"""Local-only synthetic grants: real signed cookies and a synthetic SQLite DB."""

from datetime import datetime, timedelta, timezone

import jwt
import pytest
from fastapi import Depends, FastAPI, Request
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from backend.app import developer_face_bypass as bypass
from backend.app.auth import get_secret
from backend.app.db import get_db

URL = "/exam/student/developer-face-bypass"
IDS = tuple(f"10000000-0000-4000-8000-{i:012d}" for i in range(1, 54))
OTHER_ID = "10000000-0000-4000-8000-000000000999"


def application(database):
    app = FastAPI()
    app.include_router(bypass.router)
    app.dependency_overrides[get_db] = database

    @app.get("/test-only/grant/{student_id}")
    def inspect_grant(student_id: str, request: Request, db: Session = Depends(get_db)):
        grant = bypass.authorized_bypass(db, student_id, request)
        return grant or {"allowed": False}

    return app


@pytest.fixture
def api(monkeypatch):
    monkeypatch.setenv("AUTH_SECRET_KEY", "synthetic-developer-face-bypass-test-secret-32-characters")
    monkeypatch.setenv("CYBROS_DEVELOPER_FACE_BYPASS", "1")
    monkeypatch.setenv("AUTH_COOKIE_SECURE", "false")
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE students(id TEXT PRIMARY KEY, name TEXT, eid TEXT)"))
        connection.execute(text("CREATE TABLE student_face_verifications(student_id TEXT PRIMARY KEY, attempt_count INTEGER, status TEXT)"))
        for index, (student_id, eid) in enumerate(zip(IDS, bypass.ALLOWED_EIDS), 1):
            connection.execute(text("INSERT INTO students VALUES (:id,:name,:eid)"),
                {"id": student_id, "name": f"Synthetic developer {index}", "eid": eid})
        connection.execute(text("INSERT INTO students VALUES (:id,'Synthetic ordinary student','ordinary.student')"), {"id": OTHER_ID})
        connection.execute(text("INSERT INTO student_face_verifications VALUES (:id,3,'no_match')"), {"id": IDS[0]})
    factory = sessionmaker(bind=engine)
    def database():
        with factory() as session:
            yield session
    app = application(database)
    statements = []
    @event.listens_for(engine, "before_cursor_execute")
    def capture_sql(connection, cursor, statement, parameters, context, executemany):
        statements.append(statement)
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as client:
        yield client, engine, database, statements
    engine.dispose()


def grant(client, eid="student.demo"):
    return client.post(URL, json={"eid": eid})


def use(client, student_id=IDS[0]):
    return client.get(f"/test-only/grant/{student_id}").json()


def signed_cookie(client, **changes):
    now = int(datetime.now(timezone.utc).timestamp())
    claims = {"sub": IDS[0], "eid": "student.demo", "purpose": bypass.PURPOSE,
              "iat": now, "exp": now + 900, **changes}
    token = jwt.encode(claims, get_secret(), algorithm="HS256")
    client.cookies.clear()
    client.cookies.set(bypass.COOKIE_NAME, token, domain="127.0.0.1", path="/")


def test_capabilities_disabled_by_default_and_no_db_access(api, monkeypatch):
    client, engine, database, statements = api
    monkeypatch.delenv("CYBROS_DEVELOPER_FACE_BYPASS")
    response = client.get(URL)
    assert response.json() == {"enabled": False, "allowed_eids": [], "expires_in_seconds": 900}
    assert response.headers["cache-control"] == "no-store"
    assert grant(client).status_code == 403
    assert use(client) == {"allowed": False}
    assert statements == []


def test_capabilities_list_only_the_exact_authorized_synthetic_eids(api):
    client, *_ = api
    response = client.get(URL)
    assert response.json() == {"enabled": True, "allowed_eids": list(bypass.ALLOWED_EIDS), "expires_in_seconds": 900}
    assert "set-cookie" not in response.headers


