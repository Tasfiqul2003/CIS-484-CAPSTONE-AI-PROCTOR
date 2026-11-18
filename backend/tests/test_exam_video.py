"""Synthetic HTTP/storage regression tests; never connects to a live database."""
import copy
import os
from datetime import datetime, timedelta, timezone
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app import exam_video as video
from backend.app.auth import require_professor
from backend.app.db import get_db
from backend.app.student_auth import issue_student_token

SID = '20000000-0000-4000-8000-000000000001'
STUDENT = '30000000-0000-4000-8000-000000000001'
EXAM = '40000000-0000-4000-8000-000000000001'
OWNER = '50000000-0000-4000-8000-000000000001'
BASE = f'/exam/sessions/{SID}/video-recording'
WEBM = b'\x1a\x45\xdf\xa3synthetic-container'


class Result:
    def __init__(self, row=None, rows=()):
        self.row, self.rows = row, rows
    def mappings(self): return self
    def first(self): return self.row
    def all(self): return self.rows


class RecordingDB:
    def __init__(self):
        self.session = dict(id=SID, student_id=STUDENT, exam_template_id=EXAM,
            status='in_progress', developer_demo=False, record_examination=True,
            generate_transcript=True, recording_consent_status='consented', exam_professor_id=OWNER)
        self.video = None
        self.notifications = set()
        self.backup = None
        self.fail_commit = False
        self.rollbacks = 0

    def execute(self, statement, params=None):
        sql = ' '.join(str(statement).lower().split())
        p = params or {}
        if self.backup is None: self.backup = (copy.deepcopy(self.video), set(self.notifications))
        if 'from exam_sessions' in sql and sql.startswith('select'):
            return Result(dict(self.session))
        if 'select * from exam_session_videos' in sql:
            return Result(copy.deepcopy(self.video))
        if 'insert into recording_consent_notifications' in sql:
            self.notifications.add('recording_failed'); return Result()
        if 'insert into exam_session_videos' in sql:
            if self.video is None:
                self.video = dict(status=p.get('status', 'recording'), content_type=p.get('content_type'),
                    expires_at=p.get('expires_at'), failure_reason=p.get('reason'),
                    next_chunk_index=0, total_bytes=0, updated_at=datetime.now(timezone.utc),
                    transcript_status=p['transcript_status'], generated_transcript=None)
            elif self.video['status'] == 'recording':
                self.video.update(status=p['status'], failure_reason=p['reason'], transcript_status=p['transcript_status'])
            return Result()
        if 'set next_chunk_index = next_chunk_index + 1' in sql:
            self.video['next_chunk_index'] += 1
            self.video['total_bytes'] += p['chunk_bytes']
            self.video['updated_at'] = datetime.now(timezone.utc)
            return Result()
        if "set status = 'completed'" in sql:
            self.video.update(status='completed', transcript_status=p['transcript_status']); return Result()
        raise AssertionError(sql)

    def commit(self):
        if self.fail_commit:
            self.fail_commit = False
            raise RuntimeError('synthetic commit failure')
        self.backup = None

    def rollback(self):
        self.rollbacks += 1
        if self.backup is not None: self.video, self.notifications = self.backup
        self.backup = None


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setenv('AUTH_SECRET_KEY', 'synthetic-recording-test-secret-01234567890123456789')
    monkeypatch.setenv('EXAM_VIDEO_DIR', str(tmp_path / 'private'))
    monkeypatch.setenv('EXAM_VIDEO_RETENTION_UNTIL', (datetime.now(timezone.utc) + timedelta(days=2)).isoformat())
    db = RecordingDB()
    app = FastAPI()
    app.include_router(video.router)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[require_professor] = lambda: {'role': 'professor', 'professor_id': OWNER}
    client = TestClient(app, raise_server_exceptions=False)
    token = issue_student_token(student_id=STUDENT, exam_template_id=EXAM, session_id=SID, purpose='student_session')
    client.headers['Authorization'] = f'Bearer {token}'
    return client, db, app, tmp_path / 'private'


