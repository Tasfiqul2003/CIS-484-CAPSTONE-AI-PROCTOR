"""Synthetic question timing checks; no application database, model or media."""

from datetime import datetime, timedelta, timezone
import json
from uuid import UUID

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend.app import exam, stream
from backend.app.auth import get_current_account
from backend.app.db import get_db
from backend.app.time_settings import router


STUDENT = "10000000-0000-4000-8000-000000000001"
EXAM = "20000000-0000-4000-8000-000000000001"
SESSION = "30000000-0000-4000-8000-000000000001"
BANK = "40000000-0000-4000-8000-000000000001"
CLAIMS = {"sub": STUDENT, "exam_template_id": EXAM, "session_id": SESSION}
NOW = datetime(2026, 1, 1, 0, 5, tzinfo=timezone.utc)
URL = f"/exam/templates/{EXAM}/time-settings"


@pytest.fixture
def settings_api():
    engine = create_engine("sqlite://", poolclass=StaticPool,
                           connect_args={"check_same_thread": False})
    with engine.begin() as db:
        db.execute(text("""CREATE TABLE exam_templates (id TEXT PRIMARY KEY,
            professor_id TEXT, time_limit_minutes INTEGER,
            question_time_limit_minutes INTEGER)"""))
        db.execute(text("INSERT INTO exam_templates VALUES (:id, 'owner', 30, NULL)"), {"id": EXAM})
    sessions = sessionmaker(bind=engine)
    app = FastAPI()
    app.include_router(router)

    def isolated_db():
        with sessions() as db:
            yield db

    app.dependency_overrides[get_db] = isolated_db
    app.dependency_overrides[get_current_account] = lambda: {
        "role": "professor", "professor_id": "owner"}
    with TestClient(app) as client:
        yield client, app
    engine.dispose()


def test_professor_can_enable_update_and_disable_question_limit(settings_api):
    client, _ = settings_api
    assert client.get(URL).json()["question_time_limit_minutes"] is None
    for minutes in (1, 5, 240):
        response = client.put(URL, json={"time_limit_minutes": 30,
                                        "question_time_limit_minutes": minutes})
        assert response.status_code == 200
        assert client.get(URL).json() == {
            "time_limit_minutes": 30, "question_time_limit_minutes": minutes}
    assert client.put(URL, json={"time_limit_minutes": 45}).json() == {
        "time_limit_minutes": 45, "question_time_limit_minutes": 240}
    assert client.put(URL, json={"time_limit_minutes": 45,
                                 "question_time_limit_minutes": None}).json() == {
        "time_limit_minutes": 45, "question_time_limit_minutes": None}


@pytest.mark.parametrize("value", [0, -1, 241, 1.5, True, "5", [], {}])
def test_invalid_question_limit_does_not_change_saved_settings(settings_api, value):
    client, _ = settings_api
    assert client.put(URL, json={"time_limit_minutes": 30,
                                 "question_time_limit_minutes": 5}).status_code == 200
    assert client.put(URL, json={"time_limit_minutes": 60,
                                 "question_time_limit_minutes": value}).status_code == 422
    assert client.get(URL).json() == {
        "time_limit_minutes": 30, "question_time_limit_minutes": 5}


def test_other_professor_cannot_change_question_limit(settings_api):
    client, app = settings_api
    app.dependency_overrides[get_current_account] = lambda: {
        "role": "professor", "professor_id": "other"}
    assert client.put(URL, json={"time_limit_minutes": 30,
                                 "question_time_limit_minutes": 5}).status_code == 404
    app.dependency_overrides[get_current_account] = lambda: {
        "role": "professor", "professor_id": "owner"}
    assert client.get(URL).json()["question_time_limit_minutes"] is None


@pytest.mark.parametrize("value", [0, -1, 1.5, True, "1"])
def test_question_sequence_must_be_a_positive_integer(value):
    with pytest.raises(ValidationError):
        exam.AnswerRequest(session_id=SESSION, answer_transcript="Synthetic answer",
                           question_sequence_num=value)


class Result:
    def __init__(self, row=None, rows=()):
        if isinstance(row, dict) and "student_id" in row and "status" in row:
            row = {"avatar_policy_snapshot": None, "avatar_policy_revision": 0, "avatar_exam_mode": "assessed", **row}
        self.row = row
        self.rows = list(rows)
        self.rowcount = 1

    def mappings(self):
        return self

    def first(self):
        return self.row

    def all(self):
        return self.rows


