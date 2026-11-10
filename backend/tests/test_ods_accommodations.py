"""Synthetic exam-scoped ODS assignments using isolated in-memory SQLite."""

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend.app.auth import get_current_account
from backend.app.db import get_db
from backend.app.ods_accommodations import MAX_UPLOAD_BYTES, MAX_UPLOAD_ROWS, parse_eid_csv, router


PROFESSOR = "10000000-0000-4000-8000-000000000001"
OTHER_PROFESSOR = "10000000-0000-4000-8000-000000000002"
EXAM = "20000000-0000-4000-8000-000000000001"
SECOND_EXAM = "20000000-0000-4000-8000-000000000002"
OTHER_EXAM = "20000000-0000-4000-8000-000000000003"
ALICE = "30000000-0000-4000-8000-000000000001"
BOB = "30000000-0000-4000-8000-000000000002"
OUTSIDER = "30000000-0000-4000-8000-000000000003"
URL = f"/exam/templates/{EXAM}/ods-accommodations"
ACCOUNT = {"id": "synthetic-account", "role": "professor", "professor_id": PROFESSOR}


@pytest.fixture
def api():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    with engine.begin() as db:
        db.execute(text("""CREATE TABLE exam_templates (id TEXT PRIMARY KEY, professor_id TEXT,
            time_limit_minutes INTEGER, question_time_limit_minutes INTEGER)"""))
        db.execute(text("""CREATE TABLE students (id TEXT PRIMARY KEY, name TEXT NOT NULL,
            eid TEXT)"""))
        db.execute(text("""CREATE TABLE exam_roster (exam_template_id TEXT NOT NULL,
            student_id TEXT NOT NULL, extended_time_multiplier NUMERIC,
            PRIMARY KEY (exam_template_id, student_id))"""))
        db.execute(text("INSERT INTO exam_templates VALUES (:id, :owner, 30, 2)"), [
            {"id": EXAM, "owner": PROFESSOR}, {"id": SECOND_EXAM, "owner": PROFESSOR},
            {"id": OTHER_EXAM, "owner": OTHER_PROFESSOR}])
        db.execute(text("INSERT INTO students VALUES (:id, :name, :eid)"), [
            {"id": ALICE, "name": "Synthetic Alice", "eid": "alpha01"},
            {"id": BOB, "name": "Synthetic Bob", "eid": "0000123"},
            {"id": OUTSIDER, "name": "Synthetic Outside", "eid": "outside01"}])
        db.execute(text("INSERT INTO exam_roster VALUES (:exam, :student, NULL)"), [
            {"exam": EXAM, "student": ALICE}, {"exam": EXAM, "student": BOB},
            {"exam": SECOND_EXAM, "student": ALICE}, {"exam": OTHER_EXAM, "student": OUTSIDER}])
    sessions = sessionmaker(bind=engine)
    app = FastAPI()
    app.include_router(router)

    def isolated_db():
        with sessions() as db:
            yield db

    app.dependency_overrides[get_db] = isolated_db
    app.dependency_overrides[get_current_account] = lambda: dict(ACCOUNT)
    with TestClient(app) as client:
        yield client, app, engine
    engine.dispose()


def stored_assignments(engine):
    with engine.connect() as db:
        return list(db.execute(text("""SELECT exam_template_id, student_id, extended_time_multiplier
            FROM exam_roster ORDER BY exam_template_id, student_id""")))


def upload(client, contents, multiplier="1.5", filename="synthetic-eids.csv"):
    return client.post(f"{URL}/upload", files={"file": (filename, contents, "text/csv")},
                       data={"extended_time_multiplier": multiplier})


def test_single_assignment_update_reset_and_exam_isolation(api):
    client, _, engine = api
    assert client.get(URL).json() == {
        "time_limit_minutes": 30, "question_time_limit_minutes": 2, "assignments": []}
    for multiplier in (1.25, 1.5, 2, 3):
        response = client.put(URL, json={"eid": "  ALPHA01  ",
                                        "extended_time_multiplier": multiplier})
        assert response.status_code == 200
        data = response.json()
        assert data == client.get(URL).json()
        assert data["time_limit_minutes"] == 30
        assert data["question_time_limit_minutes"] == 2
        assert data["assignments"] == [{"student_id": ALICE, "eid": "alpha01", "name": "Synthetic Alice",
            "extended_time_multiplier": multiplier, "effective_time_limit_minutes": 30 * multiplier}]
        other = client.get(f"/exam/templates/{SECOND_EXAM}/ods-accommodations")
        assert other.status_code == 200
        assert other.json()["assignments"] == []
    response = client.delete(f"{URL}/{ALICE}")
    assert response.status_code == 200
    assert response.json()["assignments"] == []
    assert all(row[2] is None for row in stored_assignments(engine))


