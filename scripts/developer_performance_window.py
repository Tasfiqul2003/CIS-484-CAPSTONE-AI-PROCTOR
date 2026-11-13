"""Local, read-only Developer Mode performance window (standard library only).

The launcher owns collection and writes a small JSON state file. This separate
process never inspects processes, environment variables, or examination data.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import time


def _number(value: object, suffix: str) -> str:
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
        return "Unavailable"
    return f"{value:,.1f}{suffix}"


def sample_age(snapshot: dict, now: datetime | None = None) -> float | None:
    """Use the collector timestamp rather than the window's refresh time."""
    try:
        stamp = datetime.fromisoformat(snapshot.get("sampled_at", ""))
        if stamp.tzinfo is None:
            return None
        age = ((now or datetime.now(timezone.utc)) - stamp).total_seconds()
        return max(0.0, age)
    except (TypeError, ValueError, OverflowError):
        return None


def format_snapshot(snapshot: dict) -> str:
    """Format measured values without substituting zero for missing metrics."""
    host = snapshot.get("host") if isinstance(snapshot.get("host"), dict) else {}
    gpu = snapshot.get("gpu") if isinstance(snapshot.get("gpu"), dict) else {}
    elapsed = snapshot.get("elapsed_seconds")
    age = sample_age(snapshot)
    sampled_at = snapshot.get("sampled_at") if age is not None else "Unavailable"
    lines = [
        f"Elapsed: {_number(elapsed, ' seconds')}",
        f"Last sampled: {sampled_at}",
        f"Sample age: {_number(age, ' seconds')}",
        "",
        "MONITORED HOST",
        f"CPU: {_number(host.get('cpu_percent'), '%')}",
        f"Memory: {_number(host.get('memory_used_mb'), ' MiB')}"
        f"  |  {_number(host.get('memory_percent'), '%')}",
        "",
        "APPLICATION SERVICES",
    ]
    services = snapshot.get("services") if isinstance(snapshot.get("services"), list) else []
    services = [service for service in services if isinstance(service, dict)]
    if not services:
        lines.append("No application process measurements available yet.")
    for service in services:
        lines.append(str(service.get("name", "Application service")))
        lines.append(
            f"  CPU: {_number(service.get('cpu_percent'), '%')}"
            f"  |  Memory: {_number(service.get('memory_mb'), ' MiB')}"
        )
        if service.get("status"):
            lines.append(f"  {service['status']}")
    lines.extend([
        "",
        "GPU — DEVICE TOTAL",
        f"Usage: {_number(gpu.get('utilization_percent'), '%')}"
        f"  |  Memory: {_number(gpu.get('memory_used_mb'), ' MiB')}",
    ])
    if gpu.get("status"):
        lines.append(str(gpu["status"]))
    lines.extend([
        "", "MEASUREMENT NOTES",
        "Host CPU is a percentage of total machine capacity.",
        "Service CPU uses one core as 100% and can exceed 100%.",
        "Host totals include other work on this machine; service values cover tracked application processes.",
    ])
    if isinstance(snapshot.get("warnings"), list) and snapshot["warnings"]:
        lines.extend(str(warning) for warning in snapshot["warnings"])
    return "\n".join(lines)


def read_state(path: Path) -> dict:
    """Read one complete, bounded state update; atomic writes may be retried."""
    with path.open("r", encoding="utf-8") as handle:
        raw = handle.read(2_000_001)
    if len(raw) > 2_000_000:
        raise ValueError("State update exceeds the display limit.")
    state = json.loads(raw)
    if not isinstance(state, dict) or state.get("phase") not in ("running", "finished"):
        raise ValueError("Unknown performance state.")
    if state["phase"] == "running" and not isinstance(state.get("snapshot"), dict):
        raise ValueError("Missing snapshot.")
    if state["phase"] == "finished" and not isinstance(state.get("report_text"), str):
        raise ValueError("Missing report text.")
    return state


