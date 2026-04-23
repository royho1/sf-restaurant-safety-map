"""Configuration for the Flask app."""

import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_ROOT = BACKEND_DIR.parent

DEFAULT_DB_PATH = BACKEND_DIR / "db" / "safety.db"


class Config:
    DATABASE_PATH = Path(os.environ.get("SAFETY_DB_PATH", DEFAULT_DB_PATH))
    JSON_SORT_KEYS = False