@pytest.mark.parametrize("eid,index", [("student.demo", 0), (" STUDENT.DEMO2 ", 1)] + [(f"student.demo{i}", i-1) for i in range(3,54)])
def test_all_authorized_accounts_issue_honest_cookie_without_photo_history_writes(api, eid, index):
    client, engine, database, statements = api
    response = grant(client, eid)
    assert response.status_code == 200
    result = response.json()
    assert result["student"] == {"id": IDS[index], "name": f"Synthetic developer {index+1}", "eid": bypass.ALLOWED_EIDS[index]}
    assert result["allowed"] is True and result["developer_bypass"] is True
    assert result["matched"] is False and result["identity_check_completed"] is False
    assert result["identity_verified"] is False
    assert result["review_required"] is True and result["identity_review_required"] is True
    expires = datetime.fromisoformat(result["expires_at"])
    assert 897 < (expires - datetime.now(timezone.utc)).total_seconds() <= 900
    assert set(result) == {"student", "expires_at", "allowed", "matched", "developer_bypass", "identity_check_completed", "identity_verified", "identity_method", "review_required", "identity_review_required"}
    cookie = response.headers["set-cookie"]
    assert cookie.startswith(bypass.COOKIE_NAME + "=")
    assert "HttpOnly" in cookie and "SameSite=strict" in cookie
    assert "Max-Age=900" in cookie and "Path=/" in cookie and "Domain=" not in cookie
    assert response.headers["cache-control"] == "no-store"
    inspected = use(client, IDS[index])
    assert inspected["status"] == "developer_bypass" and inspected["matched"] is False
    assert inspected["attempt_count"] == (3 if index == 0 else 0)
    assert inspected["review_required"] is True and inspected["identity_check_completed"] is False
    assert not any(sql.lstrip().split()[0].upper() in {"INSERT", "UPDATE", "DELETE"} for sql in statements)
    with engine.connect() as connection:
        assert connection.execute(text("SELECT attempt_count,status FROM student_face_verifications")).all() == [(3, "no_match")]


@pytest.mark.parametrize("eid", ["ordinary.student", "student.demo54", "student.demo0", "student.demo1", "student.demo04", "student.demo.evil", "student.demo@localhost", "", "  "])
def test_other_and_prefix_eids_cannot_get_grants(api, eid):
    client, engine, database, statements = api
    assert grant(client, eid).status_code in {403, 422}
    assert bypass.COOKIE_NAME not in client.cookies
    assert statements == []


@pytest.mark.parametrize("payload", [{}, {"eid": 1}, {"eid": "a" * 65}, {"eid": "student.demo", "matched": True}])
def test_request_shape_and_size_are_strict(api, payload):
    client, *_ = api
    assert client.post(URL, json=payload).status_code == 422


def test_missing_or_ambiguous_synthetic_row_does_not_issue_grant(api):
    client, engine, *_ = api
    with engine.begin() as connection:
        connection.execute(text("DELETE FROM students WHERE id=:id"), {"id": IDS[2]})
    assert grant(client, "student.demo3").status_code == 404
    with engine.begin() as connection:
        connection.execute(text("UPDATE students SET eid='student.demo' WHERE id=:id"), {"id": OTHER_ID})
    assert grant(client).status_code == 404
    assert bypass.COOKIE_NAME not in client.cookies


def test_signed_grant_survives_a_new_app_instance_without_memory_state(api):
    client, engine, database, statements = api
    assert grant(client).status_code == 200
    cookie = client.cookies.get(bypass.COOKIE_NAME)
    with TestClient(application(database), base_url="http://127.0.0.1", client=("127.0.0.1", 50001)) as restarted:
        restarted.cookies.set(bypass.COOKIE_NAME, cookie)
        assert use(restarted)["status"] == "developer_bypass"
        assert use(restarted, IDS[1]) == {"allowed": False}


@pytest.mark.parametrize("changes", [
    {"purpose": "student_access"}, {"sub": OTHER_ID}, {"sub": "not-a-uuid"},
    {"eid": "ordinary.student"}, {"eid": "student.demo2"},
    {"exp": 1, "iat": 0}, {"iat": 1}, {"exp": "not-time"},
    {"iat": True}, {"exp": None}, {"purpose": None},
])
def test_invalid_mismatched_or_expired_cookie_denied(api, changes):
    client, *_ = api
    signed_cookie(client, **changes)
    assert use(client) == {"allowed": False}


def test_tampered_signature_and_other_cookie_do_not_authorize(api):
    client, *_ = api
    signed_cookie(client)
    token = client.cookies.get(bypass.COOKIE_NAME)
    first, payload, signature = token.split(".")
    changed = ("A" if signature[0] != "A" else "B") + signature[1:]
    client.cookies.clear()
    client.cookies.set(bypass.COOKIE_NAME, ".".join((first, payload, changed)))
    assert use(client) == {"allowed": False}
    client.cookies.clear()
    client.cookies.set("oralexam_face_check_passed", "true")
    assert use(client) == {"allowed": False}


