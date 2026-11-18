"""Owned P3 restart/persistence checks; explicit run only after local authorization.

Reads protected synthetic credentials internally. No real exam publication or media.
"""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time

import httpx
from sqlalchemy import create_engine, text

import cybros_local as local


def run(*, validate_restore=False, failure_ui=False):
    root = local.DATA / 'verification' / ('lifecycle_' + datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S'))
    root.mkdir(parents=True, exist_ok=False, mode=0o700)
    report = {'started_at': datetime.now(timezone.utc).isoformat(), 'checks': [], 'status': 'running'}
    exam_id = None
    cfg = local.load()
    environment = local.environment(cfg)
    accounts = json.loads((local.DATA/'local-accounts.json').read_text())
    professor = accounts['professor']

    def check(condition, label):
        report['checks'].append({'name': label, 'passed': bool(condition)})
        if not condition: raise RuntimeError(label + ' failed')

    def command(arguments, label):
        start = time.monotonic()
        result = subprocess.run([str(arg) for arg in arguments], cwd=local.ROOT, env=environment,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
            creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0), timeout=180)
        (root/(label+'.log')).write_bytes(result.stdout)
        report[label+'_seconds'] = round(time.monotonic()-start, 3)
        check(result.returncode == 0, label)

    def no_active_attempts():
        engine = create_engine(environment['DATABASE_URL'], hide_parameters=True)
        try:
            with engine.connect() as connection:
                count = connection.execute(text("SELECT count(*) FROM exam_sessions WHERE status='in_progress'")).scalar_one()
            check(count == 0, 'No active assessed attempt before controlled lifecycle check')
        finally: engine.dispose()

    def ready(client):
        check(client.get('/health/ready').status_code == 200, 'Backend schema readiness')
        check(httpx.get('http://127.0.0.1:5173/api/health/ready', timeout=10).status_code == 200, 'Frontend API proxy readiness')

    try:
        no_active_attempts()
        with httpx.Client(base_url='http://127.0.0.1:8000', timeout=15, trust_env=False) as client:
            ready(client)
            response = client.post('/auth/login', json={'username':professor['username'],'password':professor['password']})
            check(response.status_code == 200, 'Actual synthetic professor login')
            check(client.get('/auth/me').json().get('role') == 'professor', 'Actual authenticated professor role')
            created = client.post('/exam/templates', json={'title':'Synthetic lifecycle '+secrets.token_hex(4),
                'course':'Synthetic validation only', 'description':'Unpublished scratch exam; no student/media use.'})
            check(created.status_code == 201, 'Create one unpublished scratch exam')
            exam_id = created.json()['id']
            # A controlled disappearance reproduces the failure mode, not the
            # historical unknown cause. Stop ONLY the verified launcher-owned PID.
            state = json.loads(local.STATE.read_text())
            process = local.owned(state.get('backend', {}))
            check(process is not None, 'Backend process ownership verified')
            children = process.children(recursive=True)
            for child in children: child.terminate()
            process.terminate()
            import psutil
            _, alive = psutil.wait_procs([process,*children], timeout=10)
            check(not alive, 'Controlled owned backend termination')
            check(httpx.get('http://127.0.0.1:5173/api/auth/me',timeout=10).status_code >= 500,
                  'Actual proxy reports unavailable backend')
            if failure_ui:
                command([local.NODE, local.ROOT/'scripts/smoke_p3_browser.mjs', '--expect-backend-unavailable'], 'unavailable_ui')
            command([local.PYTHON, local.ROOT/'scripts/cybros_local.py', 'start'], 'backend_recovery')
            ready(client)
            check(client.get('/auth/me').status_code == 200, 'Existing login cookie survives backend recovery')
            no_active_attempts()
            command([local.PYTHON, local.ROOT/'scripts/cybros_local.py', 'stop'], 'full_stop')
            check(not local.port_open(5173) and not local.port_open(8000) and not local.port_open(55432), 'Owned frontend/backend/database stopped')
            check(local.port_open(11434), 'External Ollama left running')
            if validate_restore:
                command([local.PYTHON, local.ROOT/'scripts/validate_p3_upgrade.py', 'validate'], 'post_upgrade_restore')
            command([local.PYTHON, local.ROOT/'scripts/cybros_local.py', 'start'], 'full_restart')
            ready(client)
            check(client.get('/auth/me').status_code == 200, 'Existing login cookie survives full restart')
            exams = client.get('/auth/professor/exams')
            check(exams.status_code == 200 and any(row['id']==exam_id for row in exams.json()), 'Scratch exam persists across database restart')
            report['status'] = 'passed'
    except Exception as error:
        report['status'] = 'failed'
        report['failure_type'] = type(error).__name__
        (root/'failure.txt').write_text(str(error),encoding='utf-8')
    finally:
        if exam_id is not None:
            try:
                with httpx.Client(base_url='http://127.0.0.1:8000',timeout=10,trust_env=False) as cleanup:
                    login = cleanup.post('/auth/login',json={'username':professor['username'],'password':professor['password']})
                    removed = cleanup.delete('/exam/templates/'+exam_id) if login.status_code==200 else None
                    report['scratch_exam_removed'] = removed is not None and removed.status_code in (200,204)
            except Exception:
                report['scratch_exam_removed'] = False
            if not report.get('scratch_exam_removed'):
                report['status'] = 'cleanup_failed'
        report['ended_at'] = datetime.now(timezone.utc).isoformat()
        (root/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps({'status':report['status'],'passed_checks':sum(item['passed'] for item in report['checks']),
        'report':str(root/'report.json'),'scratch_exam_removed':report.get('scratch_exam_removed')},indent=2))
    return 0 if report['status']=='passed' else 1


if __name__ == '__main__':
    import argparse
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run',action='store_true')
    parser.add_argument('--validate-restore',action='store_true')
    parser.add_argument('--failure-ui',action='store_true')
    args=parser.parse_args()
    if not args.run:
        print('Plan only: authorized controlled backend recovery, full restart, cookie/data persistence, scratch cleanup. No services changed.')
    else:
        sys.exit(run(validate_restore=args.validate_restore,failure_ui=args.failure_ui))
