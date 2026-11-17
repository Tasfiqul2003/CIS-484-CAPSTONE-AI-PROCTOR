"""Protected P3 backup/isolated-restore validation. Default plan starts nothing.

Only invoke validate/apply after the user approves local database maintenance.
No application start, model call, real media capture or shared server operation.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import secrets
import subprocess
import sys

from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

import cybros_local as local
from developer_migrate import load_migrations, apply_migrations, executable_sql


def validation_name(value):
    if not isinstance(value, str) or not re.fullmatch(r'cybros_validation_[a-z0-9_]{8,50}', value):
        raise ValueError('Refusing a database outside the owned validation namespace.')
    return value


def plan():
    migrations = load_migrations(local.ROOT / 'database')
    for migration in migrations:
        executable_sql(migration)
    return {'action': 'plan', 'starts_services': False, 'database_changes': False,
            'catalog_files': len(migrations),
            'new_migrations': [m.name for m in migrations if Path(m.name).name.startswith(('016_', '017_', '018_', '019_', '020_'))],
            'maintenance': 'protected backup -> isolated restore -> migrations -> real SQL contracts -> optional reviewed source upgrade',
            'media_coverage': 'Database backup only; recording and WAV asset backups are separate.'}


def _run_locked(action):
    if action == 'plan':
        print(json.dumps(plan(), indent=2))
        return 0
    if local.port_open(8000) or local.port_open(5173):
        raise RuntimeError('Stop the owned CYBROS frontend/backend before database maintenance; no process was stopped automatically.')
    if local.port_open(8000) or local.port_open(5173):
        raise RuntimeError('Keep the local frontend/backend stopped during database maintenance.')
    cfg = local.load()
    environment = local.environment(cfg)
    source_url = make_url(environment['DATABASE_URL'])
    if (source_url.host != '127.0.0.1' or source_url.port != 55432 or source_url.database != 'cybros_p3'):
        raise RuntimeError('The configured target is not the known local P3 database.')
    stamp = datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')
    name = validation_name(f'cybros_validation_{stamp}_{secrets.token_hex(4)}')
    output = local.DATA / 'backups' / f'upgrade_{stamp}_{secrets.token_hex(4)}'
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    report_path = output / 'validation.json'
    report = {'action': action, 'status': 'started', 'validation_database': name,
              'backup': str(output / 'before_upgrade.dump'), 'source_applied': [],
              'media_coverage': 'Database only; asset backups remain separate.', 'step': 'database start'}
    source = admin = isolated = None
    created = False
    successful = False
    was_running = local.pg_running(cfg)
    started_database = False

    def save():
        report_path.write_text(json.dumps(report, indent=2), encoding='utf-8')

    def command(args, label, *, child_environment=None):
        report['step'] = label
        save()
        result = subprocess.run([str(arg) for arg in args], env=child_environment or environment,
            cwd=local.ROOT, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), timeout=180)
        (output / f'{label}.log').write_bytes(result.stdout)
        if result.returncode:
            raise RuntimeError(f'{label} failed; protected logs retained.')
        return result

    try:
        save()
        if not was_running:
            if local.port_open(55432):
                raise RuntimeError('Database port is occupied; refusing to adopt or stop an unowned process.')
            # Claim ownership only after our explicit pg_ctl start succeeds.
            # A competing start failure never authorizes a later stop.
            local.run([local.PG / 'pg_ctl.exe', '-D', local.DATA / 'pgdata', '-l',
                       local.DATA / 'postgres.log', '-w', 'start'], cfg,
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            started_database = True
        source = create_engine(source_url, hide_parameters=True)
        admin = create_engine(source_url.set(database='postgres'), isolation_level='AUTOCOMMIT', hide_parameters=True)
        migrations = load_migrations(local.ROOT / 'database')
        catalog = {item.name: item.sha256 for item in migrations}
        with source.connect() as connection:
            ledger = dict(connection.execute(text('SELECT name, sha256 FROM developer_schema_migrations')).tuples().all())
        if not ledger or any(name not in catalog or catalog[name] != digest for name, digest in ledger.items()):
            raise RuntimeError('Source migration ledger is missing, unknown or changed; no upgrade attempted.')
        report['source_ledger_count'] = len(ledger)
        report['pending'] = [item.name for item in migrations if item.name not in ledger]
        save()
        command([local.PG / 'pg_dump.exe', '--host=127.0.0.1', '--port=55432', '--username=proctor',
                 '--no-password', '--format=custom', '--file', report['backup'], 'cybros_p3'], 'backup')
        if Path(report['backup']).stat().st_size < 1:
            raise RuntimeError('Database backup is empty.')
        command([local.PG / 'pg_restore.exe', '--list', report['backup']], 'backup_listing')
        with admin.connect() as connection:
            connection.execute(text(f'CREATE DATABASE {validation_name(name)}'))
        created = True
        command([local.PG / 'pg_restore.exe', '--host=127.0.0.1', '--port=55432', '--username=proctor',
                 '--no-password', '--exit-on-error', '--no-owner', '--no-privileges',
                 '--dbname', name, report['backup']], 'isolated_restore')
        isolated_url = source_url.set(database=name)
        isolated = create_engine(isolated_url, hide_parameters=True)
        report['step'] = 'isolated_migrations'
        save()
        with isolated.begin() as connection:
            report['isolated_applied'] = apply_migrations(connection, migrations)
        with isolated.begin() as connection:
            if apply_migrations(connection, migrations):
                raise RuntimeError('Second migration pass was not idempotent.')
        test_environment = environment.copy()
        # The test process gets only the isolated URL and a test JWT key, never
        # a reason to connect through a generic application DATABASE_URL.
        test_environment.pop('DATABASE_URL', None)
        test_environment.pop('ADMIN_BOOTSTRAP_TOKEN', None)
        test_environment['AUTH_SECRET_KEY'] = 'isolated-validation-only-' + secrets.token_hex(24)
        test_environment['CYBROS_VALIDATION_DATABASE_URL'] = isolated_url.render_as_string(hide_password=False)
        test_environment['PYTHONPATH'] = str(local.ROOT) + ';' + str(local.ROOT / 'backend')
        command([local.PYTHON, '-m', 'pytest', 'backend/tests/test_postgres_contracts.py', '-q',
                 '--disable-warnings', '-p', 'no:cacheprovider'], 'postgres_contracts', child_environment=test_environment)
        report['contracts_passed'] = True
        if action == 'apply':
            report['step'] = 'source_migrations'
            save()
            if local.port_open(8000) or local.port_open(5173):
                raise RuntimeError('The application started during validation; source migrations were not applied.')
            with source.begin() as connection:
                applied_names = apply_migrations(connection, migrations)
            report['source_applied'] = applied_names
        successful = True
        report['status'] = 'passed'
    except Exception as error:
        report['status'] = 'failed'
        report['failure_type'] = type(error).__name__
        # Full diagnostics may include database identifiers, so keep them private.
        (output / 'failure.txt').write_text(str(error), encoding='utf-8')
    finally:
        if isolated is not None:
            isolated.dispose()
        if source is not None:
            source.dispose()
        if created and successful:
            try:
                with admin.connect() as connection:
                    connection.execute(text(f'DROP DATABASE {validation_name(name)}'))
                report['validation_database_removed'] = True
            except Exception:
                report['validation_database_removed'] = False
                report.setdefault('cleanup_failures', []).append('validation_database_remove')
        if admin is not None:
            admin.dispose()
        if started_database:
            try:
                local.run([local.PG / 'pg_ctl.exe', '-D', local.DATA / 'pgdata', '-m', 'fast', '-w', 'stop'], cfg,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                report['owned_database_stopped'] = True
            except Exception:
                report['owned_database_stopped'] = False
                report.setdefault('cleanup_failures', []).append('owned_database_stop')
        if report.get('cleanup_failures'):
            successful = False
            report['status'] = 'cleanup_failed'
        save()
    print(json.dumps({'status': report['status'], 'report': str(report_path),
                      'source_migrations_applied': len(report['source_applied']),
                      'isolated_contracts_passed': report.get('contracts_passed', False),
                      'cleanup_failures': report.get('cleanup_failures', []),
                      'owned_database_stopped': report.get('owned_database_stopped'),
                      'validation_database_removed': report.get('validation_database_removed')}, indent=2))
    return 0 if successful else 1


def run(action):
    if action == 'plan':
        return _run_locked(action)
    with local.lifecycle_lock():
        return _run_locked(action)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', nargs='?', choices=('plan', 'validate', 'apply'), default='plan')
    sys.exit(run(parser.parse_args().action))
