"""Bridge between the student exam page and the separate avatar service (avatar/avatar_app.py).

The browser only ever talks to this backend. For a signed-in student in an active attempt it
  - turns question text into talking-avatar clips (POST /avatar/sessions/{id}/speak, NDJSON stream),
  - serves those clips (GET /avatar/media/{name}), and
  - transcribes a recorded answer (POST /avatar/sessions/{id}/transcribe).
The avatar service is optional: without AVATAR_SERVICE_URL every route reports it as unavailable and
the exam keeps working with typed answers.
"""

import asyncio
import json
import os
import re
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from sqlalchemy import text
from sqlalchemy.orm import Session

from .auth import require_professor
from .avatar_lines import FOLLOW_UP_FALLBACKS, REACTIONS
from .db import get_db
from .student_auth import read_student_token

router = APIRouter(prefix="/avatar", tags=["Avatar service bridge"])

SERVICE_URL = os.getenv("AVATAR_SERVICE_URL", "").rstrip("/")
SERVICE_TOKEN = os.getenv("AVATAR_SERVICE_TOKEN", "")
MAX_TEXT = 1500
MAX_AUDIO = 10_000_000
MEDIA_NAME = re.compile(r"[A-Za-z0-9_.-]{1,80}\.mp4")
PROFILE_ID = re.compile(r"[a-z0-9-]{1,40}")
MAX_UPLOAD = 25_000_000
PREVIEW_TEXT = "Hello. I will be your examiner today. Take your time, and answer in your own words."
# How long a student's first question waits for their professor's avatar to load.
SWITCH_WAIT_S = 240


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


async def _relay_speech(said: str, lead: str = "") -> StreamingResponse:
    """Stream the avatar service's clips for `said`, with clip URLs rewritten to this backend.
    `lead` is a short stock line said first; it is sent as its own segment so its ready-made clip is used."""
    client = httpx.AsyncClient(timeout=httpx.Timeout(10, read=600))
    try:
        upstream = await client.send(
            client.build_request("POST", f"{SERVICE_URL}/service/speak", headers=_headers(),
                                 json={"segments": [lead, said]} if lead else {"text": said}),
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

    # Only the stock reactions are accepted as a lead-in, so it always has a ready-made clip.
    lead = " ".join(str(body.get("lead") or "").split())
    lead = lead if lead in REACTIONS else ""

    target = await _exam_avatar(db, str(session_id))
    if target:
        await _wait_until_loaded(target)
        await _prepare_exam_clips(db, target, session_id=str(session_id))
    return await _relay_speech(said, lead)


@router.get("/sessions/{session_id}/poster")
async def examiner_poster(session_id: UUID, authorization: str | None = Header(default=None),
                          db: Session = Depends(get_db)):
    """The examiner's still photo, shown while the avatar gets ready or waits between questions."""
    if not _enabled():
        raise HTTPException(404, "Not found.")
    _active_session(db, str(session_id), authorization)
    # Asking for the photo at the start of the exam also starts loading the professor's avatar.
    pid = await _exam_avatar(db, str(session_id)) or ""
    if not PROFILE_ID.fullmatch(pid):
        raise HTTPException(404, "No examiner photo yet.")
    await _prepare_exam_clips(db, pid, session_id=str(session_id))
    r = await _service("GET", f"/service/profiles/{pid}/photo")
    if r.status_code != 200:
        raise HTTPException(404, "No examiner photo yet.")
    return Response(r.content, media_type="image/jpeg", headers={"Cache-Control": "private, no-store"})


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


# ---------------- professor side: create and manage the talking avatar ----------------
# The photo and voice sample go straight to the avatar service, which stores them on the exam
# server (never in this database or the repository). Each avatar records the professor who made
# it; a professor sees and changes only their own. Avatars made in the standalone prototype page
# have no owner: they are shown to every professor as "made outside the exam app", can be used
# for exams, and can only be deleted from that page.

async def _service(method: str, path: str, **kwargs) -> httpx.Response:
    if not _enabled():
        raise HTTPException(503, "The avatar service is not configured on this server.")
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10, read=180)) as client:
            return await client.request(method, f"{SERVICE_URL}{path}", headers=_headers(), **kwargs)
    except httpx.HTTPError:
        raise HTTPException(503, "The avatar service is unreachable.")


def _service_error(r: httpx.Response, fallback: str):
    try:
        message = str(r.json().get("error") or "")
    except ValueError:
        message = ""
    raise HTTPException(400 if r.status_code < 500 else 503, message or fallback)


async def _profiles() -> dict:
    r = await _service("GET", "/service/profiles")
    if r.status_code != 200:
        _service_error(r, "The avatar list is unavailable.")
    return r.json()


