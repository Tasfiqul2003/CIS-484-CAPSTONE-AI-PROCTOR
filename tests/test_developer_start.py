"""Synthetic launcher checks: no services, inference, downloads, or recordings."""

from contextlib import nullcontext, redirect_stderr, redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, Mock, patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("developer_start", ROOT / "scripts/developer_start.py")
launcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launcher)


def choices(local_ai=False):
    return {key: key == "local_ai" and local_ai for key in launcher.FEATURES}


def inventory(local_ai=True):
    return {
        "labels": {key: f"Synthetic {key} version 1" for key in launcher.FEATURES},
        "available": {key: key == "local_ai" and local_ai for key in launcher.FEATURES},
        "ollama": "C:/synthetic tools/ollama.exe",
        "model": "synthetic-examiner",
    }


class DeveloperMenuTests(unittest.TestCase):
    def test_yes_no_variants_and_blank_defaults(self):
        for answer, expected in (("Y", True), ("yes", True), (" YES ", True),
                                 ("n", False), ("No", False)):
            with self.subTest(answer=answer):
                self.assertIs(launcher.ask_yes_no("Synthetic", False, lambda _: answer), expected)
        for default in (True, False):
            self.assertIs(launcher.ask_yes_no("Synthetic", default, lambda _: " "), default)

    def test_invalid_input_retries_and_eof_cancels(self):
        answers = iter(("maybe", "1", "N"))
        output = []
        self.assertFalse(launcher.ask_yes_no("Synthetic", True, lambda _: next(answers), output.append))
        self.assertEqual(len(output), 2)
        with self.assertRaises(launcher.StartupCancelled):
            launcher.ask_yes_no("Synthetic", False, Mock(side_effect=EOFError))

    def test_unavailable_features_reject_yes_and_cannot_inherit_enabled_defaults(self):
        defaults = dict.fromkeys(launcher.FEATURES, True)
        # Four unavailable integrations each receive Y then a blank N default.
        answers = iter(("Y", "Y", "", "Y", "", "Y", "", "Y", ""))
        output = []
        selected = launcher.collect_choices(inventory(), defaults, lambda _: next(answers), output.append)
        self.assertEqual(selected, choices(True))
        self.assertEqual(sum("Cannot activate" in message for message in output), 4)

    def test_unavailable_local_ai_stays_off(self):
        answers = iter(("Y", "N", "N", "N", "N", "N"))
        selected = launcher.collect_choices(inventory(False), choices(), lambda _: next(answers), lambda _: None)
        self.assertEqual(selected, choices())

    def test_saved_choices_are_strict_and_reject_unavailable_integrations(self):
        invalid = [None, [], {}, {**choices(), "extra": False},
                   {**choices(), "local_ai": 1}, {**choices(), "voice": "false"}]
        invalid.extend({**choices(), key: True} for key in launcher.UNAVAILABLE)
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                launcher.validate_choices(value)
        valid = choices(True)
        self.assertEqual(launcher.validate_choices(valid), valid)
        self.assertIsNot(launcher.validate_choices(valid), valid)

    def test_defaults_are_missing_file_safe_and_save_contains_only_choices(self):
        with tempfile.TemporaryDirectory(prefix=".developer-test-", dir=ROOT) as directory:
            path = Path(directory) / ".developer-settings.json"
            self.assertEqual(launcher.load_choices(path), choices())
            launcher.save_choices(path, choices(True))
            self.assertEqual(json.loads(path.read_text()), {"version": 1, "choices": choices(True)})
            self.assertEqual(launcher.load_choices(path), choices(True))
            self.assertEqual(list(Path(directory).glob("*.tmp")), [])

    def test_corrupt_or_unsupported_settings_are_left_unchanged(self):
        values = ["not json", json.dumps({"version": True, "choices": choices()}),
                  json.dumps({"version": 2, "choices": choices()}),
                  json.dumps({"version": 1, "choices": {**choices(), "avatar": True}}),
                  json.dumps({"version": 1, "choices": choices(), "password": "synthetic-only"})]
        with tempfile.TemporaryDirectory(prefix=".developer-test-", dir=ROOT) as directory:
            path = Path(directory) / ".developer-settings.json"
            for value in values:
                with self.subTest(value=value):
                    path.write_text(value)
                    with self.assertRaises(launcher.StartupError):
                        launcher.load_choices(path)
                    self.assertEqual(path.read_text(), value)

    def test_failed_atomic_save_keeps_previous_defaults_and_removes_temporary_file(self):
        with tempfile.TemporaryDirectory(prefix=".developer-test-", dir=ROOT) as directory:
            path = Path(directory) / ".developer-settings.json"
            launcher.save_choices(path, choices())
            before = path.read_bytes()
            with patch.object(launcher.os, "replace", side_effect=OSError("Synthetic denied replace")):
                with self.assertRaises(OSError):
                    launcher.save_choices(path, choices(True))
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(list(Path(directory).glob("*.tmp")), [])


