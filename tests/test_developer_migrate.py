"""Synthetic migration safety checks; no application imports or database access.

The SQLAlchemy dependency is supplied by backend/requirements.txt. These checks
exercise the ledger and connection-target guards, not PostgreSQL SQL execution.
"""

from contextlib import redirect_stderr
from dataclasses import replace
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("developer_migration_test_subject", ROOT / "scripts/developer_migrate.py")
runner = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = runner
SPEC.loader.exec_module(runner)
HAS_SQLALCHEMY = importlib.util.find_spec("sqlalchemy") is not None


class FakeResult:
    def __init__(self, rows=()):
        self.rows = rows

    def scalars(self):
        return iter(self.rows)

    def __iter__(self):
        return iter(self.rows)


class FakeConnection:
    """Small ledger storage double; SQL scripts are recorded and never executed."""

    def __init__(self, tables=(), applied=None):
        self.tables = set(tables)
        self.applied = dict(applied or {})
        self.scripts = []
        self.lock_requested = False

    def execute(self, statement, params=None):
        sql = str(statement)
        if "pg_advisory_xact_lock" in sql:
            self.lock_requested = True
            return FakeResult()
        if "FROM pg_tables" in sql:
            return FakeResult(self.tables)
        if "SELECT name, sha256" in sql:
            return FakeResult(self.applied.items())
        if "INSERT INTO developer_schema_migrations" in sql:
            if params["name"] in self.applied:
                raise AssertionError("An applied migration must not be inserted twice")
            self.applied[params["name"]] = params["sha256"]
            return FakeResult()
        raise AssertionError(f"Unexpected ledger query: {sql}")

    def exec_driver_sql(self, sql):
        if "CREATE TABLE IF NOT EXISTS developer_schema_migrations" in sql:
            self.tables.add("developer_schema_migrations")
        else:
            self.scripts.append(sql)


def migration(name, sql):
    return runner.Migration(name, sql, hashlib.sha256(sql.encode()).hexdigest())


class MigrationSourceTests(unittest.TestCase):
    def test_both_same_numbered_files_keep_distinct_full_names(self):
        sources = runner.load_migrations(ROOT / "database")
        names = [source.name for source in sources]
        self.assertEqual(names[0], "exam_agent_schema.sql")
        self.assertEqual(names[1:], sorted(names[1:]))
        self.assertIn("migrations/006_add_course_material_summary.sql", names)
        self.assertIn("migrations/006_exam_avatar_policy.sql", names)
        self.assertEqual(len(names), len(set(names)))

    def test_source_hash_tracks_original_bytes_and_empty_sql_is_rejected(self):
        database = ROOT / "synthetic-in-memory-database"
        base = database / "exam_agent_schema.sql"
        change = database / "migrations/001_synthetic.sql"
        content = {base: b"\xef\xbb\xbfSELECT 1;\n", change: b"SELECT 2;"}
        # A file-catalog double avoids writes and works inside restricted shells.
        with patch.object(Path, "is_file", return_value=True), \
                patch.object(Path, "glob", return_value=[change]), \
                patch.object(Path, "read_bytes", autospec=True, side_effect=lambda path: content[path]):
            source = runner.load_migrations(database)[0]
            self.assertEqual(source.sql, "SELECT 1;\n")
            self.assertEqual(source.sha256, hashlib.sha256(content[base]).hexdigest())
            content[change] = b"  \n"
            with self.assertRaisesRegex(ValueError, "Empty migration"):
                runner.load_migrations(database)


