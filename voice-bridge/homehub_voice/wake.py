"""openWakeWord wrapper — fully local keyword spotting for "Hey Cleo"."""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

log = logging.getLogger("homehub_voice.wake")


class WakeWord:
    """Detects the wake phrase in 80 ms int16 frames. Custom model if given, else a pretrained name."""

    def __init__(self, cfg):  # noqa: ANN001
        # Import lazily so the rest of the bridge can be imported/tested without the heavy dep.
        import openwakeword
        from openwakeword.model import Model

        # First run needs the shared melspectrogram + embedding models; safe to call repeatedly.
        try:
            openwakeword.utils.download_models()
        except Exception:  # already present / offline with models in place
            log.debug("openwakeword.download_models() skipped", exc_info=True)

        if cfg.wake_model_path:
            self.key = Path(cfg.wake_model_path).stem
            models = [cfg.wake_model_path]
        else:
            self.key = cfg.wake_model
            models = [cfg.wake_model]
            log.warning(
                "No WAKE_MODEL_PATH set — using pretrained '%s' as a stand-in for '%s'. "
                "Train a custom Hey-Cleo model for the real phrase (see README).",
                cfg.wake_model,
                cfg.wake_phrase,
            )

        self._model = Model(wakeword_models=models, inference_framework=cfg.wake_framework)
        self._threshold = cfg.wake_threshold

    def detect(self, frame: np.ndarray) -> bool:
        scores = self._model.predict(frame)
        score = scores.get(self.key)
        if score is None:  # key mismatch (e.g. pretrained bundle) — take the best score present
            score = max(scores.values(), default=0.0)
        return score >= self._threshold

    def reset(self) -> None:
        """Clear internal audio buffers so the next turn starts clean (avoids immediate re-triggers)."""
        self._model.reset()
