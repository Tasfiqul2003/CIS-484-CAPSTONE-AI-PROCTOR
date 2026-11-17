"""Optional timing log shared with the avatar service: one CSV row per model call.

Set TIMING_LOG to a file path to turn it on (the pod script points it at the avatar's log, so every
step of a turn lands in one file). Rows hold durations and GPU memory, never a student's words.
"""
import os
import subprocess
import threading
import time
from contextlib import contextmanager
from datetime import datetime

_LOCK = threading.Lock()
_GPU = {"at": 0.0, "value": ("", "")}
HEADER = "time,service,component,seconds,gpu_used_mib,gpu_total_mib,detail\n"


def _gpu_memory():
    if time.time() - _GPU["at"] > 1:
        try:
            out = subprocess.run(
                ["nvidia-smi", "--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=3).stdout.strip().splitlines()[0]
            used, total = [part.strip() for part in out.split(",")[:2]]
            _GPU["value"] = (used, total)
        except Exception:
            _GPU["value"] = ("", "")
        _GPU["at"] = time.time()
    return _GPU["value"]


def log_timing(component: str, seconds: float, detail: str = "") -> None:
    path = os.environ.get("TIMING_LOG")
    if not path:
        return
    try:
        used, total = _gpu_memory()
        note = " ".join(str(detail).split())[:80].replace('"', "'")
        row = f'{datetime.now().isoformat(timespec="seconds")},exam app,{component},{seconds:.2f},{used},{total},"{note}"\n'
        with _LOCK:
            os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
            new = not os.path.exists(path)
            with open(path, "a") as f:
                if new:
                    f.write(HEADER)
                f.write(row)
    except Exception:
        pass  # The log must never break an exam.


@contextmanager
def timed(component: str, detail: str = ""):
    start = time.perf_counter()
    try:
        yield
    finally:
        log_timing(component, time.perf_counter() - start, detail)
