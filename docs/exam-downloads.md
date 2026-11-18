# Download all examination files

**Download all** appears at the top of Student Progress, the student examination
review and the detailed assessment page. The exam-level button downloads every
submitted, non-demo attempt for that exam, regardless of the current table
filter. The student-level button downloads only the reviewed attempt.

Each ZIP uses a separate `attempts/<session UUID>/` folder with available files:

| File | Contents |
| --- | --- |
| `attempt.json` | Student name/EID, attempt identifiers, status, identity flags and expiry metadata |
| `typed-answers.txt` | Questions and saved submitted answers |
| `grades.txt` | Saved AI recommendations and professor-confirmed grades, clearly distinguished |
| `recording.webm` | Original completed camera/microphone recording, when available |
| `speech-transcript.txt` | Completed saved speech transcription, separate from typed answers |
| `README.txt` | Availability states when the export was requested |

Pending, failed, declined or expired recording/speech artifacts are omitted;
typed answers and grades remain downloadable. An empty completed speech
transcript is preserved as an empty file. A recording that expires or changes
after preparation is replaced by `recording-unavailable.txt`; a speech text
that expires before streaming gets a corresponding unavailable notice.
This does not requeue transcription, generate grades or modify exam records.

The endpoints require the owning professor and a submitted attempt. Anonymous,
student, other-professor, developer-demo and unsubmitted attempts cannot use
them. Expiry, protected recording paths and file-size checks are retained.
ZIP names use validated UUIDs, not student-supplied names or paths. Responses
are private and non-cacheable.

The browser downloads directly without a JavaScript media blob. The API streams
ZIP64 entries in chunks of at most 1 MiB and stores media without recompression.
It does not create a full temporary archive. Export text/metadata is prepared
before streaming, with a 32 MiB text limit and 500-attempt bulk limit. Requests
above either limit ask the professor to download individual attempts.

## Verification on 2026-11-18

Backend: 634 passed, two existing host link-operation skips. This includes 24
synthetic ZIP tests covering content separation, real ZIP parsing/CRC checks,
zero grades, empty speech, queued/missing/expired artifacts, anonymous/student/
other-owner rejection, separate attempt folders, limits, bounded streaming and
closing files when a download is cancelled. All export test database statements
are SELECTs; tests connect to no model or live database.

Frontend: 106 passed, including three new download-control checks. TypeScript
and Vite production build passed. Build output was written outside the source
tree. The original individual download links are retained. The obsolete note
claiming review playback was unavailable was removed.

These results establish automated checks with synthetic data. A real browser
ZIP download on the laptop remains to be checked after updating the running
checkout. The previously tested live recording/audio/transcription flow is
separate from these new export tests. No schema migration is required.
