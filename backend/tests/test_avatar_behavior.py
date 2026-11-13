"""Synthetic live behavior checks; no model, media, or application database."""

import json
from datetime import timedelta

from fastapi import HTTPException
import pytest

from backend.app import exam, stream
from backend.app.avatar_policy import default_settings
from backend.tests.test_question_time_limits import (
    BANK, CLAIMS, EXAM, NOW, SESSION, STUDENT, Result, TurnDB, prepare_turn,
)


SECOND_BANK = "40000000-0000-4000-8000-000000000002"


class BehaviorDB(TurnDB):
    def __init__(self, *, followups=1, current_followup=0, bank=True, order="authored"):
        super().__init__(question_limit=None, question_elapsed=0, exam_elapsed=0)
        self.settings = default_settings()
        self.settings.behavior.followUps = followups
        self.settings.behavior.order = order
        self.current_followup = current_followup
        self.bank = bank
        self.inserted = None
        self.bank_sql = None

    def execute(self, statement, params=None):
        sql = str(statement)
        if "FROM exam_sessions s" in sql:
            result = super().execute(statement, params)
            result.row.update(avatar_policy_snapshot=self.settings.model_dump(),
                              avatar_policy_revision=4, avatar_exam_mode="assessed")
            return result
        if "SELECT id, sequence_num" in sql and "student_answer_transcript IS NULL" in sql:
            return Result({"id": "synthetic-pending", "sequence_num": 3,
                           "avatar_root_sequence": 1, "avatar_followup_index": self.current_followup,
                           "elapsed_min": 0})
        if "FROM questions" in sql:
            self.bank_sql = " ".join(sql.split())
            return Result(rows=[
                {"id": BANK, "question_text": "First authored question", "topic": "synthetic", "difficulty": 1},
                {"id": SECOND_BANK, "question_text": "Later authored question", "topic": "synthetic", "difficulty": 1},
            ] if self.bank else [])
        if "INSERT INTO interactions" in sql:
            self.inserted = dict(params)
        return super().execute(statement, params)


def answer_request():
    return exam.AnswerRequest(session_id=SESSION, answer_transcript="Synthetic response", question_sequence_num=3)


def unexpected_model_call(*args, **kwargs):
    raise AssertionError("The model must not be called when the follow-up allowance is exhausted.")


@pytest.mark.parametrize("streaming", [False, True])
def test_followups_disabled_end_when_no_bank_questions_remain(monkeypatch, streaming):
    db = BehaviorDB(followups=0, bank=False)
    prepare_turn(monkeypatch, db)
    monkeypatch.setattr(exam, "ask_model", unexpected_model_call)
    monkeypatch.setattr(stream, "decide", unexpected_model_call)
    if streaming:
        plan = stream.plan_turn(answer_request(), CLAIMS)
        assert plan["kind"] == "done"
        list(stream.event_stream(plan))
    else:
        assert exam.submit_answer(answer_request(), authorization="synthetic", db=db)["done"] is True
    assert db.ended
    assert db.inserted is None


@pytest.mark.parametrize("streaming", [False, True])
def test_reaching_followup_cap_advances_to_next_authored_question(monkeypatch, streaming):
    db = BehaviorDB(followups=1, current_followup=1)
    prepare_turn(monkeypatch, db)
    monkeypatch.setattr(exam, "ask_model", unexpected_model_call)
    monkeypatch.setattr(stream, "decide", unexpected_model_call)
    if streaming:
        plan = stream.plan_turn(answer_request(), CLAIMS)
        assert plan["kind"] == "bank"
        list(stream.event_stream(plan))
    else:
        assert exam.submit_answer(answer_request(), authorization="synthetic", db=db)["done"] is False
    assert db.inserted["qid"] == BANK
    assert db.inserted["root"] == 4
    assert db.inserted["followup"] == 0


