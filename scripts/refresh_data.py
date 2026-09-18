"""Rebuild local inspection data when DataSF publishes a newer snapshot.

Checks dataset metadata first so routine runs are cheap when nothing changed.
Also rebuilds the SQLite DB when the schema is stale (for example after a
code upgrade that adds columns such as ``inspector``) even if DataSF has not
published a new revision.
"""

from __future__ import annotations

import argparse
import csv
import json
import sqlite3
import subprocess
import sys
from pathlib import Path

from fetch_data import fetch_source_revision

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = Path(__file__).resolve().parent
STAMP_PATH = ROOT / "data" / "processed" / "source_revision.json"
INSPECTIONS_CSV = ROOT / "data" / "processed" / "inspections.csv"
DB_PATH = ROOT / "backend" / "db" / "safety.db"

# Columns the running app expects on inspections after this codebase version.
REQUIRED_INSPECTION_COLS = ("facility_rating_status", "inspector")


def _load_stamp() -> dict | None:
    if not STAMP_PATH.is_file():
        return None
    try:
        payload = json.loads(STAMP_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _save_stamp(revision: dict) -> None:
    STAMP_PATH.parent.mkdir(parents=True, exist_ok=True)
    STAMP_PATH.write_text(
        json.dumps(revision, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _run(script: str, extra: list[str] | None = None) -> None:
    cmd = [sys.executable, str(SCRIPTS / script), *(extra or [])]
    print(f"$ {' '.join(cmd)}", flush=True)
    subprocess.run(cmd, check=True, cwd=ROOT)


def _csv_has_required_columns() -> bool:
    if not INSPECTIONS_CSV.is_file():
        return False
    try:
        with INSPECTIONS_CSV.open(newline="", encoding="utf-8") as handle:
            reader = csv.reader(handle)
            header = next(reader, [])
    except OSError:
        return False
    cols = {name.strip() for name in header}
    return all(col in cols for col in REQUIRED_INSPECTION_COLS)


def _db_schema_is_current() -> bool:
    if not DB_PATH.is_file():
        return False
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cols = {
                row[1]
                for row in conn.execute("PRAGMA table_info(inspections)")
            }
    except sqlite3.Error:
        return False
    return all(col in cols for col in REQUIRED_INSPECTION_COLS)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--force",
        action="store_true",
        help="Fetch and rebuild even if DataSF metadata is unchanged.",
    )
    parser.add_argument(
        "--skip-geocode",
        action="store_true",
        help="Pass through to clean_data.py (skip Nominatim).",
    )
    parser.add_argument(
        "--max-geocodes",
        type=int,
        default=None,
        help="Cap new Nominatim lookups during this refresh.",
    )
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    revision = fetch_source_revision()
    previous = _load_stamp()
    source_changed = previous is None or previous.get("rows_updated_at") != revision.get(
        "rows_updated_at"
    )
    schema_current = _db_schema_is_current()
    csv_current = _csv_has_required_columns()

    print(
        f"DataSF {revision.get('id')}: rows_updated_at={revision.get('rows_updated_at')} "
        f"({revision.get('name')})",
        flush=True,
    )

    if not args.force and not source_changed:
        if schema_current:
            print("No new rows published. Skipping fetch.", flush=True)
            return

        print(
            "DataSF revision unchanged, but local schema/CSV is stale.",
            flush=True,
        )
        if csv_current:
            print("Reloading SQLite from existing processed CSVs.", flush=True)
            _run("load_db.py")
            return

        print(
            "Processed CSVs are missing required columns; forcing a full rebuild.",
            flush=True,
        )
        # Fall through to fetch → clean → load.

    if not args.force and previous is None and DB_PATH.is_file() and schema_current:
        _save_stamp(revision)
        print(
            f"Recorded current DataSF revision at {STAMP_PATH}. "
            "Later runs will rebuild only when that revision changes. "
            "Pass --force to rebuild now.",
            flush=True,
        )
        return

    clean_flags: list[str] = []
    if args.skip_geocode:
        clean_flags.append("--skip-geocode")
    if args.max_geocodes is not None:
        clean_flags.extend(["--max-geocodes", str(args.max_geocodes)])

    _run("fetch_data.py")
    _run("clean_data.py", clean_flags)
    _run("load_db.py")
    _save_stamp(revision)
    print(f"Wrote source stamp to {STAMP_PATH}", flush=True)


if __name__ == "__main__":
    main()