def start(client):
    response = client.post(BASE + '/start', json={'content_type': 'video/webm;codecs=vp8,opus'})
    assert response.status_code == 200, response.text


def chunk(client, index=0, data=WEBM):
    return client.put(BASE + f'/chunks/{index}', content=data)


def test_preflight_success_and_missing_retention(api, monkeypatch):
    client, _, _, _ = api
    assert client.post(BASE + '/preflight').json()['ready']
    monkeypatch.delenv('EXAM_VIDEO_RETENTION_UNTIL')
    assert client.post(BASE + '/preflight').json()['ready'] is False


@pytest.mark.parametrize('field,value', [('record_examination', False), ('recording_consent_status', 'pending'),
    ('recording_consent_status', 'declined'), ('developer_demo', True)])
def test_start_requires_snapshot_consent_and_non_demo(api, field, value):
    client, db, _, _ = api
    db.session[field] = value
    assert client.post(BASE + '/start', json={'content_type': 'video/webm'}).status_code == 409
    assert db.video is None


@pytest.mark.parametrize('part', ['sub', 'session_id', 'exam_template_id'])
def test_wrong_student_session_and_template_tokens(api, part):
    client, _, _, _ = api
    args = dict(student_id=STUDENT, session_id=SID, exam_template_id=EXAM, purpose='student_session')
    args[{'sub': 'student_id'}.get(part, part)] = OWNER
    client.headers['Authorization'] = 'Bearer ' + issue_student_token(**args)
    assert client.get(BASE).status_code == 403


def test_missing_and_invalid_tokens(api):
    client, _, _, _ = api
    client.headers.pop('Authorization')
    assert client.get(BASE).status_code == 401
    client.headers['Authorization'] = 'Bearer invalid'
    assert client.get(BASE).status_code == 401


def test_sequential_chunks_retries_conflicts_and_limits(api, monkeypatch):
    client, db, _, _ = api
    start(client)
    assert chunk(client, 1).status_code == 409
    assert chunk(client).status_code == 200
    assert chunk(client).json()['duplicate'] is True
    assert chunk(client, data=WEBM + b'changed').status_code == 409
    assert db.video['next_chunk_index'] == 1
    monkeypatch.setattr(video, 'MAX_CHUNK_BYTES', 4)
    assert chunk(client, 1, b'large').status_code == 413
    monkeypatch.setattr(video, 'MAX_CHUNK_BYTES', 100)
    monkeypatch.setattr(video, 'MAX_RECORDING_BYTES', len(WEBM))
    assert chunk(client, 1, b'x').status_code == 413


def test_completion_after_submission_and_authenticated_range_playback(api):
    client, db, app, root = api
    start(client)
    assert chunk(client).status_code == 200
    assert chunk(client, 1, b'last').status_code == 200
    db.session['status'] = 'pending_grading'
    response = client.post(BASE + '/complete', json={'expected_chunk_count': 2})
    assert response.status_code == 200
    assert db.video['transcript_status'] == 'queued'
    assert (root / f'{SID}.webm').read_bytes() == WEBM + b'last'
    assert not (root / SID).exists()
    assert client.post(BASE + '/complete', json={'expected_chunk_count': 2}).status_code == 200
    response = client.get(f'/exam/sessions/{SID}/video')
    assert response.content == WEBM + b'last'
    assert response.headers['cache-control'] == 'private, no-store'
    assert client.get(f'/exam/sessions/{SID}/video', headers={'Range': 'bytes=2-5'}).content == WEBM[2:6]
    assert client.get(f'/exam/sessions/{SID}/video', headers={'Range': 'bytes=-4'}).content == b'last'
    assert client.get(f'/exam/sessions/{SID}/video', headers={'Range': 'bytes=999-'}).status_code == 416
    app.dependency_overrides[require_professor] = lambda: {'professor_id': STUDENT}
    assert client.get(f'/exam/sessions/{SID}/video').status_code == 404
    assert client.get(f'/exam/sessions/{SID}/recording-review').status_code == 404


