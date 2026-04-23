"""Aggregate stats endpoints."""

from flask import Blueprint, jsonify

from ..utils.db import get_db, rows_to_dicts

bp = Blueprint("stats", __name__, url_prefix="/api/stats")

TOP_VIOLATIONS_LIMIT = 10
TOP_NEIGHBORHOOD_VIOLATIONS = 3

# 100 -> 90 -> 80 -> 70 -> <70 buckets, plus an "unscored" bucket for context.
SCORE_BUCKETS = [
    ("90-100", 90, 100),
    ("80-89", 80, 89),
    ("70-79", 70, 79),
    ("0-69", 0, 69),
]


@bp.get("")
def citywide_stats():
    db = get_db()

    total_restaurants = db.execute("SELECT COUNT(*) AS n FROM restaurants").fetchone()["n"]
    total_inspections = db.execute("SELECT COUNT(*) AS n FROM inspections").fetchone()["n"]
    total_violations = db.execute("SELECT COUNT(*) AS n FROM violations").fetchone()["n"]

    avg_row = db.execute(
        "SELECT AVG(inspection_score) AS avg_score FROM inspections WHERE inspection_score IS NOT NULL"
    ).fetchone()
    avg_score = round(avg_row["avg_score"], 2) if avg_row["avg_score"] is not None else None

    most_common = db.execute(
        """
        SELECT violation_description, risk_category, COUNT(*) AS count
        FROM violations
        WHERE violation_description IS NOT NULL
        GROUP BY violation_description, risk_category
        ORDER BY count DESC
        LIMIT ?
        """,
        (TOP_VIOLATIONS_LIMIT,),
    ).fetchall()

    distribution = []
    for label, lo, hi in SCORE_BUCKETS:
        n = db.execute(
            """
            SELECT COUNT(*) AS n FROM inspections
            WHERE inspection_score IS NOT NULL
              AND inspection_score BETWEEN ? AND ?
            """,
            (lo, hi),
        ).fetchone()["n"]
        distribution.append({"bucket": label, "min_score": lo, "max_score": hi, "count": n})

    unscored = db.execute(
        "SELECT COUNT(*) AS n FROM inspections WHERE inspection_score IS NULL"
    ).fetchone()["n"]
    distribution.append({"bucket": "unscored", "min_score": None, "max_score": None, "count": unscored})

    return jsonify(
        {
            "total_restaurants": total_restaurants,
            "total_inspections": total_inspections,
            "total_violations": total_violations,
            "avg_inspection_score": avg_score,
            "most_common_violations": rows_to_dicts(most_common),
            "score_distribution": distribution,
        }
    )


@bp.get("/neighborhoods")
def neighborhood_stats():
    db = get_db()

    rows = db.execute(
        """
        SELECT
            r.business_postal_code AS postal_code,
            COUNT(DISTINCT r.business_id) AS restaurant_count,
            AVG(i.inspection_score)       AS avg_score,
            COUNT(i.inspection_id)        AS scored_inspection_count
        FROM restaurants r
        LEFT JOIN inspections i
               ON i.business_id = r.business_id
              AND i.inspection_score IS NOT NULL
        WHERE r.business_postal_code IS NOT NULL
          AND r.business_postal_code <> ''
        GROUP BY r.business_postal_code
        ORDER BY restaurant_count DESC
        """,
    ).fetchall()

    top_violations_sql = """
        SELECT v.violation_description, COUNT(*) AS count
        FROM violations v
        JOIN restaurants r ON r.business_id = v.business_id
        WHERE r.business_postal_code = ?
          AND v.violation_description IS NOT NULL
        GROUP BY v.violation_description
        ORDER BY count DESC
        LIMIT ?
    """

    payload = []
    for row in rows:
        postal = row["postal_code"]
        top = db.execute(top_violations_sql, (postal, TOP_NEIGHBORHOOD_VIOLATIONS)).fetchall()
        payload.append(
            {
                "postal_code": postal,
                "restaurant_count": row["restaurant_count"],
                "scored_inspection_count": row["scored_inspection_count"],
                "avg_inspection_score": round(row["avg_score"], 2) if row["avg_score"] is not None else None,
                "top_violations": rows_to_dicts(top),
            }
        )

    return jsonify({"count": len(payload), "neighborhoods": payload})
