"""OPT-IN actual PostgreSQL answer/media transactions in an isolated validation DB.

Fixtures insert synthetic attempt rows directly to test answer transactions. They
do NOT exercise photo checks, exam-start gates, real recording, providers or E2E.
No database is started/created/migrated here. No default DATABASE_URL is used.
"""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
import os
import re
import secrets
from threading import Barrier, Lock
import time
from uuid import UUID, uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.orm import Session

from backend.app import exam
from backend.app.avatar_policy import default_settings
from backend.app.media_timeline import record_response_submitted
from backend.app.student_auth import issue_student_token


def _checked_validation_url(raw):
    try:
        url = make_url(raw)
    except Exception:
        raise ValueError("A valid explicit validation database URL is required.") from None
    if (not url.drivername.startswith("postgresql")
            or not re.fullmatch(r"cybros_validation_[a-z0-9_]+", url.database or "")
            or url.host not in ("127.0.0.1", "localhost", "::1") or url.query):
        raise ValueError("Refusing database URL: use a loopback PostgreSQL cybros_validation_ database without query overrides.")
    return url


@pytest.mark.parametrize("raw", [
    "postgresql://synthetic@127.0.0.1/cybros_p3",
    "postgresql://synthetic@127.0.0.1/postgres",
    "postgresql://synthetic@127.0.0.1/cybros_validation_",
    "postgresql://synthetic@127.0.0.1/cybros_validation_UPPER",
    "postgresql://synthetic@remote.invalid/cybros_validation_fixture",
    "postgresql://synthetic@127.0.0.1/cybros_validation_fixture?dbname=cybros_p3",
    "sqlite:///cybros_validation_fixture",
])
def test_validation_url_refuses_nonisolated_or_ambiguous_targets(raw):
    with pytest.raises(ValueError, match="Refusing database URL"):
        _checked_validation_url(raw)


def test_validation_url_accepts_only_explicit_local_validation_target():
    assert _checked_validation_url("postgresql+psycopg2://synthetic@127.0.0.1:55432/cybros_validation_fixture").database == "cybros_validation_fixture"


@pytest.fixture(scope="module")
def pg_engine():
    raw = os.getenv("CYBROS_VALIDATION_DATABASE_URL")
    if not raw:
        pytest.skip("Opt-in PostgreSQL contract check: CYBROS_VALIDATION_DATABASE_URL is unset; no database connection attempted.")
    url = _checked_validation_url(raw)
    engine = create_engine(url, pool_size=4, max_overflow=0, pool_timeout=10,
        isolation_level="READ COMMITTED", echo=False, connect_args={
            "connect_timeout": 5, "application_name": "cybros_validation_contracts",
            "options": "-c statement_timeout=15000 -c lock_timeout=10000",
        })
    try:
        with engine.connect() as connection:
            assert connection.execute(text("SELECT current_database()")).scalar_one() == url.database
            tables = connection.execute(text("""SELECT
                to_regclass('exam_answer_operations') IS NOT NULL,
                to_regclass('exam_media_events') IS NOT NULL,
                to_regclass('exam_question_audio') IS NOT NULL""")).first()
            assert all(tables), "The isolated validation database needs the reviewed migrations; this test never applies them."
        yield engine
    finally:
        engine.dispose()


@dataclass
class AttemptFixture:
    engine: object = field(repr=False)
    professor: UUID
    student: UUID
    exam_id: UUID
    session_id: UUID
    interaction_id: UUID
    first_question: UUID
    next_question: UUID
    authorization: str = field(repr=False)
    sessions: list

    def request(self, request_id=None):
        return exam.AnswerRequest(session_id=self.session_id, request_id=request_id or uuid4(),
            question_sequence_num=1, answer_transcript="Synthetic PostgreSQL confirmed answer",
            answer_timestamp_start=0, answer_timestamp_end=1)


