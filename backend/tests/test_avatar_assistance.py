"""Synthetic assistance transactions; PostgreSQL row-lock races require deployment checks."""

from datetime import datetime, timedelta, timezone
import json
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx
import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend.app import avatar_assistance as assistance
from backend.app.avatar_policy import default_settings
from backend.app.db import get_db
from backend.app.student_auth import issue_student_token


STUDENT = "10000000-0000-4000-8000-000000000001"
EXAM = "20000000-0000-4000-8000-000000000001"
SESSION = "30000000-0000-4000-8000-000000000001"
QUESTION = "40000000-0000-4000-8000-000000000001"
NEXT_QUESTION = "40000000-0000-4000-8000-000000000002"
URL = f"/exam/sessions/{SESSION}/assistance"
ORIGIN = datetime(2026, 1, 1, tzinfo=timezone.utc)
REAL_GENERATOR = assistance.generate_assistance


def auth(**claims):
    token = issue_student_token(student_id=claims.get("student", STUDENT),
        exam_template_id=claims.get("exam", EXAM), session_id=claims.get("session", SESSION),
        purpose=claims.get("purpose", "student_session"))
    return {"Authorization": f"Bearer {token}"}


def body(action="repeat", request_id=None, sequence=1, **extra):
    return {"action": action, "request_id": request_id or str(uuid4()),
            "question_sequence_num": sequence, **extra}


def records(engine):
    with engine.connect() as db:
        return [dict(row) for row in db.execute(text("SELECT * FROM avatar_assistance_requests")).mappings()]


def update_settings(engine, action, **changes):
    with engine.begin() as db:
        settings = json.loads(db.execute(text("SELECT avatar_policy_snapshot FROM exam_sessions")).scalar_one())
        settings["assistance"][action].update(changes)
        db.execute(text("UPDATE exam_sessions SET avatar_policy_snapshot = :settings"),
                   {"settings": json.dumps(settings)})


