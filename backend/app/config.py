"""Configuration for the Flask app."""

import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_ROOT = BACKEND_DIR.parent

DEFAULT_DB_PATH = BACKEND_DIR / "db" / "safety.db"


def _split_origins(raw: str) -> list[str]:
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


class Config:
    DATABASE_PATH = Path(os.environ.get("SAFETY_DB_PATH", DEFAULT_DB_PATH))
    JSON_SORT_KEYS = False
    # Comma-separated list. Empty means allow any origin (local-dev default).
    CORS_ORIGINS = _split_origins(os.environ.get("CORS_ORIGINS", ""))
