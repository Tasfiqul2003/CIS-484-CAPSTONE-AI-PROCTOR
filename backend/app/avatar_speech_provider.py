"""Explicit authenticated Linux speech adapter. No renderer or global avatar dependency."""
import os
from functools import lru_cache
from urllib.parse import urlsplit
import httpx
from .speech_adapters import ProviderStatus, ProviderAudio, SpeechError, SUPPORTED_INPUTS, MAX_AUDIO_BYTES


class AvatarSpeechProvider:
    accepted_mime_types = SUPPORTED_INPUTS

    def __init__(self, url, token):
        parsed = urlsplit(url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("Speech service needs an explicit HTTP(S) internal URL without credentials")
        if not token:
            raise ValueError("Speech service token is required")
        self.url = url.rstrip("/")
        self.headers = {"X-Avatar-Token": token}

    def _status(self, kind):
        try:
            response = httpx.get(self.url + "/service/speech/status", headers=self.headers, timeout=3, follow_redirects=False)
            response.raise_for_status()
            if response.json().get(kind) is True:
                return ProviderStatus(True, "avatar-speech", ("calm", "clear") if kind == "synthesis" else ())
        except (httpx.HTTPError, ValueError, TypeError):
            pass
        return ProviderStatus(False)

    async def _call(self, path, **kwargs):
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(5, read=100), follow_redirects=False) as client:
                async with client.stream("POST", self.url + path, headers=self.headers, **kwargs) as response:
                    response.raise_for_status()
                    data = bytearray()
                    async for chunk in response.aiter_bytes():
                        data.extend(chunk)
                        if len(data) > MAX_AUDIO_BYTES:
                            raise SpeechError("invalid_output", "Speech service returned excessive data.", 502)
                    return bytes(data), response.headers.get("content-type", "").split(";", 1)[0]
        except httpx.HTTPError:
            raise SpeechError("unavailable", "The configured internal speech service is unavailable.") from None

    async def synthesize(self, request):
        data, mime = await self._call("/service/speech/synthesize", json={"text": request.text,
            "voice": request.voice, "speed": request.speed})
        return ProviderAudio(data, mime)

    async def transcribe(self, request):
        import json
        data, _ = await self._call("/service/transcribe", content=request.audio)
        try:
            value = json.loads(data)
            if not isinstance(value.get("text"), str):
                raise ValueError()
            return value["text"]
        except (ValueError, TypeError, AttributeError):
            raise SpeechError("invalid_output", "Speech service returned an invalid transcript.", 502) from None


class AvatarSynthesis(AvatarSpeechProvider):
    def status(self):
        return self._status("synthesis")


class AvatarTranscription(AvatarSpeechProvider):
    def status(self):
        return self._status("transcription")


@lru_cache(maxsize=4)
def _configured(url, token):
    from .speech_adapters import SpeechService
    return SpeechService(synthesis=AvatarSynthesis(url, token), transcription=AvatarTranscription(url, token), timeout_seconds=110, concurrency=2)


def configured_avatar_service():
    from .speech_adapters import SpeechService
    url, token = os.environ.get("CYBROS_SPEECH_SERVICE_URL", ""), os.environ.get("CYBROS_SPEECH_SERVICE_TOKEN", "")
    if not url or not token:
        return SpeechService()
    try:
        return _configured(url, token)
    except ValueError:
        return SpeechService()
