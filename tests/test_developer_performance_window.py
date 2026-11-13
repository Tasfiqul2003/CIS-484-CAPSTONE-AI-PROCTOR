"""Synthetic formatting and state-file checks; no desktop window is opened."""

import importlib.util
from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("performance_window", ROOT / "scripts/developer_performance_window.py")
window = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(window)


class PerformanceWindowTests(unittest.TestCase):
    def test_formats_measured_host_services_and_gpu(self):
        text = window.format_snapshot({
            "elapsed_seconds": 10,
            "host": {"cpu_percent": 5.25, "memory_used_mb": 1024, "memory_percent": 25},
            "services": [{"name": "Frontend", "cpu_percent": 2, "memory_mb": 128, "status": "Measured"}],
            "gpu": {"utilization_percent": 0, "memory_used_mb": 0, "status": "Device total"},
            "warnings": ["Synthetic warning"],
        })
        for expected in ("10.0 seconds", "5.2%", "1,024.0 MiB", "Frontend", "128.0 MiB", "0.0%", "Synthetic warning",
                         "total machine capacity", "one core as 100%", "can exceed 100%"):
            self.assertIn(expected, text)

    def test_timestamp_age_uses_collector_time_and_rejects_unknown_timezone(self):
        now = datetime(2026, 11, 12, 16, 0, 10, tzinfo=timezone.utc)
        self.assertEqual(window.sample_age({"sampled_at": "2026-11-12T16:00:00+00:00"}, now), 10)
        self.assertEqual(window.sample_age({"sampled_at": "2026-11-12T16:00:00Z"}, now), 10)
        for value in (None, "invalid", "2026-11-12T16:00:00", 42):
            with self.subTest(value=value):
                self.assertIsNone(window.sample_age({"sampled_at": value}, now))
        self.assertIn("Last sampled: Unavailable", window.format_snapshot({}))
        self.assertIn("Last sampled: 2026-11-12T16:00:00Z",
                      window.format_snapshot({"sampled_at": "2026-11-12T16:00:00Z"}))

    def test_missing_or_invalid_measurements_do_not_become_zero(self):
        for value in (None, True, "5", float("nan"), float("inf"), -1):
            with self.subTest(value=value):
                text = window.format_snapshot({"host": {"cpu_percent": value}})
                self.assertIn("CPU: Unavailable", text)
                self.assertNotIn("0.0%", text)

    def test_reads_running_and_finished_states(self):
        with tempfile.TemporaryDirectory(prefix=".developer-window-test-", dir=ROOT) as directory:
            path = Path(directory) / "state.json"
            for state in ({"phase": "running", "snapshot": {}},
                          {"phase": "finished", "report_text": "Synthetic report", "report_path": None}):
                path.write_text(json.dumps(state), encoding="utf-8")
                self.assertEqual(window.read_state(path), state)

    def test_rejects_invalid_and_oversize_updates(self):
        with tempfile.TemporaryDirectory(prefix=".developer-window-test-", dir=ROOT) as directory:
            path = Path(directory) / "state.json"
            for value in ("{", "[]", '{}', '{"phase":"running"}', '{"phase":"finished","report_text":42}', ' ' * 2_000_001):
                path.write_text(value, encoding="utf-8")
                with self.subTest(length=len(value)), self.assertRaises(ValueError):
                    window.read_state(path)


if __name__ == "__main__":
    unittest.main()
