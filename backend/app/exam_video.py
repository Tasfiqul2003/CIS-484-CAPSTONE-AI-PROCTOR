"""Optional consented WebM capture. Capture never gates answers or grading."""
import errno
import os
import re
import shutil
import stat
import tempfile
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from fastapi.routing import APIRoute
from fastapi.exceptions import RequestValidationError
from fastapi.encoders import jsonable_encoder
from starlette.background import BackgroundTask
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from .auth import require_professor
from .db import get_db
from .student_auth import read_student_token

MAX_RECORDING_BYTES = 512 * 1024 * 1024
MAX_CHUNK_BYTES = 10 * 1024 * 1024
STALE_AFTER = timedelta(seconds=90)
SUBMITTED = ('pending_grading', 'flagged', 'graded')
FAILURES = {
    'permission_denied': 'Camera or microphone permission was denied.',
    'unavailable': 'Camera, microphone, browser support, or recording configuration was unavailable.',
    'upload_failed': 'Recording data could not be uploaded or finalized.',
    'interrupted': 'Recording was interrupted and cannot be resumed.',
}


class PrivateRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def private(request):
            try:
                response = await handler(request)
            except RequestValidationError as error:
                raise HTTPException(422, jsonable_encoder(error.errors()),
                    headers={'Cache-Control': 'private, no-store'}) from error
            except HTTPException as error:
                error.headers = {**(error.headers or {}), 'Cache-Control': 'private, no-store'}
                raise
            response.headers['Cache-Control'] = 'private, no-store'
            response.headers['X-Content-Type-Options'] = 'nosniff'
            return response
        return private


router = APIRouter(prefix='/exam', tags=['exam recording'], route_class=PrivateRoute)


class StartRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    content_type: str = Field(min_length=1, max_length=120)


class CompleteRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    expected_chunk_count: int = Field(ge=1, le=1000000, strict=True)


class FailureRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    status: str


def _retention_deadline():
    value = os.getenv('EXAM_VIDEO_RETENTION_UNTIL', '').strip()
    try:
        if len(value) == 10:
            deadline = datetime.combine(date.fromisoformat(value), time.max, tzinfo=timezone.utc)
        else:
            deadline = datetime.fromisoformat(value.replace('Z', '+00:00'))
            if deadline.tzinfo is None:
                raise ValueError('timezone required')
        if deadline <= datetime.now(timezone.utc):
            raise ValueError('expired')
        return deadline.astimezone(timezone.utc)
    except ValueError as error:
        raise HTTPException(503, 'An administrator must configure a valid recording retention deadline.') from error


def _safe_path(path: Path):
    # Reject links before resolve(), including configured-root ancestors and
    # Windows junctions. The mounted root is private to the backend account.
    for part in [path, *path.parents]:
        if part.is_symlink() or (hasattr(part, 'is_junction') and part.is_junction()):
            raise HTTPException(503, 'Recording storage has an unsafe path.')
    return path


def _recording_root(*, require_space=False, write_required=True):
    configured = os.getenv('EXAM_VIDEO_DIR', '').strip()
    root = Path(configured).expanduser()
    if not configured or not root.is_absolute():
        raise HTTPException(503, 'Recording storage is not configured.')
    _safe_path(root)
    try:
        if write_required:
            root.mkdir(parents=True, exist_ok=True, mode=0o700)
            os.chmod(root, 0o700)
            with tempfile.TemporaryFile(dir=root):
                pass
        if not root.is_dir():
            raise OSError('not a directory')
        if require_space and shutil.disk_usage(root).free < MAX_RECORDING_BYTES:
            raise HTTPException(507, 'Recording storage has insufficient free space.')
    except OSError as error:
        raise HTTPException(503, 'Recording storage is unavailable.') from error
    return root


def _private_open(path, flags):
    _safe_path(path)
    fd = os.open(path, flags | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0), 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        os.close(fd)
        raise OSError('unsafe recording file')
    return os.fdopen(fd, 'rb' if not flags & (os.O_WRONLY | os.O_RDWR) else 'wb')


