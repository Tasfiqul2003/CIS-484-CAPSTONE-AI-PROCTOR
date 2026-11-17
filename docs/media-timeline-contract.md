# Durable media observations

Implemented November 16, 2026. Migration `018_media_delivery_timeline.sql` is
additive. It was subsequently applied on P3 through the protected backup,
isolated-restore and real PostgreSQL validation workflow. See
[P3 hardening verification](p3-hardening-verification.md) for current runtime
evidence. No existing migration or academic state machine was replaced.

`exam_media_events` stores attempt-scoped, idempotent observations in server receipt
order. A composite foreign key binds every interaction to the same attempt. The
existing immutable interaction ID is also its delivered-question revision. The
event ID is independent of a mutable question-bank row. Server-created
`student_response_submitted` events use the answer request ID when available.

## API and integration

Authenticated student endpoint:

```text
POST /exam/sessions/{session_id}/media-timeline/events
Authorization: Bearer <existing student_session token>

{
  "event_id": "<UUID>",
  "kind": "question_presented",
  "question_sequence_num": 1,
  "media_offset_seconds": 0,
  "asset_id": null
}
```

Client kinds: `question_presented`, `question_audio_started`,
`question_audio_ended`, `question_audio_failed`, `recording_interrupted`,
`recording_ended`. Clients cannot submit `student_response_submitted`.

The server authenticates the existing token, locks the existing attempt row,
rechecks token expiry after the lock, and resolves the current interaction itself.
Clients cannot supply an interaction ID, academic state, revision, question text,
answer text or arbitrary metadata. Presentation/audio observations require the
latest question and an active, retained assessed recording. They never advance
questions. A valid `recording_interrupted` or `recording_ended` boundary atomically
sets an active attempt to the existing `flagged` status and sets `ended_at`,
retaining partial chunks for later explicit finalization/review. Answers, speech
and live viewing then fail their existing session-status gates.

Terminal events also work after submission in pending-grading, flagged or graded
states without changing that academic status. They can refer to a prior delivered
question of the same attempt, so racing answer advancement cannot lose an
interruption. Unhealthy/missing/expired recording configuration does not prevent
termination; this stores a stop boundary, never extends media access or retention.
It does not resume recording or grant access to another attempt.

Identical event-ID retries return the original event even after academic
progression. Reusing an ID for changed observations fails with 409. New observations
require nondecreasing reported offsets; retries do not consume capacity. Ordinary
student events are bounded to 2,048 per attempt and 64 per interaction, leaving
reserved capacity for one terminal boundary per kind. Backward terminal offsets
remain labeled `out_of_order` instead of dropping the stop. Repeated terminal
notifications reuse the existing boundary; replaying an older observational stop
also closes a still-active attempt once. Event identity is scoped to its attempt;
permitted observation fields contribute to a bounded
fingerprint; no transcript, raw audio or secret is stored in that fingerprint.

Optional `asset_id` is allowed only for question-audio events. It is checked against
`exam_question_audio` for that attempt/current interaction and expiration before
the event is accepted. This integration requires the subsequent audio-asset schema
when a non-null asset is supplied. An absent schema/provider is unavailable, not a
fabricated successful playback. A null asset can describe a failed attempt or a
separately labeled browser read-aloud path; it is not proof of saved original audio.

Within the existing answer transaction, while holding its attempt lock:

```python
from .media_timeline import record_response_submitted

record_response_submitted(
    db,
    session_id=session_id,
    interaction_id=pending_interaction_id,
    sequence_num=pending_sequence,
    event_id=answer_request_id,  # optional; generated for legacy callers
    media_offset_seconds=accepted_answer_media_end,
)
```

The helper does not commit. The answer, next question, durable answer receipt and
response event must commit or roll back together. A server response snapshot
earlier than a received client observation is retained with
`offset_status: out_of_order` and a null ordered offset, rather than blocking a
valid academic answer because of client media metadata. The original reported
offset remains separately labeled.

Owning professors can request `GET /exam/sessions/{id}/media-timeline`. The review
route can call `read_timeline(db, session_id)` **after its own ownership guard**.
Returned events contain IDs, source, receipt time, offset status and observation
kind, without private rubric/model/answer text. Another professor receives 404.

## Meaning and limits

`received_at` is server receipt time. `event_order` reflects serialized ingestion,
not acoustic delivery order. Offsets use
`client_recording_elapsed_seconds`: monotonic elapsed time since that browser's
assessed recorder began. Capture continues during ordinary provider delays. The
existing recorder does not support a safe pause/resume operation; interruptions
remain explicit boundaries. There is no second implied continuous timeline across
gaps or missing fragments.

All published offsets have `offset_verified: false`. A browser observation is not
proof that audio reached a speaker, that a student heard it, or that its value
matches an encoded-media timestamp exactly. `missing` offsets stay missing. An
interruption/end is marked `continuity_boundary: true`; review must not concatenate
fragments across it or infer missing start/end events. Late stale-question events
fail instead of being attached to the next question. Server receipt time remains
visible for terminal events delivered after submission.

No recording/asset/transcript/backup retention deadline is invented by this
table. Existing recording expiration still blocks new presentation/audio observations; retained
timeline metadata is distinct from playable audio/video. Deleting an attempt or
its interaction cascades the corresponding observations. A database backup can
preserve the metadata, but physical media requires separate protected backup and
restoration. A live-storage purge does not delete backup copies.

## Measured checks

```powershell
.\.venv\Scripts\python.exe -m pytest backend\tests\test_media_timeline.py -q
```

16 tests passed in 0.50 seconds, with one existing Starlette/httpx deprecation
warning. The fixture executes real SQL and transactions against isolated
in-memory SQLite using a portable mirror of the PostgreSQL constraints. It covers
commit/rollback, order, duplicate/reused IDs, stale/current interaction binding,
composite same-attempt foreign keys, forbidden server-event spoofing, monotonic and
missing offsets, late server snapshots, interruption/end after submission,
ownership and cross-attempt token checks, token expiry after waiting, retention,
event budgets, audio-asset scoping, invalid offsets and unavailable schema.

These checks do **not** apply the PostgreSQL migration or prove PostgreSQL lock
behavior, actual delivered audio, live devices, a real browser stream, restored
physical media or a complete assessed exam. No service, database upgrade,
installation, real capture or shared infrastructure change was performed.

Subsequent recording-termination hardening passed 24 synthetic SQLite/auth tests,
including atomic status/end-time changes, stale-question stops, reserved capacity,
backward offsets, legacy replay and unauthorized termination refusal. The final
real PostgreSQL checks and the actual HTTP/native-canvas harness are documented
in the P3 hardening report and media/live feature guide. Their declared fixture
rows do not establish a real identity/start/assessed-device walkthrough.
