"""Synthetic temporary photo-check admission tests; no real photos or services."""
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
import pytest

from backend.app import exam, photo_test_access as policy
from backend.tests.test_developer_demo import StartDB, Result, STUDENT, EXAM, prepare_start, start_attempt
from backend.tests.test_student_roster_access import FakeDB as RosterDB

NOW = datetime(2026, 11, 18, 12, tzinfo=timezone.utc)


class Clock(datetime):
    current = NOW

    @classmethod
    def now(cls, tz=None):
        return cls.current if tz is not None else cls.current.replace(tzinfo=None)


@pytest.fixture(autouse=True)
def isolated_policy(monkeypatch):
    monkeypatch.delenv(policy.EID_KEY, raising=False)
    monkeypatch.delenv(policy.UNTIL_KEY, raising=False)
    monkeypatch.setattr(policy, 'datetime', Clock)
    monkeypatch.setattr(Clock, 'current', NOW)


def enable(monkeypatch, eid='synthetic1'):
    monkeypatch.setenv(policy.EID_KEY, eid)
    monkeypatch.setenv(policy.UNTIL_KEY, (NOW + timedelta(hours=2)).isoformat())


def test_default_off_and_single_normalized_eid(monkeypatch):
    assert policy.photo_test_policy() is None
    assert not policy.photo_test_access('synthetic1')
    enable(monkeypatch, '  SYNTHETIC1  ')
    assert policy.photo_test_access('synthetic1')
    assert policy.photo_test_access(' SYNTHETIC1 ')
    assert not policy.photo_test_access('synthetic2')


@pytest.mark.parametrize('until', ['', 'bad', '2000-01-01T00:00:00Z',
                                  '2026-11-18T14:00:00', '2026-11-18',
                                  '2026-11-20T12:00:00Z'])
def test_missing_invalid_expired_or_overlong_window_fails_closed(monkeypatch, until):
    enable(monkeypatch)
    monkeypatch.setenv(policy.UNTIL_KEY, until)
    assert not policy.photo_test_access('synthetic1')


@pytest.mark.parametrize('eid', ['', '*', 'one,two', 'one two', 'x' * 65])
def test_wildcards_lists_and_invalid_eids_cannot_enable_access(monkeypatch, eid):
    enable(monkeypatch, eid)
    assert policy.photo_test_policy() is None


def test_expiry_is_checked_again_without_restarting_backend(monkeypatch):
    enable(monkeypatch)
    assert policy.photo_test_access('synthetic1')
    monkeypatch.setattr(Clock, 'current', NOW + timedelta(hours=2))
    assert not policy.photo_test_access('synthetic1')


class TestStartDB(StartDB):
    __test__ = False

    def __init__(self, *, eid='synthetic1', rostered=True):
        super().__init__(rostered=rostered)
        self.eid = eid
        self.queries = []

    def execute(self, statement, params=None):
        sql = str(statement)
        self.queries.append(sql)
        if 'SELECT eid FROM students' in sql:
            return Result({'eid': self.eid})
        if 'FROM student_face_verifications' in sql:
            return Result({'status': 'no_match', 'attempt_count': 3})
        return super().execute(statement, params)


def test_exception_does_not_create_a_match_or_modify_prior_attempts(monkeypatch):
    enable(monkeypatch)
    db = TestStartDB()
    assert exam._require_recent_face_check(db, STUDENT) == {'status': 'test_bypass', 'attempt_count': 0}
    assert all(sql.strip().startswith('SELECT') for sql in db.queries)
    assert not db.committed


def test_other_student_still_needs_a_real_match(monkeypatch):
    enable(monkeypatch)
    db = TestStartDB(eid='other-student')
    with pytest.raises(HTTPException) as error:
        exam._require_recent_face_check(db, STUDENT)
    assert error.value.status_code == 403 and not db.committed


def test_new_test_attempt_is_unverified_and_keeps_recording_consent(monkeypatch):
    enable(monkeypatch)
    monkeypatch.delenv('DEVELOPER_DEMO_MODE', raising=False)
    prepare_start(monkeypatch)
    db = TestStartDB()
    start_attempt(db)
    assert db.committed
    assert db.insert_params['identity_check_completed'] is False
    assert db.insert_params['identity_review_required'] is True
    assert db.insert_params['identity_verification_attempts'] == 0
    assert db.insert_params['developer_demo'] is False
    insertion = next(sql for sql in db.queries if 'INSERT INTO exam_sessions' in sql)
    assert "WHEN t.record_examination THEN 'pending'" in insertion
    assert ':identity_check_completed' in insertion
    assert not any('UPDATE' in sql or 'INSERT INTO student_face_verifications' in sql for sql in db.queries)


def test_enabled_exception_cannot_skip_published_roster_authorization(monkeypatch):
    enable(monkeypatch)
    prepare_start(monkeypatch)
    db = TestStartDB(rostered=False)
    with pytest.raises(HTTPException) as error:
        start_attempt(db)
    assert error.value.status_code == 403
    assert db.insert_params is None and not db.committed


def test_expired_exception_cannot_start_using_an_earlier_student_token(monkeypatch):
    enable(monkeypatch)
    prepare_start(monkeypatch)
    monkeypatch.setattr(Clock, 'current', NOW + timedelta(hours=2))
    db = TestStartDB()
    with pytest.raises(HTTPException) as error:
        start_attempt(db)
    assert error.value.status_code == 403 and db.insert_params is None


def test_lookup_advertises_exception_only_for_configured_student(monkeypatch):
    db = RosterDB('available_exams')
    req = exam.StudentAvailableExamsRequest(eid='testeid')
    assert exam.get_student_available_exams(req, db)['photo_test_access'] is False
    enable(monkeypatch, 'testeid')
    assert exam.get_student_available_exams(req, db)['photo_test_access'] is True
    enable(monkeypatch, 'other-student')
    assert exam.get_student_available_exams(req, db)['photo_test_access'] is False
    assert not db.committed