class DeveloperDiscoveryTests(unittest.TestCase):
    def test_discovery_reports_runtime_and_model_without_generation_or_download(self):
        metadata = []

        def local(path):
            metadata.append(path)
            return {"version": "synthetic-runtime-1"}

        with patch.object(launcher, "package_versions", return_value={"faster-whisper": "synthetic-stt-2", "piper-tts": "synthetic-tts-3"}), \
                patch.object(launcher.shutil, "which", return_value="C:/synthetic/ollama.exe"), \
                patch.object(launcher, "local_json", side_effect=local), \
                patch.object(launcher, "command_output") as command:
            found = launcher.discover(ROOT, {"DEVELOPER_OLLAMA_MODEL": "cybros-v2"})
        self.assertIn("Ollama server synthetic-runtime-1", found["labels"]["local_ai"])
        self.assertIn("cybros-v2 | configured base qwen3:14b", found["labels"]["local_ai"])
        self.assertIn("synthetic-stt-2 | base.en | CPU INT8", found["labels"]["transcription"])
        self.assertIn("synthetic-tts-3 | en_US-lessac-medium", found["labels"]["voice"])
        self.assertEqual(metadata, ["/api/version"])
        command.assert_not_called()
        self.assertEqual(found["available"], inventory()["available"])

    def test_absent_runtime_and_unknown_versions_are_explicit(self):
        with patch.object(launcher, "package_versions", return_value={}), \
                patch.object(launcher.shutil, "which", return_value=None), \
                patch.object(launcher, "local_json", return_value=None), \
                patch.object(launcher, "command_output") as command:
            found = launcher.discover(ROOT, {"DEVELOPER_OLLAMA_MODEL": "synthetic-custom-model"})
        self.assertIn("Ollama Not installed", found["labels"]["local_ai"])
        self.assertIn("base model Unknown", found["labels"]["local_ai"])
        self.assertIn("Faster-Whisper Unknown", found["labels"]["transcription"])
        self.assertFalse(any(found["available"].values()))
        command.assert_not_called()

    def test_cli_version_query_is_literal_and_bounded(self):
        executable = "C:/synthetic tools/ollama & literal.exe"
        with patch.object(launcher.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="synthetic 1\n")) as run:
            self.assertEqual(launcher.command_output([executable, "--version"]), "synthetic 1")
        args, kwargs = run.call_args
        self.assertEqual(args[0], [executable, "--version"])
        self.assertFalse(kwargs["shell"])
        self.assertEqual(kwargs["timeout"], 5)
        with patch.object(launcher.subprocess, "run", side_effect=subprocess.TimeoutExpired("synthetic", 5)):
            self.assertIsNone(launcher.command_output([executable, "--version"]))

    def test_local_metadata_uses_no_proxy_and_does_not_issue_model_operations(self):
        response = Mock()
        response.read.return_value = b'{"version":"synthetic-1"}'
        opener = MagicMock()
        opener.open.return_value.__enter__.return_value = response
        with patch.object(launcher, "build_opener", return_value=opener), \
                patch.object(launcher, "ProxyHandler") as proxy:
            self.assertEqual(launcher.local_json("/api/version"), {"version": "synthetic-1"})
        proxy.assert_called_once_with({})
        opener.open.assert_called_once_with("http://127.0.0.1:11434/api/version", timeout=0.5)

    def test_flashhead_revision_detection_does_not_enable_unwired_renderer(self):
        checkout = "C:/synthetic FlashHead & literal checkout"
        with patch.object(launcher, "package_versions", return_value={}), \
                patch.object(launcher.shutil, "which", side_effect=lambda name, **_kwargs: f"C:/synthetic/{name}.exe"), \
                patch.object(launcher, "local_json", return_value={"version": "synthetic-1"}), \
                patch.object(launcher.Path, "is_dir", return_value=True), \
                patch.object(launcher, "command_output", return_value="synthetic-revision") as command:
            found = launcher.discover(ROOT, {"DEVELOPER_FLASHHEAD_DIR": checkout})
        self.assertIn("synthetic-revision", found["labels"]["avatar"])
        self.assertIn("model installation Unknown", found["labels"]["avatar"])
        self.assertFalse(found["available"]["avatar"])
        command.assert_called_once_with(["C:/synthetic/git.exe", "-C", str(Path(checkout)), "rev-parse", "--short", "HEAD"])


class DeveloperToolDiscoveryTests(unittest.TestCase):
    def test_supplied_path_is_preferred_without_checking_install_fallbacks(self):
        executable = "C:/synthetic preferred tools/node.exe"
        with patch.object(launcher.shutil, "which", return_value=executable) as which, \
                patch.object(launcher.Path, "is_file", side_effect=AssertionError("Unexpected fallback")):
            self.assertEqual(launcher.find_tool("node", {"Path": "synthetic-path"}), executable)
        which.assert_called_once_with("node", path="synthetic-path")

    def test_normal_windows_install_locations_are_found_with_stale_path(self):
        locations = (
            ("node", "ProgramFiles", "nodejs/node.exe"),
            ("node", "ProgramW6432", "nodejs/node.exe"),
            ("node", "LOCALAPPDATA", "Programs/nodejs/node.exe"),
            ("docker", "LOCALAPPDATA", "Programs/DockerDesktop/resources/bin/docker.exe"),
            ("docker", "ProgramFiles", "Docker/Docker/resources/bin/docker.exe"),
            ("ollama", "LOCALAPPDATA", "Programs/Ollama/ollama.exe"),
            ("ollama", "ProgramFiles", "Ollama/ollama.exe"),
        )
        with tempfile.TemporaryDirectory(prefix=".developer-test-", dir=ROOT) as directory:
            base = Path(directory) / "synthetic install root & literal"
            for name, variable, relative in locations:
                with self.subTest(name=name, variable=variable, relative=relative):
                    executable = base / relative
                    executable.parent.mkdir(parents=True, exist_ok=True)
                    executable.write_text("Synthetic placeholder; never execute.")
                    with patch.object(launcher.shutil, "which", return_value=None) as which:
                        found = launcher.find_tool(name, {variable: str(base), "PATH": "synthetic-stale-path"})
                    self.assertEqual(found, str(executable))
                    which.assert_called_once_with(name, path="synthetic-stale-path")

    def test_missing_environment_roots_have_no_account_or_runtime_fallback(self):
        with patch.object(launcher.shutil, "which", return_value=None) as which, \
                patch.object(launcher.Path, "is_file", side_effect=AssertionError("No fallback root was supplied")):
            self.assertIsNone(launcher.find_tool("node", {}))
        which.assert_called_once_with("node", path="")

    def test_case_insensitive_roots_and_inaccessible_candidates_are_handled(self):
        user_root, machine_root = Path("C:/synthetic user tools"), Path("C:/synthetic Program Files")
        expected = machine_root / "Docker/Docker/resources/bin/docker.exe"
        with patch.object(launcher.shutil, "which", return_value=None), \
                patch.object(launcher.Path, "is_file", side_effect=[OSError("Synthetic access denied"), True]):
            self.assertEqual(launcher.find_tool("docker", {"localappdata": str(user_root), "programfiles": str(machine_root)}), str(expected))