@pytest.fixture
def attempt(pg_engine, monkeypatch):
    # A fresh ephemeral signing key is local to this test process and never logged.
    monkeypatch.setenv("AUTH_SECRET_KEY", secrets.token_urlsafe(48))
    monkeypatch.setattr(exam, "MAX_QUESTIONS", 8)
    def no_provider(*args, **kwargs):
        raise AssertionError("A provider/network call is forbidden in PostgreSQL transaction checks.")
    monkeypatch.setattr(exam, "ask_model", no_provider)
    monkeypatch.setattr(exam.httpx, "post", no_provider)
    professor, student, exam_id, session_id, interaction_id, first_question, next_question = [uuid4() for _ in range(7)]
    created_sessions = [session_id]
    policy = default_settings().model_dump()
    policy["behavior"].update(followUps=0, order="authored", responseTiming="exam")
    import json
    with pg_engine.begin() as db:
        db.execute(text("INSERT INTO professors(id,name,email) VALUES (:id,'Synthetic validation professor',:email)"),
            {"id": professor, "email": f"validation-{professor.hex}@example.invalid"})
        db.execute(text("INSERT INTO students(id,name,email,eid) VALUES (:id,'Synthetic validation student',:email,:eid)"),
            {"id": student, "email": f"validation-{student.hex}@example.invalid", "eid": f"validation-{student.hex}"})
        db.execute(text("""INSERT INTO exam_templates(id,professor_id,title,rubric,status,topic_coverage_required)
            VALUES (:id,:prof,'Synthetic transaction-only validation','{}'::jsonb,'published',ARRAY['synthetic-contracts'])"""),
            {"id": exam_id, "prof": professor})
        db.execute(text("INSERT INTO exam_roster(exam_template_id,student_id) VALUES (:exam,:student)"),
            {"exam": exam_id, "student": student})
        for identifier, position, question in ((first_question, 1, "Synthetic approved first question"),
                                                (next_question, 2, "Synthetic approved second question")):
            db.execute(text("""INSERT INTO questions(id,professor_id,exam_template_id,question_text,
                topic,difficulty,avatar_authored_position) VALUES (:id,:prof,:exam,:question,'synthetic-contracts',1,:position)"""),
                {"id": identifier, "prof": professor, "exam": exam_id, "question": question, "position": position})
        db.execute(text("""INSERT INTO exam_sessions(id,student_id,exam_template_id,status,
            time_limit_minutes,question_time_limit_minutes,avatar_policy_snapshot,avatar_policy_revision,
            avatar_exam_mode,developer_demo,identity_check_completed)
            VALUES (:id,:student,:exam,'in_progress',30,NULL,CAST(:policy AS jsonb),0,'assessed',FALSE,FALSE)"""),
            {"id": session_id, "student": student, "exam": exam_id, "policy": json.dumps(policy)})
        db.execute(text("""INSERT INTO interactions(id,session_id,sequence_num,question_text,question_source,
            source_question_id,avatar_root_sequence,avatar_followup_index)
            VALUES (:id,:sid,1,'Synthetic approved first question','bank',:question,1,0)"""),
            {"id": interaction_id, "sid": session_id, "question": first_question})
        db.execute(text("""INSERT INTO exam_session_videos(session_id,status,content_type,next_chunk_index,total_bytes,expires_at)
            VALUES (:sid,'recording','video/webm',1,1,:expiry)"""),
            {"sid": session_id, "expiry": datetime.now(timezone.utc) + timedelta(days=1)})
    token = issue_student_token(student_id=str(student), exam_template_id=str(exam_id),
                                purpose="student_session", session_id=str(session_id), minutes=10)
    value = AttemptFixture(pg_engine, professor, student, exam_id, session_id, interaction_id,
                           first_question, next_question, f"Bearer {token}", created_sessions)
    try:
        yield value
    finally:
        # Only UUIDs created by THIS fixture; no broad reset, prefix or time filter.
        with pg_engine.begin() as db:
            for sid in created_sessions:
                db.execute(text("DELETE FROM exam_sessions WHERE id=:id"), {"id": sid})
            db.execute(text("DELETE FROM questions WHERE id IN (:first,:second)"),
                       {"first": first_question, "second": next_question})
            db.execute(text("DELETE FROM exam_roster WHERE exam_template_id=:id AND student_id=:student"),
                       {"id": exam_id, "student": student})
            db.execute(text("DELETE FROM exam_templates WHERE id=:id"), {"id": exam_id})
            db.execute(text("DELETE FROM students WHERE id=:id"), {"id": student})
            db.execute(text("DELETE FROM professors WHERE id=:id"), {"id": professor})


def _submit(fixture, request):
    with Session(fixture.engine) as db:
        try:
            return exam.submit_answer(request, authorization=fixture.authorization, db=db)
        except Exception:
            db.rollback()
            raise


def _counts(fixture):
    with fixture.engine.connect() as db:
        return dict(db.execute(text("""SELECT
            (SELECT count(*) FROM interactions WHERE session_id=:sid) AS interactions,
            (SELECT count(*) FROM interactions WHERE session_id=:sid AND student_answer_transcript IS NOT NULL) AS answers,
            (SELECT count(*) FROM exam_answer_operations WHERE session_id=:sid) AS receipts,
            (SELECT count(*) FROM exam_media_events WHERE session_id=:sid AND kind='student_response_submitted') AS events
        """), {"sid": fixture.session_id}).mappings().one())


def test_actual_postgres_concurrent_identical_answer_waits_on_lock_and_commits_once(attempt):
    request = attempt.request()
    ready = Barrier(3)
    pids, pid_lock = [], Lock()
    def worker():
        with Session(attempt.engine) as db:
            pid = db.execute(text("SELECT pg_backend_pid()")).scalar_one()
            with pid_lock:
                pids.append(pid)
            ready.wait(timeout=5)
            try:
                return exam.submit_answer(request, authorization=attempt.authorization, db=db)
            except Exception:
                db.rollback()
                raise
    blocker = Session(attempt.engine)
    pool = ThreadPoolExecutor(max_workers=2)
    futures = []
    try:
        try:
            blocker.execute(text("SELECT id FROM exam_sessions WHERE id=:sid FOR UPDATE"), {"sid": attempt.session_id})
            futures = [pool.submit(worker), pool.submit(worker)]
            ready.wait(timeout=5)
            with attempt.engine.connect() as observer:
                deadline = time.monotonic() + 5
                waiting = 0
                while time.monotonic() < deadline:
                    # Clear the statistics snapshot so each poll sees current waits.
                    observer.execute(text("SELECT pg_stat_clear_snapshot()"))
                    waiting = observer.execute(text("SELECT count(*) FROM pg_stat_activity WHERE pid IN (:first,:second) AND wait_event_type='Lock'"),
                        {"first": pids[0], "second": pids[1]}).scalar_one()
                    if waiting == 2:
                        break
                    time.sleep(0.02)
            assert waiting == 2, "Both real answer transactions must be observed waiting on the actual PostgreSQL attempt lock."
        finally:
            blocker.rollback()
            blocker.close()
        results = [future.result(timeout=20) for future in futures]
    finally:
        pool.shutdown(wait=True, cancel_futures=True)
    assert results[0] == results[1]
    assert results[0]["sequence_num"] == 2
    assert results[0]["question"] == "Synthetic approved second question"
    assert _counts(attempt) == {"interactions": 2, "answers": 1, "receipts": 1, "events": 1}


def test_actual_postgres_different_tab_stale_sequence_cannot_consume_next_question(attempt):
    first = _submit(attempt, attempt.request())
    assert first["sequence_num"] == 2
    with pytest.raises(HTTPException) as error:
        _submit(attempt, attempt.request())
    assert error.value.status_code == 409
    assert _counts(attempt) == {"interactions": 2, "answers": 1, "receipts": 1, "events": 1}


