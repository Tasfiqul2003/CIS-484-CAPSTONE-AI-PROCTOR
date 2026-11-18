# Temporary photo-check access for recording tests

An absent official roster photo blocks normal face comparison. Official photos
are currently imported with the roster ZIP (`roster.csv` plus
`photos/<EID>.jpg`, `.jpeg` or `.png`). This temporary exception lets an operator
test recording while that reference photo is unavailable.

`EXAM_TEST_PHOTO_EID` selects exactly one EID and `EXAM_TEST_PHOTO_UNTIL` is a
timezone-aware expiry within 24 hours. Both are private runtime settings. The
default is off. Empty, malformed, expired or excessive windows fail closed.
Wildcards and lists are refused. The helper defaults to two hours and prompts
for the chosen test EID if `-StudentEid` is omitted.

The backend rechecks the configured EID from the student record before exam
admission. It still requires an existing student, a published exam roster,
the appropriate student token and recording consent. The exception does not
upload a substitute photo, create a `matched` result, reset failed attempts,
or alter existing sessions, answers, consent or grades. New attempts store
`identity_check_completed=false`, `identity_review_required=true` and zero
photo-comparison attempts. The professor progress table labels them
**Unverified: photo check skipped for testing**. These are test attempts, not
evidence of verified identity. Use a synthetic student and a fresh test exam.

The exception is separate from developer demo mode, which disables recording.
Disabling the exception or reaching its expiry blocks new unverified
admissions. A session already started can finish and retains its saved
unverified identity flags. No migration, new image, model or GPU is needed.

## Apply on the laptop

When nobody is taking an exam, run the delivered PowerShell helper with
`-Apply -MaintenanceWindow -ExpectedOpenSessions 6`. It asks for the test EID,
commits only the reviewed source update and uses the existing storage helper
to apply private settings while preserving the image, recording volume,
retention deadline, other environment values and services. Saved open attempts
are unchanged. A changed activity fingerprint, recent recording upload or
different expected count stops the restart. The same private backups and
rollback checks used for recording storage apply.

Return to `http://localhost:5173/student/verification`, enter that EID, and
choose **Continue to exams for testing**. Only the configured student's lookup
offers this route. The browser flag supports navigation only; it cannot
replace backend authorization. Enable **Record Examination** and **Generate
Transcript** on the test exam before creating the new attempt, then review
and grant recording consent normally.

The two-hour window expires automatically in the running backend. To remove
the private exception settings earlier, rerun the helper with `-Disable`
instead of the EID/hours options during a maintenance window. The expected
open-attempt count must still match; finish a running test attempt first.

Runtime activation remains an operator action because this assistant session
cannot access the Docker Engine pipe. Automated checks use synthetic database
results and local Compose rendering; they do not prove a live browser capture.

## Verification on 2026-11-18

Backend checks: 610 passed, with two existing host link-operation skips.
Repository script checks: 126 passed, including 26 activation tests.
Frontend checks: 103 passed; TypeScript and Vite production build passed.
The PowerShell entry point parsed without errors. Tests cover default-off,
single-EID scoping, expiry during an admission flow, malformed/overlong windows,
roster enforcement, unchanged face-match records, unverified session metadata,
preserved recording consent, private settings and rollback. Runtime enabling
and the user's actual browser path remain to be observed after application.