class DeveloperDockerPreflightTests(unittest.TestCase):
    def test_linux_engine_check_is_literal_bounded_and_accepts_ready_engine(self):
        docker = "C:/synthetic Docker tools/docker.exe"
        with patch.object(launcher, "command_output", return_value="linux") as command:
            launcher.check_docker_engine(docker)
        command.assert_called_once_with([docker, "info", "--format", "{{.OSType}}"], timeout=10)

    def test_missing_or_non_linux_engine_has_actionable_message(self):
        for engine in (None, "", "windows", "synthetic-unknown"):
            with self.subTest(engine=engine), \
                    patch.object(launcher, "command_output", return_value=engine):
                with self.assertRaises(launcher.StartupError) as raised:
                    launcher.check_docker_engine("synthetic-docker")
                self.assertIn("Docker Desktop", str(raised.exception))
                self.assertIn("WSL 2", str(raised.exception))

    def test_startup_checks_engine_before_requesting_credentials_or_starting(self):
        docker, node = "C:/synthetic new Docker/docker.exe", "C:/synthetic new Node/node.exe"
        for engine in (None, "windows", "linux"):
            events = []

            def output(args, **_kwargs):
                events.append(args)
                return engine if args[1] == "info" else "synthetic-compose-version"

            def environment(*_args):
                events.append("credentials")
                return {}

            with self.subTest(engine=engine), \
                    patch.object(launcher, "load_choices", return_value=choices()), \
                    patch.object(launcher, "discover", return_value=inventory()), \
                    patch.object(launcher, "collect_choices", return_value=choices()), \
                    patch.object(launcher, "ask_yes_no", return_value=False), \
                    patch.object(launcher, "find_tool", side_effect=lambda name, _env: {"docker": docker, "node": node}[name]), \
                    patch.object(launcher.Path, "is_file", return_value=True), \
                    patch.object(launcher, "command_output", side_effect=output), \
                    patch.object(launcher, "check_free_ports", side_effect=lambda: events.append("ports")) as ports, \
                    patch.object(launcher, "service_environment", side_effect=environment) as credentials, \
                    patch.object(launcher, "launch") as launch, \
                    patch.dict(launcher.os.environ, {}, clear=True), \
                    redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                self.assertEqual(launcher.main([]), 0 if engine == "linux" else 1)
            self.assertEqual(events[:2], [[docker, "compose", "version", "--short"], [docker, "info", "--format", "{{.OSType}}"]])
            if engine == "linux":
                self.assertEqual(events[2:], ["ports", "credentials"])
                self.assertEqual(launch.call_args.args[2]["frontend"][0], node)
                self.assertEqual(launch.call_args.args[2]["compose"][0], docker)
                credentials.assert_called_once()
            else:
                ports.assert_not_called()
                credentials.assert_not_called()
                launch.assert_not_called()

    def test_busy_port_refuses_startup_before_credentials_defaults_or_services(self):
        output = io.StringIO()
        with patch.object(launcher, "load_choices", return_value=choices()), \
                patch.object(launcher, "discover", return_value=inventory()), \
                patch.object(launcher, "collect_choices", return_value=choices()), \
                patch.object(launcher, "ask_yes_no", return_value=True), \
                patch.object(launcher, "find_tool", side_effect=lambda name, _env: f"C:/synthetic/{name}.exe"), \
                patch.object(launcher.Path, "is_file", return_value=True), \
                patch.object(launcher, "command_output", return_value="synthetic-compose-version"), \
                patch.object(launcher, "check_docker_engine") as engine, \
                patch.object(launcher, "check_free_ports", side_effect=launcher.StartupError("Port 5173 is already in use. Existing services were left running.")) as ports, \
                patch.object(launcher, "service_environment") as credentials, \
                patch.object(launcher, "save_choices") as save, \
                patch.object(launcher, "launch") as launch, \
                patch.dict(launcher.os.environ, {}, clear=True), \
                redirect_stdout(output), redirect_stderr(output):
            self.assertEqual(launcher.main([]), 1)
        engine.assert_called_once_with("C:/synthetic/docker.exe")
        ports.assert_called_once_with()
        credentials.assert_not_called()
        save.assert_not_called()
        launch.assert_not_called()
        self.assertIn("Port 5173 is already in use", output.getvalue())
        self.assertIn("Existing services were left running", output.getvalue())


