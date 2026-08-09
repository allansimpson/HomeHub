"""openWakeWord wrapper — fully local keyword spotting for "Hey Barnaby" / "Oh Barnaby"."""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

log = logging.getLogger("homehub_voice.wake")


class WakeWord:
    """
    Detects any of the configured wake phrases in 80 ms int16 frames.

    Several models are loaded at once and **any one of them opens the mic**. That is the only way to
    support more than one phrase: openWakeWord matches acoustics against a trained model, not text,
    so "Hey Barnaby" and "Oh Barnaby" are two models. Adding a phrase to `WAKE_PHRASE` without a
    matching model changes the log line and nothing else.
    """

    def __init__(self, cfg):  # noqa: ANN001
        # Import lazily so the rest of the bridge can be imported/tested without the heavy dep.
        import openwakeword
        from openwakeword.model import Model

        # First run needs the shared melspectrogram + embedding models; safe to call repeatedly.
        try:
            openwakeword.utils.download_models()
        except Exception:  # already present / offline with models in place
            log.debug("openwakeword.download_models() skipped", exc_info=True)

        if cfg.wake_model_paths:
            missing = [p for p in cfg.wake_model_paths if not Path(p).is_file()]
            if missing:
                # Loud, because the failure is otherwise silent: the bridge would start, listen, and
                # simply never wake for the phrase whose model is absent.
                log.error("Wake model file(s) not found and will not be heard: %s", ", ".join(missing))
            models = [p for p in cfg.wake_model_paths if p not in missing]
            self.keys = [Path(p).stem for p in models]
        else:
            models = [cfg.wake_model]
            self.keys = [cfg.wake_model]
            log.warning(
                "No WAKE_MODEL_PATH set — using pretrained '%s' as a stand-in for %s. "
                "Train a custom model per phrase for the real thing (see README).",
                cfg.wake_model,
                " / ".join(cfg.wake_phrases) or "the wake phrase",
            )

        if not models:
            raise RuntimeError(
                "No usable wake-word model. Set WAKE_MODEL_PATH to one or more existing .onnx files, "
                "or unset it to fall back to the pretrained WAKE_MODEL."
            )

        self._model = Model(wakeword_models=models, inference_framework=cfg.wake_framework)
        self._threshold = cfg.wake_threshold
        log.info("Wake models loaded: %s", ", ".join(self.keys))

    def detect(self, frame: np.ndarray) -> str | None:
        """The key of the model that fired, or None. Truthy exactly when a phrase was heard."""
        scores = self._model.predict(frame)

        best_key, best_score = None, 0.0
        for key in self.keys:
            score = scores.get(key)
            if score is not None and score > best_score:
                best_key, best_score = key, score

        # Key mismatch (a pretrained bundle names its outputs differently) — fall back to the best
        # score present so the stand-in model still works.
        if best_key is None and scores:
            best_key = max(scores, key=lambda k: scores[k])
            best_score = scores[best_key]

        return best_key if best_score >= self._threshold else None

    def reset(self) -> None:
        """Clear internal audio buffers so the next turn starts clean (avoids immediate re-triggers)."""
        self._model.reset()
