"""Synthetic transaction tests; no live PostgreSQL, model, or devices."""
from threading import RLock
from uuid import uuid4
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from backend.app import exam, stream
from backend.app.exam_contracts import answer_fingerprint, answer_metadata
from backend.app.transcript_receipts import issue_transcript_receipt
from backend.app.review import _valid_exchange_offsets
from backend.tests.test_question_time_limits import TurnDB, Result, SESSION, CLAIMS, prepare_turn


class ReceiptsDB(TurnDB):
    def __init__(self):
        super().__init__(question_elapsed=0)
        self.receipts = {}
        self.next_sequence = 1
        self.lock = RLock()
        self.locked = False

    def execute(self, statement, params=None):
        sql = str(statement)
        if 'FROM exam_answer_operations' in sql:
            return Result(self.receipts.get(params['rid']))
        if 'INSERT INTO exam_answer_operations' in sql:
            assert params['rid'] not in self.receipts
            self.receipts[params['rid']] = {'input_hash': params['hash'], 'response': params['response']}
            return Result()
        if 'FROM exam_sessions s' in sql and 'FOR UPDATE' in sql:
            self.lock.acquire()
            self.locked = True
        if 'SELECT id' in sql and 'student_answer_transcript IS NULL' in sql:
            return Result({'id': 'synthetic-pending', 'sequence_num': self.next_sequence, 'elapsed_min': 0})
        result = super().execute(statement, params)
        if 'INSERT INTO interactions' in sql:
            self.next_sequence += 1
        return result

    def commit(self):
        super().commit()
        self.close()

    def close(self):
        if self.locked:
            self.locked = False
            self.lock.release()


def request(**overrides):
    return exam.AnswerRequest(session_id=SESSION, answer_transcript='Synthetic confirmed answer',
                              question_sequence_num=1, request_id=uuid4(), **overrides)


def submit(db, req):
    try:
        return exam.submit_answer(req, authorization='synthetic', db=db)
    finally:
        db.close()


def test_lost_response_retry_returns_same_result_without_advancing(monkeypatch):
    db = ReceiptsDB()
    prepare_turn(monkeypatch, db)
    req = request()
    first = submit(db, req)
    saved = list(db.writes)
    assert submit(db, req) == first
    assert db.writes == saved
    assert db.next_sequence == 2
    assert len(db.timeline_events) == 1
    assert db.timeline_events[0]['sequence_num'] == 1


def test_two_tabs_cannot_answer_next_question_with_old_identity(monkeypatch):
    db = ReceiptsDB()
    prepare_turn(monkeypatch, db)
    first = request()
    submit(db, first)
    changed = first.model_copy(update={'answer_transcript': 'Changed synthetic answer'})
    with pytest.raises(HTTPException) as error:
        submit(db, changed)
    assert error.value.status_code == 409
    with pytest.raises(HTTPException) as stale:
        submit(db, request())
    assert stale.value.status_code == 409
    assert db.next_sequence == 2
    assert len(db.timeline_events) == 1
    assert db.timeline_events[0]['sequence_num'] == 1


@pytest.mark.parametrize('replay', [False, True])
def test_token_expiring_while_waiting_for_attempt_lock_cannot_write_or_replay(monkeypatch, replay):
    import jwt
    from backend.app import student_auth

    monkeypatch.setenv('AUTH_SECRET_KEY', 'synthetic-lock-expiry-secret-at-least-32-bytes')
    db = ReceiptsDB()
    prepare_turn(monkeypatch, db)
    req = request()
    if replay:
        submit(db, req)
    previous_writes, previous_receipts = list(db.writes), dict(db.receipts)
    previous_sequence = db.next_sequence
    instant = datetime.now(timezone.utc)
    token = student_auth.issue_student_token(student_id=CLAIMS['sub'],
        exam_template_id=CLAIMS['exam_template_id'], purpose='student_session',
        session_id=str(SESSION), minutes=1)

    class TokenClock(datetime):
        current = instant

        @classmethod
        def now(cls, tz=None):
            return cls.current if tz is not None else cls.current.replace(tzinfo=None)

    monkeypatch.setattr(jwt.api_jwt, 'datetime', TokenClock)
    monkeypatch.setattr(exam, 'read_student_token', student_auth.read_student_token)
    execute = db.execute

    def wait_for_lock(statement, params=None):
        result = execute(statement, params)
        if 'FROM exam_sessions s' in str(statement) and 'FOR UPDATE' in str(statement):
            # Deterministically model the time spent blocked on the attempt row;
            # both auth checks still use the actual signed JWT decoder.
            TokenClock.current = instant + timedelta(minutes=2)
        return result

    db.execute = wait_for_lock
    try:
        with pytest.raises(HTTPException) as error:
            exam.submit_answer(req, authorization=f'Bearer {token}', db=db)
        assert error.value.status_code == 401
    finally:
        db.close()
    assert db.writes == previous_writes and db.receipts == previous_receipts
    assert db.next_sequence == previous_sequence


def test_interrupted_provider_rolls_back_before_receipt(monkeypatch):
    db = ReceiptsDB()
    prepare_turn(monkeypatch, db)
    monkeypatch.setenv('DEVELOPER_DEMO_MODE', '1')
    monkeypatch.delenv('DEVELOPER_MINIMAL_MODE', raising=False)
    monkeypatch.setattr(exam, 'ai_available', lambda *a: True)
    monkeypatch.setattr(exam, 'ask_model', lambda *a: (_ for _ in ()).throw(HTTPException(504, 'Synthetic timeout')))
    # Demo-only generation is permitted, but provider failure must not fabricate
    # a reply or receipt. Assessed attempts use approved bank questions only.
    original = db.execute
    def execute(statement, params=None):
        if 'FROM questions' in str(statement):
            return Result(rows=[])
        result = original(statement, params)
        if 'FROM exam_sessions s' in str(statement):
            result.row['developer_demo'] = True
        return result
    db.execute = execute
    with pytest.raises(HTTPException) as error:
        submit(db, request())
    assert error.value.status_code == 504
    assert not db.committed and db.receipts == {}


