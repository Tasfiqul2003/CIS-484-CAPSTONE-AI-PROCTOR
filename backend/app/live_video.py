"""Ephemeral single-process WebRTC signaling. Media never passes through this API.

No STUN/TURN service is configured: the supported topology is same host/LAN.
Every poll/write rechecks identity, ownership, attempt/recording state and expiry.
"""
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field, ConfigDict, field_validator
from sqlalchemy import text
from sqlalchemy.orm import Session

from .auth import get_current_account
from .db import get_db
from .student_auth import read_student_token

router = APIRouter(prefix="/exam", tags=["live video"])
LEASE_SECONDS = 15
SIGNAL_TTL_SECONDS = 30
MAX_ROOMS = 256
MAX_SIGNALS = 128
MAX_SIGNAL_BYTES = 65536
MAX_ROOM_BYTES = 256 * 1024
MAX_TOTAL_BYTES = 16 * 1024 * 1024
_lock = threading.Lock()


class LiveSignal(BaseModel):
    model_config = ConfigDict(extra="forbid")
    peer_id: UUID
    room_id: UUID
    epoch: int = Field(strict=True, ge=1)
    kind: Literal["offer", "answer", "candidate", "leave"]
    payload: str = Field(default="", max_length=65536)

    @field_validator("payload", mode="before")
    @classmethod
    def safe_unicode_payload(cls, value):
        # FastAPI's default validation renderer cannot encode lone surrogates
        # echoed in Pydantic errors. Reject them with a fixed safe error first.
        if isinstance(value, str):
            try:
                value.encode("utf-8")
            except UnicodeEncodeError:
                raise HTTPException(422, "Invalid live-view signal encoding.") from None
        return value


@dataclass
class Room:
    room_id: UUID = field(default_factory=uuid4)
    peers: dict = field(default_factory=dict)
    signals: deque = field(default_factory=deque)
    epoch: int = 0
    sequence: int = 0
    queued_bytes: int = 0


_rooms: dict[str, Room] = {}


def _clear(room):
    room.signals.clear()
    room.queued_bytes = 0


def _expire(now: float) -> None:
    for sid, room in list(_rooms.items()):
        expired = [role for role, peer in room.peers.items() if now - peer[1] >= LEASE_SECONDS]
        if expired:
            for role in expired:
                del room.peers[role]
            room.epoch += 1
            _clear(room)
        while room.signals and now - room.signals[0]["created"] >= SIGNAL_TTL_SECONDS:
            room.queued_bytes -= room.signals.popleft()["bytes"]
        if not room.peers:
            del _rooms[sid]


def _authorize(request, session_id, authorization, db):
    claims = None
    account = None
    if authorization:
        claims = read_student_token(authorization, expected_purpose="student_session")
        if claims.get("session_id") != str(session_id):
            raise HTTPException(403, "Student token does not match this attempt.")
        role = "student"
    else:
        account = get_current_account(request, db)
        if account.get("role") != "professor" or not account.get("professor_id"):
            raise HTTPException(403, "Professor account required.")
        role = "professor"
    attempt = db.execute(text("""
        SELECT s.student_id, s.exam_template_id, s.status, s.developer_demo,
               t.professor_id, v.status AS video_status, v.expires_at
        FROM exam_sessions s JOIN exam_templates t ON t.id = s.exam_template_id
        LEFT JOIN exam_session_videos v ON v.session_id = s.id
        WHERE s.id = CAST(:sid AS uuid)
    """), {"sid": str(session_id)}).mappings().first()
    if not attempt:
        raise HTTPException(404, "Attempt not found.")
    if claims is not None:
        if claims.get("sub") != str(attempt["student_id"]) or claims.get("exam_template_id") != str(attempt["exam_template_id"]):
            raise HTTPException(403, "Student token does not match this attempt.")
    elif str(account["professor_id"]) != str(attempt["professor_id"]):
        raise HTTPException(404, "Attempt not found.")
    # Database work can wait behind another request. Revalidate authentication
    # after that work rather than renewing a lease using credentials that expired
    # or an account that was deactivated during the wait.
    if claims is not None:
        current = read_student_token(authorization, expected_purpose="student_session")
        if any(current.get(key) != claims.get(key) for key in ("sub", "session_id", "exam_template_id")):
            raise HTTPException(403, "Student authorization changed during this operation.")
    else:
        current = get_current_account(request, db)
        if current.get("role") != "professor" or str(current.get("professor_id")) != str(attempt["professor_id"]):
            raise HTTPException(404, "Attempt not found.")
    if (attempt["status"] != "in_progress" or attempt.get("developer_demo", False)
            or attempt.get("video_status") != "recording"
            or attempt.get("expires_at") is None
            or attempt["expires_at"] <= datetime.now(timezone.utc)):
        with _lock:
            _rooms.pop(str(session_id), None)
        raise HTTPException(410, "Live viewing is unavailable because this assessed recording is not active.")
    return role


