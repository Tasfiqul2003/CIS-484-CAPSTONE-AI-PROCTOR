"""Synthetic opt-in demo checks; no services, real database or assessment output."""

import asyncio
import re
from uuid import UUID

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import httpx
import pytest

from backend.app import developer_demo as demo
from backend.app import exam, grading, review, stream
from backend.app.auth import get_current_account
from backend.app.db import get_db


PROFESSOR = "10000000-0000-4000-8000-000000000001"
OTHER_PROFESSOR = "10000000-0000-4000-8000-000000000002"
STUDENT = "20000000-0000-4000-8000-000000000001"
EXAM = "30000000-0000-4000-8000-000000000001"
SESSION = "40000000-0000-4000-8000-000000000001"
BANK = "50000000-0000-4000-8000-000000000001"
CLAIMS = {"sub": STUDENT, "exam_template_id": EXAM, "session_id": SESSION}


def set_flag(monkeypatch, value):
    if value is None:
        monkeypatch.delenv("DEVELOPER_DEMO_MODE", raising=False)
    else:
        monkeypatch.setenv("DEVELOPER_DEMO_MODE", value)


@pytest.mark.parametrize("value,expected", [(None, False), ("0", False), ("true", False),
                                          ("yes", False), (" 1", False), ("1 ", False), ("1", True)])
def test_demo_requires_exact_explicit_opt_in(monkeypatch, value, expected):
    set_flag(monkeypatch, value)
    assert demo.demo_enabled() is expected


def test_default_off_capabilities_does_not_probe_optional_ai(monkeypatch):
    set_flag(monkeypatch, None)
    monkeypatch.setattr(demo.httpx, "get", lambda *a, **k: pytest.fail("Disabled demo must not probe AI"))
    assert demo.capabilities() == {"enabled": False}


@pytest.mark.parametrize("flag,marker,expected", [
    ("1", True, True), ("1", 1, True), ("1", False, False), ("1", 0, False),
    ("1", None, False), (None, True, False), ("0", True, False),
])
def test_runtime_demo_requires_saved_session_marker_and_current_opt_in(monkeypatch, flag, marker, expected):
    set_flag(monkeypatch, flag)
    assert demo.demo_for_session({"developer_demo": marker}) is expected
    assert demo.demo_for_session({}) is False


class ProbeResponse:
    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self.payload


@pytest.mark.parametrize("payload,expected", [
    ({"models": [{"name": "synthetic-examiner"}]}, True),
    ({"models": [{"name": "synthetic-examiner:latest"}]}, True),
    ({"models": [{"model": "synthetic-examiner:latest"}]}, True),
    ({"models": [{"name": "synthetic-examiner:4b"}]}, False),
    ({"models": [{"name": "synthetic-examiner-instruct"}]}, False),
    ({"models": []}, False), ({"models": None}, False),
    ({"models": [None, "synthetic-examiner"]}, False), ({}, False), ([], False),
])
def test_ai_probe_checks_installed_configured_model_without_generation(monkeypatch, payload, expected):
    calls = []

    def get(url, **kwargs):
        calls.append((url, kwargs))
        return ProbeResponse(payload)

    monkeypatch.setattr(demo.httpx, "get", get)
    assert demo.ai_available("http://synthetic.invalid/", "synthetic-examiner") is expected
    assert len(calls) == 1 and calls[0][0] == "http://synthetic.invalid/api/tags"
    timeout = calls[0][1]["timeout"]
    assert timeout.connect <= 0.5 and timeout.read <= 1.5


