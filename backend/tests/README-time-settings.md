# Exam and question time settings

The professor Time & Scheduling page now reads/writes
`/exam/templates/{exam_id}/time-settings` (frontend requests use `/api`).
Only the owning professor can access it. The total exam limit accepts integer
minutes 1–240. The optional `question_time_limit_minutes` accepts the same range
or `null` to disable per-question timing. Omitting that field on an older client's
PUT preserves its saved value; GET returns both fields.
An existing NULL means no limit and appears as a blank input until explicitly set.
Existing browser-local time drafts are not automatically imported. Extended time
can now be assigned by roster EID on the ODS page; it extends only the total exam
timer of new attempts. Other accommodations remain a future placeholder. See
[ODS assignments](README-ods-accommodations.md) for that feature's setup and checks.

## Deployment prerequisite

Apply `database/migrations/007_session_time_limit.sql` **once**, before running
the updated backend. It adds a session time snapshot and backfills existing
sessions from their current template. Historical starting limits are unknown.
The migration intentionally fails on repeat execution rather than overwriting
attempt snapshots. Back up the database using the team's normal process first.

Also apply `database/migrations/009_question_time_limit.sql` **once** before this
version of the backend. It adds nullable question-limit columns to templates and
sessions. Existing attempts keep `NULL`, so enabling the setting does not add a
question deadline to an attempt already in progress. Preserve the earlier SQL
files and the developer migration ledger. The developer migration runner detects
the new file automatically; its use of older SQL files containing explicit
transactions remains a separate integration limitation.

For the existing Docker Compose setup, run from the repository root:

```powershell
Get-Content -Raw database/migrations/007_session_time_limit.sql | docker compose exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

If `007_session_time_limit.sql` has already been applied, do not run it again.
Apply the new question-limit migration separately:

```powershell
Get-Content -Raw database/migrations/009_question_time_limit.sql | docker compose exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

No database migration was applied by the coding agent. PostgreSQL migration and
browser integration require verification in the deployment environment.

New attempts copy both template limits at creation; answer and streaming checks
use the session snapshots. Each new interaction explicitly sets its `created_at`
with PostgreSQL `clock_timestamp()` after question generation. This starts the
answering interval when the question is saved, rather than at transaction start.
Start, resume, next-question and streaming completion responses include the
persisted `deadline`, `question_deadline`, and server `server_now`. Resuming an
attempt does not reset either deadline. Client answer timestamps are video offsets
only and never control expiry.

At or after a question deadline, the server replaces the received transcript with
`[System: No answer accepted before the question time limit expired.]`, clears its
video offsets, and continues the ordinary next-question selection flow. The marker
records a timeout, not a score or grading decision. A total-exam deadline ends the
attempt. Expiry is checked on requests, not by a background scheduler. The browser
can lock input and request advancement at zero, but disconnected clients do not
cause background advancement. Network delay can cause text sent near zero to
arrive after the server deadline and be replaced. No grace period is implemented.

Clients should send the displayed positive `question_sequence_num` with each
answer. A stale sequence is rejected with 409 before saving any transcript.
Older clients may omit it for compatibility; they do not receive this guard.
Session token lifetime accommodates the configured overall exam limit.

## Checks

From repository root:

```powershell
.venv/Scripts/python.exe -m pytest backend/tests/test_time_settings.py backend/tests/test_question_time_limits.py backend/tests/test_session_clock.py backend/tests/test_stream_authorization.py backend/tests/test_student_roster_access.py -q
```

API tests use synthetic SQLite data. Expiry and session tests use synthetic
records; they do not validate PostgreSQL migration execution or live model timing.
In the browser, save both times, refresh, and verify persistence; disable the
question limit and verify the total remains. Verify the ODS link opens per-EID
assignments and a failed save reports an error. Use synthetic attempts to verify a template
change affects new attempts while existing attempts retain their starting limits.

## Actual backend verification — November 3, 2026

The six selected suites (`test_time_settings`, `test_question_time_limits`,
`test_session_clock`, `test_exam_progress`, `test_student_roster_access`, and
`test_stream_authorization`) passed: **59 tests**, with two installed-dependency
deprecation warnings. The new question-limit suite accounts for 31 of those tests.
Checks cover strict validation and professor ownership, saving/disabling and
legacy PUT preservation, saved deadline calculation, emitted snapshot/clock SQL,
timeout boundaries and discarded late text in both answer paths, stale sequence
rejection, and total-exam timeout precedence. API fixtures use isolated in-memory
SQLite; other records and model calls are fake.

Sandboxed TestClient checks hung and were stopped; running the same selected
synthetic suites with local process access passed. No application database,
recordings, model, or external service was used. PostgreSQL migration execution,
live question generation timing, and deployment behavior remain unverified.

## Actual frontend and root verification — November 3, 2026

- Frontend TypeScript (`node node_modules/typescript/bin/tsc --noEmit`): passed.
- Vite production build: passed; output went to a temporary directory outside
  the repository, preserving tracked `frontend/dist` assets.
- Targeted category settings and clock tests: **22 passed**. Clock tests cover
  independent deadlines, resume without reset, question-only reset, whole-exam
  precedence, absent limits, and invalid server timing.
- Full frontend Node invocation (`node --test tests/*.test.mjs`): **64 passed**,
  **4 browser test files failed to start** because `playwright` is not installed.
  This is not a passing full browser suite.
- Root synthetic unittest discovery: **73 passed**.
- `git diff --check`: passed.

A temporary synthetic browser harness was attempted. The in-app browser could
not reach the local server; the local browser check then stopped because
Computer Use could not verify its current URL. No rendered UI, interactive
saving/reloading, or automatic timeout/retry browser behavior was verified.
The temporary harness server was stopped. No application database or real
student data was accessed, and no migration was applied.
