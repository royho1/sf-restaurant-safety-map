"""Clean raw SF inspections JSON into normalized restaurants/inspections/violations CSVs.

Expects DataSF ``tvy3-wexg`` (Pass / Conditional Pass / Closure, 2024–present).
Optionally geocodes restaurants that are missing latitude/longitude using
OpenStreetMap's Nominatim (free, no API key). Geocoding results are cached to
``data/processed/geocode_cache.json`` so the step is fully resumable and never
re-queries an address it has already resolved (or confirmed as missing).
"""

import argparse
import json
import re
import sys
import time
from datetime import date
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW_PATH = ROOT / "data" / "raw" / "inspections_raw.json"
PROCESSED_DIR = ROOT / "data" / "processed"
GEOCODE_CACHE_PATH = PROCESSED_DIR / "geocode_cache.json"

# Nominatim usage policy requires a descriptive User-Agent identifying the app.
NOMINATIM_USER_AGENT = "sf-restaurant-safety-map/0.1 (data prep script)"
NOMINATIM_MIN_DELAY_SECONDS = 1.0

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
    "analysis_neighborhood",
    "permit_type",
]

INSPECTION_COLS = [
    "inspection_id",
    "business_id",
    "inspection_date",
    "inspection_type",
    "facility_rating_status",
    "violation_count",
    "inspection_notes",
    "suspension_notes",
]

VIOLATION_COLS = [
    "violation_id",
    "inspection_id",
    "business_id",
    "violation_description",
    "risk_category",
]

# Keep food-service permits; drop massage, tattoo, laundry, tobacco, etc.
FOOD_PERMIT_RE = re.compile(
    r"restaurant|take-?out|fast food|bar|tavern|baker|"
    r"cafeteria|food prep|food facility|food service|retail mkt|"
    r"supermarket|commissar|cater|pushcart|mobile food|"
    r"cottage food|stadium concession|summer meals",
    re.IGNORECASE,
)
NON_FOOD_PERMIT_RE = re.compile(
    r"massage|tattoo|laundry|tobacco|piercing",
    re.IGNORECASE,
)

# "113952, 113953.3 - Wash hands...., 114157 - Provide thermometer...."
VIOLATION_SPLIT_RE = re.compile(r"(?<=\.)\s*,\s*(?=\d{5,6}\b)")
RATING_VALUES = {"Pass", "Conditional Pass", "Closure"}


def load_raw() -> pd.DataFrame:
    print(f"Loading {RAW_PATH}...", flush=True)
    df = pd.read_json(RAW_PATH, dtype=str, convert_dates=False)
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


def _is_missing(value) -> bool:
    if value is None or value is pd.NA:
        return True
    try:
        return bool(pd.isna(value))
    except (ValueError, TypeError):
        return False


def _blank_to_na(value):
    if _is_missing(value):
        return pd.NA
    text = str(value).strip()
    if not text or text.lower() in {"nan", "none", "null", "<na>"}:
        return pd.NA
    return text


def _normalize_rating(value) -> str | None:
    text = _blank_to_na(value)
    if text is pd.NA:
        return None
    if text in RATING_VALUES:
        return text
    lowered = text.lower()
    if lowered == "pass":
        return "Pass"
    if lowered in {"conditional pass", "conditional"}:
        return "Conditional Pass"
    if lowered in {"closure", "closed"}:
        return "Closure"
    return None


def _is_food_permit(permit_type) -> bool:
    text = _blank_to_na(permit_type)
    if text is pd.NA:
        return True
    if NON_FOOD_PERMIT_RE.search(text):
        return False
    return bool(FOOD_PERMIT_RE.search(text))


