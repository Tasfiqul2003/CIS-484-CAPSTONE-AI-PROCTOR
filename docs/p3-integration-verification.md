> Current hardening results: see [P3 hardening verification](p3-hardening-verification.md) for terminal recording interruption, async/audio recovery, final regression totals and actual backend/native-video acceptance. Earlier dated results below remain historical evidence.

# P3 integrated verification — November 16, 2026

This is the current local evidence report for the eight developer prompts. It
supersedes the earlier pending-startup and unapplied-migration notes in
`developer-prompts-continuation.md` and `p3-local-setup.md`. The source remains
uncommitted on `paulo` at `18f6a1c`; nothing was pushed, merged or deployed to the
shared Ubuntu host. The user instructed us to continue after the concrete local
backup/restore/upgrade/start plan was presented.

## Implemented application paths

- Professor question bank: approved topics and rubric editor, private question
  draft generation, edit/approve/reject controls, and an explicit freeze after
  an assessed attempt. Assessed attempts use the approved question bank.
- Student preview and exam: five built-in environments through the shared
  renderer, policy-scoped persisted preferences, typed answers, speech draft
  review/edit/confirmation, exact saved question audio, and recording/live states.
- Professor submissions: separate live viewing, retained recording review,
  original delivered question audio, transcript provenance and interruption
  timeline, plus private provisional evaluation and manual grading controls.
- Local operations: readiness checks, distinct backend-unavailable login errors,
  bounded owned-backend recovery, lifecycle locking, protected isolated upgrade
  verification, and frontend/model-process environment isolation.

See `eight-feature-evidence.md` for the requirements-to-evidence mapping and
the individual feature documents for API and browser support details.

## Database and persistence

The protected pre-upgrade backup was restored into a fresh isolated database
before migrations 016–020 were applied to P3. The migration ledger changed from
19 to 24 entries. A second migration pass on the restore applied nothing. No
existing migration, prompt baseline, model baseline or original database was
replaced. Normal application startup does not run migrations.

The first upgrade report is protected at
`private-data/p3-local/backups/upgrade_20261116_233924_3ffdb677/validation.json`.
Post-upgrade restore validation also succeeded during lifecycle verification;
its report is `backups/upgrade_20261116_234739_c1224b9b/validation.json` under the
same protected data root.

Recording and question-audio retention remains the approved fixed deadline:
November 15, 2027, 23:59:59 America/New_York. Transcript and backup retention
remain separate; no deletion schedule was installed and no real-asset cleanup
was run. Protected backups contain account data and must remain outside Git.

Final isolated validation passed **14 tests in 11.90 seconds**: eight destination
URL guards and six real PostgreSQL contracts, including concurrent answer row
locks, stale-tab rejection, atomic rollback, composite foreign-key isolation,
HTTP media provenance/recovery and actual local-model provisional evaluation.
The source ledger was 24 with no pending migrations; this final `validate`
applied no source changes. Its created validation database was removed and its
owned maintenance PostgreSQL process stopped without cleanup failures.
Report: `backups/upgrade_20261117_002855_85c2e638/validation.json` under the
protected data root.

The media contract made a second custom-format dump after two distinguishable
synthetic question WAVs and their metadata existed. It restored that dump into
another exact owned database and restored the WAVs separately into a fresh
asset root. Question order, transcript provenance, timeline IDs/offsets, bytes,
hashes and range reads survived. Database-only playback failed with 409 until
the separate asset restore. Only owned restored fixture files and that secondary
database were removed; protected dump/ZIP/manifest evidence remains in
`backups/media_restore_*/`. This does not back up real media automatically.

The first real grading call failed safely: the model echoed the grading input
as valid JSON, so no scores were saved. The request now supplies an explicit
output schema and rejects unfinished/truncated/invalid responses. The final
single real Ollama call took **8.319 seconds**. Its suggestions stayed private
with final score/graded time unset until explicit professor confirmation;
student report/grade/confirm requests were denied. Repeating generation after
confirmation returned 409 without a second model call. This used synthetic
completed metadata in the isolated database, not a captured or verified human
exam. The failed temporary database was removed after successful verification;
its protected backup and diagnostics were retained.

## Measured local integration

- **24 lifecycle checks passed** using actual localhost HTTP/proxy traffic and
  synthetic professor/exam data. The controlled backend failure stopped only a
  verified launcher-owned process; it does not identify the cause of a past
  disappearance. The browser showed service unavailability rather than bad
  credentials. Bounded backend recovery took 2.421 seconds; full stop 0.469
  seconds; isolated post-upgrade restore 6.735 seconds; full restart 4.593 seconds.
  Authentication cookies and synthetic database state survived restart, and
  the owned scratch exam was removed. External Ollama stayed running.
