"""Synthetic checks for the review-feedback changes: follow-up decisions, finished exams, presence flags."""
from datetime import datetime, timezone

from fastapi import HTTPException
import pytest

from backend.app import exam, grading, presence
from backend.tests.test_question_time_limits import CLAIMS, EXAM, STUDENT, Result

HISTORY = [
    {"sequence_num": 1, "question": "What is a primary key?", "answer": "It is a key."},
]
TEMPLATE = {"rubric": {}, "topic_coverage_required": "keys"}


class ModelReply:
    def __init__(self, content):
        self.content = content

    def raise_for_status(self):
        pass

    def json(self):
        return {"message": {"content": self.content}}


def reply(monkeypatch, content=None, error=None):
    def post(*args, **kwargs):
        if error:
            raise error
        return ModelReply(content)
    monkeypatch.setattr(exam.httpx, "post", post)


def test_follow_up_is_asked_when_the_model_wants_one(monkeypatch):
    reply(monkeypatch, '{"follow_up": true, "question": "Which column would you choose as the key, and why?", "reasoning": "vague"}')
    question, why = exam.ask_follow_up(TEMPLATE, HISTORY)
    assert question == "Which column would you choose as the key, and why?"
    assert why == "vague"


@pytest.mark.parametrize("content", [
    '{"follow_up": false, "question": ""}',
    '{"follow_up": true, "question": ""}',
    '{"follow_up": true, "question": "What is a primary key?"}',   # repeats an asked question
    '{"follow_up": "yes", "question": "Something else?"}',         # not a real boolean
    'not json',
])
def test_follow_up_is_skipped_unless_valid_and_new(monkeypatch, content):
    reply(monkeypatch, content)
    assert exam.ask_follow_up(TEMPLATE, HISTORY) == (None, None)


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
