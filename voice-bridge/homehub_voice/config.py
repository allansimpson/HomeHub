"""Configuration for the voice bridge, read from environment variables (optionally a .env file)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


def _env_opt(name: str) -> str | None:
    v = os.environ.get(name)
    return v if v else None


def _env_list(name: str, default: str = "") -> tuple[str, ...]:
    """Comma-separated setting → tuple, blanks dropped. Accepts a single value unchanged."""
    raw = os.environ.get(name, default)
    return tuple(part.strip() for part in raw.split(",") if part.strip())


@dataclass(frozen=True)
class Config:
    # --- HomeHub API (the .NET app; same host as the SPA) ---
    api_base_url: str            # e.g. http://home-server:5220
    http_timeout: float          # seconds for the short calls: transcribe and speak
    # Seconds a spoken *turn* may take, which is a different question entirely.
    #
    # An agent that reaches for a tool, or thinks hard about a household question, takes as long as
    # the question needs — the server allows ten minutes. Sharing the short timeout meant the bridge
    # hung up at thirty seconds and the kitchen heard the failure line for a question that was being
    # answered perfectly well, with nothing on any screen to say otherwise.
    chat_timeout: float

    # --- Wake word (openWakeWord, fully local) ---
    # Several models can run at once and any one of them opens the mic: openWakeWord scores a frame
    # against every loaded model, so "Hey Barnaby" and "Oh Barnaby" are two models, not two strings.
    # A phrase with no model of its own is never heard, however it is spelled here.
    wake_model_paths: tuple[str, ...]  # custom .onnx paths; empty → fall back to wake_model
    wake_model: str              # pretrained fallback name if no custom model (e.g. "hey_jarvis")
    wake_framework: str          # "onnx" or "tflite"
    wake_threshold: float        # score in [0,1] above which the phrase counts as detected
    wake_phrases: tuple[str, ...]  # display labels only

    # --- Audio capture ---
    mic_device: str | None       # sounddevice device name/index; None = system default
    vad_aggressiveness: int      # webrtcvad 0..3 (higher = more aggressive at calling non-speech)
    start_timeout_ms: int        # give up if no speech starts this long after the wake word
    end_silence_ms: int          # trailing silence that ends the utterance
    min_speech_ms: int           # ignore blips shorter than this
    max_utterance_ms: int        # hard cap on a single capture

    # --- TTS ---
    tts_prefer_server: bool      # speak via POST /api/voice/speak (one app voice); False = local only
    piper_bin: str               # "piper" or an absolute path — the local fallback voice
    piper_model: str             # path to en_US-norman-medium.onnx (.onnx.json alongside it)
    tts_sample_rate: int         # 22050 for the norman *medium* voice
    aplay_device: str | None     # ALSA output device (aplay -D), None = default

    # --- Conversation ---
    history_turns: int           # prior user+assistant turns to send for context

    # --- Auth ---
    # Bearer credential for the API (AUDIT A1). Must match an entry under Auth:ServiceTokens in the
    # server's /etc/homehub/homehub.env. Empty means every call is refused — the bridge cannot talk
    # to an authenticated API without one, and failing loudly beats appearing to work.
    service_token: str
    # Exact approved HomeHub origins; empty means loopback only.
    allowed_origins: tuple[str, ...]

    @staticmethod
    def from_env() -> "Config":
        # Load a .env sitting next to the package root, if python-dotenv is installed.
        try:
            from dotenv import load_dotenv

            load_dotenv(Path(__file__).resolve().parent.parent / ".env")
        except Exception:
            pass

        return Config(
            api_base_url=_env("HOMEHUB_API_BASE_URL", "http://localhost:5220").rstrip("/"),
            # Exact origins this bridge may talk to. Empty means loopback only, which is the
            # documented arrangement: the bridge runs on the panel. See api.approve_origin.
            allowed_origins=_env_list("HOMEHUB_ALLOWED_ORIGINS"),
            service_token=_env("HOMEHUB_SERVICE_TOKEN", ""),
            http_timeout=float(_env("HOMEHUB_HTTP_TIMEOUT", "30")),
            # Matches the server's own turn ceiling (Hermes:StreamTimeoutSeconds). Two numbers that
            # mean the same thing should be the same number; if one is raised, raise both.
            chat_timeout=float(_env("HOMEHUB_CHAT_TIMEOUT", "600")),
            # WAKE_MODEL_PATH takes a comma-separated list, so an existing single-path install keeps
            # working untouched.
            wake_model_paths=_env_list("WAKE_MODEL_PATH"),
            wake_model=_env("WAKE_MODEL", "hey_jarvis"),
            wake_framework=_env("WAKE_FRAMEWORK", "onnx"),
            wake_threshold=float(_env("WAKE_THRESHOLD", "0.5")),
            wake_phrases=_env_list("WAKE_PHRASE", "Hey Barnaby, Oh Barnaby"),
            mic_device=_env_opt("MIC_DEVICE"),
            vad_aggressiveness=int(_env("VAD_AGGRESSIVENESS", "2")),
            start_timeout_ms=int(_env("START_TIMEOUT_MS", "3000")),
            end_silence_ms=int(_env("END_SILENCE_MS", "900")),
            min_speech_ms=int(_env("MIN_SPEECH_MS", "300")),
            max_utterance_ms=int(_env("MAX_UTTERANCE_MS", "15000")),
            tts_prefer_server=_env("TTS_PREFER_SERVER", "1") not in ("0", "false", "False"),
            piper_bin=_env("PIPER_BIN", "piper"),
            piper_model=_env("PIPER_MODEL", "/opt/homehub-voice/voices/en_US-norman-medium.onnx"),
            tts_sample_rate=int(_env("TTS_SAMPLE_RATE", "22050")),
            aplay_device=_env_opt("APLAY_DEVICE"),
            history_turns=int(_env("HISTORY_TURNS", "4")),
        )
