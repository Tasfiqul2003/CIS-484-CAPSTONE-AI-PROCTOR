"""Synthetic signaling authorization and lifecycle tests; no devices or servers."""
from datetime import datetime, timedelta, timezone
import json

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from backend.app import live_video
from backend.app.db import get_db

SID = "20000000-0000-4000-8000-000000000001"
EXAM = "40000000-0000-4000-8000-000000000001"
STUDENT = "30000000-0000-4000-8000-000000000001"
PROFESSOR = "50000000-0000-4000-8000-000000000001"
STUDENT_PEER = "60000000-0000-4000-8000-000000000001"
PROFESSOR_PEER = "60000000-0000-4000-8000-000000000002"
OTHER_PEER = "60000000-0000-4000-8000-000000000003"
URL = f"/exam/sessions/{SID}/live-video"
HEADERS = {"Authorization": "Bearer synthetic"}


class DB:
    def __init__(self, row):
        self.row = row

    def execute(self, *args, **kwargs):
        return self

    def mappings(self):
        return self

    def first(self):
        return self.row


@pytest.fixture
def setup(monkeypatch):
    row = {"student_id": STUDENT, "exam_template_id": EXAM, "professor_id": PROFESSOR,
           "status": "in_progress", "developer_demo": False, "video_status": "recording",
           "expires_at": datetime.now(timezone.utc) + timedelta(days=1)}
    claims = {"session_id": SID, "sub": STUDENT, "exam_template_id": EXAM}
    account = {"role": "professor", "professor_id": PROFESSOR}
    clock = {"now": 100.0}
    monkeypatch.setattr(live_video, "read_student_token", lambda *a, **kw: claims)
    monkeypatch.setattr(live_video, "get_current_account", lambda *a, **kw: account)
    monkeypatch.setattr(live_video.time, "monotonic", lambda: clock["now"])
    live_video._rooms.clear()
    app = FastAPI()
    app.include_router(live_video.router)
    app.dependency_overrides[get_db] = lambda: DB(row)
    with TestClient(app) as client:
        yield client, row, claims, account, clock
    live_video._rooms.clear()
    app.dependency_overrides.clear()


def join(client):
    first = client.get(URL, params={"peer_id": STUDENT_PEER}, headers=HEADERS)
    assert first.status_code == 200
    assert first.json()["peer_present"] is False
    viewer = client.get(URL, params={"peer_id": PROFESSOR_PEER})
    assert viewer.status_code == 200 and viewer.json()["peer_present"] is True
    return viewer.json()["epoch"]


def post(client, epoch, kind="offer", peer=STUDENT_PEER, headers=HEADERS, payload="synthetic-sdp", room_id=None):
    return client.post(URL, headers=headers, json={"peer_id": peer, "room_id": str(room_id or live_video._rooms[SID].room_id),
        "epoch": epoch, "kind": kind, "payload": payload})


def test_authorized_pair_only_receives_other_side_signals(setup):
    client, *_ = setup
    epoch = join(client)

    assert post(client, epoch).status_code == 200
    viewer = client.get(URL, params={"peer_id": PROFESSOR_PEER})
    assert viewer.headers["cache-control"] == "private, no-store"
    assert [s["kind"] for s in viewer.json()["signals"]] == ["offer"]
    assert viewer.json()["topology"] == "single-process-local-webrtc-no-relay"
    student = client.get(URL, params={"peer_id": STUDENT_PEER}, headers=HEADERS)
    assert student.json()["signals"] == []
    after = client.get(URL, params={"peer_id": PROFESSOR_PEER, "after": viewer.json()["cursor"], "room_id": viewer.json()["room_id"]})
    assert after.json()["signals"] == []


def test_wrong_professor_and_cross_attempt_token_denied(setup):
    client, row, claims, account, _ = setup
    account["professor_id"] = "different-professor"
    assert client.get(URL, params={"peer_id": PROFESSOR_PEER}).status_code == 404
    claims["session_id"] = EXAM
    assert client.get(URL, params={"peer_id": STUDENT_PEER}, headers=HEADERS).status_code == 403
    claims["session_id"] = SID
    claims["exam_template_id"] = SID
    assert client.get(URL, params={"peer_id": STUDENT_PEER}, headers=HEADERS).status_code == 403
    assert live_video._rooms == {}


def test_expired_credentials_cannot_poll_or_signal(setup, monkeypatch):
    client, *_ = setup
    epoch = join(client)
    def invalid(*args, **kwargs):
        raise HTTPException(401, "Invalid or expired student token.")
    monkeypatch.setattr(live_video, "read_student_token", invalid)
    assert client.get(URL, params={"peer_id": STUDENT_PEER}, headers=HEADERS).status_code == 401
    assert post(client, epoch).status_code == 401


@pytest.mark.parametrize("field,value", [("status", "pending_grading"), ("video_status", "completed"), ("developer_demo", True), ("expires_at", None)])
def test_attempt_completion_and_recording_gates_remove_room(setup, field, value):
    client, row, *_ = setup
    epoch = join(client)
    row[field] = value
    assert post(client, epoch).status_code == 410
    assert SID not in live_video._rooms


def test_elapsed_retention_deadline_blocks_live_view(setup):
    client, row, *_ = setup
    row["expires_at"] = datetime.now(timezone.utc) - timedelta(seconds=1)
    assert client.get(URL, params={"peer_id": PROFESSOR_PEER}).status_code == 410


