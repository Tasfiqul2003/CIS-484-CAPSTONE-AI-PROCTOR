"""Opt-in, local-only resource summaries for a Developer Mode run.

Importing this module does not sample anything. psutil is optional. Docker and
NVIDIA probes are read-only, bounded, and never store command lines or secrets.
"""

from __future__ import annotations

import copy
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
import time
import uuid

try:
    import psutil
except ImportError:
    psutil = None


INTERVAL_SECONDS = 3
COMMAND_TIMEOUT_SECONDS = 2
LIMITATIONS = [
    "Local Developer Mode run only; no student responses, recordings, credentials or command lines are collected.",
    "Host CPU is percent of all logical CPUs. Service CPU uses a one-core basis and can exceed 100%; these columns are not directly comparable.",
    "Memory is measured in MiB. Host memory includes other applications; only registered app processes and this project's backend/database containers are attributed.",
    "Frontend means the Node development server and its children, not browser tabs. Container values may include reclaimable memory according to Docker's platform accounting.",
    "GPU figures are device-wide: maximum device utilization and summed used memory. GPU use cannot be attributed to this application.",
    "Averages and peaks use successful periodic samples only; startup, brief spikes, inaccessible processes and forced termination may be missed.",
    "Collection waits the configured interval after each cycle; bounded Docker/GPU queries add latency. Live sampled-at time identifies the latest completed cycle.",
]


def _number(value):
    """Accept finite nonnegative measurements only (never bool/NaN/Infinity)."""
    if isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (ValueError, TypeError, OverflowError):
        return None
    return result if math.isfinite(result) and result >= 0 else None


def _memory_mib(value):
    match = re.fullmatch(r"\s*([\d.]+)\s*(B|KiB|MiB|GiB|TiB|kB|KB|MB|GB|TB)\s*", str(value))
    if not match:
        return None
    number = _number(match[1])
    factors = {"B": 1, "KiB": 1024, "MiB": 1024**2, "GiB": 1024**3,
               "TiB": 1024**4, "kB": 1000, "KB": 1000, "MB": 1000**2,
               "GB": 1000**3, "TB": 1000**4}
    return number * factors[match[2]] / 1024**2 if number is not None else None


def _utc():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _run(args, env):
    try:
        result = subprocess.run(args, env=env, capture_output=True, text=True,
                                shell=False, timeout=COMMAND_TIMEOUT_SECONDS,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0)
        return result.stdout if result.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        return None


def _records(raw):
    if not raw or len(raw) > 1_000_000:
        return []
    try:
        value = json.loads(raw)
        return value if isinstance(value, list) else [value] if isinstance(value, dict) else []
    except (ValueError, TypeError):
        result = []
        for line in raw.splitlines():
            try:
                value = json.loads(line)
                if isinstance(value, dict):
                    result.append(value)
            except ValueError:
                continue
        return result


def _empty_metric():
    return {"sum": 0.0, "peak": None, "samples": 0}


def _write_report_file(path, content):
    """Keep a failed save from leaving a truncated report at its final name."""
    temporary = path.with_suffix(path.suffix + ".tmp")
    try:
        temporary.write_text(content, encoding="utf-8")
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