@pytest.fixture
def api(monkeypatch):
    monkeypatch.setenv("AUTH_SECRET_KEY", "synthetic-assistance-secret-at-least-32-characters")
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    with engine.begin() as db:
        db.execute(text("""CREATE TABLE exam_sessions (id TEXT PRIMARY KEY, student_id TEXT,
            exam_template_id TEXT, status TEXT, avatar_policy_snapshot TEXT,
            avatar_policy_revision INTEGER, avatar_exam_mode TEXT,
            developer_demo BOOLEAN NOT NULL DEFAULT FALSE)"""))
        db.execute(text("""CREATE TABLE interactions (id TEXT PRIMARY KEY, session_id TEXT,
            sequence_num INTEGER, question_text TEXT, student_answer_transcript TEXT)"""))
        db.execute(text("""CREATE TABLE exam_templates (id TEXT PRIMARY KEY,
            rubric TEXT, topic_coverage_required TEXT)"""))
        db.execute(text("""CREATE TABLE avatar_assistance_requests (session_id TEXT, interaction_id TEXT,
            request_id TEXT, action TEXT, input_hash TEXT, status TEXT, response TEXT, error_text TEXT,
            created_at TIMESTAMP, pause_started_at TIMESTAMP, pause_until TIMESTAMP, pause_ended_at TIMESTAMP,
            PRIMARY KEY (session_id, request_id))"""))
        db.execute(text("""INSERT INTO exam_sessions VALUES (:sid, :student, :exam, 'in_progress',
            :settings, 1, 'assessed', FALSE)"""), {"sid": SESSION, "student": STUDENT,
            "exam": EXAM, "settings": json.dumps(default_settings().model_dump())})
        db.execute(text("INSERT INTO interactions VALUES (:qid, :sid, 1, 'Exact synthetic question?', NULL)"),
                   {"qid": QUESTION, "sid": SESSION})
        db.execute(text("INSERT INTO exam_templates VALUES (:exam, :rubric, 'synthetic topics')"),
                   {"exam": EXAM, "rubric": '{"criteria":["synthetic criterion"]}'})
    sessions = sessionmaker(bind=engine)
    clock = {"now": ORIGIN}
    calls = []

    def state(db, sid, claims):
        current = db.execute(text("SELECT status FROM exam_sessions WHERE id = :id"), {"id": sid}).scalar_one()
        pending = db.execute(text("""SELECT id, sequence_num, question_text FROM interactions
            WHERE session_id = :sid ORDER BY sequence_num DESC LIMIT 1"""), {"sid": sid}).mappings().one()
        now = clock["now"]
        total = timedelta(0)
        question_pause = timedelta(0)
        active = None
        for request in db.execute(text("SELECT * FROM avatar_assistance_requests WHERE session_id = :sid"),
                                  {"sid": sid}).mappings():
            if request["pause_started_at"] is None:
                continue
            start = assistance._timestamp(request["pause_started_at"])
            until = assistance._timestamp(request["pause_until"])
            ended = assistance._timestamp(request["pause_ended_at"]) if request["pause_ended_at"] else until
            credit = max(timedelta(0), min(now, until, ended) - start)
            total += credit
            if request["interaction_id"] == pending["id"]:
                question_pause += credit
            if request["pause_ended_at"] is None and until > now:
                active = until
        return {"session_id": sid, "status": current, "sequence_num": pending["sequence_num"],
            "question": pending["question_text"], "server_now": now.isoformat(),
            "deadline": (ORIGIN + timedelta(minutes=30) + total).isoformat(),
            "question_deadline": (ORIGIN + timedelta(minutes=2) + question_pause).isoformat(),
            "pause_until": active.isoformat() if active else None}

    def generated(db, session, pending, action, answer):
        if action == "repeat":
            return REAL_GENERATOR(db, session, pending, action, answer)
        calls.append((action, answer))
        return f"Synthetic generated {action}."

    monkeypatch.setattr(assistance, "_read_state", state)
    monkeypatch.setattr(assistance, "generate_assistance", generated)
    app = FastAPI()
    app.include_router(assistance.router)

    def isolated_db():
        with sessions() as db:
            yield db

    app.dependency_overrides[get_db] = isolated_db
    with TestClient(app) as client:
        yield client, engine, clock, calls, sessions
    engine.dispose()


def test_only_mode_permitted_actions_are_released_without_private_policy(api):
    client, _, _, _, _ = api
    response = client.get(URL, headers=auth())
    assert response.status_code == 200
    data = response.json()
    assert data["mode"] == "assessed"
    assert set(data["actions"]) == {"repeat", "clarification"}
    assert data["actions"]["repeat"] == {"limit": 2, "used": 0, "remaining": 2, "timerContinues": True}
    assert not any(key in data for key in ("settings", "policy", "behavior", "rubric", "input_hash"))


def test_demo_assistance_preserves_permissions_quota_idempotency_and_pause(api, monkeypatch):
    client, engine, _, _, _ = api
    monkeypatch.setenv("DEVELOPER_DEMO_MODE", "1")
    update_settings(engine, "clarification", timerContinues=False)
    with engine.begin() as db:
        db.execute(text("UPDATE exam_sessions SET developer_demo = TRUE"))
    monkeypatch.setattr(assistance, "generate_assistance", REAL_GENERATOR)
    monkeypatch.setattr("backend.app.exam.load_exam_material_summaries", lambda *a: [])
    probes = []
    monkeypatch.setattr(assistance, "ai_available", lambda *a: probes.append(True) or False)
    assert client.post(URL, json=body("hint"), headers=auth()).status_code == 403
    assert probes == [] and records(engine) == []
    request = body("clarification")
    result = client.post(URL, json=request, headers=auth()).json()
    assert result["status"] == "succeeded" and result["text"].startswith("[Developer demo]")
    assert result["usage"]["actions"]["clarification"]["remaining"] == 0
    assert result["pause_until"] is not None
    replay = client.post(URL, json=request, headers=auth()).json()
    assert replay["text"] == result["text"] and replay["usage"] == result["usage"]
    assert len(records(engine)) == 1 and len(probes) == 1
    complete = client.post(f"{URL}/{request['request_id']}/complete",
        json={}, headers=auth())
    assert complete.status_code == 200 and complete.json()["pause_until"] is None
    assert client.post(URL, json=body("clarification"), headers=auth()).status_code == 409


