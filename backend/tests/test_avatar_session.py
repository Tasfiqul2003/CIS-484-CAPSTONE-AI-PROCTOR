"""Synthetic student presentation snapshots; no application DB, models or media."""

import base64
import json
from uuid import UUID

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend.app import avatar_session
from backend.app.avatar_policy import default_settings
from backend.app.db import get_db
from backend.app.student_auth import issue_student_token


STUDENT = "10000000-0000-4000-8000-000000000001"
OTHER_STUDENT = "10000000-0000-4000-8000-000000000002"
EXAM = "20000000-0000-4000-8000-000000000001"
OTHER_EXAM = "20000000-0000-4000-8000-000000000002"
SESSION = "30000000-0000-4000-8000-000000000001"
OTHER_SESSION = "30000000-0000-4000-8000-000000000002"
URL = f"/exam/sessions/{SESSION}/presentation"
RASTER = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\nsynthetic-private-upload").decode()


def editable_settings():
    settings = default_settings().model_dump()
    settings["student"].update(avatar=True, background=True, speed=True)
    return settings


def preferences():
    return {"volume": 40, "textSize": 20, "reducedMotion": False,
            "avatar": "geometric", "background": "library", "speed": 1.1}


def headers(**claims):
    token = issue_student_token(student_id=claims.get("student", STUDENT),
        exam_template_id=claims.get("exam", EXAM), purpose=claims.get("purpose", "student_session"),
        session_id=claims.get("session", SESSION))
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def api(monkeypatch):
    monkeypatch.setenv("AUTH_SECRET_KEY", "synthetic-avatar-session-secret-at-least-32-characters")
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    with engine.begin() as db:
        db.execute(text("""CREATE TABLE exam_avatar_policies (
            exam_template_id TEXT PRIMARY KEY, settings TEXT NOT NULL, revision INTEGER NOT NULL,
            exam_mode TEXT NOT NULL DEFAULT 'assessed')"""))
        db.execute(text("""CREATE TABLE exam_sessions (
            id TEXT PRIMARY KEY, student_id TEXT NOT NULL, exam_template_id TEXT NOT NULL,
            status TEXT NOT NULL, avatar_policy_snapshot TEXT, avatar_policy_revision INTEGER DEFAULT 0,
            avatar_exam_mode TEXT NOT NULL DEFAULT 'assessed',
            avatar_preferences TEXT DEFAULT '{}', started_at TEXT, ended_at TEXT,
            time_limit_minutes INTEGER, question_time_limit_minutes INTEGER, extended_time_multiplier NUMERIC)"""))
        settings = json.dumps(editable_settings())
        db.execute(text("INSERT INTO exam_avatar_policies VALUES (:exam, :settings, 3, 'assessed')"),
                   {"exam": EXAM, "settings": settings})
        db.execute(text("""INSERT INTO exam_sessions (id, student_id, exam_template_id, status,
            avatar_policy_snapshot, avatar_policy_revision, started_at,
            time_limit_minutes, question_time_limit_minutes, extended_time_multiplier)
            VALUES (:session, :student, :exam, 'in_progress', :settings, 3,
                    '2026-01-01T00:00:00+00:00', 30, 2, 1.5)"""),
                   {"session": SESSION, "student": STUDENT, "exam": EXAM, "settings": settings})
    sessions = sessionmaker(bind=engine)
    app = FastAPI()
    app.include_router(avatar_session.router)

    def isolated_db():
        with sessions() as db:
            yield db

    app.dependency_overrides[get_db] = isolated_db
    with TestClient(app) as client:
        yield client, engine, sessions
    engine.dispose()


def session_record(engine):
    with engine.connect() as db:
        return dict(db.execute(text("SELECT * FROM exam_sessions WHERE id = :id"),
                               {"id": SESSION}).mappings().one())


def replace_snapshot(engine, settings):
    with engine.begin() as db:
        db.execute(text("UPDATE exam_sessions SET avatar_policy_snapshot = :settings WHERE id = :id"),
                   {"settings": json.dumps(settings), "id": SESSION})