def test_two_tabs_and_stale_epoch_cannot_cross_connections(setup):
    client, *_ = setup
    epoch = join(client)
    assert client.get(URL, params={"peer_id": OTHER_PEER}).status_code == 409
    assert post(client, epoch - 1).status_code == 409
    assert post(client, epoch, peer=OTHER_PEER).status_code == 409
    assert post(client, epoch, kind="answer").status_code == 403
    assert post(client, epoch, peer=PROFESSOR_PEER, headers={}, kind="offer").status_code == 403


def test_disconnect_cleanup_and_reconnect_gets_new_epoch(setup):
    client, row, claims, account, clock = setup
    epoch = join(client)
    assert post(client, epoch).status_code == 200
    clock["now"] += 10
    client.get(URL, params={"peer_id": STUDENT_PEER}, headers=HEADERS)
    clock["now"] += 6
    publisher = client.get(URL, params={"peer_id": STUDENT_PEER}, headers=HEADERS).json()
    assert publisher["peer_present"] is False and publisher["epoch"] > epoch
    viewer = client.get(URL, params={"peer_id": OTHER_PEER}).json()
    assert viewer["epoch"] > publisher["epoch"] and viewer["signals"] == []
    assert post(client, epoch).status_code == 409
    assert post(client, viewer["epoch"], kind="leave", peer=OTHER_PEER, headers={}).status_code == 200
    assert "professor" not in live_video._rooms[SID].peers


def test_payload_and_signal_queue_limits(setup):
    client, *_ = setup
    epoch = join(client)
    assert post(client, epoch, payload="x" * 65537).status_code == 422
    assert post(client, epoch, kind="candidate", payload="x" * 8193).status_code == 422
    for _ in range(live_video.MAX_SIGNALS):
        assert post(client, epoch, kind="candidate").status_code == 200
    assert post(client, epoch, kind="candidate").status_code == 429


def test_ephemeral_room_capacity_is_bounded(setup, monkeypatch):
    client, *_ = setup
    monkeypatch.setattr(live_video, "MAX_ROOMS", 0)
    assert client.get(URL, params={"peer_id": PROFESSOR_PEER}).status_code == 503


def test_recreated_room_rejects_old_generation_and_resets_old_cursor(setup):
    client, *_ = setup
    epoch = join(client)
    old_room = live_video._rooms[SID].room_id
    live_video._rooms.clear()  # A process/room lifetime boundary, no media restart.
    assert join(client) == epoch
    new_room = live_video._rooms[SID].room_id
    assert new_room != old_room
    assert post(client, epoch, room_id=old_room).status_code == 409
    assert post(client, epoch).status_code == 200
    reset = client.get(URL, params={"peer_id":PROFESSOR_PEER,"room_id":str(old_room),"after":999})
    assert reset.status_code == 200 and len(reset.json()['signals']) == 1
    acknowledged = client.get(URL, params={"peer_id":PROFESSOR_PEER,"room_id":str(new_room),"after":reset.json()['cursor']})
    assert acknowledged.json()['signals'] == []


@pytest.mark.parametrize('role', ['student','professor'])
def test_authentication_is_rechecked_after_scope_database_work(setup, monkeypatch, role):
    client, row, claims, account, _ = setup
    reads = []
    def read(*args, **kwargs):
        reads.append(True)
        if len(reads) > 1:
            raise HTTPException(401,'Synthetic expiry while database scope was being checked')
        return claims if role == 'student' else account
    monkeypatch.setattr(live_video,'read_student_token' if role == 'student' else 'get_current_account',read)
    response=client.get(URL,params={'peer_id':STUDENT_PEER if role == 'student' else PROFESSOR_PEER},
        headers=HEADERS if role == 'student' else {})
    assert response.status_code == 401 and live_video._rooms == {}


def test_signal_bytes_are_bounded_and_released_on_ttl_expiry(setup, monkeypatch):
    client, row, claims, account, clock = setup
    monkeypatch.setattr(live_video,'MAX_ROOM_BYTES',8)
    monkeypatch.setattr(live_video,'MAX_TOTAL_BYTES',8)
    epoch=join(client)
    assert post(client,epoch,payload='12345678').status_code == 200
    assert live_video._rooms[SID].queued_bytes == 8
    assert post(client,epoch,payload='x').status_code == 429
    for delta in (10,10,10,1):
        clock['now'] += delta
        client.get(URL,params={'peer_id':STUDENT_PEER},headers=HEADERS)
        client.get(URL,params={'peer_id':PROFESSOR_PEER})
    assert live_video._rooms[SID].queued_bytes == 0
    assert post(client,epoch,payload='new').status_code == 200


def test_unicode_signal_budget_counts_encoded_bytes_and_strict_generation(setup, monkeypatch):
    client, *_ = setup
    epoch=join(client)
    monkeypatch.setattr(live_video,'MAX_SIGNAL_BYTES',4)
    assert post(client,epoch,payload='🙂🙂').status_code == 422
    invalid_unicode=json.dumps({'peer_id':STUDENT_PEER,'room_id':str(live_video._rooms[SID].room_id),
        'epoch':epoch,'kind':'offer','payload':'\ud800'},ensure_ascii=True)
    assert client.post(URL,headers={**HEADERS,'Content-Type':'application/json'},content=invalid_unicode).status_code == 422
    assert post(client,True,payload='test').status_code == 422
    assert live_video._rooms[SID].queued_bytes == 0