def _chunks(root, session_id):
    directory = _safe_path(root / str(session_id) / 'chunks')
    directory.parent.mkdir(mode=0o700, exist_ok=True)
    directory.mkdir(mode=0o700, exist_ok=True)
    os.chmod(directory.parent, 0o700)
    os.chmod(directory, 0o700)
    return directory


def _student(db, session_id, authorization):
    claims = read_student_token(authorization, expected_purpose='student_session')
    if claims.get('session_id') != str(session_id):
        raise HTTPException(403, 'Student token does not match this session.')
    session = db.execute(text('''SELECT id, student_id, exam_template_id, status,
        developer_demo, record_examination, generate_transcript, recording_consent_status
        FROM exam_sessions WHERE id = CAST(:sid AS uuid) FOR UPDATE'''),
        {'sid': str(session_id)}).mappings().first()
    if session is None:
        raise HTTPException(404, 'Session not found.')
    if (claims.get('sub') != str(session['student_id']) or
            claims.get('exam_template_id') != str(session['exam_template_id'])):
        raise HTTPException(403, 'Student token does not match this exam session.')
    if session['developer_demo']:
        raise HTTPException(409, 'Developer demo sessions are never recorded.')
    return session


def _eligible(session):
    if not session['record_examination'] or session['recording_consent_status'] != 'consented':
        raise HTTPException(409, 'Recording requires an enabled session snapshot and saved consent.')
    if session['status'] not in ('in_progress', *SUBMITTED):
        raise HTTPException(409, 'This session does not accept recording operations.')


def _video(db, sid, *, lock=True):
    query = 'SELECT * FROM exam_session_videos WHERE session_id = CAST(:sid AS uuid)'
    return db.execute(text(query + (' FOR UPDATE' if lock else '')), {'sid': str(sid)}).mappings().first()


def _notify(db, sid):
    db.execute(text('''INSERT INTO recording_consent_notifications
        (professor_id, exam_template_id, exam_session_id, student_id, event_type)
        SELECT t.professor_id, s.exam_template_id, s.id, s.student_id, 'recording_failed'
        FROM exam_sessions s JOIN exam_templates t ON t.id = s.exam_template_id
        WHERE s.id = CAST(:sid AS uuid)
        ON CONFLICT (exam_session_id, event_type) DO NOTHING'''), {'sid': str(sid)})


def _fail(db, sid, status, session, *, reason=None):
    reason = reason or FAILURES[status]
    # Keep the session -> video lock order, including after storage-error
    # rollback released the original session lock.
    db.execute(text('SELECT id FROM exam_sessions WHERE id = CAST(:sid AS uuid) FOR UPDATE'), {'sid': str(sid)})
    db.execute(text('''INSERT INTO exam_session_videos
        (session_id, status, failure_reason, transcript_status)
        VALUES (CAST(:sid AS uuid), :status, :reason, :transcript_status)
        ON CONFLICT (session_id) DO UPDATE SET status = :status,
            failure_reason = :reason, updated_at = now(), transcript_status = :transcript_status
        WHERE exam_session_videos.status = 'recording' '''),
        {'sid': str(sid), 'status': status, 'reason': reason,
         'transcript_status': 'no_recording' if session['generate_transcript'] else 'not_requested'})
    _notify(db, sid)
    db.commit()


def recording_summary(session, video):
    """A shared representation without file paths or public media URLs."""
    status = 'awaiting_recording'
    if session.get('developer_demo') or not session.get('record_examination'):
        status = 'not_required'
    elif session.get('recording_consent_status') == 'pending':
        status = 'awaiting_consent'
    elif session.get('recording_consent_status') == 'declined':
        status = 'consent_declined'
    elif video:
        status = video['status']
        if video.get('expires_at') and video['expires_at'] <= datetime.now(timezone.utc):
            status = 'expired'
    transcript_status = 'not_requested'
    if session.get('generate_transcript'):
        transcript_status = video['transcript_status'] if video else (
            'no_recording' if status in ('consent_declined', 'not_required') else 'awaiting_recording')
        if status == 'expired':
            transcript_status = 'expired'
    return {
        'status': status,
        'failure_reason': video.get('failure_reason') if video else None,
        'chunk_count': int(video['next_chunk_index']) if video else 0,
        'total_bytes': int(video['total_bytes']) if video else 0,
        'expires_at': video['expires_at'].isoformat() if video and video.get('expires_at') else None,
        'playable': status == 'completed' and session['status'] in SUBMITTED,
        'transcript_status': transcript_status,
        'generated_transcript': video.get('generated_transcript') if video and status != 'expired' else None,
    }