@pytest.mark.parametrize("saved_demo,flag", [(False, "1"), (True, "0")])
def test_demo_help_never_leaks_into_legacy_or_disabled_runtime(api, monkeypatch, saved_demo, flag):
    client, engine, _, _, _ = api
    monkeypatch.setenv("DEVELOPER_DEMO_MODE", flag)
    with engine.begin() as db:
        db.execute(text("UPDATE exam_sessions SET developer_demo = :demo"), {"demo": saved_demo})
    monkeypatch.setattr(assistance, "generate_assistance", REAL_GENERATOR)
    monkeypatch.setattr("backend.app.exam.load_exam_material_summaries", lambda *a: [])
    monkeypatch.setattr(assistance, "ai_available", lambda *a: pytest.fail("Normal attempts must not probe demo capabilities"))
    monkeypatch.setattr(assistance.httpx, "post", lambda *a, **k: (_ for _ in ()).throw(httpx.ConnectError("synthetic offline")))
    result = client.post(URL, json=body("clarification"), headers=auth()).json()
    assert result["status"] == "failed" and result["text"] is None
    assert result["pause_until"] is None
    assert result["usage"]["actions"]["clarification"]["remaining"] == 1


def test_repeat_is_exact_and_idempotent_with_fresh_clocks_and_no_model(api):
    client, engine, clock, calls, _ = api
    request = body()
    first = client.post(URL, json=request, headers=auth()).json()
    assert first["text"] == "Exact synthetic question?"
    assert first["status"] == "succeeded"
    assert first["usage"]["actions"]["repeat"]["remaining"] == 1
    clock["now"] += timedelta(seconds=10)
    replay = client.post(URL, json=request, headers=auth()).json()
    assert replay["text"] == first["text"] and replay["server_now"] != first["server_now"]
    assert replay["usage"] == first["usage"]
    assert calls == [] and len(records(engine)) == 1


@pytest.mark.parametrize("changed", [{"action": "clarification"}, {"question_sequence_num": 2}])
def test_idempotency_key_cannot_be_reused_for_another_action_or_question(api, changed):
    client, engine, _, _, _ = api
    request = body()
    assert client.post(URL, json=request, headers=auth()).status_code == 200
    assert client.post(URL, json={**request, **changed}, headers=auth()).status_code == 409
    assert len(records(engine)) == 1


def test_correctness_idempotency_is_bound_to_the_original_answer(api):
    client, engine, _, calls, _ = api
    update_settings(engine, "correctness", enabled=True, modes="both")
    request = body("correctness", answer_transcript="Original synthetic answer")
    first = client.post(URL, json=request, headers=auth())
    assert first.status_code == 200
    assert client.post(URL, json={**request, "answer_transcript": "Changed answer"}, headers=auth()).status_code == 409
    assert calls == [("correctness", "Original synthetic answer")]
    assert "input_hash" not in first.json()


def test_exhausted_allowance_survives_reload_and_resets_only_for_new_question(api):
    client, engine, _, _, _ = api
    for _ in range(2):
        assert client.post(URL, json=body(), headers=auth()).status_code == 200
    assert client.get(URL, headers=auth()).json()["actions"]["repeat"]["remaining"] == 0
    assert client.post(URL, json=body(), headers=auth()).status_code == 409
    with engine.begin() as db:
        db.execute(text("UPDATE interactions SET student_answer_transcript = 'Synthetic answer'"))
        db.execute(text("INSERT INTO interactions VALUES (:id, :sid, 2, 'Next synthetic question?', NULL)"),
                   {"id": NEXT_QUESTION, "sid": SESSION})
    response = client.post(URL, json=body(sequence=2), headers=auth())
    assert response.status_code == 200
    assert response.json()["usage"]["actions"]["repeat"]["remaining"] == 1


