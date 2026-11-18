"""Explicit local-only admission for the explicit synthetic developer roster.

A grant is not a photo match. It never writes face-verification history and is
revalidated against the current flag, request origin, and student row each use.
"""

import ipaddress
import os
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit
from uuid import UUID

import jwt
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from .auth import get_secret
from .db import get_db

router = APIRouter(prefix="/exam/student", tags=["Synthetic developer identity"])

ALLOWED_EIDS = ("student.demo",) + tuple(f"student.demo{i}" for i in range(2, 54))
COOKIE_NAME = "cybros_developer_face_bypass"
EXPIRES_IN_SECONDS = 900
PURPOSE = "developer_face_bypass"


class BypassRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    eid: str = Field(min_length=1, max_length=64)


def _loopback(host: str | None, *, allow_localhost: bool = False) -> bool:
    if not host:
        return False
    if allow_localhost and host.casefold() == "localhost":
        return True
    try:
        address = ipaddress.ip_address(host)
        if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
            address = address.ipv4_mapped
        return address.is_loopback
    except ValueError:
        return False


def _local_url(value: str) -> bool:
    try:
        parsed = urlsplit(value)
        # Origins are authorities, not arbitrary URLs. Accessing port validates
        # malformed authorities without trusting forwarded headers or DNS.
        parsed.port
        return (
            parsed.scheme in {"http", "https"}
            and _loopback(parsed.hostname, allow_localhost=True)
            and parsed.username is None
            and parsed.password is None
            and parsed.path in {"", "/"}
            and not parsed.query
            and not parsed.fragment
        )
    except (ValueError, TypeError):
        return False


def _enabled_for(request: Request | None) -> bool:
    if os.getenv("CYBROS_DEVELOPER_FACE_BYPASS") != "1" or request is None:
        return False
    if request.client is None or not _loopback(request.client.host):
        return False
    if not _local_url(str(request.base_url)):
        return False
    origins = request.headers.getlist("origin")
    return not origins or (len(origins) == 1 and _local_url(origins[0]))


def _identity_flags() -> dict:
    return {
        "allowed": True,
        "matched": False,
        "developer_bypass": True,
        "identity_check_completed": False,
        "identity_verified": False,
        "identity_method": "developer_bypass",
        "review_required": True,
        "identity_review_required": True,
    }


def authorized_bypass(db: Session, student_id: str, request: Request | None) -> dict | None:
    """Return an honest unverified grant, or None; never accept a client hint."""
    if not _enabled_for(request):
        return None
    token = request.cookies.get(COOKIE_NAME)
    if not token or len(token) > 4096:
        return None
    try:
        requested_id = str(UUID(str(student_id)))
        claims = jwt.decode(
            token, get_secret(), algorithms=["HS256"],
            options={"require": ["sub", "eid", "purpose", "iat", "exp"]},
        )
        issued, expires = claims["iat"], claims["exp"]
        if (
            claims["purpose"] != PURPOSE
            or claims["eid"] not in ALLOWED_EIDS
            or claims["sub"] != requested_id
            or type(issued) is not int
            or type(expires) is not int
            or not 0 < expires - issued <= EXPIRES_IN_SECONDS
        ):
            return None
        student = db.execute(
            text("SELECT id, eid FROM students WHERE id = :student_id"),
            {"student_id": requested_id},
        ).mappings().first()
        if not student or str(student["id"]) != requested_id:
            return None
        eid = student["eid"]
        if not isinstance(eid, str) or eid.strip().casefold() != claims["eid"]:
            return None
        prior = db.execute(
            text("SELECT attempt_count FROM student_face_verifications WHERE student_id = :student_id"),
            {"student_id": requested_id},
        ).mappings().first()
        attempts = int(prior["attempt_count"]) if prior else 0
        return {
            **_identity_flags(),
            "status": "developer_bypass",
            "attempt_count": max(0, attempts),
            "expires_at": datetime.fromtimestamp(expires, timezone.utc),
        }
    except (jwt.InvalidTokenError, HTTPException, ValueError, TypeError, KeyError, OverflowError):
        return None
    except SQLAlchemyError:
        db.rollback()
        return None


@router.get("/developer-face-bypass")
def developer_face_bypass_capabilities(request: Request, response: Response):
    enabled = _enabled_for(request)
    response.headers["Cache-Control"] = "no-store"
    return {
        "enabled": enabled,
        "allowed_eids": list(ALLOWED_EIDS) if enabled else [],
        "expires_in_seconds": EXPIRES_IN_SECONDS,
    }


@router.post("/developer-face-bypass")
def grant_developer_face_bypass(
    body: BypassRequest, request: Request, response: Response,
    db: Session = Depends(get_db),
):
    response.headers["Cache-Control"] = "no-store"
    if not _enabled_for(request):
        raise HTTPException(403, "Synthetic developer identity bypass is unavailable for this request.")
    eid = body.eid.strip().casefold()
    if eid not in ALLOWED_EIDS:
        raise HTTPException(403, "Use one of the listed synthetic developer EIDs.")
    try:
        rows = db.execute(
            text("SELECT id, name, eid FROM students WHERE lower(trim(eid)) = :eid LIMIT 2"),
            {"eid": eid},
        ).mappings().all()
        if len(rows) != 1:
            raise HTTPException(404, "That synthetic developer student is unavailable.")
        student = rows[0]
        student_id = str(UUID(str(student["id"])))
    except SQLAlchemyError:
        db.rollback()
        raise HTTPException(503, "Synthetic developer identity storage is unavailable.") from None
    except (ValueError, TypeError):
        raise HTTPException(404, "That synthetic developer student is unavailable.") from None

    issued_at = datetime.now(timezone.utc).replace(microsecond=0)
    expires_at = issued_at + timedelta(seconds=EXPIRES_IN_SECONDS)
    token = jwt.encode(
        {"sub": student_id, "eid": eid, "purpose": PURPOSE,
         "iat": int(issued_at.timestamp()), "exp": int(expires_at.timestamp())},
        get_secret(), algorithm="HS256",
    )
    response.set_cookie(
        key=COOKIE_NAME, value=token, max_age=EXPIRES_IN_SECONDS, expires=expires_at,
        httponly=True,
        secure=os.getenv("AUTH_COOKIE_SECURE", "false").lower() == "true",
        samesite="strict", path="/",
    )
    return {
        **_identity_flags(),
        "student": {"id": student_id, "name": student["name"], "eid": student["eid"]},
        "expires_at": expires_at.isoformat(),
    }
