from fastapi import FastAPI, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.orm import Session
from sqlalchemy.exc import SQLAlchemyError
import httpx
import os

from .db import get_db
from .exam import router as exam_router
from .grading import router as grading_router
from .review import router as review_router
from .stream import router as stream_router
from .auth import router as auth_router, validate_auth_secret
from .avatar_policy import router as avatar_policy_router
from .avatar_session import router as avatar_session_router
from .avatar_assistance import router as avatar_assistance_router
from .time_settings import router as time_settings_router
from .recording_settings import router as recording_settings_router
from .exam_video import router as exam_video_router
from .exam_downloads import router as exam_downloads_router
from .ods_accommodations import router as ods_accommodations_router
from .developer_demo import router as developer_demo_router
from .identity import router as identity_router
from .environment_preview import router as environment_preview_router
from .exam_speech import router as exam_speech_router
from .live_video import router as live_video_router
from .question_audio import router as question_audio_router
from .media_timeline import router as media_timeline_router
from .question_drafts import router as question_drafts_router
from .avatar_bridge import router as avatar_bridge_router
from .presence import router as presence_router
from .developer_face_bypass import router as developer_face_bypass_router

app = FastAPI(title="AI Oral Exam Proctor")


@app.exception_handler(HTTPException)
async def domain_error(_request: Request, error: HTTPException):
    codes = {401: "invalid_credentials", 403: "permission_denied", 404: "not_found",
             409: "state_conflict", 410: "expired", 413: "payload_too_large",
             422: "invalid_request", 502: "provider_error", 503: "service_unavailable",
             504: "provider_timeout", 507: "storage_full"}
    code = error.detail.get("code") if isinstance(error.detail, dict) else None
    return JSONResponse(status_code=error.status_code, headers=error.headers,
                        content={"detail": error.detail, "code": code or codes.get(error.status_code, "request_failed")})


@app.on_event("startup")
def validate_auth_configuration() -> None:
    """Fail startup if the JWT signing secret is missing or unsafe."""
    validate_auth_secret(os.getenv("AUTH_SECRET_KEY"))


app.include_router(exam_router)
app.include_router(developer_face_bypass_router)
app.include_router(grading_router)
app.include_router(review_router)
app.include_router(stream_router)
app.include_router(auth_router)
app.include_router(avatar_policy_router)
app.include_router(avatar_session_router)
app.include_router(avatar_assistance_router)
app.include_router(time_settings_router)
app.include_router(recording_settings_router)
app.include_router(exam_video_router)
app.include_router(exam_downloads_router)
app.include_router(ods_accommodations_router)
app.include_router(developer_demo_router)
app.include_router(identity_router)
app.include_router(environment_preview_router)
app.include_router(exam_speech_router)
app.include_router(live_video_router)
app.include_router(question_audio_router)
app.include_router(media_timeline_router)
app.include_router(question_drafts_router)
app.include_router(avatar_bridge_router)
app.include_router(presence_router)


@app.get("/")
def root():
    return {"message": "AI Oral Exam Proctor backend is running"}


@app.get("/health")
def health():
    return {"status": "healthy"}


@app.get("/health/db")
def health_db(db: Session = Depends(get_db)):
    db.execute(text("SELECT 1"))
    return {"db": "ok"}


@app.get("/ollama")
async def ollama_test():
    ollama_url = os.getenv("OLLAMA_URL", "http://ollama:11434")

    async with httpx.AsyncClient() as client:
        response = await client.get(f"{ollama_url}/api/tags")

    return response.json()


@app.get("/health/ready")
def readiness(db: Session = Depends(get_db)):
    """Read-only prerequisite check; does not run migrations or start providers."""
    try:
        row = db.execute(text("""SELECT
            (SELECT count(*) = 6 FROM information_schema.columns WHERE table_schema = current_schema()
                AND table_name = 'exam_answer_operations' AND column_name IN
                ('session_id','request_id','question_sequence_num','input_hash','response','created_at')) AS answer_contracts,
            (SELECT count(*) = 4 FROM information_schema.columns WHERE table_schema = current_schema()
                AND table_name = 'student_environment_preferences' AND column_name IN
                ('exam_template_id','student_id','policy_revision','preferences')) AS environments,
            (SELECT count(*) = 4 FROM information_schema.columns WHERE table_schema = current_schema()
                AND table_name = 'interactions' AND column_name IN
                ('answer_input_source','answer_revision_id','transcript_draft_id','machine_transcript_draft')) AS transcripts,
            to_regclass('exam_media_events') IS NOT NULL AS media_timeline,
            to_regclass('exam_question_audio') IS NOT NULL AS question_audio,
            to_regclass('exam_question_audio_requests') IS NOT NULL AS audio_requests,
            to_regclass('question_drafts') IS NOT NULL AS question_drafts,
            to_regclass('question_generation_requests') IS NOT NULL AS question_generation,
            EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('interactions')
                AND conname = 'interactions_answer_input_source_check' AND convalidated
                AND pg_get_constraintdef(oid) LIKE '%automatic_transcript%'
                AND pg_get_constraintdef(oid) LIKE '%unanswered_voice%') AS automatic_oral_transcripts
            """)).mappings().first()
    except SQLAlchemyError:
        raise HTTPException(503, "The local database is unavailable. Check the stopped services and private logs.") from None
    if not row or not all(bool(row.get(key)) for key in ("answer_contracts", "environments", "transcripts", "media_timeline", "question_audio", "audio_requests", "question_drafts", "question_generation", "automatic_oral_transcripts")):
        raise HTTPException(503, "The local database needs the reviewed exam/media migrations before use.")
    return {"status": "ready", "database": "reachable", "schema": "present",
            "optional_providers": "Check authenticated attempt speech capabilities separately."}
