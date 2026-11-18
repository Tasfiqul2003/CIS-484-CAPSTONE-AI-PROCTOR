"""Synthetic resource checks; never sample a student recording or application DB."""

import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("developer_performance", ROOT / "scripts/developer_performance.py")
performance = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(performance)


class ResourceParserTests(unittest.TestCase):
    def test_only_finite_nonnegative_numbers(self):
        for value in (None, True, False, "NaN", "Infinity", -1, "garbage"):
            with self.subTest(value=value):
                self.assertIsNone(performance._number(value))
        self.assertEqual(performance._number("12.5"), 12.5)
        self.assertEqual(performance._number(0), 0)

    def test_memory_units_and_bad_units(self):
        self.assertEqual(performance._memory_mib("1 GiB"), 1024)
        self.assertEqual(performance._memory_mib("20MiB"), 20)
        self.assertAlmostEqual(performance._memory_mib("1MB"), 1000000 / 1024**2)
        for value in ("1 widgets", "NaN MiB", "-1 MiB", "not data"):
            self.assertIsNone(performance._memory_mib(value))

    def test_records_support_compose_array_and_newline_formats(self):
        self.assertEqual(performance._records('[{"Service":"db"}]'), [{"Service": "db"}])
        self.assertEqual(performance._records('{"ID":"a"}\n{"ID":"b"}'), [{"ID": "a"}, {"ID": "b"}])
        self.assertEqual(performance._records("malformed"), [])
        self.assertEqual(performance._records("x" * 1_000_001), [])

    def test_commands_are_literal_bounded_and_do_not_leak_stderr(self):
        args = ["synthetic docker & literal.exe", "stats", "--no-stream"]
        with patch.object(performance.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="ok")) as run:
            self.assertEqual(performance._run(args, {"SYNTHETIC_SECRET": "never serialize"}), "ok")
        self.assertEqual(run.call_args.args[0], args)
        self.assertFalse(run.call_args.kwargs["shell"])
        self.assertEqual(run.call_args.kwargs["timeout"], 2)
        with patch.object(performance.subprocess, "run", side_effect=subprocess.TimeoutExpired("secret", 2)):
            self.assertIsNone(performance._run(args, {}))