def test_streaming_http_uses_same_receipt_transaction(monkeypatch):
    db = ReceiptsDB()
    prepare_turn(monkeypatch, db)
    monkeypatch.setattr(stream, 'read_student_token', lambda *a, **k: CLAIMS)
    req = request()
    first = submit(db, req)
    response = stream.answer_stream(req, authorization='synthetic')
    assert response.media_type == 'text/event-stream'
    assert db.next_sequence == 2 and first['done'] is False


@pytest.mark.parametrize('extra', [
    {'answer_timestamp_start': -1, 'answer_timestamp_end': 1},
    {'answer_timestamp_start': 2, 'answer_timestamp_end': 1},
    {'answer_timestamp_start': float('nan'), 'answer_timestamp_end': 1},
    {'answer_timestamp_start': 1}, {'answer_transcript': 'x' * 20001},
    {'input_source': 'automatic_confidence'}, {'question_sequence_num': True},
])
def test_invalid_answer_contract_rejected(extra):
    data = {'session_id': SESSION, 'answer_transcript': 'Synthetic', 'question_sequence_num': 1, **extra}
    with pytest.raises(ValidationError):
        exam.AnswerRequest(**data)


def test_missing_question_identity_cannot_consume_pending_answer():
    req = exam.AnswerRequest(session_id=SESSION, answer_transcript='Synthetic')
    with pytest.raises(HTTPException) as error:
        exam.accepted_answer(req, {}, {'sequence_num': 1})
    assert error.value.status_code == 409


def test_provenance_and_fingerprint_include_source_but_not_request_id():
    typed = request()
    speech = typed.model_copy(update={'input_source': 'confirmed_transcript'})
    assert answer_fingerprint(typed) != answer_fingerprint(speech)
    assert answer_fingerprint(typed) == answer_fingerprint(typed.model_copy(update={'request_id': uuid4()}))
    assert answer_metadata(speech, speech.answer_transcript)['input_source'] == 'confirmed_transcript'
    assert answer_metadata(speech, exam.QUESTION_TIMEOUT_ANSWER)['input_source'] == 'timeout'


@pytest.mark.parametrize('deadline', [None, datetime(2000, 1, 1, tzinfo=timezone.utc)])
def test_expired_recording_cannot_accept_answers_or_speech(deadline):
    class DB:
        def execute(self, *_args, **_kwargs):
            return Result({'status': 'recording', 'next_chunk_index': 5, 'expires_at': deadline})
    with pytest.raises(HTTPException) as error:
        exam.require_active_video_recording(DB(), SESSION, False)
    assert error.value.status_code == 410


def test_confirmed_speech_correction_retains_signed_machine_draft(monkeypatch):
    monkeypatch.setenv('AUTH_SECRET_KEY', 'synthetic-only-provenance-secret-at-least-32-bytes')
    db = ReceiptsDB()
    prepare_turn(monkeypatch, db)
    draft_id, draft = uuid4(), 'Synthetic machine transcript'
    receipt = issue_transcript_receipt(student_id=CLAIMS['sub'], session_id=SESSION,
        interaction_id='synthetic-pending', sequence_num=1, draft_id=draft_id,
        machine_draft=draft, student_token_exp=(datetime.now(timezone.utc) + timedelta(hours=1)).timestamp())
    req = request(input_source='confirmed_transcript', transcript_draft_id=draft_id,
                  machine_draft=draft, transcript_receipt=receipt)
    submit(db, req)
    assert db.saved['a'] == req.answer_transcript
    assert db.saved['machine_draft'] == draft
    assert db.saved['draft_id'] == str(draft_id)
    assert db.saved['input_source'] == 'confirmed_transcript'


def test_tampered_original_draft_is_rejected_before_any_write(monkeypatch):
    monkeypatch.setenv('AUTH_SECRET_KEY', 'synthetic-only-provenance-secret-at-least-32-bytes')
    db = ReceiptsDB()
    prepare_turn(monkeypatch, db)
    draft_id = uuid4()
    receipt = issue_transcript_receipt(student_id=CLAIMS['sub'], session_id=SESSION,
        interaction_id='synthetic-pending', sequence_num=1, draft_id=draft_id,
        machine_draft='Original synthetic', student_token_exp=(datetime.now(timezone.utc) + timedelta(hours=1)).timestamp())
    with pytest.raises(HTTPException) as error:
        submit(db, request(input_source='confirmed_transcript', transcript_draft_id=draft_id,
                           machine_draft='Tampered synthetic', transcript_receipt=receipt))
    assert error.value.status_code == 422
    assert db.writes == [] and not db.receipts


@pytest.mark.parametrize('start,end,valid', [(0, 2, True), (2, 1, False), (-1, 1, False),
    (float('nan'), 2, False), (None, 2, False), (0, float('inf'), False)])
def test_invalid_exchange_offsets_are_unavailable(start, end, valid):
    assert _valid_exchange_offsets({'answer_timestamp_start': start, 'answer_timestamp_end': end}) is valid