@pytest.mark.parametrize("streaming", [False, True])
def test_authored_bank_order_overrides_model_selection_and_resets_followup_group(monkeypatch, streaming):
    db = BehaviorDB(followups=2, current_followup=1)
    prepare_turn(monkeypatch, db)
    monkeypatch.setattr(exam, "ask_model", lambda *a: {"bank_question_id": SECOND_BANK})
    monkeypatch.setattr(stream, "decide", lambda *a: {"action": "bank", "bank_question_id": SECOND_BANK})
    if streaming:
        list(stream.event_stream(stream.plan_turn(answer_request(), CLAIMS)))
    else:
        exam.submit_answer(answer_request(), authorization="synthetic", db=db)
    assert "ORDER BY avatar_authored_position NULLS LAST, created_at, id" in db.bank_sql
    assert db.inserted["q"] == "First authored question"
    assert (db.inserted["root"], db.inserted["followup"]) == (4, 0)


@pytest.mark.parametrize("streaming", [False, True])
def test_allowed_generated_followup_retains_root_and_increments_index(monkeypatch, streaming):
    db = BehaviorDB(followups=2, current_followup=1, bank=False)
    prepare_turn(monkeypatch, db)
    monkeypatch.setattr(exam, "ask_model", lambda *a: {"question": "Allowed synthetic follow-up"})
    monkeypatch.setattr(stream, "decide", lambda *a: {"action": "follow_up", "follow_up_focus": "Synthetic focus"})
    if streaming:
        plan = stream.plan_turn(answer_request(), CLAIMS)
        assert plan["kind"] == "generate"
        stream.finish_question(plan, "Allowed synthetic follow-up", "generated", None)
    else:
        exam.submit_answer(answer_request(), authorization="synthetic", db=db)
    assert db.inserted["src"] == "generated"
    assert (db.inserted["root"], db.inserted["followup"]) == (1, 2)


@pytest.mark.parametrize("question_minutes,timing,fixed_seconds,expected", [
    (1, "fixed", 120, 60), (2, "fixed", 30, 30),
    (None, "fixed", 45, 45), (2, "exam", 30, 120), (None, "exam", 30, None),
])
def test_effective_response_window_uses_first_applicable_limit(question_minutes, timing, fixed_seconds, expected):
    settings = default_settings()
    settings.behavior.responseTiming = timing
    settings.behavior.responseSeconds = fixed_seconds
    settings.behavior.responseUnit = "minutes"  # A display unit; storage remains seconds.
    session = {"question_time_limit_minutes": question_minutes,
               "avatar_policy_snapshot": settings.model_dump(), "avatar_policy_revision": 2}
    assert exam.effective_question_seconds(session) == expected


def test_response_deadline_includes_only_that_questions_saved_pause():
    settings = default_settings()
    settings.behavior.responseTiming = "fixed"
    settings.behavior.responseSeconds = 45

    class DB:
        def execute(self, statement, params):
            if "FROM exam_sessions" in str(statement):
                return Result({"student_id": STUDENT, "exam_template_id": EXAM,
                    "status": "in_progress", "started_at": NOW, "time_limit_minutes": 1,
                    "question_time_limit_minutes": 1, "extended_time_multiplier": 1.5,
                    "avatar_policy_snapshot": settings.model_dump(), "avatar_policy_revision": 2,
                    "server_now": NOW, "avatar_pause_seconds": 50, "pause_until": None})
            return Result({"sequence_num": 3, "question_text": "Synthetic question",
                           "created_at": NOW, "avatar_pause_seconds": 10})

    state = exam.read_session_state(DB(), SESSION, CLAIMS)
    assert state["deadline"] == (NOW + timedelta(seconds=140)).isoformat()
    assert state["question_deadline"] == (NOW + timedelta(seconds=55)).isoformat()


