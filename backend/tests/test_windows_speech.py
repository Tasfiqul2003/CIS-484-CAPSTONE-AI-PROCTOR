"""Native provider boundaries; native file-only integration is explicitly opt-in."""

import asyncio
import io
import json
import os
from pathlib import Path
from uuid import uuid4
import wave

import pytest

from backend.app import exam_speech, windows_speech
from backend.app.speech_adapters import (
    SpeechContext, SpeechError, SpeechOutputRequest, SpeechService, TranscriptionRequest,
)


def context():
    return SpeechContext(uuid4(), uuid4(), "native-synthetic-test", uuid4())


def wav():
    result = io.BytesIO()
    with wave.open(result, "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(16000)
        stream.writeframes(b"\x00\x00" * 1600)
    return result.getvalue()


def test_factory_is_disabled_without_explicit_config(monkeypatch):
    monkeypatch.delenv("CYBROS_SPEECH_PROVIDER", raising=False)
    monkeypatch.setattr(windows_speech, "probe_native", lambda: pytest.fail("Must not probe implicitly"))
    assert exam_speech.get_speech_service() is exam_speech._service


def test_factory_probes_once_when_explicit_and_caches(monkeypatch):
    calls = []
    monkeypatch.setenv("CYBROS_SPEECH_PROVIDER", "windows-system-speech")
    monkeypatch.setattr(exam_speech, "_native_service", None)
    monkeypatch.setattr(windows_speech, "probe_native", lambda: calls.append(1) or
        (Path("synthetic-powershell.exe"), ["Microsoft David Desktop"], ["synthetic-recognizer"]))
    one = exam_speech.get_speech_service()
    assert one is exam_speech.get_speech_service()
    assert calls == [1]
    assert one.capabilities()["transcription"]["accepted_mime_types"] == ["audio/wav"]


def test_absent_native_runtime_stays_unavailable(monkeypatch):
    monkeypatch.setattr(windows_speech, "probe_native", lambda: None)
    assert windows_speech.configured_windows_service().capabilities()["synthesis"]["available"] is False


def test_native_synthesis_uses_stdin_data_private_temp_and_cleanup(monkeypatch):
    paths = []
    async def invoke(exe, body):
        assert body["operation"] == "synthesize"
        assert body["text"] == 'Synthetic text $(never a command)'
        path = Path(body["output_path"])
        paths.append(path)
        path.write_bytes(wav())
        return {"ok": True}
    monkeypatch.setattr(windows_speech, "invoke_native", invoke)
    provider = windows_speech.WindowsSynthesisProvider(Path("synthetic-powershell.exe"), ["Microsoft David Desktop"])
    request = SpeechOutputRequest(context(), 'Synthetic text $(never a command)')
    result = asyncio.run(SpeechService(synthesis=provider).synthesize(request, is_current=lambda _: True))
    assert result.audio == wav()
    assert paths and not paths[0].exists() and not paths[0].parent.exists()


def test_transcription_requires_exact_wav_and_cleans_temp(monkeypatch):
    paths = []
    async def invoke(exe, body):
        assert body["operation"] == "transcribe"
        path = Path(body["input_path"])
        paths.append(path)
        assert path.read_bytes() == wav()
        return {"ok": True, "text": "Synthetic draft"}
    monkeypatch.setattr(windows_speech, "invoke_native", invoke)
    provider = windows_speech.WindowsTranscriptionProvider(Path("synthetic-powershell.exe"), ["synthetic-recognizer"])
    service = SpeechService(transcription=provider)
    result = asyncio.run(service.transcribe(TranscriptionRequest(context(), wav(), "audio/wav"), is_current=lambda _: True))
    assert result.text == "Synthetic draft"
    assert not paths[0].parent.exists()
    with pytest.raises(SpeechError) as error:
        asyncio.run(service.transcribe(TranscriptionRequest(context(), b"\x1aE\xdf\xa3fake", "audio/webm"), is_current=lambda _: True))
    assert error.value.code == "invalid_input"
    assert len(paths) == 1


def test_cancelled_native_work_cleans_temporary_files(monkeypatch):
    paths = []
    async def invoke(exe, body):
        paths.append(Path(body["input_path"]))
        await asyncio.sleep(10)
    monkeypatch.setattr(windows_speech, "invoke_native", invoke)
    provider = windows_speech.WindowsTranscriptionProvider(Path("synthetic-powershell.exe"), ["synthetic-recognizer"])
    async def scenario():
        task = asyncio.create_task(provider.transcribe(TranscriptionRequest(context(), wav(), "audio/wav")))
        await asyncio.sleep(0)
        assert paths[0].exists()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    asyncio.run(scenario())
    assert not paths[0].parent.exists()


def test_worker_output_decoding_is_safe():
    for invalid in (b"secret-native-error", b'{"ok":false,"error":"private-path"}', b"[]"):
        with pytest.raises(SpeechError) as error:
            windows_speech._decode(invalid)
        assert "private-path" not in str(error.value)
    assert windows_speech._decode(b'{"ok":true,"text":"synthetic"}')["text"] == "synthetic"


def test_bounded_worker_pipe():
    class Stream:
        def __init__(self):
            self.count = 0
        async def read(self, _size):
            self.count += 1
            return b"synthetic" if self.count < 3 else b""
    with pytest.raises(SpeechError) as error:
        asyncio.run(windows_speech._read_limited(Stream(), 9))
    assert error.value.code == "invalid_output"


class FakeProcess:
    class Input:
        def __init__(self):
            self.data = b""
        def write(self, data):
            self.data += data
        async def drain(self):
            pass
        def close(self):
            pass
    class Stream:
        def __init__(self, value=b"", block=False):
            self.value, self.block = value, block
        async def read(self, _size):
            if self.block:
                await asyncio.sleep(100)
            value, self.value = self.value, b""
            return value
    def __init__(self, *, block=False):
        self.stdin = self.Input()
        self.stdout = self.Stream(b'{"ok":true}', block=block)
        self.stderr = self.Stream()
        self.returncode = None
        self.killed = False
    async def wait(self):
        if self.returncode is None:
            self.returncode = 0
        return self.returncode
    def kill(self):
        self.killed = True
        self.returncode = -9


def test_worker_payload_is_stdin_never_command_text(monkeypatch):
    process, arguments = FakeProcess(), []
    async def create(*args, **kwargs):
        arguments.extend(args)
        assert kwargs["stdin"] == asyncio.subprocess.PIPE
        return process
    monkeypatch.setattr(asyncio, "create_subprocess_exec", create)
    assert asyncio.run(windows_speech.invoke_native(Path("synthetic.exe"),
        {"operation": "synthesize", "text": "synthetic private $(untrusted)"}))["ok"] is True
    assert "synthetic private" not in " ".join(arguments)
    assert json.loads(process.stdin.data)["text"] == "synthetic private $(untrusted)"


def test_worker_is_killed_on_external_cancellation(monkeypatch):
    process = FakeProcess(block=True)
    async def create(*args, **kwargs):
        return process
    monkeypatch.setattr(asyncio, "create_subprocess_exec", create)
    async def scenario():
        task = asyncio.create_task(windows_speech.invoke_native(Path("synthetic.exe"), {"operation": "probe"}))
        await asyncio.sleep(0.001)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert process.killed
    asyncio.run(scenario())


def test_native_provider_rejects_compressed_audio_before_worker(monkeypatch):
    async def unexpected(*args):
        pytest.fail("Unsupported compressed audio must not reach native worker")
    monkeypatch.setattr(windows_speech, "invoke_native", unexpected)
    provider = windows_speech.WindowsTranscriptionProvider(Path("synthetic.exe"), ["synthetic-id"])
    with pytest.raises(SpeechError) as error:
        asyncio.run(SpeechService(transcription=provider).transcribe(
            TranscriptionRequest(context(), b"\x1aE\xdf\xa3synthetic", "audio/webm"), is_current=lambda _: True))
    assert error.value.code == "invalid_input"


@pytest.mark.skipif(os.environ.get("CYBROS_RUN_NATIVE_SPEECH_TESTS") != "1", reason="Explicit file-only native speech verification opt-in")
def test_actual_native_generated_wav_round_trip():
    service = windows_speech.configured_windows_service()
    assert service.capabilities()["synthesis"]["available"] is True
    assert service.capabilities()["transcription"]["available"] is True
    async def scenario():
        correlation = context()
        audio = await service.synthesize(SpeechOutputRequest(correlation,
            "The library contains books about computer science."), is_current=lambda _: True)
        result = await service.transcribe(TranscriptionRequest(correlation, audio.audio, "audio/wav"), is_current=lambda _: True)
        assert audio.duration_seconds > 1
        assert "library" in result.text.lower()
        assert "computer science" in result.text.lower()
    asyncio.run(scenario())


def test_native_probe_excludes_backend_secrets_and_untrusted_path(monkeypatch):
    from types import SimpleNamespace
    secrets = ('DATABASE_URL', 'AUTH_SECRET_KEY', 'PGPASSWORD', 'ADMIN_BOOTSTRAP_TOKEN', 'ARBITRARY_TEST_TOKEN')
    for name in secrets:
        monkeypatch.setenv(name, 'synthetic-secret-not-for-native-process')
    monkeypatch.setenv('PATH', 'untrusted-synthetic-directory')
    monkeypatch.setattr(windows_speech, '_powershell', lambda: Path('synthetic-powershell.exe'))
    def run(*args, **kwargs):
        environment = kwargs['env']
        assert all(name.casefold() not in {key.casefold() for key in environment} for name in secrets)
        assert 'untrusted-synthetic-directory' not in environment['PATH']
        assert environment['SystemRoot'] and environment['WINDIR']
        return SimpleNamespace(returncode=0, stderr=b'', stdout=b'{"ok":true,"voices":[],"recognizers":[]}')
    monkeypatch.setattr(windows_speech.subprocess, 'run', run)
    assert windows_speech.probe_native() is not None


def test_native_async_worker_excludes_backend_secrets(monkeypatch):
    secrets = ('DATABASE_URL', 'AUTH_SECRET_KEY', 'PGPASSWORD', 'ADMIN_BOOTSTRAP_TOKEN', 'ARBITRARY_TEST_TOKEN')
    for name in secrets:
        monkeypatch.setenv(name, 'synthetic-secret-not-for-native-process')
    monkeypatch.setenv('PATH', 'untrusted-synthetic-directory')
    process = FakeProcess()
    async def create(*args, **kwargs):
        environment = kwargs['env']
        assert all(name.casefold() not in {key.casefold() for key in environment} for name in secrets)
        assert 'untrusted-synthetic-directory' not in environment['PATH']
        return process
    monkeypatch.setattr(asyncio, 'create_subprocess_exec', create)
    assert asyncio.run(windows_speech.invoke_native(Path('synthetic.exe'), {'operation':'probe'}))['ok'] is True
