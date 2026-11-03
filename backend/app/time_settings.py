"""Professor-owned standard exam time limits; ODS remains a separate preview."""
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


def owned_time(db, exam_id, account):
    if not account.get("professor_id"):
        raise HTTPException(403, "This account is not linked to a professor.")
    row = db.execute(text("""SELECT time_limit_minutes FROM exam_templates
        WHERE id = :exam_id AND professor_id = :professor_id"""),
        {"exam_id": str(exam_id), "professor_id": str(account["professor_id"])}).mappings().first()
    if row is None:
        raise HTTPException(404, "Exam template not found.")
    return {"time_limit_minutes": row["time_limit_minutes"]}


@router.get("/{exam_id}/time-settings")
def get_time_settings(exam_id: UUID, account: dict = Depends(require_professor), db: Session = Depends(get_db)):
    return owned_time(db, exam_id, account)


@router.put("/{exam_id}/time-settings")
def save_time_settings(exam_id: UUID, body: TimeSettings,
                       account: dict = Depends(require_professor), db: Session = Depends(get_db)):
    owned_time(db, exam_id, account)
    row = db.execute(text("""UPDATE exam_templates SET time_limit_minutes = :minutes
        WHERE id = :exam_id AND professor_id = :professor_id RETURNING time_limit_minutes"""),
        {"minutes": body.time_limit_minutes, "exam_id": str(exam_id),
         "professor_id": str(account["professor_id"])}).mappings().first()
    if row is None:
        raise HTTPException(404, "Exam template not found.")
    db.commit()
    return {"time_limit_minutes": row["time_limit_minutes"]}
