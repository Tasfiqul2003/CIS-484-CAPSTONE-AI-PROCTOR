"""Draft approval contract with real cookie auth and synthetic model/SQLite only."""

from datetime import datetime, timedelta, timezone
import json
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import jwt
import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend.app import question_drafts
from backend.app.auth import COOKIE_NAME, get_secret
from backend.app.db import get_db


EXAM = "20000000-0000-4000-8000-000000000001"
PROFESSOR = "10000000-0000-4000-8000-000000000001"
OTHER = "10000000-0000-4000-8000-000000000002"
URL = f"/exam/templates/{EXAM}/question-drafts"
REQUEST = "30000000-0000-4000-8000-000000000001"


def body(**changes):
    return {"request_id": REQUEST, "topic": "Recursion", "difficulty": 3, "count": 2, **changes}


class Generator:
    def __init__(self):
        self.calls = []
        self.result = None
        self.action = None
        self.error = None
    async def __call__(self, context, request):
        self.calls.append((context, request))
        if self.action:
            self.action()
        if self.error:
            raise self.error
        return self.result if self.result is not None else [
            {"question_text": f"Explain synthetic recursion example {i}.", "topic": request.topic,
             "difficulty": request.difficulty} for i in range(request.count)]


def authenticate(client, identity="owner", minutes=60):
    token = jwt.encode({"sub": identity, "role": "professor",
        "exp": datetime.now(timezone.utc) + timedelta(minutes=minutes)}, get_secret(), algorithm="HS256")
    client.cookies.set(COOKIE_NAME, token)


@pytest.fixture
def api(monkeypatch):
    monkeypatch.setenv("AUTH_SECRET_KEY", "synthetic-question-draft-secret-at-least-32-characters")
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    schema = [
        "CREATE TABLE user_accounts(id TEXT PRIMARY KEY, username TEXT, role TEXT, professor_id TEXT, is_active BOOLEAN)",
        "CREATE TABLE exam_templates(id TEXT PRIMARY KEY, professor_id TEXT, title TEXT, status TEXT, topic_coverage_required TEXT, rubric TEXT)",
        "CREATE TABLE exam_sessions(id TEXT PRIMARY KEY, exam_template_id TEXT, status TEXT,developer_demo BOOLEAN DEFAULT 0)",
        "CREATE TABLE course_materials(id TEXT PRIMARY KEY, exam_template_id TEXT, filename TEXT, summary TEXT, created_at TEXT)",
        "CREATE TABLE questions(id TEXT PRIMARY KEY, professor_id TEXT, exam_template_id TEXT, question_text TEXT, topic TEXT, difficulty INTEGER, avatar_authored_position INTEGER, created_at TEXT)",
        """CREATE TABLE question_generation_requests(exam_template_id TEXT,request_id TEXT,professor_id TEXT,
            input_hash TEXT,context_hash TEXT,status TEXT,error_code TEXT,created_at TEXT,lease_expires_at TEXT,completed_at TEXT,
            PRIMARY KEY(exam_template_id,request_id))""",
        """CREATE TABLE question_drafts(id TEXT PRIMARY KEY,exam_template_id TEXT,request_id TEXT,professor_id TEXT,
            question_text TEXT,topic TEXT,difficulty INTEGER,status TEXT,approved_question_id TEXT REFERENCES questions(id) ON DELETE SET NULL,
            approval_hash TEXT,created_at TEXT,reviewed_at TEXT)""",
    ]
    with engine.begin() as db:
        db.execute(text("PRAGMA foreign_keys=ON"))
        for statement in schema:
            db.execute(text(statement))
        db.execute(text("INSERT INTO user_accounts VALUES ('owner','synthetic-owner','professor',:professor,1),('other','synthetic-other','professor',:other,1),('admin','synthetic-admin','admin',NULL,1)"),
            {"professor": PROFESSOR, "other": OTHER})
        db.execute(text("INSERT INTO exam_templates VALUES (:id,:professor,'Synthetic draft exam','draft',:topics,:rubric)"),
            {"id": EXAM, "professor": PROFESSOR, "topics": json.dumps(["Recursion", "Sorting"]),
             "rubric": json.dumps({"Accuracy": 5})})
        db.execute(text("INSERT INTO course_materials VALUES ('material',:exam,'synthetic.txt','Recursion requires a base case.','2026-11-16')"), {"exam": EXAM})
    factory = sessionmaker(bind=engine)
    def database():
        with factory() as session:
            yield session
    generator = Generator()
    app = FastAPI()
    app.include_router(question_drafts.router)
    app.dependency_overrides[get_db] = database
    app.dependency_overrides[question_drafts.get_question_generator] = lambda: generator
    with TestClient(app) as client:
        authenticate(client)
        yield client, engine, generator
    engine.dispose()


