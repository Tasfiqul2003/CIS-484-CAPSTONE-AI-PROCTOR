"""Interactive optional-tool controls, independent of application startup."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess
import sys

try:
    from . import developer_start as startup
except ImportError:  # Direct execution from the BAT.
    import developer_start as startup


ROOT = Path(__file__).resolve().parents[1]
UNAVAILABLE = (
    ("Speech recognition", startup.UNAVAILABLE["transcription"]),
    ("Voice playback", startup.UNAVAILABLE["voice"]),
    ("Animated avatar", startup.UNAVAILABLE["avatar"]),
    ("Camera recording", startup.UNAVAILABLE["camera_recording"]),
)


class ToolSession:
    def __init__(self, root: Path, environ: dict):
        self.root = root
        self.env = dict(environ)
        self.ai = None
        self.performance = None

    def ai_status(self) -> str:
        if self.ai is not None and self.ai.poll() is None:
            return "ON (started by this menu)"
        if startup.local_json("/api/version") is not None:
            return "RUNNING EXTERNALLY (not controlled here)"
        return "OFF"

    def toggle_ai(self) -> None:
        if self.ai is not None and self.ai.poll() is None:
            startup.stop_process(self.ai)
            self.ai = None
            print("Local Ollama OFF.")
            return
        self.ai = None
        if startup.local_json("/api/version") is not None:
            print("Ollama is already running externally. Use its original controls to stop it.")
            return
        executable = startup.find_tool("ollama", self.env)
        if executable is None:
            raise startup.StartupError("Ollama is not installed. No tool was started.")
        self.ai = subprocess.Popen(
            [executable, "serve"], cwd=self.root,
            env=dict(self.env, OLLAMA_HOST="127.0.0.1:11434"), shell=False,
            creationflags=startup.hidden_flags(),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            startup.wait_for_http("http://127.0.0.1:11434/api/version", self.ai)
        except BaseException:
            startup.stop_process(self.ai)
            self.ai = None
            raise
        if self.performance is not None:
            self.performance.register_process("local_ai", self.ai.pid)
        print("Local Ollama ON. No model was downloaded or loaded by this menu.")

    def toggle_performance(self) -> None:
        if self.performance is not None:
            self.stop_performance()
            print("Performance tracking OFF.")
            return
        # Empty Compose plan: host/GPU and menu-owned AI only; no Docker calls.
        self.performance = startup.PerformanceSession(self.root, [], self.env)
        try:
            self.performance.start()
            if self.ai is not None and self.ai.poll() is None:
                self.performance.register_process("local_ai", self.ai.pid)
        except BaseException:
            self.stop_performance("startup_failed")
            raise
        print("Performance tracking ON (host/GPU and menu-owned Ollama; no website-service tracking).")

    def stop_performance(self, reason="stopped") -> None:
        performance, self.performance = self.performance, None
        if performance is not None:
            try:
                performance.stop(reason)
            finally:
                performance.show_report()

    def close(self) -> None:
        try:
            self.stop_performance()
        finally:
            startup.stop_process(self.ai)
            self.ai = None


def show_menu(ai_status: str, tracking: bool) -> None:
    print("\nCYBROS - Developer Tools")
    print(f"1. Toggle local Ollama: {ai_status}")
    print(f"2. Toggle performance tracking: {'ON' if tracking else 'OFF'}")
    for index, (name, reason) in enumerate(UNAVAILABLE, 3):
        print(f"{index}. {name}: UNAVAILABLE - {reason}")
    print("0. Exit and deactivate tools started by this menu")
    print("Tool controls only. Start the website separately; its configured capabilities still apply.")


def main(argv=None, *, input_fn=input) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--show-menu", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--performance-tracking", choices=("on", "off"),
                        help="Start tracking for this menu session; defaults to off.")
    args = parser.parse_args(argv)
    if args.show_menu or args.dry_run:
        show_menu("NOT CHECKED (preview)", args.performance_tracking == "on")
        print("Preview only: no settings saved, tools inspected, or processes started.")
        return 0

    session = ToolSession(ROOT, os.environ)
    try:
        # A separate lock leaves the legacy app launcher independent.
        with startup.session_lock(ROOT / "Developer Mode"):
            try:
                if args.performance_tracking == "on":
                    session.toggle_performance()
                while True:
                    show_menu(session.ai_status(), session.performance is not None)
                    try:
                        selected = input_fn("Select a tool [0-6]: ").strip()
                        if selected == "0":
                            break
                        if selected == "1":
                            session.toggle_ai()
                        elif selected == "2":
                            session.toggle_performance()
                        elif selected in ("3", "4", "5", "6"):
                            print(UNAVAILABLE[int(selected) - 3][1])
                        else:
                            print("Select a number from 0 to 6.")
                    except (startup.StartupError, OSError, ValueError) as exc:
                        print(f"Tool control: {exc}", file=sys.stderr)
            finally:
                session.close()
        return 0
    except (KeyboardInterrupt, EOFError):
        print("\nDeveloper tools stopped.")
        return 0
    except (startup.StartupError, OSError, ValueError) as exc:
        print(f"Developer tools: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