class ResourceSamplingTests(unittest.TestCase):
    def tracker(self, root=ROOT):
        with patch.object(performance.shutil, "which", return_value=None):
            return performance.SessionTracker(root, ["docker", "compose", "-p", "synthetic-project"], {})

    def test_docker_samples_only_valid_ids_for_allowed_services(self):
        tracker = self.tracker()
        discovery = json.dumps([
            {"Service": "backend", "ID": "a" * 64},
            {"Service": "db", "ID": "b" * 64},
            {"Service": "unrelated", "ID": "c" * 64},
            {"Service": "backend", "ID": "--unsafe-command"},
        ])
        stats = "\n".join(json.dumps(item) for item in [
            {"ID": "a" * 12, "CPUPerc": "125.5%", "MemUsage": "512MiB / 8GiB"},
            {"ID": "b" * 12, "CPUPerc": "2%", "MemUsage": "1GiB / 8GiB"},
            {"ID": "c" * 12, "CPUPerc": "99%", "MemUsage": "7GiB / 8GiB"},
        ])
        with patch.object(performance, "_run", side_effect=[discovery, stats]) as run:
            samples = tracker._docker_samples()
        self.assertEqual(run.call_args_list[0].args[0][-3:], ["backend", "db", "migrate"])
        self.assertEqual(run.call_args_list[1].args[0], ["docker", "stats", "--no-stream", "--format", "{{json .}}", "a" * 64, "b" * 64])
        self.assertEqual(samples[0]["cpu_percent"], 125.5)
        self.assertEqual(samples[0]["memory_mb"], 512)
        self.assertEqual(samples[1]["memory_mb"], 1024)
        self.assertIsNone(samples[2]["memory_mb"])

    def test_failed_docker_probe_and_nonfinite_metrics_are_unavailable_not_zero(self):
        tracker = self.tracker()
        with patch.object(performance, "_run", return_value=None) as run:
            samples = tracker._docker_samples()
        self.assertEqual(run.call_count, 1)
        self.assertTrue(all(item["cpu_percent"] is None for item in samples))
        with patch.object(performance, "_run", side_effect=[
            '{"Service":"db","ID":"bbbbbbbbbbbb"}',
            '{"ID":"bbbbbbbbbbbb","CPUPerc":"NaN%","MemUsage":"[unavailable] / 8GiB"}',
        ]):
            samples = tracker._docker_samples()
        self.assertIsNone(samples[1]["cpu_percent"])
        self.assertIsNone(samples[1]["memory_mb"])

    def test_missing_replica_does_not_report_a_partial_service_total(self):
        tracker = self.tracker()
        discovery = json.dumps([{"Service": "backend", "ID": "a" * 12},
                                {"Service": "backend", "ID": "b" * 12}])
        stats = json.dumps({"ID": "a" * 12, "CPUPerc": "10%", "MemUsage": "20MiB / 8GiB"})
        with patch.object(performance, "_run", side_effect=[discovery, stats]):
            sample = tracker._docker_samples()[0]
        self.assertIsNone(sample["cpu_percent"])
        self.assertIsNone(sample["memory_mb"])
        self.assertIn("samples missing or invalid", sample["status"])

    def test_replica_metrics_require_complete_values_and_duplicate_rows_do_not_inflate_totals(self):
        tracker = self.tracker()
        discovery = json.dumps([{"Service": "backend", "ID": "a" * 12},
                                {"Service": "backend", "ID": "b" * 12}])
        first = {"ID": "a" * 12, "CPUPerc": "10%", "MemUsage": "20MiB / 8GiB"}
        second = {"ID": "b" * 12, "CPUPerc": "NaN%", "MemUsage": "30MiB / 8GiB"}
        with patch.object(performance, "_run", side_effect=[discovery, "\n".join(json.dumps(row) for row in (first, first, second))]):
            sample = tracker._docker_samples()[0]
        self.assertIsNone(sample["cpu_percent"])
        self.assertEqual(sample["memory_mb"], 50)
        second["CPUPerc"] = "15%"
        with patch.object(performance, "_run", side_effect=[discovery, "\n".join(json.dumps(row) for row in (first, first, second))]):
            sample = tracker._docker_samples()[0]
        self.assertEqual(sample["cpu_percent"], 25)
        self.assertEqual(sample["memory_mb"], 50)
        self.assertEqual(sample["status"], "Measured")

    def test_host_cpu_warmup_and_missing_psutil(self):
        tracker = self.tracker()
        fake = SimpleNamespace(Error=Exception, cpu_percent=Mock(side_effect=[0, 12.5]),
                               virtual_memory=Mock(return_value=SimpleNamespace(used=1024**3, percent=50)))
        with patch.object(performance, "psutil", fake):
            first, second = tracker._host_sample(), tracker._host_sample()
        self.assertIsNone(first["cpu_percent"])
        self.assertEqual(first["memory_used_mb"], 1024)
        self.assertEqual(second["cpu_percent"], 12.5)
        with patch.object(performance, "psutil", None):
            self.assertTrue(all(value is None for value in tracker._host_sample().values()))

    def test_registered_processes_only_descendants_and_cpu_warmup(self):
        tracker = self.tracker()
        child = Mock(pid=13)
        root = Mock(pid=12)
        for process in (child, root):
            process.create_time.return_value = 100
            process.memory_info.return_value = SimpleNamespace(rss=10 * 1024**2)
            process.cpu_percent.return_value = 25
        root.children.return_value = [child]
        fake = SimpleNamespace(Error=Exception, Process=Mock(return_value=root))
        with patch.object(performance, "psutil", fake):
            tracker.register_process("frontend", 12)
            tracker.register_process("arbitrary private process name", 20)
            first, second = tracker._process_samples(), tracker._process_samples()
        fake.Process.assert_called_once_with(12)
        self.assertIsNone(first[0]["cpu_percent"])
        self.assertEqual(first[0]["memory_mb"], 20)
        self.assertEqual(second[0]["cpu_percent"], 50)
        self.assertEqual(second[0]["name"], "Frontend (Node dev server)")
        root.children.assert_called_with(recursive=True)

    def test_exited_root_does_not_report_recycled_pid(self):
        tracker = self.tracker()
        process = Mock(pid=12)
        process.is_running.return_value = False
        fake = SimpleNamespace(Error=Exception, Process=Mock(return_value=process))
        with patch.object(performance, "psutil", fake):
            tracker.register_process("frontend", 12)
            sample = tracker._process_samples()[0]
        self.assertIsNone(sample["memory_mb"])
        process.children.assert_not_called()

    def test_gpu_device_scope_and_unavailable_values(self):
        tracker = self.tracker()
        tracker._gpu_command = "synthetic nvidia-smi"
        with patch.object(performance, "_run", return_value="12, 100\n40, 200\n"):
            sample = tracker._gpu_sample()
        self.assertEqual(sample["utilization_percent"], 40)
        self.assertEqual(sample["memory_used_mb"], 300)
        self.assertIn("no app attribution", sample["status"])
        with patch.object(performance, "_run", return_value="[N/A], 100"):
            self.assertIsNone(tracker._gpu_sample()["utilization_percent"])


