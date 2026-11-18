"""Attach the existing worker recording volume to the backend. Dry-run by default.

Preserves the running backend's environment, image, command, ports and binds.
Only the backend is recreated. Private recovery files stay outside the checkout.
"""
import argparse
from dataclasses import dataclass
from datetime import date, datetime, time as day_time, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from uuid import uuid4


ROOT = '/var/lib/oral-exam/recordings'
DIR_KEY = 'EXAM_VIDEO_DIR'
DATE_KEY = 'EXAM_VIDEO_RETENTION_UNTIL'
BACKEND = 'cis-484-capstone-ai-proctor-backend-1'
WORKER = 'cis-484-capstone-ai-proctor-transcription-worker-1'

# Returns only a count and a fingerprint of non-content activity metadata.
# Student identities, questions and answers never leave the backend process.
SESSION_SNAPSHOT_CODE = """
import hashlib, json
from app.db import open_session
from sqlalchemy import text
db = open_session()
try:
    db.execute(text('SET TRANSACTION READ ONLY'))
    db.execute(text('SET LOCAL statement_timeout=5000'))
    rows = db.execute(text('''
        SELECT s.id, s.started_at, s.recording_consent_status,
               s.recording_consent_decided_at,
               q.questions, q.answered, q.last_question,
               a.actions, a.last_action, v.status AS video_status,
               v.next_chunk_index, v.updated_at AS video_updated_at
        FROM exam_sessions s
        LEFT JOIN LATERAL (
            SELECT count(*) AS questions,
                   count(*) FILTER (WHERE student_answer_transcript IS NOT NULL) AS answered,
                   max(created_at) AS last_question
            FROM interactions WHERE session_id = s.id
        ) q ON true
        LEFT JOIN LATERAL (
            SELECT count(*) AS actions, max(created_at) AS last_action
            FROM avatar_assistance_requests WHERE session_id = s.id
        ) a ON true
        LEFT JOIN exam_session_videos v ON v.session_id = s.id
        WHERE s.status = 'in_progress' AND NOT s.developer_demo
        ORDER BY s.id
    ''')).mappings().all()
    live = db.execute(text('''SELECT count(*) FROM exam_session_videos
        WHERE status = 'recording' AND updated_at > clock_timestamp() - interval '90 seconds'
    ''')).scalar_one()
    data = json.dumps([dict(row) for row in rows], sort_keys=True, default=str).encode('utf-8')
    print(json.dumps({'open': len(rows), 'fingerprint': hashlib.sha256(data).hexdigest(),
                      'active_recordings': int(live)}))
finally:
    db.rollback()
    db.close()
"""


class ActivationError(Exception):
    pass


def environment(container):
    values = {}
    for item in container['Config'].get('Env') or []:
        key, separator, value = item.partition('=')
        if not separator or key in values:
            raise ActivationError('The running environment needs manual inspection.')
        values[key] = value
    return values


def retention(value):
    try:
        deadline = (datetime.combine(date.fromisoformat(value), day_time.max, timezone.utc)
                    if len(value) == 10 else datetime.fromisoformat(value.replace('Z', '+00:00')))
        if deadline.tzinfo is None or deadline <= datetime.now(timezone.utc):
            raise ValueError
    except (ValueError, TypeError):
        raise ActivationError('Use a future YYYY-MM-DD date or an ISO timestamp with a timezone.') from None
    return value


def escaped(value):
    if isinstance(value, str):
        return value.replace('$', '$$')
    if isinstance(value, dict):
        return {key: escaped(item) for key, item in value.items()}
    if isinstance(value, list):
        return [escaped(item) for item in value]
    return value


def flow(value):
    return json.dumps(escaped(value), ensure_ascii=True, separators=(',', ':'))


def literal(value):
    return value.replace('$$', '$') if isinstance(value, str) else value


def port_rows(container):
    rows = []
    for name, bindings in (container['HostConfig'].get('PortBindings') or {}).items():
        target, protocol = name.split('/')
        for binding in bindings or []:
            row = {'target': int(target), 'published': str(binding['HostPort']), 'protocol': protocol}
            if binding.get('HostIp'):
                row['host_ip'] = binding['HostIp']
            rows.append(row)
    return sorted(rows, key=lambda item: json.dumps(item, sort_keys=True))


