"""Synthetic photo previews and professor/roster access boundaries."""

import io

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from backend.app.auth import get_current_account
from backend.app.db import get_db
from backend.app.exam import router

PROFESSOR = "10000000-0000-4000-8000-000000000001"
OTHER_PROFESSOR = "10000000-0000-4000-8000-000000000002"
EXAM = "20000000-0000-4000-8000-000000000001"
OTHER_EXAM = "20000000-0000-4000-8000-000000000002"
STUDENT = "30000000-0000-4000-8000-000000000001"
OTHER_STUDENT = "30000000-0000-4000-8000-000000000002"
PHOTO_URL = f"/exam/templates/{EXAM}/roster/{STUDENT}/photo"


def synthetic_photo(format="JPEG", orientation=None):
    output = io.BytesIO()
    image = Image.new("RGB", (600, 900), color="purple")
    exif = Image.Exif()
    exif[270] = "Synthetic source metadata"
    if orientation:
        exif[274] = orientation
    image.save(output, format=format, exif=exif)
    return output.getvalue()


class Result:
    def __init__(self, row=None, rows=None):
        self.row, self.rows = row, rows or []

    def first(self):
        return self.row

    def mappings(self):
        return self

    def all(self):
        return self.rows


class RosterDB:
    def __init__(self):
        self.photo = synthetic_photo()
        self.calls = []

    def execute(self, statement, params=None):
        sql = str(statement)
        self.calls.append((sql, params))
        if "SELECT s.official_photo" in sql:
            # All three constraints must be present, using bound parameters.
            assert "e.professor_id = CAST(:professor_id AS uuid)" in sql
            assert "r.student_id = CAST(:student_id AS uuid)" in sql
            assert "r.exam_template_id = CAST(:exam_id AS uuid)" in sql
            if params == {"exam_id": EXAM, "student_id": STUDENT, "professor_id": PROFESSOR}:
                return Result(row={"official_photo": self.photo})
            return Result()
        if "FROM exam_templates" in sql:
            return Result(row={"id": EXAM} if params["professor_id"] == PROFESSOR else None)
        if "FROM exam_roster AS r" in sql:
            assert "AS student_id" in sql and "AS has_photo" in sql
            # Photo bytes must stay out of the roster JSON query.
            assert "s.official_photo," not in sql
            return Result(rows=[{
                "student_id": STUDENT, "name": "Synthetic Student",
                "email": "student@example.invalid", "eid": "synthetic-eid",
                "has_photo": bool(self.photo),
            }])
        raise AssertionError("Unexpected database query")


@pytest.fixture
def api():
    db = RosterDB()
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_account] = lambda: {
        "id": "synthetic-account", "role": "professor", "professor_id": PROFESSOR,
    }
    with TestClient(app) as client:
        yield client, app, db


@pytest.mark.parametrize("format", ["JPEG", "PNG"])
def test_owner_gets_small_jpeg_without_source_metadata(api, format):
    client, _, db = api
    db.photo = synthetic_photo(format)
    response = client.get(PHOTO_URL)
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/jpeg"
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    with Image.open(io.BytesIO(response.content)) as preview:
        assert preview.width <= 128 and preview.height <= 160
        assert preview.height > preview.width
        assert not preview.getexif()


def test_preview_honors_exif_orientation(api):
    client, _, db = api
    db.photo = synthetic_photo(orientation=6)
    response = client.get(PHOTO_URL)
    assert response.status_code == 200
    with Image.open(io.BytesIO(response.content)) as preview:
        assert preview.width > preview.height


@pytest.mark.parametrize("photo", [None, b"", b"not an image"])
def test_missing_or_invalid_photo_returns_no_image(api, photo):
    client, _, db = api
    db.photo = photo
    response = client.get(PHOTO_URL)
    assert response.status_code == 404
    assert response.json() == {"detail": "Photo unavailable."}
    assert "no-store" in response.headers["cache-control"]


@pytest.mark.parametrize("role", ["student", "admin"])
def test_other_roles_cannot_fetch_photos(api, role):
    client, app, db = api
    app.dependency_overrides[get_current_account] = lambda: {"role": role}
    assert client.get(PHOTO_URL).status_code == 403
    assert not db.calls


def test_anonymous_cannot_fetch_photos(api):
    client, app, db = api
    del app.dependency_overrides[get_current_account]
    assert client.get(PHOTO_URL).status_code == 401
    assert not db.calls


def test_another_professor_cannot_fetch_photos(api):
    client, app, _ = api
    app.dependency_overrides[get_current_account] = lambda: {
        "role": "professor", "professor_id": OTHER_PROFESSOR,
    }
    assert client.get(PHOTO_URL).status_code == 404


@pytest.mark.parametrize("exam,student", [(OTHER_EXAM, STUDENT), (EXAM, OTHER_STUDENT)])
def test_photo_requires_student_membership_in_requested_exam(api, exam, student):
    client, _, _ = api
    assert client.get(f"/exam/templates/{exam}/roster/{student}/photo").status_code == 404


def test_roster_metadata_has_photo_availability_without_photo_bytes(api):
    client, _, _ = api
    response = client.get(f"/exam/templates/{EXAM}/roster")
    assert response.status_code == 200
    row = response.json()[0]
    assert row["student_id"] == STUDENT and row["has_photo"] is True
    assert "official_photo" not in row
