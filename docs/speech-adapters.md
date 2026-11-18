# Optional backend speech adapters

Implemented November 16, 2026. `backend/app/speech_adapters.py` is an offline-safe
boundary between exam orchestration and optional speech providers. Importing it
does not open devices, contact a network, load weights, start services, or read a
database. No provider is installed or enabled by this change.

## Current evidence and assumptions

The existing website has typed answers and browser question read-aloud. The
standalone Faster-Whisper/Ollama/Piper scripts are separate desktop prototypes,
not importable backend adapters: importing the foundation script runs its media
workflow. No Chatterbox implementation/configuration was found in the current
backend or documentation. Its actual API, license, runtime, assets and hardware
requirements remain unverified. Consequently this change exposes both synthesis
and transcription as unavailable unless a server-owned provider is explicitly
injected and reports readiness. It installs nothing and never selects a cloud
service automatically. Browser speech synthesis remains a separately labeled
fallback; it is not an original delivered-question audio asset.

Presentation already uses the authenticated backend policy/presentation APIs and
`avatar_session.student_policy` to expose permitted display settings. Speech
providers and frontend renderers receive no database credentials. SoulX/FlashHead
remain excluded. A basic static renderer is independent of speech availability.

## Contract

- `SpeechContext(attempt_id, interaction_id, question_revision, request_id)` uses
  UUID correlation identifiers and a bounded opaque revision string. A context
  is correlation data, not authorization. Routes must resolve ownership, the
  active attempt/question and the actual revision from trusted server state.
- `SpeechOutputRequest(context, text, voice="calm", speed=1.0)` accepts approved
  student-facing text only. The route selects delivered question text from the
  authorized interaction, never assessor reasoning/rubrics or arbitrary client
  instructions. `synthesize` returns `SpeechAudio` with WAV bytes, measured PCM
  duration, identical correlation, and `complete` status.
- `TranscriptionRequest(context, audio, mime_type)` produces a `TranscriptDraft`
  with `machine_draft` source and `review_required` status. It never submits an
  answer, increments the question, evaluates a student, or asserts confirmation.
  Student edits and explicit confirmation belong to the separate answer API.
- `SpeechService(synthesis=None, transcription=None, timeout_seconds=30,
  concurrency=2)` accepts server-owned implementations of the provider protocols.
  `capabilities()` reports in-memory verified readiness via `ProviderStatus`;
  an enabled setting alone cannot turn an absent/failing provider into available.
  Provider `status()` must be a fast local check with no blocking network I/O.
- Both service operations require `is_current(context)`, a synchronous or async
  server guard checked before work, after acquiring a generation slot, and before
  returning output. It must re-check active interaction/revision and authorization,
  including attempt termination and expired credentials. A false result discards
  the output with `stale_context`. It is not a replacement for route authentication.
- `cancellation=asyncio.Event()` allows explicit request cancellation. Cancelling
  the HTTP coroutine also cancels provider work. A request timeout includes waiting
  for a generation slot. There are no automatic retries; route idempotency and
  provider job correlation must prevent duplicate work on explicit retries.
- Safe `SpeechError` objects expose `code`, `status_code`, and a fixed public
  message. Provider exceptions are not copied into responses/logs. Draft text and
  audio are excluded from dataclass repr output. Route errors must still avoid
  logging raw requests, transcripts, audio, tokens, or provider credentials.

## Resource and format boundaries

Inputs and outputs are limited to 10 MiB of audio, 8,000 text characters, and
120 seconds of audio. Output is decoded/validated PCM WAV, 8–48 kHz, one or two
channels, one to four bytes per sample. Duration comes from actual sample data;
truncated, empty, oversized and unsupported WAV output is rejected. Voice must
appear in the ready provider's supported voice list. Speed is finite and 0.5–2.

