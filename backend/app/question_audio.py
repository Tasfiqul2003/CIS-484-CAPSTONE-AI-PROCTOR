"""Retain exactly the question audio returned for authorized browser playback.

Generation is not evidence of listening. Client playback reports live separately
in the media timeline. All assets inherit their attempt recording's fixed expiry.
"""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from .auth import get_current_account
from .avatar_assistance import _context, _check_deadlines, _read_state
from .db import get_db
from .exam_speech import get_speech_service, _authorized_context, _guard, _failure
from .exam_video import _recording_root
from .speech_adapters import SpeechService, SpeechOutputRequest, SpeechError
from .student_auth import read_student_token

router = APIRouter(prefix='/exam/sessions', tags=['Question audio'])
MAX_ASSETS_PER_QUESTION = 5
MAX_REQUEST_IDS_PER_QUESTION = 128


class GenerateQuestionAudio(BaseModel):
    model_config = ConfigDict(extra='forbid')
    sequence_num: int = Field(strict=True, ge=1)
    request_id: UUID


def _bind(db, name):
    return f'CAST(:{name} AS uuid)' if db.get_bind().dialect.name == 'postgresql' else f':{name}'


def _hash(value):
    return hashlib.sha256(value).hexdigest()


def _fingerprint(context, question, voice, speed):
    return _hash(json.dumps({'interaction': str(context.interaction_id), 'question': question,
                            'voice': voice, 'speed': speed}, sort_keys=True).encode('utf-8'))


def _file(root: Path, session_id, asset_id, *, create=False):
    # Both names are server UUIDs, never client filenames. Check before mkdir to
    # avoid traversing a malicious directory junction and creating files elsewhere.
    root = root.resolve()
    base = root / 'question-audio'
    directory = base / str(UUID(str(session_id)))
    target = directory / f'{UUID(str(asset_id))}.wav'
    if (base.is_symlink() or base.resolve().parent != root or directory.is_symlink()
            or directory.resolve().parent != base.resolve() or target.is_symlink()
            or target.resolve().parent != directory.resolve()):
        raise HTTPException(503, 'Question audio storage is unavailable.')
    if create:
        try:
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        except OSError:
            raise HTTPException(503, 'Question audio storage is unavailable.') from None
    return target


def _deadline(value):
    if isinstance(value, str):
        value = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if value is None or value.tzinfo is None or value <= datetime.now(timezone.utc):
        raise HTTPException(410, 'Question audio has passed its recording retention deadline.')
    return value


def _metadata(row):
    return {'asset_id': str(row['id']), 'interaction_id': str(row['interaction_id']),
            'audio_url': f"/api/exam/sessions/{row['session_id']}/question-audio/{row['id']}",
            'content_sha256': row['content_hash'], 'duration_seconds': float(row['duration_seconds']),
            'expires_at': _deadline(row['expires_at']).isoformat(),
            'status': 'ready', 'playback_evidence': 'generated_only'}


def _existing(db, context, body, fingerprint, voice, speed):
    row = db.execute(text(f'''SELECT a.*, r.input_hash AS request_hash FROM exam_question_audio_requests r
        JOIN exam_question_audio a ON a.id = r.asset_id
        WHERE r.session_id = {_bind(db, 'sid')} AND r.request_id = {_bind(db, 'rid')}'''),
        {'sid': str(context.attempt_id), 'rid': str(body.request_id)}).mappings().first()
    if row:
        if row['request_hash'] != fingerprint:
            raise HTTPException(409, 'This audio request ID belongs to a different question or configuration.')
        if row['status'] != 'ready':
            raise HTTPException(410, 'Question audio is no longer retained.')
        return row
    row = db.execute(text(f'''SELECT * FROM exam_question_audio WHERE session_id = {_bind(db, 'sid')}
        AND interaction_id = {_bind(db, 'iid')} AND voice = :voice AND speed = :speed AND status = 'ready' '''),
        {'sid': str(context.attempt_id), 'iid': str(context.interaction_id), 'voice': voice, 'speed': speed}).mappings().first()
    if row and row['input_hash'] != fingerprint:
        raise HTTPException(409, 'The delivered question revision has changed.')
    return row