@pytest.mark.parametrize("fault", ["unreachable", "timeout", "invalid-json", "http-error"])
def test_ai_probe_returns_unavailable_for_optional_provider_failures(monkeypatch, fault):
    def get(*args, **kwargs):
        if fault == "unreachable":
            raise httpx.ConnectError("Synthetic connection failure")
        if fault == "timeout":
            raise httpx.ReadTimeout("Synthetic timeout")
        if fault == "invalid-json":
            raise ValueError("Synthetic malformed response")
        raise httpx.HTTPStatusError("Synthetic HTTP error", request=httpx.Request("GET", "http://synthetic.invalid"),
                                   response=httpx.Response(503))

    monkeypatch.setattr(demo.httpx, "get", get)
    assert demo.ai_available("http://synthetic.invalid", "synthetic-examiner") is False


def test_enabled_capability_report_distinguishes_demo_from_real_ai(monkeypatch):
    set_flag(monkeypatch, "1")
    monkeypatch.setattr(demo, "ai_available", lambda: False)
    report = demo.capabilities()
    assert report["enabled"] is True and report["ai_available"] is False
    assert report["substitutes"]["questions"] and report["substitutes"]["assistance"]
    assert "grading" not in report["substitutes"] or not report["substitutes"]["grading"]


def test_synthetic_content_is_labeled_deterministic_and_does_not_produce_grades():
    for sequence in (1, 2, 3, 4):
        question = demo.demo_question(sequence)
        assert question.startswith("[Developer demo] ")
        assert question == demo.demo_question(sequence)
    for action in ("clarification", "hint", "explanation", "correctness"):
        result = demo.demo_assistance(action, "Synthetic question?")
        assert result.startswith("[Developer demo] ")
        assert result == demo.demo_assistance(action, "Synthetic question?")
        assert re.search(r"\d+(?:\.\d+)?\s*(?:%|/\s*\d+)", result) is None
    summary = demo.demo_summary("  Synthetic   source\nexcerpt  ")
    assert summary.startswith("[Developer demo] ") and "not an AI summary" in summary
    assert "Synthetic source excerpt" in summary
    assert len(demo.demo_summary("x" * 10_000)) < 800


class Result:
    def __init__(self, row=None):
        self.row = row

    def mappings(self):
        return self

    def first(self):
        return self.row


class GradingDB:
    owner = PROFESSOR
    marked_demo = True

    def __init__(self):
        self.calls = []

    def execute(self, statement, params=None):
        sql = str(statement)
        self.calls.append(sql)
        if "FROM exam_sessions" in sql:
            return Result({"status": "pending_grading", "developer_demo": self.marked_demo,
                "professor_id": self.owner, "exam_professor_id": self.owner,
                "rubric": {"criteria": [{"name": "Synthetic", "max_score": 1}]},
                "title": "Synthetic exam", "topic_coverage_required": []})
        raise AssertionError("Demo grading must stop before reading or writing grade records")

    def commit(self):
        raise AssertionError("Demo grading must not commit")


@pytest.fixture
def grading_api(monkeypatch):
    app = FastAPI()
    app.include_router(grading.router)
    app.include_router(review.router)
    db = GradingDB()
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_account] = lambda: {"role": "professor", "professor_id": PROFESSOR}
    monkeypatch.setattr(grading.httpx, "post", lambda *a, **k: pytest.fail("Demo grading must not invoke a model"))
    with TestClient(app) as client:
        yield client, app, db


def grading_requests(client):
    return [client.post("/exam/grade", json={"session_id": SESSION}),
            client.put(f"/exam/{SESSION}/grades", json={"professor_id": PROFESSOR,
                "grades": [{"rubric_criterion": "Synthetic", "score": 1}]})]


@pytest.mark.parametrize("flag", [None, "0", "1"])
def test_saved_demo_attempt_cannot_be_graded_even_after_demo_mode_is_disabled(grading_api, monkeypatch, flag):
    client, _, db = grading_api
    set_flag(monkeypatch, flag)
    responses = grading_requests(client)
    assert [response.status_code for response in responses] == [409, 409]
    assert all("demo" in response.json()["detail"].lower() for response in responses)
    assert len(db.calls) == 2


