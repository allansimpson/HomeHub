"""HomeHub voice bridge: local wake word + capture + STT/assistant (via the HomeHub API) + Piper TTS.

Runs on the Raspberry Pi kiosk. openWakeWord listens locally for "Hey Cleo"; on a trigger it captures
the following utterance (webrtcvad endpointing), sends it to the HomeHub API's local-first STT, routes
the transcript through the assistant, and speaks the reply with Piper (en_US-norman-medium). The wake
buffer never leaves the device; only the transcribed request can reach the cloud, and only per the
API's Voice:Stt fallback policy.
"""

__all__ = ["config", "audio", "wake", "tts", "api", "bridge"]