@pytest.mark.parametrize("action", ["hint", "explanation", "correctness"])
def test_disabled_actions_cannot_be_requested_directly(api, action):
    client, engine, _, calls, _ = api
    request = body(action, answer_transcript="Synthetic answer")
    assert client.post(URL, json=request, headers=auth()).status_code == 403
    assert records(engine) == [] and calls == []


def test_authoritative_mode_controls_availability(api):
    client, engine, _, _, _ = api
    update_settings(engine, "hint", enabled=True, modes="practice")
    assert "hint" not in client.get(URL, headers=auth()).json()["actions"]
    assert client.post(URL, json=body("hint"), headers=auth()).status_code == 403
    with engine.begin() as db:
        db.execute(text("UPDATE exam_sessions SET avatar_exam_mode = 'practice'"))
    assert client.post(URL, json=body("hint"), headers=auth()).status_code == 200


@pytest.mark.parametrize("claims", [{"session": str(uuid4())}, {"student": str(uuid4())},
                                    {"exam": str(uuid4())}, {"purpose": "student_exam"}])
def test_student_scope_is_checked_on_all_assistance_endpoints(api, claims):
    client, engine, _, _, _ = api
    token = auth(**claims)
    assert client.get(URL, headers=token).status_code == 403
    assert client.post(URL, json=body(), headers=token).status_code == 403
    assert client.post(f"{URL}/{uuid4()}/complete", json={}, headers=token).status_code == 403
    assert records(engine) == []


def test_missing_bearer_is_rejected_before_storage_access(api):
    client, engine, _, _, _ = api
    with engine.begin() as db:
        db.execute(text("DROP TABLE avatar_assistance_requests"))
    assert client.get(URL).status_code == 401
    assert client.post(URL, json=body()).status_code == 401


@pytest.mark.parametrize("extra", [{"mode": "practice"}, {"policy": {}}, {"limit": 100},
                                   {"question_sequence_num": True}, {"question_sequence_num": 0}])
def test_request_body_cannot_set_authority_or_coerce_question_sequence(api, extra):
    client, engine, _, _, _ = api
    assert client.post(URL, json={**body(), **extra}, headers=auth()).status_code == 422
    assert records(engine) == []


@pytest.mark.parametrize("answer", [None, "", "  "])
def test_correctness_requires_answer_without_reserving_allowance(api, answer):
    client, engine, _, _, _ = api
    update_settings(engine, "correctness", enabled=True, modes="both")
    assert client.post(URL, json=body("correctness", answer_transcript=answer), headers=auth()).status_code == 422
    assert records(engine) == []


def test_answer_transcript_is_bounded(api):
    client, engine, _, _, _ = api
    assert client.post(URL, json=body("correctness", answer_transcript="x" * 20_001), headers=auth()).status_code == 422
    assert records(engine) == []


def test_paused_assistance_is_completed_explicitly_and_replay_does_not_reopen_pause(api):
    client, engine, clock, _, _ = api
    update_settings(engine, "repeat", timerContinues=False)
    request = body()
    first = client.post(URL, json=request, headers=auth()).json()
    assert first["pause_until"] == (ORIGIN + timedelta(seconds=120)).isoformat()
    clock["now"] += timedelta(seconds=15)
    loaded = client.get(URL, headers=auth()).json()
    assert loaded["active_request_id"] == request["request_id"]
    assert loaded["deadline"] == (ORIGIN + timedelta(minutes=30, seconds=15)).isoformat()
    assert client.post(URL, json=body("clarification"), headers=auth()).status_code == 409
    complete_url = f"{URL}/{request['request_id']}/complete"
    complete = client.post(complete_url, json={}, headers=auth()).json()
    assert complete["pause_until"] is None
    clock["now"] += timedelta(seconds=20)
    replay = client.post(URL, json=request, headers=auth()).json()
    assert replay["pause_until"] is None and replay["deadline"] == complete["deadline"]
    assert client.post(complete_url, json={}, headers=auth()).json()["deadline"] == complete["deadline"]