class DeveloperChildEnvironmentTests(unittest.TestCase):
    def test_tool_directories_are_literal_deduplicated_and_do_not_mutate_base(self):
        docker = str(Path("C:/Synthetic Docker Tools & literal/resources/bin/docker.exe"))
        node = str(Path("C:/Synthetic Node Tools/node.exe"))
        ollama = str(Path("C:/Synthetic Ollama/ollama.exe"))
        docker_dir = str(Path(docker).parent)
        old_dir = str(Path("C:/Synthetic Existing Tools"))
        base = {"Path": launcher.os.pathsep.join((docker_dir.lower() + "/", old_dir, old_dir.upper())),
                "SYNTHETIC_SECRET": "synthetic-preserved-value"}
        original = dict(base)
        env = launcher.with_tool_paths(base, docker, node, ollama, docker.upper(), None)
        self.assertEqual(base, original)
        self.assertIsNot(base, env)
        self.assertEqual(env["PATH"].split(launcher.os.pathsep),
                         [docker_dir, str(Path(node).parent), str(Path(ollama).parent), old_dir])
        self.assertNotIn("Path", env)
        self.assertEqual(env["SYNTHETIC_SECRET"], original["SYNTHETIC_SECRET"])
        self.assertNotIn('"', env["PATH"])

    def test_missing_tool_paths_do_not_add_runtime_or_current_directory_fallback(self):
        base = {"SYNTHETIC_SETTING": "synthetic-preserved"}
        self.assertEqual(launcher.with_tool_paths(base, None), {**base, "PATH": ""})
        self.assertEqual(base, {"SYNTHETIC_SETTING": "synthetic-preserved"})

    def test_docker_credential_helper_directory_reaches_launched_environment(self):
        docker = str(Path("C:/synthetic Docker Desktop/resources/bin/docker.exe"))
        node = str(Path("C:/synthetic Node/node.exe"))
        base = {"Path": "C:/synthetic stale tools", "DEVELOPER_POSTGRES_PASSWORD": "synthetic-only-password",
                "DEVELOPER_ADMIN_BOOTSTRAP_TOKEN": "synthetic-only-bootstrap-token"}
        with patch.object(launcher, "load_choices", return_value=choices()), \
                patch.object(launcher, "discover", return_value=inventory()), \
                patch.object(launcher, "collect_choices", return_value=choices()), \
                patch.object(launcher, "ask_yes_no", return_value=False), \
                patch.object(launcher, "find_tool", side_effect=lambda name, _env: {"docker": docker, "node": node}[name]), \
                patch.object(launcher.Path, "is_file", return_value=True), \
                patch.object(launcher, "command_output", return_value="synthetic-compose-version"), \
                patch.object(launcher, "check_docker_engine"), \
                patch.object(launcher, "check_free_ports"), \
                patch.object(launcher.secrets, "token_urlsafe", return_value="synthetic-session-secret"), \
                patch.object(launcher, "save_choices") as save, \
                patch.object(launcher, "launch") as launch, \
                patch.dict(launcher.os.environ, base, clear=True), \
                redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(launcher.main([]), 0)
            self.assertEqual(launcher.os.environ["PATH"], base["Path"])
        env = launch.call_args.args[3]
        self.assertEqual(env["PATH"].split(launcher.os.pathsep)[:3],
                         [str(Path(docker).parent), str(Path(node).parent), str(Path(inventory()["ollama"]).parent)])
        self.assertEqual(env["DEVELOPER_POSTGRES_PASSWORD"], base["DEVELOPER_POSTGRES_PASSWORD"])
        self.assertEqual(env["DEVELOPER_ADMIN_BOOTSTRAP_TOKEN"], base["DEVELOPER_ADMIN_BOOTSTRAP_TOKEN"])
        save.assert_not_called()