def test_actual_postgres_token_expiring_during_observed_lock_wait_cannot_submit(attempt, monkeypatch):
    import jwt

    instant = datetime.now(timezone.utc)
    class TokenClock(datetime):
        current = instant
        @classmethod
        def now(cls, tz=None):
            return cls.current if tz is not None else cls.current.replace(tzinfo=None)
    monkeypatch.setattr(jwt.api_jwt, "datetime", TokenClock)
    ready = Barrier(2)
    pids = []
    def worker():
        with Session(attempt.engine) as db:
            pids.append(db.execute(text("SELECT pg_backend_pid()")).scalar_one())
            ready.wait(timeout=5)
            try:
                return exam.submit_answer(attempt.request(), authorization=attempt.authorization, db=db)
            except Exception:
                db.rollback()
                raise
    blocker = Session(attempt.engine)
    pool = ThreadPoolExecutor(max_workers=1)
    try:
        try:
            blocker.execute(text("SELECT id FROM exam_sessions WHERE id=:sid FOR UPDATE"), {"sid": attempt.session_id})
            future = pool.submit(worker)
            ready.wait(timeout=5)
            with attempt.engine.connect() as observer:
                deadline = time.monotonic() + 5
                waiting = False
                while time.monotonic() < deadline:
                    observer.execute(text("SELECT pg_stat_clear_snapshot()"))
                    waiting = observer.execute(text("SELECT wait_event_type = 'Lock' FROM pg_stat_activity WHERE pid=:pid"),
                        {"pid": pids[0]}).scalar_one()
                    if waiting:
                        break
                    time.sleep(0.02)
            assert waiting, "The signed-token request must be observed waiting on the actual attempt row lock."
            # The fixture JWT lasts ten minutes. Advance only the real decoder's
            # clock; no wall-clock sleep or fabricated authorization result.
            TokenClock.current = instant + timedelta(minutes=11)
        finally:
            blocker.rollback()
            blocker.close()
        with pytest.raises(HTTPException) as error:
            future.result(timeout=20)
        assert error.value.status_code == 401
    finally:
        pool.shutdown(wait=True, cancel_futures=True)
    assert _counts(attempt) == {"interactions": 1, "answers": 0, "receipts": 0, "events": 0}


def test_actual_postgres_delayed_recording_interruption_flags_and_blocks_next_answer(attempt):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from backend.app import media_timeline
    from backend.app.db import get_db

    assert _submit(attempt, attempt.request())["sequence_num"] == 2
    app = FastAPI()
    app.include_router(exam.router)
    app.include_router(media_timeline.router)
    def database():
        with Session(attempt.engine) as session:
            yield session
    app.dependency_overrides[get_db] = database
    headers = {"Authorization": attempt.authorization}
    body = {"event_id": str(uuid4()), "kind": "recording_interrupted",
        "question_sequence_num": 1, "media_offset_seconds": 0.25}
    endpoint = f"/exam/sessions/{attempt.session_id}/media-timeline/events"
    with TestClient(app) as client:
        boundary = client.post(endpoint, headers=headers, json=body)
        assert boundary.status_code == 200
        event = boundary.json()["event"]
        assert event["interaction_id"] == str(attempt.interaction_id)
        assert event["offset_status"] == "out_of_order" and event["media_offset_seconds"] is None
        with attempt.engine.connect() as db:
            before = db.execute(text("SELECT status,ended_at FROM exam_sessions WHERE id=:sid"),
                {"sid": attempt.session_id}).mappings().one()
            assert before["status"] == "flagged" and before["ended_at"] is not None
            assert db.execute(text("SELECT status FROM exam_session_videos WHERE session_id=:sid"),
                {"sid": attempt.session_id}).scalar_one() == "recording"
        next_answer = attempt.request().model_copy(update={"question_sequence_num": 2})
        blocked = client.post("/exam/answer", headers=headers, json=next_answer.model_dump(mode="json"))
        assert blocked.status_code == 409
        for retry in (body, {**body, "event_id": str(uuid4())}):
            repeated = client.post(endpoint, headers=headers, json=retry)
            assert repeated.status_code == 200 and repeated.json()["duplicate"] is True
            assert repeated.json()["event"]["event_id"] == body["event_id"]
        with attempt.engine.connect() as db:
            assert db.execute(text("SELECT ended_at FROM exam_sessions WHERE id=:sid"),
                {"sid": attempt.session_id}).scalar_one() == before["ended_at"]
            assert db.execute(text("SELECT count(*) FROM exam_media_events WHERE session_id=:sid AND kind='recording_interrupted'"),
                {"sid": attempt.session_id}).scalar_one() == 1
    assert _counts(attempt) == {"interactions": 2, "answers": 1, "receipts": 1, "events": 1}


def test_actual_postgres_late_transaction_abort_rolls_back_answer_event_receipt_and_question(attempt, monkeypatch):
    original = exam.remember_answer
    def abort_after_receipt(db, request, response):
        original(db, request, response)
        db.execute(text("SELECT 1 / 0"))  # Real PostgreSQL transaction-aborting error.
    monkeypatch.setattr(exam, "remember_answer", abort_after_receipt)
    request = attempt.request()
    with pytest.raises(DBAPIError):
        _submit(attempt, request)
    assert _counts(attempt) == {"interactions": 1, "answers": 0, "receipts": 0, "events": 0}
    monkeypatch.setattr(exam, "remember_answer", original)
    assert _submit(attempt, request)["sequence_num"] == 2
    assert _counts(attempt) == {"interactions": 2, "answers": 1, "receipts": 1, "events": 1}


