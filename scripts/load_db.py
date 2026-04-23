"""Load the cleaned CSVs into a SQLite database at backend/db/safety.db."""

import sqlite3
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
PROCESSED_DIR = ROOT / "data" / "processed"
DB_PATH = ROOT / "backend" / "db" / "safety.db"

RESTAURANTS_CSV = PROCESSED_DIR / "restaurants.csv"
INSPECTIONS_CSV = PROCESSED_DIR / "inspections.csv"
VIOLATIONS_CSV = PROCESSED_DIR / "violations.csv"

SCHEMA = {
    "restaurants": """
        CREATE TABLE restaurants (
            business_id TEXT PRIMARY KEY,
            business_name TEXT,
            business_address TEXT,
            business_city TEXT,
            business_state TEXT,
            business_postal_code TEXT,
            business_phone_number TEXT,
            business_latitude REAL,
            business_longitude REAL
        )
    """,
    "inspections": """
        CREATE TABLE inspections (
            inspection_id TEXT PRIMARY KEY,
            business_id TEXT REFERENCES restaurants(business_id),
            inspection_date TEXT,
            inspection_score INTEGER,
            inspection_type TEXT
        )
    """,
    "violations": """
        CREATE TABLE violations (
            violation_id TEXT PRIMARY KEY,
            inspection_id TEXT REFERENCES inspections(inspection_id),
            business_id TEXT REFERENCES restaurants(business_id),
            violation_description TEXT,
            risk_category TEXT
        )
    """,
}


def load_restaurants() -> pd.DataFrame:
    df = pd.read_csv(
        RESTAURANTS_CSV,
        dtype={
            "business_id": str,
            "business_name": str,
            "business_address": str,
            "business_city": str,
            "business_state": str,
            "business_postal_code": str,
            "business_phone_number": str,
        },
    )
    df["business_latitude"] = pd.to_numeric(df["business_latitude"], errors="coerce")
    df["business_longitude"] = pd.to_numeric(df["business_longitude"], errors="coerce")
    return df


def load_inspections() -> pd.DataFrame:
    df = pd.read_csv(
        INSPECTIONS_CSV,
        dtype={
            "inspection_id": str,
            "business_id": str,
            "inspection_date": str,
            "inspection_type": str,
        },
    )
    df["inspection_score"] = pd.to_numeric(df["inspection_score"], errors="coerce").astype("Int64")
    return df


def load_violations() -> pd.DataFrame:
    return pd.read_csv(
        VIOLATIONS_CSV,
        dtype={
            "violation_id": str,
            "inspection_id": str,
            "business_id": str,
            "violation_description": str,
            "risk_category": str,
        },
    )


def main() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    print(f"Opening database at {DB_PATH}", flush=True)

    print("Reading CSVs...", flush=True)
    restaurants = load_restaurants()
    inspections = load_inspections()
    violations = load_violations()
    print(
        f"  -> restaurants={len(restaurants):,}  "
        f"inspections={len(inspections):,}  "
        f"violations={len(violations):,}",
        flush=True,
    )

    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("PRAGMA foreign_keys = ON")
        cur = conn.cursor()

        for table in ("violations", "inspections", "restaurants"):
            print(f"Dropping table if exists: {table}", flush=True)
            cur.execute(f"DROP TABLE IF EXISTS {table}")

        for table, ddl in SCHEMA.items():
            print(f"Creating table: {table}", flush=True)
            cur.execute(ddl)

        print("Inserting rows...", flush=True)
        restaurants.to_sql("restaurants", conn, if_exists="append", index=False)
        inspections.to_sql("inspections", conn, if_exists="append", index=False)
        violations.to_sql("violations", conn, if_exists="append", index=False)

        conn.commit()

        counts = {
            t: cur.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
            for t in ("restaurants", "inspections", "violations")
        }

    print()
    print("Loaded row counts:")
    for t, n in counts.items():
        print(f"  {t}: {n:,}")
    print(f"Database written to {DB_PATH}")


if __name__ == "__main__":
    main()
