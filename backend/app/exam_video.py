import os
import shutil
import tempfile
from datetime import date, datetime, time, timezone
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from .auth import require_professor
from .db import get_db
from .developer_demo import demo_enabled
from .student_auth import read_student_token

router = APIRouter(prefix="/exam", tags=["exam video"])

MAX_RECORDING_BYTES = 512 * 1024 * 1024
MAX_CHUNK_BYTES = 10 * 1024 * 1024


class RecordingPreflightRequest(BaseModel):
    student_id: UUID
    exam_template_id: UUID
    student_token: str = Field(min_length=1)


class RecordingStartRequest(BaseModel):
    content_type: str = Field(min_length=1, max_length=120)


class RecordingCompleteRequest(BaseModel):
    expected_chunk_count: int = Field(ge=1)


def _retention_deadline() -> datetime:
    value = os.getenv("EXAM_VIDEO_RETENTION_UNTIL", "").strip()
    if not value:
        raise HTTPException(
            503,
            "Exam video retention is not configured. Contact the administrator.",
        )
    try:
        if len(value) == 10:
            deadline = datetime.combine(
                date.fromisoformat(value), time.max, tzinfo=timezone.utc
            )
        else:
            deadline = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if deadline.tzinfo is None:
                raise ValueError("A timezone is required.")
            deadline = deadline.astimezone(timezone.utc)
    except ValueError as error:
        raise HTTPException(
            503,
            "EXAM_VIDEO_RETENTION_UNTIL must be an ISO date or timezone-aware timestamp.",
        ) from error
    if deadline <= datetime.now(timezone.utc):
        raise HTTPException(
            503,
            "The configured video-retention deadline has passed.",
        )
    return deadline


def _recording_root(
    *,
    require_space: bool = False,
    write_required: bool = True,
) -> Path:
    configured = os.getenv("EXAM_VIDEO_DIR", "").strip()
    if not configured:
        raise HTTPException(
            503,
            "Exam video storage is not configured. Contact the administrator.",
        )
    root = Path(configured).expanduser().resolve()
    try:
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not root.is_dir():
            raise OSError("The configured video path is not a directory.")
        if write_required:
            os.chmod(root, 0o700)
            with tempfile.NamedTemporaryFile(dir=root, prefix=".write-check-", delete=True):
                pass
    except OSError as error:
        raise HTTPException(
            503,
            "Exam video storage is not writable. Contact the administrator.",
        ) from error
    if require_space and shutil.disk_usage(root).free < MAX_RECORDING_BYTES:
        raise HTTPException(
            507,
            "Exam video storage does not have enough free space for a recording.",
        )
    return root


def _session_for_student(
    db: Session,
    session_id: UUID,
    authorization: str | None,
    allowed_statuses: tuple[str, ...],
):
    sid = str(session_id)
    claims = read_student_token(
        authorization,
        expected_purpose="student_session",
    )
    if claims.get("session_id") != sid:
        raise HTTPException(403, "Student token does not match this session.")
    session = db.execute(
        text("""SELECT id, student_id, exam_template_id, status, developer_demo
                FROM exam_sessions WHERE id = CAST(:sid AS uuid)"""),
        {"sid": sid},
    ).mappings().first()
    if not session:
        raise HTTPException(404, "Session not found.")
    if (
        claims.get("sub") != str(session["student_id"])
        or claims.get("exam_template_id") != str(session["exam_template_id"])
    ):
        raise HTTPException(403, "Student token does not match this exam session.")
    if session["status"] not in allowed_statuses:
        raise HTTPException(409, f"Session is {session['status']}.")
    if session.get("developer_demo", False):
        raise HTTPException(409, "Developer demo attempts are not recorded.")
    return session


def _session_video_dir(root: Path, session_id: UUID) -> Path:
    session_dir = root / str(session_id)
    chunks_dir = session_dir / "chunks"
    if session_dir.is_symlink() or chunks_dir.is_symlink():
        raise HTTPException(500, "Invalid exam recording storage path.")
    chunks_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    if (
        session_dir.resolve().parent != root.resolve()
        or chunks_dir.resolve().parent != session_dir.resolve()
    ):
        raise HTTPException(500, "Invalid exam recording storage path.")
    return chunks_dir