Input WAV receives the same decode checks. WebM/Ogg/MP4 input receives bounded
container signature checks; the actual configured transcription provider must
decode safely, reject malformed data, and enforce the 120-second decoded duration
before inference. There is no backend compressed-media decoder. The native provider requires
PCM WAV, and the browser conversion path below performs its codec conversion
before submission. Other future providers must demonstrate their own decode
checks before enabling compressed input.

Generation concurrency is limited to two operations per service instance by
default (configurable 1–8). Multiple server workers require a provider-wide budget.
Providers must honor cancellation. A non-cooperative coroutine cannot be forcibly
terminated safely by this library; it retains its slot until it ends, late output
is discarded, and the HTTP request still returns within its deadline. Real
subprocess/GPU adapters need their own owned-process termination/resource controls.
No output is persisted here; the route/media layer owns authorized delivery,
retention, storage limits, original audio preservation and asset access.

## Verification

From the repository root, with the existing environment and services stopped:

```powershell
.\.venv\Scripts\python.exe -m pytest backend/tests/test_speech_adapters.py -q -p no:cacheprovider
```

Measured: **33 passed in 0.31 seconds** on P3, using only generated WAV fixtures,
synthetic providers and async state guards. Covered success/correlation, machine
draft provenance, missing/failing providers, malformed/oversized/truncated audio,
duration/voice/text/speed limits, empty transcript, timeouts, explicit and task
cancellation, concurrency, queued stale work, cross-attempt isolation and private
provider exception suppression. No database, camera, microphone, speaker, model,
network, Chatterbox, Faster-Whisper or Piper integration was exercised. Real
provider latency, resource use, decoder behavior and shutdown remain unmeasured.

No schema migration, environment variable, model weight or installer is introduced
by these adapter files. Removing their route consumers before removing the module
is sufficient to roll this boundary back; persisted data is unaffected.

## Authenticated web boundary

`exam_speech.router` adds attempt-scoped `/exam/sessions/{session_id}/speech/`
routes. `GET capabilities` requires the current student session. `POST transcribe`
accepts a raw audio request body with `sequence_num` and UUID `request_id` query
parameters. Streaming input is capped at 10 MiB and 20 seconds; authentication,
active-question state, configured provider readiness, saved policy, exam clocks
and assessed recording readiness are checked before reading the body. The raw
body avoids an unbounded multipart parser spooling uploads before validation.
`POST synthesize` accepts only those correlation fields as JSON and obtains the
actual approved question text, voice and allowed speed from the backend. It never
accepts client-supplied synthesis text or assessor context. The returned WAV uses
`Cache-Control: no-store`; this endpoint does not establish a saved original audio
asset or implement question-audio archival.

Both operations re-check the signed student token, ownership, active interaction,
question revision, saved presentation, minimal-mode restriction and exam deadlines
before and after async provider work. Read transactions are released between
checks, so provider delays do not hold locks or stale transaction snapshots.
No operation advances a question, changes the exam clock or consumes an answer.
Timeout is HTTP 504; provider unavailability is HTTP 503; rejected draft
provenance is HTTP 422. The server has no automatic external provider selection.

Transcription returns `transcript_receipt`, an HS256 receipt generated by
`transcript_receipts.py` using the existing application signing secret. It binds
student, attempt, interaction, question sequence, draft UUID and SHA-256 of the
original machine draft, without putting draft text in the receipt. Expiry is the
earlier of one hour and the original student token deadline. The answer API must
verify this receipt against its currently authorized pending interaction before
accepting `confirmed_transcript` provenance. Student-edited answer text remains
separate from the attested original draft. A receipt proves draft provenance,
not answer truth, speaker identity or student confirmation by itself.

`SpeechDraftPanel.tsx` checks capabilities and shows unavailable input truthfully.
With an explicitly configured ready provider it uses an audio-only wrapper around
the already permitted assessed stream; it never calls `getUserMedia` or stops
owned tracks. Students stop a draft recording, review/edit the machine transcript,
and explicitly choose **Use reviewed transcript** before a separate **Submit
answer** action. The existing typed textarea remains available. Later edits retain
draft provenance; **Use typed answer** explicitly resets the source. Generation
guards and aborts discard responses after a question change or cancellation.
Browser question read-aloud is stopped while a speech draft is captured.

