"""Synthetic activation/rollback tests. No live containers or application DB."""
import copy
from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location('recording_storage_activation', Path(__file__).resolve().parents[1] / 'scripts/activate_recording_storage.py')
module = importlib.util.module_from_spec(SPEC)
import sys
sys.modules[SPEC.name] = module
SPEC.loader.exec_module(module)


def fixture(repo):
    project = 'synthetic-storage'
    backend = {
        'Id': 'synthetic-old-backend', 'Image': 'sha256:synthetic-image', 'State': {'Running': True},
        'Config': {'Image': 'synthetic-backend:local', 'Cmd': ['uvicorn', 'app.main:app', '--reload'],
                   'Entrypoint': None, 'WorkingDir': '/app', 'User': '',
                   'Env': ['DATABASE_URL=postgresql://synthetic:NOT_A_SECRET$test@db/examdb',
                           'AUTH_SECRET_KEY=synthetic-auth-secret', 'OLLAMA_MODEL=synthetic-preserved-model'],
                   'Labels': {'com.docker.compose.project': project, 'com.docker.compose.service': 'backend',
                              'com.docker.compose.project.working_dir': str(repo)}},
        'HostConfig': {'PortBindings': {'8000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '18000'}]},
                       'RestartPolicy': {'Name': 'unless-stopped'}, 'LogConfig': {'Type': 'json-file', 'Config': {}}},
        'Mounts': [{'Type': 'bind', 'Source': str(repo / 'backend/app'), 'Destination': '/app/app',
                    'RW': True, 'Propagation': 'rprivate'}],
        'NetworkSettings': {'Networks': {project + '_default': {'Aliases': ['backend', 'synthetic-backend-1']}}},
    }
    worker = {'Id': 'synthetic-existing-worker', 'State': {'Running': True},
              'Config': {'Env': [backend['Config']['Env'][0], 'EXAM_VIDEO_DIR=' + module.ROOT],
                         'Labels': {'com.docker.compose.project': project}},
              'Mounts': [{'Type': 'volume', 'Name': project + '_exam_videos', 'Destination': module.ROOT, 'RW': False}],
              'NetworkSettings': {'Networks': {project + '_default': {}}}}
    base = {'name': project, 'services': {'backend': {'environment': {}, 'volumes': [], 'ports': []}}}
    return backend, worker, base


class FakeDocker:
    def __init__(self, plan):
        self.plan = plan
        self.calls = []
        self.open_sessions = 0
        self.layer_media = False
        self.fail_probe = False
        self.changed_tag = False
        self.recreated = False
        self.restored = False
        self.active_recordings = 0
        self.snapshots = None

    def session_snapshot(self):
        if self.snapshots is not None:
            return self.snapshots.pop(0)
        return {'open': self.open_sessions, 'fingerprint': 'synthetic-session-fingerprint',
                'active_recordings': self.active_recordings}
    def unmounted_recordings(self, _): return self.layer_media
    def healthy(self): return True
    def compose(self, project, override): return ['compose', '-p', project, '-f', str(override)]

    def inspect(self, name):
        if name == module.WORKER:
            return self.plan.worker
        actual = copy.deepcopy(self.plan.before)
        if self.recreated and not self.restored:
            actual['Id'] = 'synthetic-new-backend'
            actual['Config']['Env'] = [key + '=' + value for key, value in self.plan.expected_env.items()]
            actual['Mounts'] = [row for row in actual['Mounts'] if row['Destination'] != module.ROOT]
            actual['Mounts'].append({'Type': 'volume', 'Name': self.plan.volume, 'Destination': module.ROOT, 'RW': True})
        return actual

    def run(self, args, **kwargs):
        self.calls.append(args)
        if args[:2] == ['image', 'inspect']:
            return json.dumps([{'Id': 'sha256:other-image' if self.changed_tag else self.plan.before['Image']}])
        if 'up' in args:
            if any(str(item).endswith('before.yaml') for item in args):
                self.restored = True
            else:
                self.recreated = True
        if self.fail_probe and args[:2] == ['exec', module.WORKER]:
            raise module.ActivationError('Synthetic probe failure')
        return 'synthetic success'


class StorageActivationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / 'repo'
        (self.repo / 'backend/app').mkdir(parents=True)
        self.env_before = b'OTHER=synthetic$setting\nEXAM_VIDEO_RETENTION_UNTIL=\n'
        (self.repo / '.env').write_bytes(self.env_before)
        self.backend, self.worker, self.base = fixture(self.repo)
        self.plan = module.make_plan(self.repo, self.backend, self.worker, self.base)

    def test_plan_preserves_secrets_model_ports_and_existing_binds(self):
        env = self.plan.expected_env
        self.assertEqual(env['AUTH_SECRET_KEY'], 'synthetic-auth-secret')
        self.assertEqual(env['OLLAMA_MODEL'], 'synthetic-preserved-model')
        self.assertEqual(env[module.DATE_KEY], '')
        self.assertIn('NOT_A_SECRET$$test', self.plan.after_yaml)
        self.assertIn('!override', self.plan.after_yaml)
        self.assertIn('"published":"18000"', self.plan.after_yaml)
        self.assertEqual(self.plan.volume, 'synthetic-storage_exam_videos')

    def test_different_database_connections_are_rejected(self):
        self.worker['Config']['Env'][0] = 'DATABASE_URL=synthetic-other'
        with self.assertRaisesRegex(module.ActivationError, 'connections differ'):
            module.make_plan(self.repo, self.backend, self.worker, self.base)

    def test_different_existing_recording_volume_cannot_be_hidden(self):
        self.backend['Mounts'].append({'Type': 'volume', 'Name': 'synthetic-other-media', 'Destination': module.ROOT, 'RW': True})
        with self.assertRaisesRegex(module.ActivationError, 'must not be hidden'):
            module.make_plan(self.repo, self.backend, self.worker, self.base)

    def test_custom_memory_limits_are_not_silently_discarded(self):
        self.backend['HostConfig']['Memory'] = 512 * 1024 * 1024
        with self.assertRaisesRegex(module.ActivationError, 'Memory'):
            module.make_plan(self.repo, self.backend, self.worker, self.base)

    def test_expired_or_timezone_free_retention_is_rejected(self):
        for value in ['2000-01-01', '2099-01-01T12:00:00', 'not-a-date']:
            with self.subTest(value=value), self.assertRaises(module.ActivationError):
                module.retention(value)

    def test_existing_private_settings_and_literal_dollars_are_preserved(self):
        actual = module.update_retention_setting(self.env_before, '2099-01-01')
        self.assertIn(b'OTHER=synthetic$setting\n', actual)
        self.assertIn(b"EXAM_VIDEO_RETENTION_UNTIL='2099-01-01'", actual)
        with self.assertRaises(module.ActivationError):
            module.update_retention_setting(b'EXAM_VIDEO_RETENTION_UNTIL=\nEXAM_VIDEO_RETENTION_UNTIL=\n', '2099-01-01')

    def test_open_exam_prevents_any_restart_or_private_file_write(self):
        docker = FakeDocker(self.plan)
        docker.open_sessions = 1
        backup = self.root / 'backups'
        with self.assertRaisesRegex(module.ActivationError, 'still in progress'):
            module.activate(self.plan, docker, backup)
        self.assertFalse(backup.exists())
        self.assertFalse(docker.calls)

    def test_unmounted_recordings_prevent_recreation(self):
        docker = FakeDocker(self.plan)
        docker.layer_media = True
        with self.assertRaisesRegex(module.ActivationError, 'need migration'):
            module.activate(self.plan, docker, self.root / 'backups')
        self.assertFalse(docker.recreated)

    def test_changed_local_image_tag_stops_before_recreation(self):
        docker = FakeDocker(self.plan)
        docker.changed_tag = True
        with self.assertRaisesRegex(module.ActivationError, 'tag changed'):
            module.activate(self.plan, docker, self.root / 'backups')
        self.assertFalse(docker.recreated)

    def test_private_backups_cannot_be_written_inside_the_checkout(self):
        with self.assertRaisesRegex(module.ActivationError, 'outside the Git checkout'):
            module.activate(self.plan, FakeDocker(self.plan), self.repo / 'private-backups')

    def test_success_recreates_only_backend_without_build_or_pull(self):
        docker = FakeDocker(self.plan)
        output = io.StringIO()
        with redirect_stdout(output):
            module.activate(self.plan, docker, self.root / 'backups')
        self.assertTrue(docker.recreated)
        self.assertFalse(docker.restored)
        calls = [args for args in docker.calls if 'up' in args]
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][-1], 'backend')
        for option in ['--no-build', '--no-deps', '--pull']:
            self.assertIn(option, calls[0])
        self.assertIn('never', calls[0])
        self.assertNotIn('synthetic-auth-secret', output.getvalue())
        self.assertEqual((self.repo / '.env').read_bytes(), self.env_before)

    def test_failed_shared_probe_restores_prior_backend_and_private_env(self):
        plan = module.make_plan(self.repo, self.backend, self.worker, self.base, '2099-01-01')
        docker = FakeDocker(plan)
        docker.fail_probe = True
        with redirect_stdout(io.StringIO()), self.assertRaises(module.ActivationError):
            module.activate(plan, docker, self.root / 'backups', '2099-01-01')
        self.assertTrue(docker.restored)
        self.assertEqual((self.repo / '.env').read_bytes(), self.env_before)
        self.assertEqual(len(list((self.root / 'backups').glob('*/before.yaml'))), 1)

    def test_valid_existing_mount_is_idempotent(self):
        self.backend['Config']['Env'] += ['EXAM_VIDEO_DIR=' + module.ROOT, 'EXAM_VIDEO_RETENTION_UNTIL=']
        self.backend['Mounts'].append({'Type': 'volume', 'Name': self.plan.volume, 'Destination': module.ROOT, 'RW': True})
        plan = module.make_plan(self.repo, self.backend, self.worker, self.base)
        self.assertTrue(plan.already_attached)
        docker = FakeDocker(plan)
        with redirect_stdout(io.StringIO()):
            module.activate(plan, docker, self.root / 'backups')
        self.assertFalse(docker.recreated)

    def test_explicit_maintenance_keeps_six_open_attempts_unchanged(self):
        docker = FakeDocker(self.plan)
        docker.open_sessions = 6
        with redirect_stdout(io.StringIO()):
            module.activate(self.plan, docker, self.root / 'backups',
                            maintenance_window=True, expected_open_sessions=6)
        self.assertTrue(docker.recreated)
        self.assertEqual(docker.open_sessions, 6)
        self.assertEqual((self.repo / '.env').read_bytes(), self.env_before)

    def test_maintenance_requires_an_explicit_expected_count(self):
        docker = FakeDocker(self.plan)
        docker.open_sessions = 6
        with self.assertRaisesRegex(module.ActivationError, 'expected number'):
            module.activate(self.plan, docker, self.root / 'backups', maintenance_window=True)
        self.assertFalse(docker.recreated)

    def test_changed_open_count_prevents_maintenance_restart(self):
        docker = FakeDocker(self.plan)
        docker.open_sessions = 7
        with self.assertRaisesRegex(module.ActivationError, 'count changed'):
            module.activate(self.plan, docker, self.root / 'backups',
                            maintenance_window=True, expected_open_sessions=6)
        self.assertFalse(docker.recreated)

    def test_new_activity_with_the_same_count_blocks_restart(self):
        docker = FakeDocker(self.plan)
        docker.snapshots = [
            {'open': 6, 'fingerprint': 'synthetic-before', 'active_recordings': 0},
            {'open': 6, 'fingerprint': 'synthetic-new-question', 'active_recordings': 0},
        ]
        with redirect_stdout(io.StringIO()), self.assertRaises(module.ActivationError):
            module.activate(self.plan, docker, self.root / 'backups',
                            maintenance_window=True, expected_open_sessions=6)
        self.assertFalse(docker.recreated)

    def test_active_recording_blocks_even_an_explicit_maintenance_window(self):
        docker = FakeDocker(self.plan)
        docker.open_sessions = 6
        docker.active_recordings = 1
        with self.assertRaisesRegex(module.ActivationError, 'recording upload'):
            module.activate(self.plan, docker, self.root / 'backups',
                            maintenance_window=True, expected_open_sessions=6)
        self.assertFalse(docker.recreated)

    def test_submitted_session_upload_blocks_normal_restart(self):
        docker = FakeDocker(self.plan)
        docker.open_sessions = 0
        docker.active_recordings = 1
        with self.assertRaisesRegex(module.ActivationError, 'recording upload'):
            module.activate(self.plan, docker, self.root / 'backups')
        self.assertFalse(docker.recreated)

    def test_snapshot_is_read_only_hides_identifiers_and_tracks_activity(self):
        from types import ModuleType
        from unittest.mock import Mock
        app = ModuleType('app'); app.__path__ = []
        db_module = ModuleType('app.db')
        db = Mock()
        rows = [{'id': 'synthetic-private-session-id', 'questions': 1, 'answered': 0}]
        db.execute.return_value.mappings.return_value.all.side_effect = lambda: copy.deepcopy(rows)
        db.execute.return_value.scalar_one.return_value = 0
        db_module.open_session = lambda: db
        app.db = db_module
        snapshots = []
        with patch.dict(sys.modules, {'app': app, 'app.db': db_module}):
            for answered in [0, 1]:
                rows[0]['answered'] = answered
                output = io.StringIO()
                with redirect_stdout(output):
                    exec(compile(module.SESSION_SNAPSHOT_CODE, '<synthetic-snapshot>', 'exec'), {})
                self.assertNotIn('synthetic-private-session-id', output.getvalue())
                snapshots.append(json.loads(output.getvalue()))
        self.assertEqual(snapshots[0]['open'], 1)
        self.assertNotEqual(snapshots[0]['fingerprint'], snapshots[1]['fingerprint'])
        for call in db.execute.call_args_list:
            self.assertIn(str(call.args[0]).strip().split()[0].upper(), ['SET', 'SELECT'])
        self.assertEqual(db.rollback.call_count, 2)
        self.assertEqual(db.close.call_count, 2)

    def test_real_compose_parser_preserves_dollars_and_replaces_added_mounts(self):
        # Config parsing is local: it does not contact Docker Engine or start a container.
        try:
            version = subprocess.run(['docker', 'compose', 'version', '--short'], capture_output=True, timeout=10)
        except OSError:
            self.skipTest('Docker Compose CLI is not installed.')
        if version.returncode:
            self.skipTest('Docker Compose CLI is not available.')
        base = {'name': 'synthetic-storage', 'services': {'backend': {
            'image': 'synthetic-backend:local', 'environment': {'AUTH_SECRET_KEY': 'synthetic-base-wrong'},
            'volumes': [{'type': 'bind', 'source': str(self.repo / 'unwanted-models'), 'target': '/models'}],
            'ports': ['19000:8000']}}, 'volumes': {'exam_videos': {}}, 'networks': {'default': {}}}
        base_path = self.repo / 'synthetic-compose.json'
        base_path.write_text(json.dumps(base), encoding='utf-8')
        result = subprocess.run(['docker', 'compose', '-f', str(base_path), '-f', '-', 'config', '--format', 'json'],
                                input=self.plan.after_yaml, encoding='utf-8', capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, 'Synthetic Compose rendering failed: ' + result.stderr)
        rendered = json.loads(result.stdout)
        module.check_rendered(self.plan, rendered)
        self.assertNotIn('/models', [item['target'] for item in rendered['services']['backend']['volumes']])
        rendered['services']['backend']['environment']['AUTH_SECRET_KEY'] = 'synthetic-wrong'
        with self.assertRaisesRegex(module.ActivationError, 'environment differs'):
            module.check_rendered(self.plan, rendered)


if __name__ == '__main__':
    unittest.main()