def test_actual_postgres_audio_and_timeline_composite_foreign_keys_reject_cross_attempt_interaction(attempt):
    other_session, other_interaction = uuid4(), uuid4()
    attempt.sessions.append(other_session)
    with attempt.engine.begin() as db:
        db.execute(text("INSERT INTO exam_sessions(id,student_id,exam_template_id) VALUES (:sid,:student,:exam)"),
            {"sid": other_session, "student": attempt.student, "exam": attempt.exam_id})
        db.execute(text("""INSERT INTO interactions(id,session_id,sequence_num,question_text,question_source,source_question_id)
            VALUES (:id,:sid,1,'Synthetic other-attempt question','bank',:question)"""),
            {"id": other_interaction, "sid": other_session, "question": attempt.first_question})
    with Session(attempt.engine) as db:
        with pytest.raises(IntegrityError) as timeline_error:
            record_response_submitted(db, session_id=attempt.session_id, interaction_id=other_interaction,
                sequence_num=1, event_id=uuid4(), media_offset_seconds=1)
        assert getattr(timeline_error.value.orig, "pgcode", None) == "23503"
        db.rollback()
        with pytest.raises(IntegrityError) as audio_error:
            db.execute(text("""INSERT INTO exam_question_audio(id,session_id,interaction_id,request_id,
                input_hash,text_hash,content_hash,voice,speed,duration_seconds,byte_count,status,expires_at)
                VALUES (:id,:sid,:iid,:rid,:hash,:hash,:hash,'calm',1,1,44,'ready',:expires)"""),
                {"id": uuid4(), "sid": attempt.session_id, "iid": other_interaction, "rid": uuid4(),
                 "hash": "0" * 64, "expires": datetime.now(timezone.utc) + timedelta(days=1)})
        assert getattr(audio_error.value.orig, "pgcode", None) == "23503"
        db.rollback()
    assert _counts(attempt) == {"interactions": 1, "answers": 0, "receipts": 0, "events": 0}


