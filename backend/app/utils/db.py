"""SQLite connection helpers shared by the route blueprints."""

import logging
import sqlite3
from pathlib import Path

from flask import current_app, g

logger = logging.getLogger(__name__)

INDEX_STATEMENTS = (
    "CREATE INDEX IF NOT EXISTS idx_inspections_business_date "
    "ON inspections (business_id, inspection_date DESC)",
    "CREATE INDEX IF NOT EXISTS idx_restaurants_postal "
    "ON restaurants (business_postal_code)",
    "CREATE INDEX IF NOT EXISTS idx_restaurants_neighborhood "
    "ON restaurants (analysis_neighborhood)",
    "CREATE INDEX IF NOT EXISTS idx_violations_inspection "
    "ON violations (inspection_id)",
    "CREATE INDEX IF NOT EXISTS idx_violations_business "
    "ON violations (business_id)",
)

LATEST_SCORES_DDL = """
CREATE TABLE IF NOT EXISTS latest_scores (
    business_id TEXT PRIMARY KEY,
    inspection_id TEXT,
    inspection_date TEXT,
    facility_rating_status TEXT
)
"""

LATEST_SCORES_INSERT = """
INSERT INTO latest_scores (
    business_id, inspection_id, inspection_date, facility_rating_status
)
SELECT business_id, inspection_id, inspection_date, facility_rating_status
FROM (
    SELECT
        business_id,
        inspection_id,
        inspection_date,
        facility_rating_status,
        ROW_NUMBER() OVER (
            PARTITION BY business_id
            ORDER BY inspection_date DESC, inspection_id DESC
        ) AS rn
    FROM inspections
    WHERE facility_rating_status IS NOT NULL
      AND TRIM(facility_rating_status) <> ''
)
WHERE rn = 1
"""


def rebuild_latest_scores(conn: sqlite3.Connection) -> None:
    """Materialize the latest rated inspection per restaurant.

    List/stats/map queries join this table instead of running a window
    function over all inspections on every request.
    """
    conn.execute("DROP TABLE IF EXISTS latest_scores")
    conn.execute(LATEST_SCORES_DDL)
    conn.execute(LATEST_SCORES_INSERT)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_latest_scores_rating "
        "ON latest_scores (facility_rating_status)"
    )


def table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    exists = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table,),
    ).fetchone()
    if exists is None:
        return set()
    return {row[1] for row in conn.execute(f'PRAGMA table_info("{table}")')}


def schema_is_current(conn: sqlite3.Connection) -> bool:
    restaurants = table_columns(conn, "restaurants")
    inspections = table_columns(conn, "inspections")
    return (
        "analysis_neighborhood" in restaurants
        and "facility_rating_status" in inspections
        and "inspector" in inspections
    )


def _db_path() -> Path:
    return Path(current_app.config["DATABASE_PATH"])


def ensure_indexes(db_path: Path | None = None) -> None:
    """Create query indexes if the DB file exists. Safe to call on every startup."""
    path = Path(db_path) if db_path is not None else _db_path()
    if not path.is_file():
        return
    try:
        with sqlite3.connect(path) as conn:
            conn.execute("PRAGMA foreign_keys = ON")
            restaurant_cols = table_columns(conn, "restaurants")
            inspection_cols = table_columns(conn, "inspections")
            for sql in INDEX_STATEMENTS:
                if (
                    "analysis_neighborhood" in sql
                    and "analysis_neighborhood" not in restaurant_cols
                ):
                    logger.warning(
                        "skipping neighborhood index; database schema is stale "
                        "(run python scripts/load_db.py)"
                    )
                    continue
                try:
                    conn.execute(sql)
                except sqlite3.OperationalError as exc:
                    logger.warning("skipping index (%s): %s", sql.split()[5], exc)
            if "facility_rating_status" in inspection_cols:
                rebuild_latest_scores(conn)
            conn.commit()
    except sqlite3.OperationalError as exc:
        logger.warning("ensure_indexes skipped (%s)", exc)


def get_db() -> sqlite3.Connection:
    """Return a per-request read-only SQLite connection with row access by name."""
    if "db" not in g:
        path = _db_path()
        uri = f"file:{path.resolve().as_posix()}?mode=ro"
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA cache_size = -16000")
        g.db = conn
    return g.db


def close_db(_exc: BaseException | None = None) -> None:
    db = g.pop("db", None)
    if db is not None:
        db.close()


def rebuild_database_from_csvs(db_path: Path | None = None) -> bool:
    """Atomically rebuild safety.db from processed CSVs when schema is stale.

    Returns True when a rebuild ran successfully. Uses ``scripts/load_db.py``
    so the same write-temp-then-replace path as the offline pipeline.
    """
    import csv
    import subprocess
    import sys

    from ..config import Config

    path = Path(db_path) if db_path is not None else _db_path()
    project_root = Config.PROJECT_ROOT
    script = project_root / "scripts" / "load_db.py"
    if not script.is_file():
        logger.warning("cannot rebuild database: %s missing", script)
        return False

    inspections_csv = project_root / "data" / "processed" / "inspections.csv"
    if not inspections_csv.is_file():
        logger.warning("cannot rebuild database: %s missing", inspections_csv)
        return False

    try:
        with inspections_csv.open(newline="", encoding="utf-8") as handle:
            header = next(csv.reader(handle), [])
    except OSError as exc:
        logger.warning("cannot read %s (%s)", inspections_csv, exc)
        return False
    if "inspector" not in {name.strip() for name in header}:
        logger.warning(
            "cannot rebuild database: %s is missing the inspector column; "
            "run python scripts/refresh_data.py --force",
            inspections_csv,
        )
        return False

    logger.warning(
        "database schema is stale at %s; rebuilding from processed CSVs", path
    )
    import os

    env = os.environ.copy()
    env["SAFETY_DB_PATH"] = str(path)
    result = subprocess.run(
        [sys.executable, str(script)],
        cwd=project_root,
        capture_output=True,
        text=True,
        check=False,
        env=env,
    )
    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "").strip()[-2000:]
        logger.error("database rebuild failed (%s): %s", result.returncode, tail)
        return False
    logger.info("database rebuild finished")
    return True


def ensure_current_database(db_path: Path | None = None) -> None:
    """Rebuild from CSVs on startup when the on-disk schema is behind the app."""
    path = Path(db_path) if db_path is not None else _db_path()
    if not path.is_file():
        return
    try:
        with sqlite3.connect(path) as conn:
            if schema_is_current(conn):
                return
    except sqlite3.Error as exc:
        logger.warning("could not inspect database schema (%s)", exc)
        return
    rebuild_database_from_csvs(path)


def rows_to_dicts(rows) -> list[dict]:
    return [dict(row) for row in rows]
