import json
from fastapi import HTTPException
import pytest
from scripts import cybros_local
from backend.app.main import readiness
from sqlalchemy.exc import OperationalError


def test_stopped_status_does_not_probe_or_spawn(monkeypatch, tmp_path):
    monkeypatch.setattr(cybros_local, 'STATE', tmp_path / 'absent.json')
    monkeypatch.setattr(cybros_local, 'port_open', lambda port: False)
    monkeypatch.setattr(cybros_local, 'probe', lambda url: pytest.fail('Stopped service must not be probed'))
    result = cybros_local.status()
    assert all(value.get('ready', False) is False for value in result.values())


def test_alive_process_and_port_are_not_readiness(monkeypatch, tmp_path):
    state = tmp_path / 'state.json'
    state.write_text(json.dumps({'backend': {'pid': 123, 'created': 1}}))
    monkeypatch.setattr(cybros_local, 'STATE', state)
    monkeypatch.setattr(cybros_local, 'port_open', lambda port: True)
    monkeypatch.setattr(cybros_local, 'owned', lambda entry: object())
    monkeypatch.setattr(cybros_local, 'probe', lambda url: False)
    assert cybros_local.status()['backend'] == {'listening': True, 'owned_process_alive': True, 'ready': False}


@pytest.mark.parametrize('present', [False, True])
def test_schema_readiness_never_applies_migrations(present):
    class DB:
        def execute(self, sql):
            assert 'CREATE ' not in str(sql) and 'ALTER ' not in str(sql)
            return self
        def mappings(self): return self
        def first(self): return dict.fromkeys(('answer_contracts', 'environments', 'transcripts', 'media_timeline', 'question_audio', 'audio_requests', 'question_drafts', 'question_generation', 'automatic_oral_transcripts'), present)
    if present:
        assert readiness(DB())['status'] == 'ready'
    else:
        with pytest.raises(HTTPException) as error:
            readiness(DB())
        assert error.value.status_code == 503


def test_database_outage_is_service_unavailable():
    class DB:
        def execute(self, sql):
            raise OperationalError('Synthetic unavailable database', {}, Exception())
    with pytest.raises(HTTPException) as error:
        readiness(DB())
    assert error.value.status_code == 503


def test_automatic_workflow_requires_new_transcript_constraint():
    class DB:
        def execute(self, sql):
            assert "pg_get_constraintdef" in str(sql)
            assert "automatic_transcript" in str(sql)
            return self
        def mappings(self): return self
        def first(self):
            row = dict.fromkeys(('answer_contracts', 'environments', 'transcripts', 'media_timeline',
                'question_audio', 'audio_requests', 'question_drafts', 'question_generation'), True)
            row['automatic_oral_transcripts'] = False
            return row
    with pytest.raises(HTTPException) as failure:
        readiness(DB())
    assert failure.value.status_code == 503
