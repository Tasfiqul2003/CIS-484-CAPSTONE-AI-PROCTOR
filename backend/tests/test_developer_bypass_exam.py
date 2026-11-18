"""Synthetic admission integration; no real identity, provider, device or DB."""
import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import Session

from backend.app import exam, developer_face_bypass
from backend.tests.test_developer_demo import StartDB, prepare_start, STUDENT, EXAM


def request():
    return exam.StartRequest(student_id=STUDENT, exam_template_id=EXAM, student_token='synthetic')


def no_match(*_):
    raise HTTPException(403, 'Complete the student photo check before starting this exam.')


def test_developer_admission_keeps_full_recording_and_records_unverified_identity(monkeypatch, tmp_path):
    prepare_start(monkeypatch)
    monkeypatch.setenv('DEVELOPER_DEMO_MODE', '0')
    monkeypatch.setattr(exam, '_require_recent_face_check', no_match)
    marker = object()
    monkeypatch.setattr(developer_face_bypass, 'authorized_bypass', lambda db, student, http:
        {'status': 'developer_bypass', 'attempt_count': 2} if student == STUDENT and http is marker else None)
    preflight = []
    monkeypatch.setattr(exam, '_retention_deadline', lambda: preflight.append('retention'))
    monkeypatch.setattr(exam, '_recording_root', lambda **kwargs: preflight.append('storage'))
    db = StartDB()
    exam.start_exam(request(), db=db, http_request=marker)
    assert db.committed and preflight == ['retention', 'storage']
    assert db.insert_params['identity_check_completed'] is False
    assert db.insert_params['identity_review_required'] is True
    assert db.insert_params['identity_verification_attempts'] == 2
    assert db.insert_params['developer_demo'] is False


def test_developer_grant_cannot_skip_roster_check(monkeypatch):
    prepare_start(monkeypatch)
    monkeypatch.setattr(developer_face_bypass, 'authorized_bypass', lambda *_: pytest.fail('Roster must precede bypass'))
    db = StartDB(rostered=False)
    with pytest.raises(HTTPException) as error:
        exam.start_exam(request(), db=db)
    assert error.value.status_code == 403 and db.insert_params is None


def test_missing_or_revoked_grant_cannot_replace_a_match(monkeypatch):
    prepare_start(monkeypatch)
    monkeypatch.setattr(exam, '_require_recent_face_check', no_match)
    monkeypatch.setattr(developer_face_bypass, 'authorized_bypass', lambda *_: None)
    db = StartDB()
    with pytest.raises(HTTPException) as error:
        exam.start_exam(request(), db=db)
    assert error.value.status_code == 403 and db.insert_params is None


def test_real_match_takes_precedence_over_old_developer_grant(monkeypatch):
    prepare_start(monkeypatch)
    monkeypatch.setattr(developer_face_bypass, 'authorized_bypass', lambda *_: pytest.fail('A genuine match takes precedence'))
    assert exam._require_face_authorization(StartDB(), STUDENT)['status'] == 'matched'


def test_completed_unverified_attempt_is_flagged_instead_of_ordinary_pending_grading():
    engine = create_engine('sqlite://')
    @event.listens_for(engine, 'before_cursor_execute', retval=True)
    def dialect(_connection, _cursor, statement, parameters, _context, _many):
        return statement.replace('CAST(? AS uuid)', '?').replace('now()', 'CURRENT_TIMESTAMP'), parameters
    with engine.begin() as db:
        db.execute(text('CREATE TABLE exam_sessions(id TEXT PRIMARY KEY,status TEXT,identity_review_required BOOLEAN,ended_at TEXT)'))
        db.execute(text('CREATE TABLE integrity_events(session_id TEXT,severity INTEGER)'))
        db.execute(text("INSERT INTO exam_sessions VALUES ('verified','in_progress',0,NULL),('bypassed','in_progress',1,NULL)"))
    with Session(engine) as db:
        exam.end_session(db, 'verified'); exam.end_session(db, 'bypassed'); db.commit()
        rows=dict(db.execute(text('SELECT id,status FROM exam_sessions')).all())
        assert rows == {'verified': 'pending_grading', 'bypassed': 'flagged'}
    engine.dispose()
