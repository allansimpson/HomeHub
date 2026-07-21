"""Thin client for the HomeHub API endpoints the bridge uses: STT + assistant chat."""

from __future__ import annotations

import requests


class HomeHubClient:
    def __init__(self, cfg):  # noqa: ANN001
        self._base = cfg.api_base_url.rstrip("/")
        self._timeout = cfg.http_timeout

    def transcribe(self, wav_bytes: bytes) -> dict:
        """POST audio to the local-first STT router. Returns {"text", "engine"}."""
        resp = requests.post(
            f"{self._base}/api/voice/transcribe",
            files={"audio": ("utterance.wav", wav_bytes, "audio/wav")},
            timeout=self._timeout,
        )
        resp.raise_for_status()
        return resp.json()

    def chat(self, prompt: str, history: list[dict]) -> dict:
        """POST a turn to the assistant router. Returns {"text", "origin", "escalated", "model"}."""
        resp = requests.post(
            f"{self._base}/api/assistant/chat",
            json={"prompt": prompt, "history": history, "force": None},
            timeout=self._timeout,
        )
        resp.raise_for_status()
        return resp.json()
