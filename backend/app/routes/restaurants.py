"""Restaurant endpoints."""

from flask import Blueprint, jsonify, request

from ..utils.db import get_db, rows_to_dicts

bp = Blueprint("restaurants", __name__, url_prefix="/api/restaurants")

DEFAULT_LIMIT = 50
MAX_LIMIT = 500
# When callers explicitly filter to geocoded restaurants (the map view) we
# allow a much larger page so the whole city can be rendered in one fetch.
MAX_LIMIT_HAS_COORDINATES = 10000

# CTE picking the most recent scored inspection per restaurant. Reused by both
# the list endpoint (for filtering / display) and the detail endpoint.
LATEST_SCORE_CTE = """
WITH latest AS (
    SELECT
        business_id,
        inspection_id,
        inspection_date,
        inspection_score,
        ROW_NUMBER() OVER (
            PARTITION BY business_id
            ORDER BY inspection_date DESC, inspection_id DESC
        ) AS rn
    FROM inspections
    WHERE inspection_score IS NOT NULL
)
"""


def _parse_bool(value: str | None) -> bool | None:
    if value is None:
        return None
    return value.strip().lower() in {"1", "true", "yes", "y", "t"}


def _parse_int(value: str | None, default: int | None = None) -> int | None:
    if value is None or value == "":
        return default
    try:
        return int(value)
    except ValueError:
        return default


@bp.get("")
def list_restaurants():
    # `search` is an alias for `name` (substring match on business_name).
    search = request.args.get("search", type=str)
    name = request.args.get("name", type=str)
    name_term = (search or name or "").strip() or None
    postal_code = request.args.get("postal_code", type=str)
    min_score = _parse_int(request.args.get("min_score"))
    has_coordinates = _parse_bool(request.args.get("has_coordinates"))

    limit = _parse_int(request.args.get("limit"), DEFAULT_LIMIT) or DEFAULT_LIMIT
    offset = _parse_int(request.args.get("offset"), 0) or 0
    effective_max = MAX_LIMIT_HAS_COORDINATES if has_coordinates is True else MAX_LIMIT
    limit = max(1, min(limit, effective_max))
    offset = max(0, offset)

    where: list[str] = []
    params: list = []

    if name_term:
        where.append("r.business_name LIKE ?")
        params.append(f"%{name_term}%")
    if postal_code:
        where.append("r.business_postal_code = ?")
        params.append(postal_code)
    if has_coordinates is True:
        where.append("r.business_latitude IS NOT NULL AND r.business_longitude IS NOT NULL")
    elif has_coordinates is False:
        where.append("(r.business_latitude IS NULL OR r.business_longitude IS NULL)")
    if min_score is not None:
        where.append("latest.inspection_score >= ?")
        params.append(min_score)

    where_sql = f"WHERE {' AND '.join(where)}" if where else ""

    db = get_db()

    count_sql = f"""
        {LATEST_SCORE_CTE}
        SELECT COUNT(*) AS total
        FROM restaurants r
        LEFT JOIN latest ON latest.business_id = r.business_id AND latest.rn = 1
        {where_sql}
    """
    total = db.execute(count_sql, params).fetchone()["total"]

    list_sql = f"""
        {LATEST_SCORE_CTE}
        SELECT
            r.business_id,
            r.business_name,
            r.business_address,
            r.business_city,
            r.business_state,
            r.business_postal_code,
            r.business_phone_number,
            r.business_latitude,
            r.business_longitude,
            latest.inspection_score AS latest_inspection_score,
            latest.inspection_date  AS latest_inspection_date
        FROM restaurants r
        LEFT JOIN latest ON latest.business_id = r.business_id AND latest.rn = 1
        {where_sql}
        ORDER BY r.business_name COLLATE NOCASE
        LIMIT ? OFFSET ?
    """
    rows = db.execute(list_sql, params + [limit, offset]).fetchall()

    return jsonify(
        {
            "total": total,
            "limit": limit,
            "offset": offset,
            "count": len(rows),
            "results": rows_to_dicts(rows),
        }
    )


@bp.get("/<business_id>/inspections")
def get_restaurant_inspections(business_id: str):
    """Restaurant identity plus the most recent inspection and its violations."""
    db = get_db()

    restaurant = db.execute(
        """
        SELECT
            business_id,
            business_name,
            business_address,
            business_city,
            business_state,
            business_postal_code
        FROM restaurants
        WHERE business_id = ?
        """,
        (business_id,),
    ).fetchone()

    if restaurant is None:
        return jsonify({"error": "Restaurant not found"}), 404

    inspections = db.execute(
        """
        SELECT inspection_id, inspection_date, inspection_score, inspection_type
        FROM inspections
        WHERE business_id = ?
        ORDER BY inspection_date DESC, inspection_id DESC
        """,
        (business_id,),
    ).fetchall()

    payload = dict(restaurant)
    if not inspections:
        payload["latest_inspection"] = None
        return jsonify(payload)

    latest = inspections[0]
    violation_rows = db.execute(
        """
        SELECT violation_id, inspection_id, violation_description, risk_category
        FROM violations
        WHERE inspection_id = ?
        ORDER BY violation_id
        """,
        (latest["inspection_id"],),
    ).fetchall()

    latest_payload = dict(latest)
    latest_payload["violations"] = rows_to_dicts(violation_rows)
    payload["latest_inspection"] = latest_payload
    return jsonify(payload)


@bp.get("/<business_id>")
def get_restaurant(business_id: str):
    db = get_db()

    restaurant = db.execute(
        f"""
        {LATEST_SCORE_CTE}
        SELECT
            r.*,
            latest.inspection_score AS latest_inspection_score,
            latest.inspection_date  AS latest_inspection_date
        FROM restaurants r
        LEFT JOIN latest ON latest.business_id = r.business_id AND latest.rn = 1
        WHERE r.business_id = ?
        """,
        (business_id,),
    ).fetchone()

    if restaurant is None:
        return jsonify({"error": "Restaurant not found"}), 404

    inspections = db.execute(
        """
        SELECT inspection_id, inspection_date, inspection_score, inspection_type
        FROM inspections
        WHERE business_id = ?
        ORDER BY inspection_date DESC, inspection_id DESC
        """,
        (business_id,),
    ).fetchall()

    violations = db.execute(
        """
        SELECT violation_id, inspection_id, violation_description, risk_category
        FROM violations
        WHERE business_id = ?
        """,
        (business_id,),
    ).fetchall()

    by_inspection: dict[str, list[dict]] = {}
    for v in violations:
        by_inspection.setdefault(v["inspection_id"], []).append(
            {
                "violation_id": v["violation_id"],
                "violation_description": v["violation_description"],
                "risk_category": v["risk_category"],
            }
        )

    inspection_payload = []
    for insp in inspections:
        d = dict(insp)
        d["violations"] = by_inspection.get(insp["inspection_id"], [])
        inspection_payload.append(d)

    payload = dict(restaurant)
    payload["inspections"] = inspection_payload
    return jsonify(payload)
