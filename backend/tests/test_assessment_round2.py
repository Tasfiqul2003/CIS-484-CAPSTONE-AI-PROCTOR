"""Automatic AI assessment, per-answer evaluations and the per-exam rubric. Synthetic data, no model."""
import json
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
import pytest

from backend.app import grading

SID = "70000000-0000-4000-8000-000000000001"
EXAM = "70000000-0000-4000-8000-000000000002"
PROF = "70000000-0000-4000-8000-000000000003"


class Result:
    def __init__(self, row=None, rows=(), scalar=None):
        self.row, self.rows, self._scalar = row, list(rows), scalar

    def mappings(self):
        return self

    def first(self):
        return self.row

    def all(self):
        return self.rows

    def scalar_one(self):
        return self._scalar

    def scalar(self):
        return self._scalar


class AssessDB:
    def __init__(self, rubric=None):
        self.rubric = rubric if rubric is not None else {"criteria": grading.DEFAULT_CRITERIA}
        self.updates, self.grades, self.committed = [], [], False

    def execute(self, statement, params=None):
        sql = " ".join(str(statement).split())
        if "FROM exam_sessions s JOIN exam_templates t" in sql:
            return Result({"status": "pending_grading", "developer_demo": False, "professor_id": PROF,
                           "assessment_rubric_snapshot": self.rubric, "title": "Synthetic", "topic_coverage_required": "keys",
                           "video_status": "completed",
                           "video_expires_at": datetime.now(timezone.utc) + timedelta(days=30)})
        if "pg_advisory_xact_lock" in sql:
            return Result()
        if "SELECT count(*) FROM grades" in sql:
            return Result(scalar=0)
        if "FROM interactions" in sql and "student_answer_transcript IS NOT NULL" in sql:
            return Result(rows=[{"sequence_num": 1, "question": "Q1?", "answer": "A1"},
                                {"sequence_num": 2, "question": "Follow-up?", "answer": "A2"}])
        if "INSERT INTO grades" in sql:
            self.grades.append(params)
            return Result()
        if "UPDATE interactions SET ai_evaluation" in sql:
            self.updates.append(params)
            return Result()
        raise AssertionError(sql)

    def commit(self):
        self.committed = True


class Reply:
    def __init__(self, content):
        self.content = content

    def raise_for_status(self):
        pass

    def json(self):
        return {"done": True, "done_reason": "stop", "message": {"content": json.dumps(self.content)}}


def test_assessment_saves_scores_and_an_evaluation_for_each_answer(monkeypatch):
    sent = {}

    def post(url, json, timeout):
        sent.update(json)
        return Reply({"scores": [{"criterion": c["name"], "score": 7, "rationale": "ok"} for c in grading.DEFAULT_CRITERIA],
                      "questions": [{"sequence_num": 1, "evaluation": "Correct but brief."},
                                    {"sequence_num": 2, "evaluation": "Missing an example."},
                                    {"sequence_num": 9, "evaluation": "Not a real question number."}]})

    monkeypatch.setattr(grading.httpx, "post", post)
    db = AssessDB()
    result = grading.assess_session(db, SID)  # automatic run: no professor
    assert result["default_rubric"] is False and len(db.grades) == 3 and db.committed
    assert [u["n"] for u in db.updates] == [1, 2]
    assert db.updates[1]["evaluation"] == "Missing an example."
    assert '"questions"' in sent["messages"][0]["content"]


def test_a_professor_cannot_assess_someone_elses_exam(monkeypatch):
    monkeypatch.setattr(grading.httpx, "post", lambda *a, **k: pytest.fail("no model call"))
    with pytest.raises(HTTPException) as error:
        grading.assess_session(AssessDB(), SID, professor_id="someone-else")
    assert error.value.status_code == 404


def test_custom_rubric_descriptions_reach_the_model(monkeypatch):
    seen = {}

    def post(url, json, timeout):
        seen["payload"] = json["messages"][1]["content"]
        return Reply({"scores": [{"criterion": "Terminology", "score": 3, "rationale": "Uses terms."}], "questions": []})

    monkeypatch.setattr(grading.httpx, "post", post)
    grading.assess_session(AssessDB({"criteria": [{"name": "Terminology", "max_score": 5, "description": "Uses PK/FK"}]}), SID)
    payload = json.loads(seen["payload"])
    assert payload["criteria"] == [{"name": "Terminology", "max_score": 5.0, "description": "Uses PK/FK"}]


@pytest.mark.parametrize("rubric", [{}, None, "not json", {"criteria": [{"name": "A"}]},
    {"criteria": [{"name": "A", "weight": 0.5}]}, {"type": "qualitative", "criteria": [{"name": "A", "max_score": 2}]}])
def test_invalid_rubrics_are_not_silently_converted(rubric):
    with pytest.raises(HTTPException):
        grading.rubric_criteria(rubric)


def test_explicit_points_rubric_parsing():
    assert grading.rubric_criteria('{"criteria":[{"name":"A","max_score":2}]}') == [
        {"name": "A", "description": "", "max_score": 2.0}]


class RubricDB:
    def __init__(self):
        self.saved = None

    def execute(self, statement, params=None):
        sql = " ".join(str(statement).split())
        if sql.startswith("SELECT professor_id, rubric FROM exam_templates"):
            return Result({"professor_id": PROF, "rubric": {}})
        if sql.startswith("UPDATE exam_templates SET rubric"):
            self.saved = json.loads(params["r"])
            return Result()
        raise AssertionError(sql)

    def commit(self):
        pass


def test_rubric_save_and_reset_to_default():
    db, me = RubricDB(), {"professor_id": PROF}
    body = grading.RubricRequest(criteria=[{"name": " Terminology ", "max_score": 5, "description": " "}])
    assert grading.save_rubric(EXAM, body, me, db)["criteria"] == [{"name": "Terminology", "max_score": 5.0}]
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        grading.RubricRequest(criteria=[])
    result = grading.save_rubric(EXAM, grading.RubricRequest(criteria=grading.DEFAULT_CRITERIA), me, db)
    assert result["default"] is False and len(db.saved["criteria"]) == 3


def test_rubric_rejects_duplicate_names_and_other_professors():
    body = grading.RubricRequest(criteria=[{"name": "A", "max_score": 1}, {"name": "a", "max_score": 2}])
    with pytest.raises(HTTPException) as error:
        grading.save_rubric(EXAM, body, {"professor_id": PROF}, RubricDB())
    assert error.value.status_code == 422
    with pytest.raises(HTTPException) as error:
        grading.get_rubric(EXAM, {"professor_id": "someone-else"}, RubricDB())
    assert error.value.status_code == 404


def test_assessment_state_reports_running_and_failures(monkeypatch):
    started = []
    monkeypatch.setattr(grading.threading, "Thread", lambda target, args, daemon: type("T", (), {"start": lambda self: started.append(args)})())
    assert grading.start_auto_assessment("s-1") is True
    assert grading.assessment_state("s-1") == {"status": "running"}
    assert grading.start_auto_assessment("s-1") is False and started == [("s-1",)]
    grading._ASSESSING.discard("s-1")
    grading._ASSESS_FAILED["s-1"] = "model offline"
    assert grading.assessment_state("s-1") == {"status": "failed", "error": "model offline"}
    grading._ASSESS_FAILED.pop("s-1")