def test_successful_reading_pause_is_capped_at_120_seconds(api):
    client, engine, clock, _, _ = api
    update_settings(engine, "repeat", timerContinues=False)
    request = body()
    assert client.post(URL, json=request, headers=auth()).status_code == 200
    clock["now"] += timedelta(seconds=140)
    response = client.post(f"{URL}/{request['request_id']}/complete", json={}, headers=auth()).json()
    assert response["deadline"] == (ORIGIN + timedelta(minutes=32)).isoformat()
    row = records(engine)[0]
    assert assistance._timestamp(row["pause_ended_at"]) == ORIGIN + timedelta(seconds=120)


def test_model_failure_is_cached_without_quota_or_pause_credit(api, monkeypatch):
    client, engine, clock, _, _ = api
    update_settings(engine, "clarification", timerContinues=False)
    calls = []

    def fail(*args):
        calls.append(True)
        clock["now"] += timedelta(seconds=30)
        raise RuntimeError("private synthetic model detail")

    monkeypatch.setattr(assistance, "generate_assistance", fail)
    request = body("clarification")
    response = client.post(URL, json=request, headers=auth())
    assert response.status_code == 200
    failed = response.json()
    assert failed["status"] == "failed" and failed["text"] is None
    assert failed["pause_until"] is None
    assert failed["deadline"] == (ORIGIN + timedelta(minutes=30)).isoformat()
    assert failed["usage"]["actions"]["clarification"]["remaining"] == 1
    assert "private" not in failed["error"]
    assert client.post(URL, json=request, headers=auth()).json()["status"] == "failed"
    assert len(calls) == 1
    row = records(engine)[0]
    assert row["pause_started_at"] == row["pause_ended_at"]


@pytest.mark.parametrize("change", ["next-question", "completed", "expired"])
def test_help_not_released_if_question_advances_or_expires_during_generation(api, monkeypatch, change):
    client, engine, clock, _, _ = api

    def changed(*args):
        if change == "expired":
            clock["now"] += timedelta(minutes=3)
        else:
            with engine.begin() as db:
                if change == "completed":
                    db.execute(text("UPDATE exam_sessions SET status = 'pending_grading'"))
                else:
                    db.execute(text("UPDATE interactions SET student_answer_transcript = 'Synthetic answer'"))
                    db.execute(text("INSERT INTO interactions VALUES (:id, :sid, 2, 'Next?', NULL)"),
                               {"id": NEXT_QUESTION, "sid": SESSION})
        return "Synthetic help that must not be released"

    monkeypatch.setattr(assistance, "generate_assistance", changed)
    response = client.post(URL, json=body("clarification"), headers=auth()).json()
    assert response["status"] == "failed" and response["text"] is None
    assert records(engine)[0]["status"] == "failed"


def test_expired_question_cannot_reserve_help(api):
    client, engine, clock, calls, _ = api
    clock["now"] += timedelta(minutes=2)
    assert client.post(URL, json=body(), headers=auth()).status_code == 409
    assert records(engine) == [] and calls == []


@pytest.mark.parametrize("replay", [False, True])
def test_request_in_progress_cannot_create_a_second_reservation(api, monkeypatch, replay):
    client, engine, _, _, _ = api
    original = body("clarification")
    nested = []

    def overlap(*args):
        request = original if replay else body("repeat")
        nested.append(client.post(URL, json=request, headers=auth()))
        return "Synthetic clarification"

    monkeypatch.setattr(assistance, "generate_assistance", overlap)
    assert client.post(URL, json=original, headers=auth()).json()["status"] == "succeeded"
    assert nested[0].status_code == (200 if replay else 409)
    if replay:
        assert nested[0].json()["status"] == "reserved"
    assert len(records(engine)) == 1


