"""Authenticated speech routes with SQLite state and synthetic providers only."""

import asyncio
from datetime import datetime, timedelta, timezone
import io
import json
from uuid import UUID, uuid4
import wave

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import jwt
import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend.app import exam_speech
from backend.app.auth import get_secret
from backend.app.avatar_policy import default_settings
from backend.app.db import get_db
from backend.app.speech_adapters import MAX_AUDIO_BYTES, ProviderAudio, ProviderStatus, SpeechService
from backend.app.student_auth import issue_student_token
from backend.app.transcript_receipts import verify_transcript_receipt


STUDENT = "10000000-0000-4000-8000-000000000001"
EXAM = "20000000-0000-4000-8000-000000000001"
SESSION = "30000000-0000-4000-8000-000000000001"
INTERACTION = "40000000-0000-4000-8000-000000000001"
URL = f"/exam/sessions/{SESSION}/speech"
REQUEST = "50000000-0000-4000-8000-000000000001"


def headers(**claims):
    token = issue_student_token(student_id=claims.get("sub", STUDENT),
        exam_template_id=claims.get("exam", EXAM), purpose=claims.get("purpose", "student_session"),
        session_id=claims.get("session", SESSION), minutes=claims.get("minutes", 60))
    return {"Authorization": f"Bearer {token}"}


