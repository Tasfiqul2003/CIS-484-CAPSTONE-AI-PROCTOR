# Per-exam ODS extended time

## Implemented behavior

The owning professor can assign an extended-time multiplier to an individual EID
or upload an EID-only UTF-8 CSV on the selected exam's ODS Accommodations page.
The CSV has one column, `eid`; the selected multiplier applies to the entire file.
The supported multipliers are 1.25, 1.5, 2 and 3. A later assignment updates that
student's multiplier. Removal restores standard time for future attempts.

Only existing members of the selected exam roster can be assigned accommodations.
EIDs are text, with leading zeros preserved; matching ignores surrounding spaces
and case. Unknown or ambiguous EIDs and duplicate file entries are rejected.
The upload must be no larger than 1 MiB and contain at most 5,000 EIDs. The whole
file is validated and its identities resolved before updates; failed batches are
rolled back. Importing accommodations does not create students or change rosters.

Assignments apply to this exam and to **new attempts only**. An attempt stores
the base time limits and its extended-time multiplier at creation. Both answer
routes and the resumed countdown use that snapshot. Updating or removing an
assignment leaves existing attempts unchanged. The multiplier extends only the
**whole-exam timer**. Question limits remain unchanged, including question expiry
and its unanswered marker. A missing total exam limit remains unlimited.

Fractional minutes are preserved: 1 minute at 1.25 times is 75 seconds; 240 minutes
at 3 times is 720 minutes. The student's available-exam list shows their current
extended total; session-token lifetime covers the saved extended total plus a
margin. The student's existing countdown follows the saved server deadline.

The professor page lists saved assignments and effective total times. It includes
an explicitly inactive placeholder for future accommodations. Breaks, reduced
distraction and assistive technology have no new runtime behavior in this change.
The old browser-local ODS draft data is preserved but does not grant extended time.
No approval-document or diagnostic records are requested or stored by this feature.

## API and deployment

All assignment endpoints require the owning professor's session:

- `GET /exam/templates/{exam_id}/ods-accommodations`: base limits and saved assignments.
- `PUT` on the same path: `{ "eid": "synthetic001", "extended_time_multiplier": 1.5 }`.
- `POST .../ods-accommodations/upload`: multipart `file` plus `extended_time_multiplier`.
- `DELETE .../ods-accommodations/{student_id}`: clear that roster member's assignment.

The frontend uses the `/api` proxy prefix. Client-provided multipliers do not
control student attempts; the server copies the roster assignment when starting.
The API controls who can assign extended time, and does not verify whether an
accommodation has been approved outside this application.

Apply the existing question-limit migration `009_question_time_limit.sql` and
then the new `010_exam_ods_extended_time.sql` once before running this backend.
Preserve earlier SQL and migration ledger entries. The new file adds a nullable
roster multiplier and a session multiplier defaulting to 1 for existing attempts.
The developer migration runner detects new files automatically; older SQL files
with explicit transactions remain a separate migration-runner limitation.

For the existing Compose setup, after earlier migrations are already applied:

```powershell
Get-Content -Raw database/migrations/010_exam_ods_extended_time.sql | docker compose exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

No migration has been applied by the coding agent. Test the migration and the
deployed browser flow in an isolated environment using synthetic roster entries.

## Expected verification

Use synthetic EIDs to assign, reload, change and remove multipliers; test CSV
imports with duplicate/unknown identities and ensure no partial changes persist.
Try another professor and a student session and verify access is denied. Start
an attempt with extended total time, then change the assignment and verify the
active attempt keeps its deadline while a new one uses the new multiplier.
Resume an attempt without resetting its clock. Confirm a question still expires
at its original question limit. Other ODS features should remain placeholders.

Backend tests use isolated SQLite or synthetic records and stub model calls.
They do not execute PostgreSQL migrations or establish compliance with any policy.

## Actual verification — November 4, 2026

- Focused backend suites: **127 passed**, including 51 new API/CSV cases and
  20 new attempt-clock cases, with two installed-dependency deprecation warnings.
  The new API tests use real in-memory SQLite transactions for rollback checks;
  session/model records are synthetic fakes. Coverage includes ownership, EID
  normalization/ambiguity, file bounds, failed-batch rollback, fractional total
  time, unchanged question time, token lifetime and saved attempt snapshots.
- Frontend model tests: **70 passed**, including six new ODS state/validation
  checks. TypeScript and updated browser-fixture syntax checks passed.
- Root synthetic unittest discovery: **73 passed**.
- Production Vite build: passed; generated output went to a temporary directory
  outside the repository, preserving tracked distribution assets.
- `git diff --check`: passed.

Sandboxed backend TestClient checks hung and were stopped; the focused suites
passed with local process access. No real student data, application database,
recordings or model weights were used. No PostgreSQL migration was executed.
Browser automation was not run: Playwright was unavailable in the earlier check
and the earlier Computer Use attempt could not verify the local browser URL.
Interactive CSV selection, saving/reloading and end-to-end browser timing remain
unverified. The existing navigation browser fixture was updated, not executed.
