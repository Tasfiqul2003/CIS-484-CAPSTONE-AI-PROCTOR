from datetime import datetime, timedelta, timezone

import jwt
from fastapi import HTTPException

from .auth import get_secret


def issue_student_token(
    *,
    student_id: str,
    exam_template_id: str,
    purpose: str,
    session_id: str | None = None,
    minutes: int = 60,
) -> str:
    payload = {
        "sub": student_id,
        "exam_template_id": exam_template_id,
        "purpose": purpose,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=minutes),
    }

    if session_id:
        payload["session_id"] = session_id

    return jwt.encode(payload, get_secret(), algorithm="HS256")


def read_student_token(
    authorization: str | None,
    *,
    expected_purpose: str,
) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Student authorization required.")

    token = authorization.removeprefix("Bearer ").strip()

    try:
        claims = jwt.decode(
            token,
            get_secret(),
            algorithms=["HS256"],
            options={"require": ["sub", "exp", "purpose", "exam_template_id"]},
        )
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid or expired student token.")

    if claims.get("purpose") != expected_purpose:
        raise HTTPException(status_code=403, detail="Token is not valid for this operation.")

    return claims
