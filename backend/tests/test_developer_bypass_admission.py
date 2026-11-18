"""Synthetic HTTP preview admission: real signed developer cookie, no devices/DB service.

The ordinary photo decision is a rejecting test gate; no matched photo row is made.
Only the in-memory SQLite roster/preferences and declared synthetic EIDs are used.
"""
from datetime import datetime, timedelta, timezone

import jwt
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend.app import environment_preview as preview, exam
from backend.app.avatar_policy import default_settings
from backend.app.db import get_db
from backend.app.student_auth import issue_student_token

EXAM = "20000000-0000-4000-8000-000000000001"
OTHER_EXAM = "20000000-0000-4000-8000-000000000002"
STUDENT = "10000000-0000-4000-8000-000000000001"
OTHER_STUDENT = "10000000-0000-4000-8000-000000000002"
COOKIE = "cybros_developer_face_bypass"
SECRET = "synthetic-preview-grant-admission-secret-over-32-characters"
URL = f"/exam/templates/{EXAM}/student-presentation"


def headers(student=STUDENT, exam_id=EXAM, purpose="student_exam", **extra):
    token = issue_student_token(student_id=student, exam_template_id=exam_id, purpose=purpose)
    return {"Authorization": f"Bearer {token}", **extra}


@pytest.fixture
def admission(monkeypatch):
    from backend.app import developer_face_bypass as bypass

    monkeypatch.setenv("AUTH_SECRET_KEY", SECRET)
    monkeypatch.setenv("CYBROS_DEVELOPER_FACE_BYPASS", "1")
    monkeypatch.setenv("AUTH_COOKIE_SECURE", "false")
    photo_calls, photo_allowed = [], set()

    def photo_gate(db, student_id):
        photo_calls.append(student_id)
        if student_id not in photo_allowed:
            raise HTTPException(403, "Complete the student photo check before starting this exam.")
        return {"status": "matched", "attempt_count": 1}

    # The two-argument photo contract stays intact and is tested when no grant applies.
    monkeypatch.setattr(exam, "_require_recent_face_check", photo_gate)
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    with engine.begin() as db:
        for statement in (
            "CREATE TABLE students (id TEXT PRIMARY KEY, name TEXT, eid TEXT)",
            "CREATE TABLE exam_templates (id TEXT PRIMARY KEY, status TEXT)",
            "CREATE TABLE exam_roster (exam_template_id TEXT, student_id TEXT)",
            "CREATE TABLE exam_avatar_policies (exam_template_id TEXT PRIMARY KEY, settings TEXT, revision INTEGER, exam_mode TEXT)",
            "CREATE TABLE student_environment_preferences (exam_template_id TEXT, student_id TEXT, policy_revision INTEGER, preferences TEXT, PRIMARY KEY(exam_template_id,student_id))",
            "CREATE TABLE student_face_verifications (student_id TEXT PRIMARY KEY, attempt_count INTEGER)",
        ):
            db.execute(text(statement))
        db.execute(text("INSERT INTO students VALUES (:id,'Synthetic One','student.demo')"), {"id": STUDENT})
        db.execute(text("INSERT INTO students VALUES (:id,'Synthetic Two','student.demo2')"), {"id": OTHER_STUDENT})
        db.execute(text("INSERT INTO exam_templates VALUES (:exam,'published')"), {"exam": EXAM})
        db.execute(text("INSERT INTO exam_roster VALUES (:exam,:student)"),
                   {"exam": EXAM, "student": STUDENT})
        db.execute(text("INSERT INTO exam_roster VALUES (:exam,:student)"),
                   {"exam": EXAM, "student": OTHER_STUDENT})
        db.execute(text("INSERT INTO exam_avatar_policies VALUES (:exam,:settings,1,'assessed')"),
                   {"exam": EXAM, "settings": default_settings().model_dump_json()})
    sessions = sessionmaker(bind=engine)
    app = FastAPI()
    app.include_router(bypass.router)
    app.include_router(preview.router)

    def isolated_db():
        with sessions() as db:
            yield db

    app.dependency_overrides[get_db] = isolated_db
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 43100)) as client:
        yield client, engine, photo_calls, photo_allowed
    engine.dispose()


def grant(client):
    result = client.post("/exam/student/developer-face-bypass", json={"eid": "student.demo"})
    assert result.status_code == 200, result.text
    assert result.json()["matched"] is False
    assert client.cookies.get(COOKIE)
    return result


def save(client, preferences):
    return client.put(URL, headers=headers(), json={"expected_revision": 1, "preferences": preferences})


