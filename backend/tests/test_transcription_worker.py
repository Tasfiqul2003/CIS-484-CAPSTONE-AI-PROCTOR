"""Synthetic worker tests. No real speech, model downloads, or application DB."""
from dataclasses import replace
import os
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest

from backend.app import transcription_worker as worker

SID = '20000000-0000-4000-8000-000000000001'
TOKEN = '30000000-0000-4000-8000-000000000001'


@pytest.fixture
def config(tmp_path, monkeypatch):
    path = tmp_path / 'model'
    path.mkdir()
    for name in ('model.bin', 'config.json', 'tokenizer.json'):
        (path / name).write_text('synthetic test fixture')
    monkeypatch.setenv('EXAM_TRANSCRIPTION_MODEL_DIR', str(path))
    monkeypatch.setenv('EXAM_TRANSCRIPTION_CPU_THREADS', '2')
    monkeypatch.setenv('EXAM_TRANSCRIPTION_TIMEOUT_SECONDS', '60')
    monkeypatch.setenv('EXAM_TRANSCRIPTION_LANGUAGE', 'en')
    return worker.configuration()


class Model:
    def __init__(self, segments=None, duration=5):
        self.segments = segments if segments is not None else [
            SimpleNamespace(start=0.125, end=2.5, text=' Synthetic  spoken answer. '),
            SimpleNamespace(start=3, end=4, text='Second sentence.'),
        ]
        self.duration = duration
        self.calls = []

    def transcribe(self, source, **kwargs):
        self.calls.append((source, kwargs))
        return iter(self.segments), SimpleNamespace(duration=self.duration)


def test_model_is_local_cpu_and_offline_even_if_environment_disables_offline(config, monkeypatch):
    calls = []
    monkeypatch.setenv('HF_HUB_OFFLINE', '0')
    monkeypatch.setitem(sys.modules, 'faster_whisper', SimpleNamespace(WhisperModel=lambda *a, **k: calls.append((a, k))))
    worker.load_model(config)
    assert os.environ['HF_HUB_OFFLINE'] == '1'
    assert calls == [((str(config.model_dir),), dict(device='cpu', compute_type='int8',
        cpu_threads=2, num_workers=1, local_files_only=True))]


def test_default_worker_uses_one_cpu_thread(config, monkeypatch):
    monkeypatch.delenv('EXAM_TRANSCRIPTION_CPU_THREADS')
    assert worker.configuration().threads == 1


def test_model_check_tests_codec_before_loading_a_model(config, monkeypatch, capsys):
    events = []
    monkeypatch.setattr(sys, 'argv', ['transcription_worker', '--check'])
    monkeypatch.setattr(worker, 'find_spec', lambda _: True)
    monkeypatch.setattr(worker, 'check_audio_decoder', lambda: events.append('decoder'))
    monkeypatch.setattr(worker, 'load_model', lambda _: events.append('model'))
    monkeypatch.setattr(worker, 'open_session', lambda: pytest.fail('A model check must not access the application database.'))
    assert worker.main() == 0
    assert events == ['decoder', 'model']
    assert 'Synthetic audio decoder' in capsys.readouterr().out


def test_incompatible_codec_blocks_model_check_without_exposing_library_error(config, monkeypatch, capsys):
    monkeypatch.setattr(sys, 'argv', ['transcription_worker', '--check'])
    monkeypatch.setattr(worker, 'find_spec', lambda _: True)
    def incompatible_decoder():
        raise TypeError('synthetic-private-library-details')
    monkeypatch.setattr(worker, 'check_audio_decoder', incompatible_decoder)
    monkeypatch.setattr(worker, 'load_model', lambda _: pytest.fail('An incompatible decoder must stop the check.'))
    assert worker.main() == 1
    output = capsys.readouterr()
    assert 'synthetic-private' not in output.err


@pytest.mark.parametrize('value', ['', 'base.en', 'Systran/faster-whisper-base.en'])
def test_identifiers_never_trigger_model_downloads(config, monkeypatch, value):
    monkeypatch.setenv('EXAM_TRANSCRIPTION_MODEL_DIR', value)
    with pytest.raises(ValueError):
        worker.configuration()


