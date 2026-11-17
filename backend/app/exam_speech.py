"""Authenticated optional speech; typed exam answers remain independently usable."""

import asyncio
import os
import threading
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy import text
from sqlalchemy.orm import Session

from .avatar_assistance import _check_deadlines, _context, _read_state
from .avatar_session import _session
from .db import get_db
from .developer_demo import minimal_for_session
from .speech_adapters import (
    MAX_AUDIO_BYTES, SUPPORTED_INPUTS, SpeechContext, SpeechError,
    SpeechOutputRequest, SpeechService, TranscriptionRequest,
)
from .student_auth import read_student_token
from .transcript_receipts import issue_transcript_receipt


router = APIRouter(prefix="/exam/sessions", tags=["Student speech"])
_service = SpeechService()
_native_service = None
_native_lock = threading.Lock()


def get_speech_service():
    """Explicit local provider only. No desktop-script import or automatic cloud."""
    global _native_service
    if os.environ.get('CYBROS_SPEECH_PROVIDER', '').strip() != 'windows-system-speech':
        return _service
    with _native_lock:
        if _native_service is None:
            from .windows_speech import configured_windows_service
            _native_service = configured_windows_service()
        return _native_service


class SynthesisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sequence_num: int = Field(strict=True, ge=1)
    request_id: UUID


def _authorized_context(db, sid, authorization, *, sequence_num=None, request_id=None, require_capture=True):
    # Re-read credentials on each guard to notice token expiry during inference.
    claims = read_student_token(authorization, expected_purpose="student_session")
    try:
        session, settings, _, pending = _context(db, sid, claims)
        if session["status"] != "in_progress" or pending is None:
            raise HTTPException(409, "No active question is waiting for speech input.")
        if sequence_num is not None and pending["sequence_num"] != sequence_num:
            raise HTTPException(409, "This speech request belongs to a previous question.")
        if minimal_for_session(session):
            raise HTTPException(403, "Speech providers are disabled in the minimal demo.")
        state = _read_state(db, sid, claims)
        _check_deadlines(state)
        from .exam import require_active_video_recording
        if require_capture:
            require_active_video_recording(db, sid, bool(session.get("developer_demo", False)))
        elif not session.get('developer_demo', False):
            # Provider discovery happens before the first two-second chunk. It
            # must not permanently disable the first question's speech controls.
            # Capture-consuming routes still require an accepted recording chunk.
            encoded = 'CAST(:sid AS uuid)' if db.get_bind().dialect.name == 'postgresql' else ':sid'
            video = db.execute(text(f'SELECT status, expires_at FROM exam_session_videos WHERE session_id = {encoded}'),
                               {'sid': sid}).mappings().first()
            if not video or video['status'] != 'recording':
                raise HTTPException(409, 'The assessed recording is not active.')
            from .exam_video import _require_unexpired_video
            _require_unexpired_video(video)
        _, _, _, preferences = _session(db, sid, claims)
        correlation = SpeechContext(UUID(sid), UUID(str(pending["id"])),
            str(state.get("question_revision") or pending["id"]), request_id or UUID(int=0))
        return correlation, settings, preferences, pending
    except SQLAlchemyError as error:
        raise HTTPException(503, "Speech session storage is unavailable.") from error
    finally:
        # Do not hold a read transaction/row lock while reading audio or running a
        # provider. Each guard observes fresh attempt state after async work.
        db.rollback()


def _guard(db, sid, authorization, expected, sequence_num):
    def current(context):
        actual, _, _, _ = _authorized_context(db, sid, authorization,
            sequence_num=sequence_num, request_id=expected.request_id)
        return actual == expected and context == expected
    return current


def _failure(error):
    return HTTPException(error.status_code, {"code": error.code, "message": str(error)})


