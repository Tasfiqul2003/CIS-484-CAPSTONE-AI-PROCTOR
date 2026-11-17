"""Synthetic tests for recording settings and student consent; no application DB."""
from datetime import datetime, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.auth import require_professor
from backend.app.db import get_db
from backend.app.recording_settings import router
from backend.app import recording_settings


EXAM = "20000000-0000-4000-8000-000000000001"
SESSION = "30000000-0000-4000-8000-000000000001"
STUDENT = "10000000-0000-4000-8000-000000000001"
OWNER = "40000000-0000-4000-8000-000000000001"
OTHER = "50000000-0000-4000-8000-000000000001"

SETTINGS_URL = f"/exam/templates/{EXAM}/recording-settings"
CONSENT_URL = f"/exam/sessions/{SESSION}/recording-consent"
NOTIFICATIONS_URL = "/auth/professor/recording-notifications"


class Result:
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
    def __init__(self):
        self.template = {
            "id": EXAM,
            "professor_id": OWNER,
            "record_examination": True,
            "generate_transcript": True,
            "title": "Synthetic Exam",
            "course": "CIS 484",
        }
        self.session = {
            "id": SESSION,
            "student_id": STUDENT,
            "exam_template_id": EXAM,
            "status": "in_progress",
            "record_examination": True,
            "recording_consent_status": "pending",
            "developer_demo": False,
            "time_limit_minutes": 30,
            "question_time_limit_minutes": 3,
            "extended_time_multiplier": 1,
            "avatar_policy_snapshot": None,
            "avatar_policy_revision": 0,
        }
        self.student = {
            "name": "Synthetic Student",
            "eid": "synthetic1",
        }
        self.notifications = []
        self.commits = 0
        self.rollbacks = 0

    def execute(self, statement, params=None):
        sql = str(statement)
        params = params or {}

        if "FROM exam_templates" in sql and "SELECT id, record_examination" in sql:
            if (
                self.template["id"] == params["exam_id"]
                and self.template["professor_id"] == params["professor_id"]
            ):
                return Result({
                    "id": self.template["id"],
                    "record_examination": self.template["record_examination"],
                    "generate_transcript": self.template["generate_transcript"],
                })
            return Result()

        if "UPDATE exam_templates" in sql:
            if (
                self.template["id"] != params["exam_id"]
                or self.template["professor_id"] != params["professor_id"]
            ):
                return Result()

            self.template["record_examination"] = params["record_examination"]
            self.template["generate_transcript"] = params["generate_transcript"]
            return Result({
                "record_examination": self.template["record_examination"],
                "generate_transcript": self.template["generate_transcript"],
            })

        if "FROM exam_sessions" in sql and "SELECT id, student_id" in sql:
            if self.session["id"] == params["session_id"]:
                return Result(dict(self.session))
            return Result()

        if "UPDATE exam_sessions" in sql:
            if (
                self.session["id"] != params["session_id"]
                or self.session["student_id"] != params["student_id"]
                or self.session["recording_consent_status"] != "pending"
                or self.session["status"] != "in_progress"
            ):
                return Result()

            self.session["recording_consent_status"] = params["status"]
            self.session["recording_consent_decided_at"] = datetime.now(timezone.utc)
            self.session["started_at"] = datetime.now(timezone.utc)
            return Result({
                "recording_consent_status": params["status"],
                "recording_consent_decided_at":
                    self.session["recording_consent_decided_at"],
                "started_at": self.session["started_at"],
            })

        if "UPDATE interactions" in sql:
            self.first_question_started_at = params["started_at"]
            return Result()

        if "INSERT INTO recording_consent_notifications" in sql:
            if not any(
                item["exam_session_id"] == self.session["id"]
                and item["event_type"] == "recording_declined"
                for item in self.notifications
            ):
                self.notifications.append({
                    "id": "60000000-0000-4000-8000-000000000001",
                    "professor_id": self.template["professor_id"],
                    "exam_template_id": self.template["id"],
                    "exam_session_id": self.session["id"],
                    "student_id": self.session["student_id"],
                    "event_type": "recording_declined",
                    "created_at": datetime.now(timezone.utc),
                })
            return Result()

        if "FROM recording_consent_notifications" in sql:
            professor_id = params["professor_id"]
            rows = []

            for notification in self.notifications:
                if notification["professor_id"] != professor_id:
                    continue

                rows.append({
                    "id": notification["id"],
                    "event_type": notification["event_type"],
                    "created_at": notification["created_at"],
                    "exam_id": self.template["id"],
                    "exam_title": self.template["title"],
                    "course": self.template["course"],
                    "student_name": self.student["name"],
                    "student_eid": self.student["eid"],
                })

            return Result(rows=rows)

        raise AssertionError(f"Unexpected SQL in recording test: {sql}")

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


