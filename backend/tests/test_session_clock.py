"""Synthetic session clock and ownership tests; no application database."""
from datetime import datetime, timezone
from uuid import UUID

import pytest
from fastapi import HTTPException
from backend.app import exam

SID = "30000000-0000-4000-8000-000000000001"


@pytest.mark.parametrize("minutes", [None, 30, 240])
def test_clock_uses_saved_start_and_session_limit(monkeypatch, minutes):
    monkeypatch.setattr(exam, "read_student_token", lambda *a, **k: {
        "session_id": SID, "sub": "synthetic-student", "exam_template_id": "synthetic-exam"})
    class Result:
        def __init__(self, row): self.row = row
        def mappings(self): return self
        def first(self): return self.row
    class DB:
        def execute(self, statement, params):
            if "FROM exam_sessions" in str(statement):
                return Result({"student_id": "synthetic-student", "exam_template_id": "synthetic-exam",
                    "status": "in_progress", "started_at": datetime(2026, 1, 1, tzinfo=timezone.utc),
                    "time_limit_minutes": minutes, "server_now": datetime(2026, 1, 1, 0, 5, tzinfo=timezone.utc),
                    "avatar_policy_snapshot": None, "avatar_policy_revision": 0})
            return Result({"sequence_num": 2, "question_text": "Synthetic question"})
    first = exam.get_session_state(UUID(SID), authorization="synthetic", db=DB())
    assert first == exam.get_session_state(UUID(SID), authorization="synthetic", db=DB())
    assert first["deadline"] == (None if minutes is None else f"2026-01-01T{minutes // 60:02}:{minutes % 60:02}:00+00:00")
    assert first["question"] == "Synthetic question"


def test_other_session_token_cannot_read_clock(monkeypatch):
    monkeypatch.setattr(exam, "read_student_token", lambda *a, **k: {"session_id": "other"})
    with pytest.raises(HTTPException) as error:
        exam.get_session_state(UUID(SID), authorization="synthetic", db=None)
    assert error.value.status_code == 403