Assumption: existing policy has no independent speech-answer prohibition, so a
confirmed speech draft is an equivalent text-answer input path. Saved question,
assistance, timing, identity and assessed recording rules remain in force. This
change introduces no emotion/confidence/integrity inference.

Additional measured checks on P3, with services still stopped:

- Adapter plus authenticated speech API suite: **54 passed**. API tests use SQLite,
  generated WAV and injected providers, with the exam clock reader isolated from
  PostgreSQL-specific SQL. They cover session/ownership/purpose/expiry rejection,
  signed receipt rebinding/tampering, active question, ended attempt, late output,
  provider absence/timeout, bounded uploads and minimal-mode refusal.
- Speech response/provenance helper tests: **2 passed**.
- Fully mocked in-memory Chromium speech UI: **3 scenarios passed** (unavailable
  state with no device request; synthetic capture/draft/edit/explicit confirmation;
  failure/cancellation/question changes preserving drafts and owned tracks).
- Existing in-memory environment/StudentExam browser suite: **3 scenarios passed**
  after speech/live integration. This is a simulated developer attempt, not a real
  assessed-media or provider run. TypeScript `--noEmit` passed.

The student exam page also wires the separate authenticated live-video controller
to the existing assessed stream, closes that controller on completion/unmount,
shows a muted local preview, fails closed on device-ended events, and displays the
configured recording deadline before consent/device acquisition. Neither those
code changes nor synthetic speech tests establish a real student/professor live
connection. Real browser/device/provider latency and original-audio persistence
remain separate verification work.

## Explicit native Windows provider

`windows_speech.py` and `windows_speech_worker.ps1` now implement a local
**Windows System.Speech** provider. This is not Chatterbox. No Chatterbox,
Faster-Whisper, Piper, torch, ONNX, Vosk, sound-device or Transformers package was
found in the current venv metadata during this inspection, and no matching cached
voice assets were found in the checked backend/cache locations. Nothing was
installed or downloaded.

P3 already has enabled **Microsoft David Desktop** and **Microsoft Zira Desktop**
en-US synthesis voices and the **MS-1033-80-DESK** en-US offline dictation engine.
They were enumerated without opening audio devices. With the backend stopped,
set the following only in the intended local launch environment before starting
it through the normal authorized procedure:

```powershell
$env:CYBROS_SPEECH_PROVIDER = 'windows-system-speech'
```

With no value, a different value, a missing Windows runtime/voice/recognizer, or a
failed metadata probe, the corresponding capability remains unavailable.
The service factory probes metadata once per server process and caches readiness;
changing installed voices/configuration requires a normal backend restart. This
change did not start the backend or alter persisted local configuration.