def scalar(engine, query):
    with engine.connect() as db:
        return db.execute(text(query)).scalar_one()


def generate(api):
    response = api[0].post(f"{URL}/generate", json=body())
    assert response.status_code == 200, response.text
    return response.json()["drafts"]


@pytest.mark.parametrize("identity,status", [(None,401),("other",404),("admin",403),("expired",401)])
def test_auth_and_professor_ownership(api, identity, status):
    client, engine, generator = api
    client.cookies.clear()
    if identity:
        authenticate(client, "owner" if identity == "expired" else identity, minutes=-1 if identity == "expired" else 60)
    assert client.get(URL).status_code == status
    assert client.post(f"{URL}/generate", json=body()).status_code == status
    assert not generator.calls
    assert scalar(engine, "SELECT COUNT(*) FROM questions") == 0


def test_generation_is_isolated_idempotent_and_uses_professor_context(api):
    client, engine, generator = api
    drafts = generate(api)
    assert len(drafts) == 2 and all(item["status"] == "pending" for item in drafts)
    assert scalar(engine, "SELECT COUNT(*) FROM questions") == 0
    assert generator.calls[0][0]["rubric"] == {"Accuracy": 5}
    assert generator.calls[0][0]["course_material_summaries"][0]["summary"].startswith("Recursion")
    retry = client.post(f"{URL}/generate", json=body()).json()
    assert [item["id"] for item in retry["drafts"]] == [item["id"] for item in drafts]
    assert len(generator.calls) == 1
    assert client.post(f"{URL}/generate", json=body(count=1)).status_code == 409


def test_approval_edits_append_bank_once_and_rejects_rebinding(api):
    client, engine, _ = api
    draft = generate(api)[0]
    edit = {"question_text": "Professor-reviewed revised recursion question?", "topic": "Sorting", "difficulty": 4}
    url = f"{URL}/{draft['id']}/approve"
    first = client.post(url, json=edit)
    assert first.status_code == 200, first.text
    assert client.post(url, json=edit).json()["question_id"] == first.json()["question_id"]
    assert scalar(engine, "SELECT COUNT(*) FROM questions") == 1
    assert scalar(engine, "SELECT question_text FROM questions") == edit["question_text"]
    assert scalar(engine, "SELECT avatar_authored_position FROM questions") == 1
    assert client.post(url, json={**edit,"difficulty":2}).status_code == 409
    assert client.post(f"{URL}/{draft['id']}/reject", json={}).status_code == 409


def test_reject_is_idempotent_and_never_inserts_question(api):
    client, engine, _ = api
    draft = generate(api)[0]
    url = f"{URL}/{draft['id']}/reject"
    assert client.post(url, json={}).json()["status"] == "rejected"
    assert client.post(url, json={}).status_code == 200
    assert client.post(f"{URL}/{draft['id']}/approve", json={key:draft[key] for key in ("question_text","topic","difficulty")}).status_code == 409
    assert scalar(engine,"SELECT COUNT(*) FROM questions") == 0


@pytest.mark.parametrize("change", ["UPDATE exam_templates SET status='published'",
    "INSERT INTO exam_sessions(id,exam_template_id,status) VALUES ('active','20000000-0000-4000-8000-000000000001','in_progress')"])
def test_live_or_published_exam_blocks_new_generation_and_approval(api, change):
    client, engine, generator = api
    draft = generate(api)[0]
    with engine.begin() as db:
        db.execute(text(change))
    assert client.get(URL).json()["can_edit"] is False
    assert client.post(f"{URL}/generate", json=body(request_id=str(uuid4()))).status_code == 409
    assert client.post(f"{URL}/{draft['id']}/approve", json={key:draft[key] for key in ("question_text","topic","difficulty")}).status_code == 409
    assert len(generator.calls) == 1


@pytest.mark.parametrize("result", [[{"question_text":"Bad scope","topic":"Unapproved","difficulty":3}]*2,
    [{"question_text":"Same question","topic":"Recursion","difficulty":3}]*2,
    [{"question_text":"One only","topic":"Recursion","difficulty":3}],
    [{"question_text":"Extra output","topic":"Recursion","difficulty":3,"reasoning":"hidden"}]*2,
    [{"question_text":"Wrong difficulty","topic":"Recursion","difficulty":6}]*2])
