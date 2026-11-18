# Examination recording

Record Examination controls combined camera video and microphone audio. New
templates default ON through migration 014; pre-existing templates retain OFF
unless saved explicitly. Generate Transcript is an independent server setting.
Both values are copied to the session at start. Changing a template cannot
change an attempt already in progress. Existing consent history is preserved.

## Student workflow

The student saves an explicit consent decision before camera or microphone
access. Identical decisions can be retried; conflicting decisions are rejected.
The saved decision starts the server exam and first-question clocks, including
the snapshotted ODS extension and avatar response window. Declines notify the
owning professor. Developer demos never record or receive assessment grades.

Declining recording or failing to initialize a camera/microphone leaves typed
submission available. Such attempts remain visibly unrecorded. The existing main
assessment contract requires a completed video within its retention deadline
before AI assessment or professor confirmation. Accepting typed answers does not
waive that requirement. Speech-provider routes retain their active-recording and
signed-transcript provenance checks.

The integrated StudentExam workspace retains the automatic spoken workflow,
delivered-question audio, live viewing and media timeline. During an active
recorded attempt, an interrupted recorder stops interaction and reports a durable
boundary for professor review. Available partial bytes can be saved. Retrying an
upload cannot resume that attempt. An authorized technical restart creates a new
attempt while preserving the old evidence. Reload cannot restart an existing
consented recording. Pending consent and typed-only attempts can resume.

Capture requests audio and video together. VP8 is preferred; camera capture is
limited to 640 by 480 pixels and 15 frames per second. The integrated recorder uses
500 kbit/s video, 64 kbit/s audio, two-second data events and a 16 MiB upload buffer.
Each upload request has a fifteen-second deadline. The server accepts both the
existing ordered multipart POST API and the consented raw PUT API. Both enforce
the same ownership, consent, ordering, duplicate-byte and storage checks. Server
limits are 10 MiB per chunk and 512 MiB per recording.

Stopping an exam releases devices and live viewing, then flushes final data.
Already submitted answers remain saved if finalization needs a retry. A recording
is not shown as complete until the server confirms assembly. Leaving during a
pending permission/start operation releases any late returned stream and preserves
the created attempt receipt. No screen capture is requested.

## Private media and review

Student routes validate the signed session token against session, student,
and template, then check the saved snapshot and consent before writes.
Session-row locks serialize initialization and chunk metadata. Duplicate
chunks must match the stored bytes; changed retries and gaps are rejected.
Atomic files are recoverable after a failed database commit. Assembly happens
without removing uploaded chunks until the completion transaction succeeds;
then duplicate chunks are released. Completion retries are idempotent. A
failed commit retains the recovery chunks, and failed duplicate cleanup never
turns a completed recording into an upload failure.

Only the owning professor can obtain status or playback. Playback additionally
requires a submitted session and completed, unexpired media. It is served by
an authenticated same-origin API with private/no-store caching and byte-range
support. No file paths or public media links are returned. Student Review
shows recording status separately from typed answers, grades, and integrity
events. Failed or missing recordings never hide the existing report.
The review includes a private recording download and the saved expiry. Pending
status polling backs off from five to thirty seconds and pauses in hidden tabs.
Transient request failures retry up to three times, then offer a refresh button.
An authorization failure clears previously displayed recording evidence.
The professor dashboard also shows one persistent failure notification per
session; the earlier decline notifications are retained.

The backend derives names from validated UUIDs, rejects symlinks/junctions,
opens regular single-link files, and restricts directories/files to 0700/0600
where the platform supports those permissions. Keep the backend volume
private: another process with the same account or privileged host access is
outside this application's isolation boundary. The backend checks the WebM
header and limits bytes; it does not perform deep codec validation or certify
that a student's camera/microphone supplied truthful media.

## Database application procedure

Migration `017_exam_recording_lifecycle.sql` upgrades main's existing media metadata and allows
the `recording_failed` notification type. Capture states are recording,
completed, permission_denied, unavailable, upload_failed, interrupted, expired.
Not required, awaiting consent, and declined are derived from saved session
settings/consent rather than duplicated. The row includes content type,
sequential count, byte count, timestamps, expiry, failure reason, and separate
generated speech transcript fields. Expiry never removes exam records,
typed answers, grades, or consent decisions.

Inspect the actual database and migration ledger and take a verified backup
before any authorized application. Having these source files does not establish that migrations have been applied
to a particular database. This merged branch includes main's photo/identity and 014 video migrations. Inspect the actual schema and migration ledger before selecting prerequisites; do not apply files blindly.

The ordinary Compose init mount does not recursively run the migrations
directory and does not upgrade an existing PostgreSQL volume. A maintainer
must explicitly apply missing prerequisites in their correct historical order,
including `013_reconcile_live_exam_schema.sql` and
`014_exam_recording_settings.sql`, before this new 017, together with main's 014 video, 015 and 016 prerequisites as appropriate. Inspect all full
filenames; duplicate numeric prefixes already exist. For a database confirmed
to have the prerequisite schema, this is an application command for the new
migration (authorization and backup are still required):

