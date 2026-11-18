"""Real SQLite SQL/transactions plus synthetic HTTP auth, not PostgreSQL proof.

The portable fixture mirrors constraints; PostgreSQL identity/UUID/locking DDL
from migration018 is inspected separately and is not applied by these checks.
"""
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from backend.app import media_timeline as timeline
from backend.app.auth import get_current_account
from backend.app.db import get_db

SID, EXAM, STUDENT, PROFESSOR, INTERACTION = [str(uuid4()) for _ in range(5)]
HEADERS = {"Authorization": "Bearer synthetic"}
URL = f"/exam/sessions/{SID}/media-timeline/events"


@pytest.fixture
def setup(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    @event.listens_for(engine, "connect")
    def foreign_keys(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")
    db = Session(engine)
    statements = [
        "CREATE TABLE exam_templates (id TEXT PRIMARY KEY, professor_id TEXT)",
        "CREATE TABLE exam_sessions (id TEXT PRIMARY KEY, student_id TEXT, exam_template_id TEXT, status TEXT, developer_demo BOOLEAN, ended_at TEXT)",
        "CREATE TABLE exam_session_videos (session_id TEXT PRIMARY KEY, status TEXT, expires_at TEXT)",
        "CREATE TABLE interactions (id TEXT PRIMARY KEY, session_id TEXT, sequence_num INTEGER, UNIQUE(session_id,id))",
        "CREATE TABLE exam_question_audio (id TEXT PRIMARY KEY, session_id TEXT, interaction_id TEXT, expires_at TEXT)",
        """CREATE TABLE exam_media_events (
            event_order INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE,
            event_id TEXT NOT NULL, interaction_id TEXT NOT NULL,
            question_sequence_num INTEGER NOT NULL CHECK(question_sequence_num >= 1),
            kind TEXT NOT NULL CHECK(kind IN ('question_presented','question_audio_started','question_audio_ended',
                'question_audio_failed','student_response_submitted','recording_interrupted','recording_ended')),
            source TEXT NOT NULL CHECK(source IN ('student','server')),
            asset_id TEXT, media_offset_seconds REAL, reported_media_offset_seconds REAL,
            offset_status TEXT NOT NULL CHECK(offset_status IN ('reported','missing','out_of_order')),
            offset_basis TEXT NOT NULL CHECK(offset_basis = 'client_recording_elapsed_seconds'),
            payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
            received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(session_id,event_id),
            FOREIGN KEY(session_id,interaction_id) REFERENCES interactions(session_id,id) ON DELETE CASCADE,
            CHECK(media_offset_seconds IS NULL OR (media_offset_seconds >= 0 AND media_offset_seconds <= 86400)),
            CHECK(reported_media_offset_seconds IS NULL OR (reported_media_offset_seconds >= 0 AND reported_media_offset_seconds <= 86400)),
            CHECK(kind = 'student_response_submitted' OR source = 'student'),
            CHECK(kind != 'student_response_submitted' OR source = 'server'),
            CHECK(asset_id IS NULL OR kind IN ('question_audio_started','question_audio_ended','question_audio_failed'))
        )""",
    ]
    for sql in statements:
        db.execute(text(sql))
    db.execute(text("INSERT INTO exam_templates VALUES (:exam,:prof)"), {"exam": EXAM, "prof": PROFESSOR})
    db.execute(text("INSERT INTO exam_sessions VALUES (:sid,:student,:exam,'in_progress',0,NULL)"),
               {"sid": SID, "student": STUDENT, "exam": EXAM})
    db.execute(text("INSERT INTO exam_session_videos VALUES (:sid,'recording',:expiry)"),
               {"sid": SID, "expiry": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()})
    db.execute(text("INSERT INTO interactions VALUES (:iid,:sid,1)"), {"iid": INTERACTION, "sid": SID})
    db.commit()
    claims = {"sub": STUDENT, "exam_template_id": EXAM, "session_id": SID}
    account = {"role": "professor", "professor_id": PROFESSOR}
    monkeypatch.setattr(timeline, "read_student_token", lambda *a, **kw: claims)
    app = FastAPI()
    app.include_router(timeline.router)
    def database():
        try:
            yield db
        finally:
            db.rollback()
    app.dependency_overrides[get_db] = database
    app.dependency_overrides[get_current_account] = lambda: account
    with TestClient(app) as client:
        yield client, db, claims, account
    db.close()
    engine.dispose()


def send(client, *, event_id=None, kind="question_presented", offset=0, sequence=1, asset_id=None):
    body = {"event_id": event_id or str(uuid4()), "kind": kind,
            "question_sequence_num": sequence, "media_offset_seconds": offset}
    if asset_id is not None:
        body["asset_id"] = asset_id
    return client.post(URL, headers=HEADERS, json=body)


def test_durable_order_and_server_response_share_real_sql_transaction(setup):
    client, db, *_ = setup
    for kind, offset in [("question_presented", 0), ("question_audio_started", 1), ("question_audio_ended", 3)]:
        result = send(client, kind=kind, offset=offset)
        assert result.status_code == 200
        assert result.json()["event"]["offset_verified"] is False
    receipt = timeline.record_response_submitted(db, session_id=SID, interaction_id=INTERACTION,
        sequence_num=1, event_id=uuid4(), media_offset_seconds=10)
    assert receipt["source"] == "server" and receipt["kind"] == "student_response_submitted"
    db.rollback()
    assert len(timeline.read_timeline(db, SID)) == 3
    timeline.record_response_submitted(db, session_id=SID, interaction_id=INTERACTION,
        sequence_num=1, event_id=uuid4(), media_offset_seconds=10)
    db.commit()
    events = timeline.read_timeline(db, SID)
    assert [event["kind"] for event in events] == ["question_presented", "question_audio_started", "question_audio_ended", "student_response_submitted"]
    assert [event["media_offset_seconds"] for event in events] == [0, 1, 3, 10]
    assert all(event["offset_basis"] == "client_recording_elapsed_seconds" for event in events)
    assert all("payload_hash" not in event for event in events)


def test_same_event_retry_replays_after_advancement_but_changed_payload_conflicts(setup):
    client, db, *_ = setup
    event_id = str(uuid4())
    first = send(client, event_id=event_id)
    db.execute(text("INSERT INTO interactions VALUES (:iid,:sid,2)"), {"iid": str(uuid4()), "sid": SID})
    db.commit()
    replay = send(client, event_id=event_id)
    assert replay.status_code == 200 and replay.json()["duplicate"] is True
    assert replay.json()["event"] == first.json()["event"]
    assert send(client, event_id=event_id, offset=1).status_code == 409
    assert send(client, sequence=1).status_code == 409
    assert len(timeline.read_timeline(db, SID)) == 1


def test_student_cannot_forge_server_event_or_attach_another_question(setup):
    client, db, *_ = setup
    assert send(client, kind="student_response_submitted").status_code == 422
    assert send(client, sequence=2).status_code == 409
    assert timeline.read_timeline(db, SID) == []


def test_offsets_are_monotonic_and_late_server_snapshot_is_labeled(setup):
    client, db, *_ = setup
    assert send(client, offset=10).status_code == 200
    assert send(client, kind="question_audio_started", offset=9).status_code == 409
    assert send(client, kind="question_audio_failed", offset=None).json()["event"]["offset_status"] == "missing"
    result = timeline.record_response_submitted(db, session_id=SID, interaction_id=INTERACTION,
        sequence_num=1, media_offset_seconds=8)
    assert result["media_offset_seconds"] is None and result["reported_media_offset_seconds"] == 8
    assert result["offset_status"] == "out_of_order"
    db.commit()


def test_interruption_boundaries_and_terminal_events_after_submission(setup):
    client, db, *_ = setup
    assert send(client, kind="recording_interrupted", offset=5).json()["event"]["continuity_boundary"] is True
    db.execute(text("UPDATE exam_sessions SET status='pending_grading' WHERE id=:sid"), {"sid": SID})
    db.commit()
    ended = send(client, kind="recording_ended", offset=5)
    assert ended.status_code == 200 and ended.json()["event"]["continuity_boundary"] is True
    assert send(client, kind="question_presented", offset=6).status_code == 409


def test_owning_professor_and_student_attempt_authorization(setup):
    client, db, claims, account = setup
    send(client)
    assert client.get(f"/exam/sessions/{SID}/media-timeline").status_code == 200
    account["professor_id"] = str(uuid4())
    assert client.get(f"/exam/sessions/{SID}/media-timeline").status_code == 404
    claims["session_id"] = str(uuid4())
    assert send(client).status_code == 403
    claims["session_id"] = SID
    claims["sub"] = str(uuid4())
    assert send(client).status_code == 403


def test_expired_retention_rejects_new_observations(setup):
    client, db, *_ = setup
    db.execute(text("UPDATE exam_session_videos SET expires_at=:expiry"),
               {"expiry": (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()})
    db.commit()
    assert send(client).status_code == 410


def test_bounded_student_events_leave_capacity_for_server_answer(setup, monkeypatch):
    client, db, *_ = setup
    monkeypatch.setattr(timeline, "MAX_STUDENT_EVENTS", 1)
    assert send(client).status_code == 200
    assert send(client, offset=1).status_code == 429
    result = timeline.record_response_submitted(db, session_id=SID, interaction_id=INTERACTION,
        sequence_num=1, media_offset_seconds=2)
    assert result["source"] == "server"
    db.commit()


def test_question_audio_asset_is_scoped_to_attempt_and_current_interaction(setup):
    client, db, *_ = setup
    asset_id = str(uuid4())
    db.execute(text("INSERT INTO exam_question_audio VALUES (:asset,:sid,:iid,:expiry)"),
               {"asset": asset_id, "sid": SID, "iid": INTERACTION,
                "expiry": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()})
    db.commit()
    assert send(client, kind="question_audio_started", asset_id=asset_id).status_code == 200
    assert send(client, kind="question_audio_ended", offset=1, asset_id=str(uuid4())).status_code == 409
    assert send(client, kind="question_presented", asset_id=asset_id).status_code == 422
    db.execute(text("UPDATE exam_question_audio SET interaction_id=:iid"), {"iid": str(uuid4())})
    db.commit()
    assert send(client, kind="question_audio_ended", offset=1, asset_id=asset_id).status_code == 409


def test_cross_attempt_interaction_is_rejected_by_real_sql_constraint(setup):
    _, db, *_ = setup
    other_sid, other_interaction = str(uuid4()), str(uuid4())
    db.execute(text("INSERT INTO exam_sessions VALUES (:sid,:student,:exam,'in_progress',0,NULL)"),
               {"sid": other_sid, "student": STUDENT, "exam": EXAM})
    db.execute(text("INSERT INTO interactions VALUES (:iid,:sid,1)"), {"iid": other_interaction, "sid": other_sid})
    db.commit()
    from sqlalchemy.exc import IntegrityError
    with pytest.raises(IntegrityError):
        timeline.record_response_submitted(db, session_id=SID, interaction_id=other_interaction,
            sequence_num=1, media_offset_seconds=1)
    db.rollback()


def test_expired_token_is_rechecked_after_attempt_lock(setup, monkeypatch):
    client, db, claims, _ = setup
    calls = []
    def read(*args, **kwargs):
        calls.append(True)
        if len(calls) > 1:
            raise HTTPException(401, "Synthetic expiry while waiting for attempt lock")
        return claims
    monkeypatch.setattr(timeline, "read_student_token", read)
    assert send(client).status_code == 401
    assert timeline.read_timeline(db, SID) == []


def test_missing_timeline_schema_reports_service_unavailable(setup):
    client, db, *_ = setup
    db.execute(text("DROP TABLE exam_media_events"))
    db.commit()
    response = send(client)
    assert response.status_code == 503
    assert response.json()["detail"] == "Media timeline storage is unavailable."


@pytest.mark.parametrize('kind', ['recording_interrupted', 'recording_ended'])
def test_terminal_recording_boundary_atomically_flags_active_attempt_and_replays_once(setup, kind):
    client, db, *_ = setup
    event_id = str(uuid4())
    result = send(client, event_id=event_id, kind=kind, offset=2)
    assert result.status_code == 200
    state = dict(db.execute(text('SELECT status,ended_at FROM exam_sessions WHERE id=:sid'), {'sid':SID}).mappings().one())
    assert state['status'] == 'flagged' and state['ended_at'] is not None
    db.rollback()
    same = send(client, event_id=event_id, kind=kind, offset=2)
    assert same.status_code == 200 and same.json()['duplicate'] is True
    another = send(client, kind=kind, offset=3)
    assert another.status_code == 200 and another.json()['duplicate'] is True
    assert another.json()['event']['event_id'] == event_id
    assert len(timeline.read_timeline(db, SID)) == 1
    assert dict(db.execute(text('SELECT status,ended_at FROM exam_sessions WHERE id=:sid'), {'sid':SID}).mappings().one()) == state
    db.rollback()
    assert send(client, kind='question_presented', offset=4).status_code == 409


def test_stop_boundary_survives_stale_question_observation_limit_and_backward_offset(setup, monkeypatch):
    client, db, *_ = setup
    monkeypatch.setattr(timeline, 'MAX_STUDENT_EVENTS', 1)
    assert send(client, offset=10).status_code == 200
    db.execute(text('INSERT INTO interactions VALUES (:iid,:sid,2)'), {'iid':str(uuid4()),'sid':SID})
    db.commit()
    stopped = send(client, kind='recording_interrupted', sequence=1, offset=5)
    assert stopped.status_code == 200
    event = stopped.json()['event']
    assert event['interaction_id'] == INTERACTION and event['question_sequence_num'] == 1
    assert event['offset_status'] == 'out_of_order' and event['media_offset_seconds'] is None
    assert event['reported_media_offset_seconds'] == 5 and event['continuity_boundary'] is True
    assert db.execute(text('SELECT status FROM exam_sessions WHERE id=:sid'), {'sid':SID}).scalar_one() == 'flagged'
    db.rollback()
    assert send(client, kind='recording_ended', sequence=2, offset=6).status_code == 200
    assert len(timeline.read_timeline(db, SID)) == 3


@pytest.mark.parametrize('video_state', ['expired', 'missing'])
def test_capture_or_retention_failure_cannot_prevent_own_attempt_termination(setup, video_state):
    client, db, *_ = setup
    if video_state == 'missing':
        db.execute(text('DELETE FROM exam_session_videos WHERE session_id=:sid'), {'sid':SID})
    else:
        db.execute(text("UPDATE exam_session_videos SET status='expired',expires_at=:expiry WHERE session_id=:sid"),
            {'sid':SID,'expiry':(datetime.now(timezone.utc)-timedelta(days=1)).isoformat()})
    db.commit()
    assert send(client, kind='recording_interrupted', offset=None).status_code == 200
    assert db.execute(text('SELECT status FROM exam_sessions WHERE id=:sid'), {'sid':SID}).scalar_one() == 'flagged'


def test_unauthorized_recording_stop_cannot_flag_another_attempt(setup):
    client, db, claims, *_ = setup
    claims['sub'] = str(uuid4())
    assert send(client, kind='recording_interrupted').status_code == 403
    assert db.execute(text('SELECT status FROM exam_sessions WHERE id=:sid'), {'sid':SID}).scalar_one() == 'in_progress'


@pytest.mark.parametrize('same_id', [True, False])
def test_replaying_legacy_observational_stop_closes_its_still_active_attempt(setup, same_id):
    client, db, *_ = setup
    legacy_id = uuid4()
    timeline._insert(db, session_id=SID, interaction_id=INTERACTION, sequence_num=1,
        event_id=legacy_id, kind='recording_interrupted', source='student', media_offset_seconds=2.0)
    db.commit()
    result = send(client, kind='recording_interrupted', event_id=str(legacy_id) if same_id else None, offset=2)
    assert result.status_code == 200 and result.json()['duplicate'] is True
    assert db.execute(text('SELECT status FROM exam_sessions WHERE id=:sid'), {'sid':SID}).scalar_one() == 'flagged'
    assert len(timeline.read_timeline(db, SID)) == 1


@pytest.mark.parametrize("offset", [-1, 86401, float("nan"), float("inf")])
def test_invalid_offset_payload_rejected(offset):
    with pytest.raises(ValidationError):
        timeline.MediaEventRequest(event_id=uuid4(), kind="question_presented",
            question_sequence_num=1, media_offset_seconds=offset)
