"""Aggregate stats endpoints."""

from flask import Blueprint, jsonify, request

from ..utils.db import get_db, rows_to_dicts

bp = Blueprint("stats", __name__, url_prefix="/api/stats")

TOP_BOTTOM_RESTAURANTS = 3

# Same "latest scored inspection per restaurant" definition as /api/restaurants.
LATEST_SCORED_INSPECTION_CTE = """
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


@bp.get("")
def citywide_stats():
    """Total restaurants, average latest inspection score, score distribution."""
    db = get_db()

    row = db.execute(
        f"""
        {LATEST_SCORED_INSPECTION_CTE}
        SELECT
            COUNT(*) AS total_restaurants,
            AVG(latest.inspection_score) AS avg_latest_score,
            SUM(CASE WHEN latest.inspection_score IS NULL THEN 1 ELSE 0 END) AS no_score,
            SUM(CASE WHEN latest.inspection_score >= 90 THEN 1 ELSE 0 END) AS score_90_plus,
            SUM(
                CASE
                    WHEN latest.inspection_score >= 70 AND latest.inspection_score < 90
                    THEN 1 ELSE 0
                END
            ) AS score_70_to_89,
            SUM(
                CASE
                    WHEN latest.inspection_score < 70 THEN 1 ELSE 0
                END
            ) AS score_below_70
        FROM restaurants r
        LEFT JOIN latest ON latest.business_id = r.business_id AND latest.rn = 1
        """
    ).fetchone()

    avg = row["avg_latest_score"]
    return jsonify(
        {
            "total_restaurants": row["total_restaurants"],
            "avg_latest_inspection_score": round(avg, 2) if avg is not None else None,
            "restaurant_score_distribution": {
                "90_plus": row["score_90_plus"],
                "70_to_89": row["score_70_to_89"],
                "below_70": row["score_below_70"],
                "no_score": row["no_score"],
            },
        }
    )


@bp.get("/neighborhoods")
def neighborhood_stats():
    """Without postal_code: list zips. With postal_code: detail + top/bottom restaurants."""
    db = get_db()
    postal = (request.args.get("postal_code", type=str) or "").strip()

    if not postal:
        codes = db.execute(
            """
            SELECT DISTINCT business_postal_code AS postal_code
            FROM restaurants
            WHERE business_postal_code IS NOT NULL
              AND TRIM(business_postal_code) <> ''
            ORDER BY business_postal_code COLLATE NOCASE
            """
        ).fetchall()
        return jsonify({"postal_codes": [r["postal_code"] for r in codes]})

    exists = db.execute(
        "SELECT 1 AS ok FROM restaurants WHERE business_postal_code = ? LIMIT 1",
        (postal,),
    ).fetchone()
    if not exists:
        return jsonify({"error": "Unknown postal code"}), 404

    summary = db.execute(
        f"""
        {LATEST_SCORED_INSPECTION_CTE}
        SELECT
            COUNT(*) AS restaurant_count,
            AVG(latest.inspection_score) AS avg_latest_score
        FROM restaurants r
        LEFT JOIN latest ON latest.business_id = r.business_id AND latest.rn = 1
        WHERE r.business_postal_code = ?
        """,
        (postal,),
    ).fetchone()

    top_sql = f"""
        {LATEST_SCORED_INSPECTION_CTE}
        SELECT
            r.business_id,
            r.business_name,
            r.business_address,
            latest.inspection_score AS latest_inspection_score
        FROM restaurants r
        INNER JOIN latest ON latest.business_id = r.business_id AND latest.rn = 1
        WHERE r.business_postal_code = ?
          AND latest.inspection_score IS NOT NULL
        ORDER BY latest.inspection_score DESC, r.business_name COLLATE NOCASE
        LIMIT ?
    """
    bottom_sql = f"""
        {LATEST_SCORED_INSPECTION_CTE}
        SELECT
            r.business_id,
            r.business_name,
            r.business_address,
            latest.inspection_score AS latest_inspection_score
        FROM restaurants r
        INNER JOIN latest ON latest.business_id = r.business_id AND latest.rn = 1
        WHERE r.business_postal_code = ?
          AND latest.inspection_score IS NOT NULL
        ORDER BY latest.inspection_score ASC, r.business_name COLLATE NOCASE
        LIMIT ?
    """

    top_rows = db.execute(top_sql, (postal, TOP_BOTTOM_RESTAURANTS)).fetchall()
    bottom_rows = db.execute(bottom_sql, (postal, TOP_BOTTOM_RESTAURANTS)).fetchall()

    avg_s = summary["avg_latest_score"]
    return jsonify(
        {
            "postal_code": postal,
            "restaurant_count": summary["restaurant_count"],
            "avg_latest_inspection_score": round(avg_s, 2) if avg_s is not None else None,
            "top_restaurants": rows_to_dicts(top_rows),
            "bottom_restaurants": rows_to_dicts(bottom_rows),
        }
    )
