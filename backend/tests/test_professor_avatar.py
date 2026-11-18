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


class Rows:
    def __init__(self, row):
        self.row = row

    def first(self):
        return self.row

    def mappings(self):
        return self


class ExamDB:
    """Which professor owns the session's exam, and whether another professor's exam is running."""
    def __init__(self, owner="prof-me", other_running=False):
        self.owner, self.other_running = owner, other_running

    def execute(self, statement, params=None):
        sql = " ".join(str(statement).split())
        if sql.startswith("SELECT examiner_profile_snapshot FROM exam_sessions"):
            return Rows({"examiner_profile_snapshot": {"id": "mine-0001" if self.owner == "prof-me" else None}})
        if sql.startswith("SELECT 1 FROM exam_sessions"):
            return Rows((1,) if self.other_running else None)
        raise AssertionError(sql)


def run(coroutine):
    return asyncio.run(coroutine)


def test_list_hides_other_professors_avatars_and_their_names(service):
    result = run(avatar_bridge.professor_avatars(account=ME, db=ExamDB()))
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


@pytest.fixture
def switching(monkeypatch):
    """A service where the loaded avatar is someone else's and prof-me picked mine-0001."""
    calls = []
    listing = dict(PROFILES, active="theirs-0002", selections={"prof-me": "mine-0001"})

    async def fake(method, path, **kwargs):
        calls.append((method, path, kwargs))
        if path == "/service/profiles":
            return Reply(listing)
        return Reply({"ok": True})

    monkeypatch.setattr(avatar_bridge, "SERVICE_URL", "http://avatar.test")
    monkeypatch.setattr(avatar_bridge, "SERVICE_TOKEN", "synthetic-token")
    monkeypatch.setattr(avatar_bridge, "_service", fake)
    return calls


def test_a_students_exam_loads_their_professors_avatar(switching):
    assert run(avatar_bridge._exam_avatar(ExamDB(), "session-1")) == "mine-0001"
    assert ("POST", "/service/profiles/mine-0001/activate", {}) in switching


def test_no_switch_while_another_professors_exam_is_running(switching):
    # Selection stays explicit; the renderer may refuse contention, never return theirs.
    assert run(avatar_bridge._exam_avatar(ExamDB(other_running=True), "session-1")) == "mine-0001"


def test_exams_of_a_professor_without_a_choice_keep_the_loaded_avatar(switching):
    with pytest.raises(HTTPException) as error:
        run(avatar_bridge._exam_avatar(ExamDB(owner="prof-new"), "session-1"))
    assert error.value.status_code == 409
    assert not [c for c in switching if c[0] == "POST"]


def test_choosing_an_avatar_saves_it_and_loads_it_only_when_free(switching):
    assert run(avatar_bridge.professor_activate("mine-0001", account=ME, db=ExamDB(other_running=True))) == {"ok": True, "loaded": False}
    assert ("POST", "/service/selections", {"json": {"owner": "prof-me", "id": "mine-0001"}}) in switching
    assert not [c for c in switching if c[1].endswith("/activate")]
    assert run(avatar_bridge.professor_activate("mine-0001", account=ME, db=ExamDB())) == {"ok": True, "loaded": True}
    assert [c for c in switching if c[1].endswith("/activate")]


class QuestionRows:
    def __init__(self, rows):
        self.rows = rows

    def all(self):
        return self.rows


class ClipDB:
    def execute(self, statement, params=None):
        assert "FROM questions" in str(statement)
        return QuestionRows([("What is a primary key?",), ("Explain normalization.",)])


def test_exam_questions_are_sent_to_be_made_ahead_of_time_once_per_session(switching):
    avatar_bridge._PREPARED.clear()
    run(avatar_bridge._prepare_exam_clips(ClipDB(), "mine-0001", session_id="session-9"))
    run(avatar_bridge._prepare_exam_clips(ClipDB(), "mine-0001", session_id="session-9"))
    sent = [c for c in switching if c[1] == "/service/prerender"]
    assert len(sent) == 1
    body = sent[0][2]["json"]
    assert body["profile"] == "mine-0001"
    assert body["lines"][-2:] == ["What is a primary key?", "Explain normalization."]
    assert set(avatar_bridge.PRERENDER_LINES) <= set(body["lines"])


def test_a_failed_clip_request_never_breaks_the_exam_and_is_tried_again(monkeypatch):
    avatar_bridge._PREPARED.clear()

    async def down(*args, **kwargs):
        raise HTTPException(503, "The avatar service is unreachable.")
    monkeypatch.setattr(avatar_bridge, "_service", down)
    run(avatar_bridge._prepare_exam_clips(ClipDB(), "mine-0001", session_id="session-9"))
    assert "session-9" not in avatar_bridge._PREPARED
