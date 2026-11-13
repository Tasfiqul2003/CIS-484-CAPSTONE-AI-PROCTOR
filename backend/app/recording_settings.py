
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from .auth import require_professor
from .db import get_db
from .student_auth import read_student_token

router = APIRouter(tags=["exam recording"])


class RecordingSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    record_examination: bool = Field(strict=True)
    generate_transcript: bool = Field(strict=True)


class RecordingConsentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    consent: bool = Field(strict=True)


def owned_exam(db: Session, exam_id: UUID, account: dict):
    professor_id = account.get("professor_id")
    if not professor_id:
        raise HTTPException(
            status_code=403,
            detail="This account is not linked to a professor.",
        )

    row = db.execute(
        text("""
            SELECT id, record_examination, generate_transcript
            FROM exam_templates
            WHERE id = CAST(:exam_id AS uuid)
              AND professor_id = CAST(:professor_id AS uuid)
        """),
        {
            "exam_id": str(exam_id),
            "professor_id": str(professor_id),
        },
    ).mappings().first()

    if row is None:
        raise HTTPException(404, "Exam template not found.")

    return row


@router.get("/exam/templates/{exam_id}/recording-settings")
def get_recording_settings(
    exam_id: UUID,
    account: dict = Depends(require_professor),
    db: Session = Depends(get_db),
):
    row = owned_exam(db, exam_id, account)
    return {
        "record_examination": bool(row["record_examination"]),
        "generate_transcript": bool(row["generate_transcript"]),
    }


@router.put("/exam/templates/{exam_id}/recording-settings")
def update_recording_settings(
    exam_id: UUID,
    settings: RecordingSettings,
    account: dict = Depends(require_professor),
    db: Session = Depends(get_db),
):
    owned_exam(db, exam_id, account)

    row = db.execute(
        text("""
            UPDATE exam_templates
            SET record_examination = :record_examination,
                generate_transcript = :generate_transcript
            WHERE id = CAST(:exam_id AS uuid)
              AND professor_id = CAST(:professor_id AS uuid)
            RETURNING record_examination, generate_transcript
        """),
        {
            "exam_id": str(exam_id),
            "professor_id": str(account["professor_id"]),
            "record_examination": settings.record_examination,
            "generate_transcript": settings.generate_transcript,
        },
    ).mappings().first()

    if row is None:
        db.rollback()
        raise HTTPException(404, "Exam template not found.")

    db.commit()
    return {
        "record_examination": bool(row["record_examination"]),
        "generate_transcript": bool(row["generate_transcript"]),
    }


@router.post("/exam/sessions/{session_id}/recording-consent")
def submit_recording_consent(
    session_id: UUID,
    request: RecordingConsentRequest,
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
):
    claims = read_student_token(
        authorization,
        expected_purpose="student_session",
    )

    if claims.get("session_id") != str(session_id):
        raise HTTPException(403, "Student token does not match this session.")

    session = db.execute(
        text("""
            SELECT id, student_id, exam_template_id, status,
                   record_examination, recording_consent_status,
                   recording_consent_decided_at, developer_demo
            FROM exam_sessions
            WHERE id = CAST(:session_id AS uuid)
            FOR UPDATE
        """),
        {"session_id": str(session_id)},
    ).mappings().first()

    if session is None:
        raise HTTPException(404, "Exam session not found.")

    if (
        claims.get("sub") != str(session["student_id"])
        or claims.get("exam_template_id") != str(session["exam_template_id"])
    ):
        raise HTTPException(403, "Student token does not match this exam session.")

    if session["developer_demo"] or not session["record_examination"]:
        return {
            "recording_consent_status": "not_required",
            "recording_enabled": False,
        }

    current_status = session["recording_consent_status"]

    if current_status in ("consented", "declined"):
        if (current_status == "consented") != request.consent:
            raise HTTPException(
                409,
                "A recording consent decision has already been submitted.",
            )

        return {
            "recording_consent_status": current_status,
            "recording_enabled": current_status == "consented",
            "decided_at": (
                session["recording_consent_decided_at"].isoformat()
                if session["recording_consent_decided_at"] else None
            ),
        }

    if current_status != "pending":
        raise HTTPException(409, "Recording consent is not pending.")

    if session["status"] != "in_progress":
        raise HTTPException(409, "This exam session is no longer in progress.")

    new_status = "consented" if request.consent else "declined"

    updated = db.execute(
        text("""
            UPDATE exam_sessions
            SET recording_consent_status = :status,
                recording_consent_decided_at = clock_timestamp(),
                started_at = clock_timestamp()
            WHERE id = CAST(:session_id AS uuid)
              AND student_id = CAST(:student_id AS uuid)
              AND recording_consent_status = 'pending'
              AND status = 'in_progress'
            RETURNING recording_consent_status,
                      recording_consent_decided_at,
                      started_at
        """),
        {
            "session_id": str(session_id),
            "student_id": str(session["student_id"]),
            "status": new_status,
        },
    ).mappings().first()

    if updated is None:
        db.rollback()
        raise HTTPException(
            409,
            "The recording consent decision could not be saved. Reload the exam.",
        )

    # Start the first-question timer at the same moment as the exam timer.
    db.execute(
        text("""
            UPDATE interactions
            SET created_at = :started_at
            WHERE session_id = CAST(:session_id AS uuid)
              AND sequence_num = 1
        """),
        {
            "session_id": str(session_id),
            "started_at": updated["started_at"],
        },
    )

    if not request.consent:
        db.execute(
            text("""
                INSERT INTO recording_consent_notifications (
                    professor_id,
                    exam_template_id,
                    exam_session_id,
                    student_id,
                    event_type
                )
                SELECT t.professor_id, s.exam_template_id, s.id,
                       s.student_id, 'recording_declined'
                FROM exam_sessions s
                JOIN exam_templates t ON t.id = s.exam_template_id
                WHERE s.id = CAST(:session_id AS uuid)
                ON CONFLICT (exam_session_id, event_type) DO NOTHING
            """),
            {"session_id": str(session_id)},
        )

    db.commit()

    return {
        "recording_consent_status": new_status,
        "recording_enabled": request.consent,
        "decided_at": updated["recording_consent_decided_at"].isoformat(),
    }


@router.get("/auth/professor/recording-notifications")
def get_recording_notifications(
    account: dict = Depends(require_professor),
    db: Session = Depends(get_db),
):
    professor_id = account.get("professor_id")
    if not professor_id:
        raise HTTPException(
            status_code=403,
            detail="This account is not linked to a professor.",
        )

    rows = db.execute(
        text("""
            SELECT n.id, n.event_type, n.created_at,
                   t.id AS exam_id, t.title AS exam_title, t.course,
                   s.name AS student_name, s.eid AS student_eid
            FROM recording_consent_notifications n
            JOIN exam_templates t ON t.id = n.exam_template_id
            JOIN students s ON s.id = n.student_id
            WHERE n.professor_id = CAST(:professor_id AS uuid)
            ORDER BY n.created_at DESC
        """),
        {"professor_id": str(professor_id)},
    ).mappings().all()

    return [
        {
            "id": str(row["id"]),
            "event_type": row["event_type"],
            "exam_id": str(row["exam_id"]),
            "exam_title": row["exam_title"],
            "course": row["course"],
            "student_name": row["student_name"] or "Unknown student",
            "student_eid": row["student_eid"] or "Not available",
            "created_at": row["created_at"].isoformat(),
        }
        for row in rows
    ]