class TurnDB:
    """Records server decisions with synthetic pending and template records."""

    def __init__(self, *, question_limit=1, question_elapsed=1, exam_elapsed=5):
        self.question_limit = question_limit
        self.question_elapsed = question_elapsed
        self.exam_elapsed = exam_elapsed
        self.writes = []
        self.saved = None
        self.ended = False
        self.committed = False

    def execute(self, statement, params=None):
        sql = str(statement)
        params = dict(params or {})
        if "FROM exam_sessions s" in sql:
            return Result({"status": "in_progress", "student_id": STUDENT,
                           "exam_template_id": EXAM, "time_limit_minutes": 30,
                           "question_time_limit_minutes": self.question_limit,
                           "elapsed_min": self.exam_elapsed})
        if "student_answer_transcript IS NULL" in sql and "SELECT id" in sql:
            return Result({"id": "synthetic-pending", "sequence_num": 1,
                           "created_at": NOW - timedelta(minutes=self.question_elapsed),
                           "elapsed_min": self.question_elapsed})
        if "SELECT * FROM exam_templates" in sql:
            # Deliberately differs from the snapshotted question limit.
            return Result({"time_limit_minutes": 240, "question_time_limit_minutes": 240,
                           "topic_coverage_required": [], "difficulty_curve": "adaptive"})
        if "UPDATE interactions" in sql:
            self.saved = params
            self.writes.append(sql)
            return Result()
        if "UPDATE exam_sessions" in sql:
            self.ended = True
            self.writes.append(sql)
            return Result()
        if "INSERT INTO interactions" in sql:
            self.writes.append(sql)
            return Result()
        if "FROM questions" in sql:
            return Result(rows=[{"id": BANK, "question_text": "Next synthetic question",
                                 "topic": "synthetic", "difficulty": 1}])
        if "FROM interactions" in sql:
            return Result(rows=[{"sequence_num": 1, "question": "Synthetic question",
                                 "answer": self.saved["a"] if self.saved else None}])
        raise AssertionError(f"Unexpected synthetic turn query: {sql}")

    def commit(self):
        self.committed = True

    def close(self):
        pass


def prepare_turn(monkeypatch, db):
    monkeypatch.setattr(exam, "read_student_token", lambda *a, **k: CLAIMS)
    monkeypatch.setattr(exam, "load_exam_material_summaries", lambda *a: [])
    monkeypatch.setattr(stream, "load_exam_material_summaries", lambda *a: [])
    monkeypatch.setattr(stream, "open_session", lambda: db)
    monkeypatch.setattr(exam, "ask_model", lambda *a: {
        "bank_question_id": BANK, "reasoning": "Next synthetic question."})
    monkeypatch.setattr(stream, "decide", lambda *a: {
        "action": "bank", "bank_question_id": BANK, "reasoning": "Next synthetic question."})
    timing = {"session_id": SESSION, "status": "in_progress", "sequence_num": 2,
              "question": "Next synthetic question", "server_now": NOW.isoformat(),
              "deadline": (NOW + timedelta(minutes=25)).isoformat(),
              "question_deadline": (NOW + timedelta(minutes=1)).isoformat()}
    monkeypatch.setattr(exam, "read_session_state", lambda *a, **k: dict(timing))
    if hasattr(stream, "read_session_state"):
        monkeypatch.setattr(stream, "read_session_state", lambda *a, **k: dict(timing))
    return timing


@pytest.mark.parametrize("streaming", [False, True])
@pytest.mark.parametrize("question_limit,elapsed,expired", [(1, 0.999, False), (1, 1, True),
                                                           (1, 10, True), (None, 10, False)])
def test_question_timeout_uses_snapshot_and_discards_late_text(monkeypatch, streaming,
                                                              question_limit, elapsed, expired):
    db = TurnDB(question_limit=question_limit, question_elapsed=elapsed)
    timing = prepare_turn(monkeypatch, db)
    req = exam.AnswerRequest(session_id=SESSION, answer_transcript="Synthetic submitted text",
                             answer_timestamp_start=-5000, answer_timestamp_end=-4000,
                             question_sequence_num=1)
    if streaming:
        plan = stream.plan_turn(req, CLAIMS)
        assert plan["kind"] == "bank"
        assert db.saved is None  # Validation and planning do not write.
        events = list(stream.event_stream(plan))
        complete = next(event for event in events if event.startswith("event: complete"))
        result = json.loads(complete.split("data: ", 1)[1])
    else:
        result = exam.submit_answer(req, authorization="synthetic", db=db)
        assert result["done"] is False
    assert db.saved["a"] == (exam.QUESTION_TIMEOUT_ANSWER if expired else req.answer_transcript)
    assert db.saved["ts"] == (None if expired else -5000)
    assert db.saved["te"] == (None if expired else -4000)
    assert not db.ended
    assert db.committed
    for key in ("deadline", "question_deadline", "server_now"):
        assert result[key] == timing[key]