def test_missing_tokenizer_rejected_before_engine_fallback(config):
    (config.model_dir / 'tokenizer.json').unlink()
    with pytest.raises(ValueError, match='incomplete'):
        worker.configuration()


@pytest.mark.parametrize('variable,value', [('EXAM_TRANSCRIPTION_CPU_THREADS', '0'),
    ('EXAM_TRANSCRIPTION_CPU_THREADS', '99'), ('EXAM_TRANSCRIPTION_TIMEOUT_SECONDS', '0'),
    ('EXAM_TRANSCRIPTION_TIMEOUT_SECONDS', '99999'), ('EXAM_TRANSCRIPTION_LANGUAGE', '../en')])
def test_invalid_resource_or_language_configuration(config, monkeypatch, variable, value):
    monkeypatch.setenv(variable, value)
    with pytest.raises(ValueError):
        worker.configuration()


def test_generated_text_has_timestamps_and_is_not_a_typed_answer_copy(config):
    model = Model()
    result = worker.transcribe('synthetic-media-handle', model, config)
    assert result == ('[00:00:00.125 - 00:00:02.500] Synthetic spoken answer.\n'
                      '[00:00:03.000 - 00:00:04.000] Second sentence.')
    assert model.calls[0][1]['language'] == 'en'
    assert model.calls[0][1]['condition_on_previous_text'] is False


def test_silence_remains_empty_instead_of_fabricated_text(config):
    assert worker.transcribe('synthetic', Model(segments=[]), config) == ''


@pytest.mark.parametrize('duration', [0, float('inf'), float('nan'), worker.MAX_AUDIO_SECONDS + 1])
def test_invalid_or_excessive_duration_is_rejected(config, duration):
    with pytest.raises(ValueError):
        worker.transcribe('synthetic', Model(duration=duration), config)


def test_output_limit_rejects_instead_of_saving_a_partial_transcript(config, monkeypatch):
    monkeypatch.setattr(worker, 'MAX_TRANSCRIPT_CHARS', 10)
    with pytest.raises(ValueError, match='size limit'):
        worker.transcribe('synthetic', Model(), config)


def test_invalid_segment_time_is_rejected(config):
    model = Model([SimpleNamespace(start=-1, end=2, text='Synthetic')])
    with pytest.raises(ValueError, match='timestamps'):
        worker.transcribe('synthetic', model, config)


def test_claim_commits_a_unique_lease_and_attempt_before_processing(config):
    db = Mock()
    db.execute.return_value.mappings.return_value.first.return_value = {'session_id': SID}
    sid, token = worker.claim_job(db, config)
    assert sid == SID and str(uuid4()) != token
    selection = str(db.execute.call_args_list[1].args[0])
    assert 'SKIP LOCKED' in selection and 's.recording_consent_status' in selection
    assert 's.generate_transcript' in selection and 'NOT s.developer_demo' in selection
    assert "'pending_grading', 'flagged', 'graded'" in selection
    assert 'v.expires_at > clock_timestamp()' in selection
    assert db.execute.call_args.kwargs == {}
    assert db.execute.call_args.args[1]['lease_seconds'] == config.timeout + 60
    assert 'transcript_attempts = transcript_attempts + 1' in str(db.execute.call_args.args[0])
    db.commit.assert_called_once()


def test_no_job_releases_transaction(config):
    db = Mock()
    db.execute.return_value.mappings.return_value.first.return_value = None
    assert worker.claim_job(db, config) is None
    db.commit.assert_called_once()


def test_claim_failure_rolls_back(config):
    db = Mock()
    db.execute.side_effect = RuntimeError('synthetic DB failure')
    with pytest.raises(RuntimeError):
        worker.claim_job(db, config)
    db.rollback.assert_called_once()


