# HomeHub Voice Bridge (Phase 3)

A local, always-listening voice front-end for the HomeHub kiosk. Runs on the Raspberry Pi and owns the
mic + speaker; the heavy lifting (STT, the assistant) happens on the home server via the HomeHub API.

```
openWakeWord ("Hey Cleo", local)  →  capture (webrtcvad)  →  POST /api/voice/transcribe
      →  POST /api/assistant/chat  →  Piper "norman" TTS  →  back to listening
```

- The wake buffer **never leaves the Pi** — only the transcribed request reaches the server, and it
  only reaches the cloud per the API's `Voice:Stt:AllowCloudFallback` policy (Phase 2).
- While Piper is speaking, wake detection is paused (the loop is sequential), so replies don't
  self-trigger. Buffered audio is flushed and the detector reset before listening resumes.
- **Status:** functional end-to-end but **untested on hardware** — validate on a real Pi with a mic +
  speaker. The kiosk UI display of live state (WebSocket) is Phase 4; this bridge runs headless today.

## Prerequisites

- Raspberry Pi 4/5, Python 3.11+, a working USB mic + speaker (verify with `arecord -l` / `aplay -l`).
- `sudo apt install libportaudio2 alsa-utils` (PortAudio for sounddevice, `aplay` for playback).
- The HomeHub API reachable on the LAN, with **local STT configured** (`Voice:Stt:LocalEndpoint`,
  Phase 2) or cloud fallback enabled — otherwise `/transcribe` returns 501.

## Install

```bash
sudo mkdir -p /opt/homehub-voice && sudo chown $USER /opt/homehub-voice
cp -r voice-bridge/* /opt/homehub-voice/ && cd /opt/homehub-voice
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env      # then edit HOMEHUB_API_BASE_URL etc.
```

## The "norman" voice (Piper)

```bash
mkdir -p /opt/homehub-voice/voices && cd /opt/homehub-voice/voices
BASE=https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/norman/medium
curl -L -O $BASE/en_US-norman-medium.onnx
curl -L -O $BASE/en_US-norman-medium.onnx.json   # must sit beside the .onnx
```

`en_US-norman-medium` outputs 22.05 kHz — keep `TTS_SAMPLE_RATE=22050` (default). Test:

```bash
echo "Hello from Cleo." | piper --model voices/en_US-norman-medium.onnx --output-raw \
  | aplay -r 22050 -f S16_LE -t raw -c 1 -
```

## The "Hey Cleo" wake model (openWakeWord)

openWakeWord has no built-in "Hey Cleo", so train a custom one (the phrase is synthesized, no recording
needed):

1. Open openWakeWord's **automatic model training** notebook (Google Colab) from the openWakeWord repo.
2. Set the target phrase to `hey cleo`; it generates synthetic TTS samples + negatives and trains an
   ONNX model.
3. Download `hey_cleo.onnx` to `/opt/homehub-voice/models/` and set `WAKE_MODEL_PATH` to it.

Until then the bridge falls back to the pretrained `WAKE_MODEL` (default `hey_jarvis`) so you can test
the pipeline — it logs a warning that it's a stand-in. Tune `WAKE_THRESHOLD` (0.3–0.7) for your room.

## Run

```bash
cd /opt/homehub-voice && . .venv/bin/activate
python -m homehub_voice
```

Say the wake word, then your request. Logs show `Heard:` (transcript) and `Reply [Local|Cloud]:`.

## Run as a service

```bash
sudo cp deploy/voice-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now voice-bridge
journalctl -u voice-bridge -f
```

## Configuration

All settings are environment variables (see `.env.example` and `config.py`). Common ones:

| Var | Default | Purpose |
|---|---|---|
| `HOMEHUB_API_BASE_URL` | `http://localhost:5220` | HomeHub API base |
| `WAKE_MODEL_PATH` | — | Custom `hey_cleo.onnx` (falls back to `WAKE_MODEL`) |
| `WAKE_THRESHOLD` | `0.5` | Detection score cutoff |
| `MIC_DEVICE` / `APLAY_DEVICE` | default | Specific input/output devices |
| `END_SILENCE_MS` | `900` | Trailing silence that ends a capture |
| `PIPER_MODEL` | `…/en_US-norman-medium.onnx` | Piper voice |

## Not yet (Phase 4)

- WebSocket push of live state (listening → thinking → speaking) + transcript/reply to the kiosk SPA.
- Barge-in (interrupt Piper mid-sentence) and acoustic echo handling for true always-on listening.
