"""Professor-owned base exam and question limits; per-EID ODS is separate."""
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from .auth import require_professor
from .db import get_db

router = APIRouter(prefix="/exam/templates", tags=["exam"])


class TimeSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    time_limit_minutes: int = Field(strict=True, ge=1, le=240)
    question_time_limit_minutes: int | None = Field(default=None, strict=True, ge=1, le=240)


def owned_time(db, exam_id, account):
    if not account.get("professor_id"):
        raise HTTPException(403, "This account is not linked to a professor.")
    row = db.execute(text("""SELECT time_limit_minutes, question_time_limit_minutes FROM exam_templates
        WHERE id = :exam_id AND professor_id = :professor_id"""),
        {"exam_id": str(exam_id), "professor_id": str(account["professor_id"])}).mappings().first()
    if row is None:
        raise HTTPException(404, "Exam template not found.")
    return dict(row)


@router.get("/{exam_id}/time-settings")
def get_time_settings(exam_id: UUID, account: dict = Depends(require_professor), db: Session = Depends(get_db)):
    return owned_time(db, exam_id, account)


@router.put("/{exam_id}/time-settings")
def save_time_settings(exam_id: UUID, body: TimeSettings,
                       account: dict = Depends(require_professor), db: Session = Depends(get_db)):
    current = owned_time(db, exam_id, account)
    # Older clients save only the total limit and must not disable a saved question limit.
    question_minutes = (body.question_time_limit_minutes
                        if "question_time_limit_minutes" in body.model_fields_set
                        else current["question_time_limit_minutes"])
    row = db.execute(text("""UPDATE exam_templates SET time_limit_minutes = :minutes,
        question_time_limit_minutes = :question_minutes
        WHERE id = :exam_id AND professor_id = :professor_id
        RETURNING time_limit_minutes, question_time_limit_minutes"""),
        {"minutes": body.time_limit_minutes, "exam_id": str(exam_id),
         "question_minutes": question_minutes,
         "professor_id": str(account["professor_id"])}).mappings().first()
    if row is None:
        raise HTTPException(404, "Exam template not found.")
    db.commit()
    return dict(row)