@router.get("/sessions/{session_id}/live-video")
def poll_live_video(
    session_id: UUID, request: Request, response: Response,
    peer_id: UUID, after: int = Query(default=0, ge=0), room_id: UUID | None = Query(default=None),
    authorization: str | None = Header(default=None), db: Session = Depends(get_db),
):
    role = _authorize(request, session_id, authorization, db)
    now = time.monotonic()
    response.headers["Cache-Control"] = "private, no-store"
    with _lock:
        _expire(now)
        sid = str(session_id)
        room = _rooms.get(sid)
        if room is None:
            if len(_rooms) >= MAX_ROOMS:
                raise HTTPException(503, "Live viewing capacity is unavailable.")
            room = _rooms[sid] = Room()
        current = room.peers.get(role)
        if current is not None and current[0] != str(peer_id):
            raise HTTPException(409, "This attempt already has an active live-view tab for this role.")
        if current is None:
            room.epoch += 1
            _clear(room)
        room.peers[role] = (str(peer_id), now)
        other = "professor" if role == "student" else "student"
        # A cursor from a destroyed/restarted room must never skip the new room's
        # initial offer, even when its small per-room epoch counter repeats.
        effective_after = after if room_id == room.room_id else 0
        signals = [{key: value for key, value in message.items() if key not in ("created", "bytes")}
                   for message in room.signals if message["role"] == other and message["sequence"] > effective_after]
        return {"room_id": str(room.room_id), "epoch": room.epoch, "peer_present": other in room.peers,
                "signals": signals, "cursor": room.sequence, "lease_seconds": LEASE_SECONDS,
                "topology": "single-process-local-webrtc-no-relay"}


@router.post("/sessions/{session_id}/live-video")
def send_live_video_signal(
    session_id: UUID, request: Request, body: LiveSignal,
    authorization: str | None = Header(default=None), db: Session = Depends(get_db),
):
    role = _authorize(request, session_id, authorization, db)
    now = time.monotonic()
    with _lock:
        _expire(now)
        room = _rooms.get(str(session_id))
        peer = room.peers.get(role) if room else None
        if peer is None or peer[0] != str(body.peer_id):
            raise HTTPException(409, "Live-view lease is missing or belongs to another tab.")
        if body.room_id != room.room_id or body.epoch != room.epoch:
            raise HTTPException(409, "Live-view connection changed; poll again before signaling.")
        if body.kind == "leave":
            del room.peers[role]
            room.epoch += 1
            _clear(room)
            if not room.peers:
                _rooms.pop(str(session_id), None)
            return {"accepted": True}
        if (body.kind == "offer" and role != "student") or (body.kind == "answer" and role != "professor"):
            raise HTTPException(403, "This signal is not allowed for this participant.")
        if len(room.peers) != 2:
            raise HTTPException(409, "The other participant is unavailable.")
        if len(room.signals) >= MAX_SIGNALS:
            raise HTTPException(429, "Live-view signaling limit reached; reconnect after the lease expires.")
        if not body.payload or (body.kind == "candidate" and len(body.payload) > 8192):
            raise HTTPException(422, "Invalid live-view signal payload.")
        try:
            size = len(body.payload.encode("utf-8"))
        except UnicodeEncodeError:
            raise HTTPException(422, "Invalid live-view signal encoding.") from None
        if size > (8192 if body.kind == "candidate" else MAX_SIGNAL_BYTES):
            raise HTTPException(422, "Live-view signal exceeds its byte limit.")
        if (room.queued_bytes + size > MAX_ROOM_BYTES
                or sum(value.queued_bytes for value in _rooms.values()) + size > MAX_TOTAL_BYTES):
            raise HTTPException(429, "Live-view signaling byte budget reached; reconnect after its lease expires.")
        room.sequence += 1
        room.signals.append({"sequence": room.sequence, "kind": body.kind,
                             "payload": body.payload, "role": role, "created": now, "bytes": size})
        room.queued_bytes += size
        return {"accepted": True, "sequence": room.sequence}
