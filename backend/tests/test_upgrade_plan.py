"""Safety boundaries of the offline maintenance plan; starts nothing."""
import importlib.util
from pathlib import Path
import sys
import json
import os
from threading import Thread, Event
import pytest

scripts = Path(__file__).parents[2] / 'scripts'
spec = importlib.util.spec_from_file_location('p3_upgrade_under_test', scripts/'validate_p3_upgrade.py')
sys.path.insert(0, str(scripts))
try:
    upgrade = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(upgrade)
finally:
    sys.path.remove(str(scripts))


def test_default_plan_never_reads_secrets_starts_database_or_connects(monkeypatch, capsys):
    def forbidden(*args, **kwargs): pytest.fail('A plan must not touch runtime configuration or services')
    monkeypatch.setattr(upgrade.local, 'load', forbidden)
    monkeypatch.setattr(upgrade.local, 'start_db', forbidden)
    monkeypatch.setattr(upgrade, 'create_engine', forbidden)
    assert upgrade.run('plan') == 0
    assert '"starts_services": false' in capsys.readouterr().out
    assert len(upgrade.plan()['new_migrations']) == 7
    assert 'migrations/021_automatic_oral_transcripts.sql' in upgrade.plan()['new_migrations']


@pytest.mark.parametrize('name', ['cybros_p3', 'postgres', 'cybros_validation_', 'cybros_validation_abc;DROP DATABASE postgres',
                                 '../cybros_validation_abcdef12', 'cybros_validation_UPPERCASE'])
def test_existing_and_unsafe_database_names_cannot_be_drop_targets(name):
    with pytest.raises(ValueError): upgrade.validation_name(name)


def test_maintenance_refuses_running_application_without_stopping_it(monkeypatch):
    monkeypatch.setattr(upgrade.local, 'port_open', lambda port: port == 8000)
    monkeypatch.setattr(upgrade.local, 'load', lambda: pytest.fail('Refuse before reading private settings'))
    with pytest.raises(RuntimeError, match='before database maintenance'):
        upgrade.run('validate')


def _fake_private_configuration(monkeypatch, tmp_path):
    monkeypatch.setattr(upgrade.local, 'DATA', tmp_path)
    monkeypatch.setattr(upgrade.local, 'load', lambda: {})
    monkeypatch.setattr(upgrade.local, 'environment', lambda cfg: {
        'DATABASE_URL': 'postgresql+psycopg2://proctor:synthetic-test-only@127.0.0.1:55432/cybros_p3'})
    monkeypatch.setattr(upgrade.local, 'port_open', lambda port: False)


def test_failed_database_start_does_not_authorize_stop(monkeypatch, tmp_path):
    _fake_private_configuration(monkeypatch, tmp_path)
    monkeypatch.setattr(upgrade.local, 'pg_running', lambda cfg: False)
    commands = []
    def command(args, *a, **k):
        commands.append(str(args[-1]))
        raise RuntimeError('Synthetic start failure')
    monkeypatch.setattr(upgrade.local, 'run', command)
    monkeypatch.setattr(upgrade, 'create_engine', lambda *a, **k: pytest.fail('No DB connection after failed start'))
    assert upgrade.run('validate') == 1
    assert commands == ['start']
    report = json.loads(next(tmp_path.rglob('validation.json')).read_text())
    assert report['status'] == 'failed' and report['source_applied'] == []
    assert not report.get('owned_database_stopped', False)


def test_preexisting_database_is_not_stopped_on_validation_failure(monkeypatch, tmp_path):
    _fake_private_configuration(monkeypatch, tmp_path)
    monkeypatch.setattr(upgrade.local, 'pg_running', lambda cfg: True)
    monkeypatch.setattr(upgrade.local, 'run', lambda *a, **k: pytest.fail('Existing database lifecycle must remain untouched'))
    def fail_connect(*a, **k): raise RuntimeError('Synthetic connection failure')
    monkeypatch.setattr(upgrade, 'create_engine', fail_connect)
    assert upgrade.run('validate') == 1
    report = json.loads(next(tmp_path.rglob('validation.json')).read_text())
    assert not report.get('owned_database_stopped', False)


@pytest.mark.skipif(os.name != 'nt', reason='Native P3 Windows lifecycle mutex')
def test_native_lifecycle_mutex_excludes_another_thread_and_releases_after_exit(monkeypatch, tmp_path):
    monkeypatch.setattr(upgrade.local, 'ROOT', tmp_path)
    entered, release = Event(), Event()
    def hold():
        with upgrade.local.lifecycle_lock():
            entered.set()
            release.wait(timeout=5)
    worker = Thread(target=hold)
    worker.start()
    try:
        assert entered.wait(timeout=3)
        with pytest.raises(RuntimeError, match='operation is running'):
            with upgrade.local.lifecycle_lock():
                pytest.fail('A second operation must not enter')
    finally:
        release.set(); worker.join(timeout=5)
    assert not worker.is_alive()
    with upgrade.local.lifecycle_lock():
        pass


def test_cleanup_failure_is_explicit_even_after_an_earlier_validation_error(monkeypatch, tmp_path, capsys):
    _fake_private_configuration(monkeypatch, tmp_path)
    monkeypatch.setattr(upgrade.local, 'pg_running', lambda cfg: False)
    commands = []
    def command(args, *a, **k):
        commands.append(str(args[-1]))
        if str(args[-1]) == 'stop': raise RuntimeError('Synthetic stop failure')
    monkeypatch.setattr(upgrade.local, 'run', command)
    def fail_connect(*a, **k): raise RuntimeError('Synthetic validation error')
    monkeypatch.setattr(upgrade, 'create_engine', fail_connect)
    assert upgrade.run('validate') == 1
    report = json.loads(next(tmp_path.rglob('validation.json')).read_text())
    assert commands == ['start', 'stop']
    assert report['status'] == 'cleanup_failed'
    assert report['cleanup_failures'] == ['owned_database_stop']
    assert 'cleanup_failures' in capsys.readouterr().out