@unittest.skipUnless(HAS_SQLALCHEMY, "Install backend requirements to exercise migration guards")
class MigrationLedgerTests(unittest.TestCase):
    def setUp(self):
        self.sources = [
            migration("exam_agent_schema.sql", "SELECT 'synthetic base';"),
            migration("migrations/001_synthetic.sql", "SELECT 'synthetic change';"),
        ]

    def test_restart_skips_applied_sql_and_runs_only_new_migrations(self):
        connection = FakeConnection()
        self.assertEqual(runner.apply_migrations(connection, self.sources), [item.name for item in self.sources])
        self.assertTrue(connection.lock_requested)
        scripts = list(connection.scripts)
        ledger = dict(connection.applied)
        self.assertEqual(runner.apply_migrations(connection, self.sources), [])
        self.assertEqual(connection.scripts, scripts)
        self.assertEqual(connection.applied, ledger)
        new = migration("migrations/002_synthetic.sql", "SELECT 'later synthetic change';")
        self.assertEqual(runner.apply_migrations(connection, [*self.sources, new]), [new.name])
        self.assertEqual(connection.scripts, [*scripts, new.sql])

    def test_changed_applied_source_refuses_all_pending_sql(self):
        connection = FakeConnection()
        runner.apply_migrations(connection, self.sources)
        scripts = list(connection.scripts)
        ledger = dict(connection.applied)
        changed = replace(self.sources[1], sha256="different-digest")
        pending = migration("migrations/000_pending.sql", "SELECT 'must not run';")
        with self.assertRaisesRegex(ValueError, "Previously applied migration changed"):
            runner.apply_migrations(connection, [self.sources[0], pending, changed])
        self.assertEqual(connection.scripts, scripts)
        self.assertEqual(connection.applied, ledger)

    def test_missing_applied_source_refuses_all_pending_sql(self):
        connection = FakeConnection()
        runner.apply_migrations(connection, self.sources)
        scripts = list(connection.scripts)
        pending = migration("migrations/002_pending.sql", "SELECT 'must not run';")
        with self.assertRaisesRegex(ValueError, "Previously applied migrations are missing"):
            runner.apply_migrations(connection, [self.sources[0], pending])
        self.assertEqual(connection.scripts, scripts)

    def test_existing_schema_cannot_be_adopted_without_complete_ledger(self):
        for tables in (["students"], ["developer_schema_migrations", "students"]):
            with self.subTest(tables=tables):
                connection = FakeConnection(tables=tables)
                with self.assertRaisesRegex(ValueError, "existing"):
                    runner.apply_migrations(connection, self.sources)
                self.assertEqual(connection.scripts, [])
                self.assertEqual(connection.applied, {})

    def test_duplicate_source_identifier_refuses_execution(self):
        connection = FakeConnection()
        with self.assertRaisesRegex(ValueError, "Duplicate migration filenames"):
            runner.apply_migrations(connection, [self.sources[0], self.sources[0]])
        self.assertEqual(connection.scripts, [])
        self.assertEqual(connection.applied, {})


@unittest.skipUnless(HAS_SQLALCHEMY, "Install backend requirements to exercise migration guards")
class MigrationEntrypointTests(unittest.TestCase):
    def invoke(self, environment):
        output = io.StringIO()
        with patch.dict(os.environ, environment, clear=True), redirect_stderr(output):
            status = runner.main(["--database-dir", str(ROOT / "database")])
        return status, output.getvalue()

    def test_disabled_migrations_and_missing_url_never_create_engine(self):
        with patch("sqlalchemy.create_engine") as create_engine:
            for environment in ({}, {"DEVELOPER_MIGRATIONS": "1"}):
                with self.subTest(environment=environment):
                    status, output = self.invoke(environment)
                    self.assertEqual(status, 1)
                    self.assertTrue(output)
            create_engine.assert_not_called()

    def test_unrelated_hosts_databases_and_backends_never_connect(self):
        targets = [
            "postgresql://synthetic:synthetic_password@localhost/oralexam_developer",
            "postgresql://synthetic:synthetic_password@db/team_database",
            "mysql://synthetic:synthetic_password@db/oralexam_developer",
            "sqlite:///:memory:",
        ]
        with patch("sqlalchemy.create_engine") as create_engine:
            for target in targets:
                with self.subTest(target=target):
                    status, output = self.invoke({"DEVELOPER_MIGRATIONS": "1", "DATABASE_URL": target})
                    self.assertEqual(status, 1)
                    self.assertIn("isolated", output)
                    self.assertNotIn("synthetic_password", output)
            create_engine.assert_not_called()

    def test_connection_failure_does_not_print_url_or_driver_details(self):
        target = "postgresql://synthetic:synthetic_password@db/oralexam_developer"
        with patch("sqlalchemy.create_engine", side_effect=RuntimeError("synthetic_password driver details")):
            status, output = self.invoke({"DEVELOPER_MIGRATIONS": "1", "DATABASE_URL": target})
        self.assertEqual(status, 1)
        self.assertIn("RuntimeError", output)
        self.assertNotIn("synthetic_password", output)
        self.assertNotIn("driver details", output)


