"""Entry point: `python -m homehub_voice`."""

from .bridge import run
from .config import Config

if __name__ == "__main__":
    run(Config.from_env())
