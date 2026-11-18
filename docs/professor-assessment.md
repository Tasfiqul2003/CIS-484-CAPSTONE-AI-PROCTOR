# Professor provisional and manual assessment

Implemented November 16, 2026. `ProvisionalAssessment.tsx` is a professor-review
component with props `sessionId` and optional `onConfirmed(status)` callback.
It fetches the current authenticated professor identity and private attempt
report, shows saved criteria and score bounds, and supports two explicit paths:

- Enter every score and notes manually, then **Confirm professor assessment**.
  This path makes no model request and saves `model_suggested_score = NULL` when
  creating initial grade rows.
- Select **Generate provisional evaluation** to request private AI suggestions.
  The professor can explicitly copy a suggestion, edit scores/notes and confirm.
  Generation does not confirm a score or mark the attempt graded by itself.

The component has no student route or student-facing output. It obtains the
professor ID from `/auth/me`, never an editable client identity field. The server
independently enforces ownership and role on reports, generation and confirmation;
the request's professor ID must match the signed-in professor. A student bearer
token cannot access private professor reports or grading endpoints.

## Server behavior and concurrency

The existing APIs remain: `POST /exam/grade`, `GET /exam/{session_id}/report`, and
`PUT /exam/{session_id}/grades`. The report now includes the private normalized
rubric criteria and retained-recording status/expiry needed by the professor UI.
Reports do not create grade rows or invoke a model.

Generation locks the attempt row using PostgreSQL **FOR UPDATE OF s**, then
rechecks whether any grades already exist before calling the configured model.
Concurrent requests serialize on this same row; a second request sees the saved
grades and returns409 without a second generation. Confirmation uses the same
attempt lock, including the initial manual path, so manual confirmation cannot
race generation into duplicate grade sets. The retained recording must still be
available before provider work and before its result is saved.

AI results are validated against exactly the professor's known criteria and
finite score bounds before inserts. The targeted inline system instructions
explicitly treat submitted answers/transcripts as untrusted evidence that cannot
change the rubric, rules, role or output format. Scores are private provisional
suggestions. The model must not infer emotion, confidence, honesty, disability or
misconduct. Original prompt files and Modelfiles were preserved.

Confirmation rejects empty or duplicate criteria, unknown criteria, bool/nonfinite
scores, out-of-bound scores, oversized notes and a mismatched professor ID. Initial
manual grading requires an explicit full score set matching every saved criterion,
with no implicit acceptance of nonexistent suggestions. Existing provisional
rows retain the compatible `score = null` API option to accept a saved suggestion;
the new UI always sends explicit numbers. All submitted updates are validated
before any score changes are written. Repeating confirmation updates the same
rows rather than creating additional grades. Graded attempts can be explicitly
reviewed again by the owning professor under the same recording/access gates.

Provider failures/timeouts remain visible and preserve manual score drafts.
Suggestions never silently overwrite an already entered manual score. A failed
provider does not prevent a complete manual assessment. No final grade is
fabricated to hide a provider error.

## Rubric and media lifecycle boundaries

Professor topic/rubric context is now fixed after **any non-demo assessed attempt**
exists, including a completed or abandoned attempt. This prevents grading a
completed response against a later edited rubric. Context GET reports locked
state and the editor says to create a new exam for topic/rubric changes. A
completed developer demo does not freeze a future assessed rubric. The separate
unpublished question-draft generation policy is unchanged. No schema migration or
automatic data correction was introduced for this boundary.

Submission review returns410 when a recording's retention deadline has elapsed,
including a row still marked completed before cleanup runs. Missing/incomplete
recording storage remains a separate409 state. Both provisional and manual grading
require a completed recording within its deadline. Expiration cleanup is not
required to enforce access state.

Invalid legacy rubrics are reported explicitly; they are not silently replaced or
inferred from student content. Existing duplicate legacy grade rows also require
review rather than automatic deletion. This work did not modify assessed records
or invent identity/recording evidence in the running application.

## Verification

- **13 new synthetic API tests passed** for manual grading without AI, provisional
  isolation, sequential duplicate generation, full/manual score validation,
  atomic invalid updates, ownership/private-report rejection, professor identity,
  nonfinite boundaries and completed-but-expired review behavior.
- **145 existing targeted tests passed** across context, professor authorization,
  demo safeguards and evaluation contracts after the backend changes.
- **7 in-memory mocked assessment browser scenario groups passed**: explicit manual
  confirmation with no provider, optional provisional generation/copy/edit/confirm,
  timeout preserving manual drafts with bounds enforced before submission, and
  denied reports exposing no score fields or mutation controls, fresh saved
  suggestions requiring explicit acceptance, late report isolation and late
  generation/confirmation/provider-error isolation across session changes.
- The question-draft browser suite also verifies the completed-attempt rubric lock
  and create-new-exam copy, independently of draft generation permission.
- TypeScript `--noEmit` passed. SQLite test UUID casts are adapted locally for test
  execution; those tests do not establish PostgreSQL row-lock concurrency. An
  isolated PostgreSQL concurrency check and optional actual local model check are
  separate evidence, not claimed by these synthetic API/browser results.

```powershell
.\.venv\Scripts\python.exe -m pytest backend/tests/test_assessment_workflow.py -q -p no:cacheprovider
```

From `frontend`, with the existing bundled Playwright modules configured:

```powershell
node tests/assessment-browser.test.mjs
node tests/question-drafts-browser.test.mjs
```

No new service, installation, model weight, scheduler, commit, push or shared
deployment was introduced. No real camera, microphone or student exam was used
for this UI and boundary verification.


All report loads, evaluation requests and confirmation requests now retain their
initiating session ID and request generation. Session changes abort every owned
request, reset mutation busy state, and prevent old responses from loading an old
report into the new view or changing its errors, notices or confirmation callbacks.
Confirmation requests have an owned abort controller as well as evaluation/load
requests. Browser regressions deliberately hold fully read responses and ignore a
later abort, so these checks exercise stale-completion guards rather than relying
only on fetch cancellation. Late report, successful evaluation, confirmation and
provider-error completions all leave the newly selected session intact.

A fresh page with unconfirmed AI suggestions leaves score inputs blank. The
professor must type a score or explicitly select **Use suggestion** before the
separate confirmation action; a saved final professor score can still be loaded.
These changes add no backend operation or live assessment record.


## Final regression after grading-provider and stale-session fixes

The final complete offline backend/root run passed **852 tests**, with **6 skipped**,
**143 subtests passed**, **230 warnings**, in **16.89 seconds**. Native generated-WAV
speech checks were explicitly enabled. Live PostgreSQL/model opt-ins were absent;
the six gated integration tests are not counted as passing acceptance evidence.
TypeScript and the seven assessment browser groups passed after the UI request
lifecycle fix.

The grading request now specifies a per-rubric Ollama JSON schema. A separate
envelope guard requires a completed response with a bounded nonempty content
field before the existing strict criterion/score validator runs. An echoed input
object or incomplete provider response saves zero grade rows; neither is coerced
into scores or hidden by an automatic retry. Targeted regression tests cover these
failures. The finalized isolated PostgreSQL and optional actual grading-provider
outcome is reported in [P3 integration verification](p3-integration-verification.md),
separately from this offline regression result.