def test_student_view_is_whitelisted_and_get_has_no_side_effects(api):
    client, engine, _ = api
    before = session_record(engine)
    response = client.get(URL, headers=headers())
    assert response.status_code == 200
    data = response.json()
    assert set(data) == {"session_id", "revision", "policy", "voice_profile", "preferences"}
    assert data["session_id"] == SESSION
    assert data["revision"] == 3
    assert data["voice_profile"] == "clear"
    assert set(data["policy"]) == {"defaults", "allowAvatar", "allowBackground", "allowSpeed",
                                  "avatarChoices", "backgroundChoices", "minSpeed", "maxSpeed"}
    assert set(data["policy"]["defaults"]) == {"avatar", "background", "customAvatar", "customBackground",
                                               "voiceLabel", "speed", "reducedMotion", "animation"}
    for private in ("assistance", "behavior", "rubric", "model_reasoning", "mode"):
        assert private not in data and private not in data["policy"]
    assert session_record(engine) == before


def test_session_uses_immutable_snapshot_after_professor_changes_or_policy_table_loss(api):
    client, engine, _ = api
    before = client.get(URL, headers=headers()).json()
    changed = default_settings().model_dump()
    changed["presentation"].update(avatar="geometric", voice="clear", speed=1.5)
    with engine.begin() as db:
        db.execute(text("UPDATE exam_avatar_policies SET settings = :settings, revision = 4"),
                   {"settings": json.dumps(changed)})
    assert client.get(URL, headers=headers()).json() == before
    with engine.begin() as db:
        db.execute(text("DROP TABLE exam_avatar_policies"))
    assert client.get(URL, headers=headers()).json() == before


def test_legacy_null_snapshot_uses_revision_zero_defaults_without_changing_clocks(api):
    client, engine, _ = api
    with engine.begin() as db:
        db.execute(text("""UPDATE exam_sessions SET avatar_policy_snapshot = NULL,
            avatar_policy_revision = 0 WHERE id = :id"""), {"id": SESSION})
    before = session_record(engine)
    response = client.get(URL, headers=headers())
    assert response.status_code == 200
    data = response.json()
    assert data["revision"] == 0
    assert data["voice_profile"] == "calm"
    assert data["policy"]["defaults"]["avatar"] == "guide"
    assert data["policy"]["allowAvatar"] is False
    assert data["preferences"]["avatar"] == "guide"
    assert session_record(engine) == before


@pytest.mark.parametrize("claims,status", [
    ({"session": OTHER_SESSION}, 403), ({"student": OTHER_STUDENT}, 403),
    ({"exam": OTHER_EXAM}, 403), ({"purpose": "student_exam"}, 403),
])
def test_cross_session_student_exam_or_token_purpose_is_denied(api, claims, status):
    client, engine, _ = api
    before = session_record(engine)
    assert client.get(URL, headers=headers(**claims)).status_code == status
    assert client.put(URL, json=preferences(), headers=headers(**claims)).status_code == status
    assert session_record(engine) == before


def test_missing_or_invalid_bearer_cannot_access_student_presentation(api):
    client, _, _ = api
    for authorization in (None, "Bearer not-a-token", "Basic synthetic"):
        auth = {} if authorization is None else {"Authorization": authorization}
        assert client.get(URL, headers=auth).status_code == 401
        assert client.put(URL, headers=auth, json=preferences()).status_code == 401


def test_validly_scoped_token_for_missing_session_returns_not_found(api):
    client, engine, _ = api
    before = session_record(engine)
    url = f"/exam/sessions/{OTHER_SESSION}/presentation"
    auth = headers(session=OTHER_SESSION)
    assert client.get(url, headers=auth).status_code == 404
    assert client.put(url, headers=auth, json=preferences()).status_code == 404
    assert session_record(engine) == before