class DeveloperPlanTests(unittest.TestCase):
    def test_plan_preserves_literal_paths_and_uses_standalone_cpu_compose(self):
        root = Path("C:/synthetic checkout with spaces & literal")
        plan = launcher.build_plan(root, choices(True), "synthetic-model", "https://synthetic.invalid:11434", "C:/tools/docker.exe", "C:/tools/node.exe")
        self.assertEqual(plan["endpoint"], "http://host.docker.internal:11434")
        self.assertIn(str(root / "compose.developer.yaml"), plan["compose"])
        self.assertNotIn(str(root / "docker-compose.yml"), plan["compose"])
        self.assertEqual(plan["compose"][-2:], ["-p", "oralexam-developer"])
        self.assertEqual(plan["core"][-5:], ["up", "--build", "-d", "--wait", "backend"])
        self.assertEqual(plan["frontend"][1], str(root / "frontend/node_modules/vite/bin/vite.js"))
        compose = (ROOT / "compose.developer.yaml").read_text().lower()
        self.assertNotIn("driver: nvidia", compose)
        self.assertNotIn("capabilities: [gpu]", compose)
        self.assertNotIn("--gpus", plan["core"])

    def test_demo_opt_in_is_confined_to_the_dedicated_developer_backend(self):
        developer = (ROOT / "compose.developer.yaml").read_text()
        normal = (ROOT / "docker-compose.yml").read_text()
        self.assertIn('DEVELOPER_DEMO_MODE: "1"', developer)
        self.assertNotIn("DEVELOPER_DEMO_MODE", normal)
        self.assertNotIn("DEVELOPER_DEMO_MODE", launcher.validate_choices(choices()))

    def test_disabling_local_ai_preserves_configured_endpoint_and_no_unavailable_flags(self):
        plan = launcher.build_plan(ROOT, choices(), "synthetic-model", "https://synthetic.invalid:11434/")
        self.assertFalse(plan["local_ai"])
        self.assertEqual(plan["endpoint"], "https://synthetic.invalid:11434")
        for feature in launcher.UNAVAILABLE:
            with self.subTest(feature=feature), self.assertRaises(ValueError):
                launcher.build_plan(ROOT, {**choices(), feature: True}, "synthetic", "http://synthetic.invalid")

    def test_endpoint_rejects_credentials_paths_queries_and_bad_ports(self):
        for value in ("file:///synthetic", "http://user:secret@synthetic.invalid", "https://synthetic.invalid/api", "https://synthetic.invalid?secret=x", "https://synthetic.invalid#x", "http://synthetic.invalid:invalid"):
            with self.subTest(value=value), self.assertRaises((launcher.StartupError, ValueError)):
                launcher.validate_endpoint(value)

    def test_secret_environment_encodes_password_and_is_separate_from_saved_choices(self):
        password = "synthetic:p@ss/word?#% &"
        bootstrap = "synthetic-bootstrap-token-only"
        base = {"DEVELOPER_POSTGRES_PASSWORD": password, "DEVELOPER_ADMIN_BOOTSTRAP_TOKEN": bootstrap}
        plan = launcher.build_plan(ROOT, choices(), "synthetic-model", "http://synthetic.invalid:11434")
        with patch.object(launcher.secrets, "token_urlsafe", return_value="synthetic-auth-secret"):
            env = launcher.service_environment(base, plan, Mock(side_effect=AssertionError("Unexpected prompt")))
        self.assertIn("synthetic%3Ap%40ss%2Fword%3F%23%25%20%26@db", env["DEVELOPER_DATABASE_URL"])
        self.assertEqual(env["DEVELOPER_OLLAMA_MODEL"], "synthetic-model")
        self.assertEqual(env["DEVELOPER_OLLAMA_URL"], "http://synthetic.invalid:11434")
        self.assertNotIn("DEVELOPER_AUTH_SECRET_KEY", base)
        with tempfile.TemporaryDirectory(prefix=".developer-test-", dir=ROOT) as directory:
            path = Path(directory) / ".developer-settings.json"
            launcher.save_choices(path, choices())
            saved = path.read_text()
        self.assertNotIn(password, saved)
        self.assertNotIn(bootstrap, saved)
        self.assertNotIn("synthetic-auth-secret", saved)

    def test_short_bootstrap_token_is_refused(self):
        plan = launcher.build_plan(ROOT, choices(), "synthetic", "http://synthetic.invalid")
        with self.assertRaises(launcher.StartupError):
            launcher.service_environment({"DEVELOPER_POSTGRES_PASSWORD": "synthetic-only", "DEVELOPER_ADMIN_BOOTSTRAP_TOKEN": "short"}, plan)


class DeveloperLockTests(unittest.TestCase):
    def test_concurrent_session_is_refused_and_lock_can_be_reacquired(self):
        with tempfile.TemporaryDirectory(prefix=".developer-test-", dir=ROOT) as directory:
            root = Path(directory)
            with launcher.session_lock(root):
                with self.assertRaisesRegex(launcher.StartupError, "already active"):
                    with launcher.session_lock(root):
                        self.fail("A concurrent launcher acquired the existing lock")
            with launcher.session_lock(root):
                pass
            self.assertEqual((root / ".developer-session.lock").read_bytes(), b"0")

    def test_lock_is_released_after_session_error(self):
        with tempfile.TemporaryDirectory(prefix=".developer-test-", dir=ROOT) as directory:
            root = Path(directory)
            with self.assertRaisesRegex(RuntimeError, "Synthetic session failure"):
                with launcher.session_lock(root):
                    raise RuntimeError("Synthetic session failure")
            with launcher.session_lock(root):
                pass

    def test_refused_launcher_never_starts_or_stops_services(self):
        with tempfile.TemporaryDirectory(prefix=".developer-test-", dir=ROOT) as directory:
            root = Path(directory)
            plan = launcher.build_plan(root, choices(), "synthetic", "http://synthetic.invalid")
            with launcher.session_lock(root), \
                    patch.object(launcher, "run_command") as run, \
                    patch.object(launcher.subprocess, "Popen") as popen, \
                    patch.object(launcher, "stop_process") as stop, \
                    patch.object(launcher, "local_json") as metadata:
                with self.assertRaisesRegex(launcher.StartupError, "already active"):
                    launcher.launch(root, inventory(), plan, {})
            run.assert_not_called()
            popen.assert_not_called()
            stop.assert_not_called()
            metadata.assert_not_called()


