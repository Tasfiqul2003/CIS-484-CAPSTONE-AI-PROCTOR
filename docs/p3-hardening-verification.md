# P3 integration hardening — November 16, 2026

This report supersedes the test totals and remaining code defects in the earlier
`p3-integration-verification.md`. Validation ran on the local, uncommitted
`paulo` working tree based at `18f6a1c`. The later user-authorized publication
commit preserves these measured results; consult Git history for publication state. The original eight features, five migrations and operating
instructions remain as documented there. This pass adds no migration, provider,
model weight, public relay, scheduled task or shared-server change.

## Recording interruption is terminal

An upload failure previously stopped MediaRecorder while leaving the UI marked
active. A successful final-chunk retry could then erase the error and re-enable
answers. Recording interruption is now synchronous and sticky: stop the recorder,
stop live viewing, release owned tracks, preserve the answer draft and disable
further interaction. Upload/finalization requests have 15-second deadlines.

The student can explicitly save the available partial recording for professor
review. This action acknowledges the interruption on the server before finalizing
bytes. It does not resume the attempt, submit another answer, invent unanswered
responses or show the normal exam-complete confirmation. A normal end-of-exam
upload failure remains retryable without falsely reporting interrupted capture.

On the server, an authenticated terminal recording event atomically flags an
active assessed attempt and records its end under the existing attempt lock.
The supplied question may be an earlier delivered interaction, because a stop
can race with an answer response. Backward offsets remain explicitly out of
order. Reserved, bounded terminal events cannot be lost to an ordinary playback
observation limit, expired/missing capture metadata or duplicate notifications.
Partial bytes remain available for authorized upload/finalization; answer,
speech and live access use the ended attempt state. Already-ended attempts keep
their existing academic status.

Late permission/start/recording-start responses cannot start capture after the
student leaves. A created attempt receipt is preserved and an interruption is
reported; resolved device tracks are released. Initialization failures also
report termination of a created assessed attempt.

**11 new StudentExam browser scenarios passed** with the actual orchestration
component and declared synthetic child widgets, fake streams/recorder and mocked
HTTP. They cover upload failure followed by successful final-chunk recovery,
upload timeout, track loss, recorder error, unexpected stop, normal completion,
normal final-upload retry, three delayed-start/navigation races and recording
initialization failure. No native device, provider or backend was used in this
suite; assertions include no resumed answers, retained ordered bytes, receipt
preservation, correct partial/complete messages and owned resource cleanup.

## Authorization, signaling and stored media

- Answer tokens are revalidated after the attempt row-lock wait and before
  receipt replay. A token that expires while blocked cannot submit or replay an
  answer. Two signed-JWT deterministic-clock regressions cover both cases.
- Live scope/authentication is rechecked after database work, including token
  expiry and account deactivation. A room UUID binds offers, answers, candidates
  and cursors to the room instance, preventing stale state after recreation.
  Signaling is bounded by UTF-8 bytes as well as message count: 256 KiB per room
  and 16 MiB globally. Invalid Unicode is rejected as a client error.
- Recording initialization locks the existing attempt rather than an absent
  video row, preventing a duplicate-start unique-key race. Upload/finalization
  credentials are rechecked after database waits.
- Full and range playback compare the stored file size with persisted byte
  metadata before streaming and include `X-Content-Type-Options: nosniff`.
  Truncation returns an unavailable/conflict response; valid ranges remain 206
  and out-of-bounds ranges 416.

## Async UI recovery and playback

Question audio capability discovery now times out visibly and offers retry.
Late playback-observation failures cannot replace newer playback status. Review
rejects an exchange segment extending beyond the actual recording duration;
superseded play/seek errors, question-audio handoff and unmount cleanup cannot
contaminate a new playback operation. Browser speech retry respects saved-audio
busy and volume/mute gates, preventing overlapping speech and saved WAV audio.

Speech capability discovery has a 12-second bound and explicit retry while the
typed path remains usable. The complete preparation, fetch and response-body
path has a 55-second deadline; a late WAV conversion cannot strand transcription
or upload after cancellation. Professor draft, context and question-bank reads
and mutations are scoped to their initiating exam/generation, with cancellation
and deadlines. Old responses, errors, uploads and approval callbacks cannot
replace another exam's saved questions, rubric or draft state. Current manual
edits and retry request identities are preserved.

Focused checks passed: **14 question-audio**, **12 saved-review**, **2 legacy
review** and **2 integrated presentation** browser checks; **6 speech** scenario
groups, **5 new question-request race** groups and **5 existing draft/context**
groups. Existing assessment scenarios remain separate. Browser APIs/providers
are mocked except where generated native playback/transport is explicitly noted.

## Real PostgreSQL and localhost UI verification

