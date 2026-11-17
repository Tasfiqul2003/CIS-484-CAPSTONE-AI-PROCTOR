> Current hardening results: see [P3 hardening verification](p3-hardening-verification.md) for terminal recording interruption, async/audio recovery, final regression totals and actual backend/native-video acceptance. Earlier dated results below remain historical evidence.

# Developer prompt continuation — current implementation

November 16, 2026, P3, local **paulo** working tree. This supersedes the unfinished
implementation items in the earlier first-pass report. No commit, push, merge,
dependency/model installation, real capture or shared-infrastructure change.

## Screens and controls

- Existing student exam route: authorized five-environment preview, recording
  notice/retention before consent, typed answers, native speech draft recording,
  transcription, student correction/confirmation and separate answer submission.
  The draft uses the already owned microphone stream. Native provider input is
  PCM WAV; the browser explicitly decodes/resamples compressed drafts offline.
- **Examiner controls and assistance** now includes **Play saved question audio**,
  replay and stop. The exact validated WAV bytes are saved, hash-checked before
  browser playback, and reused without synthesis on replay. Browser read-aloud
  remains a separately labeled unsaved fallback.
- Professor **Question bank** includes **AI question drafts**: generate topic-bound
  proposals, inspect/edit, explicitly approve into the bank or reject. Drafts never
  enter student attempts. Approval is owning-professor-only, idempotent and limited
  to unpublished exams without active attempts.
- Professor active-attempt **Live view** uses the existing assessed stream and
  direct local WebRTC. No public relay/STUN/TURN or device acquisition is added.
- Professor **Exam recording and transcript** replays each stored question asset
  alongside its actual interaction text, answer and draft provenance. It separates
  generated-only assets from browser-reported started/ended playback, provides
  native playback/speed/exchange seek, and shows a delivery/interruption timeline.
  Missing/expired assets and incomplete observations remain explicit.

## Contracts and safeguards

1. Answer retries retain their request identity and use one academic transaction
   for JSON/SSE. The server records answer-submission observations in that same
   transaction. Old academic-unit fixtures isolate this new writer; real timeline
   insert/rollback/constraints have separate SQLite tests.
2. Assessed opening and follow-up questions come from the approved bank. A missing
   bank ends/fails clearly instead of introducing an unapproved model question.
   Live generated follow-ups remain an explicitly marked demo-only behavior;
   professors generate and approve assessed follow-up proposals before publication.
3. Timeline events are scoped to the authorized attempt and immutable interaction,
   bounded, idempotent and monotonic when supplied by clients. Interruption/end
   events mark continuity boundaries. Offsets and playback reports are browser
   observations, not verified encoded timing or proof the student heard anything.
4. Exact audio is tied to attempt, interaction, question text hash, voice/speed,
   synthesis request and fixed recording expiry. It is available to the student
   while authorized/active and to the owning professor after submitted recording
   completion. Every file/range read rechecks access, retention and byte integrity.
5. Five saved audio configurations and128 request IDs per question bound storage.
   Safe UUID paths, exclusive writes, flush/fsync before DB commit and cleanup on
   failures avoid claiming a missing file was delivered successfully. Retention
   cleanup includes known/orphan question WAVs and separately expired assets, with
   observable partial failures and safe retries. No real cleanup was run.
6. Scores remain private provisional suggestions. No emotion, confidence, honesty,
   disability or misconduct inference was added. No identity/roster/recording gate
   was bypassed to claim a working exam.

## Real offline speech evidence

The installed **Windows System.Speech** provider was verified with a generated
WAV and no microphone/speaker: synthesis **0.656s**, recognition **1.078s** for
the short fixture. This does not establish student speech accuracy or long-input
latency. Fourteen native-provider tests, including opt-in OS roundtrip, passed
after removing backend credentials from both probe and synthesis/recognition
subprocess environments. No unrelated package, weights or Chatterbox was installed.

`CYBROS_SPEECH_PROVIDER=windows-system-speech` explicitly selects the provider.
The P3 launcher now selects it through `settings.speech_provider`, defaulting to
the verified native provider on this configured P3 launcher. Set that private
setting to `disabled` to opt out. Other deployments remain disabled by default.
The launcher was not run; its configuration change takes effect on a later start.

## Current migration state and local validation plan

These **five additive migrations remain unapplied** to the P3 database:

| File | Effect |
|---|---|
|016_exam_media_contracts.sql|Atomic answer receipts and transcript provenance|
|017_student_environment_preferences.sql|Student/exam-scoped presentation preferences|
|018_media_delivery_timeline.sql|Durable media observations and interaction identity index|
|019_question_audio_assets.sql|Private immutable WAV asset metadata and request receipts|
|020_question_drafts.sql|Professor generation ledger and isolated approval/rejection drafts|

