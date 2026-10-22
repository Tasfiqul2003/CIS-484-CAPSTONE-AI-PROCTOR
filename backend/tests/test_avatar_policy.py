"""Synthetic API tests; never load DATABASE_URL or use the application database.

Run from the repository root with:
    .venv/Scripts/python.exe -m pytest backend/tests/test_avatar_policy.py -q
SQLite verifies route, transaction and persistence behavior. Deployment still
requires applying and validating the separate PostgreSQL migration.
"""

import base64
import copy
import json
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import sessionmaker

from backend.app.auth import get_current_account
from backend.app.avatar_policy import AvatarSettings, default_settings, router
from backend.app.db import get_db

PROFESSOR = "10000000-0000-4000-8000-000000000001"
OTHER_PROFESSOR = "10000000-0000-4000-8000-000000000002"
EXAM = "20000000-0000-4000-8000-000000000001"
OTHER_EXAM = "20000000-0000-4000-8000-000000000002"
URL = f"/exam/templates/{EXAM}/avatar-policy"
ACCOUNT = {"id": "synthetic-account", "role": "professor", "professor_id": PROFESSOR}


@pytest.fixture
def api(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'synthetic-policies.sqlite'}", connect_args={"check_same_thread": False})

    @event.listens_for(engine, "connect")
    def foreign_keys(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")

    with engine.begin() as db:
        db.execute(text("CREATE TABLE exam_templates (id TEXT PRIMARY KEY, professor_id TEXT NOT NULL)"))
        db.execute(text("""
            CREATE TABLE exam_avatar_policies (
                exam_template_id TEXT PRIMARY KEY REFERENCES exam_templates(id) ON DELETE CASCADE,
                settings TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision >= 1), updated_at TEXT NOT NULL
            )
        """))
        db.execute(text("INSERT INTO exam_templates (id, professor_id) VALUES (:id, :professor_id)"), [
            {"id": EXAM, "professor_id": PROFESSOR},
            {"id": OTHER_EXAM, "professor_id": OTHER_PROFESSOR},
        ])
    sessions = sessionmaker(bind=engine)
    app = FastAPI()
    app.include_router(router)

    def isolated_db():
        with sessions() as session:
            yield session

    app.dependency_overrides[get_db] = isolated_db
    app.dependency_overrides[get_current_account] = lambda: dict(ACCOUNT)
    with TestClient(app) as client:
        yield client, app, engine
    engine.dispose()


def payload(revision=0):
    return {"settings": default_settings().model_dump(), "expected_revision": revision}


def test_default_policy_does_not_write_and_is_independent(api):
    client, _, engine = api
    first = client.get(URL)
    assert first.status_code == 200
    data = first.json()
    assert data == {
        "exam_id": EXAM, "revision": 0, "settings": default_settings().model_dump(),
        "effective_for": "new_attempts", "assistance_scope": "per_question", "updated_at": None,
    }
    data["settings"]["presentation"]["avatar"] = "geometric"
    assert client.get(URL).json()["settings"]["presentation"]["avatar"] == "guide"
    with engine.connect() as db:
        assert db.execute(text("SELECT COUNT(*) FROM exam_avatar_policies")).scalar_one() == 0


def test_save_reload_update_and_per_exam_persistence(api):
    client, app, engine = api
    body = payload()
    body["settings"]["student"]["avatar"] = True
    body["settings"]["presentation"]["avatar"] = "geometric"
    saved = client.put(URL, json=body)
    assert saved.status_code == 200, saved.text
    assert saved.json()["revision"] == 1
    assert saved.json()["settings"] == body["settings"]
    assert saved.json()["updated_at"]
    # Every request opens a new database session; another browser context can
    # retrieve the policy without any local browser preference storage.
    with TestClient(app) as another_browser:
        assert another_browser.get(URL).json() == saved.json()
    body["expected_revision"] = 1
    body["settings"]["presentation"]["voice"] = "clear"
    updated = client.put(URL, json=body)
    assert updated.status_code == 200
    assert updated.json()["revision"] == 2
    app.dependency_overrides[get_current_account] = lambda: {**ACCOUNT, "professor_id": OTHER_PROFESSOR}
    other = client.get(f"/exam/templates/{OTHER_EXAM}/avatar-policy").json()
    assert other["revision"] == 0
    with engine.connect() as db:
        row = db.execute(text("SELECT settings, revision FROM exam_avatar_policies WHERE exam_template_id = :id"), {"id": EXAM}).mappings().one()
        assert row["revision"] == 2
        assert json.loads(row["settings"])["presentation"]["voice"] == "clear"


@pytest.mark.parametrize("stale_revision", [0, 2, 999])
def test_stale_or_missing_revision_cannot_replace_policy(api, stale_revision):
    client, _, _ = api
    before = client.put(URL, json=payload()).json()
    replacement = payload(stale_revision)
    replacement["settings"]["presentation"]["avatar"] = "geometric"
    conflict = client.put(URL, json=replacement)
    assert conflict.status_code == 409
    assert client.get(URL).json() == before


@pytest.mark.parametrize("method", ["get", "put"])
def test_anonymous_requests_require_authentication(api, method):
    client, app, _ = api
    del app.dependency_overrides[get_current_account]
    request = getattr(client, method)
    response = request(URL, **({"json": payload()} if method == "put" else {}))
    assert response.status_code == 401


@pytest.mark.parametrize("role", ["admin", "student"])
def test_only_professor_role_can_access_policy(api, role):
    client, app, _ = api
    app.dependency_overrides[get_current_account] = lambda: {**ACCOUNT, "role": role}
    assert client.get(URL).status_code == 403
    assert client.put(URL, json=payload()).status_code == 403


def test_unlinked_professor_and_other_owner_are_rejected(api):
    client, app, engine = api
    other_url = f"/exam/templates/{OTHER_EXAM}/avatar-policy"
    assert client.get(other_url).status_code == 404
    assert client.put(other_url, json=payload()).status_code == 404
    missing_url = f"/exam/templates/{UUID(int=99)}/avatar-policy"
    assert client.get(missing_url).status_code == 404
    app.dependency_overrides[get_current_account] = lambda: {**ACCOUNT, "professor_id": None}
    assert client.get(URL).status_code == 403
    assert client.put(URL, json=payload()).status_code == 403
    with engine.connect() as db:
        assert db.execute(text("SELECT COUNT(*) FROM exam_avatar_policies")).scalar_one() == 0


def test_missing_migration_has_actionable_error_without_ownership_leak(api):
    client, _, engine = api
    with engine.begin() as db:
        db.execute(text("DROP TABLE exam_avatar_policies"))
    for response in (client.get(URL), client.put(URL, json=payload())):
        assert response.status_code == 503
        assert "006_exam_avatar_policy.sql" in response.json()["detail"]
    assert client.get(f"/exam/templates/{OTHER_EXAM}/avatar-policy").status_code == 404


@pytest.mark.parametrize("path,value", [
    (("expected_revision",), True),
    (("expected_revision",), -1),
    (("expected_revision",), "0"),
    (("settings", "presentation", "speed"), True),
    (("settings", "presentation", "speed"), "1"),
    (("settings", "presentation", "speed"), 2.1),
    (("settings", "presentation", "animation"), 1),
    (("settings", "presentation", "stateLabels"), False),
    (("settings", "presentation", "avatar"), "unknown"),
    (("settings", "presentation", "voice"), "unknown"),
    (("settings", "student", "avatar"), "true"),
    (("settings", "student", "avatars"), ["guide", "guide"]),
    (("settings", "student", "backgrounds"), ["unknown"]),
    (("settings", "student", "minSpeed"), 1.5),
    (("settings", "assistance", "repeat", "limit"), 11),
    (("settings", "assistance", "repeat", "limit"), -1),
    (("settings", "assistance", "repeat", "limit"), 1.5),
    (("settings", "assistance", "repeat", "limit"), True),
    (("settings", "assistance", "repeat", "limit"), 0),
    (("settings", "assistance", "hint", "modes"), "student_decides"),
    (("settings", "behavior", "followUps"), 6),
    (("settings", "behavior", "responseSeconds"), 9),
    (("settings", "behavior", "responseUnit"), "hours"),
])
def test_invalid_limits_types_and_choices_are_rejected(api, path, value):
    client, _, _ = api
    body = payload()
    current = body
    for key in path[:-1]:
        current = current[key]
    current[path[-1]] = value
    assert client.put(URL, json=body).status_code == 422
    assert client.get(URL).json()["revision"] == 0


@pytest.mark.parametrize("section,field", [
    (None, "student_id"), ("settings", "difficulty"),
    ("presentation", "volume"), ("student", "voice"),
    ("assistance", "answer"), ("behavior", "difficulty"),
    ("repeat", "remaining"),
])
def test_unknown_fields_are_rejected_at_every_boundary(api, section, field):
    client, _, _ = api
    body = payload()
    if section is None:
        target = body
    elif section == "settings":
        target = body["settings"]
    elif section == "repeat":
        target = body["settings"]["assistance"]["repeat"]
    else:
        target = body["settings"][section]
    target[field] = "untrusted"
    assert client.put(URL, json=body).status_code == 422


@pytest.mark.parametrize("change", ["empty_avatar", "missing_avatar_default", "missing_background_default", "speed_outside_range", "custom_without_image"])
def test_enabled_choices_require_consistent_defaults(api, change):
    client, _, _ = api
    body = payload()
    settings = body["settings"]
    if change == "empty_avatar":
        settings["student"].update(avatar=True, avatars=[])
    elif change == "missing_avatar_default":
        settings["student"].update(avatar=True, avatars=["geometric"])
    elif change == "missing_background_default":
        settings["student"].update(background=True, backgrounds=["library"])
    elif change == "speed_outside_range":
        settings["student"].update(speed=True, minSpeed=1.1)
    else:
        settings["student"]["avatars"] = ["custom"]
    assert client.put(URL, json=body).status_code == 422


@pytest.mark.parametrize("image", [
    "https://example.invalid/photo.png", "data:image/svg+xml;base64,PHN2Zy8+",
    "data:image/png;base64,aGVsbG8=", "data:image/png;base64,not-base64",
    "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"x" * 1_048_576).decode(),
], ids=["remote", "svg", "forged", "malformed", "oversized"])
def test_invalid_remote_executable_forged_or_oversized_images_are_rejected(api, image):
    client, _, _ = api
    body = payload()
    body["settings"]["presentation"].update(avatar="custom", customAvatar=image)
    assert client.put(URL, json=body).status_code == 422


@pytest.mark.parametrize("mime,synthetic_bytes", [
    ("png", b"\x89PNG\r\n\x1a\nsynthetic"),
    ("jpeg", b"\xff\xd8\xffsynthetic"),
    ("webp", b"RIFF\x00\x00\x00\x00WEBPsynthetic"),
])
def test_bounded_raster_data_urls_and_selected_custom_choices_round_trip(api, mime, synthetic_bytes):
    client, _, _ = api
    image = f"data:image/{mime};base64," + base64.b64encode(synthetic_bytes).decode()
    body = payload()
    body["settings"]["presentation"].update(avatar="custom", background="custom", customAvatar=image, customBackground=image)
    body["settings"]["student"].update(avatar=True, background=True, avatars=["custom"], backgrounds=["custom"])
    response = client.put(URL, json=body)
    assert response.status_code == 200, response.text
    assert client.get(URL).json()["settings"] == body["settings"]


def test_non_finite_values_rejected_before_persistence():
    for value in (float("nan"), float("inf"), -float("inf")):
        data = copy.deepcopy(default_settings().model_dump())
        data["presentation"]["speed"] = value
        with pytest.raises(ValidationError):
            AvatarSettings.model_validate(data)


def test_policy_deleted_with_exam_in_isolated_database(api):
    client, _, engine = api
    assert client.put(URL, json=payload()).status_code == 200
    with engine.begin() as db:
        db.execute(text("DELETE FROM exam_templates WHERE id = :id"), {"id": EXAM})
        assert db.execute(text("SELECT COUNT(*) FROM exam_avatar_policies")).scalar_one() == 0
    assert client.get(URL).status_code == 404
