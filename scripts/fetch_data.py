"""Fetch all SF restaurant inspection records from the DataSF SODA API."""

import json
from pathlib import Path

import requests

API_URL = "https://data.sfgov.org/resource/pyih-qa8i.json"
PAGE_SIZE = 1000
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "data" / "raw" / "inspections_raw.json"


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
