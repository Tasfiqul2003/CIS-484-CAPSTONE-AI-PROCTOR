> Current hardening results: see [P3 hardening verification](p3-hardening-verification.md) for terminal recording interruption, async/audio recovery, final regression totals and actual backend/native-video acceptance. Earlier dated results below remain historical evidence.

> Current continuation: see [developer-prompts-continuation.md](developer-prompts-continuation.md). This file preserves the earlier first-pass evidence and its then-unfinished items.

# Developer prompt implementation and evidence

November 16, 2026, P3 / Paulo. Local `paulo` working tree, based on `18f6a1c`.
No commit, push, merge, install, model download, real media capture, shared-server
change, database migration or service startup was performed for this work.
The original P3 launcher/settings/data and prompt/model baselines are preserved.
The launcher received read-only status/readiness improvements; its prior source
was retained in the context workspace's `work/cybros_local.before.py`.

## Scope and completion limits

These are implementation changes with synthetic evidence, not a claim that all
eight prompts' real integrations or the four stories are ready for assessed use.

| Prompt | Implemented in this pass | Remaining evidence/work |
|---|---|---|
| 1: shared contracts | Existing attempt/interaction UUIDs and ordered immutable question snapshots reused. Request UUID receipts commit atomically with answer/next question under the existing attempt row lock. Stale or missing question identity rejected. JSON/SSE entry points use the same progression. Bounded payloads, transcript provenance and typed HTTP error codes. | PostgreSQL concurrency, migration and rollback validation on an isolated authorized database; richer durable delivery/interruption timeline remains incomplete. Old streaming helper functions remain non-routed test compatibility code. |
| 2: professor live video | Same assessed device stream feeds authenticated local WebRTC. Owning professor active-attempt access, per-poll authorization/retention checks, bounded signaling, leases, stale-frame masking, local preview and cleanup. Recorded review remains separate. | Real two-browser negotiation, device denial/removal, codecs and network support. Single backend worker/direct route only; no relay, multi-worker coordination or promise of assessed resume. |
| 3: voice/text | Typed path preserved, stable answer retries, optional speech draft -> transcription -> student review/edit -> explicit confirmation -> separate answer submission. Signed original-draft provenance retained with confirmed answer. Assessor-only provisional evaluation rejects malformed/out-of-range output. Assessed opening requires a professor-approved bank question. | No real transcription provider configured. Full material/question approval UI workflow and topic-constrained generated follow-ups still need integrated review. Real end-to-end assessed exam remains unverified. |
| 4: adapters | Separate backend transcription/synthesis interfaces; correlation, limits, timeout/cancellation, stale-context rejection, truthful capability responses and static web presentation. Browser read-aloud remains separately labeled. | Intended Chatterbox API/license/runtime/hardware are unverified; no package or weights installed. Providers default unavailable. Synthesized delivery audio is not archived. |
| 5: replay | Fixed review route session-ID parsing. Saved question text, confirmed answer/source, original machine draft, recording expiry, accessible native playback/speed and approximate exchange seek controls. Original question audio explicitly unavailable. | Exact delivered-question audio/timing, interruption markers, real segment playback/seek and media-aware isolated restore. Client offsets are approximate whole displayed exchanges, not verified speaking intervals or evidence of exact delivery. |
| 6: environment | Five bundled CSS backgrounds, shared preview/live renderer, authenticated exam/student preference storage, server policy validation, visible fallback, locked subsets, keyboard/reduced-motion/mobile preview tests. Preview never starts an attempt/devices. | Apply migration 017; real authenticated student walkthrough after authorized startup. Existing snapshot restrictions remain unchanged. |
| 7: media lifecycle | Expiry enforced on uploads/completion/answer prerequisites/live/replay; path/junction/symlink guards, bounded uploads, observable idempotent partial-failure cleanup. No cleanup or scheduler executed. | Institution-approved transcript/backup policies; real asset and backup expiry/deletion verification. Live delete does not delete every backup. |
| 8: acceptance/operations | Synthetic backend/root/frontend tests, mocked browser scenarios, production build, generic service/login errors, read-only schema readiness and owned-process status. | Four historical browser suites have known fixture/UI drift documented in p3-local-setup.md; they were not rerun or declared repaired. Real DB/provider/device/restart/restore/latency acceptance remains pending. Backend disappearance was not reproduced; no cause is asserted. |