- **7 actual localhost browser checks passed**, including professor login,
  creation/removal of an unpublished scratch exam, saving/reloading approved
  topics and rubric through the UI, five distinct shared-renderer environments,
  and the 390-pixel layout. No exam was published and no devices were requested.
- **19 real question-draft stages passed** through the backend and existing
  local Ollama model. Two generated drafts took 22.219 seconds; replaying the
  same request UUID took 0.016 seconds. Edited approval was idempotent, rejection
  did not add a bank question, another professor received 404, and the owned
  unpublished scratch exam was removed.
- Native Windows System.Speech generated-WAV synthesis took 0.656 seconds and
  recognition 1.078 seconds. These are short synthetic fixtures, not human
  speech accuracy/latency measurements. A separate browser MediaRecorder
  WebM/Opus round trip produced a valid 3.72-second mono 16 kHz PCM WAV through
  the production converter and native recognizer; device and speaker use were
  zero. Other deployments keep providers disabled unless configured.

Lifecycle report: `verification/lifecycle_20261116_234731/report.json`.
Draft report: `verification/question-drafts-live-20261116T234918Z.json`.
Browser reports: `verification/browser-smoke-*/report.json`.
All paths in this paragraph are under ignored `private-data/p3-local/`.

## Offline and synthetic checks

The final complete Python regression passed **852 tests**, with **143 subtests**,
6 intentionally gated PostgreSQL/model tests skipped, and 230 warnings in
16.89 seconds. Native generated-audio tests were enabled; the isolated live
database tests are run separately rather than silently pointing this suite at
the primary database.

Frontend Node unit tests passed **102/102** with no skips. TypeScript passed.
The final production build passed with 2,015 modules in 2.75 seconds and goes to
`.cache/implementation-frontend-build`, preserving tracked historical
`frontend/dist`. Its existing large-bundle advisory remains nonfatal (514.26 kB
main JS, 145.30 kB gzip). Historical browser suites retain their ownership, unexpected-request,
media and mutation assertions; current results are in
`browser-regression-repair.md`.

Seven mocked assessment-browser scenario groups include deliberately late
responses after an attempt switch. Old GET, evaluation, confirmation and error
responses cannot replace the new attempt's state or trigger its confirmation
callback. Fresh saved AI suggestions leave manual score inputs blank until the
professor explicitly copies or enters a score.

Four actual Chromium WebRTC scenarios passed using generated animated canvas
tracks, real peer connections and changing decoded frames. Signaling and
authentication were intercepted. Stored-audio tests used muted synthetic PCM
playback. These establish browser transport/playback behavior, with scope
distinct from real devices, a complete human exam, or a deployed network.

## Local operation and limits

From the application checkout in PowerShell:

```powershell
.\.venv\Scripts\python.exe scripts/cybros_local.py status
.\.venv\Scripts\python.exe scripts/cybros_local.py start
.\.venv\Scripts\python.exe scripts/cybros_local.py stop
```

The website is http://127.0.0.1:5173. The backend is on 8000, P3 PostgreSQL on
55432 and external Ollama on 11434. Status separates listening, owned-process
presence and readiness. Stop preserves data and leaves external Ollama alone.
No permanent Windows service, scheduled task, public relay or automatic
deletion process was installed.

The final restart loaded the current backend and frontend. Backend readiness,
frontend proxy readiness and Ollama readiness all passed. All four listeners
were bound to `127.0.0.1`. The verified owned frontend process had none of
`DATABASE_URL`, `PGPASSWORD`, `AUTH_SECRET_KEY`, `ADMIN_BOOTSTRAP_TOKEN` or
`EXAM_VIDEO_DIR` in its environment; only presence booleans were inspected and
recorded. The external Ollama process/environment was not changed or adopted.
Final runtime evidence is protected at
`verification/final-runtime-20261117T003250Z.json` under the local data root.
The source ledger had 24 entries and source exam-session count remained zero;
the tests did not leave synthetic assessed attempts in the primary database.

For a reviewed maintenance window, `validate_p3_upgrade.py plan` is read-only;
`validate` makes a protected backup and checks a fresh isolated restore while
the application is stopped. `apply` additionally applies pending source
migrations only after validation. Never restore over the primary database or
drop feature tables as a casual rollback; retain the backups and review data
recovery separately. Rollback has not been performed.

No real camera, microphone or display capture, face-check bypass, published
exam, or complete human assessed-exam walkthrough was performed. Human speech
quality, real identity decisions, device/browser accessibility and direct-peer
network reachability still need explicit real-use acceptance. The local live
transport is single-backend-worker direct WebRTC with no public STUN/TURN relay.
Chatterbox remains an unverified optional candidate; the implemented P3 provider
is native Windows speech. No automated emotion, confidence or integrity
inference was added. Actual AI latency varies; measured short prompts do not
establish real-time behavior.
