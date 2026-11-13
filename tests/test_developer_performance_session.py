"""Synthetic toggle, report delivery and cleanup checks; no services are run."""

from contextlib import ExitStack, nullcontext, redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from scripts import developer_performance_session as session
from scripts import developer_start as launcher


ROOT = Path(__file__).resolve().parents[1]


class PerformanceSettingsTests(unittest.TestCase):
    def test_default_off_roundtrip_and_invalid_file_preserved(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            root = Path(directory)
            self.assertFalse(session.load_enabled(root))
            session.save_enabled(root, True)
            self.assertTrue(session.load_enabled(root))
            path = root / session.SETTINGS_NAME
            for value in ({"version": True, "enabled": True}, {"version": 1, "enabled": "yes"},
                          {"version": 1, "enabled": True, "extra": "synthetic"}):
                original = json.dumps(value)
                path.write_text(original)
                with self.assertRaises(ValueError):
                    session.load_enabled(root)
                self.assertEqual(path.read_text(), original)

    def test_failed_atomic_save_retains_previous_default(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            root = Path(directory)
            session.save_enabled(root, False)
            with patch.object(session.os, "replace", side_effect=OSError):
                with self.assertRaises(OSError):
                    session.save_enabled(root, True)
            self.assertFalse(session.load_enabled(root))
            self.assertFalse((root / ".developer-performance.tmp").exists())


class PerformanceMainTests(unittest.TestCase):
    def invoke(self, root, args, answer=True):
        with ExitStack() as stack:
            stack.enter_context(patch.object(launcher, "ROOT", root))
            stack.enter_context(patch.object(launcher, "load_choices", return_value=dict.fromkeys(launcher.FEATURES, False)))
            stack.enter_context(patch.object(launcher, "find_tool", side_effect=lambda name, _env: name))
            stack.enter_context(patch.object(launcher.Path, "is_file", return_value=True))
            stack.enter_context(patch.object(launcher, "command_output", return_value="linux"))
            stack.enter_context(patch.object(launcher, "check_free_ports"))
            stack.enter_context(patch.object(launcher, "service_environment", return_value={}))
            prompt = stack.enter_context(patch.object(launcher, "ask_yes_no", return_value=answer))
            launch = stack.enter_context(patch.object(launcher, "launch"))
            output = stack.enter_context(redirect_stdout(io.StringIO()))
            result = launcher.main(args)
        return result, prompt, launch, output.getvalue()

    def test_interactive_choice_persists_without_rewriting_provider_settings(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            root = Path(directory)
            legacy = root / launcher.CONFIG_NAME
            legacy.write_text("synthetic preserved provider defaults")
            result, prompt, launch, _ = self.invoke(root, [])
            self.assertEqual(result, 0)
            prompt.assert_called_once()
            self.assertTrue(launch.call_args.args[2]["performance_tracking"])
            self.assertTrue(session.load_enabled(root))
            self.assertEqual(legacy.read_text(), "synthetic preserved provider defaults")
            self.invoke(root, [], answer=False)
            self.assertFalse(session.load_enabled(root))

    def test_cli_override_never_changes_saved_default_or_prompts(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            root = Path(directory)
            session.save_enabled(root, True)
            result, prompt, launch, _ = self.invoke(root, ["--performance-tracking", "off"])
            self.assertEqual(result, 0)
            prompt.assert_not_called()
            self.assertFalse(launch.call_args.args[2]["performance_tracking"])
            self.assertTrue(session.load_enabled(root))

    def test_inspection_never_prompts_samples_or_saves(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            root = Path(directory)
            for option in ("--show-menu", "--dry-run"):
                with self.subTest(option=option), patch.object(launcher, "PerformanceSession") as monitor:
                    result, prompt, launch, text = self.invoke(root, [option, "--performance-tracking", "on"])
                self.assertEqual(result, 0)
                prompt.assert_not_called()
                launch.assert_not_called()
                monitor.assert_not_called()
                self.assertFalse((root / session.SETTINGS_NAME).exists())
                self.assertTrue("ON" in text or '"performance_tracking": true' in text)


class PerformanceLifecycleTests(unittest.TestCase):
    def run_session(self, enabled=True, fail_core=False, fail_report=False):
        events = []
        plan = launcher.build_plan(ROOT, dict.fromkeys(launcher.FEATURES, False), "synthetic", "http://localhost", minimal=True)
        plan["performance_tracking"] = enabled
        monitor = Mock()
        monitor.start.side_effect = lambda: events.append("tracking-start")
        monitor.stop.side_effect = lambda reason: events.append(("tracking-stop", reason))
        monitor.show_report.side_effect = lambda: events.append("report-popup")
        if fail_report:
            monitor.stop.side_effect = RuntimeError("synthetic-secret")
        frontend = Mock(pid=123)
        frontend.poll.return_value = None
        frontend.terminate.side_effect = lambda: events.append("frontend-stop")

        def run(args, *_args, **_kwargs):
            if args == plan["core"] and fail_core:
                raise launcher.StartupError("synthetic startup failure")
            if args[-1] == "stop":
                events.append("docker-stop")
            return ""

        with patch.object(launcher, "session_lock", return_value=nullcontext()), \
                patch.object(launcher, "run_command", side_effect=run), \
                patch.object(launcher, "check_free_ports"), \
                patch.object(launcher, "wait_for_http"), \
                patch.object(launcher.subprocess, "Popen", return_value=frontend), \
                patch.object(launcher.webbrowser, "open"), \
                patch.object(launcher.time, "sleep", side_effect=KeyboardInterrupt), \
                patch.object(launcher, "PerformanceSession", return_value=monitor) as factory, \
                redirect_stdout(io.StringIO()) as output:
            with self.assertRaises(launcher.StartupError if fail_core else KeyboardInterrupt):
                launcher.launch_services(ROOT, {}, plan, {})
        return events, monitor, factory, output.getvalue()

    def test_tracking_off_creates_no_collector_or_popup(self):
        events, monitor, factory, _ = self.run_session(False)
        factory.assert_not_called()
        monitor.start.assert_not_called()
        self.assertEqual(events, ["frontend-stop", "docker-stop"])

    def test_ctrl_c_freezes_before_cleanup_and_delivers_after_cleanup(self):
        events, monitor, _, _ = self.run_session()
        self.assertEqual(events, ["tracking-start", ("tracking-stop", "stopped"),
                                  "frontend-stop", "docker-stop", "report-popup"])
        monitor.register_process.assert_called_once_with("frontend", 123)

    def test_failed_startup_still_produces_report_after_partial_cleanup(self):
        events, _, _, _ = self.run_session(fail_core=True)
        self.assertEqual(events, ["tracking-start", ("tracking-stop", "startup_failed"),
                                  "docker-stop", "report-popup"])

    def test_monitor_failure_cannot_skip_cleanup_or_leak_exception_text(self):
        events, _, _, output = self.run_session(fail_report=True)
        self.assertIn("frontend-stop", events)
        self.assertIn("docker-stop", events)
        self.assertNotIn("synthetic-secret", output)


class PerformanceDeliveryTests(unittest.TestCase):
    def test_stalled_publisher_does_not_block_cleanup_or_overwrite_final_state(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            tracker = Mock()
            tracker.finish.return_value = ({"synthetic": True}, None)
            with patch.object(session, "SessionTracker", return_value=tracker), \
                    patch.object(session, "render_report", return_value="Synthetic report"), \
                    patch.object(session, "atomic_json") as write, \
                    redirect_stdout(io.StringIO()):
                instance = session.PerformanceSession(Path(directory), [], {})
                instance.publisher = Mock()
                instance.publisher.is_alive.return_value = True
                instance.stop("stopped")
                instance.show_report()
            instance.publisher.join.assert_called_once_with(timeout=2)
            write.assert_not_called()
            tracker.finish.assert_called_once_with("stopped")

    def test_viewer_receives_no_backend_credentials_or_shell_command(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            tracker = Mock()
            tracker.snapshot.return_value = {}
            tracker.finish.return_value = ({}, None)
            with patch.object(session, "SessionTracker", return_value=tracker), \
                    patch.object(session.subprocess, "Popen") as spawn, \
                    patch.dict(session.os.environ, {"PATH": "synthetic path", "DEVELOPER_POSTGRES_PASSWORD": "synthetic secret"}, clear=True):
                instance = session.PerformanceSession(Path(directory), [], {})
                instance.start()
                instance.stop("stopped")
            self.assertFalse(spawn.call_args.kwargs["shell"])
            self.assertEqual(spawn.call_args.kwargs["env"], {"PATH": "synthetic path"})
            self.assertNotIn("synthetic secret", str(spawn.call_args.args))

    def test_window_failure_still_saves_and_prints_report(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            tracker = Mock()
            tracker.snapshot.return_value = {"elapsed_seconds": 1}
            tracker.finish.return_value = ({"synthetic": True}, Path(directory) / "report.json")
            with patch.object(session, "SessionTracker", return_value=tracker), \
                    patch.object(session.subprocess, "Popen", side_effect=OSError("synthetic-secret")), \
                    patch.object(session, "render_report", return_value="Synthetic report"), \
                    redirect_stdout(io.StringIO()) as output:
                instance = session.PerformanceSession(Path(directory), ["docker", "compose"], {})
                instance.start()
                instance.stop("synthetic stop")
                instance.show_report()
            state = json.loads(instance.state_path.read_text())
            self.assertEqual(state["phase"], "finished")
            self.assertEqual(state["report_text"], "Synthetic report")
            self.assertIn("Synthetic report", output.getvalue())
            self.assertNotIn("synthetic-secret", output.getvalue())
            tracker.finish.assert_called_once_with("synthetic stop")


if __name__ == "__main__":
    unittest.main()
