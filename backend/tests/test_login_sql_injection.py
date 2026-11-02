import os

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.auth import password_hash, router as auth_router
from backend.app.db import get_db

os.environ["AUTH_SECRET_KEY"] = (
    "test-only-secret-key-for-login-regression-tests-32bytes"
)


class FakeResult:
    def __init__(self, row=None):
        self.row = row

    def mappings(self):
        return self

    def first(self):
        return self.row


class FakeDB:
    def __init__(self, account=None):
        self.account = account
        self.last_sql = ""
        self.last_params = None

    def execute(self, statement, params=None):
        self.last_sql = str(statement)
        self.last_params = params
        return FakeResult(self.account)


def make_client(fake_db):
    app = FastAPI()
    app.include_router(auth_router)

    def isolated_db():
        yield fake_db

    app.dependency_overrides[get_db] = isolated_db
    return TestClient(app)


def test_sql_injection_username_cannot_bypass_login():
    fake_db = FakeDB()
    client = make_client(fake_db)

    malicious_username = "' OR '1'='1"

    response = client.post(
        "/auth/login",
        json={
            "username": malicious_username,
            "password": "not-the-password",
        },
    )

    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid username or password."
    assert fake_db.last_params == {"username": malicious_username.lower()}
    assert ":username" in fake_db.last_sql
    assert "oralexam_session" not in response.cookies


def test_sql_injection_password_cannot_bypass_login():
    correct_password = "Correct-Test-Password-123!"
    fake_db = FakeDB(
        account={
            "id": "test-account-id",
            "username": "testprof",
            "password_hash": password_hash.hash(correct_password),
            "role": "professor",
            "professor_id": "10000000-0000-4000-8000-000000000001",
            "is_active": True,
        }
    )
    client = make_client(fake_db)

    response = client.post(
        "/auth/login",
        json={
            "username": "testprof",
            "password": "' OR '1'='1",
        },
    )

    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid username or password."
    assert "oralexam_session" not in response.cookies



def test_login_rate_limit_blocks_repeated_failures():
    from backend.app import auth as auth_module

    with auth_module._login_failures_lock:
        auth_module._login_failures.clear()

    client = make_client(FakeDB())
    payload = {"username": "unknown-user", "password": "wrong-password"}

    for _ in range(auth_module.LOGIN_RATE_LIMIT):
        assert client.post("/auth/login", json=payload).status_code == 401

    response = client.post("/auth/login", json=payload)
    assert response.status_code == 429
    assert "Retry-After" in response.headers

    with auth_module._login_failures_lock:
        auth_module._login_failures.clear()


def test_login_rate_limit_expires_old_attempts(monkeypatch):
    from backend.app import auth as auth_module

    with auth_module._login_failures_lock:
        auth_module._login_failures.clear()

    now = [1000.0]
    monkeypatch.setattr(auth_module.time, "monotonic", lambda: now[0])
    client = make_client(FakeDB())
    payload = {"username": "unknown-user", "password": "wrong-password"}

    for _ in range(auth_module.LOGIN_RATE_LIMIT):
        assert client.post("/auth/login", json=payload).status_code == 401

    assert client.post("/auth/login", json=payload).status_code == 429

    now[0] += auth_module.LOGIN_RATE_WINDOW_SECONDS + 1
    assert client.post("/auth/login", json=payload).status_code == 401

    with auth_module._login_failures_lock:
        auth_module._login_failures.clear()
