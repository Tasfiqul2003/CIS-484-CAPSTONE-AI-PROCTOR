"""Real SQLite storage/HTTP tests with generated WAV; no services or real media."""
from datetime import datetime, timedelta, timezone
from pathlib import Path
import os
from uuid import uuid4

import pytest
from sqlalchemy import text

from backend.app import question_audio
from backend.app.auth import get_current_account
from backend.tests.test_exam_speech import api, headers, audio, SESSION, INTERACTION, REQUEST, STUDENT, EXAM

PROFESSOR = '60000000-0000-4000-8000-000000000001'
URL = f'/exam/sessions/{SESSION}/question-audio'


@pytest.fixture
def assets(api, monkeypatch, tmp_path):
    client, engine, provider, service = api
    client.app.include_router(question_audio.router)
    client.app.dependency_overrides[get_current_account] = lambda: {'role': 'professor', 'professor_id': PROFESSOR}
    monkeypatch.setattr(question_audio, 'get_current_account',
        lambda request, db: client.app.dependency_overrides[get_current_account]())
    # The speech fixture uses a marked synthetic demo session to isolate the
    # PostgreSQL-only academic clock. Saved-audio requires a real video row below.
    # Only clock reading is stubbed here; auth/scope/preferences/asset SQL is real.
    monkeypatch.setattr(question_audio, '_read_state', lambda *a: {
        'server_now': datetime.now(timezone.utc).isoformat(), 'deadline': None,
        'question_deadline': None, 'pause_until': None})
    monkeypatch.setattr(question_audio, '_recording_root', lambda **kwargs: tmp_path)
    with engine.begin() as db:
        db.execute(text('CREATE TABLE exam_templates(id TEXT PRIMARY KEY, professor_id TEXT)'))
        db.execute(text('INSERT INTO exam_templates VALUES (:exam,:prof)'), {'exam': EXAM, 'prof': PROFESSOR})
        db.execute(text('CREATE TABLE exam_session_videos(session_id TEXT PRIMARY KEY, status TEXT, expires_at TEXT)'))
        db.execute(text('INSERT INTO exam_session_videos VALUES (:sid, :status, :expires)'),
            {'sid': SESSION, 'status': 'recording', 'expires': (datetime.now(timezone.utc)+timedelta(days=1)).isoformat()})
        migration = Path(__file__).parents[2] / 'database/migrations/019_question_audio_assets.sql'
        sql = migration.read_text(encoding='utf-8').replace('DEFAULT clock_timestamp()', 'DEFAULT CURRENT_TIMESTAMP').replace(',\n    UNIQUE (session_id, interaction_id, voice, speed)', '')
        for statement in sql.split(';'):
            if statement.strip(): db.execute(text(statement))
        for statement in (
            "ALTER TABLE exam_question_audio ADD COLUMN media_type TEXT DEFAULT 'audio/wav'",
            "ALTER TABLE exam_question_audio ADD COLUMN profile_id TEXT",
            "ALTER TABLE exam_question_audio ADD COLUMN segment_index INTEGER DEFAULT 0",
            "ALTER TABLE exam_question_audio ADD COLUMN delivery_kind TEXT DEFAULT 'question'",
            "ALTER TABLE exam_question_audio ADD COLUMN delivery_id TEXT",
            "ALTER TABLE exam_question_audio ADD COLUMN delivery_complete BOOLEAN DEFAULT false",
            "CREATE UNIQUE INDEX retained_wav_configuration ON exam_question_audio(session_id,interaction_id,voice,speed) WHERE media_type='audio/wav'"):
            db.execute(text(statement))
    yield client, engine, provider, tmp_path


def generate(client, *, request_id=REQUEST, sequence=1, auth=None):
    return client.post(URL, json={'sequence_num': sequence, 'request_id': request_id},
                       headers=headers() if auth is None else auth)