async def _owned(pid: str, account: dict, allow_unowned: bool = False) -> dict:
    if not PROFILE_ID.fullmatch(pid or ""):
        raise HTTPException(404, "Avatar not found.")
    me = str(account.get("professor_id") or "")
    for profile in (await _profiles()).get("profiles", []):
        if profile.get("id") == pid:
            owner = profile.get("owner")
            if (owner and owner == me) or (allow_unowned and not owner):
                return profile
            break
    raise HTTPException(404, "Avatar not found.")


# One avatar is loaded on the GPU at a time, but each professor picks the avatar their own exams use.
# When a student starts an exam, the backend loads that professor's avatar, unless another
# professor's exam is running right now (switching would change the examiner mid-exam for them).

def _other_exam_running(db: Session, professor_id: str, session_id: str | None = None) -> bool:
    row = db.execute(text("""
        SELECT 1 FROM exam_sessions AS s JOIN exam_templates AS t ON t.id = s.exam_template_id
        WHERE s.status = 'in_progress' AND s.started_at > now() - interval '3 hours'
          AND CAST(t.professor_id AS text) <> :prof AND CAST(s.id AS text) <> :sid
        LIMIT 1
    """), {"prof": professor_id, "sid": session_id or ""}).first()
    return row is not None


async def _exam_avatar(db: Session, session_id: str) -> str | None:
    """The avatar this session's exam should use, loading it first when it is not the one on the GPU."""
    row = db.execute(text("""
        SELECT t.professor_id FROM exam_sessions AS s JOIN exam_templates AS t ON t.id = s.exam_template_id
        WHERE s.id = :id
    """), {"id": session_id}).mappings().first()
    listing = await _profiles()
    active = listing.get("active")
    if row is None:
        return active
    professor = str(row["professor_id"])
    chosen = (listing.get("selections") or {}).get(professor)
    complete = {p.get("id") for p in listing.get("profiles", []) if p.get("complete")}
    if not chosen or chosen not in complete or chosen == active:
        return active
    if _other_exam_running(db, professor, session_id):
        return active
    r = await _service("POST", f"/service/profiles/{chosen}/activate")
    return chosen if r.status_code == 200 else active


_PREPARED: set[str] = set()   # sessions or professors whose question clips were already requested


async def _prepare_exam_clips(db: Session, pid: str, *, session_id: str | None = None,
                              professor_id: str | None = None) -> None:
    """Ask the avatar service to make the clips for an exam's bank questions ahead of time, so the
    examiner starts speaking right away. The service does it in the background, between live requests.
    Called once per exam session, and when a professor chooses or loads their avatar."""
    key = session_id or f"prof:{professor_id}:{pid}"
    if key in _PREPARED:
        return
    if len(_PREPARED) > 5000:
        _PREPARED.clear()
    _PREPARED.add(key)
    try:
        if session_id:
            rows = db.execute(text("""
                SELECT q.question_text FROM questions AS q
                JOIN exam_sessions AS s ON s.exam_template_id = q.exam_template_id
                WHERE s.id = :id ORDER BY q.created_at LIMIT 150
            """), {"id": session_id}).all()
        else:
            rows = db.execute(text("""
                SELECT q.question_text FROM questions AS q
                JOIN exam_templates AS t ON t.id = q.exam_template_id
                WHERE CAST(t.professor_id AS text) = :prof AND t.status = 'published'
                ORDER BY q.created_at LIMIT 150
            """), {"prof": professor_id or ""}).all()
        lines = REACTIONS + FOLLOW_UP_FALLBACKS + [str(row[0]) for row in rows if row[0]]
        await _service("POST", "/service/prerender", json={"profile": pid, "lines": lines})
    except Exception:
        _PREPARED.discard(key)  # Clips made ahead are an optimisation; the exam works without them.


