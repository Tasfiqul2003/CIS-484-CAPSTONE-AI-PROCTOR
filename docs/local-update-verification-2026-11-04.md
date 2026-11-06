# Local database update and website verification — November 4, 2026

## Existing local setup

The earlier setup chats identified the existing ignored `.cache/local-web`
launchers and persistent PGlite database. This update used that database and the
existing local professor account, rather than creating another account or
replacing it with an empty Docker database. No credentials or application records
were added to source control.

Before starting the database, its data directory and local settings were copied
to `.cache/local-web/backups/pre-updates-20261104-9de6493d`. The offline source
and backup data directories each contained 40,788,163 bytes. The backup is local
and ignored by Git.

The local launcher now preflights the preserved migration sources with
`scripts/developer_migrate.py`, applies pending SQL and ledger entries together
in one transaction, and records original-source hashes for newly applied files.
Historical ledger entries without hashes remain without hashes; historical
checksums were not invented.

## Measured results

- The existing database reports PostgreSQL 18.6 through PGlite 0.5.10.
- Six pending migrations applied: `007_session_time_limit.sql`,
  `007_student_roster.sql`, `008_student_eid_roster.sql`,
  `009_question_time_limit.sql`, `010_exam_ods_extended_time.sql`, and
  `011_session_avatar_presentation.sql`.
- The ledger contains all 15 SQL files. All six new entries contain the original
  source hashes. A restart applied zero migrations.
- The existing professor account remained present and its login succeeded. The
  existing professor exam remained available.
- Frontend `/` and `/professor/login`, proxied `/api/health` and `/api/health/db`,
  and the existing exam's time settings, avatar policy, ODS assignments and
  question-list reads returned HTTP 200.
- In the visible browser, the existing account reached its dashboard and exam.
  Time & Scheduling displayed the total exam time and optional question limit;
  ODS displayed individual EID entry and CSV upload; Avatar & Interaction opened
  the built-in examiner in the explicitly synthetic student preview. These tabs
  were left open. Existing exam settings and roster assignments were not changed
  for this viewing check.
- Services were left running on loopback: frontend `127.0.0.1:5173`, backend
  `127.0.0.1:8000`, and the existing database `127.0.0.1:5433`. Initial sandboxed
  processes could not be reached from the host; restarting these local processes
  with host access resolved that startup problem.

## Migration runner checks

Existing migrations include an outer `BEGIN`/`COMMIT` wrapper. The runner now
recognizes and masks that wrapper while keeping migration execution and ledger
writes in its own transaction. It rejects other transaction-control statements,
preflights the full catalog before executing it, and preserves original SQL files
and their hashes.

- Root unittest discovery: **82 passed**, including **19 migration checks**;
  zero failures, errors or skips.
- A separate isolated PostgreSQL 16.15 check applied all 15 tracked SQL files,
  verified their source hashes, verified the new columns and assistance
  constraints, and applied zero files on restart.
- A synthetic wrapped migration deliberately failed with SQLSTATE `22012`.
  Both its probe table and ledger entry rolled back; the original 15 entries
  remained intact.
- The isolated check used a unique temporary container and network with no
  published ports or persistent volume. Its owned resources were removed after
  verification. It did not use the existing application database or account.

## Limits of this verification

The configured local inference endpoint at `127.0.0.1:11434` was unreachable.
No model was downloaded or started. AI-generated questions and assistance still
require that service and the configured model.

No student attempt, live assistance generation, PostgreSQL request concurrency,
speaker output, microphone or camera was exercised during this viewing check.
The avatar preview is synthetic and does not establish live speech or model
quality. Earlier unit and build results are recorded separately in
`avatar-live-integration.md`. No push, publication or merge was performed.