def parse_violation_codes(raw) -> list[str]:
    text = _blank_to_na(raw)
    if text is pd.NA:
        return []
    chunks = VIOLATION_SPLIT_RE.split(text)
    out: list[str] = []
    for chunk in chunks:
        chunk = chunk.strip().strip(",")
        if not chunk:
            continue
        if " - " in chunk:
            _codes, desc = chunk.split(" - ", 1)
            desc = desc.strip()
        else:
            desc = chunk
        if desc:
            out.append(desc)
    if out:
        return out
    return [text] if " - " in text else []


def map_source_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Map tvy3-wexg fields onto the restaurants/inspections schema."""
    out = pd.DataFrame(index=df.index)
    out["business_id"] = df.get("permit_number", pd.Series(index=df.index)).map(_blank_to_na)
    out["business_name"] = df.get("dba", pd.Series(index=df.index)).map(_blank_to_na)
    address = df.get("street_address_clean", pd.Series(index=df.index)).map(_blank_to_na)
    fallback_address = df.get("street_address", pd.Series(index=df.index)).map(_blank_to_na)
    out["business_address"] = address.fillna(fallback_address)
    out["business_city"] = "San Francisco"
    out["business_state"] = "CA"
    out["business_postal_code"] = pd.NA
    out["business_phone_number"] = pd.NA
    out["business_latitude"] = df.get("latitude")
    out["business_longitude"] = df.get("longitude")
    out["analysis_neighborhood"] = df.get(
        "analysis_neighborhood", pd.Series(index=df.index)
    ).map(_blank_to_na)
    out["permit_type"] = df.get("permit_type", pd.Series(index=df.index)).map(_blank_to_na)
    dates = df.get("inspection_date", pd.Series(index=df.index)).map(_blank_to_na)
    out["inspection_date"] = dates.map(
        lambda v: str(v)[:10] if v is not pd.NA and v is not None else pd.NA
    )
    today = date.today().isoformat()
    future = out["inspection_date"].notna() & (out["inspection_date"] > today)
    if future.any():
        print(f"Clearing {int(future.sum())} inspection date(s) after {today}.", flush=True)
        out.loc[future, "inspection_date"] = pd.NA
    out["inspection_type"] = df.get("inspection_type", pd.Series(index=df.index)).map(
        _blank_to_na
    )
    out["facility_rating_status"] = df.get(
        "facility_rating_status", pd.Series(index=df.index)
    ).map(_normalize_rating)
    out["violation_count"] = pd.to_numeric(df.get("violation_count"), errors="coerce")
    out["inspection_notes"] = df.get("inspection_notes", pd.Series(index=df.index)).map(
        _blank_to_na
    )
    out["suspension_notes"] = df.get("suspension_notes", pd.Series(index=df.index)).map(
        _blank_to_na
    )
    out["violation_codes"] = df.get("violation_codes", pd.Series(index=df.index)).map(
        _blank_to_na
    )
    out["permit_type_raw"] = df.get("permit_type", pd.Series(index=df.index))
    return out


def filter_food_permits(df: pd.DataFrame) -> pd.DataFrame:
    mask = df["permit_type_raw"].map(_is_food_permit)
    kept = df.loc[mask].drop(columns=["permit_type_raw"])
    dropped = int((~mask).sum())
    print(
        f"Food-service permits: kept {len(kept):,} of {len(df):,} rows "
        f"(dropped {dropped:,} non-food).",
        flush=True,
    )
    return kept


def add_inspection_ids(df: pd.DataFrame) -> pd.DataFrame:
    out = df.dropna(subset=["business_id"]).copy()
    out["_seq"] = out.groupby(["business_id", "inspection_date"], dropna=False).cumcount()
    out["inspection_id"] = (
        out["business_id"].astype(str)
        + ":"
        + out["inspection_date"].fillna("undated").astype(str)
        + ":"
        + out["_seq"].astype(str)
    )
    return out.drop(columns=["_seq"])


def build_restaurants(df: pd.DataFrame) -> pd.DataFrame:
    rest = ensure_columns(df.copy(), RESTAURANT_COLS)
    rest["_has_geo"] = rest["business_latitude"].notna() & rest["business_longitude"].notna()
    rest["_date"] = rest.get("inspection_date")
    rest = rest.sort_values(
        ["_date", "_has_geo"],
        ascending=[False, False],
        kind="stable",
    )
    rest = rest.drop_duplicates(subset="business_id", keep="first")
    rest = rest[RESTAURANT_COLS]
    rest = rest.sort_values("business_id").reset_index(drop=True)
    return rest


def build_inspections(df: pd.DataFrame) -> pd.DataFrame:
    insp = ensure_columns(df.copy(), INSPECTION_COLS)
    insp = insp.dropna(subset=["inspection_id"])
    insp = insp.drop_duplicates(subset="inspection_id", keep="first")
    insp = insp.sort_values(["business_id", "inspection_date"]).reset_index(drop=True)
    return insp[INSPECTION_COLS]


def build_violations(df: pd.DataFrame) -> pd.DataFrame:
    rows: list[dict] = []
    for row in df.itertuples(index=False):
        inspection_id = getattr(row, "inspection_id", None)
        business_id = getattr(row, "business_id", None)
        codes = getattr(row, "violation_codes", None)
        if inspection_id is None or business_id is None:
            continue
        descriptions = parse_violation_codes(codes)
        for i, desc in enumerate(descriptions):
            if _is_missing(desc) or not str(desc).strip():
                continue
            rows.append(
                {
                    "violation_id": f"{inspection_id}:{i}",
                    "inspection_id": inspection_id,
                    "business_id": business_id,
                    "violation_description": desc,
                    "risk_category": pd.NA,
                }
            )
    if not rows:
        return pd.DataFrame(columns=VIOLATION_COLS)
    viol = pd.DataFrame(rows)
    viol = viol.drop_duplicates(subset="violation_id", keep="first")
    return viol.sort_values(
        ["business_id", "inspection_id", "violation_id"]
    ).reset_index(drop=True)


# ---------------------------------------------------------------------------
# Geocoding
# ---------------------------------------------------------------------------


_ORDINAL_LEADING_ZERO_RE = re.compile(
    r"\b0(\d(?:st|nd|rd|th))\b", flags=re.IGNORECASE
)


def _normalize_sf_address(addr: str) -> str:
    """Normalize quirks of the SF inspections dataset for Nominatim.

    SF's source data zero-pads ordinal street names ("06th St", "03rd Ave"),
    which Nominatim does not recognize. Strip the leading zero so e.g.
    "475 06th St" becomes "475 6th St".
    """
    return _ORDINAL_LEADING_ZERO_RE.sub(r"\1", addr)


def _build_query(address: str | None) -> str | None:
    """Compose the Nominatim query: '<address>, San Francisco, CA'."""
    if address is None:
        return None
    addr = str(address).strip()
    if not addr or addr.lower() == "nan":
        return None
    addr = _normalize_sf_address(addr)
    return f"{addr}, San Francisco, CA"


def _load_geocode_cache(path: Path) -> dict[str, dict | None]:
    if not path.exists():
        return {}
    try:
        with path.open("r", encoding="utf-8") as f:
            cache = json.load(f)
        if not isinstance(cache, dict):
            return {}
        return cache
    except (OSError, json.JSONDecodeError) as exc:
        print(f"  WARN: could not read geocode cache ({exc}); starting fresh.", flush=True)
        return {}


def _save_geocode_cache(path: Path, cache: dict[str, dict | None]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, sort_keys=True, indent=2)
    tmp.replace(path)


def apply_geocode_cache(
    restaurants: pd.DataFrame,
    cache_path: Path = GEOCODE_CACHE_PATH,
) -> pd.DataFrame:
    """Fill coordinates from ``geocode_cache.json`` without network calls."""
    restaurants = restaurants.copy()
    restaurants["business_latitude"] = pd.to_numeric(
        restaurants["business_latitude"], errors="coerce"
    )
    restaurants["business_longitude"] = pd.to_numeric(
        restaurants["business_longitude"], errors="coerce"
    )

    missing_mask = restaurants["business_latitude"].isna() | restaurants["business_longitude"].isna()
    if not missing_mask.any():
        return restaurants

    cache = _load_geocode_cache(cache_path)
    applied = 0
    for row_idx in restaurants.index[missing_mask]:
        query = _build_query(restaurants.at[row_idx, "business_address"])
        if query is None:
            continue
        cached = cache.get(query)
        if cached is None:
            continue
        restaurants.at[row_idx, "business_latitude"] = cached["lat"]
        restaurants.at[row_idx, "business_longitude"] = cached["lon"]
        applied += 1

    print(
        f"Applied {applied:,} cached coordinate(s) from {cache_path.name}.",
        flush=True,
    )
    return restaurants


def geocode_missing_coordinates(
    restaurants: pd.DataFrame,
    *,
    max_geocodes: int | None = None,
    cache_path: Path = GEOCODE_CACHE_PATH,
) -> pd.DataFrame:
    """Fill missing business_latitude/business_longitude via Nominatim.

    Uses a JSON cache keyed by the query string. Cache values are either a
    ``{"lat": float, "lon": float}`` dict for hits or ``None`` for confirmed
    misses; both forms are persisted so re-runs never re-query the network.
    """
    try:
        from geopy.exc import GeocoderRateLimited, GeocoderServiceError, GeocoderTimedOut
        from geopy.geocoders import Nominatim
    except ImportError:
        print(
            "  ERROR: geopy is not installed. Install it with `pip install geopy` "
            "or run with --skip-geocode.",
            flush=True,
        )
        sys.exit(1)

    # Raw JSON is loaded as strings, but assigned coordinates from Nominatim
    # are floats. Coerce both columns to numeric (NaN for missing) so we can
    # write floats back into the DataFrame without dtype errors.
    restaurants["business_latitude"] = pd.to_numeric(
        restaurants["business_latitude"], errors="coerce"
    )
    restaurants["business_longitude"] = pd.to_numeric(
        restaurants["business_longitude"], errors="coerce"
    )

    missing_mask = restaurants["business_latitude"].isna() | restaurants["business_longitude"].isna()
    missing_idx = restaurants.index[missing_mask].tolist()
    print(
        f"Geocoding: {len(missing_idx):,} of {len(restaurants):,} restaurants are "
        f"missing coordinates.",
        flush=True,
    )
    if not missing_idx:
        return restaurants

    cache = _load_geocode_cache(cache_path)
    print(f"  Geocode cache: {len(cache):,} entries at {cache_path}", flush=True)

    geocoder = Nominatim(user_agent=NOMINATIM_USER_AGENT, timeout=10)

    def _nominatim_geocode(query: str):
        """Geocode with >=1s between requests; on 429, exponential backoff and retry.

        (Public Nominatim can return 429 for sustained bulk use from one IP; waiting
         longer is required. Do not treat 429 as a miss — no cache until success or
         a non-rate-limit error.)
        """
        backoff = 0
        while True:
            time.sleep(NOMINATIM_MIN_DELAY_SECONDS)
            try:
                return geocoder.geocode(query, timeout=10)
            except GeocoderRateLimited as exc:
                base = float(exc.retry_after) if exc.retry_after is not None else 60.0
                base = max(base, 15.0)
                wait = min(600.0, base * (2**min(backoff, 3)))
                backoff += 1
                print(
                    f"  WARN: Nominatim rate-limited; sleeping {wait:.0f}s "
                    f"(backoff level {backoff}) for {query!r}",
                    flush=True,
                )
                time.sleep(wait)
            except (GeocoderTimedOut, GeocoderServiceError) as exc:
                print(f"  WARN: geocoder error for {query!r}: {exc}", flush=True)
                return None

    network_calls = 0
    cache_hits = 0
    successes = 0
    misses = 0
    skipped_no_address = 0
    saved_at = time.time()

    for processed, row_idx in enumerate(missing_idx, start=1):
        query = _build_query(restaurants.at[row_idx, "business_address"])
        if query is None:
            skipped_no_address += 1
            continue

        if query in cache:
            cache_hits += 1
            cached = cache[query]
            if cached is not None:
                restaurants.at[row_idx, "business_latitude"] = cached["lat"]
                restaurants.at[row_idx, "business_longitude"] = cached["lon"]
            # Cached miss: leave coordinates as NaN.
        else:
            if max_geocodes is not None and network_calls >= max_geocodes:
                print(
                    f"  Reached --max-geocodes={max_geocodes}; stopping network calls.",
                    flush=True,
                )
                break
            location = _nominatim_geocode(query)
            network_calls += 1
            if location is not None:
                cache[query] = {"lat": location.latitude, "lon": location.longitude}
                restaurants.at[row_idx, "business_latitude"] = location.latitude
                restaurants.at[row_idx, "business_longitude"] = location.longitude
                successes += 1
            else:
                cache[query] = None
                misses += 1

            # Periodically flush the cache so an interrupted run keeps progress.
            if time.time() - saved_at > 30:
                _save_geocode_cache(cache_path, cache)
                saved_at = time.time()

        if processed % 100 == 0 or processed == len(missing_idx):
            print(
                f"  [{processed:>5,}/{len(missing_idx):,}] "
                f"network={network_calls:,} hits={successes:,} miss={misses:,} "
                f"cache_hits={cache_hits:,} no_addr={skipped_no_address:,}",
                flush=True,
            )

    _save_geocode_cache(cache_path, cache)
    print(
        f"Geocoding done. network_calls={network_calls:,} successes={successes:,} "
        f"misses={misses:,} cache_hits={cache_hits:,} no_address={skipped_no_address:,}",
        flush=True,
    )
    return restaurants


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--skip-geocode",
        action="store_true",
        help="Skip the Nominatim geocoding step (default: run it).",
    )
    parser.add_argument(
        "--max-geocodes",
        type=int,
        default=None,
        help="Cap the number of NEW network geocoding calls (cache hits don't count). "
        "Useful for smoke-testing without burning the full ~1hr run.",
    )
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)

    df = load_raw()
    df = drop_junk_columns(df)
    df = map_source_columns(df)
    df = filter_food_permits(df)
    df = add_inspection_ids(df)

    restaurants = build_restaurants(df)
    inspections = build_inspections(df)
    violations = build_violations(df)

    if args.skip_geocode:
        print(
            "Skipping Nominatim network calls (--skip-geocode); applying cache.",
            flush=True,
        )
        restaurants = apply_geocode_cache(restaurants)
    else:
        restaurants = geocode_missing_coordinates(
            restaurants,
            max_geocodes=args.max_geocodes,
        )

    restaurants_path = PROCESSED_DIR / "restaurants.csv"
    inspections_path = PROCESSED_DIR / "inspections.csv"
    violations_path = PROCESSED_DIR / "violations.csv"

    restaurants.to_csv(restaurants_path, index=False)
    inspections.to_csv(inspections_path, index=False)
    violations.to_csv(violations_path, index=False)

    geo_count = (
        restaurants["business_latitude"].notna() & restaurants["business_longitude"].notna()
    ).sum()

    print()
    print("Saved CSVs:")
    print(
        f"  restaurants.csv -> {len(restaurants):,} rows  "
        f"({geo_count:,} with coordinates)  ({restaurants_path})"
    )
    print(f"  inspections.csv -> {len(inspections):,} rows  ({inspections_path})")
    print(f"  violations.csv  -> {len(violations):,} rows  ({violations_path})")


if __name__ == "__main__":
    main()