def test_actual_postgres_http_media_provenance_survives_database_and_separate_asset_restore(attempt, monkeypatch, tmp_path):
    """Real SQL/routes and fixture WAV bytes; professor account auth is simulated.

    The seeded attempt/recording metadata is a declared contract fixture, not
    evidence that face/start gates or real devices were exercised. The speech
    provider deliberately generates synthetic PCM and a deterministic draft.
    """
    import hashlib
    import io
    import math
    import struct
    import wave

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from backend.app import exam_speech, media_timeline, question_audio, review
    from backend.app.auth import get_current_account
    from backend.app.db import get_db
    from backend.app.speech_adapters import ProviderAudio, ProviderStatus, SpeechService

    class FixtureSpeechProvider:
        draft = "Machine draft for the synthetic PostgreSQL HTTP answer"
        def __init__(self):
            self.synthesis_texts = []
            self.transcription_calls = 0
            self.outputs = {}

        def status(self):
            return ProviderStatus(True, "synthetic-postgres-http-only", ("calm", "clear"))

        async def synthesize(self, request):
            self.synthesis_texts.append(request.text)
            # Distinguishable audio per approved question; no device or native
            # provider call. Both PCM payloads pass the production WAV validator.
            frequency = 410 if request.text == "Synthetic approved first question" else 660
            output = io.BytesIO()
            with wave.open(output, "wb") as writer:
                writer.setnchannels(1)
                writer.setsampwidth(2)
                writer.setframerate(8000)
                writer.writeframes(b"".join(struct.pack("<h", int(6000 * math.sin(2 * math.pi * frequency * n / 8000)))
                                             for n in range(800)))
            payload = output.getvalue()
            self.outputs[request.text] = payload
            return ProviderAudio(payload)

        async def transcribe(self, request):
            self.transcription_calls += 1
            return self.draft

    provider = FixtureSpeechProvider()
    service = SpeechService(synthesis=provider, transcription=provider)
    app = FastAPI()
    for router in (exam.router, exam_speech.router, question_audio.router, media_timeline.router, review.router):
        app.include_router(router)

    def database():
        with Session(attempt.engine) as session:
            yield session

    professor = {"role": "professor", "professor_id": str(attempt.professor)}
    app.dependency_overrides[get_db] = database
    app.dependency_overrides[get_current_account] = lambda: dict(professor)
    # This dual student/professor route calls the same account helper directly,
    # so make its declared professor-auth simulation explicit at that seam too.
    monkeypatch.setattr(question_audio, "get_current_account", lambda _request, _db: dict(professor))
    app.dependency_overrides[exam_speech.get_speech_service] = lambda: service
    monkeypatch.setattr(question_audio, "_recording_root", lambda **kwargs: tmp_path)
    headers = {"Authorization": attempt.authorization}
    prefix = f"/exam/sessions/{attempt.session_id}"
    generated_directory = tmp_path / "question-audio" / str(attempt.session_id)
    try:
        with TestClient(app) as client:
            def observe(kind, sequence, offset, asset_id=None):
                body = {"event_id": str(uuid4()), "kind": kind, "question_sequence_num": sequence,
                        "media_offset_seconds": offset, "asset_id": asset_id}
                response = client.post(f"{prefix}/media-timeline/events", headers=headers, json=body)
                assert response.status_code == 200
                assert response.json()["event"]["offset_verified"] is False
                return response.json()["event"]

            request_one = {"sequence_num": 1, "request_id": str(uuid4())}
            first = client.post(f"{prefix}/question-audio", headers=headers, json=request_one)
            assert first.status_code == 200
            audio_one = first.json()
            assert audio_one["interaction_id"] == str(attempt.interaction_id)
            assert audio_one["playback_evidence"] == "generated_only"
            first_bytes = client.get(audio_one["audio_url"].removeprefix("/api"), headers=headers)
            assert first_bytes.status_code == 200
            assert first_bytes.content == provider.outputs["Synthetic approved first question"]
            assert hashlib.sha256(first_bytes.content).hexdigest() == audio_one["content_sha256"]
            replay = client.post(f"{prefix}/question-audio", headers=headers, json=request_one)
            assert replay.status_code == 200 and replay.json()["asset_id"] == audio_one["asset_id"]
            assert len(provider.synthesis_texts) == 1
            ranged = client.get(audio_one["audio_url"].removeprefix("/api"), headers={**headers, "Range": "bytes=0-15"})
            assert ranged.status_code == 206 and ranged.content == first_bytes.content[:16]
            observe("question_presented", 1, 0)
            observe("question_audio_started", 1, 0.01, audio_one["asset_id"])
            observe("question_audio_ended", 1, 0.1, audio_one["asset_id"])

            draft_request = uuid4()
            transcribed = client.post(f"{prefix}/speech/transcribe?sequence_num=1&request_id={draft_request}",
                headers={**headers, "Content-Type": "audio/wav"}, content=first_bytes.content)
            assert transcribed.status_code == 200
            draft = transcribed.json()
            assert draft["text"] == provider.draft and draft["status"] == "review_required"
            assert provider.transcription_calls == 1
            first_answer_id = uuid4()
            edited_answer = "Student-confirmed edited synthetic PostgreSQL HTTP answer"
            accepted = client.post("/exam/answer", headers=headers, json={
                "session_id": str(attempt.session_id), "request_id": str(first_answer_id),
                "question_sequence_num": 1, "answer_transcript": edited_answer,
                "input_source": "confirmed_transcript", "transcript_draft_id": draft["transcript_draft_id"],
                "machine_draft": draft["text"], "transcript_receipt": draft["transcript_receipt"],
                "answer_timestamp_start": 0, "answer_timestamp_end": 0.4,
            })
            assert accepted.status_code == 200
            assert accepted.json()["sequence_num"] == 2
            interaction_two = accepted.json()["interaction_id"]

            second = client.post(f"{prefix}/question-audio", headers=headers,
                json={"sequence_num": 2, "request_id": str(uuid4())})
            assert second.status_code == 200
            audio_two = second.json()
            assert audio_two["interaction_id"] == interaction_two
            assert audio_two["asset_id"] != audio_one["asset_id"]
            second_bytes = client.get(audio_two["audio_url"].removeprefix("/api"), headers=headers)
            assert second_bytes.status_code == 200
            assert second_bytes.content == provider.outputs["Synthetic approved second question"]
            assert second_bytes.content != first_bytes.content
            assert hashlib.sha256(second_bytes.content).hexdigest() == audio_two["content_sha256"]
            observe("question_presented", 2, 0.5)
            observe("question_audio_started", 2, 0.51, audio_two["asset_id"])
            observe("question_audio_ended", 2, 0.6, audio_two["asset_id"])
            final = client.post("/exam/answer", headers=headers, json={
                "session_id": str(attempt.session_id), "request_id": str(uuid4()),
                "question_sequence_num": 2, "answer_transcript": "Typed synthetic second answer",
                "input_source": "typed", "answer_timestamp_start": 0.5, "answer_timestamp_end": 1,
            })
            assert final.status_code == 200 and final.json()["done"] is True
            observe("recording_ended", 2, 1)

            # Complete only declared recording metadata to exercise review guards.
            # No full WebM recording file or successful device capture is claimed.
            with attempt.engine.begin() as db:
                db.execute(text("UPDATE exam_session_videos SET status='completed',completed_at=clock_timestamp() WHERE session_id=:sid"),
                           {"sid": attempt.session_id})
            viewed = client.get(f"{prefix}/review")
            assert viewed.status_code == 200
            result = viewed.json()
            assert result["timeline_basis"] == "client_reported_approximate_recording_seconds"
            answers = result["answers"]
            assert [answer["sequence_num"] for answer in answers] == [1, 2]
            assert [answer["question"] for answer in answers] == ["Synthetic approved first question", "Synthetic approved second question"]
            assert answers[0]["answer"] == edited_answer
            assert answers[0]["transcript_source"] == "confirmed_transcript"
            assert answers[0]["machine_transcript_draft"] == provider.draft
            assert answers[0]["transcript_draft_id"] == draft["transcript_draft_id"]
            assert answers[0]["answer_revision_id"] == str(first_answer_id)
            assert answers[1]["transcript_source"] == "typed"
            assert answers[1]["machine_transcript_draft"] is None
            for answer, metadata in zip(answers, (audio_one, audio_two), strict=True):
                assert len(answer["question_audio_assets"]) == 1
                asset = answer["question_audio_assets"][0]
                assert asset["asset_id"] == metadata["asset_id"]
                assert asset["interaction_id"] == answer["interaction_id"]
                assert asset["content_sha256"] == metadata["content_sha256"]
                assert asset["playback_status"] == "ended_reported" and asset["playback_verified"] is False
                assert answer["question_audio_status"] == "available"
                observations = [event for event in result["media_events"] if event["asset_id"] == metadata["asset_id"]]
                assert [event["kind"] for event in observations] == ["question_audio_started", "question_audio_ended"]
                assert all(event["interaction_id"] == answer["interaction_id"] and not event["offset_verified"] for event in observations)
                downloaded = client.get(metadata["audio_url"].removeprefix("/api"))
                assert downloaded.status_code == 200
                assert hashlib.sha256(downloaded.content).hexdigest() == metadata["content_sha256"]

            _verify_database_and_fixture_asset_restore(attempt, monkeypatch, generated_directory,
                result, (audio_one, audio_two))

            professor["professor_id"] = str(uuid4())
            assert client.get(f"{prefix}/review").status_code == 404
            assert client.get(audio_one["audio_url"].removeprefix("/api")).status_code == 404
            professor["professor_id"] = str(attempt.professor)
            (generated_directory / f"{audio_one['asset_id']}.wav").unlink()
            assert client.get(audio_one["audio_url"].removeprefix("/api")).status_code == 409
            with attempt.engine.begin() as db:
                db.execute(text("UPDATE exam_question_audio SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=:aid AND session_id=:sid"),
                    {"aid": UUID(audio_two["asset_id"]), "sid": attempt.session_id})
            assert client.get(audio_two["audio_url"].removeprefix("/api")).status_code == 410
            assert _counts(attempt) == {"interactions": 2, "answers": 2, "receipts": 2, "events": 2}
    finally:
        app.dependency_overrides.clear()
        # Exact fixture-owned attempt directory inside pytest tmp_path only.
        if generated_directory.exists():
            assert generated_directory.resolve().parent == (tmp_path / "question-audio").resolve()
            for path in generated_directory.iterdir():
                assert not path.is_symlink() and path.suffix == ".wav" and str(UUID(path.stem)) == path.stem
                path.unlink()
            generated_directory.rmdir()
        base = tmp_path / "question-audio"
        if base.exists() and not any(base.iterdir()):
            base.rmdir()