def test_exact_generated_asset_is_retained_and_replayed_without_resynthesis(assets):
    client, engine, provider, _ = assets
    first = generate(client)
    assert first.status_code == 200, first.text
    data = first.json()
    assert data['playback_evidence'] == 'generated_only'
    downloaded = client.get(data['audio_url'].removeprefix('/api'), headers=headers())
    assert downloaded.status_code == 200 and downloaded.content == audio()
    replay = generate(client)
    assert replay.json() == data and len(provider.requests) == 1
    alias = generate(client, request_id=str(uuid4()))
    assert alias.json()['asset_id'] == data['asset_id'] and len(provider.requests) == 1
    with engine.connect() as db:
        assert db.execute(text('SELECT count(*) FROM exam_question_audio')).scalar_one() == 1
        assert db.execute(text('SELECT count(*) FROM exam_question_audio_requests')).scalar_one() == 2
    assert downloaded.headers['cache-control'] == 'private, no-store'


@pytest.mark.parametrize('auth,status', [({},401), ({'session':'30000000-0000-4000-8000-000000000099'},403),
    ({'sub':'10000000-0000-4000-8000-000000000099'},403)])
def test_generation_rejects_invalid_attempt_before_provider(assets, auth, status):
    client, _, provider, _ = assets
    assert generate(client, auth={} if auth == {} else headers(**auth)).status_code == status
    assert provider.requests == []


def test_changed_question_rejects_stale_audio_request(assets):
    client, _, provider, _ = assets
    assert generate(client, sequence=2).status_code == 409
    assert not provider.requests


def test_owning_professor_review_and_range_are_separate_from_live_delivery(assets):
    client, engine, _, _ = assets
    data = generate(client).json()
    path = data['audio_url'].removeprefix('/api')
    assert client.get(path).status_code == 409
    with engine.begin() as db:
        db.execute(text("UPDATE exam_sessions SET status='pending_grading'"))
        db.execute(text("UPDATE exam_session_videos SET status='completed'"))
    assert client.get(path, headers=headers()).status_code == 409
    response = client.get(path, headers={'Range':'bytes=0-15'})
    assert response.status_code == 206 and response.content == audio()[:16]
    client.app.dependency_overrides[get_current_account] = lambda: {'role':'professor','professor_id':str(uuid4())}
    assert client.get(path).status_code == 404


def test_expired_missing_and_corrupted_assets_are_not_success(assets):
    client, engine, _, root = assets
    data = generate(client).json()
    path = data['audio_url'].removeprefix('/api')
    asset = question_audio._file(root, SESSION, data['asset_id'])
    asset.write_bytes(b'corrupted synthetic')
    assert client.get(path, headers=headers()).status_code == 409
    asset.unlink()
    assert client.get(path, headers=headers()).status_code == 409
    with engine.begin() as db:
        db.execute(text('UPDATE exam_question_audio SET expires_at=:expired'),
            {'expired': (datetime.now(timezone.utc)-timedelta(seconds=1)).isoformat()})
    assert client.get(path, headers=headers()).status_code == 410


def test_late_provider_result_creates_no_audio_asset(assets):
    client, engine, provider, root = assets
    def end():
        with engine.begin() as db: db.execute(text("UPDATE exam_sessions SET status='pending_grading'"))
    provider.before_return = end
    assert generate(client).status_code == 409
    assert list(root.rglob('*.wav')) == []
    with engine.connect() as db:
        assert db.execute(text('SELECT count(*) FROM exam_question_audio')).scalar_one() == 0


def test_redirected_asset_path_is_rejected_before_creating_directory(tmp_path):
    class Redirected(type(tmp_path)):
        def resolve(self, *args, **kwargs):
            if self.name == 'question-audio': return tmp_path / 'different'
            return super().resolve(*args, **kwargs)
    with pytest.raises(Exception) as error:
        question_audio._file(Redirected(str(tmp_path)), SESSION, uuid4(), create=True)
    assert error.value.status_code == 503
    assert not (tmp_path/'question-audio').exists()


def test_audio_request_identifiers_are_bounded_and_existing_retry_still_works(assets, monkeypatch):
    client, _, provider, _ = assets
    monkeypatch.setattr(question_audio, 'MAX_REQUEST_IDS_PER_QUESTION', 2)
    first = generate(client)
    assert first.status_code == 200
    assert generate(client, request_id=str(uuid4())).status_code == 200
    assert generate(client, request_id=str(uuid4())).status_code == 429
    assert generate(client).json() == first.json()
    assert len(provider.requests) == 1


