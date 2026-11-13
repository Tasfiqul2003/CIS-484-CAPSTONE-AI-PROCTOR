from datetime import date, timedelta, datetime, timezone
from uuid import UUID

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from backend.app import exam_video
from backend.app.auth import get_current_account
from backend.app.db import get_db
from backend.app.exam import require_active_video_recording
from backend.app.review import router as review_router

SESSION_ID = "20000000-0000-4000-8000-000000000001"
STUDENT_ID = "30000000-0000-4000-8000-000000000001"
EXAM_ID = "40000000-0000-4000-8000-000000000001"
PROFESSOR_ID = "50000000-0000-4000-8000-000000000001"


class FakeResult:
    def __init__(self, row=None, rows=None):
        self.row = row
        self.rows = rows or []

    def mappings(self):
        return self

    def first(self):
        return self.row

    def all(self):
        return self.rows


class RecordingDB:
    def __init__(self):
        self.session_status = "in_progress"
        self.video = None

    def execute(self, statement, params=None):
        sql = " ".join(str(statement).lower().split())
        params = params or {}
        if "select id, student_id, exam_template_id, status, developer_demo" in sql:
            return FakeResult({
                "id": UUID(SESSION_ID),
                "student_id": UUID(STUDENT_ID),
                "exam_template_id": UUID(EXAM_ID),
                "status": self.session_status,
                "developer_demo": False,
            })
        if "select status from exam_session_videos" in sql:
            return FakeResult({"status": self.video["status"]} if self.video else None)
        if "insert into exam_session_videos" in sql:
            self.video = {
                "status": "recording",
                "content_type": params["content_type"],
                "next_chunk_index": 0,
                "total_bytes": 0,
                "expires_at": params["expires_at"],
            }
            return FakeResult()
        if "select status, next_chunk_index, total_bytes" in sql:
            return FakeResult(dict(self.video) if self.video else None)
        if "set next_chunk_index = next_chunk_index + 1" in sql:
            self.video["next_chunk_index"] += 1
            self.video["total_bytes"] += params["chunk_bytes"]
            return FakeResult()
        if "select status, content_type, next_chunk_index, total_bytes" in sql:
            return FakeResult(dict(self.video) if self.video else None)
        if "set status = 'completed'" in sql:
            self.video["status"] = "completed"
            self.video["file_name"] = params["file_name"]
            return FakeResult()
        if "select s.status, s.developer_demo, t.professor_id" in sql:
            return FakeResult({
                "status": "pending_grading",
                "developer_demo": False,
                "professor_id": PROFESSOR_ID,
                "video_status": "completed",
                "content_type": "video/webm;codecs=vp8,opus",
                "expires_at": datetime.now(timezone.utc) + timedelta(days=30),
            })
        raise AssertionError(f"Unexpected SQL: {sql}")

    def commit(self):
        return None

    def rollback(self):
        return None


def make_client(db):
    app = FastAPI()
    app.include_router(exam_video.router)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_account] = lambda: {
        "role": "professor",
        "professor_id": PROFESSOR_ID,
    }
    return TestClient(app), app


def test_recording_chunks_are_ordered_and_assembled(
    monkeypatch, tmp_path
):
    monkeypatch.setattr(
        exam_video,
        "read_student_token",
        lambda *_args, **_kwargs: {
            "sub": STUDENT_ID,
            "exam_template_id": EXAM_ID,
            "session_id": SESSION_ID,
        },
    )
    monkeypatch.setattr(exam_video.shutil, "disk_usage", lambda _path: type(
        "Usage", (), {"free": exam_video.MAX_RECORDING_BYTES}
    )())
    monkeypatch.setattr(exam_video, "_recording_root", lambda **_kwargs: tmp_path)
    monkeypatch.setenv("EXAM_VIDEO_RETENTION_UNTIL", (date.today() + timedelta(days=30)).isoformat())
    db = RecordingDB()
    client, app = make_client(db)
    headers = {"Authorization": "Bearer synthetic-token"}

    try:
        started = client.post(
            f"/exam/sessions/{SESSION_ID}/video-recording/start",
            headers=headers,
            json={"content_type": "video/webm;codecs=vp8,opus"},
        )
        assert started.status_code == 200

        first = client.post(
            f"/exam/sessions/{SESSION_ID}/video-recording/chunks",
            headers=headers,
            data={"index": "0"},
            files={"chunk": ("chunk-0.webm", b"first", "video/webm")},
        )
        assert first.status_code == 200
        assert first.json()["duplicate"] is False

        duplicate = client.post(
            f"/exam/sessions/{SESSION_ID}/video-recording/chunks",
            headers=headers,
            data={"index": "0"},
            files={"chunk": ("chunk-0.webm", b"first", "video/webm")},
        )
        assert duplicate.status_code == 200
        assert duplicate.json()["duplicate"] is True

        out_of_order = client.post(
            f"/exam/sessions/{SESSION_ID}/video-recording/chunks",
            headers=headers,
            data={"index": "2"},
            files={"chunk": ("chunk-2.webm", b"third", "video/webm")},
        )
        assert out_of_order.status_code == 409

        db.session_status = "pending_grading"
        incomplete = client.post(
            f"/exam/sessions/{SESSION_ID}/video-recording/complete",
            headers=headers,
            json={"expected_chunk_count": 2},
        )
        assert incomplete.status_code == 409

        completed = client.post(
            f"/exam/sessions/{SESSION_ID}/video-recording/complete",
            headers=headers,
            json={"expected_chunk_count": 1},
        )
        assert completed.status_code == 200
        assert completed.json() == {"status": "completed", "bytes": 5}
        assert (tmp_path / f"{SESSION_ID}.webm").read_bytes() == b"first"
        assert db.video["status"] == "completed"
    finally:
        app.dependency_overrides.clear()
        client.close()


