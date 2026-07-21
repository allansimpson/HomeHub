"""Microphone input and utterance capture.

A single 16 kHz mono int16 input stream feeds both stages: the wake loop pulls 80 ms windows, and
after a trigger the capture routine pulls 30 ms frames for webrtcvad endpointing. A sample accumulator
decouples the callback's block size from the fixed frame sizes each consumer needs.
"""

from __future__ import annotations

import io
import queue
import wave

import numpy as np
import sounddevice as sd
import webrtcvad

SAMPLE_RATE = 16000          # openWakeWord + webrtcvad both operate at 16 kHz
WAKE_FRAME = 1280            # 80 ms — openWakeWord's expected window
VAD_FRAME = 480             # 30 ms — a valid webrtcvad frame size at 16 kHz


class MicStream:
    """Continuous 16 kHz mono capture with a pull API that returns exact frame sizes."""

    def __init__(self, device: str | None = None):
        self._q: queue.Queue[np.ndarray] = queue.Queue()
        self._buf = np.empty(0, dtype=np.int16)
        self._stream = sd.InputStream(
            samplerate=SAMPLE_RATE, channels=1, dtype="int16", device=device, callback=self._callback
        )

    def _callback(self, indata, frames, time_info, status):  # noqa: ANN001 - sounddevice signature
        self._q.put(indata[:, 0].copy())

    def start(self) -> None:
        self._stream.start()

    def stop(self) -> None:
        self._stream.stop()
        self._stream.close()

    def read(self, n: int) -> np.ndarray:
        """Block until exactly n samples are available and return them as int16."""
        while len(self._buf) < n:
            self._buf = np.concatenate([self._buf, self._q.get()])
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def flush(self) -> None:
        """Drop buffered + queued audio — e.g. after our own TTS, so we don't process the tail."""
        self._buf = np.empty(0, dtype=np.int16)
        while not self._q.empty():
            try:
                self._q.get_nowait()
            except queue.Empty:
                break


def capture_utterance(mic: MicStream, vad: webrtcvad.Vad, cfg) -> np.ndarray | None:  # noqa: ANN001
    """Record from just after the wake word until trailing silence. Returns int16 PCM, or None.

    Returns None if the speaker never starts (start_timeout_ms) or speaks less than min_speech_ms.
    """
    frames: list[np.ndarray] = []
    triggered = False
    leading_ms = 0
    silence_ms = 0
    voiced_ms = 0
    frame_ms = 1000 * VAD_FRAME // SAMPLE_RATE  # 30

    for _ in range(cfg.max_utterance_ms // frame_ms):
        frame = mic.read(VAD_FRAME)
        is_speech = vad.is_speech(frame.tobytes(), SAMPLE_RATE)

        if not triggered:
            if is_speech:
                triggered = True
                frames.append(frame)
                voiced_ms += frame_ms
            else:
                leading_ms += frame_ms
                if leading_ms >= cfg.start_timeout_ms:
                    return None
            continue

        frames.append(frame)
        if is_speech:
            silence_ms = 0
            voiced_ms += frame_ms
        else:
            silence_ms += frame_ms
            if silence_ms >= cfg.end_silence_ms:
                break

    if voiced_ms < cfg.min_speech_ms:
        return None
    return np.concatenate(frames)


def pcm_to_wav(samples: np.ndarray, sample_rate: int = SAMPLE_RATE) -> bytes:
    """Wrap int16 PCM as a WAV container for the /transcribe multipart upload."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(samples.tobytes())
    return buf.getvalue()
