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


def test_a_short_answer_always_gets_a_follow_up_from_one_small_call(monkeypatch):
    sent = capture(monkeypatch, "Which column would you choose as the key, and why?")
    question, why = exam.ask_follow_up(TEMPLATE, HISTORY)
    assert question == "Which column would you choose as the key, and why?"
    assert why.startswith("Follow-up: ")
    assert len(sent) == 1
    system, user = sent[0]["messages"][0]["content"], sent[0]["messages"][1]["content"]
    assert "NONE" not in system                      # a thin answer cannot be skipped
    assert "Student: It is a key." in user
    assert "rubric" not in user and "course_material" not in user and "format" not in sent[0]


def test_a_full_answer_lets_the_model_skip_the_follow_up(monkeypatch):
    sent = capture(monkeypatch, "NONE")
    assert exam.ask_follow_up(TEMPLATE, LONG_HISTORY) == (None, None)
    assert len(sent) == 1 and "NONE" in sent[0]["messages"][0]["content"]


def test_a_full_answer_can_still_get_a_follow_up(monkeypatch):
    capture(monkeypatch, 'Professor: "How would two tables use that key together?"')
    assert exam.ask_follow_up(TEMPLATE, LONG_HISTORY)[0] == "How would two tables use that key together?"


def test_an_unsure_answer_counts_as_thin_even_when_long(monkeypatch):
    sent = capture(monkeypatch, "What do you remember about how rows are told apart?")
    unsure = "I am not sure, but " + LONG_ANSWER
    assert exam.ask_follow_up(TEMPLATE, [{**HISTORY[0], "answer": unsure}])[0].startswith("What do you remember")
    assert "NONE" not in sent[0]["messages"][0]["content"]


@pytest.mark.parametrize("content", [
    "What is a primary key?",                                  # repeats an asked question
    "That is a good answer.",                                  # not a question
    "Tell me more?",                                           # does not start like a question
    "Why? And how would you use it? Explain both please?",     # more than one question
    "<think>the student seems unsure</think>",                 # reasoning only
    "",
])
def test_unusable_model_text_is_never_spoken(monkeypatch, content):
    sent = capture(monkeypatch, content)
    # A full answer: two tries, then move on without a follow-up.
    assert exam.ask_follow_up(TEMPLATE, LONG_HISTORY) == (None, None)
    assert len(sent) == 2
    # A thin answer: a stock question is used instead.
    question, why = exam.ask_follow_up(TEMPLATE, HISTORY)
    assert question in exam.FOLLOW_UP_FALLBACKS and "stock" in why


def test_the_second_try_is_used_when_the_first_is_unusable(monkeypatch):
    sent = capture(monkeypatch, ["Good answer.", "Why does each row need its own value?"])
    assert exam.ask_follow_up(TEMPLATE, HISTORY)[0] == "Why does each row need its own value?"
    assert len(sent) == 2


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