def test_no_second_recording_and_incomplete_assembly(api):
    client, db, _, _ = api
    start(client)
    assert client.post(BASE + '/start', json={'content_type': 'video/webm'}).status_code == 409
    assert chunk(client).status_code == 200
    assert client.post(BASE + '/complete', json={'expected_chunk_count': 2}).status_code == 409
    assert db.video['status'] == 'recording'


@pytest.mark.parametrize('status', list(video.FAILURES))
def test_failures_persist_notify_and_never_end_exam(api, status):
    client, db, _, _ = api
    start(client)
    chunk(client)
    assert client.post(BASE + '/failure', json={'status': status}).status_code == 200
    assert db.video['status'] == status
    assert db.video['next_chunk_index'] == 1
    assert db.notifications == {'recording_failed'}
    assert db.session['status'] == 'in_progress'
    client.post(BASE + '/failure', json={'status': 'interrupted'})
    assert db.video['status'] == status


def test_permission_failure_before_initialization(api):
    client, db, _, _ = api
    assert client.post(BASE + '/failure', json={'status': 'permission_denied'}).status_code == 200
    assert db.video['status'] == 'permission_denied'
    assert client.post(BASE + '/start', json={'content_type': 'video/webm'}).status_code == 409


@pytest.mark.parametrize('method,path,body', [
    ('get', '', None), ('post', '/preflight', None),
    ('post', '/start', {'content_type': 'video/webm'}),
    ('post', '/failure', {'status': 'permission_denied'}),
    ('post', '/complete', {'expected_chunk_count': 1}),
])
def test_demo_is_rejected_by_each_student_route(api, method, path, body):
    client, db, _, _ = api
    db.session['developer_demo'] = True
    assert client.request(method, BASE + path, json=body).status_code == 409


def test_demo_upload_and_professor_status_are_rejected(api):
    client, db, _, _ = api
    db.session['developer_demo'] = True
    assert chunk(client).status_code == 409
    assert client.get(f'/exam/sessions/{SID}/recording-review').status_code == 404


def test_transcript_flag_remains_independent(api):
    client, db, _, _ = api
    db.session['generate_transcript'] = False
    start(client); chunk(client)
    assert client.post(BASE + '/complete', json={'expected_chunk_count': 1}).status_code == 200
    assert db.video['transcript_status'] == 'not_requested'
    assert db.video['generated_transcript'] is None


def test_anonymous_professor_cannot_read_media(api):
    client, _, app, _ = api
    app.dependency_overrides.pop(require_professor)
    assert client.get(f'/exam/sessions/{SID}/video').status_code == 401
    assert client.get(f'/exam/sessions/{SID}/recording-review').status_code == 401


def test_expired_unsubmitted_and_demo_playback_rejected(api):
    client, db, _, _ = api
    start(client); chunk(client)
    client.post(BASE + '/complete', json={'expected_chunk_count': 1})
    assert client.get(f'/exam/sessions/{SID}/video').status_code == 409
    db.session['status'] = 'graded'
    db.video['expires_at'] = datetime.now(timezone.utc) - timedelta(seconds=1)
    assert client.get(f'/exam/sessions/{SID}/video').status_code == 410
    assert client.get(f'/exam/sessions/{SID}/recording-review').json()['status'] == 'expired'
    db.session['developer_demo'] = True
    assert client.get(f'/exam/sessions/{SID}/video').status_code == 404


def test_disk_failure_preserves_uploaded_chunks(api, monkeypatch):
    client, db, _, root = api
    start(client); chunk(client)
    monkeypatch.setattr(video.shutil, 'disk_usage', lambda _: type('Disk', (), {'free': 0})())
    assert chunk(client, 1, b'last').status_code == 507
    assert db.video['status'] == 'upload_failed'
    assert (root / SID / 'chunks' / '00000000.chunk').read_bytes() == WEBM