@pytest.mark.parametrize('affected,expected', [(1, True), (0, False)])
def test_save_is_guarded_against_expiry_consent_and_stale_lease(affected, expected):
    db = Mock()
    db.execute.return_value.rowcount = affected
    assert worker.save_job(db, SID, TOKEN, 'Synthetic generated speech') is expected
    sql, params = db.execute.call_args.args
    for guard in ('v.expires_at > clock_timestamp()', "s.recording_consent_status = 'consented'",
                  'v.transcript_job_token = CAST(:token AS uuid)', 'v.transcript_lease_until > clock_timestamp()'):
        assert guard in str(sql)
    assert params == {'sid': SID, 'token': TOKEN, 'transcript': 'Synthetic generated speech'}
    assert 'interactions' not in str(sql) and 'grades' not in str(sql)


def test_process_reads_private_media_then_saves_generated_text(config, tmp_path, monkeypatch):
    root = tmp_path / 'media'
    root.mkdir()
    (root / f'{SID}.webm').write_bytes(b'synthetic webm bytes')
    monkeypatch.setenv('EXAM_VIDEO_DIR', str(root))
    db = Mock()
    monkeypatch.setattr(worker, 'open_session', lambda: db)
    monkeypatch.setattr(worker, 'read_job', lambda *a: {'total_bytes': len(b'synthetic webm bytes')})
    monkeypatch.setattr(worker, 'load_model', lambda _: Model())
    save = Mock(return_value=True)
    monkeypatch.setattr(worker, 'save_job', save)
    assert worker.process_job(SID, TOKEN, config)
    assert 'Synthetic spoken answer.' in save.call_args.args[3]
    db.rollback.assert_called_once()
    db.close.assert_called_once()


def test_cancelled_or_expired_job_never_opens_media_or_model(config, monkeypatch):
    db = Mock()
    monkeypatch.setattr(worker, 'open_session', lambda: db)
    monkeypatch.setattr(worker, 'read_job', lambda *a: None)
    monkeypatch.setattr(worker, 'load_model', lambda *a: pytest.fail('Ineligible job must not load a model'))
    assert worker.process_job(SID, TOKEN, config) is False


def test_decode_failure_preserves_recording_and_hides_exception_text(config, tmp_path, monkeypatch, capsys):
    root = tmp_path / 'media'; root.mkdir()
    (root / f'{SID}.webm').write_bytes(b'synthetic')
    monkeypatch.setenv('EXAM_VIDEO_DIR', str(root))
    db = Mock()
    monkeypatch.setattr(worker, 'open_session', lambda: db)
    monkeypatch.setattr(worker, 'read_job', lambda *a: {'total_bytes': 9})
    def broken_model(_):
        raise RuntimeError('synthetic-private-text-must-not-leak')
    monkeypatch.setattr(worker, 'load_model', broken_model)
    assert worker.process_job(SID, TOKEN, config) is False
    assert (root / f'{SID}.webm').read_bytes() == b'synthetic'
    sql, params = db.execute.call_args.args
    assert "transcript_status = 'failed'" in str(sql)
    assert 'synthetic-private' not in params['message']
    assert 'synthetic-private' not in capsys.readouterr().out


def test_timed_out_native_process_is_bounded_and_failure_is_saved(config, monkeypatch):
    db = Mock()
    monkeypatch.setattr(worker, 'open_session', lambda: db)
    monkeypatch.setattr(worker, 'claim_job', lambda *a: (SID, TOKEN))
    def timeout(command, **kwargs):
        assert kwargs['timeout'] == config.timeout
        assert kwargs['stdout'] == subprocess.DEVNULL and kwargs['stderr'] == subprocess.DEVNULL
        raise subprocess.TimeoutExpired(command, config.timeout)
    monkeypatch.setattr(worker.subprocess, 'run', timeout)
    assert worker.run_one(config)
    assert 'time limit' in db.execute.call_args.args[1]['message']


def test_retry_does_not_reset_completed_or_nonconsented_jobs():
    db = Mock()
    db.execute.return_value.rowcount = 2
    assert worker.retry_failed(db) == 2
    sql = str(db.execute.call_args.args[0])
    assert "v.transcript_status = 'failed'" in sql
    assert "s.recording_consent_status = 'consented'" in sql
    assert 'v.expires_at > clock_timestamp()' in sql
    assert 'NOT s.developer_demo' in sql
