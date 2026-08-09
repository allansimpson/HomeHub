"""Speech output for the bridge.

Server-first: the HomeHub API owns the voice (`POST /api/voice/speak`), so wake-word replies get
the same engine, prosody and pre-rendered phrase cache as the panel — and the eventual Chatterbox
migration is a server config flip this bridge inherits for free. Before Stage 8R the bridge ran its
own Piper, which meant the most-used voice path would have silently missed that migration.

Local Piper stays as the fallback, because a bridge that can't reach the server also can't tell you
that it can't reach the server.
"""

from __future__ import annotations

import logging
import subprocess

log = logging.getLogger("homehub_voice.tts")


def _play_wav(wav_bytes: bytes, device: str | None) -> None:
    """Play a WAV byte string through ALSA. aplay reads the header, so no format flags are needed."""
    cmd = ["aplay", "-q"]
    if device:
        cmd += ["-D", device]
    cmd += ["-"]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
    proc.communicate(wav_bytes)


class PiperTTS:
    """Speaks text with a local Piper: `piper --output-raw | aplay`. Blocks until playback finishes."""

    def __init__(self, cfg):  # noqa: ANN001
        self._bin = cfg.piper_bin
        self._model = cfg.piper_model
        self._rate = cfg.tts_sample_rate
        self._device = cfg.aplay_device

    def speak(self, text: str) -> None:
        text = text.strip()
        if not text:
            return

        piper_cmd = [self._bin, "--model", self._model, "--output-raw"]
        aplay_cmd = ["aplay", "-q", "-r", str(self._rate), "-f", "S16_LE", "-t", "raw", "-c", "1"]
        if self._device:
            aplay_cmd += ["-D", self._device]

        try:
            piper = subprocess.Popen(piper_cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            aplay = subprocess.Popen(aplay_cmd, stdin=piper.stdout, stderr=subprocess.DEVNULL)
            piper.stdout.close()  # let aplay own the read end
            piper.stdin.write(text.encode("utf-8"))
            piper.stdin.close()
            aplay.wait()
            piper.wait()
        except FileNotFoundError as e:
            log.error("Local TTS unavailable (%s). Is piper/aplay installed and on PATH?", e)


class SpeechOutput:
    """The bridge's voice: server first, local Piper when the server can't be reached."""

    def __init__(self, cfg, api):  # noqa: ANN001
        self._api = api
        self._local = PiperTTS(cfg)
        self._device = cfg.aplay_device
        self._prefer_server = cfg.tts_prefer_server

    def speak(self, text: str, prosody: str = "warm") -> None:
        text = text.strip()
        if not text:
            return

        if self._prefer_server:
            try:
                wav = self._api.speak(text, prosody)
                if wav:
                    _play_wav(wav, self._device)
                    return
                # None means the server has no TTS configured (501) — that is the local voice's job.
                log.info("Server TTS not configured; speaking with the local voice.")
            except FileNotFoundError as e:
                log.error("aplay missing (%s); cannot play server audio.", e)
                return
            except Exception as e:  # noqa: BLE001 - any server/network failure falls back to local
                log.warning("Server TTS failed (%s); speaking with the local voice.", e)

        self._local.speak(text)
