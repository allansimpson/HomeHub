"""The bridge loop: wake → capture → transcribe → assistant → speak, then back to listening.

The mic is owned here for the whole voice turn, and while the reply is being spoken the wake detector
is not running (the loop is sequential), so the reply can't self-trigger a wake phrase. After speaking
we flush buffered audio and reset the detector before listening again.

Speech goes through the HomeHub API's voice endpoint so the bridge shares the panel's voice, prosody
and phrase cache; a local Piper covers when the server is unreachable (see tts.SpeechOutput).
"""

from __future__ import annotations

import logging
from collections import deque

import requests
import webrtcvad

from .api import HomeHubClient
from .audio import WAKE_FRAME, MicStream, capture_utterance, pcm_to_wav
from .config import Config
from .tts import SpeechOutput
from .wake import WakeWord

log = logging.getLogger("homehub_voice.bridge")


def run(cfg: Config) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    mic = MicStream(device=cfg.mic_device)
    wake = WakeWord(cfg)
    vad = webrtcvad.Vad(cfg.vad_aggressiveness)
    api = HomeHubClient(cfg)
    tts = SpeechOutput(cfg, api)
    history: deque[dict] = deque(maxlen=cfg.history_turns * 2)

    mic.start()
    log.info("Listening for %s (API %s)…", " or ".join(f"'{p}'" for p in cfg.wake_phrases), cfg.api_base_url)
    try:
        while True:
            heard = wake.detect(mic.read(WAKE_FRAME))
            if not heard:
                continue

            # Names the model that fired, so with several phrases loaded the log says which one —
            # otherwise a mis-tuned model that triggers on everything is invisible.
            log.info("Wake word detected (%s) — capturing…", heard)
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
                # Assistant chat is conversational, so it speaks Warm (Piper ignores it; Chatterbox won't).
                tts.speak(answer, prosody="warm")

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