def test_other_professor_is_denied_before_demo_provenance_is_exposed(grading_api):
    client, _, db = grading_api
    db.owner = OTHER_PROFESSOR
    responses = grading_requests(client)
    assert [response.status_code for response in responses] == [404, 404]
    assert all("demo" not in response.json()["detail"].lower() for response in responses)


@pytest.mark.parametrize("role,status", [("anonymous", 401), ("student", 403), ("admin", 403)])
def test_demo_mode_never_replaces_grading_authentication(grading_api, monkeypatch, role, status):
    client, app, db = grading_api
    set_flag(monkeypatch, "1")
    if role == "anonymous":
        def reject():
            raise HTTPException(401, "Synthetic sign-in required")
        app.dependency_overrides[get_current_account] = reject
    else:
        app.dependency_overrides[get_current_account] = lambda: {"role": role, "professor_id": PROFESSOR}
    assert [response.status_code for response in grading_requests(client)] == [status, status]
    assert db.calls == []


class StartDB:
    def __init__(self, *, rostered=True):
        self.rostered = rostered
        self.insert_params = None
        self.question_params = None
        self.committed = False

    def execute(self, statement, params=None):
        sql = str(statement)
        if "SELECT * FROM exam_templates" in sql:
            return Result({"status": "published", "time_limit_minutes": 30})
        if "FROM students" in sql:
            return Result({"id": STUDENT})
        if "FROM exam_roster" in sql and "INSERT INTO exam_sessions" not in sql:
            return Result({"id": STUDENT} if self.rostered else None)
        if "INSERT INTO exam_sessions" in sql:
            self.insert_params = dict(params)
            assert "developer_demo" in sql
            return Result({"id": SESSION, "time_limit_minutes": 30, "extended_time_multiplier": 1,
                           "developer_demo": params["developer_demo"]})
        if "FROM questions" in sql:
            return Result({"id": BANK, "question_text": "Professor-authored synthetic question?"})
        if "INSERT INTO interactions" in sql:
            self.question_params = dict(params)
            return Result()
        raise AssertionError(f"Unexpected synthetic start query: {sql}")

    def commit(self):
        self.committed = True


def prepare_start(monkeypatch):
    monkeypatch.setattr(exam, "read_student_token", lambda *a, **k: CLAIMS)
    monkeypatch.setattr(exam, "issue_student_token", lambda **kw: "synthetic-token")
    monkeypatch.setattr(exam, "snapshot_for_exam", lambda *a: (exam.session_policy({
        "avatar_policy_revision": 0, "avatar_policy_snapshot": None}), 0, "assessed"))
    monkeypatch.setattr(exam, "read_session_state", lambda *a: {})
    monkeypatch.setattr(exam, "load_exam_material_summaries", lambda *a: [])
    monkeypatch.setattr(demo, "ai_available", lambda *a, **k: pytest.fail("Authored opening question must not require demo AI"))
    monkeypatch.setattr(exam, "ai_available", lambda *a, **k: pytest.fail("Authored opening question must not require demo AI"))


@pytest.mark.parametrize("flag,expected", [(None, False), ("0", False), ("1", True)])
def test_new_attempt_snapshots_server_demo_flag(monkeypatch, flag, expected):
    set_flag(monkeypatch, flag)
    prepare_start(monkeypatch)
    db = StartDB()
    response = exam.start_exam(exam.StartRequest(student_id=STUDENT, exam_template_id=EXAM,
                                                student_token="synthetic"), db=db)
    assert db.insert_params["developer_demo"] is expected and db.committed
    assert response["question"] == "Professor-authored synthetic question?"


@pytest.mark.parametrize("flag", [None, "1"])
def test_demo_start_still_requires_real_roster_eligibility(monkeypatch, flag):
    set_flag(monkeypatch, flag)
    prepare_start(monkeypatch)
    db = StartDB(rostered=False)
    with pytest.raises(HTTPException) as error:
        exam.start_exam(exam.StartRequest(student_id=STUDENT, exam_template_id=EXAM,
                                        student_token="synthetic"), db=db)
    assert error.value.status_code == 403
    assert db.insert_params is None and not db.committed


