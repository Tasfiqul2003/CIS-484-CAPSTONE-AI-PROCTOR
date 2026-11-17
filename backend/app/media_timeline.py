"""Durable media observations and fail-closed recording termination.

Presentation/audio observations never advance questions. A terminal recording
boundary atomically flags an active attempt through its existing lifecycle.

Offsets are client-reported recording elapsed time, not verified encoded-media
timestamps or proof that a question was heard. Receipt time is separately stored.
"""
import hashlib
import json
from datetime import datetime, timezone
from typing import Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from .auth import require_professor
from .db import get_db
from .student_auth import read_student_token

router = APIRouter(prefix="/exam", tags=["media timeline"])
MAX_STUDENT_EVENTS = 2048
MAX_EVENTS_PER_INTERACTION = 64
OFFSET_BASIS = "client_recording_elapsed_seconds"
AUDIO_EVENTS = {"question_audio_started", "question_audio_ended", "question_audio_failed"}
StudentEventKind = Literal["question_presented", "question_audio_started", "question_audio_ended",
                           "question_audio_failed", "recording_interrupted", "recording_ended"]


class MediaEventRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    event_id: UUID
    kind: StudentEventKind
    question_sequence_num: int = Field(strict=True, ge=1)
    media_offset_seconds: float | None = Field(default=None, ge=0, le=86400)
    asset_id: UUID | None = None

    @model_validator(mode="after")
    def validate_audio_asset(self):
        if self.asset_id is not None and self.kind not in AUDIO_EVENTS:
            raise ValueError("Only question audio events may refer to a question audio asset.")
        return self


