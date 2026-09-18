# Project state

Durable agent memory for this repository. Not a README. Capture only what future sessions would otherwise rediscover the hard way.

## Snapshot

- **What this is:** SF restaurant health-inspection map (Vite + Mapbox frontend, Flask + SQLite API) over DataSF feed `tvy3-wexg`.
- **Current phase / constraints:** Feature work toward a public deploy later. Stack is Compose-friendly; full-stack Vercel alone is a poor fit (persistent SQLite + long-lived Flask). Prefer frontend on Vercel and API/DB on a container host when deploying.

## Learnings

Newest first.

### 2026-09-17 — Inspector is in the feed but was dropped in cleaning
- **Learning:** DataSF rows include `inspector` (nearly always populated). Cleaning previously omitted it from `INSPECTION_COLS` / `map_source_columns`, so SQLite and the API never saw it.
- **Why it matters:** UI “inspector on cards” needs a pipeline change (`clean_data.py` → `load_db.py` → routes), not just frontend.
- **Implication:** After adding columns, re-run `python scripts/clean_data.py --skip-geocode` then `python scripts/load_db.py`. `schema_is_current()` now requires `inspections.inspector`.

## Nuances and gotchas

- Restaurant/inspection “cards” live in `frontend/src/App.jsx` Mapbox popups (and list rows), not separate card components.
- Popup detail comes from `GET /api/restaurants/:id/inspections`. History list items are a slim subset of inspection fields; anything shown there must be included in that payload’s `inspections` array.
- `backend/db/*.db` is gitignored; processed CSVs under `data/processed/` are committed. Stale local DBs fail health until reload.
- Unset `CORS_ORIGINS` allows any origin (dev-friendly). Flask `run.py` defaults to `debug=True`. Before any public host: lock CORS, `--no-debug` / gunicorn, Mapbox URL restrictions.

## Decisions

- Keep the API/DB field name `inspector` to match DataSF (no `inspector_name` rename).
- Show inspector on the popup meta and history rows; skip search/Insights list rows (they do not load full inspection payloads).

## Do not store

Secrets, tokens, `.env` values, session transcripts, or content that already lives in the README unless it is easy to miss.
