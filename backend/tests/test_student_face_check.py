import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from backend.app import exam as exam_module
from backend.app.db import get_db
from backend.app.face_matching import FaceMatcherUnavailable
from backend.app.exam import router as exam_router


STUDENT_ID = "10000000-0000-4000-8000-000000000001"


class FakeResult:
    def __init__(self, row=None):
        self.row = row

    def mappings(self):
        return self

    def first(self):
        return self.row


class FakeDB:
    def __init__(self, prior_verification=None, official_photo=b"official-photo"):
        self.prior_verification = prior_verification
        self.official_photo = official_photo
        self.writes = []
        self.committed = False

    def execute(self, statement, params=None):
        sql = str(statement)
        if "SELECT s.id, s.official_photo" in sql:
            return FakeResult(
                row={
                    "id": STUDENT_ID,
                    "official_photo": self.official_photo,
                }
            )
        if "FROM student_face_verifications" in sql:
            return FakeResult(row=self.prior_verification)
        if "INSERT INTO student_face_verifications" in sql:
            self.writes.append(params)
            return FakeResult()
        raise AssertionError(f"Unexpected query: {sql}")

    def commit(self):
        self.committed = True


class FakeMatcher:
    def __init__(self, matched):
        self.matched = matched

    def compare_frames(self, reference_photo, frames):
        assert reference_photo == b"official-photo"
        assert len(frames) == 3
        return self.matched


def make_client(db):
    app = FastAPI()
    app.include_router(exam_router)
    app.dependency_overrides[get_db] = lambda: db
    return TestClient(app), app


def submit_three_frames(client):
    files = [
        ("frames", (f"frame-{index}.jpg", b"synthetic-frame", "image/jpeg"))
        for index in range(3)
    ]
    return client.post(
        "/exam/student/face-check",
        data={"eid": "TESTEID"},
        files=files,
    )


def test_face_check_passes_a_valid_match_without_professor_flag(monkeypatch):
    db = FakeDB(prior_verification={"attempt_count": 1, "status": "no_match"})
    monkeypatch.setattr(exam_module, "get_face_matcher", lambda: FakeMatcher(True))
    client, app = make_client(db)

    try:
        response = submit_three_frames(client)

        assert response.status_code == 200
        assert response.json()["allowed"] is True
        assert response.json()["review_required"] is False
        assert db.writes[0]["attempts"] == 2
        assert db.writes[0]["status"] == "matched"
        assert db.committed
    finally:
        app.dependency_overrides.clear()
        client.close()


def test_face_check_blocks_third_mismatch_and_requests_professor_help(monkeypatch):
    db = FakeDB(prior_verification={"attempt_count": 2, "status": "no_match"})
    monkeypatch.setattr(exam_module, "get_face_matcher", lambda: FakeMatcher(False))
    client, app = make_client(db)

    try:
        response = submit_three_frames(client)

        assert response.status_code == 200
        assert response.json()["attempt"] == 3
        assert response.json()["allowed"] is False
        assert response.json()["review_required"] is True
        assert db.writes[0]["status"] == "no_match"
        assert db.committed
    finally:
        app.dependency_overrides.clear()
        client.close()


def test_face_check_does_not_allow_more_attempts_after_three_recent_mismatches(monkeypatch):
    db = FakeDB(prior_verification={"attempt_count": 3, "status": "no_match"})

    def should_not_compare():
        raise AssertionError("A fourth comparison should not be attempted.")

    monkeypatch.setattr(exam_module, "get_face_matcher", should_not_compare)
    client, app = make_client(db)

    try:
        response = submit_three_frames(client)

        assert response.status_code == 200
        assert response.json() == {
            "matched": False,
            "allowed": False,
            "attempt": 3,
            "max_attempts": 3,
            "review_required": True,
        }
        assert db.writes == []
        assert not db.committed
    finally:
        app.dependency_overrides.clear()
        client.close()


def test_missing_official_photo_does_not_count_an_attempt(monkeypatch):
    db = FakeDB(official_photo=None)
    monkeypatch.setattr(exam_module, "get_face_matcher", lambda: FakeMatcher(False))
    client, app = make_client(db)

    try:
        response = submit_three_frames(client)

        assert response.status_code == 409
        assert response.json()["detail"] == (
            "An official photo is not on file. Contact your instructor."
        )
        assert db.writes == []
        assert not db.committed
    finally:
        app.dependency_overrides.clear()
        client.close()


def test_unconfigured_matcher_is_an_explicit_error_not_a_failed_attempt(monkeypatch):
    db = FakeDB()

    def unavailable():
        raise FaceMatcherUnavailable("Model files unavailable.")

    monkeypatch.setattr(exam_module, "get_face_matcher", unavailable)
    client, app = make_client(db)

    try:
        response = submit_three_frames(client)

        assert response.status_code == 503
        assert response.json()["detail"] == "Model files unavailable."
        assert db.writes == []
        assert not db.committed
    finally:
        app.dependency_overrides.clear()
        client.close()


@pytest.mark.parametrize(
    "verification",
    [
        None,
        {"attempt_count": 3, "status": "no_match"},
        {"attempt_count": 3, "status": "review_override"},
        {"attempt_count": 1, "status": "matched"},
    ],
)
def test_only_a_recent_match_can_start_an_exam(verification):
    db = FakeDB(prior_verification=verification)

    if verification and verification["status"] == "matched":
        assert exam_module._require_recent_face_check(db, STUDENT_ID) == verification
    else:
        with pytest.raises(HTTPException) as error:
            exam_module._require_recent_face_check(db, STUDENT_ID)
        assert error.value.status_code == 403
