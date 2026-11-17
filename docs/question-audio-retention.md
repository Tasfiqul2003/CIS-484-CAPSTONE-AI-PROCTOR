# Question-audio retention cleanup

November 16, 2026. Extends the explicit `backend.app.purge_exam_videos` maintenance
operation to saved question WAVs and their metadata. No cleanup command was run
against P3's database or private storage. No scheduler was installed.

The complete reviewed schema, including migration019's `exam_question_audio` and
`exam_question_audio_requests`, must exist before cleanup. The command checks both
tables **before deleting any files**; an older deployment fails clearly rather
than reporting a complete cleanup that omitted question audio. The new migrations
remain unapplied in this implementation session.

An expired recording attempt is inventoried as one storage scope:

- Existing full WebM, temporary assembly and ordered chunks.
- `question-audio/{session_UUID}/{asset_UUID}.wav` files, with canonical UUID names.
- Saved question-audio rows, including those already marked expired.
- Canonical orphan WAV files left by failed database commits for that attempt.

Directory and leaf links, junction redirection, noncanonical filenames, unexpected
extensions and nested directories fail that attempt's cleanup. All question WAVs
are validated before recording deletion starts. Only the backend account should
be able to modify the storage tree; these checks do not provide filesystem
isolation from a concurrently hostile account with the same permissions.

The attempt and its recording are locked during PostgreSQL cleanup so generation
cannot race retention changes. For an elapsed recording deadline, the recording
and question-audio metadata are marked expired only after file cleanup succeeds.
If unlinking fails partway, retryable metadata remains and the report lists the
attempt as failed. Missing files are safe to retry. Successful attempts may commit
even if another attempt has a filesystem failure. Playback independently refuses
elapsed deadlines regardless of cleanup success.

Already expired recording rows are reconsidered to find orphan files, including
files without an asset row; a fully clean repeat reports no removals. If an
individual question-audio deadline expires before its recording deadline, only
that known expired asset is removed. The active recording, other assets and
unattributed WAVs are preserved until the attempt's recording deadline expires.
Directories without a corresponding recording row cannot be assigned an expiry
by this operation and require separate review; no deadline is invented for them.

Receipt rows continue to point to expired asset metadata so a retried audio request
cannot silently generate a replacement after retention. The operation does not
delete transcripts, timeline metadata, reference photos or database/media backup
copies. Those policies remain separate. P3's fixed approved recording deadline is
unchanged.

In the configured backend environment, a separately authorized maintenance run
can first inspect `python -m backend.app.purge_exam_videos --dry-run`. Dry run
inspects eligibility and storage shape without unlinking files or updating
metadata. Running without `--dry-run` deletes eligible assets and requires the
applicable deletion authorization. No real dry run or deletion was performed here.

The JSON report includes attempt counts, failed attempt IDs,
`question_audio_assets_expired`, `question_audio_files_removed` and
`orphan_files_removed`. A partial failure gives a nonzero CLI exit. These counts
describe live configured storage only and do not claim deletion from every backup.

Measured isolated checks:

```powershell
.\.venv\Scripts\python.exe -m pytest backend\tests\test_media_lifecycle.py backend\tests\test_question_audio_purge.py -q
```

19 passed in 0.35 seconds. The new audio cleanup tests execute actual SQL against
in-memory SQLite and create generated fixture files only in temporary directories.
They cover metadata/file expiry, orphan WAVs, dry run, partial failure/retry,
idempotence, missing schema, safe names, directory redirection and preservation of
an active recording. Existing fake-database media tests explicitly model a present
audio schema with no assets. PostgreSQL locking, real storage permissions and
protected backup deletion have not been exercised.