def run_window(state_path: Path) -> int:
    # Import only when requested: formatter tests do not need a desktop session.
    import tkinter as tk
    from tkinter import messagebox, ttk

    root = tk.Tk()
    root.title("Developer Mode · Performance tracking")
    root.geometry("740x690")
    root.minsize(540, 420)
    root.configure(background="#eef2f6")
    style = ttk.Style(root)
    style.theme_use("clam")
    style.configure("Page.TFrame", background="#eef2f6")
    style.configure("Heading.TLabel", background="#eef2f6", foreground="#142d4e",
                    font=("Segoe UI", 19, "bold"))
    style.configure("Body.TLabel", background="#eef2f6", foreground="#344861",
                    font=("Segoe UI", 10))
    style.configure("TButton", font=("Segoe UI", 10), padding=(12, 8))

    frame = ttk.Frame(root, padding=24, style="Page.TFrame")
    frame.pack(fill="both", expand=True)
    heading = ttk.Label(frame, text="Performance tracking", style="Heading.TLabel")
    heading.pack(anchor="w")
    status = ttk.Label(frame, text="Waiting for the first measurement…", style="Body.TLabel",
                       wraplength=650)
    status.pack(anchor="w", pady=(6, 16))
    body_frame = ttk.Frame(frame)
    body_frame.pack(fill="both", expand=True)
    body = tk.Text(body_frame, wrap="word", state="disabled", background="#ffffff",
                   foreground="#172b46", font=("Segoe UI", 11), padx=18, pady=16,
                   relief="flat", highlightthickness=1, highlightbackground="#c4cfdb",
                   highlightcolor="#1769bb", takefocus=True)
    scrollbar = ttk.Scrollbar(body_frame, orient="vertical", command=body.yview)
    body.configure(yscrollcommand=scrollbar.set)
    scrollbar.pack(side="right", fill="y")
    body.pack(side="left", fill="both", expand=True)
    footer = ttk.Frame(frame, style="Page.TFrame")
    footer.pack(fill="x", pady=(16, 0))
    note = ttk.Label(footer, text="Closing this view keeps tracking on.",
                     style="Body.TLabel", wraplength=370)
    note.pack(side="left", fill="x", expand=True)

    finished = False
    stale = False
    received = False
    report_path = None
    last_content = None
    last_version = None
    last_update = time.monotonic()
    missing_count = 0

    def close():
        if finished or stale:
            root.destroy()
        else:
            root.withdraw()

    def open_report_folder():
        if not report_path:
            return
        try:
            path = Path(report_path)
            if os.name != "nt" or not path.is_absolute() or not path.is_file():
                raise OSError()
            os.startfile(str(path.parent))
        except (OSError, ValueError):
            messagebox.showinfo("Report folder unavailable",
                                "The report folder could not be opened. Use the saved path in the report.",
                                parent=root)

    open_button = ttk.Button(footer, text="Open report folder", command=open_report_folder)
    close_button = ttk.Button(footer, text="Hide window", command=close)
    close_button.pack(side="right")
    root.protocol("WM_DELETE_WINDOW", close)
    root.bind("<Escape>", lambda _event: close())

    def set_body(content):
        nonlocal last_content
        if content == last_content:
            return
        position = body.yview()[0]
        body.configure(state="normal")
        body.delete("1.0", "end")
        body.insert("1.0", content)
        body.configure(state="disabled")
        body.yview_moveto(position)
        last_content = content

    def refresh():
        nonlocal finished, stale, received, report_path, last_version, last_update, missing_count
        age = None
        try:
            stamp = state_path.stat()
            state = read_state(state_path)
            snapshot = state.get("snapshot", {})
            age = sample_age(snapshot)
            version = snapshot.get("sampled_at") if age is not None else (stamp.st_mtime_ns, stamp.st_size)
            missing_count = 0
            received = True
            if version != last_version:
                last_update = time.monotonic()
                last_version = version
                stale = False
            if state["phase"] == "finished":
                report_path = state.get("report_path")
                heading.configure(text="Session performance report")
                status.configure(text="Session ended. Report saved locally." if report_path
                                 else "Session ended. Report is displayed below; local saving was unavailable.")
                note.configure(text="This report stays on this computer.")
                set_body(state["report_text"])
                if report_path and os.name == "nt":
                    open_button.pack(side="right", padx=(0, 8))
                close_button.configure(text="Close")
                if not finished:
                    finished = True
                    root.deiconify()
                    root.lift()
                    root.bell()
                    close_button.focus_set()
                return  # Preserve the final popup even after launcher exits.
            set_body(format_snapshot(state["snapshot"]))
            status.configure(text="Live measurements from the machine running Developer Mode. "
                             "Updates depend on collector availability.")
            note.configure(text="Closing this view keeps tracking on.")
            close_button.configure(text="Hide window")
        except FileNotFoundError:
            missing_count += 1
            if received and missing_count >= 3:
                root.destroy()
                return
        except (OSError, ValueError, TypeError, KeyError):
            # A transient file access or malformed update must not crash the UI.
            status.configure(text="Waiting for a complete measurement update…")
        if time.monotonic() - last_update > 90 or (age is not None and age > 90):
            if not stale:
                root.deiconify()
                root.lift()
            stale = True
            status.configure(text="Tracking updates stopped. The launcher may have closed unexpectedly. "
                             "The values below are no longer current.")
            note.configure(text="A final report was not received.")
            close_button.configure(text="Close")
        root.after(1000, refresh)

    root.after(0, refresh)
    root.mainloop()
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        return run_window(args.state)
    except Exception:
        # Desktop/Tk availability varies; launcher retains the saved text report.
        print("Performance window unavailable. Review the local report in .developer-reports.")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
