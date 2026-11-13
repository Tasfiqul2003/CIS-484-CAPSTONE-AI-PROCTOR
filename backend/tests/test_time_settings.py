"""Synthetic SQLite API checks; never use the application database."""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend.app.auth import get_current_account
from backend.app.db import get_db
from backend.app.time_settings import router

EXAM = "20000000-0000-4000-8000-000000000001"
URL = f"/exam/templates/{EXAM}/time-settings"


@pytest.fixture
def api():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    with engine.begin() as db:
        db.execute(text("CREATE TABLE exam_templates (id TEXT PRIMARY KEY, professor_id TEXT, time_limit_minutes INTEGER, question_time_limit_minutes INTEGER)"))
        db.execute(text("INSERT INTO exam_templates VALUES (:id, 'owner', NULL, NULL)"), {"id": EXAM})
    sessions = sessionmaker(bind=engine)
    app = FastAPI()
    app.include_router(router)
    def isolated_db():
        with sessions() as db:
            yield db
    app.dependency_overrides[get_db] = isolated_db
    app.dependency_overrides[get_current_account] = lambda: {"role": "professor", "professor_id": "owner"}
    with TestClient(app) as client:
        yield client, app
    engine.dispose()


def test_load_and_save(api):
    client, _ = api
    assert client.get(URL).json() == {"time_limit_minutes": None, "question_time_limit_minutes": None}
    for minutes in [1, 30, 240]:
        assert client.put(URL, json={"time_limit_minutes": minutes}).status_code == 200
        assert client.get(URL).json() == {"time_limit_minutes": minutes, "question_time_limit_minutes": None}


@pytest.mark.parametrize("value", [0, -1, 241, 1.5, True, "30", None])
def test_invalid_values_do_not_write(api, value):
    client, _ = api
    assert client.put(URL, json={"time_limit_minutes": value}).status_code == 422
    assert client.get(URL).json() == {"time_limit_minutes": None, "question_time_limit_minutes": None}


@pytest.mark.parametrize("method", ["get", "put"])
def test_other_professor_cannot_access(api, method):
    client, app = api
    app.dependency_overrides[get_current_account] = lambda: {"role": "professor", "professor_id": "other"}
    kwargs = {"json": {"time_limit_minutes": 30}} if method == "put" else {}
    assert getattr(client, method)(URL, **kwargs).status_code == 404


def test_requires_login_and_professor(api):
    client, app = api
    app.dependency_overrides[get_current_account] = lambda: {"role": "student"}
    assert client.get(URL).status_code == 403
    assert client.put(URL, json={"time_limit_minutes": 30}).status_code == 403
    del app.dependency_overrides[get_current_account]
    assert client.get(URL).status_code == 401


@pytest.mark.parametrize("streaming", [False, True])
def test_expiry_uses_attempt_limit_even_when_template_was_extended(monkeypatch, streaming):
    from backend.app import exam, stream
    from uuid import UUID
    student = "10000000-0000-4000-8000-000000000001"
    sid = "30000000-0000-4000-8000-000000000001"
    claims = {"sub": student, "session_id": sid, "exam_template_id": EXAM}

    class Result:
        def __init__(self, row=None): self.row = row
        def mappings(self): return self
        def first(self): return self.row
        def all(self): return []

    class DB:
        committed = False
        def execute(self, statement, params=None):
            sql = str(statement)
            if "FROM exam_sessions s" in sql:
                return Result({"status": "in_progress", "student_id": student,
                               "exam_template_id": EXAM, "elapsed_min": 31, "time_limit_minutes": 30,
                               "avatar_policy_snapshot": None, "avatar_policy_revision": 0,
                               "developer_demo": False})
            if "FROM exam_session_videos" in sql:
                return Result({"status": "recording", "next_chunk_index": 1})
            if "student_answer_transcript IS NULL" in sql:
                return Result({"id": "synthetic-question", "sequence_num": 1})
            if "SELECT * FROM exam_templates" in sql:
                return Result({"time_limit_minutes": 60, "topic_coverage_required": [], "difficulty_curve": "adaptive"})
            if "FROM interactions" in sql or "UPDATE interactions" in sql or "UPDATE exam_sessions" in sql:
                return Result()
            raise AssertionError(sql)
        def commit(self): self.committed = True
        def close(self): pass

    db = DB()
    req = exam.AnswerRequest(session_id=UUID(sid), answer_transcript="Synthetic answer")
    if streaming:
        monkeypatch.setattr(stream, "open_session", lambda: db)
        monkeypatch.setattr(stream, "load_exam_material_summaries", lambda *args: [])
        assert stream.plan_turn(req, claims)["kind"] == "done"
    else:
        monkeypatch.setattr(exam, "read_student_token", lambda *args, **kwargs: claims)
        assert exam.submit_answer(req, authorization="synthetic", db=db)["done"] is True
        assert db.committed
