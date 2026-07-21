"""Piper text-to-speech — the local "norman" voice, played through ALSA (aplay)."""

from __future__ import annotations

import logging
import subprocess

log = logging.getLogger("homehub_voice.tts")


class PiperTTS:
    """Speaks text with Piper: `piper --output-raw | aplay`. Blocks until playback finishes."""

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
            log.error("TTS unavailable (%s). Is piper/aplay installed and on PATH?", e)
