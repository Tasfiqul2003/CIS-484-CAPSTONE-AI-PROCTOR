"""Interactive laptop launcher. Importing this module starts no services.

Only the local Ollama provider switch has an application integration here.
Unavailable provider choices remain off; the dedicated developer stack's
labeled substitutes and built-in browser presentation are separate.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import getpass
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import URLError
from urllib.parse import quote, urlsplit
from urllib.request import ProxyHandler, Request, build_opener
import webbrowser

ROOT = Path(__file__).resolve().parents[1]
CONFIG_NAME = ".developer-settings.json"
FEATURES = ("local_ai", "transcription", "voice", "avatar", "camera_recording")
TITLES = {
    "local_ai": "Start local AI model?",
    "transcription": "Enable speech recognition?",
    "voice": "Enable voice playback?",
    "avatar": "Enable animated avatar?",
    "camera_recording": "Enable camera recording?",
}
# Relative estimates for the displayed configurations, not measured benchmarks.
RESOURCE_LOAD = {
    "local_ai": "HEAVY",
    "transcription": "LIGHT",
    "voice": "LIGHT",
    "avatar": "HEAVY",
    "camera_recording": "LIGHT",
}
CORE_LABEL = "Core [LIGHT]: React/Vite frontend, FastAPI backend, PostgreSQL 16 (always started)."
LOAD_GUIDANCE = (
    "HEAVY = high RAM/CPU/GPU demand; LIGHT = lower demand relative to the AI/avatar options.\n"
    "Estimates only: model size, speech processing, and recording settings affect usage.\n"
    "First-time Docker builds/downloads can be HEAVY even with optional features off."
)
LIGHT_COMPUTER_GUIDANCE = (
    "\nRecommended for light computers: choose N for all five optional features.\n"
    "The core website still starts; labeled developer substitutes cover unavailable optional services.\n"
    "This is a suggestion; your choices and saved defaults remain under your control."
)
DEMO_NOTICE = (
    "DEVELOPER DEMO MODE: this separate stack enables labeled substitutes when optional services "
    "or exam content are unavailable. Real providers are used when available.\n"
    "Demo-marked attempts stay demo; substitutes do not establish grades or real verification.\n"
    "Authentication, roster eligibility, the database, migrations, Docker, Node, and ports remain real requirements."
)
UNAVAILABLE = {
    "transcription": "The standalone voice prototype is not connected to the web exam.",
    "voice": "Piper playback is not connected to the web exam.",
    "avatar": "No FlashHead service or web renderer adapter is implemented.",
    "camera_recording": "Browser camera recording is not implemented in the web exam.",
}


class StartupError(Exception):
    """An actionable startup error without secret-bearing command output."""


class StartupCancelled(Exception):
    pass


def validate_choices(value: object) -> dict[str, bool]:
    if not isinstance(value, dict) or set(value) != set(FEATURES):
        raise ValueError("Settings must contain exactly the five developer choices.")
    if any(type(item) is not bool for item in value.values()):
        raise ValueError("Developer choices must be true or false.")
    if any(value[key] for key in UNAVAILABLE):
        raise ValueError("Settings enable a web integration that is unavailable in this checkout.")
    return dict(value)


def load_choices(path: Path) -> dict[str, bool]:
    if not path.exists():
        return dict.fromkeys(FEATURES, False)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise StartupError(f"Cannot read {path.name}. Fix or rename that file before starting.") from exc
    try:
        if not isinstance(value, dict) or set(value) != {"version", "choices"}:
            raise ValueError("Unexpected settings format.")
        if type(value["version"]) is not int or value["version"] != 1:
            raise ValueError("Unsupported settings version.")
        return validate_choices(value["choices"])
    except ValueError as exc:
        raise StartupError(f"Invalid {path.name}: {exc} The file was left unchanged.") from exc


def save_choices(path: Path, choices: dict[str, bool]) -> None:
    data = {"version": 1, "choices": validate_choices(choices)}
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=".developer-settings-", suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            json.dump(data, handle, indent=2)
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def ask_yes_no(prompt: str, default: bool, input_fn=input, output_fn=print) -> bool:
    while True:
        try:
            answer = input_fn(f"{prompt} [Y/N] ({'Y' if default else 'N'}): ").strip().lower()
        except EOFError as exc:
            raise StartupCancelled("Input closed; nothing was started.") from exc
        if not answer:
            return default
        if answer in ("y", "yes"):
            return True
        if answer in ("n", "no"):
            return False
        output_fn("Type Y or N, or press Enter to keep the displayed default.")


def command_output(args: list[str], timeout: float = 5) -> str | None:
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=timeout,
                                shell=False, creationflags=hidden_flags())
        return result.stdout.strip() if result.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def hidden_flags() -> int:
    return getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0


def find_tool(name: str, environ: dict) -> str | None:
    """Find an installed tool even when a newly installed app is absent from PATH."""
    environment = {key.upper(): value for key, value in environ.items()}
    executable = shutil.which(name, path=environment.get("PATH", ""))
    if executable:
        return executable

    locations = {
        "node": (
            ("LOCALAPPDATA", "Programs/nodejs/node.exe"),
            ("LOCALAPPDATA", "Programs/Node.js/node.exe"),
            ("ProgramW6432", "nodejs/node.exe"),
            ("ProgramFiles", "nodejs/node.exe"),
            ("ProgramFiles(x86)", "nodejs/node.exe"),
        ),
        "docker": (
            ("LOCALAPPDATA", "Programs/DockerDesktop/resources/bin/docker.exe"),
            ("ProgramW6432", "Docker/Docker/resources/bin/docker.exe"),
            ("ProgramFiles", "Docker/Docker/resources/bin/docker.exe"),
        ),
        "ollama": (
            ("LOCALAPPDATA", "Programs/Ollama/ollama.exe"),
            ("ProgramW6432", "Ollama/ollama.exe"),
            ("ProgramFiles", "Ollama/ollama.exe"),
        ),
    }
    checked = set()
    for variable, relative in locations.get(name, ()):
        if not environment.get(variable.upper()):
            continue
        candidate = Path(environment[variable.upper()]) / relative
        if candidate in checked:
            continue
        checked.add(candidate)
        try:
            if candidate.is_file():
                return str(candidate)
        except OSError:
            continue
    return None


def with_tool_paths(base: dict, *executable_paths: str | None) -> dict:
    """Give child processes installed helper directories without changing system PATH."""
    env = {key: value for key, value in base.items() if key.upper() != "PATH"}
    directories = [str(Path(executable).parent) for executable in executable_paths if executable]
    for key, value in base.items():
        if key.upper() == "PATH":
            directories.extend(value.split(os.pathsep))
    unique, seen = [], set()
    for directory in directories:
        # Windows paths are case-insensitive; preserve the first literal spelling.
        identity = directory.replace("\\", "/").rstrip("/").casefold()
        if identity and identity not in seen:
            seen.add(identity)
            unique.append(directory)
    env["PATH"] = os.pathsep.join(unique)
    return env


def check_docker_engine(docker: str) -> None:
    """Check Linux-engine readiness before requesting any development secrets."""
    engine = command_output([docker, "info", "--format", "{{.OSType}}"], timeout=10)
    if engine is None or not engine.strip():
        raise StartupError(
            "Docker's Linux engine is not ready. Start Docker Desktop, finish its WSL 2 setup, "
            "and wait until the engine is running before trying again."
        )
    if engine.strip().lower() != "linux":
        raise StartupError(
            "The developer stack requires Linux containers. Switch Docker Desktop to Linux "
            "containers and finish its WSL 2 setup before trying again."
        )


def local_json(path: str, timeout: float = 0.5) -> dict | None:
    """Read local Ollama metadata only; never send a generation/download request."""
    try:
        opener = build_opener(ProxyHandler({}))
        with opener.open(f"http://127.0.0.1:11434{path}", timeout=timeout) as response:
            value = json.load(response)
        return value if isinstance(value, dict) else None
    except (OSError, URLError, ValueError):
        return None


def package_versions(python: str) -> dict:
    code = (
        "import importlib.metadata as m,json; result={}; "
        "\nfor name in ('faster-whisper','piper-tts'):"
        "\n try: result[name]=m.version(name)"
        "\n except m.PackageNotFoundError: result[name]='Not installed'"
        "\nprint(json.dumps(result))"
    )
    output = command_output([python, "-B", "-c", code])
    try:
        return json.loads(output) if output else {}
    except ValueError:
        return {}


def model_description(root: Path, model: str) -> str:
    files = {
        "cybros-v2": "Modelfile-cybros-v2",
        "oral-examiner-v2": "Modelfile-v2",
        "oral-examiner-v3": "Modelfile-v3",
        "oral-examiner-v4": "Modelfile-v4",
    }
    filename = files.get(model.removesuffix(":latest"))
    if filename:
        for line in (root / "ollama" / filename).read_text(encoding="utf-8").splitlines():
            if line.strip().startswith("FROM "):
                return f"{model} | configured base {line.strip()[5:]}"
    return f"{model} | base model Unknown"


def discover(root: Path, environ: dict) -> dict:
    python = root / ".venv" / "Scripts" / "python.exe"
    versions = package_versions(str(python) if python.exists() else sys.executable)
    ollama = find_tool("ollama", environ)
    server = local_json("/api/version")
    cli = command_output([ollama, "--version"]) if ollama and not server else None
    runtime = (f"Ollama server {server.get('version', 'Unknown')}" if server else
               f"Ollama CLI {cli}; server not running" if cli else
               "Ollama Unknown; server not running" if ollama else "Ollama Not installed")
    model = environ.get("DEVELOPER_OLLAMA_MODEL", "cybros-v2").strip()
    if not model or any(char.isspace() for char in model):
        raise StartupError("DEVELOPER_OLLAMA_MODEL must be a nonempty Ollama model name.")
    flashhead = "SoulX-FlashHead Not configured; revision Unknown | proposed Lite 1.3B"
    if environ.get("DEVELOPER_FLASHHEAD_DIR"):
        checkout = Path(environ["DEVELOPER_FLASHHEAD_DIR"])
        if checkout.is_dir():
            git = shutil.which("git")
            revision = command_output([git, "-C", str(checkout), "rev-parse", "--short", "HEAD"]) if git else None
            flashhead = f"SoulX-FlashHead checkout {revision or 'Unknown'} | proposed Lite 1.3B; model installation Unknown"
        else:
            flashhead = "SoulX-FlashHead Not installed at configured path; revision Unknown | proposed Lite 1.3B"
    labels = {
        "local_ai": f"{runtime} | {model_description(root, model)}",
        "transcription": f"Faster-Whisper {versions.get('faster-whisper', 'Unknown')} | base.en | CPU INT8",
        "voice": f"Piper {versions.get('piper-tts', 'Unknown')} | en_US-lessac-medium",
        "avatar": flashhead,
        "camera_recording": "Browser camera recording | No AI model",
    }
    available = {key: key == "local_ai" and bool(ollama or server) for key in FEATURES}
    return {"labels": labels, "available": available, "ollama": ollama, "model": model}


def show_menu(inventory: dict, defaults: dict, output_fn=print) -> None:
    output_fn("\nOralExam AI - Developer Startup\n")
    output_fn(CORE_LABEL)
    output_fn(LOAD_GUIDANCE)
    output_fn(LIGHT_COMPUTER_GUIDANCE)
    output_fn(DEMO_NOTICE)
    output_fn("Model names are configured selections; installed model availability is checked before launch.\n")
    for key in FEATURES:
        output_fn(f"{TITLES[key]} [{RESOURCE_LOAD[key]}]\n  ({inventory['labels'][key]})")
        if not inventory["available"][key]:
            output_fn(f"  Unavailable: {UNAVAILABLE.get(key, 'Install Ollama or start its local service first.')}")
        output_fn(f"  Saved default: {'Y' if defaults[key] else 'N'}\n")


def collect_choices(inventory: dict, defaults: dict, input_fn=input, output_fn=print) -> dict:
    selected = {}
    for key in FEATURES:
        output_fn(f"\n{TITLES[key]} [{RESOURCE_LOAD[key]}]\n  ({inventory['labels'][key]})")
        reason = UNAVAILABLE.get(key, "Install Ollama or start its local service first.")
        if not inventory["available"][key]:
            output_fn(f"  Unavailable: {reason}")
        while True:
            enabled = ask_yes_no("  Activate", defaults[key] and inventory["available"][key], input_fn, output_fn)
            if enabled and not inventory["available"][key]:
                output_fn(f"  Cannot activate: {reason} Choose N to continue.")
                continue
            selected[key] = enabled
            break
    return validate_choices(selected)


def validate_endpoint(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
        raise StartupError("DEVELOPER_OLLAMA_URL must be an HTTP(S) endpoint without embedded credentials.")
    if parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        raise StartupError("DEVELOPER_OLLAMA_URL must contain only scheme, host, and optional port.")
    try:
        parsed.port
    except ValueError as exc:
        raise StartupError("DEVELOPER_OLLAMA_URL has an invalid port.") from exc
    return value.rstrip("/")


def build_plan(root: Path, choices: dict, model: str, endpoint: str, docker="docker", node="node") -> dict:
    validate_choices(choices)
    endpoint = validate_endpoint(endpoint)
    if choices["local_ai"]:
        endpoint = "http://host.docker.internal:11434"
    compose = [docker, "compose", "--env-file", str(root / ".env.example"),
               "-f", str(root / "compose.developer.yaml"), "-p", "oralexam-developer"]
    return {
        "compose": compose,
        "core": compose + ["up", "--build", "-d", "--wait", "backend"],
        "frontend": [node, str(root / "frontend" / "node_modules" / "vite" / "bin" / "vite.js"),
                     "--host", "127.0.0.1", "--port", "5173", "--strictPort"],
        "model": model, "endpoint": endpoint, "local_ai": choices["local_ai"],
    }


def service_environment(base: dict, plan: dict, password_fn=getpass.getpass) -> dict:
    env = dict(base)
    password = env.get("DEVELOPER_POSTGRES_PASSWORD") or password_fn(
        "Developer database password (reuse it for this database on later starts): ")
    bootstrap = env.get("DEVELOPER_ADMIN_BOOTSTRAP_TOKEN") or password_fn(
        "Developer admin bootstrap token (at least 16 characters; retain it for account setup): ")
    if not password or len(bootstrap) < 16:
        raise StartupError("A database password and an admin bootstrap token of at least 16 characters are required.")
    env.update({
        "DEVELOPER_POSTGRES_PASSWORD": password,
        "DEVELOPER_DATABASE_URL": f"postgresql+psycopg2://proctor:{quote(password, safe='')}@db:5432/oralexam_developer",
        "DEVELOPER_AUTH_SECRET_KEY": env.get("DEVELOPER_AUTH_SECRET_KEY") or secrets.token_urlsafe(48),
        "DEVELOPER_ADMIN_BOOTSTRAP_TOKEN": bootstrap,
        "DEVELOPER_OLLAMA_MODEL": plan["model"],
        "DEVELOPER_OLLAMA_URL": plan["endpoint"],
    })
    return env


def run_command(args: list[str], root: Path, env: dict, capture=False, timeout=30) -> str:
    try:
        result = subprocess.run(args, cwd=root, env=env, shell=False, text=True,
                                capture_output=capture, check=False, timeout=timeout,
                                creationflags=hidden_flags())
    except subprocess.TimeoutExpired as exc:
        raise StartupError(f"{Path(args[0]).name} did not finish within {timeout} seconds.") from exc
    except OSError as exc:
        raise StartupError(f"Could not start {Path(args[0]).name}.") from exc
    if result.returncode:
        raise StartupError(f"{Path(args[0]).name} exited with code {result.returncode}. Review its output or Docker Desktop.")
    return result.stdout.strip() if capture else ""


def stop_process(process) -> None:
    if process is not None and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def wait_for_http(url: str, process, timeout=45) -> None:
    deadline = time.monotonic() + timeout
    opener = build_opener(ProxyHandler({}))
    while time.monotonic() < deadline:
        if process is not None and process.poll() is not None:
            raise StartupError("A developer process exited before it became ready.")
        try:
            with opener.open(Request(url), timeout=1) as response:
                if response.status == 200:
                    return
        except (OSError, URLError):
            pass
        time.sleep(0.25)
    raise StartupError(f"Timed out waiting for {url}.")


def check_free_ports() -> None:
    for port in (8000, 5173, 55432):
        with socket.socket() as probe:
            probe.settimeout(0.2)
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                raise StartupError(f"Port {port} is already in use. Existing services were left running.")


@contextmanager
def session_lock(root: Path):
    """Keep concurrent launchers from sharing ownership of a developer project."""
    handle = (root / ".developer-session.lock").open("a+b")
    try:
        if handle.seek(0, os.SEEK_END) == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise StartupError("Another developer launcher is already active for this checkout.") from exc
        yield
    finally:
        # Closing releases the OS lock. Leave the inert file in place so a new
        # launch cannot lock a different file while another handle still exists.
        handle.close()


def launch(root: Path, inventory: dict, plan: dict, env: dict) -> None:
    with session_lock(root):
        launch_services(root, inventory, plan, env)


def launch_services(root: Path, inventory: dict, plan: dict, env: dict) -> None:
    owned_ai = owned_frontend = None
    core_started = False
    local_ai_ready = False
    ai_exit_reported = False
    try:
        # A fixed separate project plus this guard prevents taking over an existing stack.
        if run_command(plan["compose"] + ["ps", "--status", "running", "-q"], root, env, capture=True):
            raise StartupError("The developer stack is already running. Stop it separately before using this launcher.")
        check_free_ports()
        print(DEMO_NOTICE)
        if plan["local_ai"]:
            try:
                if local_json("/api/version") is None:
                    if not inventory["ollama"]:
                        raise StartupError("Ollama is unavailable.")
                    # Keep the host service local. Container connectivity is checked below.
                    ai_env = dict(env, OLLAMA_HOST="127.0.0.1:11434")
                    owned_ai = subprocess.Popen([inventory["ollama"], "serve"], cwd=root,
                                                env=ai_env, shell=False, creationflags=hidden_flags(),
                                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    wait_for_http("http://127.0.0.1:11434/api/version", owned_ai)
                tags = local_json("/api/tags") or {}
                models = tags.get("models", [])
                names = {
                    item["name"] for item in models
                    if isinstance(item, dict) and isinstance(item.get("name"), str)
                } if isinstance(models, list) else set()
                desired = plan["model"] if ":" in plan["model"] else plan["model"] + ":latest"
                if desired not in names and plan["model"] not in names:
                    raise StartupError(f"Model {plan['model']} is not installed. No model was downloaded.")
                local_ai_ready = True
            except (StartupError, OSError) as exc:
                reason = str(exc) if isinstance(exc, StartupError) else "The optional Ollama process could not start."
                print(f"Warning: {reason} Continuing core startup with labeled developer demo fallback available.")
        print(f"Backend model: {plan['model']} at {plan['endpoint']}")
        print("Starting developer database, migrations, and backend...")
        core_started = True  # Also clean up partially started services if Compose fails.
        # Initial image builds may take longer than metadata/cleanup commands.
        # Ctrl+C still cancels the build and enters owned-service cleanup.
        run_command(plan["core"], root, env, timeout=None)
        wait_for_http("http://127.0.0.1:8000/health", None)
        if local_ai_ready:
            probe = ("import os,urllib.request; "
                     "urllib.request.urlopen(os.environ['OLLAMA_URL']+'/api/tags', timeout=5).close()")
            try:
                run_command(plan["compose"] + ["exec", "-T", "backend", "python", "-c", probe], root, env, capture=True)
            except StartupError:
                print("Warning: the Docker backend cannot reach local Ollama. Continuing with labeled developer demo fallback available; see docs/developer-startup.md.")
        owned_frontend = subprocess.Popen(plan["frontend"], cwd=root / "frontend", env=env,
                                          shell=False, creationflags=hidden_flags())
        wait_for_http("http://127.0.0.1:5173", owned_frontend)
        print("\nDeveloper app: http://127.0.0.1:5173")
        print("Optional Faster-Whisper, Piper, FlashHead, and recording providers remain off. Built-in web presentation and labeled demo substitutes are separate.")
        print("Keep this window open. Press Ctrl+C to stop services started by this launcher.")
        webbrowser.open("http://127.0.0.1:5173")
        while True:
            if owned_frontend.poll() is not None:
                raise StartupError("The frontend exited. Stopping the developer session.")
            if owned_ai is not None and owned_ai.poll() is not None and not ai_exit_reported:
                print("Warning: the optional local AI service exited. Core services remain running; labeled developer demo fallback is available.")
                ai_exit_reported = True
            time.sleep(1)
    finally:
        previous = signal.signal(signal.SIGINT, signal.SIG_IGN)
        try:
            try:
                stop_process(owned_frontend)
            except (OSError, subprocess.TimeoutExpired) as exc:
                print(f"Frontend cleanup failed ({type(exc).__name__}); close its developer process manually.")
            if core_started:
                try:
                    run_command(plan["compose"] + ["stop"], root, env)
                except StartupError as exc:
                    print(f"Cleanup: {exc} Stop the oralexam-developer project in Docker Desktop.")
            try:
                stop_process(owned_ai)
            except (OSError, subprocess.TimeoutExpired) as exc:
                print(f"Ollama cleanup failed ({type(exc).__name__}); close the process started by this launcher manually.")
        finally:
            signal.signal(signal.SIGINT, previous)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--show-menu", action="store_true", help="Inspect versions and choices without starting or saving anything.")
    parser.add_argument("--dry-run", action="store_true", help="Answer the menu and inspect the plan without saving or starting services.")
    args = parser.parse_args(argv)
    try:
        defaults = load_choices(ROOT / CONFIG_NAME)
        inventory = discover(ROOT, os.environ)
        if args.show_menu:
            show_menu(inventory, defaults)
            return 0
        print("\nOralExam AI - Developer Startup")
        print(CORE_LABEL)
        print(LOAD_GUIDANCE)
        print(LIGHT_COMPUTER_GUIDANCE)
        print("Unavailable integrations require N; the menu does not simulate successful activation.")
        choices = collect_choices(inventory, defaults)
        save = ask_yes_no("\nSave choices as defaults?", True)
        endpoint = os.environ.get("DEVELOPER_OLLAMA_URL", "http://host.docker.internal:11434")
        docker = find_tool("docker", os.environ)
        node = find_tool("node", os.environ)
        plan = build_plan(ROOT, choices, inventory["model"], endpoint, docker or "docker", node or "node")
        if args.dry_run:
            print("\nDry run: no choices saved; no services, model downloads, or recordings started.")
            print(json.dumps(plan, indent=2))
            return 0
        if not docker or not node or not (ROOT / "frontend/node_modules/vite/bin/vite.js").is_file():
            raise StartupError("Docker Compose, Node.js, and installed frontend dependencies are required. See docs/developer-startup.md.")
        if command_output([docker, "compose", "version", "--short"]) is None:
            raise StartupError("Docker Compose is not available. See docs/developer-startup.md.")
        check_docker_engine(docker)
        check_free_ports()
        child_environment = with_tool_paths(os.environ, docker, node, inventory["ollama"])
        env = service_environment(child_environment, plan)
        if save:
            save_choices(ROOT / CONFIG_NAME, choices)
        launch(ROOT, inventory, plan, env)
        return 0
    except (StartupCancelled, KeyboardInterrupt):
        print("\nDeveloper startup/session stopped.")
        return 0
    except (StartupError, OSError, ValueError) as exc:
        print(f"\nDeveloper startup: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
