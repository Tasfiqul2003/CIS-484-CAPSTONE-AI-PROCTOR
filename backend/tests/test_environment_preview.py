"""Synthetic in-memory preview/preferences; no real DB, provider, or media."""
import json

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
URL = f"/exam/templates/{EXAM}/student-presentation"


def headers(student=STUDENT, exam_id=EXAM, purpose="student_exam"):
    token = issue_student_token(student_id=student, exam_template_id=exam_id, purpose=purpose)
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def api(monkeypatch):
    monkeypatch.setenv("AUTH_SECRET_KEY", "synthetic-environment-preview-secret-over-32-characters")
    checks = []
    monkeypatch.setattr(exam, "_require_recent_face_check", lambda db, student: checks.append(student))
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    with engine.begin() as db:
        db.execute(text("CREATE TABLE students (id TEXT PRIMARY KEY)"))
        db.execute(text("CREATE TABLE exam_templates (id TEXT PRIMARY KEY, status TEXT)"))
        db.execute(text("CREATE TABLE exam_roster (exam_template_id TEXT, student_id TEXT)"))
        db.execute(text("CREATE TABLE exam_avatar_policies (exam_template_id TEXT PRIMARY KEY, settings TEXT, revision INTEGER, exam_mode TEXT)"))
        db.execute(text("CREATE TABLE student_environment_preferences (exam_template_id TEXT, student_id TEXT, policy_revision INTEGER, preferences TEXT, PRIMARY KEY(exam_template_id,student_id))"))
        db.execute(text("INSERT INTO students VALUES (:id)"), {"id": STUDENT})
        db.execute(text("INSERT INTO students VALUES (:id)"), {"id": OTHER_STUDENT})
        db.execute(text("INSERT INTO exam_templates VALUES (:id, 'published')"), {"id": EXAM})
        db.execute(text("INSERT INTO exam_roster VALUES (:exam,:student)"), {"exam": EXAM, "student": STUDENT})
        settings = default_settings().model_dump()
        settings["student"]["background"] = True
        db.execute(text("INSERT INTO exam_avatar_policies VALUES (:exam,:settings,1,'assessed')"),
                   {"exam": EXAM, "settings": json.dumps(settings)})
    sessions = sessionmaker(bind=engine)
    app = FastAPI()
    app.include_router(preview.router)
    def isolated_db():
        with sessions() as db:
            yield db
    app.dependency_overrides[get_db] = isolated_db
    with TestClient(app) as client:
        yield client, engine, checks
    engine.dispose()


def saved(client, background="nature", **extra):
    preferences = client.get(URL, headers=headers()).json()["preferences"]
    preferences.update(background=background, **extra)
    return client.put(URL, headers=headers(), json={"expected_revision": 1, "preferences": preferences})


def test_preview_contains_five_choices_and_has_no_write_or_attempt_side_effects(api):
    client, engine, checks = api
    value = client.get(URL, headers=headers()).json()
    assert [item["id"] for item in value["policy"]["backgroundChoices"]] == ["neutral", "library", "classroom", "office", "nature"]
    assert checks == [STUDENT]
    assert "questions" not in value and "assistance" not in value["policy"]
    with engine.connect() as db:
        assert db.execute(text("SELECT COUNT(*) FROM student_environment_preferences")).scalar() == 0
        assert "exam_sessions" not in engine.dialect.get_table_names(db)


@pytest.mark.parametrize("background", ["neutral", "library", "classroom", "office", "nature"])
def test_each_environment_persists_on_reload(api, background):
    client, _, _ = api
    assert saved(client, background).status_code == 200
    assert client.get(URL, headers=headers()).json()["preferences"]["background"] == background


def test_scope_and_identity_gates_are_enforced(api, monkeypatch):
    client, _, _ = api
    assert client.get(URL).status_code == 401
    assert client.get(URL, headers=headers(exam_id=OTHER_EXAM)).status_code == 403
    assert client.get(URL, headers=headers(student=OTHER_STUDENT)).status_code == 403
    assert client.get(URL, headers=headers(purpose="student_session")).status_code == 403
    def failed_check(*_):
        raise HTTPException(403, "Complete the student photo check before starting this exam.")
    monkeypatch.setattr(exam, "_require_recent_face_check", failed_check)
    assert client.get(URL, headers=headers()).status_code == 403


def test_changed_policy_and_locked_options_fall_back_visibly(api):
    client, engine, _ = api
    assert saved(client).status_code == 200
    settings = default_settings().model_dump()
    with engine.begin() as db:
        db.execute(text("UPDATE exam_avatar_policies SET settings=:settings,revision=2"), {"settings": json.dumps(settings)})
    value = client.get(URL, headers=headers()).json()
    assert value["preferences"]["background"] == "neutral" and value["notice"]
    assert len(value["policy"]["backgroundChoices"]) == 1
    assert saved(client).status_code == 409
    body = {"expected_revision": 2, "preferences": {**value["preferences"], "background": "nature"}}
    assert client.put(URL, headers=headers(), json=body).status_code == 422


def test_preferences_cannot_change_rules_and_missing_storage_is_truthful(api):
    client, engine, _ = api
    assert saved(client, time_limit_minutes=999).status_code == 422
    assert saved(client, reducedMotion="false").status_code == 422
    with engine.begin() as db:
        db.execute(text("DROP TABLE student_environment_preferences"))
    assert client.get(URL, headers=headers()).status_code == 503