@pytest.mark.parametrize("maintenance", ["get", "denied-action", "expired-question"])
def test_abandoned_reservation_is_retired_durably_without_quota_or_pause_credit(api, maintenance):
    client, engine, clock, calls, _ = api
    request = body("clarification")
    created = ORIGIN - timedelta(seconds=121)
    with engine.begin() as db:
        db.execute(text("""INSERT INTO avatar_assistance_requests (session_id, interaction_id, request_id,
            action, input_hash, status, created_at, pause_started_at, pause_until)
            VALUES (:sid, :qid, :rid, 'clarification', :hash, 'reserved', :created, :created, :until)"""),
            {"sid": SESSION, "qid": QUESTION, "rid": request["request_id"],
             "hash": assistance._input_hash(assistance.AssistanceRequest.model_validate(request)),
             "created": created, "until": created + timedelta(seconds=120)})
    if maintenance == "get":
        response = client.get(URL, headers=auth())
        assert response.status_code == 200
        assert response.json()["actions"]["clarification"]["remaining"] == 1
    elif maintenance == "denied-action":
        assert client.post(URL, json=body("hint"), headers=auth()).status_code == 403
    else:
        clock["now"] += timedelta(minutes=3)
        assert client.post(URL, json=body(), headers=auth()).status_code == 409
    row = records(engine)[0]
    assert row["status"] == "failed" and row["pause_ended_at"] == row["pause_started_at"]
    replay = client.post(URL, json=request, headers=auth()).json()
    assert replay["status"] == "failed" and replay["text"] is None
    assert calls == []


def test_reload_returns_current_pause_identifier_instead_of_old_unclosed_success(api):
    client, engine, _, _, _ = api
    old_id, current_id = str(uuid4()), str(uuid4())
    with engine.begin() as db:
        for request_id, status, created in (
            (old_id, "succeeded", ORIGIN - timedelta(seconds=140)),
            (current_id, "reserved", ORIGIN - timedelta(seconds=5))):
            db.execute(text("""INSERT INTO avatar_assistance_requests (session_id, interaction_id, request_id,
                action, input_hash, status, created_at, pause_started_at, pause_until)
                VALUES (:sid, :qid, :rid, 'repeat', :hash, :status, :created, :created, :until)"""),
                {"sid": SESSION, "qid": QUESTION, "rid": request_id, "hash": "0" * 64,
                 "status": status, "created": created, "until": created + timedelta(seconds=120)})
    response = client.get(URL, headers=auth())
    assert response.status_code == 200
    assert response.json()["active_request_id"] == current_id
    assert client.post(f"{URL}/{current_id}/complete", json={}, headers=auth()).status_code == 409


def test_real_generator_sends_professor_context_and_returns_only_text(api, monkeypatch):
    _, _, _, _, sessions = api
    from backend.app import exam
    requests = []
    monkeypatch.setattr(exam, "load_exam_material_summaries", lambda *args: [
        {"filename": "synthetic.txt", "summary": "Synthetic reference context"}])

    class Response:
        def raise_for_status(self):
            pass

        def json(self):
            return {"message": {"content": json.dumps({"text": "Provisional synthetic feedback", "reasoning": "private"})}}

    monkeypatch.setattr(assistance.httpx, "post", lambda *a, **k: requests.append(k) or Response())
    with sessions() as db:
        result = REAL_GENERATOR(db, {"exam_template_id": EXAM},
            {"question_text": "Synthetic question?"}, "correctness", "Untrusted synthetic answer")
    assert result == "Provisional synthetic feedback"
    payload = json.loads(requests[0]["json"]["messages"][1]["content"])
    assert payload["student_answer"] == "Untrusted synthetic answer"
    assert payload["professor_rubric"] and payload["course_material_summaries"]
    assert requests[0]["timeout"] < assistance.PAUSE_SECONDS