@router.get("/{session_id}/speech/capabilities")
def capabilities(session_id: UUID, authorization: str | None = Header(default=None),
                 db: Session = Depends(get_db), service: SpeechService = Depends(get_speech_service)):
    _authorized_context(db, str(session_id), authorization, require_capture=False)
    return {**service.capabilities(), "typed_input_available": True,
            "transcript_confirmation_required": True}


async def _read_audio(request: Request):
    length = request.headers.get("content-length")
    if length is not None:
        try:
            count = int(length)
        except ValueError:
            raise HTTPException(400, "Invalid audio content length.") from None
        if count < 0 or count > MAX_AUDIO_BYTES:
            raise HTTPException(413, "Speech audio exceeds the size limit.")
    mime_type = request.headers.get("content-type", "").split(";", 1)[0].lower().strip()
    if mime_type not in SUPPORTED_INPUTS:
        raise HTTPException(415, "Speech audio format is unsupported.")

    async def collect():
        audio = bytearray()
        async for chunk in request.stream():
            if len(audio) + len(chunk) > MAX_AUDIO_BYTES:
                raise HTTPException(413, "Speech audio exceeds the size limit.")
            audio.extend(chunk)
        return bytes(audio), mime_type
    try:
        return await asyncio.wait_for(collect(), timeout=20)
    except asyncio.TimeoutError:
        raise HTTPException(408, "Speech audio upload timed out.") from None


@router.post("/{session_id}/speech/transcribe")
async def transcribe(session_id: UUID, request: Request,
                     sequence_num: int = Query(ge=1), request_id: UUID = Query(),
                     authorization: str | None = Header(default=None),
                     db: Session = Depends(get_db), service: SpeechService = Depends(get_speech_service)):
    sid = str(session_id)
    expected, _, _, _ = _authorized_context(db, sid, authorization,
        sequence_num=sequence_num, request_id=request_id)
    # Refuse unavailable providers before consuming private media.
    if not service.capabilities()["transcription"]["available"]:
        raise HTTPException(503, {"code": "provider_unavailable", "message": "Speech transcription is unavailable. Type your answer."})
    audio, mime_type = await _read_audio(request)
    try:
        result = await service.transcribe(TranscriptionRequest(expected, audio, mime_type),
            is_current=_guard(db, sid, authorization, expected, sequence_num))
    except SpeechError as error:
        raise _failure(error) from None
    claims = read_student_token(authorization, expected_purpose="student_session")
    receipt = issue_transcript_receipt(student_id=claims["sub"], session_id=session_id,
        interaction_id=result.context.interaction_id, sequence_num=sequence_num,
        draft_id=request_id, machine_draft=result.text, student_token_exp=claims["exp"])
    return {"request_id": str(request_id), "transcript_draft_id": str(request_id),
            "transcript_receipt": receipt,
            "interaction_id": str(result.context.interaction_id),
            "question_revision": result.context.question_revision, "sequence_num": sequence_num,
            "text": result.text, "source": result.source, "status": result.status}


@router.post("/{session_id}/speech/synthesize")
async def synthesize(session_id: UUID, body: SynthesisRequest,
                     authorization: str | None = Header(default=None),
                     db: Session = Depends(get_db), service: SpeechService = Depends(get_speech_service)):
    sid = str(session_id)
    expected, settings, preferences, pending = _authorized_context(db, sid, authorization,
        sequence_num=body.sequence_num, request_id=body.request_id)
    # The request cannot supply text, a rubric, a voice name or other policy.
    synthesis = SpeechOutputRequest(expected, pending["question_text"],
        settings.presentation.voice, preferences.speed)
    try:
        result = await service.synthesize(synthesis,
            is_current=_guard(db, sid, authorization, expected, body.sequence_num))
    except SpeechError as error:
        raise _failure(error) from None
    return Response(result.audio, media_type=result.mime_type, headers={
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "X-Speech-Request-Id": str(body.request_id),
        "X-Speech-Interaction-Id": str(result.context.interaction_id),
        "X-Speech-Duration-Seconds": str(result.duration_seconds)})