@pytest.mark.parametrize("minutes,effective", [(None, None), (240, 720)])
def test_effective_total_preserves_disabled_limit_and_can_exceed_standard_limit(api, minutes, effective):
    client, _, engine = api
    with engine.begin() as db:
        db.execute(text("UPDATE exam_templates SET time_limit_minutes = :minutes WHERE id = :exam"),
                   {"minutes": minutes, "exam": EXAM})
    response = client.put(URL, json={"eid": "alpha01", "extended_time_multiplier": 3})
    assert response.status_code == 200
    assert response.json()["assignments"][0]["effective_time_limit_minutes"] == effective
    assert response.json()["assignments"][0]["extended_time_multiplier"] == 3
    assert response.json()["question_time_limit_minutes"] == 2
    assert response.json() == client.get(URL).json()


@pytest.mark.parametrize("value", [None, True, False, "1.5", 1, 0, -1, 1.75, 4, [], {}])
def test_single_multiplier_validation_preserves_saved_state(api, value):
    client, _, engine = api
    assert client.put(URL, json={"eid": "alpha01", "extended_time_multiplier": 1.5}).status_code == 200
    before = stored_assignments(engine)
    assert client.put(URL, json={"eid": "alpha01", "extended_time_multiplier": value}).status_code == 422
    assert stored_assignments(engine) == before


@pytest.mark.parametrize("body", [
    {"eid": 123, "extended_time_multiplier": 1.5},
    {"eid": "alpha01", "extended_time_multiplier": 1.5, "professor_id": OTHER_PROFESSOR},
    {"eid": "alpha01", "extended_time_multiplier": 1.5, "student_id": OUTSIDER},
])
def test_assignment_request_cannot_coerce_identity_or_add_authority_fields(api, body):
    client, _, engine = api
    before = stored_assignments(engine)
    assert client.put(URL, json=body).status_code == 422
    assert stored_assignments(engine) == before


@pytest.mark.parametrize("eid", ["", "  ", "unknown01", "outside01", "123"])
def test_only_existing_unambiguous_rostered_eid_can_receive_assignment(api, eid):
    client, _, engine = api
    before = stored_assignments(engine)
    response = client.put(URL, json={"eid": eid, "extended_time_multiplier": 1.5})
    assert response.status_code in (400, 404, 409, 422)
    assert stored_assignments(engine) == before
    with engine.connect() as db:
        assert db.execute(text("SELECT count(*) FROM students")).scalar_one() == 3


def test_case_insensitive_identity_collision_is_rejected(api):
    client, _, engine = api
    with engine.begin() as db:
        db.execute(text("INSERT INTO students VALUES ('synthetic-duplicate', 'Synthetic Duplicate', ' ALPHA01 ')"))
        db.execute(text("INSERT INTO exam_roster VALUES (:exam, 'synthetic-duplicate', NULL)"), {"exam": EXAM})
    before = stored_assignments(engine)
    assert client.put(URL, json={"eid": "alpha01", "extended_time_multiplier": 2}).status_code in (400, 409, 422)
    assert stored_assignments(engine) == before


@pytest.mark.parametrize("identity,status", [("anonymous", 401), ("student", 403), ("admin", 403),
                                             ("unlinked", 403), ("other-professor", 404)])
def test_all_assignment_endpoints_require_owner_professor(api, identity, status):
    client, app, engine = api
    if identity == "anonymous":
        def anonymous():
            raise HTTPException(401, "Synthetic sign-in required")
        app.dependency_overrides[get_current_account] = anonymous
    else:
        account = dict(ACCOUNT)
        if identity == "unlinked":
            account["professor_id"] = None
        elif identity == "other-professor":
            account["professor_id"] = OTHER_PROFESSOR
        else:
            account["role"] = identity
        app.dependency_overrides[get_current_account] = lambda: account
    before = stored_assignments(engine)
    responses = [client.get(URL),
                 client.put(URL, json={"eid": "alpha01", "extended_time_multiplier": 1.5}),
                 upload(client, b"eid\nalpha01\n"), client.delete(f"{URL}/{ALICE}")]
    assert [response.status_code for response in responses] == [status] * 4
    assert stored_assignments(engine) == before


