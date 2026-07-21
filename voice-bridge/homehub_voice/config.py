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


@dataclass(frozen=True)
class Config:
    # --- HomeHub API (the .NET app; same host as the SPA) ---
    api_base_url: str            # e.g. http://home-server:5220
    http_timeout: float          # seconds for transcribe/chat calls

    # --- Wake word (openWakeWord, fully local) ---
    wake_model_path: str | None  # path to a custom "hey_cleo.onnx"; None → use wake_model name
    wake_model: str              # pretrained fallback name if no custom model (e.g. "hey_jarvis")
    wake_framework: str          # "onnx" or "tflite"
    wake_threshold: float        # score in [0,1] above which the phrase counts as detected
    wake_phrase: str             # display label only

    # --- Audio capture ---
    mic_device: str | None       # sounddevice device name/index; None = system default
    vad_aggressiveness: int      # webrtcvad 0..3 (higher = more aggressive at calling non-speech)
    start_timeout_ms: int        # give up if no speech starts this long after the wake word
    end_silence_ms: int          # trailing silence that ends the utterance
    min_speech_ms: int           # ignore blips shorter than this
    max_utterance_ms: int        # hard cap on a single capture

    # --- TTS (Piper) ---
    piper_bin: str               # "piper" or an absolute path
    piper_model: str             # path to en_US-norman-medium.onnx (.onnx.json alongside it)
    tts_sample_rate: int         # 22050 for the norman *medium* voice
    aplay_device: str | None     # ALSA output device (aplay -D), None = default

    # --- Conversation ---
    history_turns: int           # prior user+assistant turns to send for context

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
            http_timeout=float(_env("HOMEHUB_HTTP_TIMEOUT", "30")),
            wake_model_path=_env_opt("WAKE_MODEL_PATH"),
            wake_model=_env("WAKE_MODEL", "hey_jarvis"),
            wake_framework=_env("WAKE_FRAMEWORK", "onnx"),
            wake_threshold=float(_env("WAKE_THRESHOLD", "0.5")),
            wake_phrase=_env("WAKE_PHRASE", "Hey Cleo"),
            mic_device=_env_opt("MIC_DEVICE"),
            vad_aggressiveness=int(_env("VAD_AGGRESSIVENESS", "2")),
            start_timeout_ms=int(_env("START_TIMEOUT_MS", "3000")),
            end_silence_ms=int(_env("END_SILENCE_MS", "900")),
            min_speech_ms=int(_env("MIN_SPEECH_MS", "300")),
            max_utterance_ms=int(_env("MAX_UTTERANCE_MS", "15000")),
            piper_bin=_env("PIPER_BIN", "piper"),
            piper_model=_env("PIPER_MODEL", "/opt/homehub-voice/voices/en_US-norman-medium.onnx"),
            tts_sample_rate=int(_env("TTS_SAMPLE_RATE", "22050")),
            aplay_device=_env_opt("APLAY_DEVICE"),
            history_turns=int(_env("HISTORY_TURNS", "4")),
        )