@pytest.mark.parametrize("streaming", [False, True])
def test_stale_question_submission_is_rejected_before_writes(monkeypatch, streaming):
    db = TurnDB()
    prepare_turn(monkeypatch, db)
    req = exam.AnswerRequest(session_id=SESSION, answer_transcript="Stale synthetic text",
                             question_sequence_num=2)
    with pytest.raises(HTTPException) as error:
        if streaming:
            stream.plan_turn(req, CLAIMS)
        else:
            exam.submit_answer(req, authorization="synthetic", db=db)
    assert error.value.status_code == 409
    assert db.writes == []


@pytest.mark.parametrize("streaming", [False, True])
def test_total_exam_timeout_ends_instead_of_advancing_question(monkeypatch, streaming):
    db = TurnDB(exam_elapsed=30)
    prepare_turn(monkeypatch, db)
    req = exam.AnswerRequest(session_id=SESSION, answer_transcript="Late synthetic text")
    if streaming:
        plan = stream.plan_turn(req, CLAIMS)
        assert plan["kind"] == "done"
        assert list(stream.event_stream(plan))[0].startswith("event: done")
    else:
        assert exam.submit_answer(req, authorization="synthetic", db=db)["done"] is True
    assert db.ended
    assert not any("INSERT INTO interactions" in sql for sql in db.writes)


@pytest.mark.parametrize("question_limit", [None, 1, 240])
def test_question_deadline_survives_resume_and_uses_server_saved_start(monkeypatch, question_limit):
    monkeypatch.setattr(exam, "read_student_token", lambda *a, **k: CLAIMS)
    question_started = NOW - timedelta(minutes=2)

    class ClockDB:
        def execute(self, statement, params):
            if "FROM exam_sessions" in str(statement):
                return Result({"student_id": STUDENT, "exam_template_id": EXAM,
                               "status": "in_progress", "started_at": NOW - timedelta(minutes=5),
                               "time_limit_minutes": 30, "question_time_limit_minutes": question_limit,
                               "server_now": NOW})
            return Result({"sequence_num": 3, "question_text": "Synthetic question",
                           "created_at": question_started})

    first = exam.get_session_state(UUID(SESSION), authorization="synthetic", db=ClockDB())
    assert first == exam.get_session_state(UUID(SESSION), authorization="synthetic", db=ClockDB())
    assert first["deadline"] == (NOW + timedelta(minutes=25)).isoformat()
    assert first["server_now"] == NOW.isoformat()
    expected = (question_started + timedelta(minutes=question_limit)).isoformat() if question_limit else None
    assert first["question_deadline"] == expected


def test_start_copies_question_limit_with_total_limit_and_uses_wall_clock_for_question(monkeypatch):
    """The fake verifies emitted SQL; it does not execute PostgreSQL migrations."""
    writes = []

    class StartDB:
        def execute(self, statement, params=None):
            sql = str(statement)
            if "SELECT * FROM exam_templates" in sql:
                return Result({"id": EXAM, "status": "published", "time_limit_minutes": 30,
                               "question_time_limit_minutes": 2})
            if "FROM students" in sql or "FROM exam_roster" in sql:
                return Result({"id": STUDENT})
            if "INSERT INTO exam_sessions" in sql:
                writes.append(sql)
                return Result({"id": SESSION, "time_limit_minutes": 30,
                               "extended_time_multiplier": 1})
            if "FROM questions" in sql:
                return Result({"id": BANK, "question_text": "Synthetic opening question"})
            if "INSERT INTO interactions" in sql:
                writes.append(sql)
                return Result()
            raise AssertionError(f"Unexpected synthetic start query: {sql}")

        def commit(self):
            pass

    monkeypatch.setattr(exam, "read_student_token", lambda *a, **k: CLAIMS)
    monkeypatch.setattr(exam, "issue_student_token", lambda **k: "synthetic-token")
    monkeypatch.setattr(exam, "snapshot_for_exam", lambda *a: (exam.session_policy({"avatar_policy_revision": 0, "avatar_policy_snapshot": None}), 0, "assessed"))
    monkeypatch.setattr(exam, "read_session_state", lambda *a: {
        "question_deadline": (NOW + timedelta(minutes=2)).isoformat()})
    response = exam.start_exam(exam.StartRequest(student_id=STUDENT, exam_template_id=EXAM,
                                                student_token="synthetic"), db=StartDB())
    session_insert, question_insert = (" ".join(sql.split()) for sql in writes)
    assert "SELECT" in session_insert and "FROM exam_templates" in session_insert
    assert "t.question_time_limit_minutes" in session_insert
    assert "t.time_limit_minutes" in session_insert
    assert "created_at" in question_insert and "clock_timestamp()" in question_insert
    assert response["question_deadline"] == (NOW + timedelta(minutes=2)).isoformat()
