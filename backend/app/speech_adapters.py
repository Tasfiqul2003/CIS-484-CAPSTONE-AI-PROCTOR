"""Bounded optional speech providers; no devices, database or provider startup.

Routes own authentication, approved text selection and persistence. A current-state
guard is mandatory before and after work so a late result cannot be delivered to
another question or an ended/revoked attempt. Providers must support cancellation.
"""

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
import inspect
import io
import math
from typing import Protocol
from uuid import UUID
import wave


MAX_TEXT_CHARS = 8000
MAX_AUDIO_BYTES = 10 * 1024 * 1024
MAX_AUDIO_SECONDS = 120.0
SUPPORTED_INPUTS = ("audio/wav", "audio/webm", "audio/ogg", "audio/mp4")


class SpeechError(Exception):
    """Safe public failure, with no provider exception text or private payload."""

    def __init__(self, code: str, message: str, status_code: int = 503):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


@dataclass(frozen=True)
class SpeechContext:
    attempt_id: UUID
    interaction_id: UUID
    question_revision: str
    request_id: UUID

    def __post_init__(self):
        if not all(isinstance(value, UUID) for value in
                   (self.attempt_id, self.interaction_id, self.request_id)):
            raise SpeechError("invalid_input", "Speech correlation identifiers are invalid.", 422)
        if (not isinstance(self.question_revision, str) or
                not 1 <= len(self.question_revision) <= 128):
            raise SpeechError("invalid_input", "Question revision is invalid.", 422)


@dataclass(frozen=True)
class ProviderStatus:
    """Adapter reports verified local readiness, never just an enabled setting."""

    available: bool
    provider: str | None = None
    voices: tuple[str, ...] = ()


@dataclass(frozen=True)
class SpeechOutputRequest:
    context: SpeechContext
    text: str = field(repr=False)
    voice: str = "calm"
    speed: float = 1.0


@dataclass(frozen=True)
class TranscriptionRequest:
    context: SpeechContext
    audio: bytes = field(repr=False)
    mime_type: str = "audio/webm"


@dataclass(frozen=True)
class ProviderAudio:
    audio: bytes = field(repr=False)
    mime_type: str = "audio/wav"


@dataclass(frozen=True)
class SpeechAudio:
    context: SpeechContext
    audio: bytes = field(repr=False)
    mime_type: str
    duration_seconds: float
    status: str = "complete"


@dataclass(frozen=True)
class TranscriptDraft:
    context: SpeechContext
    text: str = field(repr=False)
    source: str = "machine_draft"
    status: str = "review_required"


class SynthesisProvider(Protocol):
    def status(self) -> ProviderStatus: ...
    async def synthesize(self, request: SpeechOutputRequest) -> ProviderAudio: ...


class TranscriptionProvider(Protocol):
    def status(self) -> ProviderStatus: ...
    async def transcribe(self, request: TranscriptionRequest) -> str: ...


CurrentGuard = Callable[[SpeechContext], bool | Awaitable[bool]]


def _wav_duration(audio: bytes, *, output: bool) -> float:
    code = "invalid_output" if output else "invalid_input"
    status = 502 if output else 422
    try:
        with wave.open(io.BytesIO(audio), "rb") as stream:
            frames, rate = stream.getnframes(), stream.getframerate()
            if (stream.getnchannels() not in (1, 2) or stream.getsampwidth() not in (1, 2, 3, 4)
                    or not 8000 <= rate <= 48000 or frames < 1
                    or frames / rate > MAX_AUDIO_SECONDS):
                raise ValueError("Unsupported PCM parameters")
            expected = frames * stream.getnchannels() * stream.getsampwidth()
            if expected > MAX_AUDIO_BYTES or len(stream.readframes(frames)) != expected:
                raise ValueError("Incomplete or excessive PCM frames")
            return frames / rate
    except (ValueError, EOFError, wave.Error, OverflowError) as error:
        raise SpeechError(code, "Speech audio must contain supported, complete PCM WAV data.", status) from error


