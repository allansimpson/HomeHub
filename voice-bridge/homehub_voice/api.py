"""Thin client for the HomeHub API endpoints the bridge uses: STT + assistant chat."""

from __future__ import annotations

import requests


class HomeHubClient:
    def __init__(self, cfg):  # noqa: ANN001
        self._base = cfg.api_base_url.rstrip("/")
        self._timeout = cfg.http_timeout
        # A turn is not a short call — see Config.chat_timeout.
        self._chat_timeout = cfg.chat_timeout
        # Every HomeHub endpoint requires authentication (AUDIT A1). The bridge is a program with
        # no browser, so it presents a bearer token rather than holding a session cookie; the
        # server matches it against Auth:ServiceTokens and admits it as a *service* — able to read
        # and act on the house, and deliberately unable to reach any member's own data or the
        # household roster. Unset, every call below gets a 401, which is the correct failure for a
        # bridge nobody has issued a credential to.
        self._headers = (
            {"Authorization": f"Bearer {cfg.service_token}"} if cfg.service_token else {}
        )

    def transcribe(self, wav_bytes: bytes) -> dict:
        """POST audio to the local-first STT router. Returns {"text", "engine"}."""
        resp = requests.post(
            f"{self._base}/api/voice/transcribe",
            files={"audio": ("utterance.wav", wav_bytes, "audio/wav")},
            headers=self._headers,
            timeout=self._timeout,
        )
        resp.raise_for_status()
        return resp.json()

    def chat(self, prompt: str, history: list[dict]) -> dict:
        """POST a turn to the assistant router. Returns {"text", "origin", "escalated", "model"}.

        `spoken` is always True from the bridge: everything here arrived through the wake word and
        leaves through Piper, so the reply is heard rather than read. The server uses it to pin the
        turn to the fast on-server model instead of the agent — a spoken answer that arrives ten
        seconds late has already failed, however good it is (ai-assistant.md, A5).
        """
        resp = requests.post(
            f"{self._base}/api/assistant/chat",
            json={"prompt": prompt, "history": history, "force": None, "spoken": True},
            headers=self._headers,
            # The turn ceiling, not the short one. Hanging up on a slow answer is the one failure
            # nobody here can see coming: there is no screen in the kitchen showing that it was still
            # being written.
            timeout=self._chat_timeout,
        )
        resp.raise_for_status()
        return resp.json()

    def speak(self, text: str, prosody: str = "warm") -> bytes | None:
        """Synthesize in the app's central voice. Returns WAV bytes, or None when the server has
        no TTS configured (501) so the caller can use its local voice instead."""
        resp = requests.post(
            f"{self._base}/api/voice/speak",
            json={"text": text, "prosody": prosody, "allowCache": True},
            headers=self._headers,
            timeout=self._timeout,
        )
        if resp.status_code == 501:
            return None
        resp.raise_for_status()
        return resp.content