@router.get('/sessions/{session_id}/video-recording')
def student_recording_status(session_id: UUID, authorization: str | None = Header(default=None), db: Session = Depends(get_db)):
    session = _student(db, session_id, authorization)
    return recording_summary(session, _video(db, session_id))


@router.post('/sessions/{session_id}/video-recording/preflight')
def preflight(session_id: UUID, authorization: str | None = Header(default=None), db: Session = Depends(get_db)):
    session = _student(db, session_id, authorization)
    _eligible(session)
    try:
        _retention_deadline()
        _recording_root(require_space=True)
    except HTTPException as error:
        if not _video(db, session_id):
            _fail(db, session_id, 'unavailable', session, reason=error.detail)
        return {'ready': False, 'reason': 'Recording storage or retention is unavailable. You can continue the exam.'}
    return {'ready': True}


@router.post('/sessions/{session_id}/video-recording/start')
def start(session_id: UUID, body: StartRequest, authorization: str | None = Header(default=None), db: Session = Depends(get_db)):
    session = _student(db, session_id, authorization)
    _eligible(session)
    if session['status'] != 'in_progress' or _video(db, session_id):
        raise HTTPException(409, 'Recording cannot be started again for this session.')
    if body.content_type.lower().replace(' ', '') not in (
            'video/webm', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus'):
        raise HTTPException(415, 'Combined WebM audio and video recording is required.')
    try:
        deadline = _retention_deadline()
        root = _recording_root(require_space=True)
        if any(_chunks(root, session_id).iterdir()):
            raise HTTPException(409, 'An earlier capture cannot be resumed.')
        db.execute(text('''INSERT INTO exam_session_videos
            (session_id, status, content_type, expires_at, transcript_status)
            VALUES (CAST(:sid AS uuid), 'recording', :content_type, :expires_at, :transcript_status)'''),
            {'sid': str(session_id), 'content_type': body.content_type, 'expires_at': deadline,
             'transcript_status': 'awaiting_recording' if session['generate_transcript'] else 'not_requested'})
        db.commit()
    except Exception:
        db.rollback()
        raise
    return {'status': 'recording', 'next_chunk_index': 0}


def _accepting(video):
    if not video or video['status'] != 'recording':
        raise HTTPException(409, 'Recording is no longer accepting data.')
    if video['expires_at'] <= datetime.now(timezone.utc):
        raise HTTPException(410, 'Recording retention has expired.')


@router.put('/sessions/{session_id}/video-recording/chunks/{index}')
async def upload(session_id: UUID, index: int, request: Request,
                 authorization: str | None = Header(default=None), db: Session = Depends(get_db)):
    # Read a bounded raw body before taking locks. No multipart temporary file
    # can grow beyond the per-chunk application limit.
    data = bytearray()
    async for part in request.stream():
        data.extend(part)
        if len(data) > MAX_CHUNK_BYTES:
            raise HTTPException(413, 'Recording chunk exceeds the size limit.')
    if index < 0 or index > 99999999 or not data:
        raise HTTPException(422, 'A nonempty sequential chunk is required.')
    session = _student(db, session_id, authorization)
    _eligible(session)
    video = _video(db, session_id)
    _accepting(video)
    if index > video['next_chunk_index']:
        raise HTTPException(409, 'Recording chunks must be uploaded in order.')
    try:
        directory = _chunks(_recording_root(), session_id)
        path = directory / f'{index:08d}.chunk'
        if path.exists() or path.is_symlink():
            with _private_open(path, os.O_RDONLY) as source:
                if source.read(MAX_CHUNK_BYTES + 1) != data:
                    raise HTTPException(409, 'This chunk index already contains different data.')
            if index < video['next_chunk_index']:
                return {'accepted': True, 'duplicate': True, 'index': index}
        elif index < video['next_chunk_index']:
            raise OSError('accepted chunk missing')
        if int(video['total_bytes']) + len(data) > MAX_RECORDING_BYTES:
            raise HTTPException(413, 'Recording exceeds the total size limit.')
        if index == 0 and not data.startswith(b'\x1a\x45\xdf\xa3'):
            raise HTTPException(415, 'The first chunk must contain a WebM header.')
        if shutil.disk_usage(directory).free < len(data) + 1024 * 1024:
            raise OSError(errno.ENOSPC, 'insufficient storage')
        if not path.exists():
            # Atomic installation allows recovery of a file written before a
            # failed DB commit. Identical orphan bytes are adopted on retry.
            temp = directory / f'{index:08d}.tmp'
            try:
                with _private_open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL) as target:
                    target.write(data)
                    target.flush()
                    os.fsync(target.fileno())
                os.replace(temp, path)
            finally:
                if temp.exists() and not temp.is_symlink():
                    temp.unlink()
        db.execute(text('''UPDATE exam_session_videos SET next_chunk_index = next_chunk_index + 1,
            total_bytes = total_bytes + :chunk_bytes, updated_at = now()
            WHERE session_id = CAST(:sid AS uuid)'''), {'sid': str(session_id), 'chunk_bytes': len(data)})
        db.commit()
    except OSError as error:
        db.rollback()
        _fail(db, session_id, 'upload_failed', session)
        raise HTTPException(507, 'Recording storage failed. Continue the exam.') from error
    except Exception:
        db.rollback()
        raise
    return {'accepted': True, 'duplicate': False, 'index': index}