@pytest.fixture
def api():
    db = FakeDB()
    app = FastAPI()
    app.include_router(router)

    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[require_professor] = lambda: {
        "role": "professor",
        "professor_id": OWNER,
    }

    with TestClient(app) as client:
        yield client, app, db


def install_student_token(monkeypatch, *, session_id=SESSION,
                          student_id=STUDENT, exam_id=EXAM):
    claims = {
        "sub": student_id,
        "session_id": session_id,
        "exam_template_id": exam_id,
    }
    monkeypatch.setattr(
        recording_settings,
        "read_student_token",
        lambda *args, **kwargs: claims,
    )


def test_load_and_save_recording_settings(api):
    client, _, db = api

    response = client.get(SETTINGS_URL)
    assert response.status_code == 200
    assert response.json() == {
        "record_examination": True,
        "generate_transcript": True,
    }

    response = client.put(
        SETTINGS_URL,
        json={
            "record_examination": False,
            "generate_transcript": True,
        },
    )
    assert response.status_code == 200
    assert response.json() == {
        "record_examination": False,
        "generate_transcript": True,
    }

    assert db.template["record_examination"] is False
    assert db.template["generate_transcript"] is True
    assert db.commits == 1


def test_template_setting_changes_preserve_existing_session_snapshot(api):
    client, _, db = api
    response = client.put(SETTINGS_URL, json={
        'record_examination': False, 'generate_transcript': False,
    })
    assert response.status_code == 200
    assert db.session['record_examination'] is True
    assert db.session['recording_consent_status'] == 'pending'


def test_consent_deadlines_use_saved_exam_extension_and_question_window():
    started = datetime(2026, 1, 1, tzinfo=timezone.utc)
    timing = recording_settings.consent_timing({
        'started_at': started, 'time_limit_minutes': 30,
        'extended_time_multiplier': 2, 'question_time_limit_minutes': 3,
        'avatar_policy_snapshot': None, 'avatar_policy_revision': 0,
    })
    assert timing['deadline'] == '2026-01-01T01:00:00+00:00'
    assert timing['question_deadline'] == '2026-01-01T00:03:00+00:00'
    assert timing['server_now']


@pytest.mark.parametrize("value", [0, 1, "true", None, 1.5])
def test_invalid_recording_setting_values_do_not_write(api, value):
    client, _, db = api

    response = client.put(
        SETTINGS_URL,
        json={
            "record_examination": value,
            "generate_transcript": True,
        },
    )

    assert response.status_code == 422
    assert db.template["record_examination"] is True
    assert db.commits == 0


def test_extra_setting_fields_are_rejected(api):
    client, _, db = api

    response = client.put(
        SETTINGS_URL,
        json={
            "record_examination": True,
            "generate_transcript": True,
            "record_video": True,
        },
    )

    assert response.status_code == 422
    assert db.commits == 0


@pytest.mark.parametrize("method", ["get", "put"])
def test_other_professor_cannot_access_recording_settings(api, method):
    client, app, _ = api
    app.dependency_overrides[require_professor] = lambda: {
        "role": "professor",
        "professor_id": OTHER,
    }

    kwargs = {
        "json": {
            "record_examination": False,
            "generate_transcript": False,
        }
    } if method == "put" else {}

    response = getattr(client, method)(SETTINGS_URL, **kwargs)
    assert response.status_code == 404


def test_declining_consent_saves_decision_and_creates_notification(
    api, monkeypatch
):
    client, _, db = api
    install_student_token(monkeypatch)

    response = client.post(
        CONSENT_URL,
        json={"consent": False},
        headers={"Authorization": "Bearer synthetic-token"},
    )

    assert response.status_code == 200
    result = response.json()
    assert result["recording_consent_status"] == "declined"
    assert result["recording_enabled"] is False
    assert result["decided_at"]

    assert db.session["recording_consent_status"] == "declined"
    assert db.session["recording_consent_decided_at"] is not None
    assert len(db.notifications) == 1
    assert db.commits == 1