def mount_rows(container):
    rows = []
    for mount in container.get('Mounts') or []:
        if mount['Type'] != 'bind' or mount.get('Propagation', '') not in ('', 'rprivate'):
            raise ActivationError('The backend has a custom mount that needs manual inspection.')
        rows.append({'type': 'bind', 'source': mount['Source'], 'target': mount['Destination'],
                     'read_only': not mount['RW'], 'bind': {'create_host_path': False}})
    return rows


def safe_host_configuration(container):
    # This laptop currently uses a standard backend. Refuse custom host features
    # instead of silently dropping resource limits, devices or security options.
    host = container['HostConfig']
    for field in ('Privileged', 'ReadonlyRootfs', 'DeviceRequests', 'Devices', 'CapAdd', 'CapDrop',
                  'SecurityOpt', 'ExtraHosts', 'Dns', 'DnsSearch', 'DnsOptions', 'Tmpfs',
                  'Memory', 'NanoCpus', 'CpuShares', 'CpuQuota', 'CpuPeriod', 'CpusetCpus',
                  'Ulimits', 'Init', 'PublishAllPorts', 'VolumesFrom', 'Sysctls', 'Links', 'GroupAdd', 'PidMode'):
        if host.get(field):
            raise ActivationError('Custom backend host setting requires review: ' + field)
    if host.get('PidsLimit') not in (None, 0, -1):
        raise ActivationError('Custom backend process limits require review.')
    if host.get('IpcMode') not in (None, '', 'private'):
        raise ActivationError('Custom backend IPC settings require review.')
    if container['Config'].get('Healthcheck'):
        raise ActivationError('The backend has a custom health check that needs review.')


@dataclass
class Plan:
    repo: Path
    project: str
    before: dict
    worker: dict
    expected_env: dict
    volume: str
    network: str
    after_yaml: str
    before_yaml: str
    already_attached: bool


def compose_document(backend, project, network, volume, env, mounts):
    config, host = backend['Config'], backend['HostConfig']
    policy = host.get('RestartPolicy') or {'Name': 'no'}
    restart = policy.get('Name') or 'no'
    if restart == 'on-failure' and policy.get('MaximumRetryCount'):
        restart += ':' + str(policy['MaximumRetryCount'])
    aliases = backend['NetworkSettings']['Networks'][network].get('Aliases') or ['backend']
    lines = [
        'services:', '  backend:',
        '    image: ' + flow(backend['Image']),
        '    pull_policy: never',
        '    environment: !override ' + flow(env),
        '    volumes: !override ' + flow(mounts),
        '    ports: !override ' + flow(port_rows(backend)),
        '    command: ' + flow(config.get('Cmd') or []),
        '    entrypoint: ' + flow(config.get('Entrypoint') or []),
        '    working_dir: ' + flow(config.get('WorkingDir') or ''),
        '    user: ' + flow(config.get('User') or ''),
        '    restart: ' + flow(restart),
        '    logging: !override ' + flow({'driver': host.get('LogConfig', {}).get('Type') or 'json-file',
                                        'options': host.get('LogConfig', {}).get('Config') or {}}),
        '    networks: !override ' + flow({'default': {'aliases': aliases}}),
        'volumes:', '  exam_videos: !override ' + flow({'external': True, 'name': volume}),
        'networks:', '  default: !override ' + flow({'external': True, 'name': network}),
    ]
    return '\n'.join(lines) + '\n'