def _fingerprint(*, kind, sequence_num, media_offset_seconds, asset_id, source):
    canonical = {"kind": kind, "sequence_num": sequence_num,
                 "media_offset_seconds": media_offset_seconds,
                 "asset_id": str(asset_id) if asset_id else None, "source": source}
    return hashlib.sha256(json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _public(row):
    event = {key: row[key] for key in (
        "event_id", "event_order", "interaction_id", "question_sequence_num", "kind", "source",
        "asset_id", "media_offset_seconds", "reported_media_offset_seconds", "offset_status",
        "offset_basis", "received_at")}
    for key in ("event_id", "interaction_id", "asset_id"):
        if event[key] is not None:
            event[key] = str(event[key])
    if hasattr(event["received_at"], "isoformat"):
        event["received_at"] = event["received_at"].isoformat()
    event["continuity_boundary"] = event["kind"] in ("recording_interrupted", "recording_ended")
    event["offset_verified"] = False
    event["question_revision"] = event["interaction_id"]
    event["recording_id"] = str(row["session_id"])
    return event


def _replay(db, session_id, event_id, fingerprint):
    row = db.execute(text("""SELECT * FROM exam_media_events
        WHERE session_id = :sid AND event_id = :eid"""),
        {"sid": str(session_id), "eid": str(event_id)}).mappings().first()
    if row is None:
        return None
    if row["payload_hash"] != fingerprint:
        raise HTTPException(409, "This event ID was already used for different media observations.")
    return _public(row)


def _insert(db, *, session_id, interaction_id, sequence_num, event_id, kind, source,
            media_offset_seconds, asset_id=None, student_limits=True):
    fingerprint = _fingerprint(kind=kind, sequence_num=sequence_num,
        media_offset_seconds=media_offset_seconds, asset_id=asset_id, source=source)
    replay = _replay(db, session_id, event_id, fingerprint)
    if replay is not None:
        return replay
    totals = db.execute(text("""SELECT COUNT(*) AS event_count,
        MAX(media_offset_seconds) AS latest_offset,
        SUM(CASE WHEN source = 'student' THEN 1 ELSE 0 END) AS student_count,
        SUM(CASE WHEN interaction_id = :iid AND source = 'student' THEN 1 ELSE 0 END) AS interaction_count
        FROM exam_media_events WHERE session_id = :sid"""),
        {"sid": str(session_id), "iid": str(interaction_id)}).mappings().first()
    if student_limits and (int(totals["student_count"] or 0) >= MAX_STUDENT_EVENTS
                           or int(totals["interaction_count"] or 0) >= MAX_EVENTS_PER_INTERACTION):
        raise HTTPException(429, "This attempt has reached its media observation limit.")
    latest = totals["latest_offset"]
    offset = media_offset_seconds
    offset_status = "missing" if offset is None else "reported"
    if offset is not None and latest is not None and offset < float(latest):
        if student_limits:
            raise HTTPException(409, "This media observation precedes an already accepted recording offset.")
        # Preserve a late response snapshot without claiming ordered media or
        # blocking an otherwise valid academic answer because of client metadata.
        offset, offset_status = None, "out_of_order"
    row = db.execute(text("""INSERT INTO exam_media_events
        (session_id, event_id, interaction_id, question_sequence_num, kind, source,
         asset_id, media_offset_seconds, reported_media_offset_seconds, offset_status, offset_basis, payload_hash)
        VALUES (:sid, :eid, :iid, :seq, :kind, :source, :asset,
                :offset, :reported, :offset_status, :basis, :hash)
        RETURNING *"""),
        {"sid": str(session_id), "eid": str(event_id), "iid": str(interaction_id),
         "seq": sequence_num, "kind": kind, "source": source,
         "asset": str(asset_id) if asset_id else None, "offset": offset,
         "reported": media_offset_seconds, "offset_status": offset_status,
         "basis": OFFSET_BASIS, "hash": fingerprint}).mappings().first()
    return _public(row)


def record_response_submitted(db, *, session_id, interaction_id, sequence_num,
                              event_id=None, media_offset_seconds=None):
    """Call within the answer transaction while holding its existing attempt lock.

    The server controls interaction/sequence. It must pass the accepted answer's
    media end offset, not an unvalidated raw request. This helper never commits.
    """
    if media_offset_seconds is not None:
        # Reuse strict payload validation even for internal callers.
        MediaEventRequest(event_id=uuid4(), kind="question_presented",
                          question_sequence_num=sequence_num, media_offset_seconds=media_offset_seconds)
    return _insert(db, session_id=session_id, interaction_id=interaction_id,
        sequence_num=sequence_num, event_id=event_id or uuid4(), kind="student_response_submitted",
        source="server", media_offset_seconds=media_offset_seconds, student_limits=False)


def read_timeline(db, session_id):
    """Caller must have authorized this attempt; contains no answer or private text."""
    rows = db.execute(text("""SELECT * FROM exam_media_events
        WHERE session_id = :sid ORDER BY event_order LIMIT 4096"""),
        {"sid": str(session_id)}).mappings().all()
    return [_public(row) for row in rows]


def _student_attempt(db, session_id, claims):
    if claims.get("session_id") != str(session_id):
        raise HTTPException(403, "Student token does not match this attempt.")
    suffix = " FOR UPDATE OF s" if db.get_bind().dialect.name == "postgresql" else ""
    attempt = db.execute(text("""SELECT s.id, s.student_id, s.exam_template_id,
        s.status, s.developer_demo, v.status AS video_status, v.expires_at
        FROM exam_sessions s LEFT JOIN exam_session_videos v ON v.session_id = s.id
        WHERE s.id = :sid""" + suffix), {"sid": str(session_id)}).mappings().first()
    if not attempt:
        raise HTTPException(404, "Attempt not found.")
    if claims.get("sub") != str(attempt["student_id"]) or claims.get("exam_template_id") != str(attempt["exam_template_id"]):
        raise HTTPException(403, "Student token does not match this attempt.")
    return attempt


def _close_recording_attempt(db, session_id, attempt):
    if attempt["status"] != "in_progress" or attempt.get("developer_demo", False):
        return False
    clock = "clock_timestamp()" if db.get_bind().dialect.name == "postgresql" else "CURRENT_TIMESTAMP"
    db.execute(text("""UPDATE exam_sessions SET status = 'flagged',
        ended_at = COALESCE(ended_at, """ + clock + ") WHERE id = :sid AND status = 'in_progress'"),
        {"sid": str(session_id)})
    return True


def _record_media_event(db, session_id, body, authorization):
    claims = read_student_token(authorization, expected_purpose="student_session")
    attempt = _student_attempt(db, session_id, claims)
    # An answer can hold the attempt lock during bounded provider work. Recheck
    # expiry after acquiring that lock rather than relying on the pre-wait token.
    read_student_token(authorization, expected_purpose="student_session")
    terminal = body.kind in ("recording_interrupted", "recording_ended")
    fingerprint = _fingerprint(kind=body.kind, sequence_num=body.question_sequence_num,
        media_offset_seconds=body.media_offset_seconds, asset_id=body.asset_id, source="student")
    replay = _replay(db, session_id, body.event_id, fingerprint)
    if replay is not None:
        if terminal and _close_recording_attempt(db, session_id, attempt):
            db.commit()
        return {"event": replay, "duplicate": True}
    if terminal:
        # A recording cannot safely resume. Keep one durable boundary per kind,
        # reserving space even when ordinary browser observations exhausted their
        # budget. Repeated stop notifications must not create unbounded rows.
        previous = db.execute(text("""SELECT * FROM exam_media_events
            WHERE session_id = :sid AND kind = :kind ORDER BY event_order LIMIT 1"""),
            {"sid": str(session_id), "kind": body.kind}).mappings().first()
        if previous is not None:
            if _close_recording_attempt(db, session_id, attempt):
                db.commit()
            return {"event": _public(previous), "duplicate": True, "recording_terminal_already_reported": True}
    allowed = ("in_progress", "pending_grading", "flagged", "graded") if terminal else ("in_progress",)
    if attempt["status"] not in allowed or attempt.get("developer_demo", False):
        raise HTTPException(409, "This attempt cannot accept this media observation.")
    if not terminal and attempt.get("video_status") != "recording":
        raise HTTPException(409, "The assessed recording is unavailable for media observations.")
    deadline = attempt.get("expires_at")
    if not terminal and deadline is None:
        raise HTTPException(410, "The recording retention deadline is missing.")
    if isinstance(deadline, str):
        deadline = datetime.fromisoformat(deadline.replace("Z", "+00:00"))
    if not terminal and deadline <= datetime.now(timezone.utc):
        raise HTTPException(410, "The recording retention deadline has passed.")
    # A delayed stop can refer to the previous delivered question while an
    # already submitted answer advanced the attempt. Its recording boundary is
    # still essential, and must remain attached to its own delivered revision.
    question_filter = " AND sequence_num = :sequence" if terminal else ""
    interaction = db.execute(text("""SELECT id, sequence_num FROM interactions
        WHERE session_id = :sid""" + question_filter + " ORDER BY sequence_num DESC LIMIT 1"),
        {"sid": str(session_id), "sequence": body.question_sequence_num}).mappings().first()
    if not interaction or interaction["sequence_num"] != body.question_sequence_num:
        raise HTTPException(409, "This media observation belongs to a stale question.")
    if body.asset_id is not None:
        try:
            asset = db.execute(text("""SELECT id FROM exam_question_audio
                WHERE id = :asset AND session_id = :sid AND interaction_id = :iid
                  AND expires_at > CURRENT_TIMESTAMP"""),
                {"asset": str(body.asset_id), "sid": str(session_id), "iid": str(interaction["id"])}).first()
        except SQLAlchemyError:
            raise HTTPException(503, "Question audio storage is unavailable.") from None
        if asset is None:
            raise HTTPException(409, "Question audio does not belong to this active interaction or has expired.")
    event = _insert(db, session_id=session_id, interaction_id=interaction["id"],
        sequence_num=interaction["sequence_num"], event_id=body.event_id, kind=body.kind,
        source="student", media_offset_seconds=body.media_offset_seconds, asset_id=body.asset_id,
        student_limits=not terminal)
    if terminal:
        _close_recording_attempt(db, session_id, attempt)
    db.commit()
    return {"event": event, "duplicate": False}


@router.post("/sessions/{session_id}/media-timeline/events")
def record_media_event(session_id: UUID, body: MediaEventRequest,
                       authorization: str | None = Header(default=None),
                       db: Session = Depends(get_db)):
    try:
        return _record_media_event(db, session_id, body, authorization)
    except SQLAlchemyError:
        db.rollback()
        raise HTTPException(503, "Media timeline storage is unavailable.") from None


@router.get("/sessions/{session_id}/media-timeline")
def professor_timeline(session_id: UUID, account: dict = Depends(require_professor),
                       db: Session = Depends(get_db)):
    row = db.execute(text("""SELECT t.professor_id FROM exam_sessions s
        JOIN exam_templates t ON t.id = s.exam_template_id WHERE s.id = :sid"""),
        {"sid": str(session_id)}).mappings().first()
    if not row or str(row["professor_id"]) != str(account.get("professor_id")):
        raise HTTPException(404, "Attempt not found.")
    return {"session_id": str(session_id), "offset_basis": OFFSET_BASIS,
            "offsets_verified": False, "events": read_timeline(db, session_id)}
