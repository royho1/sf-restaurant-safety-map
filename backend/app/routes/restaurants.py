"""Restaurant endpoints."""

from flask import Blueprint, jsonify, request

from ..utils.db import get_db, rows_to_dicts

bp = Blueprint("restaurants", __name__, url_prefix="/api/restaurants")

DEFAULT_LIMIT = 50
MAX_LIMIT = 500
# When callers explicitly filter to geocoded restaurants (the map view) we
# allow a much larger page so the whole city can be rendered in one fetch.
MAX_LIMIT_HAS_COORDINATES = 10000

LATEST_SCORE_JOIN = (
    "LEFT JOIN latest_scores latest ON latest.business_id = r.business_id"
)

MAP_LIST_COLUMNS = """
            r.business_id,
            r.business_name,
            r.business_address,
            r.analysis_neighborhood,
            r.business_latitude,
            r.business_longitude,
            latest.facility_rating_status AS latest_rating_status
"""

FULL_LIST_COLUMNS = """
            r.business_id,
            r.business_name,
            r.business_address,
            r.business_city,
            r.business_state,
            r.business_postal_code,
            r.business_phone_number,
            r.business_latitude,
            r.business_longitude,
            r.analysis_neighborhood,
            r.permit_type,
            latest.facility_rating_status AS latest_rating_status,
            latest.inspection_date  AS latest_inspection_date
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
    neighborhood = (request.args.get("neighborhood") or "").strip() or None
    rating = (request.args.get("rating") or "").strip() or None
    has_coordinates = _parse_bool(request.args.get("has_coordinates"))
    view = (request.args.get("view") or "").strip().lower()
    is_map_view = view == "map"
    include_total = _parse_bool(request.args.get("include_total"))
    if include_total is None:
        include_total = not is_map_view

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
    if neighborhood:
        where.append("r.analysis_neighborhood = ?")
        params.append(neighborhood)
    if has_coordinates is True:
        where.append("r.business_latitude IS NOT NULL AND r.business_longitude IS NOT NULL")
    elif has_coordinates is False:
        where.append("(r.business_latitude IS NULL OR r.business_longitude IS NULL)")
    if rating:
        where.append("latest.facility_rating_status = ?")
        params.append(rating)

    where_sql = f"WHERE {' AND '.join(where)}" if where else ""

    db = get_db()

    total = None
    if include_total:
        count_sql = f"""
            SELECT COUNT(*) AS total
            FROM restaurants r
            {LATEST_SCORE_JOIN}
            {where_sql}
        """
        total = db.execute(count_sql, params).fetchone()["total"]

    columns = MAP_LIST_COLUMNS if is_map_view else FULL_LIST_COLUMNS
    order_sql = "" if is_map_view else "ORDER BY r.business_name COLLATE NOCASE"
    list_sql = f"""
        SELECT
            {columns}
        FROM restaurants r
        {LATEST_SCORE_JOIN}
        {where_sql}
        {order_sql}
        LIMIT ? OFFSET ?
    """
    rows = db.execute(list_sql, params + [limit, offset]).fetchall()
    results = rows_to_dicts(rows)

    return jsonify(
        {
            "total": len(results) if total is None else total,
            "limit": limit,
            "offset": offset,
            "count": len(results),
            "results": results,
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
            business_postal_code,
            analysis_neighborhood,
            permit_type
        FROM restaurants
        WHERE business_id = ?
        """,
        (business_id,),
    ).fetchone()

    if restaurant is None:
        return jsonify({"error": "Restaurant not found"}), 404

    inspections = db.execute(
        """
        SELECT
            inspection_id,
            inspection_date,
            inspection_type,
            facility_rating_status,
            violation_count,
            inspection_notes,
            suspension_notes
        FROM inspections
        WHERE business_id = ?
        ORDER BY inspection_date DESC, inspection_id DESC
        """,
        (business_id,),
    ).fetchall()

    payload = dict(restaurant)
    payload["inspections"] = [
        {
            "inspection_id": row["inspection_id"],
            "inspection_date": row["inspection_date"],
            "inspection_type": row["inspection_type"],
            "facility_rating_status": row["facility_rating_status"],
            "violation_count": row["violation_count"],
        }
        for row in inspections
    ]
    if not inspections:
        payload["latest_inspection"] = None
        payload["rated_inspection"] = None
        return jsonify(payload)

    def inspection_with_violations(row):
        if row is None:
            return None
        violation_rows = db.execute(
            """
            SELECT violation_id, inspection_id, violation_description, risk_category
            FROM violations
            WHERE inspection_id = ?
            ORDER BY violation_id
            """,
            (row["inspection_id"],),
        ).fetchall()
        item = dict(row)
        item["violations"] = rows_to_dicts(violation_rows)
        return item

    rated_row = next(
        (row for row in inspections if row["facility_rating_status"]),
        None,
    )
    payload["latest_inspection"] = inspection_with_violations(inspections[0])
    payload["rated_inspection"] = inspection_with_violations(rated_row)
    return jsonify(payload)


@bp.get("/<business_id>")
def get_restaurant(business_id: str):
    db = get_db()

    restaurant = db.execute(
        f"""
        SELECT
            r.*,
            latest.facility_rating_status AS latest_rating_status,
            latest.inspection_date  AS latest_inspection_date
        FROM restaurants r
        {LATEST_SCORE_JOIN}
        WHERE r.business_id = ?
        """,
        (business_id,),
    ).fetchone()

    if restaurant is None:
        return jsonify({"error": "Restaurant not found"}), 404

    inspections = db.execute(
        """
        SELECT inspection_id, inspection_date, inspection_type, facility_rating_status,
               violation_count, inspection_notes, suspension_notes
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
