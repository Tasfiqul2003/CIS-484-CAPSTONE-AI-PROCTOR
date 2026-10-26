from datetime import datetime, timezone
from uuid import UUID

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from backend.app.auth import get_current_account
from backend.app.db import get_db
from backend.app.exam import router as exam_router

PROFESSOR_ID = "10000000-0000-4000-8000-000000000001"
SESSION_ID = "20000000-0000-4000-8000-000000000001"
EXAM_ID = "30000000-0000-4000-8000-000000000001"


class FakeRows:
    def __init__(self, rows):
        self.rows = rows

    def mappings(self):
        return self

    def all(self):
        return self.rows


class FakeDB:
    def __init__(self):
        self.sql = ""
        self.params = None

    def execute(self, statement, params=None):
        self.sql = str(statement)
        self.params = params
        return FakeRows([{
            "session_id": UUID(SESSION_ID),
            "status": "pending_grading",
            "started_at": datetime(2026, 10, 20, 14, 0, tzinfo=timezone.utc),
            "ended_at": datetime(2026, 10, 20, 14, 20, tzinfo=timezone.utc),
            "student_name": "Test Student",
            "student_eid": "abc123",
            "exam_template_id": UUID(EXAM_ID),
            "exam_title": "Test Exam",
            "course": "CIS 484",
        }])


@pytest.fixture
def api():
    app = FastAPI()
    app.include_router(exam_router)
    db = FakeDB()

    def isolated_db():
        yield db

    app.dependency_overrides[get_db] = isolated_db
    app.dependency_overrides[get_current_account] = lambda: {
        "id": "test-account",
        "role": "professor",
        "professor_id": PROFESSOR_ID,
    }

    with TestClient(app) as client:
        yield client, app, db

    app.dependency_overrides.clear()


def test_professor_gets_submission_fields_and_own_scope(api):
    client, _, db = api

    response = client.get("/exam/submissions")

    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["id"] == SESSION_ID
    assert data[0]["studentName"] == "Test Student"
    assert data[0]["studentId"] == "abc123"
    assert data[0]["examName"] == "Test Exam"
    assert data[0]["course"] == "CIS 484"
    assert data[0]["status"] == "pending_grading"
    assert data[0]["startedAt"] is not None
    assert data[0]["submittedAt"] is not None

    normalized_sql = " ".join(db.sql.lower().split())
    assert "where t.professor_id = cast(:professor_id as uuid)" in normalized_sql
    assert db.params == {"professor_id": PROFESSOR_ID}


def test_anonymous_cannot_list_submissions(api):
    client, app, _ = api

    def reject_anonymous():
        raise HTTPException(status_code=401, detail="Please sign in.")

    app.dependency_overrides[get_current_account] = reject_anonymous

    response = client.get("/exam/submissions")
    assert response.status_code == 401


@pytest.mark.parametrize("role", ["student", "admin"])
def test_non_professor_cannot_list_submissions(api, role):
    client, app, _ = api
    app.dependency_overrides[get_current_account] = lambda: {
        "id": "test-account",
        "role": role,
        "professor_id": PROFESSOR_ID,
    }

    response = client.get("/exam/submissions")
    assert response.status_code == 403


def test_professor_without_professor_id_is_rejected(api):
    client, app, db = api
    app.dependency_overrides[get_current_account] = lambda: {
        "id": "test-account",
        "role": "professor",
        "professor_id": None,
    }

    response = client.get("/exam/submissions")

    assert response.status_code == 403
    assert db.sql == ""
