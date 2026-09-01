"""Rebuild local inspection data when DataSF publishes a newer snapshot.

Checks dataset metadata first so routine runs are cheap when nothing changed.
When restaurants are missing coordinates, can re-run clean + load without
re-fetching (``--geocode-only`` or automatic backlog detection).
"""

from __future__ import annotations

import argparse
import csv
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from fetch_data import fetch_source_revision

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = Path(__file__).resolve().parent
PROCESSED_DIR = ROOT / "data" / "processed"
STAMP_PATH = PROCESSED_DIR / "source_revision.json"
LAST_REFRESH_PATH = PROCESSED_DIR / "last_refresh.json"
RESTAURANTS_CSV = PROCESSED_DIR / "restaurants.csv"
RAW_PATH = ROOT / "data" / "raw" / "inspections_raw.json"
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


def _has_valid_coordinate(value: str | None) -> bool:
    text = (value or "").strip()
    if not text or text.lower() in {"nan", "none", "null", "<na>"}:
        return False
    try:
        float(text)
    except ValueError:
        return False
    return True


def _count_missing_coordinates() -> int:
    if not RESTAURANTS_CSV.is_file():
        return 0
    missing = 0
    with RESTAURANTS_CSV.open(encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            if not _has_valid_coordinate(
                row.get("business_latitude")
            ) or not _has_valid_coordinate(row.get("business_longitude")):
                missing += 1
    return missing


def _write_last_refresh(
    *,
    status: str,
    message: str,
    source_changed: bool | None = None,
    geocode_pass: bool = False,
) -> None:
    payload = {
        "status": status,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "message": message,
        "source_changed": source_changed,
        "geocode_pass": geocode_pass,
        "restaurants_missing_coordinates": _count_missing_coordinates(),
    }
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    LAST_REFRESH_PATH.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _clean_flags(args: argparse.Namespace) -> list[str]:
    flags: list[str] = []
    if args.skip_geocode:
        flags.append("--skip-geocode")
    if args.max_geocodes is not None:
        flags.extend(["--max-geocodes", str(args.max_geocodes)])
    return flags


def _run_geocode_pass(args: argparse.Namespace) -> None:
    if not RAW_PATH.is_file():
        print(
            f"Raw data not found at {RAW_PATH}; fetching from DataSF first.",
            flush=True,
        )
        _run("fetch_data.py")
    _run("clean_data.py", _clean_flags(args))
    _run("load_db.py")


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--force",
        action="store_true",
        help="Fetch and rebuild even if DataSF metadata is unchanged.",
    )
    parser.add_argument(
        "--geocode-only",
        action="store_true",
        help="Skip fetch; re-run clean + load to backfill missing coordinates.",
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

    if args.geocode_only:
        if args.skip_geocode:
            print("Nothing to do: --geocode-only with --skip-geocode.", flush=True)
            _write_last_refresh(
                status="skipped",
                message="geocode-only requested with skip-geocode",
                geocode_pass=False,
            )
            return
        try:
            _run_geocode_pass(args)
            _write_last_refresh(
                status="success",
                message="geocode-only pass completed",
                source_changed=False,
                geocode_pass=True,
            )
        except Exception as exc:
            _write_last_refresh(
                status="failed",
                message=str(exc),
                source_changed=False,
                geocode_pass=True,
            )
            raise
        return

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
        missing_coords = _count_missing_coordinates()
        print("No new rows published. Skipping fetch.", flush=True)
        if not DB_PATH.is_file():
            print("Database missing; loading from existing CSVs.", flush=True)
            _run("load_db.py")
            _write_last_refresh(
                status="success",
                message="loaded database from existing CSVs",
                source_changed=False,
            )
            return
        if missing_coords > 0 and not args.skip_geocode:
            print(
                f"{missing_coords:,} restaurant(s) missing coordinates; "
                "running geocode pass.",
                flush=True,
            )
            try:
                _run_geocode_pass(args)
                _write_last_refresh(
                    status="success",
                    message=f"geocode backlog pass ({missing_coords} missing before run)",
                    source_changed=False,
                    geocode_pass=True,
                )
            except Exception as exc:
                _write_last_refresh(
                    status="failed",
                    message=str(exc),
                    source_changed=False,
                    geocode_pass=True,
                )
                raise
            return
        _write_last_refresh(
            status="skipped",
            message="source unchanged; no geocode backlog",
            source_changed=False,
        )
        return

    try:
        clean_flags = _clean_flags(args)
        _run("fetch_data.py")
        _run("clean_data.py", clean_flags)
        _run("load_db.py")
        _save_stamp(revision)
        print(f"Wrote source stamp to {STAMP_PATH}", flush=True)
        _write_last_refresh(
            status="success",
            message="full refresh completed",
            source_changed=True,
            geocode_pass=not args.skip_geocode,
        )
    except Exception as exc:
        _write_last_refresh(
            status="failed",
            message=str(exc),
            source_changed=source_changed,
        )
        raise


if __name__ == "__main__":
    main()