def test_invalid_model_output_never_reaches_bank(api,result):
    client, engine, generator = api
    generator.result = result
    response = client.post(f"{URL}/generate",json=body())
    assert response.status_code == 502, response.text
    assert scalar(engine,"SELECT COUNT(*) FROM questions") == 0
    assert scalar(engine,"SELECT COUNT(*) FROM question_drafts") == 0
    assert scalar(engine,"SELECT status FROM question_generation_requests") == "failed"


@pytest.mark.parametrize("sql,status", [("UPDATE exam_templates SET title='Changed title'",409),
    ("UPDATE exam_templates SET status='published'",409),
    ("UPDATE user_accounts SET is_active=0 WHERE id='owner'",401),
    ("UPDATE question_generation_requests SET lease_expires_at='2000-01-01T00:00:00+00:00'",409)])
def test_context_authorization_and_lease_rechecked_after_generation(api,sql,status):
    client, engine, generator = api
    def change():
        with engine.begin() as db:
            db.execute(text(sql))
    generator.action = change
    response = client.post(f"{URL}/generate",json=body())
    assert response.status_code == status, response.text
    assert scalar(engine,"SELECT COUNT(*) FROM question_drafts") == 0
    assert scalar(engine,"SELECT COUNT(*) FROM questions") == 0


def test_provider_outage_is_truthful_and_not_retried_implicitly(api):
    client, engine, generator = api
    generator.error = RuntimeError("private-provider-path-must-not-leak")
    response = client.post(f"{URL}/generate",json=body())
    assert response.status_code == 503
    assert "private-provider" not in response.text
    retry = client.post(f"{URL}/generate",json=body())
    assert retry.json()["status"] == "failed"
    assert len(generator.calls) == 1
    assert scalar(engine,"SELECT COUNT(*) FROM questions") == 0


def test_deleted_approved_question_is_not_implicitly_recreated(api):
    client, engine, _ = api
    draft = generate(api)[0]
    edit = {key:draft[key] for key in ("question_text","topic","difficulty")}
    url = f"{URL}/{draft['id']}/approve"
    assert client.post(url,json=edit).status_code == 200
    with engine.begin() as db:
        db.execute(text("DELETE FROM questions"))
    assert client.post(url,json=edit).status_code == 409
    assert scalar(engine,"SELECT COUNT(*) FROM questions") == 0


def test_request_validation_and_cross_draft_identifier(api):
    client, _, generator = api
    for change in ({"count":11},{"difficulty":True},{"topic":"Unapproved"}):
        assert client.post(f"{URL}/generate",json=body(**change)).status_code == 422
    assert client.post(f"{URL}/{uuid4()}/reject",json={}).status_code == 404
    assert not generator.calls


def test_other_professor_cannot_review_a_known_draft(api):
    client, engine, _ = api
    draft = generate(api)[0]
    authenticate(client,"other")
    content = {key:draft[key] for key in ("question_text","topic","difficulty")}
    assert client.post(f"{URL}/{draft['id']}/approve",json=content).status_code == 404
    assert client.post(f"{URL}/{draft['id']}/reject",json={}).status_code == 404
    assert scalar(engine,"SELECT COUNT(*) FROM questions") == 0


@pytest.mark.parametrize("expired",[False,True])
def test_existing_generation_lease_is_not_run_twice(api,expired):
    client, engine, generator = api
    request = question_drafts.GenerationRequest.model_validate(body())
    request_id = str(request.request_id)
    now = datetime.now(timezone.utc)
    with engine.begin() as db:
        db.execute(text("""INSERT INTO question_generation_requests
            (exam_template_id,request_id,professor_id,input_hash,context_hash,status,created_at,lease_expires_at)
            VALUES (:exam,:request,:professor,:hash,:context,'generating',:now,:lease)"""),
            {"exam":EXAM,"request":request_id,"professor":PROFESSOR,
             "hash":question_drafts._hash(request.model_dump(mode="json",exclude={"request_id"})),
             "context":"0"*64,"now":now,"lease":now+timedelta(minutes=-1 if expired else 1)})
    response = client.post(f"{URL}/generate",json=request.model_dump(mode="json"))
    assert response.status_code == 200,response.text
    assert response.json()["status"] == ("failed" if expired else "generating")
    assert not generator.calls
    if not expired:
        assert client.post(f"{URL}/generate",json={**body(), "request_id": str(uuid4())}).status_code == 409


