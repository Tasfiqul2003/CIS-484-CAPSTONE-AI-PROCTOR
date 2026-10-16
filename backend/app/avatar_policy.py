"""Professor-owned policies for future exam attempts.

Saving a policy does not modify current sessions or configure the model, speech,
or grading services. Student attempt enforcement belongs to the attempt API.
"""

import base64
import binascii
import json
import re
from datetime import datetime, timezone
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from .auth import require_professor
from .db import get_db

router = APIRouter(prefix="/exam/templates", tags=["Avatar policy"])

MAX_IMAGE_BYTES = 1_048_576
Speed = Annotated[float, Field(strict=True, ge=0.5, le=2)]
StrictLimit = Annotated[int, Field(strict=True, ge=0, le=10)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


def valid_image(value: str | None) -> bool:
    if value is None:
        return True
    if len(value) > ((MAX_IMAGE_BYTES + 2) // 3) * 4 + 32:
        return False
    match = re.fullmatch(r"data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})", value)
    if not match or len(match[2]) % 4:
        return False
    try:
        decoded = base64.b64decode(match[2], validate=True)
    except (ValueError, binascii.Error):
        return False
    if not 0 < len(decoded) <= MAX_IMAGE_BYTES:
        return False
    if match[1] == "png":
        return decoded.startswith(b"\x89PNG\r\n\x1a\n")
    if match[1] == "jpeg":
        return decoded.startswith(b"\xff\xd8\xff")
    return decoded.startswith(b"RIFF") and decoded[8:12] == b"WEBP"


class Presentation(StrictModel):
    avatar: Literal["guide", "geometric", "custom"]
    background: Literal["neutral", "library", "custom"]
    customAvatar: str | None
    customBackground: str | None
    voice: Literal["calm", "clear"]
    speed: Speed
    animation: StrictBool
    reducedMotion: StrictBool
    stateLabels: StrictBool

    @model_validator(mode="after")
    def validate_images_and_labels(self):
        for name in ("customAvatar", "customBackground"):
            if not valid_image(getattr(self, name)):
                raise ValueError(f"{name} must be a PNG, JPEG, or WebP raster data URL of at most 1 MiB.")
        if self.avatar == "custom" and self.customAvatar is None:
            raise ValueError("A custom avatar requires an image.")
        if self.background == "custom" and self.customBackground is None:
            raise ValueError("A custom background requires an image.")
        if not self.stateLabels:
            raise ValueError("Visible avatar state labels must remain available.")
        return self


class StudentControls(StrictModel):
    avatar: StrictBool
    background: StrictBool
    speed: StrictBool
    avatars: list[Literal["guide", "geometric", "custom"]]
    backgrounds: list[Literal["neutral", "library", "custom"]]
    minSpeed: Speed
    maxSpeed: Speed

    @model_validator(mode="after")
    def validate_choices(self):
        for name in ("avatars", "backgrounds"):
            values = getattr(self, name)
            if len(values) != len(set(values)):
                raise ValueError(f"{name} must contain unique choices.")
        if self.minSpeed > self.maxSpeed:
            raise ValueError("Minimum speaking speed must not exceed maximum speaking speed.")
        return self


class AssistancePolicy(StrictModel):
    enabled: StrictBool
    modes: Literal["practice", "assessed", "both"]
    limit: StrictLimit
    timerContinues: StrictBool

    @model_validator(mode="after")
    def validate_limit(self):
        if self.enabled and self.limit == 0:
            raise ValueError("An enabled assistance action must allow at least one use.")
        return self


class Assistance(StrictModel):
    repeat: AssistancePolicy
    clarification: AssistancePolicy
    hint: AssistancePolicy
    explanation: AssistancePolicy
    correctness: AssistancePolicy


class Behavior(StrictModel):
    followUps: Annotated[int, Field(strict=True, ge=0, le=5)]
    order: Literal["authored", "random"]
    responseTiming: Literal["exam", "fixed"]
    responseSeconds: Annotated[int, Field(strict=True, ge=10, le=600)]
    responseUnit: Literal["seconds", "minutes"]


class AvatarSettings(StrictModel):
    presentation: Presentation
    student: StudentControls
    assistance: Assistance
    behavior: Behavior

    @model_validator(mode="after")
    def validate_student_defaults(self):
        for control, plural, image in (
            ("avatar", "avatars", "customAvatar"),
            ("background", "backgrounds", "customBackground"),
        ):
            choices = getattr(self.student, plural)
            if "custom" in choices and getattr(self.presentation, image) is None:
                raise ValueError(f"A custom student {control} choice requires an image.")
            if getattr(self.student, control):
                if not choices or getattr(self.presentation, control) not in choices:
                    raise ValueError(f"Allowed student {control} choices must include the professor default.")
        if self.student.speed and not self.student.minSpeed <= self.presentation.speed <= self.student.maxSpeed:
            raise ValueError("Default speaking speed must be within the permitted student range.")
        return self


class SaveAvatarPolicy(StrictModel):
    settings: AvatarSettings
    expected_revision: Annotated[int, Field(strict=True, ge=0)]


class AvatarPolicyResponse(StrictModel):
    exam_id: str
    revision: Annotated[int, Field(strict=True, ge=0)]
    settings: AvatarSettings
    effective_for: Literal["new_attempts"] = "new_attempts"
    assistance_scope: Literal["per_question"] = "per_question"
    updated_at: str | None


def default_settings() -> AvatarSettings:
    """Match the frontend defaults; return an independent policy each time."""
    def assistance(enabled: bool, modes: str, limit: int) -> dict:
        return {"enabled": enabled, "modes": modes, "limit": limit, "timerContinues": True}

    return AvatarSettings.model_validate({
        "presentation": {
            "avatar": "guide", "background": "neutral", "customAvatar": None,
            "customBackground": None, "voice": "calm", "speed": 1,
            "animation": True, "reducedMotion": False, "stateLabels": True,
        },
        "student": {
            "avatar": False, "background": False, "speed": False,
            "avatars": ["guide", "geometric"], "backgrounds": ["neutral", "library"],
            "minSpeed": 0.8, "maxSpeed": 1.2,
        },
        "assistance": {
            "repeat": assistance(True, "both", 2),
            "clarification": assistance(True, "both", 1),
            "hint": assistance(False, "practice", 1),
            "explanation": assistance(False, "practice", 1),
            "correctness": assistance(False, "practice", 1),
        },
        "behavior": {
            "followUps": 1, "order": "authored", "responseTiming": "exam",
            "responseSeconds": 120, "responseUnit": "seconds",
        },
    })


def _ensure_owner(db: Session, exam_id: UUID, account: dict) -> None:
    if not account.get("professor_id"):
        raise HTTPException(403, "This account is not linked to a professor.")
    owned = db.execute(
        text("SELECT 1 FROM exam_templates WHERE id = :exam_id AND professor_id = :professor_id"),
        {"exam_id": str(exam_id), "professor_id": str(account["professor_id"])},
    ).first()
    if not owned:
        raise HTTPException(404, "Exam template not found.")


def _database_error(db: Session, error: SQLAlchemyError) -> None:
    db.rollback()
    original = getattr(error, "orig", None)
    code = getattr(original, "pgcode", None) or getattr(original, "sqlstate", None)
    missing = code == "42P01" or (
        "no such table: exam_avatar_policies" in str(original).lower()
    )
    if missing:
        raise HTTPException(
            503,
            "Avatar policy storage is unavailable. Apply database/migrations/006_exam_avatar_policy.sql before saving or loading policies.",
        ) from error
    raise error


def _response(exam_id: UUID, row=None) -> AvatarPolicyResponse:
    settings = default_settings()
    updated_at = None
    if row:
        stored = row["settings"]
        settings = AvatarSettings.model_validate(json.loads(stored) if isinstance(stored, str) else stored)
        stamp = row["updated_at"]
        updated_at = stamp.isoformat() if isinstance(stamp, datetime) else str(stamp)
    return AvatarPolicyResponse(
        exam_id=str(exam_id), revision=row["revision"] if row else 0,
        settings=settings, updated_at=updated_at,
    )


@router.get("/{exam_id}/avatar-policy", response_model=AvatarPolicyResponse)
def get_avatar_policy(
    exam_id: UUID,
    account: dict = Depends(require_professor),
    db: Session = Depends(get_db),
):
    _ensure_owner(db, exam_id, account)
    try:
        row = db.execute(
            text("SELECT settings, revision, updated_at FROM exam_avatar_policies WHERE exam_template_id = :exam_id"),
            {"exam_id": str(exam_id)},
        ).mappings().first()
    except SQLAlchemyError as error:
        _database_error(db, error)
    return _response(exam_id, row)


@router.put("/{exam_id}/avatar-policy", response_model=AvatarPolicyResponse)
def save_avatar_policy(
    exam_id: UUID,
    body: SaveAvatarPolicy,
    account: dict = Depends(require_professor),
    db: Session = Depends(get_db),
):
    _ensure_owner(db, exam_id, account)
    # Compare-and-swap keeps a stale tab from silently replacing a newer policy.
    # JSON casting is PostgreSQL-specific; the same statements run against the
    # isolated SQLite database in tests without the cast.
    encoded = "CAST(:settings AS jsonb)" if db.get_bind().dialect.name == "postgresql" else ":settings"
    values = {
        "exam_id": str(exam_id), "professor_id": str(account["professor_id"]),
        "settings": json.dumps(body.settings.model_dump(), allow_nan=False),
        "revision": body.expected_revision, "updated_at": datetime.now(timezone.utc),
    }
    try:
        if body.expected_revision == 0:
            statement = f"""
                INSERT INTO exam_avatar_policies (exam_template_id, settings, revision, updated_at)
                SELECT id, {encoded}, 1, :updated_at FROM exam_templates
                WHERE id = :exam_id AND professor_id = :professor_id
                ON CONFLICT (exam_template_id) DO NOTHING
                RETURNING settings, revision, updated_at
            """
        else:
            statement = f"""
                UPDATE exam_avatar_policies SET settings = {encoded},
                    revision = revision + 1, updated_at = :updated_at
                WHERE exam_template_id = :exam_id AND revision = :revision
                    AND EXISTS (SELECT 1 FROM exam_templates
                        WHERE id = :exam_id AND professor_id = :professor_id)
                RETURNING settings, revision, updated_at
            """
        row = db.execute(text(statement), values).mappings().first()
        if row is None:
            db.rollback()
            raise HTTPException(409, "This avatar policy changed in another tab. Reload the saved policy before trying again.")
        result = _response(exam_id, row)
        db.commit()
        return result
    except SQLAlchemyError as error:
        _database_error(db, error)
