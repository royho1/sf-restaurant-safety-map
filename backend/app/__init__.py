"""Flask application factory."""

from flask import Flask
from flask_cors import CORS

from .config import Config
from .utils.db import close_db


def create_app(config_object: type = Config) -> Flask:
    app = Flask(__name__)
    app.config.from_object(config_object)

    CORS(app)

    from .routes.restaurants import bp as restaurants_bp
    from .routes.inspections import bp as inspections_bp
    from .routes.stats import bp as stats_bp

    app.register_blueprint(restaurants_bp)
    app.register_blueprint(inspections_bp)
    app.register_blueprint(stats_bp)

    app.teardown_appcontext(close_db)

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok"}

    return app