def test_failed_commit_is_retryable_without_duplicate_bytes(api):
    client, db, _, _ = api
    start(client)
    db.fail_commit = True
    assert chunk(client).status_code == 500
    assert db.rollbacks == 1
    assert db.video['next_chunk_index'] == 0
    assert chunk(client).status_code == 200
    assert db.video['total_bytes'] == len(WEBM)


def test_failed_completion_commit_keeps_recovery_chunks_until_successful_retry(api):
    client, db, _, root = api
    start(client); chunk(client)
    db.fail_commit = True
    assert client.post(BASE + '/complete', json={'expected_chunk_count': 1}).status_code == 500
    assert db.video['status'] == 'recording'
    assert (root / SID / 'chunks' / '00000000.chunk').read_bytes() == WEBM
    assert (root / f'{SID}.webm').read_bytes() == WEBM
    assert client.post(BASE + '/complete', json={'expected_chunk_count': 1}).status_code == 200
    assert not (root / SID).exists()
    assert (root / f'{SID}.webm').read_bytes() == WEBM


def test_duplicate_chunk_cleanup_failure_does_not_lose_completed_recording(api, monkeypatch):
    from pathlib import Path
    client, db, _, root = api
    start(client); chunk(client)
    unlink = Path.unlink
    def fail_chunk_cleanup(path, *args, **kwargs):
        if path.suffix == '.chunk':
            raise PermissionError('synthetic cleanup failure')
        return unlink(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'unlink', fail_chunk_cleanup)
    assert client.post(BASE + '/complete', json={'expected_chunk_count': 1}).status_code == 200
    assert db.video['status'] == 'completed'
    assert (root / f'{SID}.webm').read_bytes() == WEBM
    assert (root / SID / 'chunks' / '00000000.chunk').read_bytes() == WEBM


def test_directory_sync_failure_preserves_recovery_chunks(api, monkeypatch):
    client, db, _, root = api
    start(client); chunk(client)
    def fail_sync(_):
        raise OSError('synthetic directory sync failure')
    monkeypatch.setattr(video, '_sync_directory', fail_sync)
    assert client.post(BASE + '/complete', json={'expected_chunk_count': 1}).status_code == 507
    assert db.video['status'] == 'upload_failed'
    assert (root / SID / 'chunks' / '00000000.chunk').read_bytes() == WEBM


def test_hardlinked_chunk_and_path_traversal_rejected(api, tmp_path):
    client, db, _, root = api
    start(client)
    outside = tmp_path / 'unrelated'
    outside.write_bytes(WEBM)
    try:
        os.link(outside, root / SID / 'chunks' / '00000000.chunk')
    except PermissionError:
        pytest.skip('Host does not permit creating synthetic hardlinks.')
    assert chunk(client).status_code == 507
    assert outside.read_bytes() == WEBM
    assert client.post('/exam/sessions/not-a-uuid/video-recording/start', json={'content_type': 'video/webm'}).status_code == 422


def test_multilink_file_metadata_is_rejected_without_reading(api, monkeypatch, tmp_path):
    from types import SimpleNamespace
    target = tmp_path / 'synthetic-media'
    target.write_bytes(WEBM)
    original_fstat = os.fstat
    monkeypatch.setattr(video.os, 'fstat', lambda fd: SimpleNamespace(
        st_mode=original_fstat(fd).st_mode, st_nlink=2))
    with pytest.raises(OSError):
        video._private_open(target, os.O_RDONLY)
    assert target.read_bytes() == WEBM


def test_path_traversal_identifier_is_rejected(api):
    client, _, _, _ = api
    assert client.post('/exam/sessions/not-a-uuid/video-recording/start', json={'content_type': 'video/webm'}).status_code == 422