@router.post('/sessions/{session_id}/video-recording/failure')
def failure(session_id: UUID, body: FailureRequest, authorization: str | None = Header(default=None), db: Session = Depends(get_db)):
    session = _student(db, session_id, authorization)
    _eligible(session)
    if body.status not in FAILURES:
        raise HTTPException(422, 'Unsupported recording failure status.')
    video = _video(db, session_id)
    if video and video['status'] != 'recording':
        return recording_summary(session, video)
    _fail(db, session_id, body.status, session)
    return {'status': body.status}


@router.post('/sessions/{session_id}/video-recording/complete')
def complete(session_id: UUID, body: CompleteRequest, authorization: str | None = Header(default=None), db: Session = Depends(get_db)):
    session = _student(db, session_id, authorization)
    _eligible(session)
    video = _video(db, session_id)
    if not video or body.expected_chunk_count != video['next_chunk_index']:
        raise HTTPException(409, 'Not all recording chunks were received.')
    if video['expires_at'] and video['expires_at'] <= datetime.now(timezone.utc):
        raise HTTPException(410, 'Recording retention has expired.')
    if video['status'] == 'completed':
        return {'status': 'completed', 'bytes': video['total_bytes']}
    _accepting(video)
    try:
        root = _recording_root()
        directory = _chunks(root, session_id)
        final = _safe_path(root / f'{session_id}.webm')
        temp = _safe_path(root / f'{session_id}.assembling')
        if final.exists():
            with _private_open(final, os.O_RDONLY) as existing:
                if os.fstat(existing.fileno()).st_size != video['total_bytes']:
                    raise OSError('invalid assembly')
        else:
            if shutil.disk_usage(root).free < video['total_bytes'] + 1024 * 1024:
                raise OSError(errno.ENOSPC, 'insufficient storage')
            # A leftover temporary assembly is never trusted as a completed file.
            if temp.exists():
                temp.unlink()
            with _private_open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL) as target:
                for index in range(video['next_chunk_index']):
                    with _private_open(directory / f'{index:08d}.chunk', os.O_RDONLY) as source:
                        shutil.copyfileobj(source, target)
                target.flush()
                os.fsync(target.fileno())
                if target.tell() != video['total_bytes']:
                    raise OSError('assembly size mismatch')
            os.replace(temp, final)
        # No speech engine or model is bundled with the web backend. Never
        # substitute typed answers or silently call an external API.
        db.execute(text('''UPDATE exam_session_videos SET status = 'completed',
            completed_at = now(), updated_at = now(), transcript_status = :transcript_status
            WHERE session_id = CAST(:sid AS uuid)'''),
            {'sid': str(session_id), 'transcript_status': 'unavailable' if session['generate_transcript'] else 'not_requested'})
        db.commit()
    except OSError as error:
        db.rollback()
        _fail(db, session_id, 'upload_failed', session)
        raise HTTPException(507, 'Recording could not be finalized. Exam answers remain saved.') from error
    except Exception:
        db.rollback()
        raise
    # Keep chunks until retention cleanup, so a lost completion response or
    # failed DB transaction never destroys successfully uploaded evidence.
    return {'status': 'completed', 'bytes': video['total_bytes']}