class ExecutableSQLTests(unittest.TestCase):
    """Transaction wrappers belong to the runner, never the tracked SQL files."""

    def test_outer_wrapper_mask_preserves_comments_newlines_and_original_source(self):
        sql = ("-- preserved prologue\r\nBEGIN /* keep this comment */ WORK;\r\n"
               "SELECT 'synthetic'; -- body comment\r\n"
               "COMMIT -- preserve this too\r\nTRANSACTION;\r\n-- preserved epilogue\r\n")
        source = migration("migrations/synthetic_wrapped.sql", sql)
        before = (source.name, source.sql, source.sha256)
        expected = sql.replace("BEGIN", " " * 5).replace("WORK;", " " * 5)
        expected = expected.replace("COMMIT", " " * 6).replace("TRANSACTION;", " " * 12)
        self.assertEqual(runner.executable_sql(source), expected)
        self.assertEqual((source.name, source.sql, source.sha256), before)

    def test_supported_outer_wrapper_variants_are_masked(self):
        for opening in ("BEGIN;", "begin work;", "BEGIN TRANSACTION;"):
            for closing in ("COMMIT;", "commit work;", "COMMIT TRANSACTION;"):
                with self.subTest(opening=opening, closing=closing):
                    sql = f"{opening}\nSELECT 1;\n{closing}\n"
                    expected = f"{' ' * len(opening)}\nSELECT 1;\n{' ' * len(closing)}\n"
                    self.assertEqual(runner.executable_sql(migration("synthetic.sql", sql)), expected)

    def test_plain_sql_with_quoted_or_commented_control_words_is_unchanged(self):
        cases = [
            "SELECT 'BEGIN; COMMIT; ROLLBACK;', \"END;\"; -- ABORT;\n",
            "SELECT 'an ''END;'' string', \"a\"\"COMMIT;\";\n",
            r"SELECT E'escaped \' COMMIT; still quoted'; SELECT 2;",
            "/* outer BEGIN; /* nested COMMIT; */ still ROLLBACK; */ SELECT 1;\n",
            "CREATE FUNCTION synthetic() RETURNS text AS $$ BEGIN; COMMIT; END; $$ LANGUAGE sql;\n",
            "SELECT $synthetic$ BEGIN; COMMIT; 'quoted'; $synthetic$;\n",
            "SELECT begin_work, commit_count FROM synthetic;\n",
            "PREPARE synthetic_query AS SELECT 1;\n",
        ]
        for sql in cases:
            with self.subTest(sql=sql):
                self.assertEqual(runner.executable_sql(migration("synthetic.sql", sql)), sql)

    def test_transaction_directives_are_rejected_unless_one_complete_outer_pair(self):
        cases = [
            "BEGIN; SELECT 1;", "SELECT 1; COMMIT;", "COMMIT;",
            "BEGIN; BEGIN; SELECT 1; COMMIT; COMMIT;",
            "BEGIN; SELECT 1; COMMIT; SELECT 2;",
            "SELECT 1; BEGIN; SELECT 2; COMMIT;",
            "BEGIN; SELECT 1; COMMIT; BEGIN; SELECT 2; COMMIT;",
            "BEGIN; SELECT 1; ROLLBACK;", "START TRANSACTION; SELECT 1; COMMIT;",
            "SAVEPOINT synthetic;", "RELEASE SAVEPOINT synthetic;", "ROLLBACK;", "ABORT;", "END;",
            "PREPARE TRANSACTION 'synthetic';", "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;",
            "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;",
            "COMMIT AND CHAIN;", "BEGIN; SELECT 1; COMMIT AND CHAIN;",
            "BEGIN ISOLATION LEVEL SERIALIZABLE; SELECT 1; COMMIT;",
        ]
        for sql in cases:
            with self.subTest(sql=sql):
                with self.assertRaises(ValueError):
                    runner.executable_sql(migration("synthetic.sql", sql))

    def test_unterminated_quoted_or_commented_constructs_are_rejected(self):
        for sql in ("SELECT 'unterminated", 'SELECT "unterminated',
                    "SELECT $$unterminated", "SELECT $tag$unterminated", "/* unterminated",
                    "/* outer /* nested */ still open", r"SELECT E'escaped \'"):
            with self.subTest(sql=sql):
                with self.assertRaises(ValueError):
                    runner.executable_sql(migration("synthetic.sql", sql))

    def test_bom_crlf_file_digest_is_original_bytes_not_normalized_execution(self):
        database = ROOT / "synthetic-in-memory-wrapped-database"
        base = database / "exam_agent_schema.sql"
        wrapped = database / "migrations/001_wrapped.sql"
        raw = b"\xef\xbb\xbf-- preserved\r\nBEGIN;\r\nSELECT 1;\r\nCOMMIT;\r\n"
        files = {base: b"SELECT 0;\r\n", wrapped: raw}
        with patch.object(Path, "is_file", return_value=True), \
                patch.object(Path, "glob", return_value=[wrapped]), \
                patch.object(Path, "read_bytes", autospec=True, side_effect=lambda path: files[path]):
            source = runner.load_migrations(database)[1]
        original = raw.decode("utf-8-sig")
        self.assertEqual(source.sql, original)
        self.assertEqual(source.sha256, hashlib.sha256(raw).hexdigest())
        executable = runner.executable_sql(source)
        self.assertEqual(executable, original.replace("BEGIN;", " " * 6).replace("COMMIT;", " " * 7))
        self.assertNotEqual(source.sha256, hashlib.sha256(executable.encode()).hexdigest())
        self.assertEqual(files[wrapped], raw)


