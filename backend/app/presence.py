"""In-exam presence checks: the exam page sends one camera frame every few seconds.

The server counts faces with the same OpenCV detector as the photo check and records an
integrity event when no face, or more than one face, is visible. Frames are not stored.
Events are low severity (they never auto-flag an attempt); the professor sees them, with the
time into the recording, on the review page. Without the face models the check is skipped.
"""

from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sqlalchemy import text
from sqlalchemy.orm import Session

from .db import get_db
from .face_matching import FaceImageInvalid, FaceMatcherUnavailable, get_face_matcher
from .student_auth import read_student_token

router = APIRouter(prefix="/exam", tags=["Exam presence"])

MAX_FRAME_BYTES = 1_500_000
# One event of a kind per window, so a student who looks away for a minute is one flag, not twelve.
EVENT_WINDOW_SECONDS = 30
EVENTS = {
    "face_not_visible": (2, "No face was visible in the camera."),
    "multiple_faces": (3, "More than one face was visible in the camera."),
}


def presence_event(face_count: int) -> str | None:
    if face_count == 0:
        return "face_not_visible"
    if face_count > 1:
        return "multiple_faces"
    return None


@router.post("/sessions/{session_id}/presence")
async def presence_check(session_id: UUID, request: Request, authorization: str | None = Header(default=None),
                         db: Session = Depends(get_db)):
    sid = str(session_id)
    claims = read_student_token(authorization, expected_purpose="student_session")
    if claims.get("session_id") != sid:
        raise HTTPException(403, "Student token does not match this session.")
    session = db.execute(
        text("""SELECT student_id, exam_template_id, status, developer_demo,
                       EXTRACT(EPOCH FROM (now() - started_at)) AS seconds_in
                FROM exam_sessions WHERE id = CAST(:sid AS uuid)"""),
        {"sid": sid},
    ).mappings().first()
    if not session:
        raise HTTPException(404, "Session not found.")
    if claims.get("sub") != str(session["student_id"]) or claims.get("exam_template_id") != str(session["exam_template_id"]):
        raise HTTPException(403, "Student token does not match this exam session.")
    if session["status"] != "in_progress":
        raise HTTPException(409, "This attempt is no longer in progress.")
    if session.get("developer_demo"):
        return {"checked": False}

    frame = await request.body()
    if not frame or len(frame) > MAX_FRAME_BYTES:
        raise HTTPException(413 if frame else 400, "The camera frame is empty or too large.")
    try:
        faces = get_face_matcher().count_faces(frame)
    except FaceMatcherUnavailable:
        return {"checked": False}
    except FaceImageInvalid as error:
        raise HTTPException(422, str(error))

    kind = presence_event(faces)
    if kind:
        recent = db.execute(
            text("""SELECT 1 FROM integrity_events
                    WHERE session_id = CAST(:sid AS uuid) AND event_type = :kind
                      AND created_at > now() - make_interval(secs => :window)"""),
            {"sid": sid, "kind": kind, "window": EVENT_WINDOW_SECONDS},
        ).first()
        if not recent:
            severity, note = EVENTS[kind]
            db.execute(
                text("""INSERT INTO integrity_events (session_id, event_type, event_timestamp, severity, notes)
                        VALUES (CAST(:sid AS uuid), :kind, :ts, :sev, :note)"""),
                {"sid": sid, "kind": kind, "ts": round(float(session["seconds_in"] or 0), 1),
                 "sev": severity, "note": note},
            )
            db.commit()
    return {"checked": True, "faces": faces, "flagged": bool(kind)}
