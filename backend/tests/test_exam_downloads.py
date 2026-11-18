"""Synthetic ZIP export/authorization tests. No models or live services."""
import copy
from datetime import datetime, timedelta, timezone
from io import BytesIO
import json
from uuid import UUID
from zipfile import ZipFile, ZIP_STORED

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from backend.app import exam_downloads as downloads
from backend.app.auth import get_current_account, require_professor
from backend.app.db import get_db

SID = '20000000-0000-4000-8000-000000000001'
OTHER_SID = '20000000-0000-4000-8000-000000000002'
STUDENT = '30000000-0000-4000-8000-000000000001'
EXAM = '40000000-0000-4000-8000-000000000001'
OWNER = '50000000-0000-4000-8000-000000000001'
OTHER = '50000000-0000-4000-8000-000000000002'
BASE = f'/exam/sessions/{SID}/download-all'
BULK = f'/exam/templates/{EXAM}/download-all'
MEDIA = b'\x1a\x45\xdf\xa3synthetic-webm-with-audio'


class Result:
    def __init__(self, row=None, rows=()):
        self.row, self.rows = row, rows
    def mappings(self): return self
    def first(self): return self.row
    def all(self): return self.rows


class FakeDB:
    def __init__(self):
        self.sessions = {SID: dict(id=SID, student_id=STUDENT, exam_template_id=EXAM,
            exam_professor_id=OWNER, status='pending_grading', developer_demo=False,
            record_examination=True, generate_transcript=True, recording_consent_status='consented',
            identity_check_completed=False, identity_review_required=True, identity_verification_attempts=0)}
        self.videos = {SID: dict(status='completed', next_chunk_index=1, total_bytes=len(MEDIA),
            transcript_status='completed', generated_transcript='[00:00:00] Synthetic speech.',
            expires_at=datetime.now(timezone.utc) + timedelta(days=1))}
        self.answers = [{'sequence_num': 1, 'question_text': 'Synthetic question?',
                         'student_answer_transcript': 'Typed answer stays separate.'}]
        self.grades = [{'rubric_criterion': 'Synthetic criterion', 'max_score': 5,
            'model_suggested_score': 4, 'score': 0, 'professor_notes': 'Synthetic notes.', 'graded_at': None}]
        self.calls = []

    def execute(self, statement, params=None):
        sql = ' '.join(str(statement).lower().split())
        params = params or {}
        self.calls.append(sql)
        assert sql.startswith('select'), 'Downloads must be read-only.'
        if sql.startswith('select id from exam_templates'):
            return Result({'id': EXAM} if params['exam_id'] == EXAM and params['professor_id'] == OWNER else None)
        if sql.startswith('select id from exam_sessions'):
            return Result(rows=[{'id': key} for key, row in self.sessions.items()
                if row['exam_template_id'] == params['exam_id'] and not row['developer_demo']
                and row['status'] in downloads.video.SUBMITTED][:params['limit']])
        if 'from exam_sessions' in sql:
            return Result(copy.deepcopy(self.sessions.get(params['sid'])))
        if 'from exam_session_videos' in sql:
            return Result(copy.deepcopy(self.videos.get(params['sid'])))
        if 'from interactions' in sql: return Result(rows=copy.deepcopy(self.answers))
        if 'from grades' in sql: return Result(rows=copy.deepcopy(self.grades))
        if 'from students' in sql: return Result({'name': '../Synthetic Student', 'eid': 'synthetic1'})
        raise AssertionError(sql)

    def commit(self): raise AssertionError('Downloads must not commit.')
    def rollback(self): raise AssertionError('Downloads must not mutate or need rollback.')


@pytest.fixture
def api(tmp_path, monkeypatch):
    root = tmp_path / 'private'
    root.mkdir()
    (root / f'{SID}.webm').write_bytes(MEDIA)
    monkeypatch.setenv('EXAM_VIDEO_DIR', str(root))
    db = FakeDB()
    app = FastAPI()
    app.include_router(downloads.router)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[require_professor] = lambda: {'role': 'professor', 'professor_id': OWNER}
    with TestClient(app) as client:
        yield client, db, app, root