@unittest.skipUnless(HAS_SQLALCHEMY, "Install backend requirements to exercise migration execution")
class MigrationPreflightTests(unittest.TestCase):
    def test_later_bad_migration_prevents_lock_ledger_and_every_earlier_script(self):
        sources = [migration("exam_agent_schema.sql", "SELECT 'synthetic earlier SQL';"),
                   migration("migrations/002_bad.sql", "SELECT 1; ROLLBACK;")]
        connection = FakeConnection()
        with self.assertRaises(ValueError):
            runner.apply_migrations(connection, sources)
        self.assertFalse(connection.lock_requested)
        self.assertEqual(connection.tables, set())
        self.assertEqual(connection.scripts, [])
        self.assertEqual(connection.applied, {})

    def test_wrapped_execution_records_raw_digest_and_restart_skips_it(self):
        source = migration("migrations/001_synthetic.sql", "BEGIN;\nSELECT 'synthetic';\nCOMMIT;\n")
        connection = FakeConnection()
        self.assertEqual(runner.apply_migrations(connection, [source]), [source.name])
        self.assertEqual(connection.scripts, ["      \nSELECT 'synthetic';\n       \n"])
        self.assertEqual(connection.applied, {source.name: source.sha256})
        self.assertEqual(runner.apply_migrations(connection, [source]), [])
        self.assertEqual(len(connection.scripts), 1)

    def test_tracked_wrapped_migrations_keep_original_bytes_hashes_and_body(self):
        sources = {source.name: source for source in runner.load_migrations(ROOT / "database")}
        for name in ("migrations/007_session_time_limit.sql", "migrations/008_student_eid_roster.sql"):
            with self.subTest(name=name):
                path = ROOT / "database" / name
                before = path.read_bytes()
                source = sources[name]
                connection = FakeConnection()
                runner.apply_migrations(connection, [source])
                self.assertEqual(source.sql, before.decode("utf-8-sig"))
                self.assertEqual(source.sha256, hashlib.sha256(before).hexdigest())
                self.assertEqual(connection.applied[source.name], source.sha256)
                expected = source.sql.replace("BEGIN;", " " * 6).replace("COMMIT;", " " * 7)
                self.assertEqual(connection.scripts, [expected])
                self.assertEqual(path.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