def test_db_identity_and_flag_are_revalidated_on_every_use(api, monkeypatch):
    client, engine, *_ = api
    assert grant(client).status_code == 200
    assert use(client)["allowed"] is True
    monkeypatch.setenv("CYBROS_DEVELOPER_FACE_BYPASS", "0")
    assert use(client) == {"allowed": False}
    monkeypatch.setenv("CYBROS_DEVELOPER_FACE_BYPASS", "1")
    with engine.begin() as connection:
        connection.execute(text("UPDATE students SET eid='ordinary.student' WHERE id=:id"), {"id": IDS[0]})
    assert use(client) == {"allowed": False}
    with engine.begin() as connection:
        connection.execute(text("DELETE FROM students WHERE id=:id"), {"id": IDS[0]})
    assert use(client) == {"allowed": False}


@pytest.mark.parametrize("origin", ["https://evil.example", "null", "http://127.0.0.1.evil.example", "http://localhost@evil.example", "http://127.0.0.1:bad", "http://localhost/path", "http://localhost#fragment"])
def test_nonloopback_or_malformed_origins_cannot_get_or_use_grants(api, origin):
    client, *_ = api
    assert grant(client).status_code == 200
    client.headers["Origin"] = origin
    assert client.get(URL).json()["enabled"] is False
    assert grant(client).status_code == 403
    assert use(client) == {"allowed": False}


@pytest.mark.parametrize("base_url,host", [
    ("http://127.0.0.1", "192.0.2.50"),
    ("http://evil.example", "127.0.0.1"),
    ("http://localhost.evil.example", "127.0.0.1"),
])
def test_client_and_url_must_both_be_loopback_despite_spoofed_headers(api, base_url, host):
    client, engine, database, statements = api
    with TestClient(application(database), base_url=base_url, client=(host, 50000), headers={"X-Forwarded-For": "127.0.0.1", "X-Forwarded-Host": "localhost", "Origin": "http://localhost:5173"}) as untrusted:
        assert untrusted.get(URL).json()["enabled"] is False
        assert grant(untrusted).status_code == 403
        signed_cookie(untrusted)
        assert use(untrusted) == {"allowed": False}
    assert statements == []


@pytest.mark.parametrize("base_url,host,origin", [
    ("http://127.0.0.1", "127.0.0.1", "http://localhost:5173"),
    ("http://localhost", "127.0.0.1", "http://127.0.0.1:5173"),
    ("http://[::1]", "::1", "http://[::1]:5173"),
    ("http://127.0.0.1", "::ffff:127.0.0.1", "http://localhost:5173"),
])
def test_loopback_variants_with_local_browser_origin_are_supported(api, base_url, host, origin):
    client, engine, database, statements = api
    with TestClient(application(database), base_url=base_url, client=(host, 50000), headers={"Origin": origin}) as local:
        assert local.get(URL).json()["enabled"] is True
        assert grant(local).status_code == 200
        assert use(local)["status"] == "developer_bypass"


def test_duplicate_origin_is_rejected(api):
    client, *_ = api
    response = client.post(URL, json={"eid": "student.demo"}, headers=[("Origin", "http://localhost:5173"), ("Origin", "https://evil.example")])
    assert response.status_code == 403


def test_secure_cookie_follows_existing_auth_configuration(api, monkeypatch):
    client, engine, database, statements = api
    monkeypatch.setenv("AUTH_COOKIE_SECURE", "true")
    with TestClient(application(database), base_url="https://localhost", client=("127.0.0.1", 50000)) as secure:
        response = grant(secure)
        assert response.status_code == 200 and "; Secure" in response.headers["set-cookie"]
        assert use(secure)["allowed"] is True


def test_missing_request_and_malformed_student_id_fail_closed(api):
    client, engine, database, statements = api
    with Session(engine) as session:
        assert bypass.authorized_bypass(session, IDS[0], None) is None
    assert grant(client).status_code == 200
    assert use(client, "invalid") == {"allowed": False}


def test_missing_signing_configuration_cannot_get_or_use_a_grant(api, monkeypatch):
    client, *_ = api
    assert grant(client).status_code == 200
    monkeypatch.delenv("AUTH_SECRET_KEY")
    assert use(client) == {"allowed": False}
    assert grant(client).status_code == 500