def _professor_session(db, sid, account, *, lock=False):
    query = '''SELECT s.*, t.professor_id AS exam_professor_id
        FROM exam_sessions s JOIN exam_templates t ON t.id = s.exam_template_id
        WHERE s.id = CAST(:sid AS uuid)'''
    session = db.execute(text(query + (' FOR UPDATE OF s' if lock else '')), {'sid': str(sid)}).mappings().first()
    if not session or not account.get('professor_id') or str(session['exam_professor_id']) != str(account['professor_id']) or session['developer_demo']:
        raise HTTPException(404, 'Session not found.')
    return session


@router.get('/sessions/{session_id}/recording-review')
def recording_review(session_id: UUID, account: dict = Depends(require_professor), db: Session = Depends(get_db)):
    session = _professor_session(db, session_id, account, lock=True)
    video = _video(db, session_id)
    if (not video and session['status'] in SUBMITTED and session['record_examination']
            and session['recording_consent_status'] == 'consented'):
        _fail(db, session_id, 'interrupted', session)
        video = _video(db, session_id)
    if video and video['status'] == 'recording' and datetime.now(timezone.utc) - video['updated_at'] > STALE_AFTER:
        _fail(db, session_id, 'interrupted', session)
        video = _video(db, session_id)
    return recording_summary(session, video)


@router.get('/sessions/{session_id}/video')
def playback(session_id: UUID, range_header: str | None = Header(default=None, alias='Range'),
             account: dict = Depends(require_professor), db: Session = Depends(get_db)):
    session = _professor_session(db, session_id, account)
    if session['status'] not in SUBMITTED:
        raise HTTPException(409, 'Playback is available after exam submission.')
    summary = recording_summary(session, _video(db, session_id, lock=False))
    if summary['status'] == 'expired':
        raise HTTPException(410, 'Recording retention has expired.')
    if not summary['playable']:
        raise HTTPException(404, 'A completed recording is not available.')
    try:
        source = _private_open(_recording_root(write_required=False) / f'{session_id}.webm', os.O_RDONLY)
    except OSError as error:
        raise HTTPException(410, 'Recording media is unavailable.') from error
    size = os.fstat(source.fileno()).st_size
    if size != summary['total_bytes']:
        source.close()
        raise HTTPException(410, 'Recording media is incomplete.')
    start, end = 0, size - 1
    headers = {'Accept-Ranges': 'bytes'}
    if range_header:
        match = re.fullmatch(r'bytes=(\d*)-(\d*)', range_header)
        if not match or not any(match.groups()):
            source.close()
            raise HTTPException(416, 'Invalid media range.', headers={'Content-Range': f'bytes */{size}'})
        left, right = match.groups()
        start = int(left) if left else max(0, size - int(right))
        end = min(size - 1, int(right)) if right and left else size - 1
        if start > end or start >= size:
            source.close()
            raise HTTPException(416, 'Media range unavailable.', headers={'Content-Range': f'bytes */{size}'})
        headers['Content-Range'] = f'bytes {start}-{end}/{size}'
    headers['Content-Length'] = str(end - start + 1)

    def stream():
        try:
            source.seek(start)
            remaining = end - start + 1
            while remaining:
                data = source.read(min(1024 * 1024, remaining))
                if not data:
                    break
                remaining -= len(data)
                yield data
        finally:
            source.close()
    return StreamingResponse(stream(), status_code=206 if range_header else 200,
                             media_type='video/webm', headers=headers,
                             background=BackgroundTask(source.close))
