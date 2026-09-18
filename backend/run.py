"""Dev entry point for the Flask API.

Debug is opt-in. For production, prefer gunicorn (see backend/Dockerfile):
  gunicorn -b 0.0.0.0:5001 -w 2 --timeout 60 'run:app'
"""

import argparse
import os

from app import create_app

app = create_app()


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the SF restaurant safety API.")
    parser.add_argument(
        "--host",
        default=os.environ.get("HOST", "127.0.0.1"),
        help="Host interface to bind (default: 127.0.0.1, env: HOST)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("PORT", "5001")),
        help="Port to listen on (default: 5001, env: PORT)",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable Flask debug mode (local development only; never on a public host)",
    )
    parser.add_argument(
        "--no-debug",
        action="store_true",
        help=argparse.SUPPRESS,  # kept for older scripts; debug is already off by default
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = _parse_args()
    app.run(host=args.host, port=args.port, debug=bool(args.debug) and not args.no_debug)