@router.post("/video-recording/preflight")
def preflight_video_recording(
    body: RecordingPreflightRequest,
):
    claims = read_student_token(
        f"Bearer {body.student_token}",
        expected_purpose="student_exam",
    )
    if (
        claims.get("sub") != str(body.student_id)
        or claims.get("exam_template_id") != str(body.exam_template_id)
    ):
        raise HTTPException(403, "Student token does not match this exam.")
    if demo_enabled():
        return {"ready": True, "recording_required": False}
    _retention_deadline()
    _recording_root(require_space=True)
    return {"ready": True, "recording_required": True}


@router.post("/sessions/{session_id}/video-recording/start")
def start_video_recording(
    session_id: UUID,
    body: RecordingStartRequest,
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
):
    session = _session_for_student(
        db, session_id, authorization, ("in_progress",)
    )
    if body.content_type.split(";", 1)[0].strip().lower() != "video/webm":
        raise HTTPException(415, "The browser must support WebM video recording.")
    deadline = _retention_deadline()
    root = _recording_root(require_space=True)
    chunks_dir = _session_video_dir(root, session_id)
    if any(chunks_dir.iterdir()):
        raise HTTPException(
            409,
            "An earlier recording was interrupted. Contact your professor before resuming.",
        )

    existing = db.execute(
        text("""SELECT status FROM exam_session_videos
                WHERE session_id = CAST(:sid AS uuid) FOR UPDATE"""),
        {"sid": str(session_id)},
    ).mappings().first()
    if existing:
        raise HTTPException(
            409,
            "An earlier recording was started. Contact your professor before resuming.",
        )
    db.execute(
        text("""INSERT INTO exam_session_videos
                    (session_id, status, content_type, expires_at)
                VALUES (CAST(:sid AS uuid), 'recording', :content_type, :expires_at)"""),
        {
            "sid": str(session_id),
            "content_type": body.content_type,
            "expires_at": deadline,
        },
    )
    db.commit()
    return {"status": "recording", "next_chunk_index": 0}


@router.post("/sessions/{session_id}/video-recording/chunks")
async def upload_video_chunk(
    session_id: UUID,
    index: int = Form(..., ge=0),
    chunk: UploadFile = File(...),
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
):
    session = _session_for_student(
        db,
        session_id,
        authorization,
        ("in_progress", "pending_grading", "flagged"),
    )
    data = await chunk.read(MAX_CHUNK_BYTES + 1)
    await chunk.close()
    if not data:
        raise HTTPException(400, "The recording chunk is empty.")
    if len(data) > MAX_CHUNK_BYTES:
        raise HTTPException(413, "A recording chunk exceeds the 10 MB limit.")

    video = db.execute(
        text("""SELECT status, next_chunk_index, total_bytes
                FROM exam_session_videos
                WHERE session_id = CAST(:sid AS uuid)
                FOR UPDATE"""),
        {"sid": str(session_id)},
    ).mappings().first()
    if not video or video["status"] != "recording":
        raise HTTPException(409, "The exam recording is not accepting chunks.")

    root = _recording_root()
    chunks_dir = _session_video_dir(root, session_id)
    chunk_path = chunks_dir / f"{index:08d}.chunk"
    if index < int(video["next_chunk_index"]):
        try:
            same_chunk = chunk_path.read_bytes() == data
        except OSError:
            same_chunk = False
        if not same_chunk:
            raise HTTPException(409, "This recording chunk index was already used.")
        return {"accepted": True, "duplicate": True, "index": index}
    if index != int(video["next_chunk_index"]):
        raise HTTPException(409, "Recording chunks must be uploaded in order.")
    if int(video["total_bytes"]) + len(data) > MAX_RECORDING_BYTES:
        raise HTTPException(413, "The exam recording exceeds the 512 MB limit.")

    try:
        if chunk_path.exists():
            if chunk_path.read_bytes() != data:
                raise HTTPException(409, "This recording chunk index was already used.")
        else:
            with chunk_path.open("xb") as target:
                target.write(data)
                target.flush()
                os.fsync(target.fileno())
            os.chmod(chunk_path, 0o600)
        db.execute(
            text("""UPDATE exam_session_videos
                    SET next_chunk_index = next_chunk_index + 1,
                        total_bytes = total_bytes + :chunk_bytes
                    WHERE session_id = CAST(:sid AS uuid)"""),
            {"sid": str(session_id), "chunk_bytes": len(data)},
        )
        db.commit()
    except OSError as error:
        db.rollback()
        try:
            chunk_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise HTTPException(507, "Unable to persist the exam recording chunk.") from error
    return {"accepted": True, "duplicate": False, "index": index}