class ResourceReportTests(unittest.TestCase):
    def test_report_aggregation_local_files_and_no_secrets(self):
        with tempfile.TemporaryDirectory(prefix=".performance-test-", dir=ROOT) as directory:
            with patch.object(performance.shutil, "which", return_value=None):
                tracker = performance.SessionTracker(Path(directory), ["private command"], {"PASSWORD": "synthetic-secret"})
            tracker._started_at, tracker._started_clock = "synthetic UTC", time.monotonic()
            performance.SessionTracker._accumulate(tracker._aggregates["host"], {"cpu_percent": 10, "memory_percent": None})
            performance.SessionTracker._accumulate(tracker._aggregates["host"], {"cpu_percent": 30, "memory_percent": None})
            tracker._count = 2
            report, path = tracker.finish("normal_shutdown")
            self.assertEqual(report["host"]["cpu_percent"], {"average": 20, "peak": 30, "samples": 2})
            self.assertEqual(report["host"]["memory_percent"]["samples"], 0)
            self.assertTrue(path.is_file())
            self.assertTrue(path.with_suffix(".txt").is_file())
            saved = path.read_text(encoding="utf-8")
            self.assertNotIn("synthetic-secret", saved)
            self.assertNotIn("private command", saved)
            self.assertNotIn(directory.replace("\\", "\\\\"), saved)
            self.assertEqual(json.loads(saved), report)
            self.assertIn("Memory %: unavailable", performance.render_report(report))
            self.assertEqual(tracker.finish("session_error"), (report, path))
            self.assertEqual(len(list(path.parent.glob("*.json"))), 1)

    def test_storage_failure_and_unknown_reason_are_safe(self):
        tracker = ResourceSamplingTests().tracker()
        with patch.object(Path, "mkdir", side_effect=OSError("synthetic secret path")):
            report, path = tracker.finish("synthetic secret error")
        self.assertIsNone(path)
        self.assertEqual(report["reason"], "stopped")
        self.assertIn("No samples completed", performance.render_report(report))
        self.assertNotIn("synthetic secret", performance.render_report(report))

    def test_text_save_failure_is_in_persisted_json_and_returned_report(self):
        with tempfile.TemporaryDirectory(prefix=".performance-test-", dir=ROOT) as directory:
            tracker = ResourceSamplingTests().tracker(Path(directory))
            real_write = performance._write_report_file
            def write(path, content):
                if path.suffix == ".txt":
                    raise OSError("synthetic secret filesystem detail")
                return real_write(path, content)
            with patch.object(performance, "_write_report_file", side_effect=write):
                report, path = tracker.finish("stopped")
            self.assertIsNotNone(path)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), report)
            self.assertIn("local text report could not be saved", performance.render_report(report))
            self.assertNotIn("synthetic secret", path.read_text(encoding="utf-8"))

    def test_json_save_failure_updates_surviving_text_report(self):
        with tempfile.TemporaryDirectory(prefix=".performance-test-", dir=ROOT) as directory:
            tracker = ResourceSamplingTests().tracker(Path(directory))
            real_write = performance._write_report_file
            def write(path, content):
                if path.suffix == ".json":
                    raise OSError("synthetic secret filesystem detail")
                return real_write(path, content)
            with patch.object(performance, "_write_report_file", side_effect=write):
                report, path = tracker.finish("stopped")
            self.assertIsNone(path)
            text_path = next((Path(directory) / ".developer-reports").glob("*.txt"))
            self.assertEqual(text_path.read_text(encoding="utf-8"), performance.render_report(report))
            self.assertIn("local JSON report could not be saved", text_path.read_text(encoding="utf-8"))
            self.assertEqual(list(text_path.parent.glob("*.tmp")), [])

    def test_worker_shutdown_discards_inflight_sample_and_snapshot_is_copy(self):
        with tempfile.TemporaryDirectory(prefix=".performance-test-", dir=ROOT) as directory:
            tracker = ResourceSamplingTests().tracker(Path(directory))
            begun = threading.Event()
            release = threading.Event()
            def sample():
                begun.set()
                release.wait(timeout=1)
                return {"host": {"cpu_percent": 10}, "services": [], "gpu": {}, "warnings": [], "elapsed_seconds": 1}
            with patch.object(tracker, "_sample", side_effect=sample):
                tracker.start()
                self.assertTrue(begun.wait(timeout=1))
                tracker._stop.set()
                release.set()
                report, _ = tracker.finish("stopped")
            self.assertEqual(report["sample_count"], 0)
            self.assertFalse(tracker._thread.is_alive())
            snapshot = tracker.snapshot()
            snapshot["warnings"].append("mutation")
            self.assertNotIn("mutation", tracker.snapshot()["warnings"])

    def test_collector_exception_is_sanitized_and_retries(self):
        tracker = ResourceSamplingTests().tracker()
        tracker._started_clock = time.monotonic()
        def fail():
            tracker._stop.set()
            raise RuntimeError("synthetic-secret")
        with patch.object(tracker, "_sample", side_effect=fail):
            tracker._worker()
        self.assertNotIn("synthetic-secret", json.dumps(tracker.snapshot()))


if __name__ == "__main__":
    unittest.main()
