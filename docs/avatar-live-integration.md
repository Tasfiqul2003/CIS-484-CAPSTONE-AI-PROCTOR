# Live avatar and interaction integration

## Checklist implementation

- **Connect on backend:** professor-owned policy saves now include a live exam
  mode. Attempts snapshot the saved settings, revision and mode. Student
  presentation preferences and assistance requests are authorized against that
  attempt; browser drafts and preview modes cannot set live rules.
- **Create a default avatar:** the built-in `guide` is a reusable SVG examiner
  with readable states and reduced-motion support. New default policies select
  the clear standard voice profile. Browser question read-aloud uses available
  English speech synthesis, with the saved voice profile, speed and volume.

The scope selected for this increment is a built-in examiner and standard voice.
Professor likeness, voice cloning and accent conversion are not implemented.
An existing professor-uploaded raster photo can still be the still avatar.

## Saved rules and student controls

Apply `database/migrations/011_session_avatar_presentation.sql` after the existing
migrations, including `006_exam_avatar_policy.sql`. No original migration or
Modelfile is replaced. This migration has not been applied to an application
database by the coding agent.

For the existing Compose setup, after all earlier migrations are applied:

```powershell
Get-Content -Raw database/migrations/011_session_avatar_presentation.sql | docker compose exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

The professor saves **Live exam mode** with **Save Exam Policy**. The separate
preview mode remains a simulation. Policy mode and settings share the same
revision check, so stale professor saves are rejected together.

Starting an eligible rostered attempt copies the policy, revision and mode. Later
professor edits affect new attempts. Existing attempts from before this migration
use a frozen revision-zero policy and assessed mode, rather than today's professor
settings; no historical policy can be reconstructed. This frozen legacy policy
retains its former calm profile. New unsaved policies default to clear.

The session presentation API exposes only the student-facing defaults, permitted
choices and preferences. It omits unused uploaded assets, professor behavior
configuration, rubric and internal model reasoning. The student cannot save a
voice, mode, timing policy or permission override. The server rejects restricted
avatar/background/speed changes and turning off professor-required reduced motion.
Volume, readable text size and additional reduced motion remain available.

Saving or resetting presentation preferences does not change exam time, ODS,
question sequence, policy snapshots or assistance counters.

## Exam behavior

The server enforces the saved question-bank order: **Authored** uses stored
positions that preserve question-file import order, including multiple questions
with the same creation timestamp. Later uploads append to that order. The
Question Bank lists this same order. **Randomized** uses a randomized bank order.
A model cannot select a later bank item to bypass this order. Original import
order cannot be recovered for legacy rows, so their initial positions use
creation time with question ID as a deterministic tie breaker.

A bank question starts a new question group. Generated continuations count toward
that group's configured follow-up limit, including zero. Once exhausted, the
examiner moves to the next bank question or ends if none remains. The existing
server-wide `MAX_QUESTIONS` cap still applies to the entire attempt.

The user selected **whichever limit expires first** when the Avatar & Interaction
fixed response window differs from Time per question. The question clock uses the
minimum enabled duration. ODS extends only the whole-exam base time, as previously
selected; it does not extend either question window.

Generated streaming follow-ups are buffered until their answer/question transition
commits. A losing concurrent request cannot expose an uncommitted next question.
End-of-exam messages do not expose internal model selection reasoning.

## Assistance and pauses

Live repeat, clarification, hint, explanation and correctness requests check the
saved mode, action availability, pending question, time limits and per-question
allowance on the server. The student supplies a request UUID for retries. Reusing
it replays that request rather than granting another use; changed request content
is rejected. Student policy fields are not accepted in assistance requests.

Repeat returns the exact current question. Other actions use the configured model
with professor rubric/material context and the permitted action. Correctness
feedback is provisional and does not assign a final grade. Student answers and
material text are data, not authorization to change the permitted action.

For an action with **Timer continues** off, the server records a pause covering
generation and reading, bounded to 120 seconds. Completion ends that pause early.
Reloaded clients can release an outstanding reading pause; abandoned requests
cannot create an unbounded pause. Failed generation restores the allowance and
grants no pause credit; the error tells the student exam time continued.

Persisted pause durations extend both applicable clocks without multiplying pause
time by an ODS factor. Student responses include the active pause deadline so the
countdown can freeze and resume. Answer submission waits until the pause ends or
is completed. Session-token lifetime includes the bounded pause budget for the
saved mode and allowances, in addition to the accommodated exam duration.

Counts and idempotency are stored per attempt/question/action; preference resets,
reloads and professor edits do not replenish an active attempt. PostgreSQL session
row locks serialize reservations. Database concurrency behavior must still be
verified against PostgreSQL; SQLite tests do not establish PostgreSQL locking.

## Expected verification

Use only synthetic professors, students, roster entries and questions. Save a
policy, start an attempt, edit the professor policy, then reload the attempt and
verify its original revision and allowed choices. Try direct forbidden preference
requests and cross-student tokens. Verify every assistance action's mode/limit,
UUID replay, failure, completion and timeout behavior. Test a zero follow-up limit,
both question orders, shorter fixed/question windows, ODS totals and pause/resume.

Check the default avatar's states and reduced motion. Read a synthetic question
aloud, mute it, change only permitted speed options, stop speech and change
questions. A browser without speech support must keep the readable question and
report that read-aloud is unavailable.

## Actual implementation verification — November 4, 2026

These are the implementation-stage results. The subsequent existing-database
update, isolated PostgreSQL migration checks and visible browser verification are
recorded in [Local update verification](local-update-verification-2026-11-04.md).

- Full backend suite: **332 passed**, with 105 dependency/SQLite datetime-adapter
  warnings. This includes presentation permissions, professor mode and revision
  handling, persisted assistance/idempotency/failure recovery, question order,
  response windows, follow-up caps, pause budgets and the previous time/ODS work.
  The final run passed after adding checks that a capped follow-up cannot call
  either model path, including when no unused bank question remains.
- Frontend non-browser Node suites: **80 passed**. After final speech-volume and
  asynchronous preference guards, the focused **40** tests passed again and
  TypeScript passed. The focused tests are a subset, not additional unique tests.
- Root synthetic unittest discovery: **73 passed**.
- Final production Vite build: passed; output was written outside the repository
  and tracked distribution assets were preserved.
- Three updated browser fixtures passed syntax checks only. `git diff --check`
  passed. No push, merge or deployment was performed.

The backend suite required both repository root and `backend` on process-local
`PYTHONPATH`, because existing tests import both `backend.app` and `app`. The first
unconfigured attempt stopped during collection; the configured final run passed
using `python -B -m pytest backend/tests -q -p no:cacheprovider --tb=short`.
Synthetic backend checks ran with local process access because sandboxed
TestClient checks hung. No application database, recordings, private student
records, live model or downloaded model weights were used.

At this implementation stage, live browser interaction/audio, model response quality, PostgreSQL migration
execution and PostgreSQL concurrent locking have not been verified. Docker's
Linux daemon was unavailable during a read-only availability check, so no
isolated PostgreSQL run was possible. Browser automation was not attempted in
this increment; the earlier browser checks were blocked as documented in the
time/ODS test notes. Speech tests use a fake synthesis engine, not speaker output.

The API checks establish the measured authorization and allowance cases; they
cannot establish that a model always respects content-release instructions.
Prompt text is not a security boundary. All correctness feedback remains
provisional and subject to professor review.