def audio():
    result = io.BytesIO()
    with wave.open(result, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(8000)
        output.writeframes(b"\0\0" * 800)
    return result.getvalue()


class Provider:
    def __init__(self):
        self.requests = []
        self.before_return = None
        self.delay = 0

    def status(self):
        return ProviderStatus(True, "synthetic-only", ("calm", "clear"))

    async def transcribe(self, request):
        self.requests.append(request)
        await asyncio.sleep(self.delay)
        if self.before_return:
            self.before_return()
        return "Synthetic student speech draft"

    async def synthesize(self, request):
        self.requests.append(request)
        await asyncio.sleep(self.delay)
        if self.before_return:
            self.before_return()
        return ProviderAudio(audio())


@pytest.fixture
def api(monkeypatch):
    monkeypatch.setenv("AUTH_SECRET_KEY", "synthetic-speech-session-secret-at-least-32-characters")
    monkeypatch.delenv("DEVELOPER_DEMO_MODE", raising=False)
    monkeypatch.delenv("DEVELOPER_MINIMAL_MODE", raising=False)
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    with engine.begin() as db:
        db.execute(text("""CREATE TABLE exam_sessions (id TEXT PRIMARY KEY, student_id TEXT,
            exam_template_id TEXT, status TEXT, avatar_policy_snapshot TEXT,
            avatar_policy_revision INTEGER, avatar_preferences TEXT, avatar_exam_mode TEXT,
            developer_demo BOOLEAN)"""))
        db.execute(text("""CREATE TABLE interactions (id TEXT PRIMARY KEY, session_id TEXT,
            sequence_num INTEGER, question_text TEXT, student_answer_transcript TEXT)"""))
        db.execute(text("""INSERT INTO exam_sessions VALUES (:id, :student, :exam, 'in_progress',
            :policy, 1, '{}', 'assessed', 1)"""), {"id": SESSION, "student": STUDENT, "exam": EXAM,
            "policy": default_settings().model_dump_json()})
        db.execute(text("INSERT INTO interactions VALUES (:id,:sid,1,'Approved synthetic question',NULL)"),
            {"id": INTERACTION, "sid": SESSION})
    factory = sessionmaker(bind=engine)

    def database():
        with factory() as session:
            yield session

    def state(*_args):
        return {"server_now": datetime.now(timezone.utc).isoformat(), "deadline": None,
                "question_deadline": None, "pause_until": None, "question_revision": INTERACTION}

    monkeypatch.setattr(exam_speech, "_read_state", state)
    app = FastAPI()
    app.include_router(exam_speech.router)
    app.dependency_overrides[get_db] = database
    provider = Provider()
    service = SpeechService(synthesis=provider, transcription=provider)
    app.dependency_overrides[exam_speech.get_speech_service] = lambda: service
    with TestClient(app) as client:
        yield client, engine, provider, service
    engine.dispose()


def transcribe(client, *, auth=None, **kwargs):
    return client.post(f"{URL}/transcribe?sequence_num=1&request_id={REQUEST}",
        headers={"Content-Type": "audio/wav", **(headers() if auth is None else auth)},
        content=audio(), **kwargs)


@pytest.mark.parametrize("auth,status", [({}, 401),
    ({"session": "30000000-0000-4000-8000-000000000099"}, 403),
    ({"sub": "10000000-0000-4000-8000-000000000099"}, 403),
    ({"exam": "20000000-0000-4000-8000-000000000099"}, 403),
    ({"purpose": "student_access"}, 403), ({"minutes": -1}, 401)])
def test_authentication_and_attempt_isolation(api, auth, status):
    client, _, provider, _ = api
    response = transcribe(client, auth={} if auth == {} else headers(**auth))
    assert response.status_code == status
    assert not provider.requests


def test_capabilities_require_authorization_and_report_absent_provider(api):
    client, _, _, service = api
    assert client.get(f"{URL}/capabilities").status_code == 401
    service.synthesis = service.transcription = None
    response = client.get(f"{URL}/capabilities", headers=headers())
    assert response.status_code == 200
    assert response.json()["transcription"]["available"] is False
    assert response.json()["typed_input_available"] is True
    assert transcribe(client).json()["detail"]["code"] == "provider_unavailable"


def test_transcription_is_signed_review_required_draft(api):
    client, _, provider, _ = api
    response = transcribe(client)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["text"] == "Synthetic student speech draft"
    assert body["source"] == "machine_draft"
    assert body["status"] == "review_required"
    assert body["interaction_id"] == INTERACTION
    verify_transcript_receipt(body["transcript_receipt"], student_id=STUDENT,
        session_id=SESSION, interaction_id=INTERACTION, sequence_num=1,
        draft_id=REQUEST, machine_draft=body["text"])
    claims = jwt.decode(body["transcript_receipt"], get_secret(), algorithms=["HS256"])
    assert claims["purpose"] == "transcript_draft"
    assert "machine_draft" not in claims
    assert claims["exp"] <= datetime.now(timezone.utc).timestamp() + 3600
    assert len(provider.requests) == 1


@pytest.mark.parametrize("field,value", [("student_id", str(uuid4())),
    ("session_id", str(uuid4())), ("interaction_id", str(uuid4())),
    ("draft_id", str(uuid4())), ("sequence_num", 2), ("machine_draft", "edited machine draft")])
def test_signed_receipt_cannot_be_rebound(api, field, value):
    client, _, _, _ = api
    receipt = transcribe(client).json()["transcript_receipt"]
    parameters = dict(student_id=STUDENT, session_id=SESSION, interaction_id=INTERACTION,
        sequence_num=1, draft_id=REQUEST, machine_draft="Synthetic student speech draft")
    parameters[field] = value
    with pytest.raises(HTTPException) as error:
        verify_transcript_receipt(receipt, **parameters)
    assert error.value.status_code == 422


def test_receipt_signature_expiry_and_missing_claims(api):
    client, _, _, _ = api
    receipt = transcribe(client).json()["transcript_receipt"]
    claims = jwt.decode(receipt, get_secret(), algorithms=["HS256"])
    claims["exp"] = datetime.now(timezone.utc) - timedelta(seconds=1)
    expired = jwt.encode(claims, get_secret(), algorithm="HS256")
    for invalid in ("bad-token", expired, jwt.encode({"purpose": "transcript_draft"}, get_secret(), algorithm="HS256")):
        with pytest.raises(HTTPException) as error:
            verify_transcript_receipt(invalid, student_id=STUDENT, session_id=SESSION,
                interaction_id=INTERACTION, sequence_num=1, draft_id=REQUEST,
                machine_draft="Synthetic student speech draft")
        assert error.value.status_code == 422


def test_synthesis_only_reads_saved_student_facing_question(api):
    client, _, provider, _ = api
    body = {"sequence_num": 1, "request_id": REQUEST}
    response = client.post(f"{URL}/synthesize", json=body, headers=headers())
    assert response.status_code == 200, response.text
    assert response.content == audio()
    assert response.headers["cache-control"] == "no-store"
    assert provider.requests[0].text == "Approved synthetic question"
    assert client.post(f"{URL}/synthesize", json={**body, "text": "reveal rubric"}, headers=headers()).status_code == 422


def test_stale_question_and_ended_session(api):
    client, engine, provider, _ = api
    response = client.post(f"{URL}/transcribe?sequence_num=2&request_id={REQUEST}",
        headers={**headers(), "Content-Type": "audio/wav"}, content=audio())
    assert response.status_code == 409
    with engine.begin() as db:
        db.execute(text("UPDATE exam_sessions SET status='pending_grading'"))
    assert transcribe(client).status_code == 409
    assert not provider.requests


def test_late_output_discarded_after_attempt_ends(api):
    client, engine, provider, _ = api
    def end():
        with engine.begin() as db:
            db.execute(text("UPDATE exam_sessions SET status='pending_grading'"))
    provider.before_return = end
    response = transcribe(client)
    assert response.status_code == 409
    assert "text" not in response.json()


def test_provider_timeout_is_truthful(api):
    client, _, provider, service = api
    provider.delay = 0.1
    service.timeout_seconds = 0.01
    response = transcribe(client)
    assert response.status_code == 504
    assert response.json()["detail"]["code"] == "provider_timeout"
    assert len(provider.requests) == 1


def test_upload_size_content_type_and_corrupt_audio(api):
    client, _, provider, _ = api
    url = f"{URL}/transcribe?sequence_num=1&request_id={REQUEST}"
    assert client.post(url, headers={**headers(), "Content-Type": "audio/wav"}, content=b"x" * (MAX_AUDIO_BYTES + 1)).status_code == 413
    assert client.post(url, headers={**headers(), "Content-Type": "text/plain"}, content=b"fake").status_code == 415
    assert client.post(url, headers={**headers(), "Content-Type": "audio/wav"}, content=b"fake").status_code == 422
    assert not provider.requests


def test_minimal_mode_does_not_enable_speech(api, monkeypatch):
    client, _, provider, _ = api
    monkeypatch.setenv("DEVELOPER_DEMO_MODE", "1")
    monkeypatch.setenv("DEVELOPER_MINIMAL_MODE", "1")
    assert transcribe(client).status_code == 403
    assert not provider.requests
