"""Synthetic async adapter checks: no providers, network, devices or database."""

import asyncio
from dataclasses import replace
import io
from uuid import uuid4
import wave

import pytest

from backend.app.speech_adapters import (
    MAX_AUDIO_BYTES, MAX_TEXT_CHARS, ProviderAudio, ProviderStatus, SpeechContext,
    SpeechError, SpeechOutputRequest, SpeechService, TranscriptionRequest,
)


def context():
    return SpeechContext(uuid4(), uuid4(), "revision-1", uuid4())


def wav(seconds=0.1):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(8000)
        stream.writeframes(b"\x00\x00" * int(8000 * seconds))
    return buffer.getvalue()


class SyntheticProvider:
    def __init__(self):
        self.output = ProviderAudio(wav())
        self.transcript = " synthetic confirmed-by-student-later draft "
        self.delay = 0
        self.error = None
        self.available = True
        self.requests = []
        self.before_return = None
        self.active = 0
        self.max_active = 0
        self.was_cancelled = False

    def status(self):
        return ProviderStatus(self.available, "synthetic-only", ("calm", "clear"))

    async def _call(self, request, value):
        self.requests.append(request)
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            await asyncio.sleep(self.delay)
            if self.error:
                raise self.error
            if self.before_return:
                self.before_return()
            return value
        except asyncio.CancelledError:
            self.was_cancelled = True
            raise
        finally:
            self.active -= 1

    async def synthesize(self, request):
        return await self._call(request, self.output)

    async def transcribe(self, request):
        return await self._call(request, self.transcript)


def run(awaitable):
    return asyncio.run(awaitable)


def test_default_is_explicitly_unavailable():
    service = SpeechService()
    assert service.capabilities()["synthesis"] == {
        "available": False, "provider": None, "reason": "provider_unavailable"}
    assert service.capabilities()["transcription"]["available"] is False
    with pytest.raises(SpeechError) as failure:
        run(service.synthesize(SpeechOutputRequest(context(), "Approved question"), is_current=lambda _: True))
    assert failure.value.code == "provider_unavailable"


def test_success_is_correlated_and_audio_duration_is_measured():
    provider = SyntheticProvider()
    request = SpeechOutputRequest(context(), "Approved synthetic question")
    result = run(SpeechService(synthesis=provider).synthesize(request, is_current=lambda _: True))
    assert result.context == request.context
    assert result.mime_type == "audio/wav"
    assert result.duration_seconds == pytest.approx(0.1)
    assert result.status == "complete"
    assert provider.requests == [request]
    assert request.text not in repr(request)
    assert "audio=" not in repr(result)


def test_transcription_is_only_a_draft():
    request = TranscriptionRequest(context(), wav(), "audio/wav")
    result = run(SpeechService(transcription=SyntheticProvider()).transcribe(request, is_current=lambda _: True))
    assert result.context == request.context
    assert result.text == "synthetic confirmed-by-student-later draft"
    assert result.source == "machine_draft"
    assert result.status == "review_required"
    assert result.text not in repr(result)


@pytest.mark.parametrize("output", [ProviderAudio(b"invalid", "audio/wav"),
    ProviderAudio(wav(), "audio/mp3"), ProviderAudio(b"x" * (MAX_AUDIO_BYTES + 1)),
    ProviderAudio(wav(120.01)), ProviderAudio(wav()[:-4]), {"audio": "fake"}])
def test_invalid_or_oversized_provider_output_is_rejected(output):
    provider = SyntheticProvider()
    provider.output = output
    with pytest.raises(SpeechError) as failure:
        run(SpeechService(synthesis=provider).synthesize(
            SpeechOutputRequest(context(), "Question"), is_current=lambda _: True))
    assert failure.value.code == "invalid_output"
    assert failure.value.status_code == 502


@pytest.mark.parametrize("changes", [{"text": ""}, {"text": "x" * (MAX_TEXT_CHARS + 1)},
    {"speed": float("nan")}, {"speed": True}, {"speed": 3}, {"voice": "unconfigured"}])
def test_invalid_speech_requests_do_not_call_provider(changes):
    provider = SyntheticProvider()
    request = replace(SpeechOutputRequest(context(), "Question"), **changes)
    with pytest.raises(SpeechError) as failure:
        run(SpeechService(synthesis=provider).synthesize(request, is_current=lambda _: True))
    assert failure.value.code == "invalid_input"
    assert not provider.requests


@pytest.mark.parametrize("audio,mime", [(b"", "audio/wav"), (b"fake", "audio/webm"),
    (b"fake", "audio/ogg"), (b"fake", "audio/mp4"), (wav(), "audio/unknown"),
    (wav(120.01), "audio/wav")], ids=["empty", "invalid-webm", "invalid-ogg", "invalid-mp4", "unknown-type", "too-long"])
def test_invalid_transcription_input_does_not_call_provider(audio, mime):
    provider = SyntheticProvider()
    with pytest.raises(SpeechError) as failure:
        run(SpeechService(transcription=provider).transcribe(
            TranscriptionRequest(context(), audio, mime), is_current=lambda _: True))
    assert failure.value.code == "invalid_input"
    assert not provider.requests


