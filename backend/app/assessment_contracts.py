"""Shared professor-only rubric and retained-recording assessment boundaries."""

from datetime import datetime, timezone
import json
import math

from fastapi import HTTPException


def session_lock_clause(db):
    get_bind = getattr(db, "get_bind", None)
    return " FOR UPDATE OF s" if get_bind and get_bind().dialect.name == "postgresql" else ""


def rubric_criteria(rubric):
    if isinstance(rubric, str):
        try:
            rubric = json.loads(rubric)
        except ValueError:
            rubric = None
    if isinstance(rubric, dict) and (set(rubric) - {"criteria", "type", "version", "description"}
            or rubric.get("type", "points") != "points"
            or any(key in rubric for key in ("weights", "weight", "levels", "scale"))):
        raise HTTPException(422, "Only an explicitly bounded points rubric is supported; weighting and other rubric types need review.")
    criteria = rubric.get("criteria") if isinstance(rubric, dict) else None
    if not isinstance(criteria, list) or not 1 <= len(criteria) <= 20:
        raise HTTPException(422, "The saved professor rubric needs 1-20 valid criteria before assessment.")
    result, seen = [], set()
    for value in criteria:
        if not isinstance(value, dict):
            raise HTTPException(422, "The saved professor rubric is invalid.")
        name, description = value.get("name"), value.get("description", "")
        maximum = value.get("max_score")
        if (set(value) - {"name", "description", "max_score", "min_score", "type"}
                or value.get("type", "points") != "points"
                or type(value.get("min_score", 0)) not in (int, float)
                or value.get("min_score", 0) != 0):
            raise HTTPException(422, "Criteria require explicit max_score, zero lower bound and no ambiguous weights.")
        if (not isinstance(name, str) or not 1 <= len(name.strip()) <= 120
                or name.strip().casefold() in seen or not isinstance(description, str)
                or len(description) > 2000 or type(maximum) not in (int, float)
                or not math.isfinite(maximum) or not 0 < maximum <= 1000):
            raise HTTPException(422, "The saved professor rubric needs unique names and finite positive score bounds.")
        seen.add(name.strip().casefold())
        result.append({"name": name.strip(), "description": description, "max_score": float(maximum)})
    return result


def require_retained_recording(session):
    expiry = session.get("video_expires_at")
    if isinstance(expiry, str):
        try:
            expiry = datetime.fromisoformat(expiry.replace("Z", "+00:00"))
        except ValueError:
            expiry = None
    if expiry is not None and expiry.tzinfo is None:
        expiry = expiry.replace(tzinfo=timezone.utc)
    if session.get("video_status") != "completed" or expiry is None or expiry <= datetime.now(timezone.utc):
        raise HTTPException(409, "A completed, retained exam video is required before assessment.")


def attempt_rubric(session):
    """Never infer a historical attempt's assessment standard from today's template."""
    if session.get("assessment_rubric_snapshot") is None:
        raise HTTPException(422, "This legacy attempt has no frozen professor rubric. Existing grades remain historical; new assessment is blocked.")
    return rubric_criteria(session["assessment_rubric_snapshot"])


def rubric_state(rubric):
    """Read-only pages remain usable while assessment is blocked."""
    try:
        return rubric_criteria(rubric), None
    except HTTPException as error:
        return [], str(error.detail)
