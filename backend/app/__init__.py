"""Flask application factory."""

import sqlite3
from pathlib import Path

from flask import Flask
from flask_cors import CORS

from .config import Config
from .refresh_job import start_refresh_scheduler
from .utils.db import close_db, ensure_indexes, get_db, schema_is_current


def _load_json_file(path: Path) -> dict | None:
    if not path.is_file():
        return None
    try:
        import json

        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


def create_app(config_object: type = Config) -> Flask:
    app = Flask(__name__)
    app.config.from_object(config_object)

    origins = app.config.get("CORS_ORIGINS") or []
    if origins:
        CORS(app, resources={r"/api/*": {"origins": origins}})
    else:
        CORS(app)

    from .routes.restaurants import bp as restaurants_bp
    from .routes.inspections import bp as inspections_bp
    from .routes.stats import bp as stats_bp

    app.register_blueprint(restaurants_bp)
    app.register_blueprint(inspections_bp)
    app.register_blueprint(stats_bp)

    app.teardown_appcontext(close_db)

    with app.app_context():
        ensure_indexes()

    @app.get("/api/health")
    def health() -> tuple[dict, int] | dict:
        path = Path(app.config["DATABASE_PATH"])
        if not path.is_file():
            return {
                "status": "error",
                "error": f"database not found at {path}. Run python scripts/load_db.py",
            }, 503
        try:
            db = get_db()
            db.execute("SELECT 1").fetchone()
            if not schema_is_current(db):
                return {
                    "status": "error",
                    "error": (
                        "database schema is stale. Run python scripts/load_db.py"
                    ),
                }, 503
        except sqlite3.Error as exc:
            return {"status": "error", "error": str(exc)}, 503
        return {"status": "ok"}

    @app.get("/api/meta")
    def meta() -> tuple[dict, int] | dict:
        path = Path(app.config["DATABASE_PATH"])
        if not path.is_file():
            return {
                "status": "error",
                "error": f"database not found at {path}. Run python scripts/load_db.py",
            }, 503
        try:
            db = get_db()
            counts = db.execute(
                """
                SELECT
                    (SELECT COUNT(*) FROM restaurants) AS restaurant_count,
                    (SELECT COUNT(*) FROM inspections) AS inspection_count,
                    (SELECT MAX(inspection_date) FROM inspections) AS latest_inspection_date,
                    (
                        SELECT COUNT(*)
                        FROM restaurants
                        WHERE business_latitude IS NOT NULL
                          AND business_longitude IS NOT NULL
                    ) AS restaurants_with_coordinates
                """
            ).fetchone()
        except sqlite3.Error as exc:
            return {"status": "error", "error": str(exc)}, 503

        processed_dir = Config.PROJECT_ROOT / "data" / "processed"
        source_revision = _load_json_file(processed_dir / "source_revision.json")
        last_refresh = _load_json_file(processed_dir / "last_refresh.json")
        restaurant_count = counts["restaurant_count"]
        with_coordinates = counts["restaurants_with_coordinates"]

        return {
            "status": "ok",
            "restaurant_count": restaurant_count,
            "inspection_count": counts["inspection_count"],
            "latest_inspection_date": counts["latest_inspection_date"],
            "restaurants_with_coordinates": with_coordinates,
            "restaurants_missing_coordinates": restaurant_count - with_coordinates,
            "db_mtime": int(path.stat().st_mtime),
            "source_revision": source_revision,
            "last_refresh": last_refresh,
        }

    start_refresh_scheduler(app)

    return app