def _remember_request(db, context, body, fingerprint, asset_id):
    existing = db.execute(text(f'''SELECT input_hash FROM exam_question_audio_requests
        WHERE session_id = {_bind(db, 'sid')} AND request_id = {_bind(db, 'rid')}'''),
        {'sid': str(context.attempt_id), 'rid': str(body.request_id)}).first()
    if existing is None:
        count = db.execute(text(f'''SELECT COUNT(*) FROM exam_question_audio_requests r
            JOIN exam_question_audio a ON a.id = r.asset_id
            WHERE r.session_id = {_bind(db, 'sid')} AND a.interaction_id = {_bind(db, 'iid')}'''),
            {'sid': str(context.attempt_id), 'iid': str(context.interaction_id)}).scalar_one()
        if count >= MAX_REQUEST_IDS_PER_QUESTION:
            raise HTTPException(429, 'This question has reached its audio request limit. Replay an existing saved version.')
    db.execute(text(f'''INSERT INTO exam_question_audio_requests(session_id, request_id, input_hash, asset_id)
        VALUES ({_bind(db, 'sid')}, {_bind(db, 'rid')}, :fingerprint, {_bind(db, 'aid')})
        ON CONFLICT(session_id, request_id) DO NOTHING'''),
        {'sid': str(context.attempt_id), 'rid': str(body.request_id),
         'aid': str(asset_id), 'fingerprint': fingerprint})


def _check_budget(db, context):
    count = db.execute(text(f'''SELECT count(*) FROM exam_question_audio
        WHERE session_id = {_bind(db, 'sid')} AND interaction_id = {_bind(db, 'iid')}'''),
        {'sid': str(context.attempt_id), 'iid': str(context.interaction_id)}).scalar_one()
    if count >= MAX_ASSETS_PER_QUESTION:
        raise HTTPException(429, 'Question audio variation limit reached. Replay an existing version or use the question text.')


def _lock_current(db, sid, authorization, context, sequence_num, voice, speed):
    claims = read_student_token(authorization, expected_purpose='student_session')
    row, settings, _, pending = _context(db, sid, claims, lock=True)
    read_student_token(authorization, expected_purpose='student_session')
    if row['status'] != 'in_progress' or pending is None or str(pending['id']) != str(context.interaction_id) or pending['sequence_num'] != sequence_num:
        raise HTTPException(409, 'The active question changed. Discard this audio result.')
    _check_deadlines(_read_state(db, sid, claims))
    from .avatar_session import _session
    _, _, _, preferences = _session(db, sid, claims)
    if settings.presentation.voice != voice or preferences.speed != speed:
        raise HTTPException(409, 'Question audio preferences changed. Try again.')
    video = db.execute(text(f'''SELECT expires_at, status FROM exam_session_videos
        WHERE session_id = {_bind(db, 'sid')}'''), {'sid': sid}).mappings().first()
    if not video or video['status'] != 'recording':
        raise HTTPException(409, 'An active assessed recording is required for saved question audio.')
    return _deadline(video['expires_at'])


@router.post('/{session_id}/question-audio')
async def generate_question_audio(session_id: UUID, body: GenerateQuestionAudio,
    authorization: str | None = Header(default=None), db: Session = Depends(get_db),
    service: SpeechService = Depends(get_speech_service)):
    sid = str(session_id)
    context, settings, preferences, pending = _authorized_context(db, sid, authorization,
        sequence_num=body.sequence_num, request_id=body.request_id)
    voice, speed, question = settings.presentation.voice, preferences.speed, pending['question_text']
    fingerprint = _fingerprint(context, question, voice, speed)
    target = None
    try:
        expires = _lock_current(db, sid, authorization, context, body.sequence_num, voice, speed)
        previous = _existing(db, context, body, fingerprint, voice, speed)
        if previous:
            result = _metadata(previous)
            _remember_request(db, context, body, fingerprint, previous['id'])
            db.commit()
            return result
        _check_budget(db, context)
        # Release the attempt before potentially slow synthesis. Recheck under the
        # same lock before storing; duplicate work cannot create duplicate assets.
        db.rollback()
        try:
            audio = await service.synthesize(SpeechOutputRequest(context, question, voice, speed),
                is_current=_guard(db, sid, authorization, context, body.sequence_num))
        except SpeechError as error:
            raise _failure(error) from None
        expires = _lock_current(db, sid, authorization, context, body.sequence_num, voice, speed)
        previous = _existing(db, context, body, fingerprint, voice, speed)
        if previous:
            result = _metadata(previous)
            _remember_request(db, context, body, fingerprint, previous['id'])
            db.commit()
            return result
        _check_budget(db, context)
        asset_id = uuid4()
        target = _file(_recording_root(require_space=True), session_id, asset_id, create=True)
        try:
            with target.open('xb') as output:
                output.write(audio.audio)
                output.flush()
                os.fsync(output.fileno())
        except OSError:
            raise HTTPException(507, 'Question audio could not be saved. Use the question text.') from None
        params = {'aid': str(asset_id), 'sid': sid, 'iid': str(context.interaction_id),
            'rid': str(body.request_id), 'input_hash': fingerprint, 'text_hash': _hash(question.encode('utf-8')),
            'content_hash': _hash(audio.audio), 'voice': voice, 'speed': speed,
            'duration': audio.duration_seconds, 'size': len(audio.audio), 'expires': expires}
        db.execute(text(f'''INSERT INTO exam_question_audio
            (id, session_id, interaction_id, request_id, input_hash, text_hash, content_hash,
             voice, speed, duration_seconds, byte_count, status, expires_at)
            VALUES ({_bind(db, 'aid')}, {_bind(db, 'sid')}, {_bind(db, 'iid')}, {_bind(db, 'rid')},
                :input_hash, :text_hash, :content_hash, :voice, :speed, :duration, :size, 'ready', :expires)'''), params)
        _remember_request(db, context, body, fingerprint, asset_id)
        metadata = _metadata({'id': asset_id, 'session_id': session_id, 'interaction_id': context.interaction_id,
            'content_hash': params['content_hash'], 'duration_seconds': audio.duration_seconds, 'expires_at': expires})
        db.commit()
        target = None
        return metadata
    except (HTTPException, SQLAlchemyError) as error:
        db.rollback()
        if target is not None:
            try:
                target.unlink(missing_ok=True)
            except OSError:
                pass  # Retention cleanup also inventories this attempt's UUID WAVs.
        if isinstance(error, SQLAlchemyError):
            raise HTTPException(503, 'Question audio storage is unavailable.') from None
        raise