def read_zip(response):
    assert response.status_code == 200, response.text
    assert response.headers['cache-control'] == 'private, no-store'
    assert response.headers['content-type'] == 'application/zip'
    assert response.headers['x-content-type-options'] == 'nosniff'
    with ZipFile(BytesIO(response.content)) as archive:
        assert archive.testzip() is None
        assert all(info.compress_type == ZIP_STORED for info in archive.infolist())
        return {name: archive.read(name) for name in archive.namelist()}


def test_attempt_zip_keeps_actual_media_speech_typed_answers_and_saved_grades_separate(api):
    client, db, _, _ = api
    response = client.get(BASE)
    files = read_zip(response)
    prefix = f'attempts/{SID}/'
    assert files[prefix + 'recording.webm'] == MEDIA
    assert files[prefix + 'speech-transcript.txt'] == b'[00:00:00] Synthetic speech.'
    assert b'Typed answer stays separate.' in files[prefix + 'typed-answers.txt']
    assert b'Synthetic speech.' not in files[prefix + 'typed-answers.txt']
    assert b'Professor-confirmed score: 0' in files[prefix + 'grades.txt']
    assert b'AI-recommended score: 4' in files[prefix + 'grades.txt']
    metadata = json.loads(files[prefix + 'attempt.json'])
    assert metadata['identity_check_completed'] is False and metadata['identity_review_required'] is True
    assert len(files) == 6 and all(name.startswith(prefix) and '..' not in name for name in files)
    assert response.headers['content-disposition'] == f'attachment; filename="exam-{SID}.zip"'
    assert all(sql.startswith('select') for sql in db.calls)


@pytest.mark.parametrize('transcript', ['queued', 'processing', 'failed', 'not_requested'])
def test_pending_or_disabled_speech_is_omitted_without_losing_other_files(api, transcript):
    client, db, _, _ = api
    db.videos[SID]['transcript_status'] = transcript
    files = read_zip(client.get(BASE))
    assert not any(name.endswith('speech-transcript.txt') for name in files)
    assert MEDIA in files.values()
    assert transcript.encode() in files[f'attempts/{SID}/README.txt']


def test_completed_empty_speech_transcript_is_a_valid_empty_file(api):
    client, db, _, _ = api
    db.videos[SID]['generated_transcript'] = ''
    assert read_zip(client.get(BASE))[f'attempts/{SID}/speech-transcript.txt'] == b''


def test_expired_media_and_speech_never_leak_into_export(api):
    client, db, _, _ = api
    db.videos[SID]['expires_at'] = datetime.now(timezone.utc) - timedelta(seconds=1)
    files = read_zip(client.get(BASE))
    assert not any(name.endswith(('.webm', '/speech-transcript.txt')) for name in files)
    assert b'Synthetic speech.' not in b'\n'.join(files.values())
    assert b'Typed answer stays separate.' in files[f'attempts/{SID}/typed-answers.txt']


@pytest.mark.parametrize('kind', ['missing', 'incomplete', 'no-retention'])
def test_unavailable_media_does_not_block_typed_answers(api, kind):
    client, db, _, root = api
    if kind == 'missing': (root / f'{SID}.webm').unlink()
    elif kind == 'incomplete': (root / f'{SID}.webm').write_bytes(b'incomplete')
    else: db.videos[SID]['expires_at'] = None
    files = read_zip(client.get(BASE))
    assert not any(name.endswith('.webm') for name in files)
    assert f'attempts/{SID}/typed-answers.txt' in files


def test_student_without_recording_still_gets_answers_and_grades(api):
    client, db, _, _ = api
    db.sessions[SID]['record_examination'] = False
    db.videos.clear()
    db.grades.clear()
    files = read_zip(client.get(BASE))
    assert len(files) == 4
    assert b'No grades have been saved.' in files[f'attempts/{SID}/grades.txt']


@pytest.mark.parametrize('route', [BASE, BULK])
def test_another_professor_cannot_download_student_files(api, route):
    client, db, app, _ = api
    app.dependency_overrides[require_professor] = lambda: {'role': 'professor', 'professor_id': OTHER}
    assert client.get(route).status_code == 404
    assert len(db.calls) == 1


@pytest.mark.parametrize('route', [BASE, BULK])
def test_anonymous_downloads_are_rejected_before_reading_records(api, route):
    client, db, app, _ = api
    app.dependency_overrides.pop(require_professor)
    assert client.get(route).status_code == 401
    assert db.calls == []


