"""Credential isolation for local frontend/model subprocesses; no processes started."""
import pytest
from scripts import cybros_local

CONFIG = {'db_password':'synthetic-only-db-password', 'auth_secret':'synthetic-only-key',
          'bootstrap_token':'synthetic-only-bootstrap', 'model':'synthetic-model'}
SECRETS = ('DATABASE_URL','AUTH_SECRET_KEY','ADMIN_BOOTSTRAP_TOKEN','PGPASSWORD','ARBITRARY_TEST_SECRET')


@pytest.mark.parametrize('service', ['frontend','ollama'])
def test_nonbackend_services_do_not_receive_database_or_auth_secrets(monkeypatch, service):
    for key in SECRETS: monkeypatch.setenv(key, 'synthetic-secret-never-for-ui-or-model')
    env = cybros_local.service_environment(CONFIG, service)
    assert not set(SECRETS).intersection(env)
    assert all('synthetic-secret-never-for-ui-or-model' not in value for value in env.values())
    assert env['PATH'] and env.get('SystemRoot')
    if service == 'ollama': assert env['OLLAMA_HOST'] == '127.0.0.1:11434'


def test_backend_retains_its_required_configuration():
    env = cybros_local.service_environment(CONFIG, 'backend')
    assert env['AUTH_SECRET_KEY'] == CONFIG['auth_secret']
    assert env['PGPASSWORD'] == CONFIG['db_password']
    assert '127.0.0.1:55432/cybros_p3' in env['DATABASE_URL']


def test_unknown_service_cannot_default_to_privileged_environment():
    with pytest.raises(ValueError): cybros_local.service_environment(CONFIG, 'unrecognized')