def _verify_database_and_fixture_asset_restore(attempt, monkeypatch, source_directory, expected_review, expected_assets):
    """Actual native dump/restore of a validation DB plus a SEPARATE fixture WAV ZIP.

    Called only by the gated PostgreSQL test. The dump includes restored source
    accounts, so every dump/log/archive stays in the pre-existing protected P3
    backup root. No default/primary DSN, real recording tree or service control.
    """
    import hashlib
    import json
    from pathlib import Path
    import subprocess
    import zipfile

    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from backend.app import question_audio, review
    from backend.app.auth import get_current_account
    from backend.app.db import get_db

    source_url = _checked_validation_url(attempt.engine.url)
    nonce = secrets.token_hex(12)
    secondary_name = f"cybros_validation_assets_{nonce}"
    secondary_url = _checked_validation_url(source_url.set(database=secondary_name))
    assert secondary_name != source_url.database
    project = Path(__file__).resolve().parents[2]
    protected = project / "private-data" / "p3-local" / "backups"
    if (not protected.is_dir() or protected.is_symlink()
            or protected.resolve().parent != (project / "private-data" / "p3-local").resolve()):
        raise RuntimeError("The existing protected P3 backup directory is required; no public backup fallback is allowed.")
    native = project / ".cache" / "postgres" / "Library" / "bin"
    if not all((native / executable).is_file() for executable in ("pg_dump.exe", "pg_restore.exe")):
        raise RuntimeError("Existing native PostgreSQL backup tools are required for the isolated asset restore check.")
    backup = protected / f"media_restore_{nonce}"
    backup.mkdir(mode=0o700, exist_ok=False)
    restored_root = backup / "restored-fixture-assets"
    restored_root.mkdir(mode=0o700, exist_ok=False)
    dump = backup / "isolated_database.dump"
    archive = backup / "fixture_wavs.zip"
    manifest = {"status": "preparing", "fixture_only_assets": True,
        "database_backup_contains_restored_source_accounts": True,
        "source_database": source_url.database, "restored_database": secondary_name,
        "session_id": str(attempt.session_id), "assets": [],
        "retention_notice": "Protected backup retained; separate approved backup retention policy remains required."}
    report_path = backup / "asset-restore.json"

    def save():
        report_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    # No credential appears in argv, command logs or a URI passed to a program.
    child_environment = {name: os.environ[name] for name in (
        "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "PATH", "USERPROFILE") if name in os.environ}
    child_environment.update(PGHOST=source_url.host, PGPORT=str(source_url.port or 5432),
                             PGUSER=source_url.username or "", PGPASSWORD=source_url.password or "")

    def native_command(executable, arguments, label, database):
        environment = {**child_environment, "PGDATABASE": database}
        completed = subprocess.run([str(native / executable), *map(str, arguments)], env=environment,
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), timeout=90)
        (backup / f"{label}.log").write_bytes(completed.stdout)
        if completed.returncode:
            raise RuntimeError(f"Isolated asset restore {label} failed; diagnostics remain in the protected backup directory.")

    # Administrative CREATE/DROP runs from the validated source validation DB,
    # avoiding any connection through postgres, DATABASE_URL or the primary DB.
    control = create_engine(source_url, isolation_level="AUTOCOMMIT", hide_parameters=True,
        connect_args={"connect_timeout": 5, "application_name": "cybros_validation_asset_control"})
    restored_engine = None
    created = False
    restored_files = []
    successful = False
    try:
        save()
        assert source_directory.name == str(attempt.session_id)
        with archive.open("xb") as archive_file:
            with zipfile.ZipFile(archive_file, "w", compression=zipfile.ZIP_DEFLATED) as package:
                for index, metadata in enumerate(expected_assets, start=1):
                    asset_id = UUID(metadata["asset_id"])
                    source = source_directory / f"{asset_id}.wav"
                    assert not source.is_symlink() and source.resolve().parent == source_directory.resolve()
                    payload = source.read_bytes()
                    digest = hashlib.sha256(payload).hexdigest()
                    assert digest == metadata["content_sha256"]
                    member = f"question-audio/{attempt.session_id}/{asset_id}.wav"
                    package.writestr(member, payload)
                    manifest["assets"].append({"asset_id": str(asset_id), "interaction_id": metadata["interaction_id"],
                        "question_sequence_num": index, "member": member, "sha256": digest, "bytes": len(payload)})
            archive_file.flush()
            os.fsync(archive_file.fileno())
        native_command("pg_dump.exe", ["--no-password", "--format=custom", "--file", dump,
            "--dbname", source_url.database], "database_dump", source_url.database)
        assert dump.is_file() and dump.stat().st_size > 0
        native_command("pg_restore.exe", ["--list", dump], "database_archive_listing", source_url.database)
        manifest["database_dump_sha256"] = hashlib.sha256(dump.read_bytes()).hexdigest()
        manifest["status"] = "restoring_database"
        save()
        with control.connect() as connection:
            connection.execute(text(f"CREATE DATABASE {secondary_name}"))
        created = True
        native_command("pg_restore.exe", ["--no-password", "--exit-on-error", "--no-owner", "--no-privileges",
            "--dbname", secondary_name, dump], "database_restore", secondary_name)
        restored_engine = create_engine(secondary_url, hide_parameters=True,
            connect_args={"connect_timeout": 5, "application_name": "cybros_validation_asset_verify"})
        with restored_engine.connect() as connection:
            assert connection.execute(text("SELECT current_database()")).scalar_one() == secondary_name
        app = FastAPI()
        app.include_router(question_audio.router)
        app.include_router(review.router)

        def restored_database():
            with Session(restored_engine) as session:
                yield session

        account = {"role": "professor", "professor_id": str(attempt.professor)}
        app.dependency_overrides[get_db] = restored_database
        app.dependency_overrides[get_current_account] = lambda: dict(account)
        with monkeypatch.context() as context:
            context.setattr(question_audio, "_recording_root", lambda **kwargs: restored_root)
            context.setattr(question_audio, "get_current_account", lambda _request, _db: dict(account))
            with TestClient(app) as client:
                # DB restore alone retains metadata but cannot supply physical audio.
                missing = client.get(expected_assets[0]["audio_url"].removeprefix("/api"))
                assert missing.status_code == 409
                with zipfile.ZipFile(archive, "r") as package:
                    assert set(package.namelist()) == {item["member"] for item in manifest["assets"]}
                    for item in manifest["assets"]:
                        # Construct from validated IDs; never extract untrusted paths.
                        target = restored_root / "question-audio" / str(attempt.session_id) / f"{UUID(item['asset_id'])}.wav"
                        target.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
                        assert target.resolve().is_relative_to(restored_root.resolve())
                        payload = package.read(item["member"])
                        assert hashlib.sha256(payload).hexdigest() == item["sha256"]
                        with target.open("xb") as output:
                            output.write(payload)
                            output.flush()
                            os.fsync(output.fileno())
                        restored_files.append(target)
                restored = client.get(f"/exam/sessions/{attempt.session_id}/review")
                assert restored.status_code == 200
                assert restored.json()["answers"] == expected_review["answers"]
                assert restored.json()["media_events"] == expected_review["media_events"]
                for metadata in expected_assets:
                    url = metadata["audio_url"].removeprefix("/api")
                    audio = client.get(url)
                    assert audio.status_code == 200
                    assert hashlib.sha256(audio.content).hexdigest() == metadata["content_sha256"]
                    ranged = client.get(url, headers={"Range": "bytes=0-31"})
                    assert ranged.status_code == 206 and ranged.content == audio.content[:32]
                    assert audio.headers["cache-control"] == "private, no-store"
                manifest.update(status="verified", metadata_order_and_provenance_preserved=True,
                    timeline_ids_and_offsets_preserved=True, restored_hash_and_range_reads_verified=True,
                    database_only_missing_assets_rejected=True)
        app.dependency_overrides.clear()
        successful = True
    finally:
        cleanup_failures = []
        if restored_engine is not None:
            try:
                restored_engine.dispose()
            except Exception:
                cleanup_failures.append("restored_connections_close")
        try:
            for file in restored_files:
                assert file.resolve().is_relative_to(restored_root.resolve())
                file.unlink(missing_ok=True)
            for directory in (restored_root / "question-audio" / str(attempt.session_id),
                              restored_root / "question-audio", restored_root):
                if directory.is_dir() and not any(directory.iterdir()):
                    directory.rmdir()
        except Exception:
            cleanup_failures.append("restored_fixture_files")
        if restored_root.exists() and "restored_fixture_files" not in cleanup_failures:
            cleanup_failures.append("restored_fixture_files")
        try:
            if created:
                # Strict fixed namespace + random exact name; never DROP source DB.
                assert re.fullmatch(r"cybros_validation_assets_[a-f0-9]{24}", secondary_name)
                assert secondary_name != source_url.database
                with control.connect() as connection:
                    connection.execute(text(f"DROP DATABASE {secondary_name}"))
                manifest["secondary_database_removed"] = True
        except Exception:
            cleanup_failures.append("secondary_database_remove")
        finally:
            try:
                control.dispose()
            except Exception:
                cleanup_failures.append("control_connections_close")
            manifest["restored_fixture_files_removed"] = not restored_root.exists()
            manifest["cleanup_failures"] = cleanup_failures
            if not successful or cleanup_failures:
                manifest["status"] = "cleanup_failed" if cleanup_failures else "failed"
            save()
        if cleanup_failures:
            raise RuntimeError("Isolated asset restore cleanup incomplete; inspect its protected report before continuing.")


@pytest.mark.skipif(os.getenv("CYBROS_RUN_OLLAMA_TESTS") != "1", reason="Opt-in actual local Ollama grading contract")
def test_actual_postgres_optional_ollama_evaluation_stays_private_and_requires_professor_confirmation(attempt, monkeypatch):
    """Real local model + PG/routes; direct completed fixture, no start/devices.

    The teacher's account and signed cookie are synthetic fixture credentials.
    This verifies cookie/role SQL handling, not a password-login walkthrough.
    """
    import json
    import math
    from http.cookies import SimpleCookie
    from pathlib import Path
    from urllib.parse import urlsplit

    from fastapi import FastAPI, Response
    from fastapi.testclient import TestClient
    import httpx
    from backend.app import grading, review
    from backend.app.auth import COOKIE_NAME, set_session_cookie
    from backend.app.db import get_db

    endpoint = os.getenv("OLLAMA_URL", "")
    parsed = urlsplit(endpoint)
    if (parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost", "::1")
            or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/")):
        raise ValueError("Actual model checks require an explicit loopback-only Ollama HTTP origin.")
    model = os.getenv("OLLAMA_MODEL", "").strip()
    if not model or len(model) > 128:
        raise ValueError("An explicit existing local model is required; this test never downloads one.")
    monkeypatch.setattr(grading, "OLLAMA_URL", endpoint.rstrip("/"))
    monkeypatch.setattr(grading, "OLLAMA_MODEL", model)
    calls = []

    class LoopbackModelHTTP:
        TimeoutException = httpx.TimeoutException
        HTTPError = httpx.HTTPError
        @staticmethod
        def post(url, **kwargs):
            # The common answer fixture forbids generic module-level httpx.post.
            # Only this exact local evaluation request gets a real client.
            if url != endpoint.rstrip("/") + "/api/chat":
                raise AssertionError("Unexpected model endpoint in isolated validation.")
            calls.append(True)
            with httpx.Client(trust_env=False, follow_redirects=False) as client:
                response = client.post(url, **kwargs)
            protected = Path(__file__).resolve().parents[2] / "private-data" / "p3-local" / "backups"
            if not protected.is_dir() or protected.is_symlink():
                raise RuntimeError("The existing protected provider diagnostic directory is required.")
            (protected / f"ollama_contract_response_{secrets.token_hex(12)}.json").write_bytes(response.content)
            return response

    monkeypatch.setattr(grading, "httpx", LoopbackModelHTTP)
    account_id = uuid4()
    rubric = {"criteria": [{"name": "Concept accuracy", "max_score": 5,
        "description": "Explains a function calling itself, a base case and decreasing input."}]}
    with attempt.engine.begin() as db:
        db.execute(text("""INSERT INTO user_accounts(id,username,password_hash,role,professor_id,is_active)
            VALUES (:id,:username,'synthetic-cookie-fixture-no-password-login','professor',:pid,TRUE)"""),
            {"id": account_id, "username": f"validation_grade_{account_id.hex}", "pid": attempt.professor})
        db.execute(text("UPDATE exam_templates SET rubric=CAST(:rubric AS jsonb),topic_coverage_required=ARRAY['recursion'] WHERE id=:id"),
            {"rubric": json.dumps(rubric), "id": attempt.exam_id})
        db.execute(text("""UPDATE interactions SET question_text='What is recursion? Include a base case.',
            student_answer_transcript='Recursion is a function calling itself on a smaller input. A base case stops further calls.',
            answer_input_source='typed',answer_revision_id=:revision WHERE id=:id AND session_id=:sid"""),
            {"revision": uuid4(), "id": attempt.interaction_id, "sid": attempt.session_id})
        db.execute(text("UPDATE exam_sessions SET status='pending_grading',ended_at=clock_timestamp() WHERE id=:id"),
            {"id": attempt.session_id})
        # Declared recording metadata only: this is NOT a captured WebM fixture.
        db.execute(text("UPDATE exam_session_videos SET status='completed',completed_at=clock_timestamp() WHERE session_id=:sid"),
            {"sid": attempt.session_id})
    app = FastAPI()
    app.include_router(grading.router)
    app.include_router(review.router)
    def database():
        with Session(attempt.engine) as session:
            yield session
    app.dependency_overrides[get_db] = database
    try:
        with TestClient(app) as student_client:
            student_headers = {"Authorization": attempt.authorization}
            assert student_client.get(f"/exam/{attempt.session_id}/report", headers=student_headers).status_code == 401
            assert student_client.post("/exam/grade", headers=student_headers,
                json={"session_id": str(attempt.session_id)}).status_code == 401
            assert student_client.put(f"/exam/{attempt.session_id}/grades", headers=student_headers,
                json={"professor_id": str(attempt.professor), "grades": [
                    {"rubric_criterion": "Concept accuracy", "score": 4.0}]}).status_code == 401
            assert calls == []
        response = Response()
        set_session_cookie(response, {"id": account_id, "role": "professor"})
        cookie = SimpleCookie()
        cookie.load(response.headers["set-cookie"])
        started = time.perf_counter()
        with TestClient(app) as professor_client:
            professor_client.cookies.set(COOKIE_NAME, cookie[COOKIE_NAME].value)
            provisional = professor_client.post("/exam/grade", json={"session_id": str(attempt.session_id)})
            elapsed = time.perf_counter() - started
            safe_details = {
                "The evaluation provider returned invalid provisional scores. No grades were saved.",
                "The evaluation provider did not finish a complete assessment. No grades were saved.",
                "The evaluation provider returned an invalid assessment. No grades were saved.",
                "The evaluation provider is unavailable or returned an invalid result.",
                "The evaluation provider timed out. No grades were saved.",
            }
            detail = provisional.json().get("detail") if provisional.status_code != 200 else None
            safe_detail = detail if isinstance(detail, str) and detail in safe_details else "unclassified safe route failure"
            assert provisional.status_code == 200, f"Evaluation HTTP {provisional.status_code}: {safe_detail}"
            proposed = provisional.json()["grades"]
            assert len(proposed) == 1 and proposed[0]["criterion"] == "Concept accuracy"
            suggested = float(proposed[0]["model_suggested_score"])
            assert math.isfinite(suggested) and 0 <= suggested <= 5
            assert len(calls) == 1
            with attempt.engine.connect() as db:
                grade = db.execute(text("SELECT score,graded_at FROM grades WHERE session_id=:sid"),
                                   {"sid": attempt.session_id}).mappings().one()
                assert grade["score"] is None and grade["graded_at"] is None
                assert db.execute(text("SELECT status FROM exam_sessions WHERE id=:sid"),
                                  {"sid": attempt.session_id}).scalar_one() == "pending_grading"
            private = professor_client.get(f"/exam/{attempt.session_id}/report")
            assert private.status_code == 200
            assert len(private.json()["grades"]) == 1
            confirmed = professor_client.put(f"/exam/{attempt.session_id}/grades", json={
                "professor_id": str(attempt.professor), "grades": [{"rubric_criterion": "Concept accuracy",
                    "score": 4.0, "professor_notes": "Synthetic assessor explicitly confirmed after review."}]})
            assert confirmed.status_code == 200 and confirmed.json()["session_status"] == "graded"
            assert float(confirmed.json()["grades"][0]["score"]) == 4.0
            assert confirmed.json()["grades"][0]["graded_at"] is not None
            assert professor_client.post("/exam/grade", json={"session_id": str(attempt.session_id)}).status_code == 409
            assert len(calls) == 1
        with TestClient(app) as student_client:
            assert student_client.get(f"/exam/{attempt.session_id}/report", headers={"Authorization": attempt.authorization}).status_code == 401
        protected = Path(__file__).resolve().parents[2] / "private-data" / "p3-local" / "backups"
        if not protected.is_dir() or protected.is_symlink():
            raise RuntimeError("The existing protected validation report directory is required.")
        (protected / f"ollama_contract_{secrets.token_hex(12)}.json").write_text(json.dumps({
            "status": "passed", "model": model, "local_provider_only": True,
            "roundtrip_seconds": round(elapsed, 3), "model_calls": len(calls),
            "provisional_before_confirmation": True, "professor_confirmation_required": True,
            "student_private_grade_routes_denied": True, "fixture_only_no_identity_or_recording_walkthrough": True,
        }, indent=2), encoding="utf-8")
    finally:
        app.dependency_overrides.clear()
        with attempt.engine.begin() as db:
            db.execute(text("DELETE FROM user_accounts WHERE id=:id AND professor_id=:pid"),
                       {"id": account_id, "pid": attempt.professor})
