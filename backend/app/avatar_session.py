"""Student presentation from a saved attempt policy, separate from exam rules."""

import json
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import Field, StrictBool, ValidationError, field_validator
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from .avatar_policy import AvatarSettings, StrictModel, default_settings
from .db import get_db
from .student_auth import read_student_token


router = APIRouter(prefix="/exam/sessions", tags=["Student presentation"])

# Frozen revision-zero behavior for attempts that predate presentation snapshots.
# Do not replace this with a lookup of the current professor policy or later defaults.
LEGACY_POLICY_V0_JSON = """{
  "presentation": {
    "avatar": "guide", "background": "neutral", "customAvatar": null,
    "customBackground": null, "voice": "calm", "speed": 1,
    "animation": true, "reducedMotion": false, "stateLabels": true
  },
  "student": {
    "avatar": false, "background": false, "speed": false,
    "avatars": ["guide", "geometric"], "backgrounds": ["neutral", "library"],
    "minSpeed": 0.8, "maxSpeed": 1.2
  },
  "assistance": {
    "repeat": {"enabled": true, "modes": "both", "limit": 2, "timerContinues": true},
    "clarification": {"enabled": true, "modes": "both", "limit": 1, "timerContinues": true},
    "hint": {"enabled": false, "modes": "practice", "limit": 1, "timerContinues": true},
    "explanation": {"enabled": false, "modes": "practice", "limit": 1, "timerContinues": true},
    "correctness": {"enabled": false, "modes": "practice", "limit": 1, "timerContinues": true}
  },
  "behavior": {
    "followUps": 1, "order": "authored", "responseTiming": "exam",
    "responseSeconds": 120, "responseUnit": "seconds"
  }
}"""


class StudentPreferences(StrictModel):
    volume: Annotated[float, Field(strict=True, ge=0, le=100)]
    textSize: Annotated[int, Field(strict=True)]
    reducedMotion: StrictBool
    avatar: Literal["guide", "geometric", "custom"]
    background: Literal["neutral", "library", "custom"]
    speed: Annotated[float, Field(strict=True, ge=0.5, le=2)]

    @field_validator("textSize")
    @classmethod
    def valid_text_size(cls, value):
        if value not in (16, 20, 24):
            raise ValueError("Text size must be 16, 20, or 24 pixels.")
        return value


def _settings(value) -> AvatarSettings:
    if isinstance(value, str):
        value = json.loads(value)
    return AvatarSettings.model_validate(value)


def _revision(value, *, saved_policy=False) -> int:
    minimum = 1 if saved_policy else 0
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        raise ValueError("Invalid avatar policy revision")
    return value


def snapshot_for_exam(db: Session, exam_id) -> tuple[AvatarSettings, int, str]:
    """Called by authorized attempt creation inside its existing transaction."""
    try:
        row = db.execute(text("""SELECT settings, revision, exam_mode FROM exam_avatar_policies
            WHERE exam_template_id = :exam_id"""), {"exam_id": str(exam_id)}).mappings().first()
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(503, "Avatar policy storage is unavailable. Apply the avatar policy migration before starting an attempt.") from error
    if row is None:
        return default_settings(), 0, "assessed"
    try:
        mode = row["exam_mode"]
        if mode not in ("practice", "assessed"):
            raise ValueError("Invalid saved exam mode")
        return _settings(row["settings"]), _revision(row["revision"], saved_policy=True), mode
    except (ValueError, TypeError, ValidationError) as error:
        raise HTTPException(503, "The saved avatar policy is invalid. Ask the professor to correct it before starting an attempt.") from error


def session_policy(row) -> AvatarSettings:
    """Read an immutable attempt snapshot, with frozen v0 only for legacy NULL rows."""
    try:
        revision = _revision(row["avatar_policy_revision"])
        if row["avatar_policy_snapshot"] is None:
            if revision != 0:
                raise ValueError("A saved revision requires a policy snapshot")
            return AvatarSettings.model_validate_json(LEGACY_POLICY_V0_JSON)
        return _settings(row["avatar_policy_snapshot"])
    except (ValueError, TypeError, ValidationError) as error:
        raise HTTPException(503, "The saved session avatar policy is invalid. Ask the professor for assistance.") from error


def student_policy(settings: AvatarSettings) -> dict:
    """Expose only usable presentation assets and choices; omit examiner rules."""
    presentation, controls = settings.presentation, settings.student
    avatars = controls.avatars if controls.avatar else [presentation.avatar]
    backgrounds = controls.backgrounds if controls.background else [presentation.background]
    avatar_labels = {"guide": "Examiner", "geometric": "Geometric avatar", "custom": "Instructor-uploaded avatar"}
    background_labels = {"neutral": "Neutral background", "library": "Library background", "custom": "Instructor-uploaded background"}
    return {
        "defaults": {
            "avatar": presentation.avatar, "background": presentation.background,
            "customAvatar": presentation.customAvatar if "custom" in avatars else None,
            "customBackground": presentation.customBackground if "custom" in backgrounds else None,
            "voiceLabel": "Clear voice" if presentation.voice == "clear" else "Calm voice",
            "speed": presentation.speed, "reducedMotion": presentation.reducedMotion,
            "animation": presentation.animation,
        },
        "allowAvatar": controls.avatar, "allowBackground": controls.background, "allowSpeed": controls.speed,
        "avatarChoices": [{"id": name, "label": avatar_labels[name]} for name in avatars],
        "backgroundChoices": [{"id": name, "label": background_labels[name]} for name in backgrounds],
        "minSpeed": controls.minSpeed if controls.speed else presentation.speed,
        "maxSpeed": controls.maxSpeed if controls.speed else presentation.speed,
    }