def test_topic_removed_during_generation_never_creates_drafts(api):
    client,engine,generator = api
    def remove_topic():
        with engine.begin() as db:
            db.execute(text("UPDATE exam_templates SET topic_coverage_required='[\"Sorting\"]'"))
    generator.action = remove_topic
    assert client.post(f"{URL}/generate",json=body()).status_code == 422
    assert scalar(engine,"SELECT COUNT(*) FROM question_drafts") == 0


def saved_context(client):
    response = client.get(f"{URL}/context")
    assert response.status_code == 200, response.text
    return response.json()


def context_body(client):
    return {"expected_context_hash": saved_context(client)["context_hash"],
        "topic_coverage_required": ["Recursion", "Sorting"],
        "rubric": {"criteria": [{"name": "Accuracy", "description": "Explain the base case and recursive step.", "max_score": 5}]}}


def test_context_load_preserves_existing_and_explicit_save_is_versioned(api):
    client, engine, _ = api
    initial = saved_context(client)
    assert initial["rubric"] == {"Accuracy":5}
    assert scalar(engine,"SELECT rubric FROM exam_templates") == json.dumps({"Accuracy":5})
    body = context_body(client)
    response = client.put(f"{URL}/context",json=body)
    assert response.status_code == 200,response.text
    assert response.json()["rubric"]["criteria"][0]["max_score"] == 5
    assert response.json()["context_hash"] != initial["context_hash"]
    stale = client.put(f"{URL}/context",json={**body,"topic_coverage_required":["New topic"]})
    assert stale.status_code == 409
    assert saved_context(client)["topic_coverage_required"] == ["Recursion","Sorting"]


@pytest.mark.parametrize("change", [{"topic_coverage_required":[]},
    {"topic_coverage_required":["Recursion","recursion"]},
    {"rubric":{"criteria":[]}},
    {"rubric":{"criteria":[{"name":"Same","max_score":5},{"name":"same","max_score":1}]}},
    {"rubric":{"criteria":[{"name":"Invalid","max_score":True}]}},
    {"rubric":{"criteria":[{"name":"Invalid","max_score":0}]}},
    {"rubric":{"criteria":[{"name":"Invalid","max_score":1001}]}}])
def test_context_rejects_invalid_topics_rubric_and_scores(api,change):
    client, _, _ = api
    body = context_body(client)
    response = client.put(f"{URL}/context",json={**body,**change})
    assert response.status_code == 422,response.text


def test_context_is_professor_private_and_blocks_live_mutations(api):
    client,engine,_ = api
    body = context_body(client)
    authenticate(client,"other")
    assert client.get(f"{URL}/context").status_code == 404
    assert client.put(f"{URL}/context",json=body).status_code == 404
    authenticate(client)
    with engine.begin() as db:
        db.execute(text("UPDATE exam_templates SET status='published'"))
    assert saved_context(client)["can_edit"] is False
    assert client.put(f"{URL}/context",json=body).status_code == 409


def test_new_empty_exam_can_be_configured_through_context_api(api):
    client,engine,_ = api
    with engine.begin() as db:
        db.execute(text("UPDATE exam_templates SET topic_coverage_required='[]',rubric='{}'"))
    body = context_body(client)
    assert client.put(f"{URL}/context",json=body).status_code == 200
    assert client.post(f"{URL}/generate",json={"request_id":str(uuid4()),"topic":"Recursion","difficulty":3,"count":1}).status_code == 200


def test_completed_assessed_attempt_freezes_rubric_but_not_unpublished_draft_listing(api):
    client,engine,_=api
    body=context_body(client)
    with engine.begin() as db:
        db.execute(text("INSERT INTO exam_sessions(id,exam_template_id,status,developer_demo) VALUES ('completed',:exam,'graded',0)"),{"exam":EXAM})
    view=saved_context(client)
    assert view['can_edit'] is False and view['context_locked_after_attempt'] is True
    assert 'new exam' in view['notice']
    assert client.put(f"{URL}/context",json=body).status_code == 409
    assert client.get(URL).json()['can_edit'] is True


def test_completed_demo_attempt_does_not_freeze_professor_rubric(api):
    client,engine,_=api
    body=context_body(client)
    with engine.begin() as db:
        db.execute(text("INSERT INTO exam_sessions(id,exam_template_id,status,developer_demo) VALUES ('demo',:exam,'graded',1)"),{"exam":EXAM})
    assert saved_context(client)['can_edit'] is True
    assert client.put(f"{URL}/context",json=body).status_code == 200
