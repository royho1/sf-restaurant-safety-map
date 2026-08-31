"""Load the cleaned CSVs into a SQLite database at backend/db/safety.db."""

import os
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
            business_longitude REAL,
            analysis_neighborhood TEXT,
            permit_type TEXT
        )
    """,
    "inspections": """
        CREATE TABLE inspections (
            inspection_id TEXT PRIMARY KEY,
            business_id TEXT REFERENCES restaurants(business_id),
            inspection_date TEXT,
            inspection_type TEXT,
            facility_rating_status TEXT,
            violation_count INTEGER,
            inspection_notes TEXT,
            suspension_notes TEXT
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
    if "analysis_neighborhood" not in df.columns:
        df["analysis_neighborhood"] = pd.NA
    if "permit_type" not in df.columns:
        df["permit_type"] = pd.NA
    return df


def load_inspections() -> pd.DataFrame:
    df = pd.read_csv(
        INSPECTIONS_CSV,
        dtype={
            "inspection_id": str,
            "business_id": str,
            "inspection_date": str,
            "inspection_type": str,
            "facility_rating_status": str,
            "inspection_notes": str,
            "suspension_notes": str,
        },
    )
    if "violation_count" in df.columns:
        df["violation_count"] = pd.to_numeric(df["violation_count"], errors="coerce").astype(
            "Int64"
        )
    else:
        df["violation_count"] = pd.NA
    if "facility_rating_status" not in df.columns:
        df["facility_rating_status"] = pd.NA
    for col in ("inspection_notes", "suspension_notes"):
        if col not in df.columns:
            df[col] = pd.NA
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
    tmp_path = DB_PATH.with_name(DB_PATH.name + ".tmp")
    if tmp_path.exists():
        tmp_path.unlink()

    print(f"Opening database at {tmp_path}", flush=True)

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

    try:
        with sqlite3.connect(tmp_path) as conn:
            conn.execute("PRAGMA foreign_keys = ON")
            cur = conn.cursor()

            for table in ("violations", "inspections", "restaurants", "latest_scores"):
                print(f"Dropping table if exists: {table}", flush=True)
                cur.execute(f"DROP TABLE IF EXISTS {table}")

            for table, ddl in SCHEMA.items():
                print(f"Creating table: {table}", flush=True)
                cur.execute(ddl)

            print("Inserting rows...", flush=True)
            restaurant_cols = [
                "business_id",
                "business_name",
                "business_address",
                "business_city",
                "business_state",
                "business_postal_code",
                "business_phone_number",
                "business_latitude",
                "business_longitude",
                "analysis_neighborhood",
                "permit_type",
            ]
            inspection_cols = [
                "inspection_id",
                "business_id",
                "inspection_date",
                "inspection_type",
                "facility_rating_status",
                "violation_count",
                "inspection_notes",
                "suspension_notes",
            ]
            violation_cols = [
                "violation_id",
                "inspection_id",
                "business_id",
                "violation_description",
                "risk_category",
            ]
            restaurants.reindex(columns=restaurant_cols).to_sql(
                "restaurants", conn, if_exists="append", index=False
            )
            inspections.reindex(columns=inspection_cols).to_sql(
                "inspections", conn, if_exists="append", index=False
            )
            violations.reindex(columns=violation_cols).to_sql(
                "violations", conn, if_exists="append", index=False
            )

            print("Creating indexes...", flush=True)
            cur.execute(
                "CREATE INDEX IF NOT EXISTS idx_inspections_business_date "
                "ON inspections (business_id, inspection_date DESC)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS idx_restaurants_postal "
                "ON restaurants (business_postal_code)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS idx_restaurants_neighborhood "
                "ON restaurants (analysis_neighborhood)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS idx_violations_inspection "
                "ON violations (inspection_id)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS idx_violations_business "
                "ON violations (business_id)"
            )

            print("Materializing latest inspections...", flush=True)
            cur.execute("DROP TABLE IF EXISTS latest_scores")
            cur.execute(
                """
                CREATE TABLE latest_scores (
                    business_id TEXT PRIMARY KEY,
                    inspection_id TEXT,
                    inspection_date TEXT,
                    facility_rating_status TEXT
                )
                """
            )
            cur.execute(
                """
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
                )
                WHERE rn = 1
                """
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS idx_latest_scores_rating "
                "ON latest_scores (facility_rating_status)"
            )

            conn.commit()

            counts = {
                t: cur.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                for t in ("restaurants", "inspections", "violations")
            }

        os.replace(tmp_path, DB_PATH)
    except Exception:
        if tmp_path.exists():
            tmp_path.unlink()
        raise

    print()
    print("Loaded row counts:")
    for t, n in counts.items():
        print(f"  {t}: {n:,}")
    print(f"Database written to {DB_PATH}")


if __name__ == "__main__":
    main()