def test_racing_generated_stream_exposes_no_uncommitted_tokens(monkeypatch):
    class ModelResponse:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def raise_for_status(self): pass
        def iter_lines(self):
            yield json.dumps({"message": {"content": "Uncommitted "}})
            yield json.dumps({"message": {"content": "question"}, "done": True})

    monkeypatch.setattr(stream.httpx, "stream", lambda *a, **k: ModelResponse())

    def lost_race(*args):
        raise HTTPException(409, "Synthetic turn already committed")

    monkeypatch.setattr(stream, "finish_question", lost_race)
    events = list(stream.event_stream({"kind": "generate", "focus": "Synthetic focus",
        "topics": [], "curve": "adaptive", "history": [], "seq": 2}))
    assert len(events) == 1
    assert events[0].startswith("event: error")
    assert "event: token" not in "".join(events)
    assert "Uncommitted question" not in "".join(events)


@pytest.mark.parametrize("mode,expected_uses", [("assessed", 5), ("practice", 9)])
def test_pause_budget_counts_only_enabled_pausing_actions_for_saved_mode(monkeypatch, mode, expected_uses):
    settings = default_settings()
    settings.assistance.repeat.limit = 2
    settings.assistance.repeat.timerContinues = False
    settings.assistance.clarification.limit = 3
    settings.assistance.clarification.timerContinues = False
    settings.assistance.hint.enabled = True
    settings.assistance.hint.limit = 4
    settings.assistance.hint.modes = "practice"
    settings.assistance.hint.timerContinues = False
    settings.assistance.explanation.enabled = True
    settings.assistance.explanation.modes = "both"
    settings.assistance.explanation.limit = 5
    settings.assistance.explanation.timerContinues = True
    settings.assistance.correctness.limit = 10
    settings.assistance.correctness.timerContinues = False
    monkeypatch.setattr(exam, "MAX_QUESTIONS", 3)
    assert exam.assistance_pause_budget_minutes(settings, mode) == 3 * 2 * expected_uses


@pytest.mark.parametrize("mode,expected_token_minutes", [("assessed", 214), ("practice", 278)])
def test_start_token_covers_saved_mode_reading_pause_budget(monkeypatch, mode, expected_token_minutes):
    settings = default_settings()
    settings.assistance.repeat.limit = 2
    settings.assistance.repeat.timerContinues = False
    settings.assistance.clarification.enabled = False
    settings.assistance.hint.enabled = True
    settings.assistance.hint.limit = 4
    settings.assistance.hint.timerContinues = False
    issued = []

    class StartDB:
        def execute(self, statement, params=None):
            sql = str(statement)
            if "FROM student_face_verifications" in sql:
                return Result({"status": "matched", "attempt_count": 1})
            if "SELECT * FROM exam_templates" in sql:
                return Result({"status": "published"})
            if "INSERT INTO exam_sessions" in sql:
                assert params["avatar_mode"] == mode
                return Result({"id": SESSION, "time_limit_minutes": 121,
                               "extended_time_multiplier": 1.25})
            if "FROM students" in sql or "FROM exam_roster" in sql:
                return Result({"id": STUDENT})
            if "FROM questions" in sql:
                return Result({"id": BANK, "question_text": "Synthetic opening question"})
            if "INSERT INTO interactions" in sql:
                return Result()
            raise AssertionError(sql)

        def commit(self): pass

    monkeypatch.setattr(exam, "MAX_QUESTIONS", 8)
    monkeypatch.setattr(exam, "snapshot_for_exam", lambda *args: (settings, 5, mode))
    monkeypatch.setattr(exam, "read_student_token", lambda *args, **kwargs: CLAIMS)
    monkeypatch.setattr(exam, "read_session_state", lambda *args: {})
    monkeypatch.setattr(exam, "issue_student_token", lambda **kwargs: issued.append(kwargs) or "synthetic-token")
    exam.start_exam(exam.StartRequest(student_id=STUDENT, exam_template_id=EXAM,
                                     student_token="synthetic"), db=StartDB())
    assert issued[0]["minutes"] == expected_token_minutes