class DeveloperProcessTests(unittest.TestCase):
    def setUp(self):
        self.plan = launcher.build_plan(ROOT, choices(), "synthetic-model", "http://synthetic.invalid")
        self.output = io.StringIO()
        # OS lock behavior is tested separately in isolated temporary directories.
        lock = patch.object(launcher, "session_lock", side_effect=lambda _: nullcontext())
        lock.start()
        self.addCleanup(lock.stop)

    def test_preexisting_stack_is_never_stopped(self):
        with patch.object(launcher, "run_command", return_value="existing-synthetic-container") as run, \
                patch.object(launcher, "check_free_ports") as ports, \
                patch.object(launcher.subprocess, "Popen") as popen, \
                redirect_stdout(self.output):
            with self.assertRaises(launcher.StartupError):
                launcher.launch(ROOT, inventory(), self.plan, {})
        run.assert_called_once_with(self.plan["compose"] + ["ps", "--status", "running", "-q"], ROOT, {}, capture=True)
        ports.assert_not_called()
        popen.assert_not_called()

    def test_partial_compose_failure_stops_only_developer_project(self):
        def command(args, *_args, **_kwargs):
            if args == self.plan["core"]:
                raise launcher.StartupError("Synthetic partial start")
            return ""

        with patch.object(launcher, "run_command", side_effect=command) as run, \
                patch.object(launcher, "check_free_ports"), \
                patch.object(launcher.subprocess, "Popen") as popen, \
                redirect_stdout(self.output):
            with self.assertRaises(launcher.StartupError):
                launcher.launch(ROOT, inventory(), self.plan, {})
        self.assertEqual([call.args[0] for call in run.call_args_list], [
            self.plan["compose"] + ["ps", "--status", "running", "-q"],
            self.plan["core"], self.plan["compose"] + ["stop"],
        ])
        self.assertIsNone(run.call_args_list[1].kwargs["timeout"])
        popen.assert_not_called()

    def test_missing_local_model_never_downloads_or_stops_borrowed_ollama(self):
        plan = launcher.build_plan(ROOT, choices(True), "synthetic-missing", "http://synthetic.invalid")
        frontend = Mock()
        frontend.poll.return_value = None

        def metadata(path):
            return {"version": "synthetic-1"} if path == "/api/version" else {"models": []}

        with patch.object(launcher, "run_command", return_value="") as run, \
                patch.object(launcher, "check_free_ports"), \
                patch.object(launcher, "local_json", side_effect=metadata) as local, \
                patch.object(launcher, "wait_for_http"), \
                patch.object(launcher.subprocess, "Popen", return_value=frontend) as popen, \
                patch.object(launcher.webbrowser, "open") as browser, \
                patch.object(launcher.time, "sleep", side_effect=KeyboardInterrupt), \
                redirect_stdout(self.output):
            with self.assertRaises(KeyboardInterrupt):
                launcher.launch(ROOT, inventory(), plan, {})
        self.assertEqual([call.args[0] for call in local.call_args_list], ["/api/version", "/api/tags"])
        self.assertEqual([call.args[0] for call in run.call_args_list], [
            plan["compose"] + ["ps", "--status", "running", "-q"], plan["core"], plan["compose"] + ["stop"],
        ])
        self.assertEqual(popen.call_args.args[0], plan["frontend"])
        browser.assert_called_once()
        self.assertIn("not installed", self.output.getvalue())
        self.assertIn("labeled developer demo fallback", self.output.getvalue())

    def test_frontend_failure_cleans_core_and_owned_process_but_leaves_borrowed_ai(self):
        plan = launcher.build_plan(ROOT, choices(True), "synthetic-model", "http://synthetic.invalid")
        frontend = Mock()
        frontend.poll.return_value = None

        def metadata(path):
            return {"version": "synthetic-1"} if path == "/api/version" else {"models": [{"name": "synthetic-model:latest"}]}

        def ready(url, _process):
            if url.endswith(":5173"):
                raise launcher.StartupError("Synthetic frontend unavailable")

        with patch.object(launcher, "run_command", return_value="") as run, \
                patch.object(launcher, "check_free_ports"), \
                patch.object(launcher, "local_json", side_effect=metadata), \
                patch.object(launcher, "wait_for_http", side_effect=ready), \
                patch.object(launcher.subprocess, "Popen", return_value=frontend) as popen, \
                patch.object(launcher.webbrowser, "open") as browser, \
                redirect_stdout(self.output):
            with self.assertRaises(launcher.StartupError):
                launcher.launch(ROOT, inventory(), plan, {})
        self.assertEqual(popen.call_count, 1)
        self.assertEqual(popen.call_args.args[0], plan["frontend"])
        self.assertFalse(popen.call_args.kwargs["shell"])
        frontend.terminate.assert_called_once()
        frontend.wait.assert_called_once_with(timeout=5)
        self.assertEqual(run.call_args.args[0], plan["compose"] + ["stop"])
        browser.assert_not_called()

    def test_missing_model_keeps_core_available_and_owned_ai_is_cleaned_at_session_end(self):
        plan = launcher.build_plan(ROOT, choices(True), "synthetic-model", "http://synthetic.invalid")
        ai, frontend = Mock(), Mock()
        ai.poll.return_value = frontend.poll.return_value = None
        with patch.object(launcher, "run_command", return_value="") as run, \
                patch.object(launcher, "check_free_ports"), \
                patch.object(launcher, "local_json", return_value=None), \
                patch.object(launcher, "wait_for_http"), \
                patch.object(launcher.subprocess, "Popen", side_effect=[ai, frontend]) as popen, \
                patch.object(launcher.webbrowser, "open"), \
                patch.object(launcher.time, "sleep", side_effect=KeyboardInterrupt), \
                redirect_stdout(self.output):
            with self.assertRaises(KeyboardInterrupt):
                launcher.launch(ROOT, inventory(), plan, {})
        self.assertEqual(popen.call_args_list[0].args[0], [inventory()["ollama"], "serve"])
        self.assertFalse(popen.call_args_list[0].kwargs["shell"])
        self.assertEqual(popen.call_args_list[0].kwargs["env"]["OLLAMA_HOST"], "127.0.0.1:11434")
        self.assertEqual(popen.call_args_list[1].args[0], plan["frontend"])
        ai.terminate.assert_called_once()
        self.assertIn(plan["core"], [call.args[0] for call in run.call_args_list])

    def test_failed_frontend_and_compose_cleanup_still_stops_owned_ai(self):
        plan = launcher.build_plan(ROOT, choices(True), "synthetic-model", "http://synthetic.invalid")
        ai, frontend = Mock(), Mock()
        ai.poll.return_value = frontend.poll.return_value = None
        frontend.terminate.side_effect = OSError("synthetic-secret-must-not-appear")

        def command(args, *_args, **_kwargs):
            if args[-1] == "stop":
                raise launcher.StartupError("Synthetic Docker cleanup failure")
            return ""

        def metadata(path):
            return None if path == "/api/version" else {"models": [{"name": "synthetic-model:latest"}]}

        def ready(url, _process):
            if url.endswith(":5173"):
                raise launcher.StartupError("Synthetic frontend unavailable")

        with patch.object(launcher, "run_command", side_effect=command) as run, \
                patch.object(launcher, "check_free_ports"), \
                patch.object(launcher, "local_json", side_effect=metadata), \
                patch.object(launcher, "wait_for_http", side_effect=ready), \
                patch.object(launcher.subprocess, "Popen", side_effect=[ai, frontend]), \
                redirect_stdout(self.output):
            with self.assertRaisesRegex(launcher.StartupError, "Synthetic frontend unavailable"):
                launcher.launch(ROOT, inventory(), plan, {})
        frontend.terminate.assert_called_once()
        self.assertEqual(run.call_args.args[0], plan["compose"] + ["stop"])
        ai.terminate.assert_called_once()
        ai.wait.assert_called_once_with(timeout=5)
        self.assertIn("Frontend cleanup failed (OSError)", self.output.getvalue())
        self.assertNotIn("synthetic-secret-must-not-appear", self.output.getvalue())

    def test_local_ai_container_connectivity_failure_continues_with_demo_fallback(self):
        plan = launcher.build_plan(ROOT, choices(True), "synthetic-model", "http://synthetic.invalid")
        frontend = Mock()
        frontend.poll.return_value = None

        def command(args, *_args, **_kwargs):
            if "exec" in args:
                raise launcher.StartupError("Synthetic unreachable Ollama")
            return ""

        def metadata(path):
            return {"version": "synthetic-1"} if path == "/api/version" else {"models": [{"name": "synthetic-model:latest"}]}

        with patch.object(launcher, "run_command", side_effect=command) as run, \
                patch.object(launcher, "check_free_ports"), \
                patch.object(launcher, "local_json", side_effect=metadata), \
                patch.object(launcher, "wait_for_http"), \
                patch.object(launcher.subprocess, "Popen", return_value=frontend) as popen, \
                patch.object(launcher.webbrowser, "open") as browser, \
                patch.object(launcher.time, "sleep", side_effect=KeyboardInterrupt), \
                redirect_stdout(self.output):
            with self.assertRaises(KeyboardInterrupt):
                launcher.launch(ROOT, inventory(), plan, {})
        self.assertEqual(run.call_args.args[0], plan["compose"] + ["stop"])
        self.assertEqual(popen.call_args.args[0], plan["frontend"])
        browser.assert_called_once()
        self.assertIn("cannot reach local Ollama", self.output.getvalue())
        self.assertIn("labeled developer demo fallback", self.output.getvalue())

    def test_absent_local_ollama_cannot_block_core_startup(self):
        plan = launcher.build_plan(ROOT, choices(True), "synthetic-model", "http://synthetic.invalid")
        frontend = Mock()
        frontend.poll.return_value = None
        found = {**inventory(False), "ollama": None}
        with patch.object(launcher, "run_command", return_value="") as run, \
                patch.object(launcher, "check_free_ports"), \
                patch.object(launcher, "local_json", return_value=None), \
                patch.object(launcher, "wait_for_http"), \
                patch.object(launcher.subprocess, "Popen", return_value=frontend) as popen, \
                patch.object(launcher.webbrowser, "open"), \
                patch.object(launcher.time, "sleep", side_effect=KeyboardInterrupt), \
                redirect_stdout(self.output):
            with self.assertRaises(KeyboardInterrupt):
                launcher.launch(ROOT, found, plan, {})
        self.assertEqual(popen.call_args.args[0], plan["frontend"])
        self.assertIn(plan["core"], [call.args[0] for call in run.call_args_list])
        self.assertIn("Ollama is unavailable", self.output.getvalue())

    def test_optional_ollama_spawn_failure_is_redacted_and_core_still_starts(self):
        plan = launcher.build_plan(ROOT, choices(True), "synthetic-model", "http://synthetic.invalid")
        frontend = Mock()
        frontend.poll.return_value = None
        with patch.object(launcher, "run_command", return_value="") as run, \
                patch.object(launcher, "check_free_ports"), \
                patch.object(launcher, "local_json", return_value=None), \
                patch.object(launcher, "wait_for_http"), \
                patch.object(launcher.subprocess, "Popen", side_effect=[OSError("synthetic-secret-must-not-appear"), frontend]), \
                patch.object(launcher.webbrowser, "open"), \
                patch.object(launcher.time, "sleep", side_effect=KeyboardInterrupt), \
                redirect_stdout(self.output):
            with self.assertRaises(KeyboardInterrupt):
                launcher.launch(ROOT, inventory(), plan, {})
        self.assertIn(plan["core"], [call.args[0] for call in run.call_args_list])
        self.assertIn("optional Ollama process could not start", self.output.getvalue())
        self.assertNotIn("synthetic-secret-must-not-appear", self.output.getvalue())

    def test_optional_ollama_readiness_timeout_does_not_stop_core(self):
        plan = launcher.build_plan(ROOT, choices(True), "synthetic-model", "http://synthetic.invalid")
        ai, frontend = Mock(), Mock()
        ai.poll.return_value = frontend.poll.return_value = None

        def ready(url, _process):
            if ":11434/" in url:
                raise launcher.StartupError("Synthetic optional Ollama readiness timeout")

        with patch.object(launcher, "run_command", return_value="") as run, \
                patch.object(launcher, "check_free_ports"), \
                patch.object(launcher, "local_json", return_value=None), \
                patch.object(launcher, "wait_for_http", side_effect=ready), \
                patch.object(launcher.subprocess, "Popen", side_effect=[ai, frontend]), \
                patch.object(launcher.webbrowser, "open"), \
                patch.object(launcher.time, "sleep", side_effect=KeyboardInterrupt), \
                redirect_stdout(self.output):
            with self.assertRaises(KeyboardInterrupt):
                launcher.launch(ROOT, inventory(), plan, {})
        self.assertIn(plan["core"], [call.args[0] for call in run.call_args_list])
        ai.terminate.assert_called_once()
        self.assertIn("readiness timeout", self.output.getvalue())

    def test_owned_ai_exit_warns_once_and_preserves_running_core(self):
        plan = launcher.build_plan(ROOT, choices(True), "synthetic-model", "http://synthetic.invalid")
        ai, frontend = Mock(), Mock()
        ai.poll.return_value = 7
        frontend.poll.return_value = None

        def metadata(path):
            return None if path == "/api/version" else {"models": [{"name": "synthetic-model:latest"}]}

        with patch.object(launcher, "run_command", return_value="") as run, \
                patch.object(launcher, "check_free_ports"), \
                patch.object(launcher, "local_json", side_effect=metadata), \
                patch.object(launcher, "wait_for_http"), \
                patch.object(launcher.subprocess, "Popen", side_effect=[ai, frontend]), \
                patch.object(launcher.webbrowser, "open"), \
                patch.object(launcher.time, "sleep", side_effect=[None, KeyboardInterrupt]) as sleep, \
                redirect_stdout(self.output):
            with self.assertRaises(KeyboardInterrupt):
                launcher.launch(ROOT, inventory(), plan, {})
        self.assertEqual(sleep.call_count, 2)
        self.assertEqual(self.output.getvalue().count("optional local AI service exited"), 1)
        ai.terminate.assert_not_called()
        self.assertEqual(run.call_args.args[0], plan["compose"] + ["stop"])

    def test_stubborn_owned_process_is_killed_after_graceful_timeout(self):
        process = Mock()
        process.poll.return_value = None
        process.wait.side_effect = [subprocess.TimeoutExpired("synthetic", 5), 0]
        launcher.stop_process(process)
        process.terminate.assert_called_once()
        process.kill.assert_called_once()
        self.assertEqual(process.wait.call_count, 2)

    def test_run_failure_does_not_include_secret_bearing_output(self):
        secret = "synthetic-secret-do-not-report"
        with patch.object(launcher.subprocess, "run", return_value=SimpleNamespace(returncode=7, stdout=secret, stderr=secret)):
            with self.assertRaises(launcher.StartupError) as raised:
                launcher.run_command(["synthetic", "inspect"], ROOT, {"SYNTHETIC_SECRET": secret}, capture=True)
        self.assertNotIn(secret, str(raised.exception))

    def test_metadata_commands_are_bounded_and_timeout_errors_are_redacted(self):
        secret = "synthetic-secret-do-not-report"
        with patch.object(launcher.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="synthetic-container")) as run:
            self.assertEqual(launcher.run_command(["docker", "compose", "ps"], ROOT, {}, capture=True), "synthetic-container")
        self.assertEqual(run.call_args.kwargs["timeout"], 30)
        self.assertFalse(run.call_args.kwargs["shell"])
        error = subprocess.TimeoutExpired(["synthetic", secret], 30, output=secret, stderr=secret)
        with patch.object(launcher.subprocess, "run", side_effect=error):
            with self.assertRaisesRegex(launcher.StartupError, "within 30 seconds") as raised:
                launcher.run_command(["synthetic", "inspect"], ROOT, {"SYNTHETIC_SECRET": secret}, capture=True)
        self.assertNotIn(secret, str(raised.exception))

    def test_dry_run_never_saves_starts_or_requests_secrets(self):
        with patch.object(launcher, "load_choices", return_value=choices()), \
                patch.object(launcher, "discover", return_value=inventory()), \
                patch.object(launcher, "collect_choices", return_value=choices()), \
                patch.object(launcher, "ask_yes_no", return_value=True), \
                patch.object(launcher, "save_choices") as save, \
                patch.object(launcher, "service_environment") as environment, \
                patch.object(launcher, "launch") as launch, \
                patch.dict(launcher.os.environ, {"DEVELOPER_OLLAMA_URL": "http://synthetic.invalid"}), \
                redirect_stdout(self.output), redirect_stderr(self.output):
            self.assertEqual(launcher.main(["--dry-run"]), 0)
        save.assert_not_called()
        environment.assert_not_called()
        launch.assert_not_called()


if __name__ == "__main__":
    unittest.main()
