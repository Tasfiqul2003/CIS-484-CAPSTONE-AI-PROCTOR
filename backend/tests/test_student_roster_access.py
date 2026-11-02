"""Regression tests for student exam-roster authorization."""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.db import get_db
from backend.app.exam import router as exam_router
from backend.app.student_auth import issue_student_token

STUDENT_ID = "10000000-0000-4000-8000-000000000001"
EXAM_ID = "20000000-0000-4000-8000-000000000001"

STUDENT = {"id": STUDENT_ID, "name": "Test Student", "eid": "testeid"}
PUBLISHED_EXAM = {
    "id": EXAM_ID,
    "title": "Published Exam",
    "course": "CIS 484",
    "description": "Test exam",
    "icon": "book",
    "time_limit_minutes": 30,
}


class FakeResult:
    def __init__(self, row=None, rows=None):
        self.row = row
        self.rows = rows or []

    def mappings(self):
        return self

    def first(self):
        return self.row

    def all(self):
        return self.rows


class FakeDB:
    """Return synthetic records for each authorization scenario."""

    def __init__(self, scenario):
        self.scenario = scenario
        self.calls = []
        self.committed = False

    def execute(self, statement, params=None):
        sql = str(statement)
        self.calls.append((sql, params or {}))

        if self.scenario == "start_unrostered":
            if "SELECT * FROM exam_templates" in sql:
                return FakeResult(
                    row={"id": EXAM_ID, "status": "published"}
                )
            if "SELECT id FROM students" in sql:
                return FakeResult(row={"id": STUDENT_ID})
            if "FROM exam_roster" in sql:
                return FakeResult(row=None)

        elif self.scenario == "verify_unrostered":
            if "exam_roster" in sql and "exam_templates" in sql:
                return FakeResult(row=None)

        elif self.scenario == "available_exams":
            if "lower(btrim(eid))" in sql:
                return FakeResult(row=STUDENT)
            if "FROM exam_roster AS r" in sql:
                assert "t.status = 'published'" in sql
                assert "JOIN exam_templates AS t" in sql
                return FakeResult(rows=[PUBLISHED_EXAM])

        raise AssertionError(
            f"Unexpected database query in {self.scenario}: {sql}"
        )

    def commit(self):
        self.committed = True
        raise AssertionError("Student request unexpectedly committed changes")


def make_client(scenario):
    app = FastAPI()
    app.include_router(exam_router)
    fake_db = FakeDB(scenario)

    def isolated_db():
        yield fake_db

    app.dependency_overrides[get_db] = isolated_db
    return TestClient(app), app, fake_db


def test_start_exam_rejects_student_not_on_exam_roster(monkeypatch):
    monkeypatch.setenv("AUTH_SECRET_KEY", "test-only-secret-for-roster-tests")
    client, app, db = make_client("start_unrostered")
    try:
        student_token = issue_student_token(
            student_id=STUDENT_ID,
            exam_template_id=EXAM_ID,
            purpose="student_exam",
        )
        response = client.post(
            "/exam/start",
            json={
                "student_id": STUDENT_ID,
                "exam_template_id": EXAM_ID,
                "student_token": student_token,
            },
        )

        assert response.status_code == 403
        assert response.json()["detail"] == (
            "This student is not authorized for this exam roster."
        )
        assert not db.committed
        assert not any(
            "INSERT INTO exam_sessions" in sql for sql, _ in db.calls
        )
    finally:
        app.dependency_overrides.clear()
        client.close()


def test_verify_eid_rejects_eid_not_on_published_exam_roster():
    client, app, db = make_client("verify_unrostered")
    try:
        response = client.post(
            "/exam/verify-eid",
            json={"eid": "testeid", "exam_template_id": EXAM_ID},
        )

        assert response.status_code == 403
        assert response.json()["detail"] == (
            "This EID is not on the roster for this published exam."
        )
        assert not db.committed
    finally:
        app.dependency_overrides.clear()
        client.close()


def test_available_exams_only_queries_published_roster_assignments():
    client, app, db = make_client("available_exams")
    try:
        response = client.post(
            "/exam/student/available",
            json={"eid": "  TESTEID  "},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["student"]["id"] == STUDENT_ID
        assert [exam["id"] for exam in body["exams"]] == [EXAM_ID]
        assert all(
            exam["status"] == "published" for exam in body["exams"]
        )

        roster_query = next(
            sql
            for sql, _ in db.calls
            if "FROM exam_roster AS r" in sql
        )
        assert "t.status = 'published'" in roster_query
        assert not db.committed
    finally:
        app.dependency_overrides.clear()
        client.close()



def test_end_session_uses_valid_uuid_cast_for_integrity_check():
    from backend.app.exam import end_session

    class RecordingDB:
        def __init__(self):
            self.sql = None
            self.params = None

        def execute(self, statement, params=None):
            self.sql = str(statement)
            self.params = params

    db = RecordingDB()
    session_id = "30000000-0000-4000-8000-000000000001"

    end_session(db, session_id)

    assert "CAST(:sid AS uuid)" in db.sql
    assert "CAST(:sid ASuuid)" not in db.sql
    assert db.params == {"sid": session_id}
    assert "integrity_events" in db.sql
    assert "pending_grading" in db.sql
    assert "flagged" in db.sql