class EmptyBankStartDB(StartDB):
    def execute(self, statement, params=None):
        if "FROM questions" in str(statement):
            return Result()
        return super().execute(statement, params)


def start_attempt(db):
    return exam.start_exam(exam.StartRequest(student_id=STUDENT, exam_template_id=EXAM,
                                            student_token="synthetic"), db=db)


def test_demo_start_without_bank_or_optional_model_persists_labeled_sample(monkeypatch):
    set_flag(monkeypatch, "1")
    prepare_start(monkeypatch)
    monkeypatch.setattr(exam, "ai_available", lambda *a, **k: False)
    monkeypatch.setattr(exam, "ask_model", lambda *a, **k: pytest.fail("Unavailable optional model must not be invoked"))
    db = EmptyBankStartDB()
    response = start_attempt(db)
    assert response["question"].startswith("[Developer demo] ")
    assert db.question_params["q"] == response["question"]
    assert db.insert_params["developer_demo"] is True and db.committed


def test_default_off_start_without_bank_propagates_real_provider_failure(monkeypatch):
    set_flag(monkeypatch, None)
    prepare_start(monkeypatch)

    def real_failure(*args, **kwargs):
        raise HTTPException(502, "Synthetic real provider unavailable")

    monkeypatch.setattr(exam, "ask_model", real_failure)
    db = EmptyBankStartDB()
    with pytest.raises(HTTPException) as error:
        start_attempt(db)
    assert error.value.status_code == 502
    assert db.insert_params["developer_demo"] is False
    assert db.question_params is None and not db.committed


def test_demo_start_prefers_real_question_when_configured_model_is_available(monkeypatch):
    set_flag(monkeypatch, "1")
    prepare_start(monkeypatch)
    probes, model_calls = [], []
    monkeypatch.setattr(exam, "ai_available", lambda *a, **k: probes.append(True) or True)
    monkeypatch.setattr(exam, "ask_model", lambda *a, **k: model_calls.append(True) or {
        "question": "Actual provider synthetic test question", "reasoning": "Synthetic rationale"})
    db = EmptyBankStartDB()
    response = start_attempt(db)
    assert response["question"] == "Actual provider synthetic test question"
    assert db.question_params["q"] == response["question"] and db.committed
    assert len(probes) == len(model_calls) == 1


@pytest.mark.parametrize("decision", [{}, {"question": None}, {"question": ""}, {"question": "  "}])
def test_demo_start_replaces_missing_provider_text_with_labeled_sample(monkeypatch, decision):
    set_flag(monkeypatch, "1")
    prepare_start(monkeypatch)
    monkeypatch.setattr(exam, "ai_available", lambda *a, **k: True)
    monkeypatch.setattr(exam, "ask_model", lambda *a, **k: decision)
    db = EmptyBankStartDB()
    response = start_attempt(db)
    assert response["question"].startswith("[Developer demo] ")
    assert db.question_params["q"] == response["question"] and db.committed


def test_demo_start_recovers_if_model_fails_after_successful_capability_probe(monkeypatch):
    set_flag(monkeypatch, "1")
    prepare_start(monkeypatch)
    probes, model_calls = [], []
    monkeypatch.setattr(exam, "ai_available", lambda *a, **k: probes.append(True) or True)

    def failed_model(*args, **kwargs):
        model_calls.append(True)
        raise HTTPException(502, "Synthetic provider failed after metadata check")

    monkeypatch.setattr(exam, "ask_model", failed_model)
    db = EmptyBankStartDB()
    response = start_attempt(db)
    assert response["question"].startswith("[Developer demo] ") and db.committed
    assert len(probes) == len(model_calls) == 1


