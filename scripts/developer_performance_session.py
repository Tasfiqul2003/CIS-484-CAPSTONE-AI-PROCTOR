"""Launcher adapter: local measurements and a separate, optional native viewer."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import uuid

try:  # Support both direct launcher execution and import-based regression tests.
    from .developer_performance import SessionTracker, render_report
except ImportError:
    from developer_performance import SessionTracker, render_report


SETTINGS_NAME = ".developer-performance.json"


def load_enabled(root: Path) -> bool:
    path = root / SETTINGS_NAME
    if not path.exists():
        return False
    value = json.loads(path.read_text(encoding="utf-8"))
    if (not isinstance(value, dict) or set(value) != {"version", "enabled"}
            or type(value["version"]) is not int or value["version"] != 1
            or type(value["enabled"]) is not bool):
        raise ValueError("Invalid performance tracking settings; fix or rename .developer-performance.json.")
    return value["enabled"]


def atomic_json(path: Path, value: dict) -> None:
    temporary = path.with_suffix(".tmp")
    try:
        temporary.write_text(json.dumps(value, allow_nan=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def save_enabled(root: Path, enabled: bool) -> None:
    atomic_json(root / SETTINGS_NAME, {"version": 1, "enabled": enabled})


class PerformanceSession:
    def __init__(self, root: Path, compose: list[str], env: dict):
        self.root = root
        self.tracker = SessionTracker(root, compose, env)
        self.state_path = root / ".developer-reports" / f"viewer-{uuid.uuid4().hex}.state.json"
        self.stop_event = threading.Event()
        self.publisher = None
        self.viewer = None
        self.report = None
        self.report_path = None
        self.publisher_stuck = False

    def start(self) -> None:
        self.tracker.start()
        try:
            self.state_path.parent.mkdir(parents=True, exist_ok=True)
            self.publish()
            # The viewer never receives the backend's secret-bearing environment.
            safe_names = {"systemroot", "windir", "path", "temp", "tmp", "home", "userprofile",
                          "localappdata", "appdata", "display", "wayland_display", "xauthority"}
            viewer_env = {key: value for key, value in os.environ.items() if key.lower() in safe_names}
            self.viewer = subprocess.Popen(
                [sys.executable, "-B", str(self.root / "scripts/developer_performance_window.py"),
                 "--state", str(self.state_path)],
                env=viewer_env, shell=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        except (OSError, ValueError):
            print("Performance window unavailable; the session report will still be printed and saved if possible.")
        self.publisher = threading.Thread(target=self._publish_loop, daemon=True, name="performance-viewer-state")
        self.publisher.start()

    def publish(self) -> None:
        atomic_json(self.state_path, {"phase": "running", "snapshot": self.tracker.snapshot()})

    def _publish_loop(self) -> None:
        while not self.stop_event.wait(1):
            try:
                self.publish()
            except (OSError, ValueError):
                pass  # Retry; a temporary viewer-write failure must not stop collection.

    def register_process(self, name: str, pid: int) -> None:
        try:
            self.tracker.register_process(name, pid)
        except Exception:
            print("Performance process measurements unavailable; core services will continue.")

    def stop(self, reason: str) -> None:
        self.stop_event.set()
        if self.publisher is not None:
            self.publisher.join(timeout=2)
            self.publisher_stuck = self.publisher.is_alive()
        self.report, self.report_path = self.tracker.finish(reason)

    def show_report(self) -> None:
        if self.report is None:
            return
        report_text = render_report(self.report)
        print("\n" + report_text)
        if self.report_path:
            print(f"Local performance report: {self.report_path}")
        else:
            print("The JSON report could not be saved; use the console summary or any available text report.")
        if self.publisher_stuck:
            print("Performance window updates stalled; use the console summary or saved report.")
            return
        try:
            atomic_json(self.state_path, {"phase": "finished", "report_text": report_text,
                                        "report_path": str(self.report_path) if self.report_path else None})
        except (OSError, ValueError):
            print("Performance popup unavailable; use the console summary or saved report.")
        if self.viewer is not None and self.viewer.poll() is not None:
            print("Performance viewer exited; use the console summary or saved report.")