def test_professor_video_is_scoped_to_exam_owner(monkeypatch, tmp_path):
    monkeypatch.setattr(exam_video, "_recording_root", lambda **_kwargs: tmp_path)
    path = tmp_path / f"{SESSION_ID}.webm"
    path.write_bytes(b"synthetic-video")
    client, app = make_client(RecordingDB())

    try:
        allowed = client.get(f"/exam/sessions/{SESSION_ID}/video")
        assert allowed.status_code == 200
        assert allowed.content == b"synthetic-video"

        app.dependency_overrides[get_current_account] = lambda: {
            "role": "professor",
            "professor_id": "60000000-0000-4000-8000-000000000001",
        }
        denied = client.get(f"/exam/sessions/{SESSION_ID}/video")
        assert denied.status_code == 404
    finally:
        app.dependency_overrides.clear()
        client.close()


def test_preflight_requires_an_approved_retention_deadline(monkeypatch, tmp_path):
    monkeypatch.setattr(
        exam_video,
        "read_student_token",
        lambda *_args, **_kwargs: {
            "sub": STUDENT_ID,
            "exam_template_id": EXAM_ID,
        },
    )
    monkeypatch.setenv("EXAM_VIDEO_DIR", str(tmp_path))
    monkeypatch.delenv("EXAM_VIDEO_RETENTION_UNTIL", raising=False)
    client, app = make_client(RecordingDB())

    try:
        response = client.post(
            "/exam/video-recording/preflight",
            json={
                "student_id": STUDENT_ID,
                "exam_template_id": EXAM_ID,
                "student_token": "synthetic-token",
            },
        )
        assert response.status_code == 503
        assert "retention" in response.json()["detail"].lower()
    finally:
        app.dependency_overrides.clear()
        client.close()


def test_answers_require_an_active_recording():
    class NoRecordingDB:
        def execute(self, *_args, **_kwargs):
            return FakeResult()

    class ActiveRecordingDB:
        def execute(self, *_args, **_kwargs):
            return FakeResult({"status": "recording", "next_chunk_index": 1})

    with pytest.raises(HTTPException) as error:
        require_active_video_recording(NoRecordingDB(), SESSION_ID, False)
    assert error.value.status_code == 409

    require_active_video_recording(ActiveRecordingDB(), SESSION_ID, False)
    require_active_video_recording(NoRecordingDB(), SESSION_ID, True)


def test_professor_review_returns_transcript_only_for_completed_owned_video():
    class ReviewDB:
        def execute(self, statement, params=None):
            sql = " ".join(str(statement).lower().split())
            if "join students as st" in sql:
                return FakeResult({
                    "status": "pending_grading",
                    "developer_demo": False,
                    "student_name": "Synthetic Student",
                    "eid": "synthetic-eid",
                    "exam_title": "Synthetic Exam",
                    "course": "Synthetic Course",
                    "professor_id": PROFESSOR_ID,
                    "video_status": "completed",
                    "expires_at": datetime.now(timezone.utc) + timedelta(days=30),
                })
            if "from interactions" in sql:
                return FakeResult(rows=[{
                    "sequence_num": 1,
                    "question": "Synthetic question",
                    "answer": "Synthetic answer",
                }])
            raise AssertionError(f"Unexpected SQL: {sql}")

    app = FastAPI()
    app.include_router(review_router)
    app.dependency_overrides[get_db] = lambda: ReviewDB()
    app.dependency_overrides[get_current_account] = lambda: {
        "role": "professor",
        "professor_id": PROFESSOR_ID,
    }

    with TestClient(app) as client:
        response = client.get(f"/exam/sessions/{SESSION_ID}/review")
        assert response.status_code == 200
        body = response.json()
        assert body["student_name"] == "Synthetic Student"
        assert body["video_url"] == f"/api/exam/sessions/{SESSION_ID}/video"
        assert body["answers"] == [{
            "sequence_num": 1,
            "question": "Synthetic question",
            "answer": "Synthetic answer",
        }]

        app.dependency_overrides[get_current_account] = lambda: {
            "role": "professor",
            "professor_id": "60000000-0000-4000-8000-000000000001",
        }
        denied = client.get(f"/exam/sessions/{SESSION_ID}/review")
        assert denied.status_code == 404
    app.dependency_overrides.clear()
