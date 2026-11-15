"""Professor avatar routes: each professor sees and changes only their own avatar. No real avatar service."""
import asyncio

from fastapi import HTTPException
import pytest

from backend.app import avatar_bridge

ME = {"role": "professor", "professor_id": "prof-me"}
PROFILES = {
    "profiles": [
        {"id": "mine-0001", "name": "Dr. Me", "owner": "prof-me", "complete": True, "active": False, "consent_recorded": True},
        {"id": "theirs-0002", "name": "Dr. Other", "owner": "prof-other", "complete": True, "active": True, "consent_recorded": True},
        {"id": "legacy-0003", "name": "Prototype", "owner": None, "complete": True, "active": False, "consent_recorded": False},
    ],
    "consent_text": "Synthetic consent statement.",
}


class Reply:
    def __init__(self, body, status=200):
        self.body, self.status_code, self.content = body, status, b"jpeg"

    def json(self):
        return self.body


@pytest.fixture
def service(monkeypatch):
    calls = []

    async def fake(method, path, **kwargs):
        calls.append((method, path, kwargs))
        if path == "/service/profiles" and method == "GET":
            return Reply(PROFILES)
        if path == "/service/status":
            return Reply({"ready": True, "models_loaded": True, "progress": "Ready",
                          "profile": {"id": "theirs-0002", "name": "Dr. Other"}})
        return Reply({"ok": True, "id": "new-0004"})

    monkeypatch.setattr(avatar_bridge, "SERVICE_URL", "http://avatar.test")
    monkeypatch.setattr(avatar_bridge, "SERVICE_TOKEN", "synthetic-token")
    monkeypatch.setattr(avatar_bridge, "_service", fake)
    return calls


def run(coroutine):
    return asyncio.run(coroutine)


def test_list_hides_other_professors_avatars_and_their_names(service):
    result = run(avatar_bridge.professor_avatars(account=ME))
    ids = {a["id"] for a in result["avatars"]}
    assert ids == {"mine-0001", "legacy-0003"}
    # Another professor's avatar is in use: reported without its name.
    assert result["active"] == {"id": None, "name": None, "mine": False, "other": True}
    assert result["consent_text"] == "Synthetic consent statement."


@pytest.mark.parametrize("pid", ["theirs-0002", "legacy-0003", "missing-9999", "../etc"])
def test_cannot_upload_to_or_delete_someone_elses_avatar(service, pid):
    with pytest.raises(HTTPException) as error:
        run(avatar_bridge._owned(pid, ME))
    assert error.value.status_code == 404


def test_prototype_avatars_can_be_used_but_not_deleted(service):
    assert run(avatar_bridge._owned("legacy-0003", ME, allow_unowned=True))["id"] == "legacy-0003"
    with pytest.raises(HTTPException):
        run(avatar_bridge._owned("theirs-0002", ME, allow_unowned=True))


def test_create_requires_consent_and_records_the_owner(service):
    class Body:
        def __init__(self, data):
            self.data = data

        async def json(self):
            return self.data

    with pytest.raises(HTTPException) as error:
        run(avatar_bridge.professor_create_avatar(Body({"name": "Dr. Me"}), account=ME))
    assert error.value.status_code == 422
    assert run(avatar_bridge.professor_create_avatar(Body({"name": "Dr. Me", "consent": True}), account=ME))["id"] == "new-0004"
    created = [c for c in service if c[0] == "POST" and c[1] == "/service/profiles"]
    assert created[-1][2]["json"]["owner"] == "prof-me"


def test_preview_refuses_another_professors_active_avatar(service):
    with pytest.raises(HTTPException) as error:
        run(avatar_bridge.professor_preview(account=ME))
    assert error.value.status_code == 404
