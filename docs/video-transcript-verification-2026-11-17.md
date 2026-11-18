# Video and transcript verification

Verification date: 2026-11-17, America/New_York. Source baseline:
`ec980e85a8c527d7d4904dc34a11e9dca12ce548` on `kay`.
The working branch is `kay-video-transcript-polish`.

## Source saved in Git

The installed 17-file speech update was copied byte-for-byte, allowing CRLF
differences, into a checkout retaining Kay's existing Git history. Commit
`8fa174e` saves that previously uncommitted source. Subsequent work on the
same branch contains the decoder fix, laptop limits, upload recovery,
review improvements, setup controller and installer checks. Run `git log -2
--oneline` in this checkout for both commits. No branch was pushed or merged.

The user's active Desktop checkout is protected from writes in this session.
Its existing source, stash, branch, upstream and recovery files were preserved.
The reviewed package can copy and commit the exact source paths there without
staging unrelated changes. It refuses changed HEADs, unexpected source edits,
existing staged work, unsafe paths and incorrect payload hashes. Original
bytes are backed up before writes. Repeating a successfully committed update
is recognized using the package receipt.

## Implemented behavior

- Saved consent precedes camera/microphone capture; declines and capture
  failures allow exams, typed answers and grading to continue. Demo sessions
  remain excluded. These existing rules were retained and regression tested.
- Combined WebM uploads are sequential and retry with the same index/bytes.
  Completion queues speech transcription durably. A failed database commit
  preserves recovery chunks; successful completion releases duplicate chunks
  when possible. On Linux, the final directory rename is synchronized before
  the metadata commit. Cleanup failures do not discard a completed recording.
- The offline worker processes submitted, consented, unexpired recordings,
  saves timestamped text independently of typed answers, bounds retries and
  processing time, and prevents stale leases from restoring expired text.
- Owner-only playback, recording downloads and transcript downloads use the
  private authenticated API. Expiry hides transcript text and blocks downloads.
- Pending professor-review polling backs off to thirty seconds, pauses while
  the tab is hidden, times out failed requests, and offers a manual refresh.
  Authorization failures clear loaded evidence; changing sessions cannot show
  another session's previously loaded data.
- `faster-whisper==1.2.1` is paired with `av==18.1.0`. Synthetic codec validation
  now precedes model checks. The dedicated worker requirements omit OpenCV and
  document parsers. No application model selection or GPU reservation changed.

## Laptop limits

| Component | Configured limit |
| --- | --- |
| Transcription container | One CPU core, 1 GB RAM, 128 processes |
| Model | Existing English base.en model, CPU int8, one thread |
| Job concurrency | One decoder child per worker container |
| Temporary filesystem | 64 MiB |
| Browser camera | At most 640 by 480 pixels, 15 fps; VP8 preferred |
| Browser pending upload data | 16 MiB |
| Video preloading | Metadata only; playback starts on user request |

These are configured ceilings, not measured peak RAM, speed or accuracy results.
No model is loaded by an idle queue poll. A job child releases its model when
it exits. `-NoStartWorker` provisions/checks the model without starting the
queue loop; the documented stop command releases a running worker's resources.

## Measured checks

| Check | Actual result |
| --- | --- |
| Full backend suite, final source | 591 passed, 2 skipped |
| Recording storage after directory-sync change | 45 passed, 2 skipped |
| Full frontend unit suite | 103 passed |
| Production frontend build | Passed; existing bundle-size advisory remains |
| Repository unittest discovery | 100 passed, including 9 real synthetic Git installer tests |
| Setup controller fixture | 9 checks passed with mocked Docker |
| Worker imports | Does not load OpenCV or document parsers |
| Python/PowerShell syntax and Git whitespace | Passed |

Backend HTTP tests used the existing in-process Windows test runner because
this sandbox blocks normal wakeup sockets. It changes test infrastructure,
not application code, and does not verify a live network transport. The two
skips are host restrictions on creating test hardlinks and symlinks. Existing
FastAPI/httpx and SQLite datetime deprecations remain.

## Runtime steps still requiring the laptop terminal

Docker's API is inaccessible from this session. The fixed Docker image,
real codec/model transcription and browser camera/microphone capture have
not been verified here. The earlier terminal output showed the model
downloaded and loaded but then failed in PyAV audio decoding. The guarded
setup will reuse that complete model directory and retest synthetic speech.
The dedicated dependency list needs its container build verified as well.

The prior terminal output reported all six missing migrations, including
018, committed together with a verified backup. This session did not rerun
SQL. The backend's persistent recording mount still needs runtime inspection,
and a recording/transcript retention end date has not been provided. Capture
remains unavailable with blank retention; exams continue.

`Finish_Video_Transcript.ps1 -Apply` checks and applies the reviewed source,
commits its exact paths in the active checkout, then builds/tests only the
speech worker. It preserves the current upstream and does not push, rerun
migrations, restart DB/Ollama/avatar services or blindly recreate the backend.
Use `-SkipRuntime` for source/Git only or `-NoStartWorker` to provision/test
without starting the worker. After activation, use a synthetic student/exam to
verify consent, speech, submission, playback, saved text and a refreshed text
download. Also decline recording and verify typed answers still save.

Local source, verification notes, setup and installer code are committed.
Credentials, model weights, database dumps and actual recordings/transcripts
are kept outside source control.