class SessionTracker:
    """Thread-safe bounded summaries; call finish before owned-service cleanup."""

    def __init__(self, root: Path, compose: list[str], env: dict, interval_seconds=INTERVAL_SECONDS):
        self.root = Path(root)
        self.compose = list(compose)
        self.env = dict(env)
        self.interval = max(0.1, float(interval_seconds))
        self._lock = threading.RLock()
        self._finish_lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self._started_at = None
        self._started_clock = None
        self._host_primed = False
        self._roots = {}
        self._processes = {}
        self._aggregates = {"host": {}, "gpu": {}, "services": {}}
        self._count = 0
        self._finished = None
        self._gpu_command = shutil.which("nvidia-smi", path=env.get("PATH"))
        self._latest = {"elapsed_seconds": 0, "sampled_at": None, "host": {
            "cpu_percent": None, "memory_used_mb": None, "memory_percent": None},
            "services": [], "gpu": {"utilization_percent": None, "memory_used_mb": None,
                                     "status": "Waiting for sample"}, "warnings": []}

    def start(self):
        with self._lock:
            if self._started_at is not None or self._stop.is_set():
                return
            self._started_at, self._started_clock = _utc(), time.monotonic()
            self._thread = threading.Thread(target=self._worker, name="developer-performance", daemon=True)
            self._thread.start()

    def register_process(self, label, pid):
        # The label allowlist is intentional: never persist arbitrary caller text.
        names = {"frontend": "Frontend (Node dev server)", "local_ai": "Local AI (owned process)",
                 "Frontend (Node dev server)": "Frontend (Node dev server)",
                 "Local AI (owned process)": "Local AI (owned process)"}
        name = names.get(label)
        if name is None or not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
            return
        process = None
        if psutil is not None:
            try:
                process = psutil.Process(pid)
                process.create_time()  # Initialize identity before PID could be reused.
            except (psutil.Error, OSError):
                process = None
        with self._lock:
            if not self._stop.is_set():
                self._roots[name] = process

    def snapshot(self):
        with self._lock:
            value = copy.deepcopy(self._latest)
            if self._started_clock is not None and self._finished is None:
                value["elapsed_seconds"] = max(0, time.monotonic() - self._started_clock)
            return value

    def _host_sample(self):
        result = {"cpu_percent": None, "memory_used_mb": None, "memory_percent": None}
        if psutil is None:
            return result
        try:
            cpu = _number(psutil.cpu_percent(interval=None))
            # psutil's first nonblocking call is an initialization value.
            if self._host_primed:
                result["cpu_percent"] = cpu
            self._host_primed = True
        except (psutil.Error, OSError):
            pass
        try:
            memory = psutil.virtual_memory()
            used = _number(memory.used)
            result["memory_used_mb"] = used / 1024**2 if used is not None else None
            result["memory_percent"] = _number(memory.percent)
        except (psutil.Error, OSError):
            pass
        return result

    def _process_samples(self):
        with self._lock:
            roots = dict(self._roots)
        result = []
        active_keys = set()
        for name, root in roots.items():
            cpu, memory, complete, primed = 0.0, 0.0, True, True
            processes = []
            if root is not None:
                try:
                    if root.is_running():  # psutil checks PID reuse against create_time.
                        processes = [root] + root.children(recursive=True)
                except (psutil.Error, OSError):
                    complete = False
            if not processes:
                complete = False
            for process in processes:
                try:
                    key = (name, process.pid, process.create_time())
                    active_keys.add(key)
                    previous = self._processes.get(key)
                    if previous is None:
                        self._processes[key] = process
                        process.cpu_percent(interval=None)
                        primed = False
                    else:
                        value = _number(previous.cpu_percent(interval=None))
                        if value is None:
                            primed = False
                        else:
                            cpu += value
                    value = _number(process.memory_info().rss)
                    if value is None:
                        complete = False
                    else:
                        memory += value / 1024**2
                except (psutil.Error, OSError):
                    complete = False
            result.append({"name": name, "cpu_percent": cpu if complete and primed else None,
                           "memory_mb": memory if complete else None,
                           "status": "Measured" if complete and primed else
                                     "CPU warming up" if complete else "Unavailable or process exited"})
        self._processes = {key: value for key, value in self._processes.items() if key in active_keys}
        return result

    def _docker_samples(self):
        service_names = {"backend": "Backend (container)", "db": "Database (container)",
                         "migrate": "Migrations (one-shot container)"}
        missing = {name: {"name": name, "cpu_percent": None, "memory_mb": None,
                          "status": "Unavailable or container not running"}
                   for name in service_names.values()}
        if not self.compose or self._stop.is_set():
            return list(missing.values())
        raw = _run(self.compose + ["ps", "--format", "json", *service_names], self.env)
        ids = {}
        for record in _records(raw):
            if not isinstance(record, dict):
                continue
            service, identifier = record.get("Service"), record.get("ID")
            if service in service_names and isinstance(identifier, str) and re.fullmatch(r"[0-9a-f]{12,64}", identifier):
                ids[identifier] = service_names[service]
        if not ids or self._stop.is_set():
            return list(missing.values())
        raw = _run([self.compose[0], "stats", "--no-stream", "--format", "{{json .}}", *ids], self.env)
        measurements = {}
        for record in _records(raw):
            if not isinstance(record, dict):
                continue
            identifier = record.get("ID", record.get("Container", ""))
            if not isinstance(identifier, str):
                continue
            matches = [key for key in ids if key == identifier or
                       (len(identifier) >= 12 and key.startswith(identifier))]
            if len(matches) != 1:
                continue
            matched_id = matches[0]
            cpu = _number(str(record.get("CPUPerc", "")).removesuffix("%"))
            memory = _memory_mib(str(record.get("MemUsage", "")).split("/", 1)[0])
            values = (cpu, memory)
            if matched_id not in measurements:
                measurements[matched_id] = values
            elif measurements[matched_id] != values:
                # Conflicting duplicate rows are not a trustworthy measurement.
                measurements[matched_id] = (None, None)
        for name, existing in missing.items():
            expected = [identifier for identifier, service_name in ids.items() if service_name == name]
            if not expected:
                continue
            values = [measurements.get(identifier, (None, None)) for identifier in expected]
            # An incomplete replica total must not masquerade as the service's
            # measured usage. CPU and memory completeness are checked separately.
            cpu = sum(value[0] for value in values) if all(value[0] is not None for value in values) else None
            memory = sum(value[1] for value in values) if all(value[1] is not None for value in values) else None
            existing.update(cpu_percent=cpu, memory_mb=memory)
            if cpu is not None and memory is not None:
                existing["status"] = "Measured"
            else:
                existing["status"] = "Some metrics unavailable (container samples missing or invalid)"
        return list(missing.values())

    def _gpu_sample(self):
        result = {"utilization_percent": None, "memory_used_mb": None,
                  "status": "Unavailable: NVIDIA device metrics not supported or accessible"}
        if not self._gpu_command or self._stop.is_set():
            return result
        raw = _run([self._gpu_command, "--query-gpu=utilization.gpu,memory.used",
                    "--format=csv,noheader,nounits"], self.env)
        if not raw:
            return result
        utilization, memory = [], []
        for line in raw.splitlines():
            fields = line.split(",")
            if len(fields) != 2:
                return result
            used, mem = (_number(item.strip()) for item in fields)
            if used is None or used > 100 or mem is None:
                return result
            utilization.append(used)
            memory.append(mem)
        if utilization:
            result.update(utilization_percent=max(utilization), memory_used_mb=sum(memory),
                          status="Device-wide only; no app attribution")
        return result

    def _sample(self):
        host = self._host_sample()
        services = self._process_samples() + self._docker_samples()
        gpu = self._gpu_sample()
        warnings = []
        if psutil is None:
            warnings.append("Host and Node process metrics unavailable: psutil is not installed. Install scripts/requirements-developer.txt into the launcher Python environment.")
        if any(item["status"] != "Measured" for item in services):
            warnings.append("Some service metrics are unavailable, warming up, or the service is not running.")
        if gpu["utilization_percent"] is None:
            warnings.append("GPU metrics unavailable; unsupported hardware is not reported as zero usage.")
        return {"elapsed_seconds": max(0, time.monotonic() - self._started_clock), "sampled_at": _utc(),
                "host": host, "services": services, "gpu": gpu, "warnings": warnings}

    @staticmethod
    def _accumulate(target, values):
        for key, value in values.items():
            if key in ("status", "name"):
                continue
            metric = target.setdefault(key, _empty_metric())
            value = _number(value)
            if value is not None:
                metric["sum"] += value
                metric["peak"] = value if metric["peak"] is None else max(metric["peak"], value)
                metric["samples"] += 1

    def _worker(self):
        while not self._stop.is_set():
            try:
                value = self._sample()
                with self._lock:
                    if self._stop.is_set():
                        return
                    self._latest = value
                    self._count += 1
                    self._accumulate(self._aggregates["host"], value["host"])
                    self._accumulate(self._aggregates["gpu"], value["gpu"])
                    for item in value["services"]:
                        self._accumulate(self._aggregates["services"].setdefault(item["name"], {}), item)
            except Exception:
                # Telemetry must never end the development session. Do not expose exception
                # text: process errors can include environment values or command arguments.
                with self._lock:
                    if not self._stop.is_set():
                        self._latest["warnings"] = ["Performance sample unavailable; tracking will retry."]
            self._stop.wait(self.interval)

    def finish(self, reason):
        with self._finish_lock:
            return self._finish(reason)

    def _finish(self, reason):
        with self._lock:
            if self._finished is not None:
                return self._finished
            self._stop.set()
            ended_at = _utc()
            duration = max(0, time.monotonic() - self._started_clock) if self._started_clock is not None else 0
        # All three probes have individual two-second bounds. Do not wait on a
        # stuck OS resource forever; the stop guard prevents late summary writes.
        if self._thread is not None:
            self._thread.join(timeout=COMMAND_TIMEOUT_SECONDS * 3 + 1)
        with self._lock:
            def summary(metrics):
                return {key: {"average": round(value["sum"] / value["samples"], 2) if value["samples"] else None,
                              "peak": round(value["peak"], 2) if value["peak"] is not None else None,
                              "samples": value["samples"]} for key, value in metrics.items()}
            allowed_reasons = {"stopped", "startup_failed", "session_error", "frontend_exited", "normal_shutdown"}
            report = {"started_at": self._started_at, "ended_at": ended_at,
                      "duration_seconds": round(duration, 2),
                      "reason": reason if reason in allowed_reasons else "stopped", "sample_count": self._count,
                      "interval_seconds": self.interval,
                      "host": summary(self._aggregates["host"]), "gpu": summary(self._aggregates["gpu"]),
                      "services": [{"name": name, "metrics": summary(metrics)} for name, metrics in self._aggregates["services"].items()],
                      "limitations": LIMITATIONS + self._latest["warnings"]}
            if not self._count:
                report["limitations"].append("No samples completed. No resource usage can be inferred from this report.")
            path = None
            try:
                directory = self.root / ".developer-reports"
                directory.mkdir(exist_ok=True)
                stem = "performance-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
                candidate = directory / (stem + ".json")
                text_path = directory / (stem + ".txt")
                text_saved = False
                try:
                    _write_report_file(text_path, render_report(report))
                    text_saved = True
                except OSError:
                    # Write JSON second so its persisted limitations include any
                    # text-file failure, matching the popup and console report.
                    report["limitations"].append("The local text report could not be saved; the JSON report may still be available.")
                try:
                    _write_report_file(candidate, json.dumps(report, indent=2, allow_nan=False) + "\n")
                    path = candidate
                except (OSError, ValueError):
                    report["limitations"].append("The local JSON report could not be saved; use the console summary or text report if available.")
                    if text_saved:
                        try:
                            _write_report_file(text_path, render_report(report))
                        except OSError:
                            report["limitations"].append("The saved text report could not be updated with the JSON save failure notice.")
            except (OSError, ValueError):
                report["limitations"].append("One or more local report files could not be saved.")
            self._latest["elapsed_seconds"] = report["duration_seconds"]
            self._finished = (report, path)
            return self._finished


