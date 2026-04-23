"""Dev entry point for the Flask API."""

import argparse
import os

from app import create_app

app = create_app()


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the SF restaurant safety API.")
    parser.add_argument(
        "--host",
        default=os.environ.get("HOST", "0.0.0.0"),
        help="Host interface to bind (default: 0.0.0.0, env: HOST)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("PORT", "5000")),
        help="Port to listen on (default: 5000, env: PORT)",
    )
    parser.add_argument(
        "--no-debug",
        action="store_true",
        help="Disable Flask debug mode",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = _parse_args()
    app.run(host=args.host, port=args.port, debug=not args.no_debug)