def test_preference_save_persists_only_preferences_and_preserves_policy_timer_ods_fields(api):
    client, engine, _ = api
    before = session_record(engine)
    response = client.put(URL, headers=headers(), json=preferences())
    assert response.status_code == 200
    assert response.json()["preferences"] == preferences()
    assert client.get(URL, headers=headers()).json() == response.json()
    after = session_record(engine)
    assert json.loads(after.pop("avatar_preferences")) == preferences()
    before.pop("avatar_preferences")
    assert after == before


@pytest.mark.parametrize("field,value", [
    ("volume", -1), ("volume", 101), ("volume", True), ("volume", "40"),
    ("textSize", 18), ("textSize", 20.0), ("textSize", True),
    ("reducedMotion", 1), ("reducedMotion", "true"),
    ("avatar", "unknown"), ("background", "unknown"),
    ("speed", 0.7), ("speed", 1.3), ("speed", True), ("speed", "1.1"),
])
def test_invalid_preferences_cannot_replace_saved_preferences(api, field, value):
    client, engine, _ = api
    assert client.put(URL, headers=headers(), json=preferences()).status_code == 200
    before = session_record(engine)
    body = preferences()
    body[field] = value
    assert client.put(URL, headers=headers(), json=body).status_code in (400, 403, 422)
    assert session_record(engine) == before


@pytest.mark.parametrize("field,value", [("voice", "clear"), ("mode", "practice"),
                                         ("policy", {}), ("revision", 999), ("student_id", OTHER_STUDENT)])
def test_preference_body_cannot_supply_rules_voice_or_identity(api, field, value):
    client, engine, _ = api
    before = session_record(engine)
    body = preferences()
    body[field] = value
    assert client.put(URL, headers=headers(), json=body).status_code == 422
    assert session_record(engine) == before


@pytest.mark.parametrize("missing", ["volume", "textSize", "reducedMotion", "avatar", "background", "speed"])
def test_preference_save_requires_full_explicit_preferences(api, missing):
    client, engine, _ = api
    before = session_record(engine)
    body = preferences()
    del body[missing]
    assert client.put(URL, headers=headers(), json=body).status_code == 422
    assert session_record(engine) == before


def test_locked_snapshot_uses_defaults_and_rejects_restricted_preference_changes(api):
    client, engine, _ = api
    replace_snapshot(engine, default_settings().model_dump())
    response = client.get(URL, headers=headers())
    assert response.status_code == 200
    actual = response.json()["preferences"]
    assert actual["avatar"] == "guide" and actual["background"] == "neutral" and actual["speed"] == 1
    before = session_record(engine)
    assert client.put(URL, headers=headers(), json=preferences()).status_code in (400, 403, 422)
    assert session_record(engine) == before


def test_stored_preferences_inconsistent_with_immutable_snapshot_fail_closed(api):
    client, engine, _ = api
    replace_snapshot(engine, default_settings().model_dump())
    with engine.begin() as db:
        db.execute(text("UPDATE exam_sessions SET avatar_preferences = :prefs WHERE id = :id"),
                   {"prefs": json.dumps(preferences()), "id": SESSION})
    response = client.get(URL, headers=headers())
    assert response.status_code == 503
    before = session_record(engine)
    assert client.put(URL, headers=headers(), json=preferences()).status_code == 503
    assert session_record(engine) == before


def test_professor_required_reduced_motion_cannot_be_disabled(api):
    client, engine, _ = api
    settings = editable_settings()
    settings["presentation"]["reducedMotion"] = True
    replace_snapshot(engine, settings)
    assert client.get(URL, headers=headers()).json()["preferences"]["reducedMotion"] is True
    before = session_record(engine)
    assert client.put(URL, headers=headers(), json=preferences()).status_code in (400, 403, 422)
    assert session_record(engine) == before
    allowed = {**preferences(), "reducedMotion": True}
    assert client.put(URL, headers=headers(), json=allowed).status_code == 200


