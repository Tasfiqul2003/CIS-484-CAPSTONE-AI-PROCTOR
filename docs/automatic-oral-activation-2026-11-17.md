# Local automatic oral workflow activation — November 17, 2026

This supersedes the pending-activation status in the earlier workflow/verification notes. The user explicitly authorized applying the migration and then stopping the blocked attempt, retaining available recording and completing the repair. All changes remain local and uncommitted; no push or shared service change occurred.

## Cause and repair

The screenshot's `Not Found` was reproduced by inspecting the running backend's OpenAPI: both new oral utterance and intelligibility routes were absent. The frontend had loaded the new controller while the older backend process and25-entry schema were still running. Migration021 was pending. One assessed attempt blocked maintenance.

That specific attempt was stopped as flagged/incomplete, with a low-severity `authorized_technical_restart` administrative integrity event documenting the user's authorization and technical failure. No academic answer or completion was fabricated. Its143 uploaded recording files,12,079,299bytes, were copied into a protected local backup and a SHA-256 manifest was saved. Original uploaded media remains retained. This preserves server-uploaded bytes, not a claim that every final frame buffered in the browser was recovered or that the incomplete recording represents a finished exam.

A narrow server-side completion exclusion now permits a fresh attempt only when a flagged attempt has that explicit administrative event. Ordinary completed/flagged attempts remain closed. Student-controlled request fields cannot create the event. The signed session-state endpoint exposes that authorization; the frontend discards only that authorized attempt's old browser receipt, then goes through the normal identity/recording/consent/start gates for a new attempt. The old recording is never resumed, and previous evidence is not deleted.

## Protected activation and verification

- Protected source database backup, isolated restore, migration and SQL contracts passed before applying021. Exactly1 source migration was applied; ledger now26. The first isolated run passed18 contracts with1 unchanged opt-in skip.
- A second protected backup/isolated restore after application passed21 contracts with1 unchanged model opt-in skip, including explicit technical-retry eligibility and ordinary-terminal-attempt denial. It also exercised the real authenticated speech HTTP route against restored SQL with the actual native Windows synthesis provider and confirmed a non-silent PCM WAV. Attempt/recording metadata in these checks is synthetic; no real devices or exam-start gate were exercised by the tests.
- Both isolated validation databases were removed successfully; cleanup failures were empty. Previously applied migration hashes and original private settings were not rewritten.
- Current `/api/health/ready` is ready; running OpenAPI exposes both `/speech/utterance` and `/speech/assess`. Avatar status remains disabled, as intended. Backend/frontend/database are ready on loopback; external Ollama was retained under its original ownership.
- Read-only verification found zero active attempts, one preserved authorized technical interruption, and the affected exam available for a fresh attempt via the actual student-available HTTP route. The interrupted attempt's saved volume was70percent.
- Final offline Python regression:993 passed,16 gated skips,143 subtests in40.44seconds. New optional isolated/native cases account for the additional default skips.
- StudentExam browser lifecycle:14 synthetic scenarios passed, including authorized fresh attempt and denial of ordinary terminal attempts. Existing automatic controller/capture checks and113 frontend unit passes remain as measured in the preceding verification report.
- TypeScript, production build into ignored `.cache/automatic-oral-build`, and whitespace checks passed. Existing nonfatal bundle-size warning remains.

Protected recovery evidence is under `private-data/p3-local/backups/technical_restart_20261117_224224_32aa0ff5/` (raw media, metadata and hash manifest), `upgrade_20261117_224226_9da8c125/` (pre-migration DB backup and validation), and `upgrade_20261117_224520_8d8dd84c/` (post-upgrade backup, restored-SQL/native checks). These ignored artifacts contain private runtime data and must not be published.

## User continuation and remaining limits

Open `/student/exams` and start the exam afresh. The old blocked attempt is closed; its Resume button cannot resume a recording. A new attempt still needs required verification/consent/browser permissions. FlashHead-off mode keeps the placeholder with native system speech and Ollama processing. It does not clone the professor's uploaded voice.

The native audio endpoint is verified to return non-silent audio; the user's actual speakers/browser autoplay policy and a complete human spoken exam have not been acceptance-tested. No new human exam or media permission was automatically started. Historical pre-main browser fixture failures remain outside this activation's passing checks.