## Six voice/text checkpoints

| Item | Current status |
|---|---|
| Typed input | Implemented; synthetic tests only in this pass. |
| Web voice capture | Draft UI reuses already permitted assessed audio tracks; tested with fake MediaRecorder, never real devices. |
| Speech-to-text | Adapter/API/UI wired; real provider unavailable, injected synthetic provider tested. |
| LLM orchestration | Existing routes preserved and unified at HTTP progression; actual model was not called. Authored bank fallback remains explicit existing behavior. |
| Response display | Existing approved-question display preserved; mocked typed/retry/browser checks. |
| Speech output | Existing browser read-aloud and bounded backend synthesis interface are distinct. No saved original question-audio evidence or real synthesis integration is claimed. |

## Shared contracts and assumptions

- An attempt is `exam_sessions.id`; its immutable delivered question revision is
  `interactions.id` plus copied `question_text`. A bank row can change without
  changing that snapshot. Server `sequence_num` controls progression.
- New clients send `request_id` and displayed `question_sequence_num`. Identical
  retries return the saved student-safe response. Changed payloads with the same
  ID, another tab's old sequence, or missing identity return conflict. Receipt
  lookup happens only after token/student/attempt/exam authorization.
- Existing clients without a request UUID can submit an identified current
  question but receive conflict on retries, never silently answer the next one.
- Media time uses continuous recorder elapsed seconds, not wall-clock timestamps
  or academic timer offsets. Assistance pauses affect the academic clock while
  recording continues. New browser bounds approximate question-display through
  submit, including reading and silence. Legacy offset provenance is unknown.
  An interrupted assessed recorder remains fail-closed; no resume is promised.
- Media/presentation states do not create a second academic state machine.
  Speech busy status blocks overlapping submissions/read-aloud; neither a stream
  nor a capability toggle proves end-to-end capture or delivery.
- Confirmed speech includes a signed hash of the original machine draft bound to
  student, attempt, interaction, sequence and draft UUID. Student edits remain
  separate confirmed text. Private draft audio is transient; confirmed draft text
  is stored with transcript provenance. No new transcript retention deadline was
  invented. Professor review is the only UI showing original drafts.
- No confidence/emotion/honesty/biometric misconduct inference was added. No
  model, browser renderer, or external speech process receives DB credentials.

## Migration, configuration and rollback effects

`016_exam_media_contracts.sql` adds durable answer receipts and nullable transcript
provenance columns. `017_student_environment_preferences.sql` adds scoped settings.
Existing migrations were not edited. Both new files are **unapplied** to P3.
The existing database ledger was not opened while services were stopped.

Before any later upgrade, inspect the actual ledger/hashes and make a protected
backup using the current P3 procedure. Review both additive migrations, apply them
through the existing migrator in an authorized maintenance session, and verify an
isolated restore. Ordinary startup does not apply them; `/health/ready` returns
503 if the required columns or database are unavailable. Do not initialize/reset
the database to silence that check. Rollback requires reviewing/reverting only
these feature changes while preserving local contributions; leave additive data
in place until an approved retention/migration decision. Rollback is not tested.

The configured recording deadline remains **November 15, 2027, 23:59:59
America/New_York**, fixed for P3, not rolling. Transcript and backup policy remain
separate. No real expiry cleanup, automatic scheduler or permanent service was run.

The main non-streaming exam model call timeout is now 90 seconds (was 45), based
on the prior handoff's 47–49-second observations. That is an engineering limit,
not a new latency measurement. Grading retains its existing separate timeout.
Speech uses bounded per-process concurrency and a default 30-second provider
budget. No endless retries or replacement scores hide provider failures.

