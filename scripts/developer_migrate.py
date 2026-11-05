"""Apply tracked SQL once to the isolated developer database.

This entry point is only enabled by compose.developer.yaml. It never adopts an
existing untracked schema. Original SQL files remain unchanged; the ledger uses
full filenames, including the two distinct 006 migrations, and SHA-256 digests.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import re
import sys


LEDGER = "developer_schema_migrations"
LOCK_ID = 48420261027


@dataclass(frozen=True)
class Migration:
    name: str
    sql: str
    sha256: str


@dataclass(frozen=True)
class _Statement:
    # Quoted values have no keyword value. Offsets let masking preserve comments.
    tokens: list[tuple[str | None, int, int]]
    terminator: int | None


def _statements(sql: str) -> list[_Statement]:
    """Find SQL statement boundaries without interpreting quoted bodies or comments."""
    statements = []
    tokens = []
    position = 0
    while position < len(sql):
        char = sql[position]
        if char.isspace():
            position += 1
            continue
        if sql.startswith("--", position):
            end = sql.find("\n", position + 2)
            position = len(sql) if end == -1 else end + 1
            continue
        if sql.startswith("/*", position):
            depth = 1
            position += 2
            while depth and position < len(sql):
                if sql.startswith("/*", position):
                    depth += 1
                    position += 2
                elif sql.startswith("*/", position):
                    depth -= 1
                    position += 2
                else:
                    position += 1
            if depth:
                raise ValueError("Unterminated SQL block comment")
            continue
        start = position
        escape_string = char in "eE" and sql[position + 1:position + 2] == "'"
        if char in "'\"" or escape_string:
            quote = "'" if escape_string else char
            position += 2 if escape_string else 1
            while position < len(sql):
                if escape_string and sql[position] == "\\":
                    position += 2
                elif sql[position] == quote:
                    if sql[position + 1:position + 2] == quote:
                        position += 2
                    else:
                        position += 1
                        break
                else:
                    position += 1
            else:
                raise ValueError("Unterminated SQL quoted value")
            tokens.append((None, start, position))
            continue
        if char == "$":
            delimiter = re.match(r"\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$", sql[position:])
            if delimiter:
                marker = delimiter.group()
                end = sql.find(marker, position + len(marker))
                if end == -1:
                    raise ValueError("Unterminated SQL dollar-quoted body")
                position = end + len(marker)
                tokens.append((None, start, position))
                continue
        if char == ";":
            if tokens:
                statements.append(_Statement(tokens, position))
                tokens = []
            position += 1
            continue
        if char.isalpha() or char == "_":
            position += 1
            while position < len(sql) and (sql[position].isalnum() or sql[position] in "_$"):
                position += 1
            tokens.append((sql[start:position].upper(), start, position))
        else:
            position += 1
            tokens.append((char, start, position))
    if tokens:
        statements.append(_Statement(tokens, None))
    return statements


def _transaction_control(statement: _Statement) -> bool:
    words = [token[0] for token in statement.tokens]
    first = words[0]
    if first in ("BEGIN", "COMMIT", "END", "ROLLBACK", "ABORT", "SAVEPOINT", "RELEASE"):
        return True
    if words[:2] in (["START", "TRANSACTION"], ["PREPARE", "TRANSACTION"]):
        return True
    if first == "SET":
        remainder = words[1:]
        if remainder and remainder[0] in ("LOCAL", "SESSION"):
            remainder = remainder[1:]
        return remainder[:1] == ["TRANSACTION"] or remainder[:3] == ["CHARACTERISTICS", "AS", "TRANSACTION"]
    return False


def executable_sql(migration: Migration) -> str:
    """Remove only validated outer wrappers, retaining original source and ledger hash.

    Transaction control is recognized only at top-level statement starts. Strings,
    quoted identifiers, nested comments, and dollar-quoted bodies remain unchanged.
    """
    try:
        statements = _statements(migration.sql)
    except ValueError as error:
        raise ValueError(f"Invalid SQL structure in {migration.name}: {error}") from error
    if not statements:
        raise ValueError(f"Empty SQL migration: {migration.name}")
    controls = [index for index, statement in enumerate(statements) if _transaction_control(statement)]
    if not controls:
        return migration.sql
    first, last = statements[0], statements[-1]
    begin = [token[0] for token in first.tokens]
    commit = [token[0] for token in last.tokens]
    if (len(statements) < 3 or controls != [0, len(statements) - 1]
            or begin not in (["BEGIN"], ["BEGIN", "WORK"], ["BEGIN", "TRANSACTION"])
            or commit not in (["COMMIT"], ["COMMIT", "WORK"], ["COMMIT", "TRANSACTION"])
            or first.terminator is None or last.terminator is None):
        raise ValueError(f"Unsupported or unmatched transaction control in {migration.name}")
    masked = list(migration.sql)
    for statement in (first, last):
        for _, start, end in statement.tokens:
            masked[start:end] = " " * (end - start)
        masked[statement.terminator] = " "
    return "".join(masked)


def load_migrations(database_dir: Path) -> list[Migration]:
    """Read the preserved base schema, followed by full-name ordered migrations."""
    base = database_dir / "exam_agent_schema.sql"
    paths = [base, *sorted((database_dir / "migrations").glob("*.sql"))]
    if not base.is_file() or len(paths) == 1:
        raise ValueError("The base schema and migration directory are required.")
    migrations = []
    for path in paths:
        content = path.read_bytes()
        sql = content.decode("utf-8-sig")
        if not sql.strip():
            raise ValueError(f"Empty migration: {path.name}")
        migrations.append(Migration(
            name=path.relative_to(database_dir).as_posix(),
            sql=sql,
            sha256=hashlib.sha256(content).hexdigest(),
        ))
    return migrations


def apply_migrations(connection, migrations: list[Migration]) -> list[str]:
    """Apply pending files inside the caller's single PostgreSQL transaction."""
    from sqlalchemy import text

    sources = {migration.name: migration for migration in migrations}
    if len(sources) != len(migrations):
        raise ValueError("Duplicate migration filenames.")
    # Preflight the complete catalog before even creating the migration ledger.
    # Stored hashes always describe original bytes, never this execution-only SQL.
    prepared = {migration.name: executable_sql(migration) for migration in migrations}
    connection.execute(text("SELECT pg_advisory_xact_lock(:lock_id)"), {"lock_id": LOCK_ID})
    tables = set(connection.execute(text(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
    )).scalars())
    if LEDGER not in tables and tables:
        raise ValueError("Refusing to adopt an existing database without the developer migration ledger.")

    applied = ({row[0]: row[1] for row in connection.execute(text(f"SELECT name, sha256 FROM {LEDGER}"))}
               if LEDGER in tables else {})
    if not applied and tables - {LEDGER}:
        raise ValueError("An empty developer ledger cannot adopt an existing application schema.")

    missing = applied.keys() - sources.keys()
    if missing:
        raise ValueError("Previously applied migrations are missing: " + ", ".join(sorted(missing)))
    for name, digest in applied.items():
        if digest != sources[name].sha256:
            raise ValueError(f"Previously applied migration changed: {name}")

    connection.exec_driver_sql(f"""
        CREATE TABLE IF NOT EXISTS {LEDGER} (
            name TEXT PRIMARY KEY,
            sha256 TEXT NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """)
    pending = []
    for migration in migrations:
        if migration.name in applied:
            continue
        connection.exec_driver_sql(prepared[migration.name])
        connection.execute(text(
            f"INSERT INTO {LEDGER} (name, sha256) VALUES (:name, :sha256)"
        ), {"name": migration.name, "sha256": migration.sha256})
        pending.append(migration.name)
    return pending


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-dir", type=Path, default=Path(__file__).resolve().parents[1] / "database")
    args = parser.parse_args(argv)
    if os.getenv("DEVELOPER_MIGRATIONS") != "1":
        print("Developer migrations are enabled only by the isolated developer stack.", file=sys.stderr)
        return 1
    url = os.getenv("DATABASE_URL")
    if not url:
        print("The developer database URL is missing.", file=sys.stderr)
        return 1
    try:
        from sqlalchemy import create_engine
        from sqlalchemy.engine import make_url

        migrations = load_migrations(args.database_dir)
        target = make_url(url)
        if (target.get_backend_name(), target.host, target.database) != ("postgresql", "db", "oralexam_developer"):
            raise ValueError("Migrations must target the isolated db service and oralexam_developer database.")
        engine = create_engine(url, pool_pre_ping=True)
        try:
            with engine.begin() as connection:
                if connection.dialect.name != "postgresql":
                    raise ValueError("Developer migrations require PostgreSQL.")
                applied = apply_migrations(connection, migrations)
        finally:
            engine.dispose()
    except ValueError as error:
        print(f"Developer migration refused: {error}", file=sys.stderr)
        return 1
    except Exception as error:
        # Connection and SQL exceptions can contain connection details or data.
        print(f"Developer migration failed ({type(error).__name__}); no pending migrations were committed.", file=sys.stderr)
        return 1
    print(f"Developer schema ready: {len(applied)} migration(s) applied.")
    for name in applied:
        print(f"  {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