@pytest.mark.parametrize("transcript,code", [("   ", "empty_transcript"),
    ("x" * (MAX_TEXT_CHARS + 1), "invalid_output"), ({"text": "fake"}, "invalid_output")])
def test_invalid_transcripts_are_not_success(transcript, code):
    provider = SyntheticProvider()
    provider.transcript = transcript
    with pytest.raises(SpeechError) as failure:
        run(SpeechService(transcription=provider).transcribe(
            TranscriptionRequest(context(), wav(), "audio/wav"), is_current=lambda _: True))
    assert failure.value.code == code


def test_stale_question_is_rejected_before_provider_call():
    provider = SyntheticProvider()
    with pytest.raises(SpeechError) as failure:
        run(SpeechService(synthesis=provider).synthesize(
            SpeechOutputRequest(context(), "Question"), is_current=lambda _: False))
    assert failure.value.code == "stale_context"
    assert not provider.requests


def test_late_result_after_attempt_ends_is_discarded():
    provider = SyntheticProvider()
    state = {"active": True}
    provider.before_return = lambda: state.update(active=False)
    with pytest.raises(SpeechError) as failure:
        run(SpeechService(synthesis=provider).synthesize(
            SpeechOutputRequest(context(), "Question"), is_current=lambda _: state["active"]))
    assert failure.value.code == "stale_context"


def test_wrong_attempt_guard_rejects_cross_attempt_result():
    provider = SyntheticProvider()
    active = context()
    wrong = replace(active, attempt_id=uuid4())
    with pytest.raises(SpeechError) as failure:
        run(SpeechService(synthesis=provider).synthesize(
            SpeechOutputRequest(wrong, "Question"), is_current=lambda c: c == active))
    assert failure.value.code == "stale_context"


def test_timeout_cancels_provider_without_retry():
    provider = SyntheticProvider()
    provider.delay = 0.2
    with pytest.raises(SpeechError) as failure:
        run(SpeechService(synthesis=provider, timeout_seconds=0.01).synthesize(
            SpeechOutputRequest(context(), "Question"), is_current=lambda _: True))
    assert failure.value.code == "provider_timeout"
    assert provider.was_cancelled
    assert len(provider.requests) == 1


def test_explicit_cancellation_and_task_cancellation():
    async def scenario():
        provider = SyntheticProvider()
        provider.delay = 10
        service = SpeechService(synthesis=provider)
        cancelled = asyncio.Event()
        task = asyncio.create_task(service.synthesize(SpeechOutputRequest(context(), "Question"),
            is_current=lambda _: True, cancellation=cancelled))
        await asyncio.sleep(0.01)
        cancelled.set()
        with pytest.raises(SpeechError) as failure:
            await task
        assert failure.value.code == "cancelled"
        await asyncio.sleep(0)
        assert provider.was_cancelled

        task = asyncio.create_task(service.synthesize(SpeechOutputRequest(context(), "Question"),
            is_current=lambda _: True))
        await asyncio.sleep(0.01)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0)
        assert provider.active == 0
    run(scenario())


def test_concurrency_bound_and_queued_state_guard():
    async def scenario():
        provider = SyntheticProvider()
        provider.delay = 0.02
        service = SpeechService(synthesis=provider, concurrency=1)
        request1, request2 = SpeechOutputRequest(context(), "One"), SpeechOutputRequest(context(), "Two")
        current = {request1.context.attempt_id, request2.context.attempt_id}
        guard = lambda c: c.attempt_id in current
        task1 = asyncio.create_task(service.synthesize(request1, is_current=guard))
        await asyncio.sleep(0.001)
        task2 = asyncio.create_task(service.synthesize(request2, is_current=guard))
        await asyncio.sleep(0.001)
        current.remove(request2.context.attempt_id)
        await task1
        with pytest.raises(SpeechError) as failure:
            await task2
        assert failure.value.code == "stale_context"
        assert provider.max_active == 1
        assert provider.requests == [request1]
    run(scenario())


def test_provider_failure_does_not_leak_private_exception_text():
    provider = SyntheticProvider()
    provider.error = RuntimeError("synthetic-secret-transcript-never-public")
    with pytest.raises(SpeechError) as failure:
        run(SpeechService(synthesis=provider).synthesize(
            SpeechOutputRequest(context(), "Question"), is_current=lambda _: True))
    assert failure.value.code == "provider_unavailable"
    assert "synthetic-secret" not in str(failure.value)


def test_async_guard_and_missing_provider_configuration():
    async def active(_):
        return True
    provider = SyntheticProvider()
    run(SpeechService(synthesis=provider).synthesize(
        SpeechOutputRequest(context(), "Question"), is_current=active))
    provider.available = False
    assert SpeechService(synthesis=provider).capabilities()["synthesis"]["available"] is False


def test_context_and_resource_validation():
    with pytest.raises(SpeechError):
        SpeechContext("not-a-uuid", uuid4(), "1", uuid4())
    with pytest.raises(SpeechError):
        replace(context(), question_revision="")
    for options in ({"timeout_seconds": float("inf")}, {"concurrency": True},
                    {"concurrency": 0}, {"timeout_seconds": 121}):
        with pytest.raises(ValueError):
            SpeechService(**options)
