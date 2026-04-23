"""Clean raw SF inspections JSON into normalized restaurants/inspections/violations CSVs."""

from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW_PATH = ROOT / "data" / "raw" / "inspections_raw.json"
PROCESSED_DIR = ROOT / "data" / "processed"

RESTAURANT_COLS = [
    "business_id",
    "business_name",
    "business_address",
    "business_city",
    "business_state",
    "business_postal_code",
    "business_phone_number",
    "business_latitude",
    "business_longitude",
]

INSPECTION_COLS = [
    "inspection_id",
    "business_id",
    "inspection_date",
    "inspection_score",
    "inspection_type",
]

VIOLATION_COLS = [
    "violation_id",
    "inspection_id",
    "business_id",
    "violation_description",
    "risk_category",
]


def load_raw() -> pd.DataFrame:
    print(f"Loading {RAW_PATH}...", flush=True)
    df = pd.read_json(RAW_PATH, dtype=str)
    print(f"  -> {len(df):,} raw rows, {len(df.columns)} columns", flush=True)
    return df


def drop_junk_columns(df: pd.DataFrame) -> pd.DataFrame:
    junk = [c for c in df.columns if c.startswith(":@computed_region")]
    if "business_location" in df.columns:
        junk.append("business_location")
    if junk:
        print(f"Dropping {len(junk)} junk columns: {junk}", flush=True)
        df = df.drop(columns=junk)
    return df


def ensure_columns(df: pd.DataFrame, cols: list[str]) -> pd.DataFrame:
    """Make sure every requested column exists (fill missing with NaN)."""
    for c in cols:
        if c not in df.columns:
            df[c] = pd.NA
    return df


def build_restaurants(df: pd.DataFrame) -> pd.DataFrame:
    df = ensure_columns(df.copy(), RESTAURANT_COLS)
    rest = df[RESTAURANT_COLS].copy()

    # Prefer rows that have lat/lng so the dedup keeps geocoded entries when available.
    rest["_has_geo"] = rest["business_latitude"].notna() & rest["business_longitude"].notna()
    rest = rest.sort_values("_has_geo", ascending=False, kind="stable")
    rest = rest.drop_duplicates(subset="business_id", keep="first")
    rest = rest.drop(columns="_has_geo")
    rest = rest.sort_values("business_id").reset_index(drop=True)
    return rest


def build_inspections(df: pd.DataFrame) -> pd.DataFrame:
    df = ensure_columns(df.copy(), INSPECTION_COLS)
    insp = df[INSPECTION_COLS].copy()
    insp = insp.dropna(subset=["inspection_id"])
    insp = insp.drop_duplicates(subset="inspection_id", keep="first")
    insp = insp.sort_values(["business_id", "inspection_date"]).reset_index(drop=True)
    return insp


def build_violations(df: pd.DataFrame) -> pd.DataFrame:
    df = ensure_columns(df.copy(), VIOLATION_COLS)
    viol = df[VIOLATION_COLS].copy()
    viol = viol[viol["violation_id"].notna() & (viol["violation_id"].astype(str).str.len() > 0)]
    viol = viol.drop_duplicates(subset="violation_id", keep="first")
    viol = viol.sort_values(["business_id", "inspection_id", "violation_id"]).reset_index(drop=True)
    return viol


def main() -> None:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)

    df = load_raw()
    df = drop_junk_columns(df)

    restaurants = build_restaurants(df)
    inspections = build_inspections(df)
    violations = build_violations(df)

    restaurants_path = PROCESSED_DIR / "restaurants.csv"
    inspections_path = PROCESSED_DIR / "inspections.csv"
    violations_path = PROCESSED_DIR / "violations.csv"

    restaurants.to_csv(restaurants_path, index=False)
    inspections.to_csv(inspections_path, index=False)
    violations.to_csv(violations_path, index=False)

    print()
    print("Saved CSVs:")
    print(f"  restaurants.csv -> {len(restaurants):,} rows  ({restaurants_path})")
    print(f"  inspections.csv -> {len(inspections):,} rows  ({inspections_path})")
    print(f"  violations.csv  -> {len(violations):,} rows  ({violations_path})")


if __name__ == "__main__":
    main()
