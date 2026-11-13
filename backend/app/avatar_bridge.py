"""Bridge between the student exam page and the separate avatar service (avatar/avatar_app.py).

The browser only ever talks to this backend. For a signed-in student in an active attempt it
  - turns question text into talking-avatar clips (POST /avatar/sessions/{id}/speak, NDJSON stream),
  - serves those clips (GET /avatar/media/{name}), and
  - transcribes a recorded answer (POST /avatar/sessions/{id}/transcribe).
The avatar service is optional: without AVATAR_SERVICE_URL every route reports it as unavailable and
the exam keeps working with typed answers.
"""

import json
import os
import re
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import text
from sqlalchemy.orm import Session

from .db import get_db
from .student_auth import read_student_token

router = APIRouter(prefix="/avatar", tags=["Avatar service bridge"])

SERVICE_URL = os.getenv("AVATAR_SERVICE_URL", "").rstrip("/")
SERVICE_TOKEN = os.getenv("AVATAR_SERVICE_TOKEN", "")
MAX_TEXT = 1500
MAX_AUDIO = 10_000_000
MEDIA_NAME = re.compile(r"[A-Za-z0-9_.-]{1,80}\.mp4")


def _enabled() -> bool:
    return bool(SERVICE_URL and SERVICE_TOKEN)


def _headers() -> dict:
    return {"X-Avatar-Token": SERVICE_TOKEN}


def _active_session(db: Session, session_id: str, authorization: str | None) -> None:
    """Same checks as the other student session routes: matching token, student, exam, and an open attempt."""
    claims = read_student_token(authorization, expected_purpose="student_session")
    if claims.get("session_id") != session_id:
        raise HTTPException(403, "Student token does not match this session.")
    row = db.execute(text("SELECT student_id, exam_template_id, status FROM exam_sessions WHERE id = :id"),
                     {"id": session_id}).mappings().first()
    if row is None:
        raise HTTPException(404, "Session not found.")
    if claims.get("sub") != str(row["student_id"]) or claims.get("exam_template_id") != str(row["exam_template_id"]):
        raise HTTPException(403, "Student token does not match this exam session.")
    if row["status"] != "in_progress":
        raise HTTPException(409, "This attempt is no longer in progress.")


@router.get("/status")
def avatar_status():
    """Whether the talking avatar and spoken answers can be used right now. No personal data."""
    if not _enabled():
        return {"enabled": False, "ready": False}
    try:
        r = httpx.get(f"{SERVICE_URL}/service/status", headers=_headers(), timeout=5)
        r.raise_for_status()
        body = r.json()
        return {"enabled": True, "ready": bool(body.get("ready")),
                "speech_input": bool(body.get("models_loaded")), "progress": body.get("progress")}
    except (httpx.HTTPError, ValueError):
        return {"enabled": True, "ready": False, "speech_input": False, "progress": "Avatar service unreachable"}


@router.post("/sessions/{session_id}/speak")
async def speak(session_id: UUID, request: Request, authorization: str | None = Header(default=None),
                db: Session = Depends(get_db)):
    if not _enabled():
        raise HTTPException(503, "The avatar service is not configured.")
    _active_session(db, str(session_id), authorization)
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(400, "Bad request.")
    said = " ".join(str(body.get("text") or "").split())
    if not said or len(said) > MAX_TEXT:
        raise HTTPException(422, f"Text must be 1-{MAX_TEXT} characters.")

    client = httpx.AsyncClient(timeout=httpx.Timeout(10, read=600))
    try:
        upstream = await client.send(
            client.build_request("POST", f"{SERVICE_URL}/service/speak", headers=_headers(), json={"text": said}),
            stream=True)
    except httpx.HTTPError:
        await client.aclose()
        raise HTTPException(503, "The avatar service is unreachable.")
    if upstream.status_code != 200:
        await upstream.aclose(); await client.aclose()
        raise HTTPException(503, "The avatar is not ready yet." if upstream.status_code == 503 else "The avatar service failed.")

    async def relay():
        # Clip URLs point at the avatar service; rewrite them to this backend's media route.
        try:
            async for line in upstream.aiter_lines():
                if not line.strip():
                    continue
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if event.get("type") == "clip":
                    name = str(event.get("url", "")).rsplit("/", 1)[-1]
                    if not MEDIA_NAME.fullmatch(name):
                        continue
                    event = {"type": "clip", "url": f"/api/avatar/media/{name}", "text": event.get("text", ""),
                             "audio_s": event.get("audio_s")}
                elif event.get("type") == "error":
                    event = {"type": "error", "message": "The avatar could not finish this clip."}
                else:
                    continue
                yield json.dumps(event) + "\n"
            yield json.dumps({"type": "done"}) + "\n"
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(relay(), media_type="application/x-ndjson")


@router.get("/media/{name}")
async def media(name: str):
    """Clip files have random or content-hash names and no student data; <video> cannot send a bearer token."""
    if not _enabled() or not MEDIA_NAME.fullmatch(name):
        raise HTTPException(404, "Not found.")
    client = httpx.AsyncClient(timeout=httpx.Timeout(10, read=120))
    try:
        upstream = await client.send(client.build_request("GET", f"{SERVICE_URL}/media/{name}"), stream=True)
    except httpx.HTTPError:
        await client.aclose()
        raise HTTPException(503, "The avatar service is unreachable.")
    if upstream.status_code != 200:
        await upstream.aclose(); await client.aclose()
        raise HTTPException(404, "Not found.")

    async def body():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(body(), media_type="video/mp4", headers={"Cache-Control": "private, max-age=3600"})


@router.post("/sessions/{session_id}/transcribe")
async def transcribe(session_id: UUID, request: Request, authorization: str | None = Header(default=None),
                     db: Session = Depends(get_db)):
    """Recorded answer -> text the student reviews before submitting. Audio is not stored here or by the service."""
    if not _enabled():
        raise HTTPException(503, "Spoken answers are not available on this server.")
    _active_session(db, str(session_id), authorization)
    data = await request.body()
    if not data or len(data) > MAX_AUDIO:
        raise HTTPException(413 if data else 400, "The recording is empty or too large.")
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10, read=120)) as client:
            r = await client.post(f"{SERVICE_URL}/service/transcribe", headers=_headers(), content=data)
    except httpx.HTTPError:
        raise HTTPException(503, "The speech service is unreachable.")
    if r.status_code != 200:
        raise HTTPException(503, "Speech recognition is not available right now.")
    return {"text": str(r.json().get("text", ""))[:5000]}
