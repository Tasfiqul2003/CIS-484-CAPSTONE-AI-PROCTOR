# Standard exam time settings

The professor Time & Scheduling page now reads/writes
`/exam/templates/{exam_id}/time-settings` (frontend requests use `/api`).
Only the owning professor can access it. Updates accept integer minutes 1–240.
An existing NULL means no limit and appears as a blank input until explicitly set.
Existing browser-local time drafts are not automatically imported. ODS settings
remain browser-local previews, not live per-student adjustments.

## Deployment prerequisite

Apply `database/migrations/007_session_time_limit.sql` **once**, before running
the updated backend. It adds a session time snapshot and backfills existing
sessions from their current template. Historical starting limits are unknown.
The migration intentionally fails on repeat execution rather than overwriting
attempt snapshots. Back up the database using the team's normal process first.

For the existing Docker Compose setup, run from the repository root:

```powershell
Get-Content -Raw database/migrations/007_session_time_limit.sql | docker compose exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

No database migration was applied by the coding agent. PostgreSQL migration and
browser integration require verification in the deployment environment.

New attempts copy the template limit at creation; answer and streaming checks
use the session snapshot. Expiry is still checked on answer requests, not by a
background scheduler. Session token lifetime accommodates the configured limit.

## Checks

From repository root:

```powershell
.venv/Scripts/python.exe -m pytest backend/tests/test_time_settings.py backend/tests/test_stream_authorization.py backend/tests/test_student_roster_access.py -q
```

API tests use synthetic SQLite data. Expiry tests use synthetic session records;
they do not validate PostgreSQL migration execution. In the browser, save a time,
refresh, and verify persistence; verify ODS preview still updates. Verify a failed
save reports an error. Use synthetic attempts to verify a template change affects
new attempts while existing attempts retain their original time limit.
