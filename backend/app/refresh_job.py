"""Optional background rebuild from DataSF while the API is running."""

from __future__ import annotations

import logging
import os
import subprocess
import sys
import threading
import time

from flask import Flask

from .config import Config

logger = logging.getLogger(__name__)

REFRESH_SCRIPT = Config.PROJECT_ROOT / "scripts" / "refresh_data.py"


def _should_start(app: Flask) -> bool:
    hours = float(app.config.get("DATA_REFRESH_HOURS") or 0)
    if hours <= 0:
        return False
    if app.debug and os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        return False
    return True


def _run_refresh() -> None:
    if not REFRESH_SCRIPT.is_file():
        logger.warning("data refresh skipped: %s is missing", REFRESH_SCRIPT)
        return
    max_geocodes = int(Config.DATA_REFRESH_MAX_GEOCODES or 30)
    cmd = [
        sys.executable,
        str(REFRESH_SCRIPT),
        "--max-geocodes",
        str(max_geocodes),
    ]
    logger.info("starting DataSF refresh: %s", " ".join(cmd))
    result = subprocess.run(
        cmd,
        cwd=Config.PROJECT_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "").strip()[-2000:]
        logger.error("data refresh failed (%s): %s", result.returncode, tail)
        return
    logger.info("data refresh finished")


def _loop(hours: float) -> None:
    time.sleep(60)
    while True:
        try:
            _run_refresh()
        except Exception:
            logger.exception("data refresh crashed")
        time.sleep(max(hours, 0.25) * 3600)


def start_refresh_scheduler(app: Flask) -> None:
    if not _should_start(app):
        return
    hours = float(app.config["DATA_REFRESH_HOURS"])
    thread = threading.Thread(
        target=_loop,
        args=(hours,),
        name="datasf-refresh",
        daemon=True,
    )
    thread.start()
    logger.info("DataSF refresh scheduler on (every %s hours)", hours)