def test_symlink_root_rejected(api, tmp_path, monkeypatch):
    client, _, _, _ = api
    actual = tmp_path / 'actual'; actual.mkdir()
    link = tmp_path / 'link'
    try: link.symlink_to(actual, target_is_directory=True)
    except OSError: pytest.skip('Host does not permit creating synthetic symlinks.')
    monkeypatch.setenv('EXAM_VIDEO_DIR', str(link))
    assert client.post(BASE + '/preflight').json()['ready'] is False


def test_stale_recording_is_reported_and_notified(api):
    client, db, _, _ = api
    start(client)
    db.video['updated_at'] -= timedelta(minutes=3)
    assert client.get(f'/exam/sessions/{SID}/recording-review').json()['status'] == 'interrupted'
    assert 'recording_failed' in db.notifications


def test_cleanup_preserves_unrelated_files_and_only_targets_media(api, tmp_path):
    from backend.app.purge_exam_videos import _remove_recording_files as _remove_media
    _, _, _, root = api
    directory = video._chunks(video._recording_root(), UUID(SID))
    (directory / '00000000.chunk').write_bytes(WEBM)
    (root / f'{SID}.webm').write_bytes(WEBM)
    unrelated = root / 'keep.txt'; unrelated.write_text('keep')
    _remove_media(root, UUID(SID))
    assert unrelated.read_text() == 'keep'
    assert not directory.parent.exists()
    assert not (root / f'{SID}.webm').exists()


def completed_transcript(api):
    client, db, _, _ = api
    start(client); chunk(client)
    client.post(BASE + '/complete', json={'expected_chunk_count': 1})
    db.session['status'] = 'graded'
    db.video.update(transcript_status='completed', generated_transcript='[00:00:01] Synthetic speech.')
    return client, db


def test_owner_can_download_generated_speech_separately_from_typed_answers(api):
    client, _ = completed_transcript(api)
    result = client.get(f'/exam/sessions/{SID}/speech-transcript')
    assert result.status_code == 200
    assert result.text == '[00:00:01] Synthetic speech.'
    assert result.headers['cache-control'] == 'private, no-store'
    assert 'attachment;' in result.headers['content-disposition']
    assert client.get(BASE).json().get('generated_transcript') is None


def test_transcript_download_rejects_other_professor_and_anonymous(api):
    client, _ = completed_transcript(api)
    app = api[2]
    app.dependency_overrides[require_professor] = lambda: {'professor_id': STUDENT}
    assert client.get(f'/exam/sessions/{SID}/speech-transcript').status_code == 404
    app.dependency_overrides.pop(require_professor)
    assert client.get(f'/exam/sessions/{SID}/speech-transcript').status_code == 401


@pytest.mark.parametrize('state', ['queued', 'processing', 'failed', 'not_requested'])
def test_unready_transcripts_cannot_be_downloaded(api, state):
    client, db = completed_transcript(api)
    db.video['transcript_status'] = state
    assert client.get(f'/exam/sessions/{SID}/speech-transcript').status_code == 409


def test_transcript_expiry_hides_text_and_refuses_download_even_before_purge(api):
    client, db = completed_transcript(api)
    db.video['expires_at'] = datetime.now(timezone.utc) - timedelta(seconds=1)
    assert client.get(f'/exam/sessions/{SID}/speech-transcript').status_code == 410
    assert client.get(f'/exam/sessions/{SID}/recording-review').json()['generated_transcript'] is None


@pytest.mark.parametrize('field,value', [('developer_demo', True), ('status', 'in_progress')])
def test_demo_or_unsubmitted_transcript_is_not_downloadable(api, field, value):
    client, db = completed_transcript(api)
    db.session[field] = value
    assert client.get(f'/exam/sessions/{SID}/speech-transcript').status_code in (404, 409)


def test_silence_is_a_valid_empty_transcript_download(api):
    client, db = completed_transcript(api)
    db.video['generated_transcript'] = ''
    assert client.get(f'/exam/sessions/{SID}/speech-transcript').status_code == 200
    assert client.get(f'/exam/sessions/{SID}/speech-transcript').text == ''
