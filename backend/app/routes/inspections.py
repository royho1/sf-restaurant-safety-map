"""Inspection endpoints."""

from flask import Blueprint, jsonify

from ..utils.db import get_db

bp = Blueprint("inspections", __name__, url_prefix="/api/inspections")


@bp.get("/<business_id>")
def list_for_restaurant(business_id: str):
    db = get_db()

    restaurant = db.execute(
        "SELECT business_id, business_name FROM restaurants WHERE business_id = ?",
        (business_id,),
    ).fetchone()
    if restaurant is None:
        return jsonify({"error": "Restaurant not found"}), 404

    inspections = db.execute(
        """
        SELECT inspection_id, business_id, inspection_date, inspection_score, inspection_type
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

    payload = []
    for insp in inspections:
        d = dict(insp)
        d["violations"] = by_inspection.get(insp["inspection_id"], [])
        payload.append(d)

    return jsonify(
        {
            "business_id": restaurant["business_id"],
            "business_name": restaurant["business_name"],
            "count": len(payload),
            "inspections": payload,
        }
    )
