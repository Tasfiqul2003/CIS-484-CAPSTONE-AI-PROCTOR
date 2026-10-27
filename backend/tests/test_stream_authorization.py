"""Regression tests for student authorization on the streaming answer endpoint."""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app import stream
from backend.app.student_auth import issue_student_token


STUDENT_ID = "10000000-0000-4000-8000-000000000001"
OTHER_STUDENT_ID = "10000000-0000-4000-8000-000000000002"
EXAM_ID = "20000000-0000-4000-8000-000000000001"
SESSION_ID = "30000000-0000-4000-8000-000000000001"
OTHER_SESSION_ID = "30000000-0000-4000-8000-000000000002"


class FakeResult:
    def __init__(self, row=None):
        self.row = row

    def mappings(self):
        return self

    def first(self):
        return self.row


class FakeDB:
    def __init__(self):
        self.calls = []

    def execute(self, statement, params=None):
        sql = str(statement)
        self.calls.append(sql)

        if "FROM exam_sessions s" in sql:
            return FakeResult({
                "status": "in_progress",
                "student_id": STUDENT_ID,
                "exam_template_id": EXAM_ID,
                "elapsed_min": 1,
            })

        if "FROM interactions" in sql:
            return FakeResult(None)

        raise AssertionError(f"Unexpected SQL query: {sql}")

    def close(self):
        pass


def make_client(monkeypatch):
    monkeypatch.setenv("AUTH_SECRET_KEY", "test-only-stream-secret-key-at-least-32-bytes")
    db = FakeDB()
    monkeypatch.setattr(stream, "open_session", lambda: db)

    app = FastAPI()
    app.include_router(stream.router)
    return TestClient(app), db


def make_token(*, student_id=STUDENT_ID, session_id=SESSION_ID):
    return issue_student_token(
        student_id=student_id,
        exam_template_id=EXAM_ID,
        purpose="student_session",
        session_id=session_id,
    )


def request_body():
    return {
        "session_id": SESSION_ID,
        "answer_transcript": "A test answer",
    }


def test_stream_rejects_missing_authorization_before_database_access(monkeypatch):
    client, db = make_client(monkeypatch)
    try:
        response = client.post("/exam/answer/stream", json=request_body())

        assert response.status_code == 401
        assert db.calls == []
    finally:
        client.close()


def test_stream_rejects_token_for_another_session(monkeypatch):
    client, db = make_client(monkeypatch)
    try:
        response = client.post(
            "/exam/answer/stream",
            json=request_body(),
            headers={"Authorization": f"Bearer {make_token(session_id=OTHER_SESSION_ID)}"},
        )

        assert response.status_code == 403
        assert db.calls == []
    finally:
        client.close()


def test_stream_rejects_token_for_another_student(monkeypatch):
    client, db = make_client(monkeypatch)
    try:
        response = client.post(
            "/exam/answer/stream",
            json=request_body(),
            headers={"Authorization": f"Bearer {make_token(student_id=OTHER_STUDENT_ID)}"},
        )

        assert response.status_code == 403
        assert any("FROM exam_sessions s" in sql for sql in db.calls)
        assert not any("UPDATE interactions" in sql for sql in db.calls)
        assert not any("INSERT INTO interactions" in sql for sql in db.calls)
    finally:
        client.close()


def test_stream_accepts_matching_token_and_checks_session_state(monkeypatch):
    client, db = make_client(monkeypatch)
    try:
        response = client.post(
            "/exam/answer/stream",
            json=request_body(),
            headers={"Authorization": f"Bearer {make_token()}"},
        )

        # The fake database has no unanswered question, so a correctly
        # authenticated request should reach that validation and receive 409.
        assert response.status_code == 409
        assert response.json()["detail"] == "No question is waiting for an answer"
        assert any("FROM exam_sessions s" in sql for sql in db.calls)
        assert any("FROM interactions" in sql for sql in db.calls)
        assert not any("UPDATE interactions" in sql for sql in db.calls)
        assert not any("INSERT INTO interactions" in sql for sql in db.calls)
    finally:
        client.close()
