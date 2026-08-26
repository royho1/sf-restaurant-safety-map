"""Rebuild local inspection data when DataSF publishes a newer snapshot.

Checks dataset metadata first so routine runs are cheap when nothing changed.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from fetch_data import fetch_source_revision

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = Path(__file__).resolve().parent
STAMP_PATH = ROOT / "data" / "processed" / "source_revision.json"
DB_PATH = ROOT / "backend" / "db" / "safety.db"


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

    print(
        f"DataSF {revision.get('id')}: rows_updated_at={revision.get('rows_updated_at')} "
        f"({revision.get('name')})",
        flush=True,
    )

    if not args.force and not source_changed:
        print("No new rows published. Skipping fetch.", flush=True)
        if not DB_PATH.is_file():
            print("Database missing; loading from existing CSVs.", flush=True)
            _run("load_db.py")
        return

    if not args.force and previous is None and DB_PATH.is_file():
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