def test_signed_grant_allows_read_and_save_without_fabricating_photo_rows(admission):
    client, engine, photo_calls, _ = admission
    granted = grant(client)
    assert "httponly" in granted.headers["set-cookie"].lower()
    result = client.get(URL, headers=headers())
    assert result.status_code == 200
    preferences = result.json()["preferences"]
    preferences["volume"] = 35
    assert save(client, preferences).status_code == 200
    assert client.get(URL, headers=headers()).json()["preferences"]["volume"] == 35
    assert photo_calls == []
    with engine.connect() as db:
        assert db.execute(text("SELECT COUNT(*) FROM student_face_verifications")).scalar_one() == 0
        assert db.execute(text("SELECT COUNT(*) FROM student_environment_preferences")).scalar_one() == 1
        assert "exam_sessions" not in engine.dialect.get_table_names(db)


@pytest.mark.parametrize("revoke", ["disabled", "eid_changed", "tampered", "expired"])
def test_every_preview_and_save_revalidates_grant(admission, monkeypatch, revoke):
    client, engine, photo_calls, _ = admission
    grant(client)
    preferences = client.get(URL, headers=headers()).json()["preferences"]
    if revoke == "disabled":
        monkeypatch.setenv("CYBROS_DEVELOPER_FACE_BYPASS", "0")
    elif revoke == "eid_changed":
        with engine.begin() as db:
            db.execute(text("UPDATE students SET eid='ordinary.synthetic' WHERE id=:student"), {"student": STUDENT})
    elif revoke == "tampered":
        client.cookies.clear()
        client.cookies.set(COOKIE, "untrusted-local-client-value")
    else:
        token = client.cookies.get(COOKIE)
        payload = jwt.decode(token, SECRET, algorithms=["HS256"], options={"verify_exp": False})
        payload["exp"] = datetime.now(timezone.utc) - timedelta(seconds=1)
        client.cookies.clear()
        client.cookies.set(COOKIE, jwt.encode(payload, SECRET, algorithm="HS256"))
    assert client.get(URL, headers=headers()).status_code == 403
    assert save(client, preferences).status_code == 403
    assert photo_calls == [STUDENT, STUDENT]
    with engine.connect() as db:
        assert db.execute(text("SELECT COUNT(*) FROM student_environment_preferences")).scalar_one() == 0
        assert db.execute(text("SELECT COUNT(*) FROM student_face_verifications")).scalar_one() == 0


def test_client_flags_are_not_a_grant_and_ordinary_photo_path_remains(admission):
    client, _, photo_calls, photo_allowed = admission
    fake_headers = headers(**{"X-Developer-Face-Bypass": "true", "X-Face-Matched": "true"})
    assert client.get(URL + "?developer_bypass=true&matched=true", headers=fake_headers).status_code == 403
    photo_allowed.add(STUDENT)
    assert client.get(URL, headers=headers()).status_code == 200
    assert photo_calls == [STUDENT, STUDENT]


@pytest.mark.parametrize("scenario", ["no_token", "wrong_exam", "wrong_purpose", "other_student", "unrostered", "unpublished"])
def test_grant_does_not_replace_student_token_or_published_roster_scope(admission, scenario):
    client, engine, photo_calls, _ = admission
    grant(client)
    request_headers = headers()
    expected = 403
    if scenario == "no_token":
        request_headers = {}
        expected = 401
    elif scenario == "wrong_exam":
        request_headers = headers(exam_id=OTHER_EXAM)
    elif scenario == "wrong_purpose":
        request_headers = headers(purpose="student_precheck")
    elif scenario == "other_student":
        request_headers = headers(student=OTHER_STUDENT)
    elif scenario == "unrostered":
        with engine.begin() as db:
            db.execute(text("DELETE FROM exam_roster WHERE student_id=:student"), {"student": STUDENT})
    elif scenario == "unpublished":
        with engine.begin() as db:
            db.execute(text("UPDATE exam_templates SET status='draft' WHERE id=:exam"), {"exam": EXAM})
    assert client.get(URL, headers=request_headers).status_code == expected
    assert photo_calls == ([OTHER_STUDENT] if scenario == "other_student" else [])


def test_valid_grant_preserves_professor_preference_policy_and_revision(admission):
    client, engine, photo_calls, _ = admission
    grant(client)
    preferences = client.get(URL, headers=headers()).json()["preferences"]
    assert client.put(URL, headers=headers(), json={"expected_revision": 2, "preferences": preferences}).status_code == 409
    preferences["avatar"] = "geometric"
    assert save(client, preferences).status_code == 422
    assert photo_calls == []
    with engine.connect() as db:
        assert db.execute(text("SELECT COUNT(*) FROM student_environment_preferences")).scalar_one() == 0