def default_preferences(settings: AvatarSettings) -> StudentPreferences:
    presentation = settings.presentation
    return StudentPreferences(volume=70, textSize=16, reducedMotion=presentation.reducedMotion,
                              avatar=presentation.avatar, background=presentation.background,
                              speed=presentation.speed)


def _validate_preferences(preferences: StudentPreferences, settings: AvatarSettings) -> None:
    presentation, controls = settings.presentation, settings.student
    for name, choices in (("avatar", controls.avatars), ("background", controls.backgrounds)):
        value = getattr(preferences, name)
        allowed = choices if getattr(controls, name) else [getattr(presentation, name)]
        if value not in allowed:
            raise HTTPException(422, f"The saved attempt policy does not permit this {name}.")
    if controls.speed:
        if not controls.minSpeed <= preferences.speed <= controls.maxSpeed:
            raise HTTPException(422, "Speaking speed is outside the saved attempt's permitted range.")
    elif preferences.speed != presentation.speed:
        raise HTTPException(422, "Speaking speed is set by the professor for this attempt.")
    if presentation.reducedMotion and not preferences.reducedMotion:
        raise HTTPException(422, "Reduced motion must remain enabled for this attempt.")


def _session(db, session_id: str, claims: dict):
    if claims.get("session_id") != session_id:
        raise HTTPException(403, "Student token does not match this session.")
    try:
        row = db.execute(text("""SELECT student_id, exam_template_id, status,
            avatar_policy_snapshot, avatar_policy_revision, avatar_preferences
            FROM exam_sessions WHERE id = :session_id"""), {"session_id": session_id}).mappings().first()
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(503, "Session presentation storage is unavailable. Apply migration 011_session_avatar_presentation.sql.") from error
    if row is None:
        raise HTTPException(404, "Session not found.")
    if claims.get("sub") != str(row["student_id"]) or claims.get("exam_template_id") != str(row["exam_template_id"]):
        raise HTTPException(403, "Student token does not match this exam session.")
    try:
        revision = _revision(row["avatar_policy_revision"])
        settings = session_policy(row)
        raw = row["avatar_preferences"]
        if isinstance(raw, str):
            raw = json.loads(raw)
        preferences = default_preferences(settings) if raw == {} else StudentPreferences.model_validate(raw)
        _validate_preferences(preferences, settings)
    except (ValueError, TypeError, ValidationError, HTTPException) as error:
        raise HTTPException(503, "The saved session presentation is invalid. Ask the professor for assistance.") from error
    return row, settings, revision, preferences


def _response(session_id, settings, revision, preferences):
    return {
        "session_id": session_id, "revision": revision, "policy": student_policy(settings),
        "voice_profile": settings.presentation.voice, "preferences": preferences.model_dump(),
    }


@router.get("/{session_id}/presentation")
def get_presentation(session_id: UUID, authorization: str | None = Header(default=None), db: Session = Depends(get_db)):
    claims = read_student_token(authorization, expected_purpose="student_session")
    _, settings, revision, preferences = _session(db, str(session_id), claims)
    return _response(str(session_id), settings, revision, preferences)


@router.put("/{session_id}/presentation")
def save_presentation(session_id: UUID, body: StudentPreferences,
                       authorization: str | None = Header(default=None), db: Session = Depends(get_db)):
    claims = read_student_token(authorization, expected_purpose="student_session")
    row, settings, revision, _ = _session(db, str(session_id), claims)
    if row["status"] != "in_progress":
        raise HTTPException(409, "Presentation preferences cannot be changed after the attempt ends.")
    _validate_preferences(body, settings)
    encoded = "CAST(:preferences AS jsonb)" if db.get_bind().dialect.name == "postgresql" else ":preferences"
    try:
        result = db.execute(text(f"""UPDATE exam_sessions SET avatar_preferences = {encoded}
            WHERE id = :session_id AND student_id = :student_id AND exam_template_id = :exam_id
              AND status = 'in_progress'"""), {
            "preferences": body.model_dump_json(), "session_id": str(session_id),
            "student_id": str(row["student_id"]), "exam_id": str(row["exam_template_id"]),
        })
        if result.rowcount != 1:
            db.rollback()
            raise HTTPException(409, "The attempt changed. Reload its presentation before saving.")
        db.commit()
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(503, "Unable to save presentation preferences. No changes were saved.") from error
    return _response(str(session_id), settings, revision, body)
