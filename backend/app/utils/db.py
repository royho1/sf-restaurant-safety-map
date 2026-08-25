"""SQLite connection helpers shared by the route blueprints."""

import sqlite3
from pathlib import Path

from flask import current_app, g

INDEX_STATEMENTS = (
    "CREATE INDEX IF NOT EXISTS idx_inspections_business_date "
    "ON inspections (business_id, inspection_date DESC)",
    "CREATE INDEX IF NOT EXISTS idx_restaurants_postal "
    "ON restaurants (business_postal_code)",
    "CREATE INDEX IF NOT EXISTS idx_violations_inspection "
    "ON violations (inspection_id)",
    "CREATE INDEX IF NOT EXISTS idx_violations_business "
    "ON violations (business_id)",
)


def _db_path() -> Path:
    return Path(current_app.config["DATABASE_PATH"])


def ensure_indexes(db_path: Path | None = None) -> None:
    """Create query indexes if the DB file exists. Safe to call on every startup."""
    path = Path(db_path) if db_path is not None else _db_path()
    if not path.is_file():
        return
    with sqlite3.connect(path) as conn:
        conn.execute("PRAGMA foreign_keys = ON")
        for sql in INDEX_STATEMENTS:
            conn.execute(sql)
        conn.commit()


def get_db() -> sqlite3.Connection:
    """Return a per-request read-only SQLite connection with row access by name."""
    if "db" not in g:
        path = _db_path()
        uri = f"file:{path.resolve().as_posix()}?mode=ro"
        conn = sqlite3.connect(uri, uri=True)
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
