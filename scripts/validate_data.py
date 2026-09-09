"""Smoke checks for processed inspection CSVs before commit or deploy."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROCESSED_DIR = ROOT / "data" / "processed"
RESTAURANTS_CSV = PROCESSED_DIR / "restaurants.csv"
INSPECTIONS_CSV = PROCESSED_DIR / "inspections.csv"
VIOLATIONS_CSV = PROCESSED_DIR / "violations.csv"

RESTAURANT_COLS = {
    "business_id",
    "business_name",
    "business_address",
    "business_latitude",
    "business_longitude",
    "analysis_neighborhood",
}
INSPECTION_COLS = {
    "inspection_id",
    "business_id",
    "inspection_date",
    "facility_rating_status",
}
VIOLATION_COLS = {
    "violation_id",
    "inspection_id",
    "business_id",
    "violation_description",
}


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def _check_columns(rows: list[dict[str, str]], required: set[str], label: str) -> list[str]:
    if not rows:
        return [f"{label}: file is empty"]
    missing = required - set(rows[0].keys())
    if missing:
        return [f"{label}: missing columns {sorted(missing)}"]
    return []


def _has_valid_coordinate(value: str | None) -> bool:
    text = (value or "").strip()
    if not text or text.lower() in {"nan", "none", "null", "<na>"}:
        return False
    try:
        float(text)
    except ValueError:
        return False
    return True


def _has_coordinates(row: dict[str, str]) -> bool:
    return _has_valid_coordinate(
        row.get("business_latitude")
    ) and _has_valid_coordinate(row.get("business_longitude"))


def validate(
    *,
    min_restaurants: int,
    max_missing_coord_ratio: float,
    max_stale_days: int,
) -> tuple[dict, list[str]]:
    errors: list[str] = []

    for path in (RESTAURANTS_CSV, INSPECTIONS_CSV, VIOLATIONS_CSV):
        if not path.is_file():
            errors.append(f"Missing required file: {path}")
    if errors:
        return {}, errors

    restaurants = _read_csv(RESTAURANTS_CSV)
    inspections = _read_csv(INSPECTIONS_CSV)
    violations = _read_csv(VIOLATIONS_CSV)

    errors.extend(_check_columns(restaurants, RESTAURANT_COLS, "restaurants.csv"))
    errors.extend(_check_columns(inspections, INSPECTION_COLS, "inspections.csv"))
    errors.extend(_check_columns(violations, VIOLATION_COLS, "violations.csv"))

    restaurant_count = len(restaurants)
    if restaurant_count < min_restaurants:
        errors.append(
            f"restaurant_count {restaurant_count} < minimum {min_restaurants}"
        )

    with_coords = sum(1 for row in restaurants if _has_coordinates(row))
    missing_coords = restaurant_count - with_coords
    missing_ratio = missing_coords / restaurant_count if restaurant_count else 1.0
    if missing_ratio > max_missing_coord_ratio:
        errors.append(
            f"missing coordinate ratio {missing_ratio:.1%} exceeds "
            f"maximum {max_missing_coord_ratio:.1%} "
            f"({missing_coords}/{restaurant_count})"
        )

    inspection_dates = [
        row["inspection_date"].strip()
        for row in inspections
        if (row.get("inspection_date") or "").strip()
    ]
    latest_inspection_date = max(inspection_dates) if inspection_dates else None
    if latest_inspection_date is None:
        errors.append("no inspection dates found")
    else:
        latest = datetime.strptime(latest_inspection_date, "%Y-%m-%d").date()
        stale_cutoff = date.today() - timedelta(days=max_stale_days)
        if latest < stale_cutoff:
            errors.append(
                f"latest_inspection_date {latest_inspection_date} is older than "
                f"{max_stale_days} days"
            )

    summary = {
        "restaurant_count": restaurant_count,
        "inspection_count": len(inspections),
        "violation_count": len(violations),
        "restaurants_with_coordinates": with_coords,
        "restaurants_missing_coordinates": missing_coords,
        "missing_coordinate_ratio": round(missing_ratio, 4),
        "latest_inspection_date": latest_inspection_date,
    }
    return summary, errors


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--min-restaurants",
        type=int,
        default=7000,
        help="Minimum restaurant row count (default: 7000).",
    )
    parser.add_argument(
        "--max-missing-coord-ratio",
        type=float,
        default=0.05,
        help="Maximum fraction of restaurants without coordinates (default: 0.05).",
    )
    parser.add_argument(
        "--max-stale-days",
        type=int,
        default=120,
        help="Fail if latest inspection is older than this many days (default: 120).",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print summary JSON to stdout.",
    )
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    summary, errors = validate(
        min_restaurants=args.min_restaurants,
        max_missing_coord_ratio=args.max_missing_coord_ratio,
        max_stale_days=args.max_stale_days,
    )

    if args.json:
        print(json.dumps({"summary": summary, "errors": errors}, indent=2))
    else:
        print("Data validation summary:")
        for key, value in summary.items():
            print(f"  {key}: {value}")
        if errors:
            print("Errors:")
            for err in errors:
                print(f"  - {err}")

    if errors:
        sys.exit(1)


if __name__ == "__main__":
    main()