Native synthesis selects David for `calm` and Zira for `clear`, with a verified
installed English voice as fallback. These are presentation names only. Windows
rate maps the permitted speed setting approximately; exact speed ratios are not
promised. Synthesis writes mono 16 kHz signed16-bit PCM WAV, never speakers.
The recognizer reads that format from a file with a dictation grammar and handles
multiple utterances until end-of-file, never a microphone. These file-only APIs
are documented by Microsoft: [WAV synthesis output](https://learn.microsoft.com/en-us/dotnet/api/system.speech.synthesis.speechsynthesizer.setoutputtowavefile?view=netframework-4.8.1)
and [WAV recognition input](https://learn.microsoft.com/en-us/dotnet/api/system.speech.recognition.speechrecognitionengine.setinputtowavefile?view=netframework-4.8).

Private text travels to a hidden, owned Windows PowerShell process as bounded
JSON on stdin, never executable command text or command-line arguments. Audio is
written to per-request temporary directories in the server account's temporary
location and removed on success/failure/cancellation. That location must retain
appropriate account ACLs. The worker has no database/provider credentials, never
evaluates input strings, and returns only bounded JSON. Native stderr/exception
text is not exposed. Python limits request IPC to 100,000 bytes, stdout to 64 KiB,
stderr to 8 KiB, work to 28 seconds plus at most two seconds of shutdown, and kills
only its owned process on timeout/cancellation. The outer service still enforces
its concurrency budget and 10 MiB/120-second audio acceptance limits. Very long
text can synthesize audio beyond that limit; such output is rejected, not served.

Native transcription advertises **only `audio/wav`** in
`transcription.accepted_mime_types`; compressed media is rejected before native
recognition. The browser speech panel uses `OfflineAudioContext` to decode its
recording, downmix/resample to mono 16 kHz, and encode PCM WAV when the provider
requires WAV. This processing renders into memory rather than an audio device,
as described in the [OfflineAudioContext constructor documentation](https://developer.mozilla.org/en-US/docs/Web/API/OfflineAudioContext/OfflineAudioContext).
An unsupported/corrupt browser codec produces a visible error and retains the
typed answer; compressed-format support is not fabricated. The original assessed
recording stream and its tracks remain under the existing exam recorder's ownership.

Measured native file-only evidence on P3, November 16, 2026:

- A generated sentence produced a **117,806-byte** PCM WAV in **0.400 seconds**
  through native .NET APIs, and native dictation returned the sentence in
  **0.533 seconds**. No playback or human speech was used.
- Through the actual bounded backend provider and service, synthesis took
  **0.656 seconds** and transcription **1.078 seconds**, including hidden process
  startup. The recognized text was “The library contains books about computer
  science” for the generated fixture. This is a fixture observation, not an
  accuracy or latency guarantee for student speech or long answers.
- **12 native-provider tests passed**, including the actual generated-WAV round
  trip with explicit `CYBROS_RUN_NATIVE_SPEECH_TESTS=1`. Additional tests cover
  disabled/default configuration, missing runtime, metadata caching, exact MIME,
  file cleanup, bounded IPC and subprocess cancellation. Normal test runs leave
  the OS integration test explicitly opt-in; the remaining tests use fakes.
- Final adapter/API/native suites together passed **66 tests in 2.89 seconds**,
  including all 12 then-current native-provider checks. The subsequent credential-environment
  regression additions brought the separately verified native suite to 14 tests.
  Speech helper tests now pass **3 tests**. The mocked speech UI still passes
  **3 scenarios**. A separate real Chromium **offline** decode/PCM-encode check
  passed on a generated WAV and rejected corrupt compressed bytes. TypeScript
  `--noEmit` passed.

Reproduce native integration without application services or real media:

```powershell
$env:CYBROS_RUN_NATIVE_SPEECH_TESTS = '1'
.\.venv\Scripts\python.exe -m pytest backend/tests/test_windows_speech.py -q -p no:cacheprovider
```

No real student speech, microphone, camera, speaker, web/provider end-to-end
attempt, assessment quality, cloud integration or
Chatterbox implementation was exercised. Human speech accuracy and long-input
resource measurements remain pending. Original question-audio persistence and
professor replay are owned by the media delivery layer, not the native provider.


The installed Uvicorn single-process Windows loop uses ProactorEventLoop, which
supports async subprocesses. Native speech was verified with that Python loop.
Windows reload/multiple-worker configurations using SelectorEventLoop are outside
this verified native-provider support; no server was started to change its loop.


Both native metadata probes and speech jobs use an explicit minimal Windows
runtime environment. Only operating-system/user/temp/application-data directory
variables are forwarded; PATH is rebuilt from Windows system directories.
DATABASE_URL, AUTH_SECRET_KEY, PGPASSWORD, bootstrap tokens and all arbitrary
application variables are excluded from the speech process. Regression tests
inject synthetic secrets and an untrusted PATH and verify exclusion on both
subprocess launch paths. No credentials or database connection are sent on stdin.


## Generated spoken WebM/Opus conversion verification

The codec coverage gap was resolved on November 16, 2026 by extending
`frontend/tests/speech-wave-browser.test.mjs`. This now uses a real Chrome
`MediaRecorder` rather than pretending a WAV blob is WebM or relying solely on a
fake recorder. It generates a native spoken WAV through the existing sanitized
file-only Windows speech worker, decodes it into an audio buffer, and connects
the source **only** to `AudioContext.createMediaStreamDestination`. There is no
connection to the speaker destination. Headless Chrome uses `--mute-audio`; the
test rejects any JavaScript connection to an `AudioDestinationNode` and makes
camera/microphone/display capture methods fail immediately.

The actual tested path passed:

1. Native generated speech WAV.
2. Real browser `MediaRecorder` WebM/Opus encoding of that internally generated
   stream.
3. The production `prepareSpeechAudio` path, decoding/resampling that actual
   WebM into mono 16 kHz signed16-bit PCM WAV.
4. Actual backend `_validate_audio` acceptance of the resulting bytes.
5. Native offline file ASR recognizing the fixture words “library” and “computer
   science” after the codec conversion.

Measured output: **27,944 WebM bytes** became **119,084 WAV bytes**, with **3.72
seconds** of decoded audio at **16,000 Hz, one channel, 16 bits**. Browser
generation/recording/conversion took **4.051 seconds**. Native fixture synthesis
including metadata probe/process startup took **1.297 seconds**; backend
validation plus native ASR/probe took **1.546 seconds**. The recorded counters
were **0 getUserMedia calls, 0 getDisplayMedia calls, and 0 speaker connections**.
All generated temporary input/encoded/converted files were removed after checking
the resolved cleanup target stayed in the test's own cache directory.

This test bypasses no application authorization or identity checks: it does not
create a student session, forge a token, modify a database or call a live exam
endpoint. It proves the real generated-audio codec/adapter path on this Chrome
and Windows setup, alongside the separate authenticated API tests. It does not
prove microphone quality, human speech recognition accuracy, an assessed exam,
other browser codecs or a professor/student live-media connection.

From `frontend`, using the existing bundled Playwright installation:

```powershell
$env:AVATAR_NODE_MODULES_PATH='C:\Users\Paulo\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
node tests/speech-wave-browser.test.mjs
```

No production code changes were needed for this additional verification.


## Speech UI deadline and availability follow-up

A concrete timeout-state bug was corrected: aborting the transcription fetch
alone did not release the UI when offline audio preparation was still pending.
The entire preparation, request and response-body wait now races its owned abort
signal. Its existing 55-second deadline promptly restores ready controls and typed
input even when a decoder promise never settles. A late decoder result cannot
upload audio or replace the draft. Browser decoder computation itself is not
forcibly stopped; its result is safely ignored after cancellation.

Capability discovery is now bounded to 12 seconds and exposes **Retry speech
availability** with an unavailable/timeout message. A timeout cannot leave the
panel indefinitely checking availability. Retry preserves the typed answer and
same-question reviewed draft. Availability, transcript results and confirmation
controls are scoped to the current attempt/token/question; an earlier lookup or
question cannot change the new question's controls. No capability failure
automatically acquires a device or submits an answer.

Focused follow-up evidence: **6 speech helper unit tests passed** and **6 mocked
speech browser scenario groups passed**. The browser test holds a decoder past an
accelerated deadline, verifies ready/busy state and a clean retry, and holds
fully read capability responses that deliberately ignore a later abort. It checks
typed-input preservation, explicit availability retry and old-question isolation.
All devices are fake/blocked. This is additional async-state evidence; the earlier
real generated-WebM codec verification remains separate.
