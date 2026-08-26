"""Fetch all SF restaurant inspection records from the DataSF SODA API."""

import json
from pathlib import Path

import requests

# LIVES-standard numeric scores. DataSF now labels this view historical
# (2016–2019); the city maintains a newer Pass/Conditional/Closure feed at
# tvy3-wexg. Keep this ID until the app is migrated to that schema.
DATASET_ID = "pyih-qa8i"
API_URL = f"https://data.sfgov.org/resource/{DATASET_ID}.json"
METADATA_URL = f"https://data.sfgov.org/api/views/{DATASET_ID}.json"
PAGE_SIZE = 1000
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "data" / "raw" / "inspections_raw.json"


def fetch_source_revision() -> dict:
    """Dataset metadata used to skip a full download when nothing changed."""
    response = requests.get(METADATA_URL, timeout=30)
    response.raise_for_status()
    payload = response.json()
    return {
        "id": DATASET_ID,
        "name": payload.get("name"),
        "rows_updated_at": payload.get("rowsUpdatedAt"),
        "view_last_modified": payload.get("viewLastModified"),
    }


def fetch_all_records() -> list[dict]:
    records: list[dict] = []
    offset = 0
    batch_num = 1

    while True:
        params = {"$limit": PAGE_SIZE, "$offset": offset}
        print(f"Fetching batch {batch_num} (offset={offset})...", flush=True)
        response = requests.get(API_URL, params=params, timeout=60)
        response.raise_for_status()
        batch = response.json()

        if not batch:
            print("No more records returned. Done.", flush=True)
            break

        records.extend(batch)
        print(f"  -> got {len(batch)} records (total so far: {len(records)})", flush=True)

        if len(batch) < PAGE_SIZE:
            print("Reached final batch.", flush=True)
            break

        offset += PAGE_SIZE
        batch_num += 1

    return records


def main() -> None:
    records = fetch_all_records()

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_PATH.open("w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=2)

    print(f"Saved {len(records)} records to {OUTPUT_PATH}", flush=True)


if __name__ == "__main__":
    main()
