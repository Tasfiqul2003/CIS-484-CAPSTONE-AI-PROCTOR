"""Private, read-only ZIP downloads. Media is streamed without recompression."""
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import os
from pathlib import Path
from uuid import UUID
from zipfile import ZipFile, ZIP_STORED

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import text
from sqlalchemy.orm import Session

from .auth import require_professor
from .db import get_db
from . import exam_video as video

router = APIRouter(prefix='/exam', tags=['exam downloads'], route_class=video.PrivateRoute)
CHUNK_BYTES = 1024 * 1024
MAX_ATTEMPTS = 500
MAX_TEXT_BYTES = 32 * 1024 * 1024


@dataclass
class Entry:
    name: str
    data: bytes | None = None
    path: Path | None = None
    size: int = 0
    identity: tuple | None = None
    expires_at: datetime | None = None


class ZipOutput:
    """Unseekable ZIP sink drained after each bounded input chunk."""
    def __init__(self):
        self.pending = deque()
        self.position = 0

    def write(self, data):
        if data:
            self.pending.append(bytes(data))
            self.position += len(data)
        return len(data)

    def tell(self):
        return self.position

    def flush(self):
        pass

    def drain(self):
        while self.pending:
            yield self.pending.popleft()


def _file_identity(source):
    info = os.fstat(source.fileno())
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns


def _recording_entry(sid, summary):
    if not summary['playable'] or not summary['expires_at']:
        return None
    size = summary['total_bytes']
    if not 0 < size <= video.MAX_RECORDING_BYTES:
        return None
    try:
        path = video._recording_root(write_required=False) / f'{sid}.webm'
        with video._private_open(path, os.O_RDONLY) as source:
            identity = _file_identity(source)
        if identity[2] != size:
            return None
    except (OSError, HTTPException):
        return None
    return Entry(f'attempts/{sid}/recording.webm', path=path, size=size,
                 identity=identity, expires_at=datetime.fromisoformat(summary['expires_at']))


def _prepare_attempt(db, sid, account, budget, exam_id=None):
    session = video._professor_session(db, sid, account)
    if session['status'] not in video.SUBMITTED:
        raise HTTPException(409, 'Files can be downloaded after exam submission.')
    if exam_id is not None and str(session['exam_template_id']) != str(exam_id):
        raise HTTPException(404, 'Session not found.')
    summary = video.recording_summary(session, video._video(db, sid, lock=False))
    params = {'sid': str(sid)}
    # Do not call the report endpoint: it can start automatic AI assessment.
    answers = db.execute(text('''SELECT sequence_num, question_text, student_answer_transcript
        FROM interactions WHERE session_id = CAST(:sid AS uuid) ORDER BY sequence_num'''), params).mappings().all()
    grades = db.execute(text('''SELECT rubric_criterion, max_score, model_suggested_score,
        score, professor_notes, graded_at FROM grades
        WHERE session_id = CAST(:sid AS uuid) ORDER BY created_at'''), params).mappings().all()
    student = db.execute(text('SELECT name, eid FROM students WHERE id = CAST(:student_id AS uuid)'),
                         {'student_id': str(session['student_id'])}).mappings().first()
    prefix = f'attempts/{sid}/'
    entries = []

    def add(name, content):
        data = content.encode('utf-8')
        budget[0] += len(data)
        if budget[0] > MAX_TEXT_BYTES:
            raise HTTPException(413, 'These files exceed the bulk text limit. Download individual attempts instead.')
        entries.append(Entry(prefix + name, data=data))

    metadata = {key: session.get(key) for key in (
        'id', 'student_id', 'exam_template_id', 'status', 'started_at', 'ended_at',
        'identity_check_completed', 'identity_review_required', 'identity_verification_attempts')}
    metadata['student'] = dict(student) if student else None
    metadata['recording_status'] = summary['status']
    metadata['speech_transcript_status'] = summary['transcript_status']
    metadata['recording_expires_at'] = summary['expires_at']
    add('attempt.json', json.dumps(metadata, ensure_ascii=False, default=str, indent=2) + '\n')
    add('typed-answers.txt', 'Questions and submitted answers\n\n' + ('\n\n'.join(
        f"Question {row['sequence_num']}\n{row['question_text'] or 'Question unavailable'}\n"
        f"Submitted answer:\n{row['student_answer_transcript'] or 'No answer saved.'}"
        for row in answers) or 'No answers have been saved.'))
    add('grades.txt', 'Saved grades. AI recommendations require professor review.\n\n' + ('\n\n'.join(
        f"Criterion: {row['rubric_criterion']}\nMaximum score: {row['max_score']}\n"
        f"AI-recommended score: {row['model_suggested_score'] if row['model_suggested_score'] is not None else 'Not available'}\n"
        f"Professor-confirmed score: {row['score'] if row['score'] is not None else 'Not confirmed'}\n"
        f"Professor notes: {row['professor_notes'] or 'None saved.'}"
        for row in grades) or 'No grades have been saved.'))
    media = _recording_entry(sid, summary)
    if media:
        entries.append(media)
    speech = summary['generated_transcript']
    if summary['transcript_status'] == 'completed' and speech is not None and summary['expires_at']:
        add('speech-transcript.txt', speech)
        entries[-1].expires_at = datetime.fromisoformat(summary['expires_at'])
    add('README.txt',
        'This folder contains the files available when the download was requested.\n'
        'Typed answers and the machine-generated speech transcript are separate files.\n'
        'AI-recommended grades are provisional; downloading does not generate new grades.\n'
        f"Recording status: {summary['status']}. Recording included: {'yes' if media else 'no'}.\n"
        f"Speech transcript status: {summary['transcript_status']}.\n"
        'Pending, declined, expired, missing or unavailable media/text is not included.\n'
        'If a recording expires or changes during export, recording-unavailable.txt explains its omission.\n')
    return entries