No existing migration or baseline was rewritten. `/health/ready` rejects a
database missing the required schema; normal startup does not migrate it.
Recording retention stays fixed at November15,2027,23:59:59 America/New_York.
Transcript and backup policy remain separate and no deletion schedule was added.

The user previously shut down CYBROS. Running-stack validation needs approval to:

1. Start only the owned local P3 database for maintenance and inspect actual DB
   identity, migration ledger, source hashes and connection readiness.
2. Make a protected custom-format database backup, verify its listing and restore
   it into an isolated validation database. Preserve all original persistent data.
3. Validate/apply016–020 to that isolated restore first. Apply to the P3 database
   only after that succeeds and the backup is confirmed.
4. Start the existing localhost backend/frontend, reuse externally managed Ollama
   without changing its lifecycle, and run authenticated synthetic HTTP/browser
   checks. Do not publish a real exam, forge a face check, or acquire real devices.
5. Verify readiness and a bounded owned-process restart/stop procedure. Report
   actual results separately from mocked tests. No database reset, shared server,
   OS service, scheduled task or broad network exposure is part of this plan.

Rollback has not been executed. Preserve the protected backup and additive data;
revert only reviewed feature code if required. Do not drop tables or restore over
the live database without a separately reviewed recovery decision.

## Evidence and remaining limits

Final complete offline run: **811 Python tests passed,4 skipped,143 subtests
passed,210 warnings,15.17 seconds**. The four skips are the actual PostgreSQL
checks awaiting an explicit isolated validation URL and approved DB maintenance.
The run includes native generated-WAV synthesis/recognition through authenticated
saved-audio and transcription routes backed by isolated SQLite. No real exam,
identity verification or deployed PostgreSQL integration is implied.

**102 frontend unit tests passed**. TypeScript and production build passed
(2013 modules,2.77s; main bundle501.83kB with the normal500kB advisory).
All24 SQL catalog files passed the existing migration loader's structural checks;
this is not a claim of PostgreSQL execution.

All four historical browser suites are repaired with meaningful contract/security
assertions retained: **55 checks**. New in-memory suites cover environment/retries,
speech drafts, login/review, stored audio, saved review and professor approval.
Stored-audio/review tests use actual muted synthetic PCM playback, not mocked
HTML media methods: **12+8 checks**. APIs and authentication are intercepted.

A separate actual Chromium WebRTC run passed **4 scenarios** with generated
animated canvas tracks. Real decoded remote frames increased2→5 and sampled pixels
changed; freeze/disconnect and mocked expiry/end closed the professor view. No
camera, microphone or display capture was called. Signaling/auth were mocked,
so this is transport evidence, not running-backend or real-network proof.

Across repaired/new browser suites, **90 checks/scenario groups passed**:
55 historical settings/navigation checks,8 environment/draft/review/login groups,
12 saved-question audio checks,8 saved-review checks,3 professor approval groups,
and4 native canvas WebRTC cases. Browser APIs/auth remain mocked. Native WAV
playback and the WebRTC peer connections are real and muted; no real device is used.

The prepared `scripts/validate_p3_upgrade.py` defaults to **plan**, not execution.
Its plan identifies016–020 among24 catalog files without reading private settings,
connecting to a database or starting any process. Only an approved explicit
`validate`/`apply` action performs the maintenance plan above. Start/stop/init and
maintenance now share a Windows lifecycle mutex; source application ports are
rechecked immediately before source migrations. Cleanup failures return a failed
status/exit and identify the unresolved cleanup instead of claiming success.
The12 maintenance safety tests passed as part of the full811 run.

`backend/tests/test_postgres_contracts.py` is prepared for the isolated restored
database. Its8 URL guards passed without connecting. The4 gated SQL tests cover
actual row-lock waits/two-tab retry, stale identity, rollback after a database
error, and composite timeline/audio foreign-key scope. They accept only an
explicit loopback `cybros_validation_*` URL, never generic `DATABASE_URL`.

Final read-only status: still local `paulo`; frontend/backend/database stopped.
An externally managed Ollama listener is running and was left untouched.
`git diff --check` passed (only Git's LF/CRLF normalization notice).

Remaining acceptance: actual PostgreSQL migrations/row locks, real authenticated
stack integration, persistence/restart/restore with the new assets, actual local
Ollama question-draft generation, and any explicitly authorized real-device exam.
No complete assessed exam is claimed from the synthetic or isolated component
checks. Chatterbox remains an unverified candidate; native Windows speech is the
implemented provider. Human speech quality and accessibility need real-use review.

Detailed contracts/evidence: speech-adapters.md, media-timeline-contract.md,
question-audio-retention.md, question-drafts.md, student-environments.md,
media-lifecycle-and-live-video.md and browser-regression-repair.md.