def test_demo_start_does_not_replace_database_or_schema_failures(monkeypatch):
    set_flag(monkeypatch, "1")
    prepare_start(monkeypatch)

    class BrokenSchemaDB(EmptyBankStartDB):
        def execute(self, statement, params=None):
            if "INSERT INTO exam_sessions" in str(statement):
                raise RuntimeError("Synthetic schema unavailable")
            return super().execute(statement, params)

    db = BrokenSchemaDB()
    with pytest.raises(RuntimeError, match="Synthetic schema unavailable"):
        start_attempt(db)
    assert db.question_params is None and not db.committed


def demo_behavior_db(**options):
    from backend.tests.test_avatar_behavior import BehaviorDB

    class DemoBehaviorDB(BehaviorDB):
        marked_demo = True

        def execute(self, statement, params=None):
            result = super().execute(statement, params)
            if "FROM exam_sessions s" in str(statement):
                result.row["developer_demo"] = self.marked_demo
            return result

    return DemoBehaviorDB(**options)


def prepare_behavior(monkeypatch, db):
    from backend.tests.test_question_time_limits import prepare_turn
    prepare_turn(monkeypatch, db)
    monkeypatch.setattr(exam, "ask_model", lambda *a, **k: pytest.fail("Authored/demo fallback must not call the model"))
    monkeypatch.setattr(stream, "decide", lambda *a, **k: pytest.fail("Authored/demo fallback must not call the model"))


def run_answer(db, streaming):
    from backend.tests.test_avatar_behavior import answer_request
    from backend.tests.test_question_time_limits import CLAIMS as TURN_CLAIMS
    if streaming:
        plan = stream.plan_turn(answer_request(), TURN_CLAIMS)
        events = list(stream.event_stream(plan))
        return plan, events
    return exam.submit_answer(answer_request(), authorization="synthetic", db=db), []


@pytest.mark.parametrize("streaming", [False, True])
def test_demo_prefers_authored_bank_question_without_model_or_probe(monkeypatch, streaming):
    set_flag(monkeypatch, "1")
    db = demo_behavior_db(bank=True)
    prepare_behavior(monkeypatch, db)
    for module in (exam, stream):
        monkeypatch.setattr(module, "ai_available", lambda *a, **k: pytest.fail("Authored content needs no model probe"))
    result, _ = run_answer(db, streaming)
    assert result.get("kind", "bank") == "bank"
    assert db.inserted["q"] == "First authored question" and db.inserted["src"] == "bank"
    assert db.inserted["followup"] == 0


@pytest.mark.parametrize("streaming", [False, True])
def test_demo_without_bank_or_model_uses_labeled_sample_within_followup_limit(monkeypatch, streaming):
    set_flag(monkeypatch, "1")
    db = demo_behavior_db(bank=False, followups=1, current_followup=0)
    prepare_behavior(monkeypatch, db)
    for module in (exam, stream):
        monkeypatch.setattr(module, "ai_available", lambda *a, **k: False)
    result, events = run_answer(db, streaming)
    assert result.get("kind", "sample") == "sample"
    assert db.inserted["q"].startswith("[Developer demo] ")
    assert db.inserted["src"] == "generated" and db.inserted["followup"] == 1
    if streaming:
        assert any(event.startswith("event: token") and "[Developer demo]" in event for event in events)


@pytest.mark.parametrize("streaming", [False, True])
def test_demo_fallback_never_bypasses_saved_followup_cap(monkeypatch, streaming):
    set_flag(monkeypatch, "1")
    db = demo_behavior_db(bank=False, followups=0)
    prepare_behavior(monkeypatch, db)
    for module in (exam, stream):
        monkeypatch.setattr(module, "ai_available", lambda *a, **k: pytest.fail("An exhausted exam must not probe AI"))
    result, _ = run_answer(db, streaming)
    assert result.get("kind", "done") == "done"
    assert db.ended and db.inserted is None