def stream_zip(entries):
    sink = ZipOutput()
    with ZipFile(sink, mode='w', compression=ZIP_STORED, allowZip64=True) as archive:
        for entry in entries:
            if entry.data is not None:
                if entry.expires_at is not None and entry.expires_at <= datetime.now(timezone.utc):
                    archive.writestr(entry.name.removesuffix('.txt') + '-unavailable.txt',
                                     'Speech transcript retention expired during download.\n')
                    yield from sink.drain()
                    continue
                with archive.open(entry.name, mode='w', force_zip64=True) as target:
                    for offset in range(0, len(entry.data), CHUNK_BYTES):
                        target.write(entry.data[offset:offset + CHUNK_BYTES])
                        yield from sink.drain()
                yield from sink.drain()
                continue
            source = None
            try:
                if entry.expires_at is None or entry.expires_at <= datetime.now(timezone.utc):
                    raise OSError('expired')
                source = video._private_open(entry.path, os.O_RDONLY)
                if _file_identity(source) != entry.identity:
                    raise OSError('changed')
            except (OSError, HTTPException):
                if source:
                    source.close()
                archive.writestr(entry.name.removesuffix('recording.webm') + 'recording-unavailable.txt',
                                 'The recording expired or became unavailable during download. Other files are unchanged.\n')
                yield from sink.drain()
                continue
            with source:
                with archive.open(entry.name, mode='w', force_zip64=True) as target:
                    remaining = entry.size
                    while remaining:
                        chunk = source.read(min(CHUNK_BYTES, remaining))
                        if not chunk:
                            raise OSError('Recording changed during download.')
                        target.write(chunk)
                        remaining -= len(chunk)
                        yield from sink.drain()
                yield from sink.drain()
    yield from sink.drain()


def _response(entries, filename):
    return StreamingResponse(stream_zip(entries), media_type='application/zip', headers={
        'Content-Disposition': f'attachment; filename="{filename}"',
        'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    })


@router.get('/sessions/{session_id}/download-all')
def download_attempt(session_id: UUID, account: dict = Depends(require_professor), db: Session = Depends(get_db)):
    return _response(_prepare_attempt(db, session_id, account, [0]), f'exam-{session_id}.zip')


@router.get('/templates/{exam_template_id}/download-all')
def download_exam(exam_template_id: UUID, account: dict = Depends(require_professor), db: Session = Depends(get_db)):
    owned = db.execute(text('''SELECT id FROM exam_templates
        WHERE id = CAST(:exam_id AS uuid) AND professor_id = CAST(:professor_id AS uuid)'''),
        {'exam_id': str(exam_template_id), 'professor_id': str(account.get('professor_id') or '')}).first()
    if not owned:
        raise HTTPException(404, 'Exam not found.')
    sessions = db.execute(text('''SELECT id FROM exam_sessions
        WHERE exam_template_id = CAST(:exam_id AS uuid) AND NOT developer_demo
          AND status IN ('pending_grading', 'flagged', 'graded')
        ORDER BY ended_at, id LIMIT :limit'''),
        {'exam_id': str(exam_template_id), 'limit': MAX_ATTEMPTS + 1}).mappings().all()
    if not sessions:
        raise HTTPException(409, 'There are no submitted attempts to download yet.')
    if len(sessions) > MAX_ATTEMPTS:
        raise HTTPException(413, 'This exam exceeds the bulk attempt limit. Download individual attempts instead.')
    budget, entries = [0], []
    for row in sessions:
        sid = UUID(str(row['id']))
        entries.extend(_prepare_attempt(db, sid, account, budget, exam_template_id))
    return _response(entries, f'exam-{exam_template_id}-submissions.zip')