async def _wait_until_loaded(pid: str) -> None:
    """Wait (the student sees "The examiner is getting ready") until `pid` is loaded and ready."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + SWITCH_WAIT_S
    while True:
        status = (await _service("GET", "/service/status")).json()
        if status.get("ready") and (status.get("profile") or {}).get("id") == pid:
            return
        if status.get("build_error") or loop.time() > deadline:
            raise HTTPException(503, "The avatar is not ready yet.")
        await asyncio.sleep(1)


@router.get("/professor/avatars")
async def professor_avatars(account: dict = Depends(require_professor), db: Session = Depends(get_db)):
    if not _enabled():
        return {"enabled": False}
    me = str(account.get("professor_id") or "")
    listing = await _profiles()
    status = (await _service("GET", "/service/status")).json()
    chosen = (listing.get("selections") or {}).get(me)
    visible = []
    for profile in listing.get("profiles", []):
        owner = profile.get("owner")
        if owner and owner != me:
            continue  # other professors' avatars stay private
        visible.append({"id": profile["id"], "name": profile.get("name"), "created": profile.get("created"),
                        "complete": bool(profile.get("complete")), "active": bool(profile.get("active")),
                        "selected": profile["id"] == chosen,
                        "mine": bool(owner), "consent_recorded": bool(profile.get("consent_recorded"))})
    active = (status.get("profile") or {})
    active_visible = next((p for p in visible if p["id"] == active.get("id")), None)
    return {
        "enabled": True,
        # The avatar this professor's exams use, and whether it can be loaded right now for a preview.
        # Before a professor picks one, their exams use whichever avatar is loaded.
        "selected": next((p for p in visible if p["selected"]), None) or active_visible,
        "other_exam_running": _other_exam_running(db, me),
        "ready": bool(status.get("ready")),
        "models_loaded": bool(status.get("models_loaded")),
        "progress": status.get("progress"),
        "build_error": status.get("build_error"),
        "consent_text": listing.get("consent_text"),
        # Another professor's active avatar is reported without its name.
        "active": active_visible or ({"id": None, "name": None, "mine": False, "other": True} if active.get("id") else None),
        "avatars": visible,
    }


@router.post("/professor/avatars")
async def professor_create_avatar(request: Request, account: dict = Depends(require_professor)):
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(400, "Bad request.")
    if body.get("consent") is not True:
        raise HTTPException(422, "Confirm the consent statement first.")
    r = await _service("POST", "/service/profiles", json={
        "name": str(body.get("name") or "")[:60], "consent": True, "owner": str(account.get("professor_id") or "")})
    if r.status_code != 200:
        _service_error(r, "The avatar could not be created.")
    return r.json()


async def _upload(pid: str, kind: str, request: Request, account: dict):
    await _owned(pid, account)
    data = await request.body()
    if not data or len(data) > MAX_UPLOAD:
        raise HTTPException(413 if data else 400, "The file is empty or larger than 25 MB.")
    r = await _service("PUT", f"/service/profiles/{pid}/{kind}", content=data)
    if r.status_code != 200:
        _service_error(r, f"The {kind} could not be saved.")
    return r.json()


@router.put("/professor/avatars/{pid}/photo")
async def professor_photo(pid: str, request: Request, account: dict = Depends(require_professor)):
    return await _upload(pid, "photo", request, account)


@router.put("/professor/avatars/{pid}/voice")
async def professor_voice(pid: str, request: Request, account: dict = Depends(require_professor)):
    return await _upload(pid, "voice", request, account)


@router.get("/professor/avatars/{pid}/photo")
async def professor_photo_preview(pid: str, account: dict = Depends(require_professor)):
    await _owned(pid, account, allow_unowned=True)
    r = await _service("GET", f"/service/profiles/{pid}/photo")
    if r.status_code != 200:
        raise HTTPException(404, "No photo yet.")
    return Response(r.content, media_type="image/jpeg", headers={"Cache-Control": "private, no-store"})


@router.post("/professor/avatars/{pid}/activate")
async def professor_activate(pid: str, account: dict = Depends(require_professor), db: Session = Depends(get_db)):
    """Use this avatar for my exams, and load it now unless another professor's exam is running."""
    await _owned(pid, account, allow_unowned=True)
    me = str(account.get("professor_id") or "")
    r = await _service("POST", "/service/selections", json={"owner": me, "id": pid})
    if r.status_code != 200:
        _service_error(r, "The avatar could not be chosen.")
    if _other_exam_running(db, me):
        return {"ok": True, "loaded": False}
    r = await _service("POST", f"/service/profiles/{pid}/activate")
    if r.status_code != 200:
        _service_error(r, "The avatar could not be started.")
    # Make this professor's published exam questions ready before any student arrives.
    await _prepare_exam_clips(db, pid, professor_id=me)
    return {"ok": True, "loaded": True}


@router.post("/professor/avatars/{pid}/delete")
async def professor_delete(pid: str, account: dict = Depends(require_professor)):
    await _owned(pid, account)
    r = await _service("POST", f"/service/profiles/{pid}/delete")
    if r.status_code != 200:
        _service_error(r, "The avatar could not be deleted.")
    return {"ok": True}


@router.post("/professor/preview")
async def professor_preview(account: dict = Depends(require_professor)):
    """Speak a short line with the active avatar, so the professor can see and hear it."""
    if not _enabled():
        raise HTTPException(503, "The avatar service is not configured.")
    status = (await _service("GET", "/service/status")).json()
    active = (status.get("profile") or {}).get("id")
    if not active:
        raise HTTPException(409, "No avatar is in use yet.")
    await _owned(active, account, allow_unowned=True)
    return await _relay_speech(PREVIEW_TEXT)