@pytest.mark.skipif(os.environ.get('CYBROS_RUN_NATIVE_SPEECH_TESTS') != '1', reason='Opt-in generated file-only native speech integration')
def test_native_question_audio_is_stored_retrieved_and_transcribed_through_authenticated_routes(assets):
    client, _, _, _ = assets
    from backend.app.windows_speech import configured_windows_service
    from backend.app.transcript_receipts import verify_transcript_receipt
    native = configured_windows_service()
    assert native.capabilities()['synthesis']['available']
    assert native.capabilities()['transcription']['available']
    client.app.dependency_overrides[question_audio.get_speech_service] = lambda: native
    generation = generate(client)
    assert generation.status_code == 200, generation.text
    metadata = generation.json()
    saved = client.get(metadata['audio_url'].removeprefix('/api'), headers=headers())
    assert saved.status_code == 200 and saved.content.startswith(b'RIFF')
    draft_id = str(uuid4())
    response = client.post(f'/exam/sessions/{SESSION}/speech/transcribe?sequence_num=1&request_id={draft_id}',
        headers={'Content-Type':'audio/wav', **headers()}, content=saved.content)
    assert response.status_code == 200, response.text
    draft = response.json()
    assert draft['status'] == 'review_required' and draft['text'].strip()
    assert draft['interaction_id'] == metadata['interaction_id'] == INTERACTION
    verify_transcript_receipt(draft['transcript_receipt'], student_id=STUDENT, session_id=SESSION,
        interaction_id=INTERACTION, sequence_num=1, draft_id=draft_id, machine_draft=draft['text'])


def test_exact_avatar_segments_retain_type_order_hash_and_completed_replay(assets,monkeypatch):
    from types import SimpleNamespace
    from uuid import UUID
    from sqlalchemy.orm import Session
    from backend.app.speech_adapters import SpeechContext
    from backend.app.exam_speech import OralUtterance
    from backend.app.purge_exam_videos import _audio_inventory
    client,engine,provider,root=assets
    context=SpeechContext(UUID(SESSION),UUID(INTERACTION),'revision',UUID(REQUEST))
    settings=SimpleNamespace(presentation=SimpleNamespace(voice='calm'))
    preferences=SimpleNamespace(speed=1)
    expiry=datetime.now(timezone.utc)+timedelta(days=1)
    monkeypatch.setattr(question_audio,'_lock_current',lambda *args:expiry)
    body=OralUtterance(sequence_num=1,request_id=UUID(REQUEST),kind='question')
    data=b'\x00\x00\x00\x18ftypisom'+b'synthetic-container-fixture'
    with Session(engine) as db:
        first=question_audio.retain_avatar_segment(db,SESSION,'synthetic',body,context,settings,preferences,'prof-a',0,data,1,'Approved clip one')
        second=question_audio.retain_avatar_segment(db,SESSION,'synthetic',body,context,settings,preferences,'prof-a',1,data+b'2',1,'Approved clip two')
        assert question_audio.retained_avatar_delivery(db,context,'prof-a','question','calm',1)==[]
        db.execute(text('UPDATE exam_question_audio SET delivery_complete=true'));db.commit()
        replay=question_audio.retained_avatar_delivery(db,context,'prof-a','question','calm',1)
        assert [value['segment_index'] for value in replay]==[0,1]
        assert [value['asset_id'] for value in replay]==[first['asset_id'],second['asset_id']]
        assert question_audio.retained_avatar_delivery(db,context,'prof-b','question','calm',1)==[]
    response=client.get(first['audio_url'].removeprefix('/api'),headers=headers())
    assert response.status_code==200 and response.content==data
    assert response.headers['content-type']=='video/mp4'
    assert all(path.suffix=='.mp4' for path in _audio_inventory(root,UUID(SESSION)))
    assert provider.requests==[]
