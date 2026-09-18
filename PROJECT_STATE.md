# Project state

Durable agent memory for this repository. Not a README. Capture only what future sessions would otherwise rediscover the hard way.

## Snapshot

- **What this is:** SF restaurant health-inspection map (Vite + Mapbox frontend, Flask + SQLite API) over DataSF feed `tvy3-wexg`.
- **Current phase / constraints:** Feature work toward a public deploy later. Stack is Compose-friendly; full-stack Vercel alone is a poor fit (persistent SQLite + long-lived Flask). Prefer frontend on Vercel and API/DB on a container host when deploying.

## Learnings

Newest first.

### 2026-09-17 — Rebuilding CSVs from stale raw without fetch rolls back the snapshot
- **Learning:** Running `clean_data.py` against an old `data/raw/inspections_raw.json` while leaving `source_revision.json` unchanged drops newer inspections/restaurants/violations. Scheduled refresh then no-ops until DataSF bumps revision.
- **Why it matters:** Adding a column like `inspector` must use `refresh_data.py --force` (or a path that re-fetches) so the committed CSVs stay current.
- **Implication:** Prefer `--force` when schema columns change; never commit a cleaned snapshot from outdated raw.

### 2026-09-17 — Inspector is in the feed but was dropped in cleaning
- **Learning:** DataSF rows include `inspector` (nearly always populated). Cleaning previously omitted it from `INSPECTION_COLS` / `map_source_columns`, so SQLite and the API never saw it.
- **Why it matters:** UI “inspector on cards” needs a pipeline change (`clean_data.py` → `load_db.py` → routes), not just frontend.
- **Implication:** `schema_is_current()` requires `inspections.inspector`. Stale DBs rebuild from processed CSVs on API startup and via `refresh_data.py` when revision is unchanged but schema/CSV is behind.

## Nuances and gotchas

- Restaurant/inspection “cards” live in `frontend/src/App.jsx` Mapbox popups (and list rows), not separate card components.
- Popup detail comes from `GET /api/restaurants/:id/inspections`. History list items are a slim subset of inspection fields; anything shown there must be included in that payload’s `inspections` array.
- `backend/db/*.db` is gitignored; processed CSVs under `data/processed/` are committed.
- Flask `run.py` debug is opt-in (`--debug`). Docker API image uses gunicorn. Compose does not publish host `:5001` (API is internal; nginx on `:8080` proxies `/api/`).
- Unset `CORS_ORIGINS` allows any origin (dev-friendly). Lock it before public deploy. Mapbox token needs URL restrictions in the Mapbox dashboard.
- `frontend/nginx.conf` sets CSP / frame / nosniff headers tailored for Mapbox GL.
- Map list endpoint allows up to 10,000 geocoded restaurants per request (`MAX_LIMIT_HAS_COORDINATES`); fine for the map, but plan CDN/cache or proxy rate limits if the API is internet-facing.

## Decisions

- Keep the API/DB field name `inspector` to match DataSF (no `inspector_name` rename).
- Show inspector on the popup meta and history rows; skip search/Insights list rows (they do not load full inspection payloads).
- On schema upgrades, rebuild SQLite from current processed CSVs rather than hand-written ALTER migrations (`load_db.py` is already atomic temp-replace).

## Do not store

Secrets, tokens, `.env` values, session transcripts, or content that already lives in the README unless it is easy to miss.