def make_plan(repo, backend, worker, base, retention_until=None):
    safe_host_configuration(backend)
    labels = backend['Config'].get('Labels') or {}
    project = labels.get('com.docker.compose.project')
    if (not project or project != base.get('name') or labels.get('com.docker.compose.service') != 'backend'
            or Path(labels.get('com.docker.compose.project.working_dir', '')).resolve() != repo.resolve()):
        raise ActivationError('The inspected backend does not match this checkout and Compose project.')
    if not backend['State']['Running'] or not worker['State']['Running']:
        raise ActivationError('The existing backend and speech worker must both be running for inspection.')
    if (worker['Config'].get('Labels') or {}).get('com.docker.compose.project') != project:
        raise ActivationError('The worker belongs to a different Compose project.')
    networks = backend['NetworkSettings']['Networks']
    if len(networks) != 1:
        raise ActivationError('Multiple backend networks need manual inspection.')
    network = next(iter(networks))
    if network not in worker['NetworkSettings']['Networks']:
        raise ActivationError('The worker and backend use different networks.')
    worker_env, original = environment(worker), environment(backend)
    if not original.get('DATABASE_URL') or original['DATABASE_URL'] != worker_env.get('DATABASE_URL'):
        raise ActivationError('The worker and backend database connections differ.')
    media = [item for item in worker['Mounts'] if item['Destination'] == ROOT]
    if len(media) != 1 or media[0]['Type'] != 'volume' or media[0]['RW']:
        raise ActivationError('The worker must have exactly one read-only named recording volume.')
    if worker_env.get(DIR_KEY) != ROOT:
        raise ActivationError('The worker recording directory differs from the reviewed configuration.')
    volume = media[0]['Name']
    forbidden = set(base['services']['backend']) - {
        'build', 'command', 'entrypoint', 'environment', 'depends_on', 'image', 'networks',
        'ports', 'volumes', 'pull_policy', 'restart', 'working_dir', 'user', 'logging',
    }
    if forbidden:
        raise ActivationError('New Compose backend options need review: ' + ', '.join(sorted(forbidden)))
    old_media = [item for item in backend['Mounts'] if item['Destination'] == ROOT]
    if old_media and (len(old_media) != 1 or old_media[0]['Type'] != 'volume' or old_media[0]['Name'] != volume):
        raise ActivationError('An existing different recording mount must not be hidden or replaced.')
    without_media = {**backend, 'Mounts': [item for item in backend['Mounts'] if item['Destination'] != ROOT]}
    old_mounts = mount_rows(without_media)
    rollback_mounts = list(old_mounts)
    if old_media:
        rollback_mounts.append({'type': 'volume', 'source': 'exam_videos', 'target': ROOT,
                                'read_only': not old_media[0]['RW']})
    new_mounts = old_mounts + [{'type': 'volume', 'source': 'exam_videos', 'target': ROOT, 'read_only': False}]
    desired = {**original, DIR_KEY: ROOT, DATE_KEY: original.get(DATE_KEY, '')}
    if retention_until is not None:
        desired[DATE_KEY] = retention(retention_until)
    attached = bool(old_media and old_media[0]['RW'] and original == desired)
    return Plan(repo, project, backend, worker, desired, volume, network,
                compose_document(backend, project, network, volume, desired, new_mounts),
                compose_document(backend, project, network, volume, original, rollback_mounts), attached)


def check_rendered(plan, rendered):
    service = rendered['services']['backend']
    env = {key: literal(value) for key, value in service['environment'].items()}
    if env != plan.expected_env:
        raise ActivationError('The candidate environment differs from the preserved running settings.')
    if service['image'] != plan.before['Image']:
        raise ActivationError('The candidate backend image changed.')
    if service.get('command', []) != (plan.before['Config'].get('Cmd') or []):
        raise ActivationError('The candidate backend command changed.')
    if service.get('entrypoint', []) != (plan.before['Config'].get('Entrypoint') or []):
        raise ActivationError('The candidate backend entrypoint changed.')
    if (service.get('working_dir', '') != (plan.before['Config'].get('WorkingDir') or '')
            or service.get('user', '') != (plan.before['Config'].get('User') or '')
            or set(service.get('networks', {})) != {'default'}):
        raise ActivationError('The candidate working directory, account or network changed.')
    ports = [{key: literal(item[key]) for key in ('target', 'published', 'protocol', 'host_ip') if item.get(key) is not None}
             for item in service.get('ports', [])]
    if sorted(ports, key=lambda item: json.dumps(item, sort_keys=True)) != port_rows(plan.before):
        raise ActivationError('The candidate backend port bindings changed.')
    media = [item for item in service['volumes'] if item['target'] == ROOT]
    if (len(media) != 1 or media[0].get('read_only', False) or media[0]['source'] != 'exam_videos'
            or rendered['volumes']['exam_videos'].get('name') != plan.volume
            or not rendered['volumes']['exam_videos'].get('external')
            or rendered['networks']['default'].get('name') != plan.network
            or not rendered['networks']['default'].get('external')):
        raise ActivationError('The candidate recording volume or existing network is incorrect.')
    original_binds = {(item['Source'].replace('\\', '/').lower(), item['Destination'], not item['RW'])
                      for item in plan.before['Mounts'] if item['Destination'] != ROOT}
    candidate_binds = {(literal(item['source']).replace('\\', '/').lower(), item['target'], item.get('read_only', False))
                       for item in service['volumes'] if item['target'] != ROOT}
    if original_binds != candidate_binds:
        raise ActivationError('The candidate must preserve every existing backend bind mount.')