def test_reset_cannot_target_student_outside_selected_exam_roster(api):
    client, _, engine = api
    before = stored_assignments(engine)
    assert client.delete(f"{URL}/{OUTSIDER}").status_code == 404
    assert stored_assignments(engine) == before


def test_utf8_bom_csv_assigns_leading_zero_eid_and_persists(api):
    client, _, _ = api
    response = upload(client, b"\xef\xbb\xbf EID \r\n ALPHA01 \r\n0000123\r\n", multiplier="1.25")
    assert response.status_code == 200
    data = response.json()
    assert data == client.get(URL).json()
    assert data["question_time_limit_minutes"] == 2
    assignments = {row["eid"]: row for row in data["assignments"]}
    assert set(assignments) == {"alpha01", "0000123"}
    assert assignments["0000123"]["student_id"] == BOB
    assert all(row["extended_time_multiplier"] == 1.25 for row in assignments.values())
    assert all(row["effective_time_limit_minutes"] == 37.5 for row in assignments.values())


@pytest.mark.parametrize("contents", [
    b"", b"eid\n", b"name\nalpha01\n", b"eid,name\nalpha01,Synthetic\n",
    b"eid,eid\nalpha01,alpha01\n", b"eid\nalpha01,extra\n", b'eid\n"alpha01\n',
    b'eid\nal"pha\n', b'eid\n"alpha"tail\n', b"eid\nalpha01\n ALPHA01 \n", b"eid\n\xff\n",
], ids=["empty", "header-only", "wrong-header", "extra-header", "duplicate-header", "extra-cell",
        "unclosed-quote", "bare-quote", "trailing-quote", "duplicate-normalized-eid", "invalid-utf8"])
def test_invalid_csv_is_rejected_without_changes(api, contents):
    client, _, engine = api
    before = stored_assignments(engine)
    assert upload(client, contents).status_code in (400, 413, 422)
    assert stored_assignments(engine) == before


def test_csv_parser_enforces_byte_and_distinct_row_limits():
    eids = [f"synthetic{index:04}" for index in range(MAX_UPLOAD_ROWS)]
    content = ("eid\n" + "\n".join(eids) + "\n").encode()
    assert parse_eid_csv(content) == eids
    with pytest.raises(HTTPException) as rows_error:
        parse_eid_csv(content + b"synthetic-over-limit\n")
    assert rows_error.value.status_code == 400
    with pytest.raises(HTTPException) as size_error:
        parse_eid_csv(b"eid\n" + b"a" * (MAX_UPLOAD_BYTES - 3))
    assert size_error.value.status_code == 413


@pytest.mark.parametrize("multiplier", ["", "1", "1.50", "true", "NaN", "Infinity", "4"])
def test_csv_multiplier_uses_allowed_canonical_form_values(api, multiplier):
    client, _, engine = api
    before = stored_assignments(engine)
    assert upload(client, b"eid\nalpha01\n", multiplier=multiplier).status_code in (400, 422)
    assert stored_assignments(engine) == before


def test_entire_csv_identity_set_is_validated_before_any_assignment_write(api):
    client, _, engine = api
    writes = []

    def capture_updates(connection, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith(("UPDATE", "INSERT", "DELETE")):
            writes.append(statement)

    before = stored_assignments(engine)
    event.listen(engine, "before_cursor_execute", capture_updates)
    try:
        response = upload(client, b"eid\nalpha01\noutside01\n")
    finally:
        event.remove(engine, "before_cursor_execute", capture_updates)
    assert response.status_code in (400, 404, 409, 422)
    assert writes == []
    assert stored_assignments(engine) == before


def test_database_error_rolls_back_all_csv_assignments(api):
    client, _, engine = api
    with engine.begin() as db:
        # SQLite triggers cannot bind parameters; this identifier is synthetic test data.
        db.execute(text(f"""CREATE TRIGGER synthetic_assignment_failure BEFORE UPDATE OF extended_time_multiplier
            ON exam_roster WHEN NEW.student_id = '{BOB}'
            BEGIN SELECT RAISE(ABORT, 'Synthetic assignment failure'); END"""))
    before = stored_assignments(engine)
    response = upload(client, b"eid\nalpha01\n0000123\n")
    assert response.status_code == 500
    assert stored_assignments(engine) == before
    assert client.get(URL).json()["assignments"] == []
