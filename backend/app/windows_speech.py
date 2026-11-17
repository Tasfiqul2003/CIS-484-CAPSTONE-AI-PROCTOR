"""Explicitly configured Windows offline speech with bounded file-only IPC."""

import asyncio
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile

from .speech_adapters import (
    MAX_AUDIO_BYTES, ProviderAudio, ProviderStatus, SpeechError, SpeechService,
    _validate_audio,
)


WORKER = Path(__file__).with_name("windows_speech_worker.ps1")
STDOUT_LIMIT = 64 * 1024
STDERR_LIMIT = 8 * 1024


def _runtime_environment():
    """The speech process must never inherit backend credentials or arbitrary vars."""
    allowed = ("SystemRoot", "WINDIR", "SystemDrive", "USERPROFILE", "APPDATA",
               "LOCALAPPDATA", "TEMP", "TMP", "ProgramData", "ProgramFiles",
               "ProgramFiles(x86)", "CommonProgramFiles", "CommonProgramFiles(x86)")
    environment = {name: os.environ[name] for name in allowed if os.environ.get(name)}
    system_root = environment.get("SystemRoot") or environment.get("WINDIR") or r"C:\Windows"
    environment["SystemRoot"] = system_root
    environment.setdefault("WINDIR", system_root)
    environment.setdefault("SystemDrive", system_root[:2] if system_root[1:2] == ":" else "C:")
    # Do not inherit PATH: provider binaries/worker are absolute, and Windows
    # framework compilation needs only the trusted operating-system locations.
    environment["PATH"] = os.pathsep.join((str(Path(system_root) / "System32"),
        system_root, str(Path(system_root) / "System32/WindowsPowerShell/v1.0")))
    return environment


def _powershell():
    if os.name != "nt":
        return None
    candidate = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    return candidate if candidate.is_file() and WORKER.is_file() else None


def _arguments(executable):
    # Text, audio and selected paths are stdin data, never shell command text.
    return [str(executable), "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(WORKER)]


def _decode(result):
    try:
        body = json.loads(result.decode("utf-8-sig"))
    except (ValueError, UnicodeError):
        raise SpeechError("invalid_output", "Native speech returned invalid output.", 502) from None
    if not isinstance(body, dict) or body.get("ok") is not True:
        raise SpeechError("provider_unavailable", "Native Windows speech is unavailable.")
    return body


def probe_native():
    """Metadata only; no model startup, synthesis, recognition or audio device."""
    executable = _powershell()
    if executable is None:
        return None
    try:
        # Worker probe has a fixed output bound: <=64 voices and16 recognizer IDs.
        result = subprocess.run(_arguments(executable), input=b'{"operation":"probe"}',
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=8,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), env=_runtime_environment(), check=False)
        if result.returncode or len(result.stdout) > STDOUT_LIMIT or len(result.stderr) > STDERR_LIMIT:
            return None
        body = _decode(result.stdout)
        voices, recognizers = body.get("voices"), body.get("recognizers")
        if not isinstance(voices, list) or not isinstance(recognizers, list):
            return None
        if any(not isinstance(value, str) or not 1 <= len(value) <= 256 for value in voices + recognizers):
            return None
        return executable, voices, recognizers
    except (OSError, subprocess.TimeoutExpired, SpeechError):
        return None


async def _read_limited(stream, limit):
    output = bytearray()
    while True:
        chunk = await stream.read(4096)
        if not chunk:
            return bytes(output)
        if len(output) + len(chunk) > limit:
            raise SpeechError("invalid_output", "Native speech exceeded its output limit.", 502)
        output.extend(chunk)


async def invoke_native(executable, payload):
    encoded = json.dumps(payload, ensure_ascii=True).encode("utf-8")
    if len(encoded) > 100000:
        raise SpeechError("invalid_input", "Native speech request exceeds its size limit.", 422)
    process = await asyncio.create_subprocess_exec(*_arguments(executable),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        env=_runtime_environment())
    tasks = []
    try:
        process.stdin.write(encoded)
        await process.stdin.drain()
        process.stdin.close()
        tasks = [asyncio.create_task(_read_limited(process.stdout, STDOUT_LIMIT)),
                 asyncio.create_task(_read_limited(process.stderr, STDERR_LIMIT))]
        stdout, _ = await asyncio.wait_for(asyncio.gather(*tasks), timeout=28)
        await asyncio.wait_for(process.wait(), timeout=2)
        if process.returncode:
            raise SpeechError("provider_unavailable", "Native Windows speech failed.")
        return _decode(stdout)
    except asyncio.TimeoutError:
        raise SpeechError("provider_timeout", "Native Windows speech timed out.", 504) from None
    finally:
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(process.wait(), timeout=2)
            except asyncio.TimeoutError:
                pass
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


class WindowsSynthesisProvider:
    def __init__(self, executable, voices):
        self.executable = executable
        english = [voice for voice in voices if voice in ("Microsoft David Desktop", "Microsoft Zira Desktop")]
        self.voices = {"calm": "Microsoft David Desktop" if "Microsoft David Desktop" in english else english[0],
                       "clear": "Microsoft Zira Desktop" if "Microsoft Zira Desktop" in english else english[0]} if english else {}

    def status(self):
        return ProviderStatus(bool(self.voices), "windows-system-speech", tuple(self.voices))

    async def synthesize(self, request):
        if request.voice not in self.voices:
            raise SpeechError("invalid_input", "This native speech voice is unavailable.", 422)
        # Windows rate is an approximate platform rate, not exact playback speed.
        rate = max(-10, min(10, round(math.log2(request.speed) * 5)))
        with tempfile.TemporaryDirectory(prefix="cybros-speech-") as directory:
            output = Path(directory) / "output.wav"
            await invoke_native(self.executable, {"operation": "synthesize", "text": request.text,
                "voice": self.voices[request.voice], "rate": rate, "output_path": str(output)})
            if not output.is_file() or output.stat().st_size > MAX_AUDIO_BYTES:
                raise SpeechError("invalid_output", "Native speech output is missing or too large.", 502)
            result = ProviderAudio(output.read_bytes())
            _validate_audio(result.audio, result.mime_type, output=True)
            return result


class WindowsTranscriptionProvider:
    accepted_mime_types = ("audio/wav",)

    def __init__(self, executable, recognizers):
        self.executable = executable
        self.recognizer = recognizers[0] if recognizers else None

    def status(self):
        return ProviderStatus(self.recognizer is not None, "windows-system-speech")

    async def transcribe(self, request):
        if request.mime_type != "audio/wav":
            raise SpeechError("invalid_input", "Native transcription requires PCM WAV audio.", 422)
        _validate_audio(request.audio, request.mime_type)
        with tempfile.TemporaryDirectory(prefix="cybros-speech-") as directory:
            source = Path(directory) / "input.wav"
            source.write_bytes(request.audio)
            result = await invoke_native(self.executable, {"operation": "transcribe",
                "input_path": str(source), "recognizer": self.recognizer})
            value = result.get("text")
            if not isinstance(value, str) or len(value) > 8000:
                raise SpeechError("invalid_output", "Native speech returned an invalid transcript.", 502)
            return value


def configured_windows_service():
    probe = probe_native()
    if probe is None:
        return SpeechService()
    executable, voices, recognizers = probe
    return SpeechService(synthesis=WindowsSynthesisProvider(executable, voices),
                         transcription=WindowsTranscriptionProvider(executable, recognizers))