@router.post("/sessions/{session_id}/video-recording/complete")
def complete_video_recording(
    session_id: UUID,
    body: RecordingCompleteRequest,
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
):
    _session_for_student(
        db,
        session_id,
        authorization,
        ("pending_grading", "flagged", "graded"),
    )
    video = db.execute(
        text("""SELECT status, content_type, next_chunk_index, total_bytes
                FROM exam_session_videos
                WHERE session_id = CAST(:sid AS uuid)
                FOR UPDATE"""),
        {"sid": str(session_id)},
    ).mappings().first()
    if not video:
        raise HTTPException(409, "No exam recording was initialized.")
    if body.expected_chunk_count != int(video["next_chunk_index"]):
        raise HTTPException(409, "Not all exam recording chunks have been uploaded.")
    if video["status"] == "completed":
        return {"status": "completed", "bytes": int(video["total_bytes"])}
    if video["status"] != "recording" or int(video["next_chunk_index"]) < 1:
        raise HTTPException(409, "The exam recording has no uploaded video data.")

    root = _recording_root()
    chunks_dir = _session_video_dir(root, session_id)
    final_path = root / f"{session_id}.webm"
    temp_path = root / f".{session_id}.webm.tmp"
    try:
        if not final_path.is_file():
            with temp_path.open("wb") as target:
                for index in range(int(video["next_chunk_index"])):
                    chunk_path = chunks_dir / f"{index:08d}.chunk"
                    with chunk_path.open("rb") as source:
                        while True:
                            data = source.read(1024 * 1024)
                            if not data:
                                break
                            target.write(data)
                target.flush()
                os.fsync(target.fileno())
            os.chmod(temp_path, 0o600)
            os.replace(temp_path, final_path)
        if final_path.stat().st_size != int(video["total_bytes"]):
            raise OSError("Final video size does not match uploaded chunks.")
        if chunks_dir.is_dir():
            for chunk_path in chunks_dir.iterdir():
                if chunk_path.is_file():
                    chunk_path.unlink()
            chunks_dir.rmdir()
            chunks_dir.parent.rmdir()
    except OSError as error:
        db.rollback()
        raise HTTPException(507, "Unable to finalize the exam recording.") from error

    db.execute(
        text("""UPDATE exam_session_videos
                SET status = 'completed', file_name = :file_name,
                    completed_at = now()
                WHERE session_id = CAST(:sid AS uuid)"""),
        {"sid": str(session_id), "file_name": final_path.name},
    )
    db.commit()
    return {"status": "completed", "bytes": int(video["total_bytes"])}


@router.get("/sessions/{session_id}/video")
def get_professor_video(
    session_id: UUID,
    account: dict = Depends(require_professor),
    db: Session = Depends(get_db),
):
    professor_id = account.get("professor_id")
    if not professor_id:
        raise HTTPException(403, "Professor account required.")
    session = db.execute(
        text("""SELECT s.status, s.developer_demo, t.professor_id,
                       v.status AS video_status, v.content_type, v.expires_at
                FROM exam_sessions AS s
                JOIN exam_templates AS t ON t.id = s.exam_template_id
                LEFT JOIN exam_session_videos AS v ON v.session_id = s.id
                WHERE s.id = CAST(:sid AS uuid)"""),
        {"sid": str(session_id)},
    ).mappings().first()
    if not session or str(session["professor_id"]) != str(professor_id):
        raise HTTPException(404, "Session not found.")
    if session.get("developer_demo", False):
        raise HTTPException(404, "Session not found.")
    if session["status"] not in ("pending_grading", "flagged", "graded"):
        raise HTTPException(409, "Exam video is available only after submission.")
    if session.get("video_status") == "expired":
        raise HTTPException(410, "The exam video has passed its retention deadline.")
    if (
        session.get("video_status") != "completed"
        or session.get("expires_at") is None
        or session["expires_at"] <= datetime.now(timezone.utc)
    ):
        raise HTTPException(404, "A completed exam video is not available.")

    root = _recording_root(write_required=False)
    video_path = root / f"{session_id}.webm"
    if video_path.is_symlink() or not video_path.is_file():
        raise HTTPException(410, "The exam video file is missing from local storage.")
    return FileResponse(
        video_path,
        media_type=session["content_type"],
        headers={"Cache-Control": "private, no-store"},
    )
