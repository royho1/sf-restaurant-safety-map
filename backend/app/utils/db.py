"""SQLite connection helpers shared by the route blueprints."""

import sqlite3
from pathlib import Path

from flask import current_app, g


def _db_path() -> Path:
    return Path(current_app.config["DATABASE_PATH"])


def get_db() -> sqlite3.Connection:
    """Return a per-request SQLite connection with row access by name."""
    if "db" not in g:
        conn = sqlite3.connect(_db_path())
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        g.db = conn
    return g.db


def close_db(_exc: BaseException | None = None) -> None:
    db = g.pop("db", None)
    if db is not None:
        db.close()


def rows_to_dicts(rows) -> list[dict]:
    return [dict(row) for row in rows]