class Docker:
    def __init__(self, repo):
        self.repo = repo

    def run(self, args, *, data=None, timeout=20):
        try:
            result = subprocess.run(['docker', *args], cwd=self.repo, input=data, text=True,
                                    encoding='utf-8', capture_output=True, timeout=timeout)
        except (OSError, subprocess.TimeoutExpired):
            raise ActivationError('A Docker inspection or activation step could not complete.') from None
        if result.returncode:
            # Compose errors can include environment values; never echo them.
            raise ActivationError('A Docker step failed. Private configuration was not printed.')
        return result.stdout

    def inspect(self, name):
        values = json.loads(self.run(['inspect', name]))
        if len(values) != 1:
            raise ActivationError('Container inspection did not return exactly one container.')
        return values[0]

    def compose(self, project=None, override=None):
        args = ['compose']
        if project:
            args += ['-p', project]
        args += ['--project-directory', str(self.repo), '-f', str(self.repo / 'docker-compose.yml')]
        if override:
            args += ['-f', str(override)]
        return args

    def session_snapshot(self):
        return json.loads(self.run(['exec', BACKEND, 'python', '-c', SESSION_SNAPSHOT_CODE]))

    def healthy(self):
        code = "import urllib.request; r=urllib.request.urlopen('http://127.0.0.1:8000/health/db',timeout=2); assert r.status==200; print('ok')"
        try:
            return self.run(['exec', BACKEND, 'python', '-c', code], timeout=5).strip() == 'ok'
        except ActivationError:
            return False

    def unmounted_recordings(self, backend):
        roots = {ROOT, environment(backend).get(DIR_KEY, ROOT)}
        persistent = [item['Destination'].rstrip('/') for item in backend['Mounts']]
        roots = [root for root in roots if root.startswith('/')
                 and not any(root == target or root.startswith(target + '/') for target in persistent)]
        code = ("import json; from pathlib import Path; roots=" + repr(roots) + "; "
                "print(json.dumps({'found':any(Path(r).is_dir() and any(Path(r).iterdir()) for r in roots)}))")
        return bool(json.loads(self.run(['exec', BACKEND, 'python', '-c', code]))['found'])


def private_write(path, data):
    for part in (path, *path.parents):
        if part.is_symlink() or (hasattr(part, 'is_junction') and part.is_junction()):
            raise ActivationError('Private recovery storage contains a link or junction.')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)


def update_retention_setting(before, value):
    content = before.decode('utf-8-sig')
    pattern = r'(?m)^[ \t]*(?:export[ \t]+)?EXAM_VIDEO_RETENTION_UNTIL[ \t]*=[^\r\n]*'
    if len(re.findall(pattern, content)) > 1:
        raise ActivationError('Resolve duplicate private retention settings before activation.')
    line = DATE_KEY + "='" + value + "'"
    if re.search(pattern, content):
        content = re.sub(pattern, lambda _: line, content)
    else:
        content = content.rstrip('\r\n') + '\n' + line + '\n'
    return content.encode('utf-8')


