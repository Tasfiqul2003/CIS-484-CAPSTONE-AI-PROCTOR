"""P3 native full-stack launcher. Runtime data and secrets stay in private-data/."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from functools import wraps
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "private-data" / "p3-local"
CONFIG = DATA / "settings.json"
STATE = DATA / "processes.json"
PG = ROOT / ".cache" / "postgres" / "Library" / "bin"
PYTHON = ROOT / ".venv" / "Scripts" / "python.exe"
NODE = Path(r"C:\Program Files\nodejs\node.exe")
OLLAMA = Path(r"C:\Users\Paulo\AppData\Local\Programs\Ollama\ollama.exe")


@contextmanager
def lifecycle_lock():
    """Serialize P3 start/stop/init/maintenance without stale filesystem flags."""
    if os.name != 'nt':
        raise RuntimeError('The P3 native lifecycle requires Windows.')
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
    kernel.CreateMutexW.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.ReleaseMutex.argtypes = [wintypes.HANDLE]
    kernel.ReleaseMutex.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    key = hashlib.sha256(str(ROOT.resolve()).casefold().encode()).hexdigest()[:24]
    handle = kernel.CreateMutexW(None, False, 'Local\\CYBROS_P3_' + key)
    if not handle:
        raise RuntimeError('Unable to reserve the local CYBROS lifecycle.')
    acquired = False
    try:
        acquired = kernel.WaitForSingleObject(handle, 0) in (0, 128)
        if not acquired:
            raise RuntimeError('Another CYBROS startup, shutdown or maintenance operation is running. Wait for it to finish.')
        yield
    finally:
        if acquired:
            kernel.ReleaseMutex(handle)
        kernel.CloseHandle(handle)


def lifecycle_operation(operation):
    @wraps(operation)
    def exclusive(*args, **kwargs):
        with lifecycle_lock():
            return operation(*args, **kwargs)
    return exclusive


def load():
    return json.loads(CONFIG.read_text())


def environment(cfg):
    env = os.environ.copy()
    env.update({
        "DATABASE_URL": f"postgresql+psycopg2://proctor:{cfg['db_password']}@127.0.0.1:55432/cybros_p3",
        "PGPASSWORD": cfg["db_password"],
        "AUTH_SECRET_KEY": cfg["auth_secret"],
        "ADMIN_BOOTSTRAP_TOKEN": cfg["bootstrap_token"],
        "AUTH_COOKIE_SECURE": "false",
        "DEVELOPER_DEMO_MODE": "0", "DEVELOPER_MINIMAL_MODE": "0",
        "AVATAR_SERVICE_URL": "", "AVATAR_SERVICE_TOKEN": "",
        "CYBROS_DEVELOPER_FACE_BYPASS": "1" if cfg.get("developer_face_bypass_enabled") is True else "0",
        "OLLAMA_URL": "http://127.0.0.1:11434",
        "OLLAMA_MODEL": cfg["model"],
        # P3's installed offline engine was verified with generated WAV only.
        # Set speech_provider to "disabled" in private settings to opt out.
        "CYBROS_SPEECH_PROVIDER": cfg.get("speech_provider", "windows-system-speech"),
        "EXAM_VIDEO_DIR": str(DATA / "recordings"),
        "EXAM_VIDEO_RETENTION_UNTIL": cfg.get("recording_retention_until", ""),
        "FACE_DETECTOR_MODEL_PATH": str(ROOT / "models" / "face_detection_yunet_2023mar.onnx"),
        "FACE_RECOGNIZER_MODEL_PATH": str(ROOT / "models" / "face_recognition_sface_2021dec.onnx"),
        "PATH": str(PG) + os.pathsep + str(NODE.parent) + os.pathsep + env["PATH"],
    })
    return env


def service_environment(cfg, service):
    """Only the backend receives application/DB credentials.

    The frontend dev server and an owned model daemon need OS paths, not auth,
    database, private recording or bootstrap configuration. External daemons keep
    their existing environment and lifecycle.
    """
    if service == 'backend':
        return environment(cfg)
    if service not in ('frontend', 'ollama'):
        raise ValueError('Unknown local service')
    allowed = ('SystemRoot', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP', 'USERPROFILE',
               'LOCALAPPDATA', 'APPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
               'CommonProgramFiles', 'CommonProgramFiles(x86)', 'ComSpec')
    env = {key: os.environ[key] for key in allowed if os.environ.get(key)}
    windows = Path(env.get('SystemRoot', r'C:\Windows'))
    env['PATH'] = os.pathsep.join((str(NODE.parent), str(windows/'System32'), str(windows)))
    if service == 'ollama':
        env['OLLAMA_HOST'] = '127.0.0.1:11434'
        if os.environ.get('OLLAMA_MODELS'):
            env['OLLAMA_MODELS'] = os.environ['OLLAMA_MODELS']
    return env


def port_open(port):
    with socket.socket() as connection:
        connection.settimeout(0.3)
        return connection.connect_ex(("127.0.0.1", port)) == 0


def probe(url):
    """Readiness is separate from a listening socket; never print response bodies."""
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            return response.status == 200
    except (OSError, ValueError):
        return False


def status():
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    endpoints = {"backend": (8000, "http://127.0.0.1:8000/health/ready"),
                 "frontend": (5173, "http://127.0.0.1:5173/api/health/ready"),
                 "ollama": (11434, "http://127.0.0.1:11434/api/version")}
    result = {}
    for name, (port, url) in endpoints.items():
        listening = port_open(port)
        entry = state.get(name)
        result[name] = {"listening": listening, "owned_process_alive": bool(entry and owned(entry)),
                        "ready": probe(url) if listening else False}
    result["database"] = {"listening": port_open(55432)}
    return result


def run(args, cfg, **kwargs):
    return subprocess.run([str(x) for x in args], env=environment(cfg), check=True,
                          creationflags=subprocess.CREATE_NO_WINDOW, **kwargs)


def pg_running(cfg):
    return subprocess.run([str(PG / "pg_ctl.exe"), "-D", str(DATA / "pgdata"), "status"],
                          env=environment(cfg), stdout=subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW).returncode == 0


def start_db(cfg):
    if not pg_running(cfg):
        if port_open(55432):
            raise RuntimeError("Port 55432 belongs to another process; refusing to replace it.")
        run([PG / "pg_ctl.exe", "-D", DATA / "pgdata", "-l", DATA / "postgres.log", "-w", "start"], cfg)


@lifecycle_operation
def init():
    DATA.mkdir(parents=True, exist_ok=True)
    if not CONFIG.exists():
        if (DATA / "pgdata").exists():
            raise RuntimeError("Existing PG data without settings; refusing to initialize.")
        cfg = {"db_password": secrets.token_hex(24), "auth_secret": secrets.token_hex(48),
               "bootstrap_token": secrets.token_hex(32), "model": "cybros-p3-qwen3-4b"}
        with CONFIG.open("x") as stream:
            json.dump(cfg, stream, indent=2)
    cfg = load()
    (DATA / "recordings").mkdir(exist_ok=True)
    if not (DATA / "pgdata").exists():
        password_file = DATA / "init-password.tmp"
        try:
            password_file.write_text(cfg["db_password"], encoding="utf-8")
            run([PG / "initdb.exe", "-D", DATA / "pgdata", "-U", "proctor", "--encoding=UTF8",
                 "--locale=C", "--auth=scram-sha-256", "--pwfile", password_file], cfg)
        finally:
            password_file.unlink(missing_ok=True)
        with (DATA / "pgdata" / "postgresql.conf").open("a") as stream:
            stream.write("\nlisten_addresses = '127.0.0.1'\nport = 55432\n")
    start_db(cfg)
    from sqlalchemy import create_engine, text
    from sqlalchemy.engine import make_url
    url = make_url(environment(cfg)["DATABASE_URL"])
    engine = create_engine(url.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with engine.connect() as connection:
        if not connection.execute(text("SELECT 1 FROM pg_database WHERE datname='cybros_p3'")).scalar():
            connection.exec_driver_sql("CREATE DATABASE cybros_p3")
    engine.dispose()
    sys.path.insert(0, str(ROOT / "scripts"))
    from developer_migrate import apply_migrations, load_migrations
    engine = create_engine(url)
    with engine.begin() as connection:
        applied = apply_migrations(connection, load_migrations(ROOT / "database"))
    engine.dispose()
    print(f"P3 database ready; {len(applied)} migrations applied.")


def owned(entry):
    import psutil
    try:
        process = psutil.Process(entry["pid"])
        return process if abs(process.create_time() - entry["created"]) < 0.1 else None
    except psutil.Error:
        return None


@lifecycle_operation
def start():
    import psutil
    cfg = load()
    start_db(cfg)
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    services = {
        "ollama": (11434, [OLLAMA, "serve"], ROOT),
        "backend": (8000, [PYTHON, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000"], ROOT / "backend"),
        "frontend": (5173, [NODE, ROOT / "frontend/node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5173", "--strictPort"], ROOT / "frontend"),
    }
    for name, (port, command, cwd) in services.items():
        if name in state and owned(state[name]):
            continue
        if port_open(port):
            if name == "ollama":
                print("Reusing external Ollama; stop leaves it running.")
                state.pop(name, None)
                continue
            raise RuntimeError(f"Port {port} is occupied by an unowned process.")
        with (DATA / f"{name}.log").open("ab") as log:
            process = subprocess.Popen([str(x) for x in command], cwd=cwd, env=service_environment(cfg, name),
                stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP)
        state[name] = {"pid": process.pid, "created": psutil.Process(process.pid).create_time()}
        STATE.write_text(json.dumps(state, indent=2))
        deadline = time.monotonic() + 45
        while not port_open(port):
            if process.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError(f"{name} failed to start; see its private log.")
            time.sleep(0.5)
    for url in ["http://127.0.0.1:8000/health/ready", "http://127.0.0.1:5173/api/health/ready"]:
        deadline = time.monotonic() + 30
        while not probe(url):
            if time.monotonic() >= deadline:
                raise RuntimeError("CYBROS is not ready. Check private service logs and reviewed database migrations; no automatic reset or retry loop was started.")
            time.sleep(0.5)
    print("CYBROS full mode: http://127.0.0.1:5173 (SoulX/FlashHead excluded).")


@lifecycle_operation
def stop():
    import psutil
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    for name in ("frontend", "backend", "ollama"):
        process = owned(state.get(name, {})) if name in state else None
        if process:
            children = process.children(recursive=True)
            for child in children:
                child.terminate()
            process.terminate()
            _, alive = psutil.wait_procs([process, *children], timeout=10)
            for child in alive:
                child.kill()
    STATE.write_text("{}")
    cfg = load()
    if pg_running(cfg):
        run([PG / "pg_ctl.exe", "-D", DATA / "pgdata", "-m", "fast", "-w", "stop"], cfg)
    print("Stopped launcher-owned services and P3 database; data preserved.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["init", "start", "stop", "status"])
    action = parser.parse_args().action
    if action == "status":
        print(json.dumps(status()))
    else:
        globals()[action]()