def _validate_audio(audio, mime_type, *, output=False):
    code = "invalid_output" if output else "invalid_input"
    status = 502 if output else 422
    if type(audio) is not bytes or not 1 <= len(audio) <= MAX_AUDIO_BYTES:
        raise SpeechError(code, "Speech audio is empty or exceeds the size limit.", status)
    allowed = ("audio/wav",) if output else SUPPORTED_INPUTS
    if mime_type not in allowed:
        raise SpeechError(code, "Speech audio format is unsupported.", status)
    if mime_type == "audio/wav":
        return _wav_duration(audio, output=output)
    # Container signature checks are a first gate. The configured transcription
    # provider must decode, reject corrupt content and enforce the duration cap.
    signatures = {"audio/webm": audio.startswith(b"\x1aE\xdf\xa3"),
                  "audio/ogg": audio.startswith(b"OggS"),
                  "audio/mp4": len(audio) >= 12 and audio[4:8] == b"ftyp"}
    if not signatures.get(mime_type, False):
        raise SpeechError(code, "Speech audio does not match its declared format.", status)
    return None


def _consume_result(task):
    """Discard late provider output/errors without logging private payloads."""
    if not task.cancelled():
        task.exception()


class SpeechService:
    """No retries or external services by default; injection is server-owned.

    Concurrency is process-local. A provider ignoring cancellation retains its
    slot until it exits; HTTP work still times out and no late result is returned.
    Deployments with multiple workers must set a provider-wide resource budget.
    """

    def __init__(self, *, synthesis: SynthesisProvider | None = None,
                 transcription: TranscriptionProvider | None = None,
                 timeout_seconds: float = 30.0, concurrency: int = 2):
        if (type(timeout_seconds) not in (float, int) or not math.isfinite(timeout_seconds)
                or not 0 < timeout_seconds <= 120 or type(concurrency) is not int
                or not 1 <= concurrency <= 8):
            raise ValueError("Invalid speech resource limits")
        self.synthesis, self.transcription = synthesis, transcription
        self.timeout_seconds = float(timeout_seconds)
        self._slots = asyncio.Semaphore(concurrency)

    @staticmethod
    def _status(provider):
        if provider is None:
            return ProviderStatus(False)
        try:
            status = provider.status()
            if (not isinstance(status, ProviderStatus) or type(status.available) is not bool
                    or not status.available or not isinstance(status.provider, str)
                    or not 1 <= len(status.provider) <= 80
                    or type(status.voices) is not tuple
                    or len(status.voices) > 64
                    or any(not isinstance(voice, str) or not 1 <= len(voice) <= 80
                           for voice in status.voices)):
                return ProviderStatus(False)
            return status
        except Exception:
            return ProviderStatus(False)

    def _accepted_inputs(self):
        if self.transcription is None:
            return ()
        values = getattr(self.transcription, 'accepted_mime_types', SUPPORTED_INPUTS)
        if type(values) is not tuple or not values or any(value not in SUPPORTED_INPUTS for value in values):
            return ()
        return values

    def capabilities(self):
        result = {}
        for name, provider in (("synthesis", self.synthesis), ("transcription", self.transcription)):
            status = self._status(provider)
            result[name] = {"available": status.available,
                            "provider": status.provider if status.available else None,
                            "reason": None if status.available else "provider_unavailable"}
        result['transcription']['accepted_mime_types'] = list(self._accepted_inputs()) if result['transcription']['available'] else []
        result["limits"] = {"audio_bytes": MAX_AUDIO_BYTES, "audio_seconds": MAX_AUDIO_SECONDS,
                            "text_characters": MAX_TEXT_CHARS, "timeout_seconds": self.timeout_seconds}
        return result

    @staticmethod
    async def _ensure_current(context, guard):
        current = guard(context)
        if inspect.isawaitable(current):
            current = await current
        if current is not True:
            raise SpeechError("stale_context", "The active question or authorization has changed.", 409)

    async def _run(self, context, guard, operation, cancellation):
        if cancellation is not None and cancellation.is_set():
            raise SpeechError("cancelled", "Speech operation was cancelled.", 409)
        await self._ensure_current(context, guard)

        async def invoke():
            async with self._slots:
                # Recheck after waiting for a resource slot.
                await self._ensure_current(context, guard)
                return await operation()

        task = asyncio.create_task(invoke())
        task.add_done_callback(_consume_result)
        cancel_task = asyncio.create_task(cancellation.wait()) if cancellation is not None else None
        waiting = {task, cancel_task} if cancel_task is not None else {task}
        try:
            done, _ = await asyncio.wait(waiting, timeout=self.timeout_seconds,
                                         return_when=asyncio.FIRST_COMPLETED)
            if cancel_task is not None and cancel_task in done:
                raise SpeechError("cancelled", "Speech operation was cancelled.", 409)
            if task not in done:
                raise SpeechError("provider_timeout", "Speech provider timed out.", 504)
            try:
                result = task.result()
            except SpeechError:
                raise
            except asyncio.CancelledError as error:
                raise SpeechError("provider_unavailable", "Speech provider was interrupted.") from error
            except Exception as error:
                raise SpeechError("provider_unavailable", "Speech provider failed.") from error
            await self._ensure_current(context, guard)
            return result
        finally:
            if not task.done():
                task.cancel()
            if cancel_task is not None and not cancel_task.done():
                cancel_task.cancel()

    async def synthesize(self, request: SpeechOutputRequest, *, is_current: CurrentGuard,
                         cancellation: asyncio.Event | None = None) -> SpeechAudio:
        if (not isinstance(request.text, str) or not request.text.strip()
                or len(request.text) > MAX_TEXT_CHARS
                or type(request.speed) not in (float, int) or not math.isfinite(request.speed)
                or not 0.5 <= request.speed <= 2):
            raise SpeechError("invalid_input", "Speech text or configuration is invalid.", 422)
        status = self._status(self.synthesis)
        if not status.available:
            raise SpeechError("provider_unavailable", "Speech synthesis is unavailable.")
        if request.voice not in status.voices:
            raise SpeechError("invalid_input", "The selected voice is unavailable.", 422)
        result = await self._run(request.context, is_current,
                                 lambda: self.synthesis.synthesize(request), cancellation)
        if not isinstance(result, ProviderAudio):
            raise SpeechError("invalid_output", "Speech provider returned invalid audio.", 502)
        duration = _validate_audio(result.audio, result.mime_type, output=True)
        return SpeechAudio(request.context, result.audio, result.mime_type, duration)

    async def transcribe(self, request: TranscriptionRequest, *, is_current: CurrentGuard,
                         cancellation: asyncio.Event | None = None) -> TranscriptDraft:
        _validate_audio(request.audio, request.mime_type)
        if self.transcription is not None and request.mime_type not in self._accepted_inputs():
            raise SpeechError("invalid_input", "The configured transcription provider does not accept this audio format.", 422)
        if not self._status(self.transcription).available:
            raise SpeechError("provider_unavailable", "Speech transcription is unavailable.")
        result = await self._run(request.context, is_current,
                                 lambda: self.transcription.transcribe(request), cancellation)
        if not isinstance(result, str) or len(result) > MAX_TEXT_CHARS:
            raise SpeechError("invalid_output", "Speech provider returned an invalid transcript.", 502)
        if not result.strip():
            raise SpeechError("empty_transcript", "No speech was recognized. Review or type your answer.", 422)
        return TranscriptDraft(request.context, result.strip())


# Explicitly unavailable until a verified local adapter is configured by server
# code. Importing this module never imports the standalone microphone prototype.
speech_service = SpeechService()