def render_report(report):
    """Render a compact report without any machine identity or process arguments."""
    labels = {"cpu_percent": "CPU %", "memory_used_mb": "Memory MiB", "memory_mb": "Memory MiB",
              "memory_percent": "Memory %", "utilization_percent": "GPU utilization %"}
    lines = ["Developer Mode performance report", f"Started (UTC): {report.get('started_at') or 'Unavailable'}",
             f"Ended (UTC): {report.get('ended_at') or 'Unavailable'}",
             f"Duration: {report.get('duration_seconds', 0):.1f} seconds",
             f"End reason: {report.get('reason', 'stopped')}",
             f"Completed samples: {report.get('sample_count', 0)}", ""]
    groups = [("Host (includes other applications)", report.get("host", {}))]
    groups.extend((item["name"], item["metrics"]) for item in report.get("services", []))
    groups.append(("GPU (device-wide, not app-attributed)", report.get("gpu", {})))
    for title, metrics in groups:
        lines.append(title)
        if not metrics:
            lines.append("  Unavailable: no completed samples")
        for name, metric in metrics.items():
            label = labels.get(name, name)
            if not metric["samples"]:
                lines.append(f"  {label}: unavailable")
            else:
                lines.append(f"  {label}: average {metric['average']:.2f}, peak {metric['peak']:.2f} ({metric['samples']} samples)")
        lines.append("")
    lines.append("Measurement limits")
    lines.extend("- " + line for line in report.get("limitations", []))
    return "\n".join(lines) + "\n"
