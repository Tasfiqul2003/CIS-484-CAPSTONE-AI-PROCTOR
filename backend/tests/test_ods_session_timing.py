"""Synthetic ODS attempt snapshots and clocks; no application DB or model."""
from datetime import timedelta
from decimal import Decimal
from uuid import UUID

from fastapi import HTTPException
import pytest

from backend.app import exam, stream
from backend.tests.test_question_time_limits import (
    BANK, CLAIMS, EXAM, NOW, SESSION, STUDENT, Result, TurnDB, prepare_turn,
)


@pytest.mark.parametrize("minutes,multiplier,expected", [
    (1, Decimal("1.25"), 1.25), (30, Decimal("1.5"), 45),
    (240, Decimal("3"), 720), (None, Decimal("2"), None), (30, 1, 30),
])
def test_effective_exam_duration_preserves_fractional_minutes(minutes, multiplier, expected):
    assert exam.effective_exam_minutes({
        "time_limit_minutes": minutes, "extended_time_multiplier": multiplier,
    }) == expected


def test_saved_multiplier_extends_exam_deadline_without_extending_question_or_resetting_resume():
    class DB:
        def execute(self, statement, params):
            sql = str(statement)
            if "FROM exam_sessions" in sql:
                return Result({"student_id": STUDENT, "exam_template_id": EXAM,
                    "status": "in_progress", "started_at": NOW,
                    "time_limit_minutes": 1, "question_time_limit_minutes": 1,
                    "extended_time_multiplier": Decimal("1.25"), "server_now": NOW})
            if "FROM interactions" in sql:
                return Result({"sequence_num": 1, "question_text": "Synthetic question", "created_at": NOW})
            raise AssertionError("Resume must not reload current template or roster accommodations")

    state = exam.read_session_state(DB(), SESSION, CLAIMS)
    assert state == exam.read_session_state(DB(), SESSION, CLAIMS)
    assert state["deadline"] == (NOW + timedelta(seconds=75)).isoformat()
    assert state["question_deadline"] == (NOW + timedelta(seconds=60)).isoformat()


class AccommodatedTurnDB(TurnDB):
    def execute(self, statement, params=None):
        result = super().execute(statement, params)
        if "FROM exam_sessions s" in str(statement):
            result.row.update(time_limit_minutes=1, extended_time_multiplier=Decimal("1.25"))
        return result


@pytest.mark.parametrize("streaming", [False, True])
@pytest.mark.parametrize("elapsed,expired", [(1, False), (1.249, False), (1.25, True), (2, True)])
def test_answer_routes_enforce_extended_total_boundary(monkeypatch, streaming, elapsed, expired):
    db = AccommodatedTurnDB(question_limit=None, exam_elapsed=elapsed)
    prepare_turn(monkeypatch, db)
    req = exam.AnswerRequest(session_id=SESSION, answer_transcript="Synthetic answer", question_sequence_num=1)
    if streaming:
        plan = stream.plan_turn(req, CLAIMS)
        assert (plan["kind"] == "done") is expired
        list(stream.event_stream(plan))
    else:
        assert exam.submit_answer(req, authorization="synthetic", db=db)["done"] is expired
    assert db.ended is expired


@pytest.mark.parametrize("streaming", [False, True])
def test_extended_exam_time_does_not_extend_question_timeout(monkeypatch, streaming):
    db = AccommodatedTurnDB(question_limit=1, question_elapsed=1, exam_elapsed=1)
    prepare_turn(monkeypatch, db)
    req = exam.AnswerRequest(session_id=SESSION, answer_transcript="Late synthetic answer")
    if streaming:
        plan = stream.plan_turn(req, CLAIMS)
        assert plan["kind"] == "bank"
        list(stream.event_stream(plan))
    else:
        assert exam.submit_answer(req, authorization="synthetic", db=db)["done"] is False
    assert db.saved["a"] == exam.QUESTION_TIMEOUT_ANSWER
    assert not db.ended


@pytest.mark.parametrize("base,multiplier,token_minutes", [
    (240, Decimal("3"), 750), (121, Decimal("1.25"), 182), (None, 1, 180),
])
def test_start_uses_persisted_accommodation_for_token_lifetime(monkeypatch, base, multiplier, token_minutes):
    issued = []

    class DB:
        def execute(self, statement, params=None):
            sql = str(statement)
            if "SELECT * FROM exam_templates" in sql:
                # Different from the insert snapshot; the token must use the saved attempt.
                return Result({"status": "published", "time_limit_minutes": 10})
            if "INSERT INTO exam_sessions" in sql:
                assert "COALESCE(r.extended_time_multiplier, 1)" in sql
                assert params["s"] == STUDENT and params["t"] == EXAM
                return Result({"id": SESSION, "time_limit_minutes": base, "extended_time_multiplier": multiplier})
            if "FROM students" in sql or "FROM exam_roster" in sql:
                return Result({"id": STUDENT})
            if "FROM questions" in sql:
                return Result({"id": BANK, "question_text": "Synthetic opening question"})
            if "INSERT INTO interactions" in sql:
                return Result()
            raise AssertionError(sql)

        def commit(self):
            pass

    monkeypatch.setattr(exam, "read_student_token", lambda *a, **k: CLAIMS)
    monkeypatch.setattr(exam, "issue_student_token", lambda **kw: issued.append(kw) or "synthetic-token")
    monkeypatch.setattr(exam, "snapshot_for_exam", lambda *a: (exam.session_policy({"avatar_policy_revision": 0, "avatar_policy_snapshot": None}), 0, "assessed"))
    monkeypatch.setattr(exam, "read_session_state", lambda *a: {})
    exam.start_exam(exam.StartRequest(student_id=STUDENT, exam_template_id=EXAM,
                                    student_token="synthetic"), db=DB())
    assert issued[0]["minutes"] == token_minutes


def test_start_refuses_if_roster_membership_disappears_before_snapshot(monkeypatch):
    class DB:
        rolled_back = False

        def execute(self, statement, params=None):
            sql = str(statement)
            if "SELECT * FROM exam_templates" in sql:
                return Result({"status": "published"})
            if "INSERT INTO exam_sessions" in sql:
                return Result()
            if "FROM students" in sql or "FROM exam_roster" in sql:
                return Result({"id": STUDENT})
            raise AssertionError("No question may be inserted without roster membership")

        def rollback(self):
            self.rolled_back = True

    monkeypatch.setattr(exam, "read_student_token", lambda *a, **k: CLAIMS)
    monkeypatch.setattr(exam, "snapshot_for_exam", lambda *a: (exam.session_policy({"avatar_policy_revision": 0, "avatar_policy_snapshot": None}), 0, "assessed"))
    db = DB()
    with pytest.raises(HTTPException) as error:
        exam.start_exam(exam.StartRequest(student_id=STUDENT, exam_template_id=EXAM,
                                        student_token="synthetic"), db=db)
    assert error.value.status_code == 403
    assert db.rolled_back