@pytest.mark.parametrize('route', [BASE, BULK])
def test_student_account_cannot_use_professor_downloads(api, route):
    client, db, app, _ = api
    app.dependency_overrides.pop(require_professor)
    app.dependency_overrides[get_current_account] = lambda: {'role': 'student', 'id': STUDENT}
    assert client.get(route).status_code == 403
    assert db.calls == []


def test_in_progress_and_demo_attempts_are_not_exportable(api):
    client, db, _, _ = api
    db.sessions[SID]['status'] = 'in_progress'
    assert client.get(BASE).status_code == 409
    assert client.get(BULK).status_code == 409
    db.sessions[SID].update(status='pending_grading', developer_demo=True)
    assert client.get(BASE).status_code == 404
    assert client.get(BULK).status_code == 409


def test_bulk_export_uses_separate_folders_and_excludes_unsubmitted_attempts(api):
    client, db, _, _ = api
    db.sessions[OTHER_SID] = {**db.sessions[SID], 'id': OTHER_SID, 'record_examination': False}
    files = read_zip(client.get(BULK))
    assert f'attempts/{SID}/recording.webm' in files
    assert f'attempts/{OTHER_SID}/typed-answers.txt' in files
    db.sessions[OTHER_SID]['status'] = 'in_progress'
    files = read_zip(client.get(BULK))
    assert not any(OTHER_SID in name for name in files)


def test_bulk_text_and_attempt_limits_fail_before_streaming(api, monkeypatch):
    client, _, _, _ = api
    monkeypatch.setattr(downloads, 'MAX_TEXT_BYTES', 8)
    assert client.get(BASE).status_code == 413
    monkeypatch.setattr(downloads, 'MAX_ATTEMPTS', 0)
    assert client.get(BULK).status_code == 413


def test_late_file_change_and_expiry_omit_private_artifacts(api):
    _, db, _, root = api
    entries = downloads._prepare_attempt(db, UUID(SID), {'professor_id': OWNER}, [0])
    for entry in entries:
        if entry.expires_at:
            entry.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    with ZipFile(BytesIO(b''.join(downloads.stream_zip(entries)))) as archive:
        assert not any(name.endswith(('.webm', '/speech-transcript.txt')) for name in archive.namelist())
        assert any(name.endswith('recording-unavailable.txt') for name in archive.namelist())
    entries = downloads._prepare_attempt(db, UUID(SID), {'professor_id': OWNER}, [0])
    (root / f'{SID}.webm').write_bytes(b'a different file with the same original length'.ljust(len(MEDIA), b'!'))
    with ZipFile(BytesIO(b''.join(downloads.stream_zip(entries)))) as archive:
        assert not any(name.endswith('.webm') for name in archive.namelist())


def test_streamed_video_uses_bounded_chunks_and_no_full_archive_tempfile(api, monkeypatch):
    client, db, _, root = api
    monkeypatch.setattr(downloads, 'CHUNK_BYTES', 4096)
    data = MEDIA + b'x' * 16000
    (root / f'{SID}.webm').write_bytes(data)
    db.videos[SID]['total_bytes'] = len(data)
    entries = downloads._prepare_attempt(db, UUID(SID), {'professor_id': OWNER}, [0])
    chunks = list(downloads.stream_zip(entries))
    assert max(map(len, chunks)) <= 4096
    with ZipFile(BytesIO(b''.join(chunks))) as archive:
        assert archive.read(f'attempts/{SID}/recording.webm') == data


def test_cancelled_stream_closes_the_open_recording_handle(api, monkeypatch):
    _, db, _, _ = api
    entries = downloads._prepare_attempt(db, UUID(SID), {'professor_id': OWNER}, [0])
    opened = []
    original_open = downloads.video._private_open
    def tracking_open(*args):
        source = original_open(*args)
        opened.append(source)
        return source
    monkeypatch.setattr(downloads.video, '_private_open', tracking_open)
    stream = downloads.stream_zip([entry for entry in entries if entry.path is not None])
    next(stream)
    assert opened and not opened[-1].closed
    stream.close()
    assert all(source.closed for source in opened)


def test_bulk_attempt_must_still_belong_to_the_requested_exam(api):
    _, db, _, _ = api
    db.sessions[SID]['exam_template_id'] = OTHER
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as error:
        downloads._prepare_attempt(db, UUID(SID), {'professor_id': OWNER}, [0], UUID(EXAM))
    assert error.value.status_code == 404