The local launcher checks `/health/ready`, distinguishes socket/process status
from readiness and does not automatically restart dead services in `status`.
`start`, `stop`, and migration/init were not invoked. A final read-only status
check found frontend/backend/database stopped and an externally owned Ollama
listener; this work did not launch it or change its lifecycle.

## Reproducible checks

From the existing checkout, with already installed dependencies, without starting
the application stack:

```powershell
$env:PYTHONPATH = "$PWD;$PWD\backend"
.\.venv\Scripts\python.exe -m pytest backend/tests -q --disable-warnings
.\.venv\Scripts\python.exe -m pytest tests -q --disable-warnings
Set-Location frontend
$unitFiles = @(Get-ChildItem tests -Filter '*.test.mjs' | Where-Object Name -NotLike '*browser*' | ForEach-Object FullName)
node --test $unitFiles
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vite/bin/vite.js build --outDir ../.cache/implementation-frontend-build
# If Playwright is outside frontend, set AVATAR_NODE_MODULES_PATH to its existing package root.
node tests/environment-browser.test.mjs
node tests/speech-draft-browser.test.mjs
node tests/review-browser.test.mjs
```

New browser suites bundle the UI in memory and intercept all requests. They start
no HTTP server and use no real provider/media. Existing historical browser suites
expect a running test frontend and are excluded by the unit command above.

## Final measured results

| Check | Result |
|---|---|
| Combined backend and root `pytest backend/tests tests` | **716 passed**, 143 subtests passed, 126 warnings, 9.86 seconds |
| Separately measured backend / root suites | **576 / 140 passed** |
| Frontend Node unit checks | **98 passed**, no failures |
| New mocked Chromium browser checks | **8 scenario groups passed**: environment/retries (3), speech drafts (3), review/login (2) |
| TypeScript / production build | Passed; 2009 modules, build 2.78 seconds; outputs in ignored `.cache/implementation-frontend-build/` |
| `git diff --check` | Passed; Git notes LF/CRLF normalization for the purge module |
| Branch / remote mutations | Still local `paulo`; no commit/push/merge/fetch |

The existing bundled Playwright package root used here was
`C:\Users\Paulo\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules`;
set `AVATAR_NODE_MODULES_PATH` to that directory for the browser commands on P3.
Chrome was the already installed `C:\Program Files\Google\Chrome\Application\chrome.exe`.
No dependency installation or browser download was needed.

Most backend tests use fake transactions or synthetic files; they do **not**
establish real PostgreSQL row-lock behavior, SQL migration execution, provider
performance, camera/identity quality or real browser media delivery. Browser seek
and recording are mocked. The 126 warnings were not hidden as passing integration
evidence. No complete exam/start-stop-restart or new backup/restore was performed.

Main changed implementation files are `backend/app/{exam,exam_contracts,stream,
exam_speech,speech_adapters,transcript_receipts,evaluation_contracts,grading,review,
exam_video,purge_exam_videos,live_video,environment_preview,avatar_policy,
avatar_session,main,db}.py`, the two new migrations, and
`scripts/cybros_local.py`. Frontend changes cover `StudentExam`, `answerSubmission`,
avatar/environment policy/rendering/preview components, `SpeechDraftPanel`,
`speechDraft`, `liveVideo`, `ProfessorLiveVideo`, `ExamSessionReview`, `ExamSubmissions`,
`ProfessorLogin`, and `App.tsx`, with corresponding synthetic tests. SQLAlchemy
exception parameter output is now hidden to avoid logging private transcripts.

See student-environments.md, speech-adapters.md and media-lifecycle-and-live-video.md
for component tests, cleanup commands, limits and support matrices. The current
workflow is prepared for a later authorized migration/integration session; the
remaining checks above must pass before calling the four stories complete.
