"""Authorization tests for professor-only grading endpoints."""

from uuid import UUID

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from backend.app.auth import get_current_account
from backend.app.db import get_db
from backend.app.grading import router as grading_router
from backend.app.review import router as review_router

PROFESSOR_ID = "10000000-0000-4000-8000-000000000001"
OTHER_PROFESSOR_ID = "10000000-0000-4000-8000-000000000002"
SESSION_ID = "20000000-0000-4000-8000-000000000001"

PROFESSOR_ACCOUNT = {
    "id": "synthetic-account",
    "role": "professor",
    "professor_id": PROFESSOR_ID,
}

GRADE_BODY = {"session_id": SESSION_ID}
REVIEW_BODY = {
    "professor_id": OTHER_PROFESSOR_ID,
    "grades": [{"rubric_criterion": "Accuracy", "score": 5}],
}


class FakeResult:
    def __init__(self, row):
        self.row = row

    def mappings(self):
        return self

    def first(self):
        return self.row


class FakeDB:
    """Return a synthetic session owned by a different professor."""

    def execute(self, statement, params=None):
        sql = str(statement)

        if "AS exam_professor_id" in sql:
            return FakeResult({
                "status": "pending_grading",
                "exam_professor_id": OTHER_PROFESSOR_ID,
            })

        if (
            "SELECT s.status, t.professor_id" in sql
            and "AS exam_professor_id" not in sql
        ):
            return FakeResult({
                "status": "pending_grading",
                "professor_id": OTHER_PROFESSOR_ID,
                "rubric": {"criteria": []},
                "title": "Synthetic exam",
                "topic_coverage_required": [],
            })

        raise AssertionError(f"Unexpected database query in test: {sql}")

    def commit(self):
        raise AssertionError("Unauthorized request must not commit changes")


@pytest.fixture
def api():
    app = FastAPI()
    app.include_router(grading_router)
    app.include_router(review_router)

    def isolated_db():
        yield FakeDB()

    app.dependency_overrides[get_db] = isolated_db
    app.dependency_overrides[get_current_account] = (
        lambda: dict(PROFESSOR_ACCOUNT)
    )

    with TestClient(app) as client:
        yield client, app

    app.dependency_overrides.clear()


def test_anonymous_requests_cannot_use_grading_endpoints(api):
    client, app = api

    def reject_anonymous():
        raise HTTPException(status_code=401, detail="Please sign in.")

    app.dependency_overrides[get_current_account] = reject_anonymous

    responses = [
        client.post("/exam/grade", json=GRADE_BODY),
        client.get(f"/exam/{SESSION_ID}/report"),
        client.put(
            f"/exam/{SESSION_ID}/grades",
            json=REVIEW_BODY,
        ),
    ]

    assert [response.status_code for response in responses] == [
        401, 401, 401
    ]


@pytest.mark.parametrize("role", ["student", "admin"])
def test_non_professor_roles_cannot_use_grading_endpoints(api, role):
    client, app = api
    app.dependency_overrides[get_current_account] = lambda: {
        **PROFESSOR_ACCOUNT,
        "role": role,
    }

    responses = [
        client.post("/exam/grade", json=GRADE_BODY),
        client.get(f"/exam/{SESSION_ID}/report"),
        client.put(
            f"/exam/{SESSION_ID}/grades",
            json=REVIEW_BODY,
        ),
    ]

    assert [response.status_code for response in responses] == [
        403, 403, 403
    ]


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("post", "/exam/grade", GRADE_BODY),
        ("get", f"/exam/{SESSION_ID}/report", None),
        ("put", f"/exam/{SESSION_ID}/grades", REVIEW_BODY),
    ],
)
def test_professor_cannot_access_another_professors_exam(
    api, method, path, body
):
    client, _ = api
    request = getattr(client, method)

    if body is None:
        response = request(path)
    else:
        response = request(path, json=body)

    assert response.status_code == 404
    assert response.json()["detail"] == "Session not found"


def test_forged_professor_id_does_not_grant_grade_access(api):
    client, _ = api

    # The logged-in professor is PROFESSOR_ID, but the synthetic exam belongs
    # to OTHER_PROFESSOR_ID. The request body deliberately claims the other ID.
    response = client.put(
        f"/exam/{SESSION_ID}/grades",
        json=REVIEW_BODY,
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Session not found"