The protected maintenance helper backed up P3 and restored a fresh isolated
database. **15 checks passed, 1 optional unchanged grading-provider test skipped,
in 3.52 seconds**. Eight checks guard the destination URL; seven use actual
PostgreSQL transactions/routes. The new tests observed an actual row-lock wait
before advancing the real JWT decoder's clock and proved rejection with zero
answer/receipt/event writes. A delayed interruption for the previous question
flagged the attempt, retained recording metadata, blocked the next answer and
remained idempotent without resetting the end time.

The existing answer concurrency/rollback, foreign-key isolation and separate
database/WAV backup-restore checks also passed. Source ledger: **24**, no pending
migrations, zero source migrations applied. The owned validation database was
removed and its maintenance PostgreSQL process stopped, with no cleanup failures.
Protected report:
`private-data/p3-local/backups/upgrade_20261117_011026_a8947efb/validation.json`.
The unchanged real grading provider's earlier passing evidence remains in the
integration report; it was not needlessly called again in this pass.

After restarting the local app, **7/7 actual localhost UI checks passed**:
authentication, dashboard/exams, rubric/topic save and reload, five shared-renderer
backgrounds and narrow layout. Only that run's unpublished scratch exam was
created and deleted. No provider or real device was used. Protected report:
`private-data/p3-local/verification/browser-smoke-1794877980007-0473eb19/report.json`.

## Regression and current operation

The final complete offline Python suite passed **867 tests**, **143 subtests**,
with **8 explicitly gated integration tests skipped** and 230 warnings in
17.91 seconds; native generated-audio checks were enabled.
Frontend: **107 unit tests** with no failures/skips, TypeScript passed, and all
three environment browser groups passed, including the StudentExam mocked-demo
lost-response retry path. The cache production build passed: 2,017 modules in
3.25 seconds. Its 521.49 kB main JS bundle retains the nonfatal size advisory;
tracked historical `frontend/dist` and original prompt/model baselines remain
unchanged.

## Actual backend and native browser media

The repeatable `frontend/tests/live-video-backend-browser.test.mjs` and owned
`backend/tests/live_backend_fixture.py` passed **2/2 scenarios** in Chrome
157.0.8103.51. Scenario times were 14.635 and 8.563 seconds. Production login,
cookie/JWT authorization, live signaling, terminal timeline, recording and
playback routers served real loopback HTTP with no intercepted API responses.
Only static browser fixture content was supplied by the harness.

The isolated backend used synthetic SQLite rows and temporary generated-media
storage. UUID/locking syntax was adapted narrowly for the fixture dialect;
PostgreSQL locking evidence comes from the separate real-PG tests above. No P3
database, real account, exam-start/identity route or real device was used.

The native canvas stream produced changing 320×180 remote frames, recreated a
room with a new nonce, and was revoked by an authenticated interruption that
flagged the attempt. A generated **296,796-byte WebM** uploaded successfully;
same-chunk replay returned 200, out-of-order/overwritten chunks 409 and a
cross-attempt request 403. The flagged partial recording finalized, preserved
its exact hash/range bytes and decoded natively in stored browser playback.
Wrong-professor access returned 404 and an expired student JWT 401. An actual
short professor-cookie expiry closed the receiving peer and cleared the video
while preserving the independent fixture-owned canvas source.

Owned child fixtures and temporary directories were cleaned up. Main application
services were not controlled by this harness. Evidence:
`.cache/browser-results/live-backend/results.json`. This closes the previously
mocked-signaling acceptance gap for the local synthetic topology; it does not
certify real cameras, microphones, distant peers or a human assessed exam.

The final runtime check confirmed all four normal service listeners on
`127.0.0.1`, backend/frontend-proxy/model readiness, 24 source migration entries,
zero source exam sessions and zero remaining live-fixture processes. The owned
frontend environment contains no database, authentication, bootstrap or recording
path configuration. Protected evidence:
`private-data/p3-local/verification/hardening-runtime-20261117T011929Z.json`.

The generated-device recording suite and isolated real-backend suite are
repeatable from `frontend` with the existing browser dependencies configured:

```powershell
node tests/student-recording-browser.test.mjs
node tests/live-video-backend-browser.test.mjs
```

The first bundles actual StudentExam orchestration with declared fake children,
streams and HTTP. The second starts and removes only its own isolated loopback
backend fixture. Neither suite requests native camera/microphone/display capture.

The normal app runs at http://127.0.0.1:5173 with backend 8000, P3 PostgreSQL 55432
and external Ollama 11434. Main services were stopped only after checking there
were no active local attempts, then restarted with current source. External
Ollama stayed outside launcher ownership. No new migration was required.

Real camera/microphone/display capture, full human assessed-exam acceptance,
human speech accuracy, and deployment outside the documented local topology
remain unverified. Synthetic direct attempt fixtures do not establish identity
verification or exam-start success. Windows native speech remains the implemented
P3 provider; Chatterbox remains an unverified optional candidate. Recording
retention, distinct transcript/backup policy and the absence of automatic deletion
remain unchanged.