@router.get('/{session_id}/question-audio/{asset_id}')
def get_question_audio(session_id: UUID, asset_id: UUID, request: Request,
    authorization: str | None = Header(default=None), db: Session = Depends(get_db)):
    claims = read_student_token(authorization, expected_purpose='student_session') if authorization else None
    account = get_current_account(request, db) if claims is None else None
    if claims is not None and claims.get('session_id') != str(session_id):
        raise HTTPException(403, 'Student token does not match this attempt.')
    row = db.execute(text(f'''SELECT a.*, s.student_id, s.exam_template_id, s.status AS session_status,
        t.professor_id, v.status AS recording_status, v.expires_at AS recording_expires_at
        FROM exam_question_audio a JOIN exam_sessions s ON s.id = a.session_id
        JOIN exam_templates t ON t.id = s.exam_template_id
        JOIN exam_session_videos v ON v.session_id = s.id
        WHERE a.id = {_bind(db, 'aid')} AND a.session_id = {_bind(db, 'sid')}'''),
        {'aid': str(asset_id), 'sid': str(session_id)}).mappings().first()
    if row is None:
        raise HTTPException(404, 'Question audio not found.')
    if claims is not None:
        if claims.get('sub') != str(row['student_id']) or claims.get('exam_template_id') != str(row['exam_template_id']):
            raise HTTPException(403, 'Student token does not match this attempt.')
        if row['session_status'] != 'in_progress' or row['recording_status'] != 'recording':
            raise HTTPException(409, 'Question audio is no longer available for this active attempt.')
    elif (account.get('role') != 'professor' or str(account.get('professor_id')) != str(row['professor_id'])):
        raise HTTPException(404, 'Question audio not found.')
    elif row['session_status'] not in ('pending_grading', 'flagged', 'graded') or row['recording_status'] != 'completed':
        raise HTTPException(409, 'Recorded question review is available after exam submission and recording completion.')
    _deadline(row['expires_at'])
    _deadline(row['recording_expires_at'])
    if row['status'] != 'ready':
        raise HTTPException(410, 'Question audio is no longer retained.')
    path = _file(_recording_root(write_required=False), session_id, asset_id)
    try:
        if not path.is_file() or path.stat().st_size != row['byte_count'] or _hash(path.read_bytes()) != row['content_hash']:
            raise HTTPException(409, 'Question audio is missing or failed its integrity check.')
    except OSError:
        raise HTTPException(503, 'Question audio storage is unavailable.') from None
    return FileResponse(path, media_type='audio/wav', headers={
        'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'})


def review_assets(db, session_id, events):
    """Called only after professor ownership and completed-recording checks."""
    rows = db.execute(text('''SELECT * FROM exam_question_audio WHERE session_id = :sid
        ORDER BY created_at, id'''), {'sid': str(session_id)}).mappings().all()
    grouped = {}
    for row in rows:
        observations = [event for event in events if event.get('asset_id') == str(row['id'])]
        started = any(event['kind'] == 'question_audio_started' for event in observations)
        playback = ('ended_reported' if started and observations[-1]['kind'] == 'question_audio_ended'
                    else 'started_reported' if started else 'not_reported')
        try:
            item = _metadata(row) if row['status'] == 'ready' else {'status': 'expired'}
        except HTTPException:
            item = {'status': 'expired'}
        item.update({'asset_id': str(row['id']), 'interaction_id': str(row['interaction_id']),
                     'playback_status': playback, 'playback_verified': False})
        grouped.setdefault(str(row['interaction_id']), []).append(item)
    return grouped