@pytest.mark.parametrize("selectable", [False, True])
def test_custom_images_released_only_when_selected_or_available_to_student(api, selectable):
    client, engine, _ = api
    settings = editable_settings()
    settings["presentation"].update(customAvatar=RASTER, customBackground=RASTER)
    if selectable:
        settings["student"]["avatars"].append("custom")
        settings["student"]["backgrounds"].append("custom")
    replace_snapshot(engine, settings)
    response = client.get(URL, headers=headers())
    assert response.status_code == 200
    defaults = response.json()["policy"]["defaults"]
    assert defaults["customAvatar"] == (RASTER if selectable else None)
    assert defaults["customBackground"] == (RASTER if selectable else None)


def test_selected_locked_custom_image_remains_available(api):
    client, engine, _ = api
    settings = default_settings().model_dump()
    settings["presentation"].update(avatar="custom", background="custom",
                                     customAvatar=RASTER, customBackground=RASTER)
    replace_snapshot(engine, settings)
    response = client.get(URL, headers=headers())
    assert response.status_code == 200
    data = response.json()
    assert data["policy"]["defaults"]["customAvatar"] == RASTER
    assert data["policy"]["defaults"]["customBackground"] == RASTER
    assert data["preferences"]["avatar"] == "custom"
    assert data["preferences"]["background"] == "custom"


def test_completed_attempt_presentation_can_be_read_but_preferences_are_read_only(api):
    client, engine, _ = api
    with engine.begin() as db:
        db.execute(text("UPDATE exam_sessions SET status = 'pending_grading' WHERE id = :id"), {"id": SESSION})
    before = session_record(engine)
    assert client.get(URL, headers=headers()).status_code == 200
    assert client.put(URL, headers=headers(), json=preferences()).status_code == 409
    assert session_record(engine) == before


@pytest.mark.parametrize("raw", ["not-json", "{}", '{"presentation":{"avatar":"unknown"}}'])
def test_corrupt_snapshot_fails_closed_without_loading_live_professor_policy(api, raw):
    client, engine, _ = api
    with engine.begin() as db:
        db.execute(text("UPDATE exam_sessions SET avatar_policy_snapshot = :raw WHERE id = :id"),
                   {"raw": raw, "id": SESSION})
    before = session_record(engine)
    assert client.get(URL, headers=headers()).status_code == 503
    assert session_record(engine) == before


def test_snapshot_for_exam_returns_independent_defaults_without_inserting_policy(api):
    _, engine, sessions = api
    with engine.begin() as db:
        db.execute(text("DELETE FROM exam_avatar_policies"))
    with sessions() as db:
        first, revision, mode = avatar_session.snapshot_for_exam(db, UUID(EXAM))
        first.presentation.avatar = "geometric"
        second, second_revision, second_mode = avatar_session.snapshot_for_exam(db, UUID(EXAM))
        assert revision == second_revision == 0
        assert mode == second_mode == 'assessed'
        assert second.presentation.avatar == "guide"
        assert db.execute(text("SELECT count(*) FROM exam_avatar_policies")).scalar_one() == 0


def test_snapshot_for_exam_returns_saved_validated_policy_revision(api):
    _, _, sessions = api
    with sessions() as db:
        settings, revision, mode = avatar_session.snapshot_for_exam(db, UUID(EXAM))
    assert revision == 3
    assert mode == 'assessed'
    assert settings.model_dump() == editable_settings()


@pytest.mark.parametrize("fault", ["missing-table", "corrupt-settings"])
def test_snapshot_for_exam_refuses_missing_storage_or_corrupt_policy(api, fault):
    _, engine, sessions = api
    with engine.begin() as db:
        if fault == "missing-table":
            db.execute(text("DROP TABLE exam_avatar_policies"))
        else:
            db.execute(text("UPDATE exam_avatar_policies SET settings = '{}'"))
    with sessions() as db, pytest.raises(HTTPException) as error:
        avatar_session.snapshot_for_exam(db, UUID(EXAM))
    assert error.value.status_code == 503
