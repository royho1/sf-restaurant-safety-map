# Project state

Durable agent memory for this repository. Not a README. Capture only what future sessions would otherwise rediscover the hard way.

## Snapshot

- **What this is:** Interactive Mapbox map of San Francisco restaurant health-inspection scores (Flask + SQLite API, React/Vite frontend).
- **Current phase / constraints:** Local-first viewer of DataSF data. `safety.db` is generated, not committed. Mapbox token lives in gitignored `frontend/.env`.
- **Data source:** [Health Inspection Scores (2024–Present)](https://data.sfgov.org/Health-and-Social-Services/Health-Inspection-Scores-2024-Present-/tvy3-wexg) (`tvy3-wexg`) — Pass / Conditional Pass / Closure. The older LIVES numeric-score feed (`pyih-qa8i`, 2016–2019) is historical and no longer used.

## Learnings

### 2026-09-01 — Data pipeline hardening
- **Learning:** Weekly GitHub refresh uses `--skip-geocode`; coordinate backfill runs monthly via `geocode-backlog.yml` (`--geocode-only --max-geocodes 500`). Runtime API refresh auto-runs a geocode pass when `restaurants.csv` has missing coords and geocoding is not skipped.
- **Why it matters:** New restaurants without DataSF lat/lng won't appear on the map until a geocode pass runs.
- **Implication:** Check `/api/meta` fields `restaurants_missing_coordinates` and `last_refresh` to spot drift.

### 2026-09-01 — `no_rating` is expected for some inspections
- **Learning:** ~248 restaurants show no latest rating. Most are **Structural** or **Site Visit** inspection types where DataSF does not set `facility_rating_status`.
- **Why it matters:** Not an ETL bug; do not treat as missing data.
- **Implication:** UI can label these as "No rating (structural visit)" if we want clearer copy.

### 2026-09-01 — `risk_category` unused on current feed
- **Learning:** `tvy3-wexg` violation text has no risk tier; `clean_data.py` sets `risk_category` to NA for all rows.
- **Why it matters:** Popup risk badges will always be empty unless we add a code lookup table.
- **Implication:** Hide empty risk badges or join another dataset.

## Nuances and gotchas

- **DB is gitignored.** `backend/db/safety.db` must be built with `python scripts/load_db.py` from `data/processed/` CSVs. `/api/health` returns 503 if the file is missing.
- **Frontend is one large `App.jsx`.** Map, search, popup, filters, Insights, and overlay live in `frontend/src/App.jsx`. Prefer targeted edits over splitting unless asked.
- **Latest scores are a derived table.** `latest_scores` is built at load time. Map/list/Insights join it; do not window the full inspections table per request.
- **Map payload is a special case.** `GET /api/restaurants?view=map` is compact, skips `COUNT(*)`/name sort, and allows `limit` up to 10,000 when `has_coordinates=true`.
- **Nominatim is slow and rate-limited.** Geocoding is 1 req/s; cache is `data/processed/geocode_cache.json`. First full pass is ~an hour; later runs only hit new addresses. Use `--skip-geocode` or `--max-geocodes N` unless backfill is the task.
- **Dev Flask is debug-on and CORS-open.** `run.py` defaults to `debug=True` on `127.0.0.1:5001`. Unset `CORS_ORIGINS` allows any origin. Lock both before any public deploy.
- **Mapbox token is public by design.** `VITE_MAPBOX_TOKEN` is bundled into client JS. Restrict it by URL in the Mapbox dashboard rather than treating it as a server secret.
- **Weaker scores are drawn larger.** Default marker sizing is intentional so a Pass majority does not hide low scores. Heatmap also weights lower scores more heavily.
- **Data validation.** `python scripts/validate_data.py` checks row counts, coordinate coverage, and inspection freshness. CI runs it after weekly refresh.
- **Refresh status file.** `data/processed/last_refresh.json` is written by `refresh_data.py` and exposed via `/api/meta`.

## Decisions

- **SQLite snapshot, not live DataSF at request time.** The API reads `safety.db`. Refresh is fetch → clean → load (`scripts/refresh_data.py`), with a 24h background check (`DATA_REFRESH_HOURS`) and a Monday GitHub Action.
- **Geocode split across schedules.** Weekly fetch skips Nominatim; monthly workflow backfills coordinates. Background job uses `DATA_REFRESH_MAX_GEOCODES` (default 30).
- **No auth.** Read-only public-data viewer. Add auth before any write endpoints.

## Do not store

Secrets, tokens, `.env` values, session transcripts, or content that already lives in the README unless it is easy to miss.