def verify_running(plan, actual):
    if not actual['State']['Running'] or actual['Image'] != plan.before['Image']:
        raise ActivationError('The new backend is not running with the preserved image.')
    if environment(actual) != plan.expected_env or port_rows(actual) != port_rows(plan.before):
        raise ActivationError('The new backend did not preserve the required settings and ports.')
    config = actual['Config']
    for field in ('Cmd', 'Entrypoint', 'WorkingDir', 'User'):
        if (config.get(field) or []) != (plan.before['Config'].get(field) or []):
            raise ActivationError('The new backend command or process settings changed.')
    expected = {(item['Type'], item.get('Name') if item['Type'] == 'volume' else item['Source'], item['Destination'], item['RW'])
                for item in plan.before['Mounts'] if item['Destination'] != ROOT}
    expected.add(('volume', plan.volume, ROOT, True))
    observed = {(item['Type'], item.get('Name') if item['Type'] == 'volume' else item['Source'], item['Destination'], item['RW'])
                for item in actual['Mounts']}
    if expected != observed or set(actual['NetworkSettings']['Networks']) != {plan.network}:
        raise ActivationError('The new backend mounts or network differ from the reviewed plan.')


def activate(plan, docker, backup_dir, retention_until=None, *, maintenance_window=False,
             expected_open_sessions=None):
    if backup_dir.resolve().is_relative_to(plan.repo.resolve()):
        raise ActivationError('Private recovery files must be outside the Git checkout.')
    initial = docker.session_snapshot()
    if initial['active_recordings']:
        raise ActivationError('A recording upload is still active. Wait until it finishes before restarting the backend.')
    if initial['open'] and not maintenance_window:
        raise ActivationError('An assessed exam session is still in progress. Finish it before recreating the backend.')
    if maintenance_window:
        if expected_open_sessions is None or expected_open_sessions < 0:
            raise ActivationError('An explicit maintenance window requires the expected number of saved open attempts.')
        if initial['open'] != expected_open_sessions:
            raise ActivationError('The saved open-attempt count changed. Inspect it before choosing a maintenance window.')
        print('Explicit maintenance window: preserving ' + str(initial['open']) + ' saved open attempts without changing their records.')
    if docker.unmounted_recordings(plan.before):
        raise ActivationError('Existing recordings in the container layer need migration before backend recreation.')
    if (docker.inspect(BACKEND)['Id'] != plan.before['Id'] or docker.inspect(WORKER)['Id'] != plan.worker['Id']):
        raise ActivationError('A container changed during inspection. Run the check again.')
    image = json.loads(docker.run(['image', 'inspect', plan.before['Config']['Image']]))
    if len(image) != 1 or image[0]['Id'] != plan.before['Image']:
        raise ActivationError('The existing backend image tag changed. No rebuild or download was attempted.')
    if plan.already_attached:
        print('The backend already has the reviewed recording mount and environment.')
        return
    folder = backup_dir / ('kay_storage_' + datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S') + '_' + uuid4().hex)
    folder.mkdir(parents=True)
    before_file, after_file = folder / 'before.yaml', folder / 'recording.yaml'
    private_write(before_file, plan.before_yaml.encode('utf-8'))
    private_write(after_file, plan.after_yaml.encode('utf-8'))
    private_write(folder / 'backend-before.json', json.dumps(plan.before, ensure_ascii=True).encode('utf-8'))
    if maintenance_window:
        private_write(folder / 'maintenance-window.json', json.dumps(initial, sort_keys=True).encode('utf-8'))
    env_file = plan.repo / '.env'
    env_before = env_file.read_bytes()
    env_after = update_retention_setting(env_before, retention_until) if retention_until else env_before
    private_write(folder / 'env-before.env', env_before)
    print('Preserved the existing backend configuration outside Git: ' + str(folder))
    written_env = False
    attempted = False
    try:
        if retention_until:
            if env_file.read_bytes() != env_before:
                raise ActivationError('The private settings changed during inspection; they were not overwritten.')
            temporary = plan.repo / ('.env.kay-storage-' + uuid4().hex + '.tmp')
            private_write(temporary, env_after)
            try:
                os.replace(temporary, env_file)
                written_env = True
            finally:
                temporary.unlink(missing_ok=True)
        current = docker.session_snapshot()
        if current['active_recordings'] or current != initial:
            raise ActivationError('Exam activity changed during preparation. The backend was not restarted.')
        attempted = True
        print('Recreating only the backend with its existing image and the shared recording mount.')
        docker.run(docker.compose(plan.project, after_file) +
                   ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'backend'], timeout=45)
        deadline = time.monotonic() + 40
        while not docker.healthy():
            if time.monotonic() >= deadline:
                raise ActivationError('The backend did not regain database health within the verification window.')
            time.sleep(1)
        verify_running(plan, docker.inspect(BACKEND))
        if docker.inspect(WORKER)['Id'] != plan.worker['Id']:
            raise ActivationError('The speech worker changed during activation.')
        probe = 'cybros_storage_probe_' + uuid4().hex + '.tmp'
        create = ("import os; from pathlib import Path; from app.exam_video import _recording_root; "
                  "p=_recording_root()/" + repr(probe) + "; f=p.open('xb'); f.write(b'cybros-synthetic-storage-probe'); f.close()")
        try:
            docker.run(['exec', BACKEND, 'python', '-c', create])
            check = "from pathlib import Path; assert (Path(" + repr(ROOT) + ")/" + repr(probe) + ").read_bytes()==b'cybros-synthetic-storage-probe'; print('shared storage verified')"
            docker.run(['exec', WORKER, 'python', '-c', check])
        finally:
            remove = "from pathlib import Path; (Path(" + repr(ROOT) + ")/" + repr(probe) + ").unlink(missing_ok=True)"
            docker.run(['exec', BACKEND, 'python', '-c', remove])
        print('Backend database health, preserved settings and shared recording-volume access verified.')
        if plan.expected_env[DATE_KEY]:
            print('Recording retention is configured. A live synthetic consent/recording/submission test remains.')
        else:
            print('The recording mount is ready. Capture remains disabled until an expiry date is configured.')
    except Exception:
        if written_env and env_file.read_bytes() == env_after:
            env_file.write_bytes(env_before)
        if attempted:
            print('Verification failed; restoring the prior backend configuration.')
            try:
                docker.run(docker.compose(plan.project, before_file) +
                           ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'backend'], timeout=45)
                print('Prior backend configuration restored. Existing recording/database volumes were preserved.')
            except Exception:
                raise ActivationError('Automatic backend restoration did not complete. The private rollback configuration is saved in the reported folder.') from None
        raise ActivationError('Recording activation did not complete; inspect the reported recovery folder locally.') from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--backup-dir', type=Path, default=Path.home() / 'CYBROS-backups')
    parser.add_argument('--retention-until')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--maintenance-window', action='store_true',
                        help='Operator confirms no one is taking an exam; keep all saved attempts unchanged.')
    parser.add_argument('--expected-open-sessions', type=int)
    args = parser.parse_args()
    if args.maintenance_window and (args.expected_open_sessions is None or args.expected_open_sessions < 0):
        parser.error('--maintenance-window requires a nonnegative --expected-open-sessions count')
    if not args.maintenance_window and args.expected_open_sessions is not None:
        parser.error('--expected-open-sessions requires --maintenance-window')
    repo = args.repo.resolve()
    try:
        docker = Docker(repo)
        version = re.search(r'(\d+)\.(\d+)\.(\d+)', docker.run(['compose', 'version', '--short']))
        if not version or tuple(map(int, version.groups())) < (2, 24, 4):
            raise ActivationError('Compose 2.24.4 or later is required for precise configuration replacement.')
        backend, worker = docker.inspect(BACKEND), docker.inspect(WORKER)
        base = json.loads(docker.run(docker.compose() + ['config', '--format', 'json']))
        plan = make_plan(repo, backend, worker, base, args.retention_until)
        rendered = json.loads(docker.run(docker.compose(plan.project, '-') + ['config', '--format', 'json'], data=plan.after_yaml))
        check_rendered(plan, rendered)
        volume = json.loads(docker.run(['volume', 'inspect', plan.volume]))
        if len(volume) != 1 or volume[0]['Name'] != plan.volume:
            raise ActivationError('The existing worker recording volume was not found.')
        print('Verified the backend project, preserved runtime settings and existing worker recording volume.')
        if not args.apply:
            print('Read-only check complete. Add --apply to recreate only the backend; no image build, model download or SQL migration is required.')
            return 0
        activate(plan, docker, args.backup_dir.resolve(), args.retention_until,
                 maintenance_window=args.maintenance_window, expected_open_sessions=args.expected_open_sessions)
        return 0
    except ActivationError as error:
        print(str(error), file=sys.stderr)
        return 1
    except Exception:
        print('Recording storage inspection stopped. No private configuration was printed; check the local container configuration.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
