"""Tests for the professor exam-progress endpoint."""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.auth import get_current_account
from backend.app.db import get_db
from backend.app.exam import router as exam_router


PROFESSOR_ID = "10000000-0000-4000-8000-000000000001"
OTHER_PROFESSOR_ID = "10000000-0000-4000-8000-000000000002"
EXAM_ID = "20000000-0000-4000-8000-000000000001"
STUDENT_ID = "30000000-0000-4000-8000-000000000001"

PROFESSOR_ACCOUNT = {
    "id": "synthetic-account",
    "role": "professor",
    "professor_id": PROFESSOR_ID,
}


class FakeResult:
    def __init__(self, row=None, rows=None):
        self.row = row
        self.rows = rows or []

    def first(self):
        return self.row

    def mappings(self):
        return self

    def all(self):
        return self.rows


class FakeDB:
    def __init__(self, owns_exam=True, progress_rows=None):
        self.owns_exam = owns_exam
        self.progress_rows = progress_rows or []
        self.calls = []

    def execute(self, statement, params=None):
        sql = str(statement)
        self.calls.append((sql, params or {}))

        if "FROM exam_templates" in sql:
            if self.owns_exam:
                return FakeResult(row={"id": EXAM_ID})
            return FakeResult(row=None)

        if "FROM exam_roster AS r" in sql:
            return FakeResult(rows=self.progress_rows)

        raise AssertionError(f"Unexpected database query: {sql}")


def make_client(db, account=None):
    app = FastAPI()
    app.include_router(exam_router)

    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_account] = (
        lambda: dict(account or PROFESSOR_ACCOUNT)
    )

    client = TestClient(app)
    return client, app


def test_progress_returns_roster_students_and_latest_session_status():
    rows = [
        {
            "student_id": STUDENT_ID,
            "student_name": "Alex Student",
            "email": "alex@example.com",
            "eid": "alex123",
            "session_id": None,
            "status": None,
            "started_at": None,
            "ended_at": None,
        },
        {
            "student_id": "40000000-0000-4000-8000-000000000001",
            "student_name": "Sam Student",
            "email": "sam@example.com",
            "eid": "sam123",
            "session_id": "50000000-0000-4000-8000-000000000001",
            "status": "in_progress",
            "started_at": "2026-10-28T12:00:00",
            "ended_at": None,
        },
    ]
    db = FakeDB(progress_rows=rows)
    client, app = make_client(db)

    try:
        response = client.get(f"/exam/templates/{EXAM_ID}/progress")

        assert response.status_code == 200
        body = response.json()
        assert len(body) == 2
        assert body[0]["student_name"] == "Alex Student"
        assert body[0]["session_id"] is None
        assert body[0]["status"] is None
        assert body[1]["student_name"] == "Sam Student"
        assert body[1]["status"] == "in_progress"

        progress_sql = next(
            sql for sql, _ in db.calls if "FROM exam_roster AS r" in sql
        )
        assert "LEFT JOIN LATERAL" in progress_sql
        assert "ORDER BY es.started_at DESC, es.id DESC" in progress_sql
        assert "LIMIT 1" in progress_sql
        assert "professor_id" in db.calls[0][0]

        # Timing uses the saved attempt settings and the database clock.
        assert "latest.time_limit_minutes" in progress_sql
        assert "latest.extended_time_multiplier" in progress_sql
        assert "AS allowed_seconds" in progress_sql
        assert "AS elapsed_seconds" in progress_sql
        assert "COALESCE(latest.ended_at, progress_clock.server_now) - latest.started_at" in progress_sql
        assert "AS remaining_seconds" in progress_sql
        assert "progress_clock.server_now AS server_now" in progress_sql

        # Elapsed and remaining time use the same persisted pause calculation
        # as the exam timer.
        assert "avatar_assistance_requests ap" in progress_sql
        assert "LEAST(COALESCE(ap.pause_ended_at, clock_timestamp()), ap.pause_until)" in progress_sql

        # Students without a session remain present in the roster.
        assert body[0]["student_id"] == STUDENT_ID
        assert body[0]["session_id"] is None
        assert body[0]["started_at"] is None
        assert body[0]["ended_at"] is None
    finally:
        app.dependency_overrides.clear()
        client.close()


def test_progress_rejects_exam_not_owned_by_professor():
    db = FakeDB(owns_exam=False)
    client, app = make_client(db)

    try:
        response = client.get(f"/exam/templates/{EXAM_ID}/progress")

        assert response.status_code == 404
        assert response.json()["detail"] == (
            "Exam not found or you do not own this exam."
        )
        assert len(db.calls) == 1
    finally:
        app.dependency_overrides.clear()
        client.close()


def test_progress_requires_professor_account_id():
    account = {**PROFESSOR_ACCOUNT, "professor_id": None}
    db = FakeDB()
    client, app = make_client(db, account=account)

    try:
        response = client.get(f"/exam/templates/{EXAM_ID}/progress")

        assert response.status_code == 403
        assert response.json()["detail"] == "Professor account required."
        assert db.calls == []
    finally:
        app.dependency_overrides.clear()
        client.close()