```powershell
Get-Content -Raw database/migrations/017_exam_recording_lifecycle.sql |
  docker compose exec -T db sh -c 'psql -v ON_ERROR_STOP=1 --single-transaction -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

The isolated developer launcher separately uses
`scripts/developer_migrate.py`: base schema first, then sorted full filenames,
within a transaction, with a filename/SHA-256 ledger. It refuses to adopt
untracked existing databases or changed historical migration bytes. No
`BOOLEANNOT NULL` typo exists in this supplied snapshot; old migration bytes
were left intact. Review startup's pending migration behavior before launching
it against any database. Minimal developer demo sessions remain unrecorded.

## Storage and retention configuration

The ordinary `docker-compose.yml` mounts the dedicated `exam_videos` named
volume only into the backend at `/var/lib/oral-exam/recordings`. Existing
PostgreSQL and model volume definitions are preserved. Recordings are never
stored in the source tree, a public frontend folder, or the container layer.
Local non-Compose backend runs must set an absolute private directory outside
the checkout. Configure variables using secure local environment configuration:

```text
EXAM_VIDEO_DIR=/var/lib/oral-exam/recordings
EXAM_VIDEO_RETENTION_UNTIL=
```

Set the retention value only to the institution-approved ISO date or
timezone-aware timestamp. A date retains media until 23:59:59.999999 UTC on
that date. No policy date is supplied. Missing, invalid, or expired retention
and unavailable/unwritable/low-space storage fail capture gracefully while
the exam continues. A new recording checks for 512 MiB free space; final
assembly needs additional free space equal to its uploaded bytes. During
assembly, budget approximately twice the 512 MiB per-session maximum plus
headroom and concurrent attempts. After a successful completion transaction,
duplicate chunks are removed when possible. Failed uploads, interrupted
transactions or failed duplicate cleanup can retain chunks until expiry.
The expiry is snapshotted into the recording; changing the environment does
not silently extend an existing recording's retention.

Schedule this command daily using an administrator-managed scheduler and the
same database/volume configuration as the backend:

```text
docker compose run --rm --no-deps backend python -m app.purge_exam_videos
```

Cleanup only targets validated UUID media files and recognized chunk/temp
names for expired metadata rows. It stops on unexpected links or entries,
never recursively deletes arbitrary paths, and is safe to retry after partial
cleanup. Counts, consent and exam history remain; generated speech text
expires with the recording. Playback refuses expired media
even if cleanup has not run. Cleanup of files orphaned by separate exam/session
deletion is not automatic; administrators must reconcile those files within
the approved data-deletion procedure. Do not delete the volume while media
must be retained.

## Speech transcription

Completed recordings with the saved Generate Transcript flag are queued in
PostgreSQL. The separate `app.transcription_worker` processes only submitted,
consented, non-demo attempts with unexpired, completed media. It decodes the
actual recording using a pre-provisioned local Faster-Whisper model and saves
timestamped text separately from typed answers. It makes no external speech API
calls and does not download models during transcription.

The professor's recording review polls queue/processing states, displays saved
speech text, and provides a private `.txt` download. The same owner, submission
and expiry restrictions apply to both media and speech text. The student status
API does not return generated speech text. Expiry cleanup clears text and
cancels leases; a stale worker cannot restore expired text.

Migration `018_exam_speech_transcripts.sql` extends the queue metadata after
017. Worker setup and model provisioning are explicit runtime steps: see
[speech-transcription.md](speech-transcription.md). A stopped or unconfigured
worker leaves jobs waiting; exams, typed answers and grading continue. Legacy
`unavailable` recordings are eligible when the worker starts. Actual engine
accuracy, live browser capture and PostgreSQL concurrency still require runtime
verification; synthetic tests cannot establish those properties.

## Local development and verification

Use a trusted HTTPS origin for remote browsers; localhost is suitable for
local development. LAN HTTP is not a secure camera/microphone context. Test
supported WebM recording and playback on the actual intended browsers. The
frontend API proxy/same origin carries professor session cookies for playback.

```text
python -m pytest backend/tests
python -m unittest discover -s tests -p "test_*.py"
cd frontend
npm ci
npm test
npm run test:recording
npm run build
```

Run backend tests with both the checkout root and its `backend` directory on
PYTHONPATH, as required by the existing mixed import conventions. Node 24
supports the TypeScript stripping used by the recording unit tests.
`npm test` runs unit tests. Existing `*-browser.test.mjs` scripts separately
require Playwright, an installed browser, and a frontend server; see their
existing README files and environment variable overrides.

Tests use synthetic media bytes and mocked devices/HTTP. They do not establish
actual A/V synchronization, institutional compliance, PostgreSQL concurrency,
live migration correctness, disk permissions on the deployed host, retention
policy approval, certificate trust, backup restorability, or deployment on JMU
infrastructure. The current Compose reload/source mount is a development
configuration. Validate these operational requirements before deployment.