@pytest.mark.parametrize("streaming", [False, True])
def test_existing_real_attempt_never_uses_new_global_demo_substitutes(monkeypatch, streaming):
    set_flag(monkeypatch, "1")
    db = demo_behavior_db(bank=False)
    db.marked_demo = False
    prepare_behavior(monkeypatch, db)

    def real_failure(*args, **kwargs):
        raise HTTPException(502, "Synthetic real provider unavailable")

    monkeypatch.setattr(exam, "ask_model", real_failure)
    monkeypatch.setattr(stream, "decide", real_failure)
    for module in (exam, stream):
        monkeypatch.setattr(module, "ai_available", lambda *a, **k: pytest.fail("Legacy real attempt must not probe demo capabilities"))
    with pytest.raises(HTTPException) as error:
        run_answer(db, streaming)
    assert error.value.status_code == 502
    assert db.inserted is None and not db.ended


def test_uncommitted_stream_sample_is_not_exposed_after_answer_race(monkeypatch):
    def conflict(*args, **kwargs):
        raise HTTPException(409, "Synthetic question already answered")

    monkeypatch.setattr(stream, "finish_question", conflict)
    events = list(stream.event_stream({"kind": "sample", "seq": 4, "use_demo": True, "developer_demo": True}))
    assert len(events) == 1 and events[0].startswith("event: error")
    assert "event: token" not in "".join(events)
    assert "event: complete" not in "".join(events)
    assert "[Developer demo]" not in "".join(events)


class MaterialDB:
    def __init__(self, summary=None, found=True):
        self.summary = summary
        self.found = found
        self.calls = []

    def execute(self, statement, params=None):
        sql = str(statement)
        self.calls.append(sql)
        if not sql.lstrip().startswith("SELECT"):
            raise AssertionError("Demo excerpts must never be persisted as authoritative material summaries")
        assert "professor_id" in sql and params["professor_id"] == PROFESSOR
        return Result({"id": BANK, "filename": "synthetic.txt", "extracted_text": "Synthetic source material.",
                       "summary": self.summary} if self.found else None)

    def commit(self):
        raise AssertionError("Demo excerpts must not commit material changes")


def summarize(db):
    return asyncio.run(exam.summarize_exam_material(UUID(EXAM), UUID(BANK),
        account={"role": "professor", "professor_id": PROFESSOR}, db=db))


def test_demo_material_excerpt_is_labeled_and_never_persisted(monkeypatch):
    set_flag(monkeypatch, "1")
    monkeypatch.setattr(exam, "ai_available", lambda *a, **k: False)
    monkeypatch.setattr(exam.httpx, "AsyncClient", lambda *a, **k: pytest.fail("Unavailable demo model must not be called"))
    db = MaterialDB()
    response = summarize(db)
    assert response["demo"] is True and response["persisted"] is False and response["cached"] is False
    assert response["summary"].startswith("[Developer demo] ")
    assert "not an AI summary" in response["summary"]
    assert db.summary is None and len(db.calls) == 1


def test_real_cached_material_summary_is_preserved_without_demo_probe(monkeypatch):
    set_flag(monkeypatch, "1")
    monkeypatch.setattr(exam, "ai_available", lambda *a, **k: pytest.fail("Cached real summary must not probe AI"))
    db = MaterialDB(summary="Existing professor material summary")
    response = summarize(db)
    assert response["summary"] == db.summary and response["cached"] is True
    assert not response.get("demo", False) and len(db.calls) == 1


def test_demo_summary_still_requires_owned_material_before_substitution(monkeypatch):
    set_flag(monkeypatch, "1")
    monkeypatch.setattr(exam, "ai_available", lambda *a, **k: pytest.fail("Unauthorized material must not probe AI"))
    with pytest.raises(HTTPException) as error:
        summarize(MaterialDB(found=False))
    assert error.value.status_code == 404
