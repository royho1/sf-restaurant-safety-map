"""Aggregate stats endpoints."""

from flask import Blueprint, jsonify, request

from ..utils.db import get_db, rows_to_dicts

bp = Blueprint("stats", __name__, url_prefix="/api/stats")

TOP_BOTTOM_RESTAURANTS = 3
CITYWIDE_LOWEST_RESTAURANTS = 8

RATING_RANK_SQL = """
CASE latest.facility_rating_status
    WHEN 'Closure' THEN 0
    WHEN 'Conditional Pass' THEN 1
    WHEN 'Pass' THEN 2
    ELSE 3
END
"""

RANKED_RESTAURANT_SELECT = """
SELECT
    r.business_id,
    r.business_name,
    r.business_address,
    r.business_city,
    r.business_state,
    r.business_postal_code,
    r.business_latitude,
    r.business_longitude,
    r.analysis_neighborhood,
    latest.facility_rating_status AS latest_rating_status
FROM restaurants r
INNER JOIN latest_scores latest ON latest.business_id = r.business_id
WHERE latest.facility_rating_status IS NOT NULL
  AND TRIM(latest.facility_rating_status) <> ''
"""


@bp.get("")
def citywide_stats():
    """Total restaurants, pass rate, and Pass / Conditional / Closure counts."""
    db = get_db()

    row = db.execute(
        """
        SELECT
            COUNT(*) AS total_restaurants,
            SUM(
                CASE WHEN latest.facility_rating_status = 'Pass' THEN 1 ELSE 0 END
            ) AS rating_pass,
            SUM(
                CASE
                    WHEN latest.facility_rating_status = 'Conditional Pass' THEN 1
                    ELSE 0
                END
            ) AS rating_conditional,
            SUM(
                CASE WHEN latest.facility_rating_status = 'Closure' THEN 1 ELSE 0 END
            ) AS rating_closure,
            SUM(
                CASE
                    WHEN latest.facility_rating_status IS NULL
                      OR TRIM(latest.facility_rating_status) = ''
                    THEN 1 ELSE 0
                END
            ) AS no_rating
        FROM restaurants r
        LEFT JOIN latest_scores latest ON latest.business_id = r.business_id
        """
    ).fetchone()

    rated = (
        (row["rating_pass"] or 0)
        + (row["rating_conditional"] or 0)
        + (row["rating_closure"] or 0)
    )
    pass_rate = round((row["rating_pass"] / rated) * 100, 1) if rated else None
    lowest_rows = db.execute(
        RANKED_RESTAURANT_SELECT
        + f"""
          AND r.business_latitude IS NOT NULL
          AND r.business_longitude IS NOT NULL
        ORDER BY {RATING_RANK_SQL} ASC, r.business_name COLLATE NOCASE
        LIMIT ?
        """,
        (CITYWIDE_LOWEST_RESTAURANTS,),
    ).fetchall()
    return jsonify(
        {
            "total_restaurants": row["total_restaurants"],
            "pass_rate": pass_rate,
            "restaurant_rating_distribution": {
                "pass": row["rating_pass"] or 0,
                "conditional": row["rating_conditional"] or 0,
                "closure": row["rating_closure"] or 0,
                "no_rating": row["no_rating"] or 0,
            },
            "lowest_restaurants": rows_to_dicts(lowest_rows),
        }
    )


@bp.get("/neighborhoods")
def neighborhood_stats():
    """Without neighborhood: list names. With neighborhood: detail + top/bottom."""
    db = get_db()
    neighborhood = (request.args.get("neighborhood", type=str) or "").strip()

    if not neighborhood:
        names = db.execute(
            """
            SELECT DISTINCT analysis_neighborhood AS neighborhood
            FROM restaurants
            WHERE analysis_neighborhood IS NOT NULL
              AND TRIM(analysis_neighborhood) <> ''
            ORDER BY analysis_neighborhood COLLATE NOCASE
            """
        ).fetchall()
        return jsonify({"neighborhoods": [r["neighborhood"] for r in names]})

    exists = db.execute(
        "SELECT 1 AS ok FROM restaurants WHERE analysis_neighborhood = ? LIMIT 1",
        (neighborhood,),
    ).fetchone()
    if not exists:
        return jsonify({"error": "Unknown neighborhood"}), 404

    summary = db.execute(
        """
        SELECT
            COUNT(*) AS restaurant_count,
            SUM(
                CASE WHEN latest.facility_rating_status = 'Pass' THEN 1 ELSE 0 END
            ) AS rating_pass,
            SUM(
                CASE
                    WHEN latest.facility_rating_status IS NOT NULL
                     AND TRIM(latest.facility_rating_status) <> ''
                    THEN 1 ELSE 0
                END
            ) AS rated_count
        FROM restaurants r
        LEFT JOIN latest_scores latest ON latest.business_id = r.business_id
        WHERE r.analysis_neighborhood = ?
        """,
        (neighborhood,),
    ).fetchone()

    ranked_select = (
        RANKED_RESTAURANT_SELECT
        + """
        AND r.analysis_neighborhood = ?
        """
    )
    top_sql = ranked_select + f"""
        ORDER BY {RATING_RANK_SQL} DESC, r.business_name COLLATE NOCASE
        LIMIT ?
    """
    bottom_sql = ranked_select + f"""
        ORDER BY {RATING_RANK_SQL} ASC, r.business_name COLLATE NOCASE
        LIMIT ?
    """

    top_rows = db.execute(top_sql, (neighborhood, TOP_BOTTOM_RESTAURANTS)).fetchall()
    bottom_rows = db.execute(bottom_sql, (neighborhood, TOP_BOTTOM_RESTAURANTS)).fetchall()

    rated = summary["rated_count"] or 0
    pass_rate = (
        round((summary["rating_pass"] / rated) * 100, 1) if rated else None
    )
    return jsonify(
        {
            "neighborhood": neighborhood,
            "restaurant_count": summary["restaurant_count"],
            "pass_rate": pass_rate,
            "top_restaurants": rows_to_dicts(top_rows),
            "bottom_restaurants": rows_to_dicts(bottom_rows),
        }
    )
