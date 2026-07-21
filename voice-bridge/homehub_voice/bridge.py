"""The bridge loop: wake → capture → transcribe → assistant → speak, then back to listening.

The mic is owned here for the whole voice turn, and while Piper is speaking the wake detector is not
running (the loop is sequential), so the reply can't self-trigger "Hey Cleo". After speaking we flush
buffered audio and reset the detector before listening again.
"""

from __future__ import annotations

import logging
from collections import deque

import requests
import webrtcvad

from .api import HomeHubClient
from .audio import WAKE_FRAME, MicStream, capture_utterance, pcm_to_wav
from .config import Config
from .tts import PiperTTS
from .wake import WakeWord

log = logging.getLogger("homehub_voice.bridge")


def run(cfg: Config) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    mic = MicStream(device=cfg.mic_device)
    wake = WakeWord(cfg)
    vad = webrtcvad.Vad(cfg.vad_aggressiveness)
    tts = PiperTTS(cfg)
    api = HomeHubClient(cfg)
    history: deque[dict] = deque(maxlen=cfg.history_turns * 2)

    mic.start()
    log.info("Listening for wake word '%s' (API %s)…", cfg.wake_phrase, cfg.api_base_url)
    try:
        while True:
            if not wake.detect(mic.read(WAKE_FRAME)):
                continue

            log.info("Wake word detected — capturing…")
            audio = capture_utterance(mic, vad, cfg)
            if audio is None:
                log.info("No speech after wake; back to listening.")
                _resume(mic, wake)
                continue

            text = _transcribe(api, audio)
            if not text:
                _resume(mic, wake)
                continue
            log.info("Heard: %s", text)
            history.append({"role": "user", "text": text})

            answer, origin = _ask(api, text, list(history))
            if answer:
                history.append({"role": "assistant", "text": answer})
                log.info("Reply [%s]: %s", origin or "?", answer)
                tts.speak(answer)

            _resume(mic, wake)
    except KeyboardInterrupt:
        log.info("Shutting down.")
    finally:
        mic.stop()


def _transcribe(api: HomeHubClient, audio) -> str:  # noqa: ANN001
    try:
        result = api.transcribe(pcm_to_wav(audio))
        return (result.get("text") or "").strip()
    except requests.RequestException as e:
        log.error("Transcription failed: %s", e)
        return ""


def _ask(api: HomeHubClient, prompt: str, history: list[dict]) -> tuple[str, str]:
    try:
        result = api.chat(prompt, history)
        return (result.get("text") or "").strip(), result.get("origin") or ""
    except requests.RequestException as e:
        log.error("Assistant call failed: %s", e)
        return "", ""


def _resume(mic: MicStream, wake: WakeWord) -> None:
    """Drop any audio captured during our own handling/TTS and reset the detector before listening."""
    mic.flush()
    wake.reset()