def test_declining_consent_does_not_block_exam_session(
    api, monkeypatch
):
    client, _, db = api
    install_student_token(monkeypatch)

    response = client.post(
        CONSENT_URL,
        json={"consent": False},
        headers={"Authorization": "Bearer synthetic-token"},
    )

    assert response.status_code == 200
    assert db.session["status"] == "in_progress"


def test_repeated_decline_is_idempotent_and_notification_is_not_duplicated(
    api, monkeypatch
):
    client, _, db = api
    install_student_token(monkeypatch)
    headers = {"Authorization": "Bearer synthetic-token"}

    first = client.post(CONSENT_URL, json={"consent": False}, headers=headers)
    second = client.post(CONSENT_URL, json={"consent": False}, headers=headers)

    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json()["recording_consent_status"] == "declined"
    assert len(db.notifications) == 1


def test_student_cannot_reverse_consent_decision(api, monkeypatch):
    client, _, db = api
    install_student_token(monkeypatch)
    headers = {"Authorization": "Bearer synthetic-token"}

    first = client.post(CONSENT_URL, json={"consent": False}, headers=headers)
    second = client.post(CONSENT_URL, json={"consent": True}, headers=headers)

    assert first.status_code == 200
    assert second.status_code == 409
    assert db.session["recording_consent_status"] == "declined"


def test_accepting_consent_does_not_create_decline_notification(
    api, monkeypatch
):
    client, _, db = api
    install_student_token(monkeypatch)

    response = client.post(
        CONSENT_URL,
        json={"consent": True},
        headers={"Authorization": "Bearer synthetic-token"},
    )

    assert response.status_code == 200
    assert response.json()["recording_consent_status"] == "consented"
    assert response.json()["recording_enabled"] is True
    assert db.session["recording_consent_status"] == "consented"
    assert db.notifications == []


def test_consent_token_must_match_session(api, monkeypatch):
    client, _, db = api
    install_student_token(monkeypatch, session_id=OTHER)

    response = client.post(
        CONSENT_URL,
        json={"consent": True},
        headers={"Authorization": "Bearer synthetic-token"},
    )

    assert response.status_code == 403
    assert db.session["recording_consent_status"] == "pending"


def test_demo_session_does_not_require_consent(api, monkeypatch):
    client, _, db = api
    db.session["developer_demo"] = True
    install_student_token(monkeypatch)

    response = client.post(
        CONSENT_URL,
        json={"consent": True},
        headers={"Authorization": "Bearer synthetic-token"},
    )

    assert response.status_code == 200
    assert response.json()["recording_consent_status"] == "not_required"
    assert response.json()["recording_enabled"] is False
    assert db.session["recording_consent_status"] == "pending"
    assert db.notifications == []


def test_recording_disabled_session_does_not_require_consent(
    api, monkeypatch
):
    client, _, db = api
    db.session["record_examination"] = False
    install_student_token(monkeypatch)

    response = client.post(
        CONSENT_URL,
        json={"consent": True},
        headers={"Authorization": "Bearer synthetic-token"},
    )

    assert response.status_code == 200
    assert response.json()["recording_consent_status"] == "not_required"
    assert response.json()["recording_enabled"] is False
    assert db.session["recording_consent_status"] == "pending"


def test_professor_can_view_decline_notification(api, monkeypatch):
    client, _, _ = api
    install_student_token(monkeypatch)

    consent = client.post(
        CONSENT_URL,
        json={"consent": False},
        headers={"Authorization": "Bearer synthetic-token"},
    )
    assert consent.status_code == 200

    response = client.get(NOTIFICATIONS_URL)
    assert response.status_code == 200
    notifications = response.json()

    assert len(notifications) == 1
    assert notifications[0]["event_type"] == "recording_declined"
    assert notifications[0]["exam_id"] == EXAM
    assert notifications[0]["exam_title"] == "Synthetic Exam"
    assert notifications[0]["course"] == "CIS 484"
    assert notifications[0]["student_name"] == "Synthetic Student"
    assert notifications[0]["student_eid"] == "synthetic1"
    assert notifications[0]["created_at"]


def test_notification_endpoint_is_scoped_to_professor(api):
    client, app, db = api
    db.notifications.append({
        "id": "60000000-0000-4000-8000-000000000001",
        "professor_id": OTHER,
        "exam_template_id": EXAM,
        "exam_session_id": SESSION,
        "student_id": STUDENT,
        "event_type": "recording_declined",
        "created_at": datetime.now(timezone.utc),
    })

    response = client.get(NOTIFICATIONS_URL)
    assert response.status_code == 200
    assert response.json() == []
