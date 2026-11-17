"""Owned ephemeral HTTP fixture: production routers + synthetic SQLite ONLY.

No PostgreSQL, application settings, model, real devices, exam-start route or
identity result is used. Private stdin/stdout IPC is consumed by the browser test;
fixture credentials must never be logged by the caller.
"""
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import secrets
import socket
import sqlite3
import sys
from tempfile import TemporaryDirectory
import threading
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
os.environ["AUTH_SECRET_KEY"] = secrets.token_urlsafe(48)
os.environ["AUTH_COOKIE_SECURE"] = "false"
os.environ.pop("DATABASE_URL", None)

from fastapi import FastAPI
import jwt
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import Session
import uvicorn

from backend.app import auth, exam_video, live_video, media_timeline
from backend.app.db import get_db
from backend.app.student_auth import issue_student_token


def run():
    with TemporaryDirectory(prefix="cybros-live-backend-synthetic-") as temporary:
        root = Path(temporary)
        os.environ["EXAM_VIDEO_DIR"] = str(root / "recordings")
        os.environ["EXAM_VIDEO_RETENTION_UNTIL"] = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
        sqlite3.register_converter("UTCSTAMP", lambda value: datetime.fromisoformat(value.decode()).replace(tzinfo=timezone.utc))
        engine = create_engine(f"sqlite:///{(root / 'fixture.sqlite').as_posix()}",
            connect_args={"check_same_thread": False, "detect_types": sqlite3.PARSE_DECLTYPES})
        @event.listens_for(engine, "before_cursor_execute", retval=True)
        def uuid_cast(_connection, _cursor, statement, parameters, _context, _many):
            # PostgreSQL UUID/row-lock syntax only is adapted. Auth/scope/lifecycle
            # queries stay real; PostgreSQL lock semantics are tested separately.
            statement = re.sub(r"CAST\((\?) AS uuid\)", r"\1", statement, flags=re.I)
            statement = re.sub(r"\s+FOR UPDATE\s*$", "", statement, flags=re.I)
            return statement, parameters
        @event.listens_for(engine, "connect")
        def functions(connection, _record):
            connection.create_function("now", 0, lambda: datetime.now(timezone.utc).isoformat())
        sid, exam, student, professor, account, other_professor, other_account, interaction = [str(uuid4()) for _ in range(8)]
        owner_password, other_password = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
        statements = [
            "CREATE TABLE user_accounts(id TEXT PRIMARY KEY,username TEXT,password_hash TEXT,role TEXT,professor_id TEXT,is_active BOOLEAN)",
            "CREATE TABLE exam_templates(id TEXT PRIMARY KEY,professor_id TEXT)",
            "CREATE TABLE exam_sessions(id TEXT PRIMARY KEY,student_id TEXT,exam_template_id TEXT,status TEXT,developer_demo BOOLEAN,ended_at UTCSTAMP,identity_check_completed BOOLEAN DEFAULT 0)",
            "CREATE TABLE interactions(id TEXT PRIMARY KEY,session_id TEXT,sequence_num INTEGER,UNIQUE(session_id,id))",
            """CREATE TABLE exam_session_videos(session_id TEXT PRIMARY KEY,status TEXT,content_type TEXT,
                next_chunk_index INTEGER DEFAULT 0,total_bytes INTEGER DEFAULT 0,file_name TEXT,
                expires_at UTCSTAMP,completed_at UTCSTAMP)""",
            """CREATE TABLE exam_media_events(event_order INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT,event_id TEXT,interaction_id TEXT,question_sequence_num INTEGER,
                kind TEXT,source TEXT,asset_id TEXT,media_offset_seconds REAL,reported_media_offset_seconds REAL,
                offset_status TEXT,offset_basis TEXT,payload_hash TEXT,received_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(session_id,event_id),FOREIGN KEY(session_id,interaction_id) REFERENCES interactions(session_id,id))""",
        ]
        with engine.begin() as db:
            for statement in statements:
                db.execute(text(statement))
            for aid, pid, username, password in ((account, professor, "synthetic-owner", owner_password),
                                                (other_account, other_professor, "synthetic-other", other_password)):
                db.execute(text("INSERT INTO user_accounts VALUES (:id,:username,:password,'professor',:pid,1)"),
                    {"id":aid,"username":username,"password":auth.password_hash.hash(password),"pid":pid})
            db.execute(text("INSERT INTO exam_templates VALUES (:exam,:professor)"),{"exam":exam,"professor":professor})
            # Declared contract rows, never fake a photo-check or call exam/start.
            db.execute(text("INSERT INTO exam_sessions VALUES (:sid,:student,:exam,'in_progress',0,NULL,0)"),
                       {"sid":sid,"student":student,"exam":exam})
            db.execute(text("INSERT INTO interactions VALUES (:iid,:sid,1)"),{"iid":interaction,"sid":sid})
        app = FastAPI()
        for router in (auth.router, live_video.router, exam_video.router, media_timeline.router):
            app.include_router(router, prefix="/api")
        def database():
            with Session(engine) as db:
                yield db
        app.dependency_overrides[get_db] = database
        @app.get("/__fixture/ready")
        def ready():
            return {"fixture": "synthetic-sqlite-only", "real_devices": False}
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(app, log_level="error", access_log=False))
        def emit(value):
            sys.stdout.write(json.dumps(value) + "\n")
            sys.stdout.flush()
        def control():
            for line in sys.stdin:
                command = json.loads(line)
                operation = command["operation"]
                result = {"kind":"control","request_id":command["request_id"]}
                if operation == "stop":
                    server.should_exit = True
                elif operation == "clear_rooms":
                    with live_video._lock:
                        live_video._rooms.clear()
                elif operation == "short_professor_cookie":
                    result["cookie"] = jwt.encode({"sub":account,"role":"professor",
                        "exp":datetime.now(timezone.utc)+timedelta(seconds=2)},auth.get_secret(),algorithm="HS256")
                elif operation == "state":
                    with engine.connect() as db:
                        result["attempt_status"] = db.execute(text("SELECT status FROM exam_sessions WHERE id=:sid"),{"sid":sid}).scalar_one()
                        video = db.execute(text("SELECT status,total_bytes FROM exam_session_videos WHERE session_id=:sid"),{"sid":sid}).mappings().first()
                        result["video"] = dict(video) if video else None
                    with live_video._lock:
                        result["room_ids"] = [str(room.room_id) for room in live_video._rooms.values()]
                else:
                    raise RuntimeError("Unknown private fixture operation")
                emit(result)
            server.should_exit = True
        threading.Thread(target=control, daemon=True).start()
        token = issue_student_token(student_id=student,exam_template_id=exam,purpose="student_session",session_id=sid,minutes=3)
        expired = issue_student_token(student_id=student,exam_template_id=exam,purpose="student_session",session_id=sid,minutes=-1)
        emit({"kind":"fixture","origin":f"http://127.0.0.1:{port}","session_id":sid,
            "student_token":token,"expired_student_token":expired,
            "owner":{"username":"synthetic-owner","password":owner_password},
            "other":{"username":"synthetic-other","password":other_password}})
        try:
            server.run(sockets=[sock])
        finally:
            sock.close()
            engine.dispose()


if __name__ == "__main__":
    run()
