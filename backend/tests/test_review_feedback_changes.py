"""Synthetic checks for the review-feedback changes: follow-up decisions, finished exams, presence flags."""
from datetime import datetime, timezone
import json

from fastapi import HTTPException
import pytest

from backend.app import exam, grading, presence
from backend.tests.test_question_time_limits import CLAIMS, EXAM, STUDENT, Result

HISTORY = [
    {"sequence_num": 1, "question": "What is a primary key?", "answer": "It is a key."},
]
TEMPLATE = {"attempt_rubric": {"criteria":[{"name":"Keys","max_score":5}]},
    "topic_coverage_required": "keys", "remaining_followups": 1, "root_sequence": 1}


class ModelReply:
    def __init__(self, content):
        self.content = content

    def raise_for_status(self):
        pass

    def json(self):
        return {"done": True, "done_reason": "stop", "message": {"content": self.content}}


def reply(monkeypatch, content=None, error=None):
    def post(*args, **kwargs):
        if error:
            raise error
        return ModelReply(content)
    monkeypatch.setattr(exam.httpx, "post", post)


LONG_ANSWER = ("A primary key is a column, or a set of columns, whose value is different in every row, so each row "
               "can be found and referenced from other tables without any ambiguity at all.")
LONG_HISTORY = [{**HISTORY[0], "answer": LONG_ANSWER}]


def capture(monkeypatch, content):
    sent = []

    def post(url, json, timeout):
        sent.append(json)
        return ModelReply(content if isinstance(content, str) else content[min(len(sent), len(content)) - 1])
    monkeypatch.setattr(exam.httpx, "post", post)
    return sent


def decision(question="", ask=True, root=1):
    return json.dumps({"ask":ask,"root_sequence":root,"unmet_evidence":"Need a concrete key example.","question":question})


def test_short_answer_can_skip_and_context_is_supplied(monkeypatch):
    sent=capture(monkeypatch,decision(ask=False))
    assert exam.ask_follow_up(TEMPLATE,HISTORY,["Approved key material"]) == (None,None)
    assert len(sent)==1
    payload=json.loads(sent[0]["messages"][1]["content"])
    assert payload["approved_root"] == HISTORY[0]["question"]
    assert payload["rubric"] == TEMPLATE["attempt_rubric"]
    assert payload["approved_material"] == ["Approved key material"]
    assert sent[0]["format"]["type"] == "object"


def test_missing_evidence_can_receive_one_targeted_followup(monkeypatch):
    sent=capture(monkeypatch,decision("How would two tables use that key together?"))
    assert exam.ask_follow_up(TEMPLATE,LONG_HISTORY)[0] == "How would two tables use that key together?"
    assert len(sent)==1


def test_uncertainty_alone_does_not_force_a_question(monkeypatch):
    capture(monkeypatch,decision(ask=False))
    assert exam.ask_follow_up(TEMPLATE,[{**HISTORY[0],"answer":"I am not sure."}]) == (None,None)


@pytest.mark.parametrize("content", ["What is a primary key?", "That is a good answer.", "Tell me more?",
    "Why? And how would you use it?", "<think>private reasoning</think>", ""])
def test_unusable_model_text_is_never_spoken_or_replaced_with_stock(monkeypatch,content):
    sent=capture(monkeypatch,decision(content))
    assert exam.ask_follow_up(TEMPLATE,LONG_HISTORY) == (None,None)
    assert len(sent)==1
    assert exam.ask_follow_up(TEMPLATE,HISTORY) == (None,None)


def test_wrong_root_and_zero_allowance_fail_closed(monkeypatch):
    capture(monkeypatch,decision("Why does each row need a unique value?",root=9))
    assert exam.ask_follow_up(TEMPLATE,HISTORY) == (None,None)
    reply(monkeypatch,error=AssertionError("No provider call"))
    assert exam.ask_follow_up({**TEMPLATE,"remaining_followups":0},HISTORY) == (None,None)


def test_follow_up_failure_never_blocks_the_exam(monkeypatch):
    reply(monkeypatch, error=exam.httpx.ConnectError("model offline"))
    assert exam.ask_follow_up(TEMPLATE, HISTORY) == (None, None)


def test_no_follow_up_for_an_empty_answer(monkeypatch):
    reply(monkeypatch, error=AssertionError("the model must not be called"))
    assert exam.ask_follow_up(TEMPLATE, [{**HISTORY[0], "answer": "  "}]) == (None, None)


def test_a_finished_exam_cannot_be_started_again(monkeypatch):
    class DB:
        def execute(self, statement, params=None):
            sql = str(statement)
            if "SELECT * FROM exam_templates" in sql:
                return Result({"status": "published"})
            if "FROM exam_roster" in sql:
                return Result({"on_roster": 1, "completed_at": datetime(2026, 11, 13, tzinfo=timezone.utc)})
            if "FROM students" in sql:
                return Result({"id": STUDENT})
            raise AssertionError(f"No attempt may be created: {sql}")

    monkeypatch.setattr(exam, "read_student_token", lambda *a, **k: CLAIMS)
    monkeypatch.setattr(exam, "demo_enabled", lambda: False)
    with pytest.raises(HTTPException) as error:
        exam.start_exam(exam.StartRequest(student_id=STUDENT, exam_template_id=EXAM,
                                          student_token="synthetic"), db=DB())
    assert error.value.status_code == 409
    assert "already completed" in error.value.detail


@pytest.mark.parametrize("faces,event", [(0, "face_not_visible"), (1, None), (2, "multiple_faces"), (3, "multiple_faces")])
def test_presence_events(faces, event):
    assert presence.presence_event(faces) == event
    if event:
        severity, _ = presence.EVENTS[event]
        assert severity < 4  # presence flags inform the professor; they never auto-flag an attempt


def test_default_rubric_has_named_criteria():
    assert all(c["name"] and c["max_score"] > 0 for c in grading.DEFAULT_CRITERIA)
