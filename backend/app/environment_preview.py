"""Authenticated pre-attempt presentation. Reading never creates or starts an attempt."""

import json
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import Field, ValidationError
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from .avatar_policy import StrictModel
from .avatar_session import (StudentPreferences, _validate_preferences, default_preferences,
                             snapshot_for_exam, student_policy)
from .db import get_db
from .student_auth import read_student_token

router = APIRouter(prefix="/exam/templates", tags=["Student environment preview"])


class SaveEnvironmentPreferences(StrictModel):
    expected_revision: Annotated[int, Field(strict=True, ge=0)]
    preferences: StudentPreferences


def authorized_settings(db, exam_id, authorization):
    claims = read_student_token(authorization, expected_purpose="student_exam")
    if claims["exam_template_id"] != exam_id:
        raise HTTPException(403, "Student token does not match this exam.")
    row = db.execute(text("""SELECT s.id FROM students s
        JOIN exam_roster r ON r.student_id = s.id
        JOIN exam_templates t ON t.id = r.exam_template_id
        WHERE s.id = :student AND t.id = :exam AND t.status = 'published'"""),
        {"student": claims["sub"], "exam": exam_id}).first()
    if row is None:
        raise HTTPException(403, "This student is not authorized for this published exam.")
    # Reuse the existing identity gate; preview does not acquire a camera or refresh it.
    from .exam import _require_recent_face_check
    _require_recent_face_check(db, claims["sub"])
    settings, revision, _ = snapshot_for_exam(db, exam_id)
    return claims["sub"], settings, revision


def response(exam_id, settings, revision, preferences, notice=None):
    return {"exam_id": exam_id, "revision": revision, "policy": student_policy(settings),
            "voice_profile": settings.presentation.voice, "preferences": preferences.model_dump(),
            "notice": notice}


@router.get("/{exam_id}/student-presentation")
def get_environment_preview(exam_id: UUID, authorization: str | None = Header(default=None),
                            db: Session = Depends(get_db)):
    try:
        student_id, settings, revision = authorized_settings(db, str(exam_id), authorization)
        row = db.execute(text("""SELECT preferences FROM student_environment_preferences
            WHERE exam_template_id = :exam AND student_id = :student"""),
            {"exam": str(exam_id), "student": student_id}).mappings().first()
        preferences, notice = default_preferences(settings), None
        if row:
            try:
                raw = row["preferences"]
                preferences = StudentPreferences.model_validate(json.loads(raw) if isinstance(raw, str) else raw)
                _validate_preferences(preferences, settings)
            except (ValidationError, ValueError, TypeError, HTTPException):
                preferences = default_preferences(settings)
                notice = "Your saved preferences are no longer allowed. Showing the current professor defaults."
        return response(str(exam_id), settings, revision, preferences, notice)
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(503, "Pre-exam presentation storage is unavailable. Contact your administrator.") from error


@router.put("/{exam_id}/student-presentation")
def save_environment_preferences(exam_id: UUID, body: SaveEnvironmentPreferences,
                                 authorization: str | None = Header(default=None),
                                 db: Session = Depends(get_db)):
    try:
        student_id, settings, revision = authorized_settings(db, str(exam_id), authorization)
        if body.expected_revision != revision:
            raise HTTPException(409, "The professor changed presentation policy. Reload the preview before saving.")
        _validate_preferences(body.preferences, settings)
        encoded = "CAST(:preferences AS jsonb)" if db.get_bind().dialect.name == "postgresql" else ":preferences"
        db.execute(text(f"""INSERT INTO student_environment_preferences
            (exam_template_id, student_id, policy_revision, preferences)
            VALUES (:exam, :student, :revision, {encoded})
            ON CONFLICT (exam_template_id, student_id) DO UPDATE
            SET policy_revision = excluded.policy_revision, preferences = excluded.preferences"""),
            {"exam": str(exam_id), "student": student_id, "revision": revision,
             "preferences": body.preferences.model_dump_json()})
        db.commit()
        return response(str(exam_id), settings, revision, body.preferences)
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(503, "Unable to save pre-exam preferences. No changes were saved.") from error
