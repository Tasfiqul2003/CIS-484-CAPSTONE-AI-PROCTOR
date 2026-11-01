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
import sys


LEDGER = "developer_schema_migrations"
LOCK_ID = 48420261027


@dataclass(frozen=True)
class Migration:
    name: str
    sql: str
    sha256: str


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

    connection.execute(text("SELECT pg_advisory_xact_lock(:lock_id)"), {"lock_id": LOCK_ID})
    tables = set(connection.execute(text(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
    )).scalars())
    if LEDGER not in tables and tables:
        raise ValueError("Refusing to adopt an existing database without the developer migration ledger.")

    connection.exec_driver_sql(f"""
        CREATE TABLE IF NOT EXISTS {LEDGER} (
            name TEXT PRIMARY KEY,
            sha256 TEXT NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """)
    applied = {row[0]: row[1] for row in connection.execute(text(f"SELECT name, sha256 FROM {LEDGER}"))}
    if not applied and tables - {LEDGER}:
        raise ValueError("An empty developer ledger cannot adopt an existing application schema.")

    sources = {migration.name: migration for migration in migrations}
    if len(sources) != len(migrations):
        raise ValueError("Duplicate migration filenames.")
    missing = applied.keys() - sources.keys()
    if missing:
        raise ValueError("Previously applied migrations are missing: " + ", ".join(sorted(missing)))
    for name, digest in applied.items():
        if digest != sources[name].sha256:
            raise ValueError(f"Previously applied migration changed: {name}")

    pending = []
    for migration in migrations:
        if migration.name in applied:
            continue
        connection.exec_driver_sql(migration.sql)
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
