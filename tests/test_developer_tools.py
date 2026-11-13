"""Synthetic optional-tool lifecycle checks; no real services or credentials."""

from contextlib import nullcontext, redirect_stdout, redirect_stderr
import io
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

from scripts import developer_tools as tools


class DeveloperToolTests(unittest.TestCase):
    def setUp(self):
        self.session = tools.ToolSession(Path("synthetic-checkout"), {"PATH": "synthetic"})

    def test_menu_session_never_starts_application_or_requests_secrets(self):
        with patch.object(tools.startup, "service_environment", side_effect=AssertionError("No credentials")), \
                patch.object(tools.startup, "launch", side_effect=AssertionError("No app startup")), \
                patch.object(tools.startup, "run_command", side_effect=AssertionError("No Docker")), \
                patch.object(tools.startup, "find_tool", side_effect=AssertionError("No prerequisites")), \
                patch.object(tools.startup, "load_choices", side_effect=AssertionError("No saved choices")), \
                patch.object(tools.startup, "load_enabled", side_effect=AssertionError("No saved tracking")), \
                patch.object(tools.startup, "local_json", return_value=None), \
                patch.object(tools.startup, "session_lock", return_value=nullcontext()), \
                redirect_stdout(io.StringIO()):
            self.assertEqual(tools.main([], input_fn=lambda _: "0"), 0)

    def test_previews_do_not_inspect_tools_lock_or_prompt(self):
        for args in (["--show-menu"], ["--dry-run", "--performance-tracking", "on"]):
            with self.subTest(args=args), \
                    patch.object(tools, "ToolSession", side_effect=AssertionError("No session")), \
                    patch.object(tools.startup, "session_lock", side_effect=AssertionError("No lock")), \
                    redirect_stdout(io.StringIO()) as output:
                self.assertEqual(tools.main(args, input_fn=Mock(side_effect=AssertionError("No input"))), 0)
                self.assertIn("NOT CHECKED", output.getvalue())

    def test_ai_on_then_off_stops_only_owned_process(self):
        process = Mock(pid=123, poll=Mock(return_value=None))
        with patch.object(tools.startup, "local_json", return_value=None), \
                patch.object(tools.startup, "find_tool", return_value="synthetic/ollama.exe"), \
                patch.object(tools.subprocess, "Popen", return_value=process) as spawn, \
                patch.object(tools.startup, "wait_for_http") as ready, \
                patch.object(tools.startup, "stop_process") as stop, redirect_stdout(io.StringIO()):
            self.session.toggle_ai()
            self.assertIs(self.session.ai, process)
            self.assertIn("ON", self.session.ai_status())
            self.assertEqual(spawn.call_args.args[0], ["synthetic/ollama.exe", "serve"])
            self.assertEqual(spawn.call_args.kwargs["env"]["OLLAMA_HOST"], "127.0.0.1:11434")
            self.assertFalse(spawn.call_args.kwargs["shell"])
            ready.assert_called_once_with("http://127.0.0.1:11434/api/version", process)
            self.session.toggle_ai()
            stop.assert_called_once_with(process)
            self.assertIsNone(self.session.ai)

    def test_external_ollama_is_reported_and_never_stopped_or_started(self):
        with patch.object(tools.startup, "local_json", return_value={"version": "synthetic"}), \
                patch.object(tools.subprocess, "Popen") as spawn, \
                patch.object(tools.startup, "stop_process") as stop, redirect_stdout(io.StringIO()):
            self.assertIn("EXTERNALLY", self.session.ai_status())
            self.session.toggle_ai()
            self.session.close()
            spawn.assert_not_called()
            stop.assert_called_once_with(None)

    def test_missing_ollama_fails_without_spawn(self):
        with patch.object(tools.startup, "local_json", return_value=None), \
                patch.object(tools.startup, "find_tool", return_value=None), \
                patch.object(tools.subprocess, "Popen") as spawn:
            with self.assertRaisesRegex(tools.startup.StartupError, "not installed"):
                self.session.toggle_ai()
            spawn.assert_not_called()

    def test_readiness_failure_and_interrupt_clean_up_partial_start(self):
        for failure in (tools.startup.StartupError("synthetic readiness failure"), KeyboardInterrupt()):
            with self.subTest(failure=type(failure).__name__), \
                    patch.object(tools.startup, "local_json", return_value=None), \
                    patch.object(tools.startup, "find_tool", return_value="synthetic-ollama"), \
                    patch.object(tools.subprocess, "Popen") as spawn, \
                    patch.object(tools.startup, "wait_for_http", side_effect=failure), \
                    patch.object(tools.startup, "stop_process") as stop:
                with self.assertRaises(type(failure)):
                    self.session.toggle_ai()
                stop.assert_called_once_with(spawn.return_value)
                self.assertIsNone(self.session.ai)

    def test_performance_on_off_has_no_compose_and_registers_owned_ai(self):
        self.session.ai = Mock(pid=123, poll=Mock(return_value=None))
        with patch.object(tools.startup, "PerformanceSession") as performance, redirect_stdout(io.StringIO()):
            self.session.toggle_performance()
            performance.assert_called_once_with(self.session.root, [], self.session.env)
            performance.return_value.start.assert_called_once_with()
            performance.return_value.register_process.assert_called_once_with("local_ai", 123)
            self.session.toggle_performance()
            performance.return_value.stop.assert_called_once_with("stopped")
            performance.return_value.show_report.assert_called_once_with()
            self.assertIsNone(self.session.performance)

    def test_tracking_started_before_ai_registers_new_owned_process(self):
        self.session.performance = Mock()
        with patch.object(tools.startup, "local_json", return_value=None), \
                patch.object(tools.startup, "find_tool", return_value="synthetic-ollama"), \
                patch.object(tools.subprocess, "Popen") as spawn, \
                patch.object(tools.startup, "wait_for_http"), redirect_stdout(io.StringIO()):
            self.session.toggle_ai()
            self.session.performance.register_process.assert_called_once_with("local_ai", spawn.return_value.pid)

    def test_failed_tracking_start_finalizes_and_clears_tracking(self):
        with patch.object(tools.startup, "PerformanceSession") as performance:
            performance.return_value.start.side_effect = OSError("synthetic start failure")
            with self.assertRaises(OSError):
                self.session.toggle_performance()
            performance.return_value.stop.assert_called_once_with("startup_failed")
            performance.return_value.show_report.assert_called_once_with()
            self.assertIsNone(self.session.performance)

    def test_tracking_failure_does_not_skip_owned_ai_cleanup(self):
        self.session.ai = Mock()
        self.session.performance = Mock()
        process, performance = self.session.ai, self.session.performance
        performance.stop.side_effect = OSError("synthetic report failure")
        with patch.object(tools.startup, "stop_process") as stop:
            with self.assertRaises(OSError):
                self.session.close()
            stop.assert_called_once_with(process)
            performance.show_report.assert_called_once_with()
            self.assertIsNone(self.session.ai)
            self.assertIsNone(self.session.performance)

    def test_unavailable_controls_and_bad_input_do_not_start_tools(self):
        answers = iter(("3", "4", "5", "6", "invalid", "0"))
        with patch.object(tools, "ToolSession") as session, \
                patch.object(tools.startup, "session_lock", return_value=nullcontext()), \
                redirect_stdout(io.StringIO()):
            self.assertEqual(tools.main([], input_fn=lambda _: next(answers)), 0)
            session.return_value.toggle_ai.assert_not_called()
            session.return_value.toggle_performance.assert_not_called()
            session.return_value.close.assert_called_once_with()

    def test_normal_exit_eof_and_interrupt_all_close_session(self):
        for ending in ("0", EOFError(), KeyboardInterrupt()):
            with self.subTest(ending=ending), patch.object(tools, "ToolSession") as session, \
                    patch.object(tools.startup, "session_lock", return_value=nullcontext()), \
                    redirect_stdout(io.StringIO()):
                reader = Mock(return_value=ending) if isinstance(ending, str) else Mock(side_effect=ending)
                self.assertEqual(tools.main([], input_fn=reader), 0)
                session.return_value.close.assert_called_once_with()

    def test_tool_failure_returns_to_menu_and_allows_exit(self):
        answers = iter(("1", "0"))
        with patch.object(tools, "ToolSession") as session, \
                patch.object(tools.startup, "session_lock", return_value=nullcontext()), \
                redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()) as errors:
            session.return_value.toggle_ai.side_effect = tools.startup.StartupError("synthetic unavailable")
            self.assertEqual(tools.main([], input_fn=lambda _: next(answers)), 0)
            self.assertIn("synthetic unavailable", errors.getvalue())
            session.return_value.close.assert_called_once_with()

    def test_bat_routes_to_tool_controller(self):
        root = Path(__file__).resolve().parents[1]
        bat = (root / "Developer Mode/Start_Developer.bat").read_text()
        self.assertIn('"scripts\\developer_tools.py" %*', bat)
        self.assertNotIn('"scripts\\developer_start.py"', bat)
        self.assertIn('Developer Mode\\Start_Developer.bat', (root / "Start_Developer.bat").read_text())


if __name__ == "__main__":
    unittest.main()
