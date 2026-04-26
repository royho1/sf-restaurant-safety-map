# SF Restaurant Safety Map

Interactive web app that maps every San Francisco restaurant inspection score on a Mapbox-rendered map. Click a dot to see the latest score, the inspection date, and the violations recorded that day. Search by name or ZIP, filter by score band, jump to your current location, and open an Insights panel for citywide stats and a per-ZIP breakdown of best/worst restaurants.

Data comes from the city's public health-inspection feed: [DataSF — Restaurant Scores (LIVES Standard)](https://data.sfgov.org/Health-and-Social-Services/Restaurant-Scores-LIVES-Standard/pyih-qa8i).

## Tech stack

- **Backend:** Python 3.10+, Flask 3, Flask-CORS, SQLite (read-only at request time)
- **Frontend:** React 18, Vite 5, react-map-gl, mapbox-gl, axios
- **Data pipeline:** Python, pandas, geopy (OpenStreetMap Nominatim for backfilling missing coordinates)
- **Storage:** SQLite file at `backend/db/safety.db`, built from cleaned CSVs in `data/processed/`

## What's in the box

- One-click circle markers colored by latest inspection score: green (90+), yellow (70–89), red (below 70), gray (no score).
- Restaurant search with debounced typeahead. Typing a 5-digit `941xx` ZIP switches into ZIP mode and flies the map to that ZIP's centroid.
- Click any dot for an inspection-detail popup: name, address, latest score, date, and the full violation list with risk category.
- "Near Me" button uses the browser's geolocation API to recenter the map.
- Light/dark Mapbox basemap toggle.
- Insights side panel with citywide totals, an avg-score readout, a score-distribution mini chart, and a per-ZIP drilldown showing the 3 highest- and 3 lowest-scoring restaurants in that ZIP.
- Score-band map filters (show/hide green, yellow, red, no-score dots).

## Repository layout

```
backend/        Flask API (app factory, blueprints, SQLite helpers)
  app/
    __init__.py        create_app(), CORS, blueprint registration, /api/health
    config.py          SAFETY_DB_PATH env override, defaults
    routes/
      restaurants.py   /api/restaurants list + detail + inspections
      inspections.py   /api/inspections/<business_id>
      stats.py         /api/stats and /api/stats/neighborhoods
    utils/db.py        per-request sqlite3 connection, row_factory
  db/.gitkeep          safety.db is generated, not committed
  requirements.txt
  run.py               dev entry point (HOST/PORT env, --no-debug)

frontend/       Vite + React app
  src/App.jsx          single-file UI: map, search, sidebar, popup, filters
  src/main.jsx         React root
  src/styles/          CSS
  vite.config.js       dev server on port 5173
  package.json

scripts/        Data pipeline (run in this order)
  fetch_data.py        Pull the full DataSF feed to data/raw/inspections_raw.json
  clean_data.py        Normalize into restaurants/inspections/violations CSVs,
                       optionally geocoding missing addresses via Nominatim
  load_db.py           Load CSVs into backend/db/safety.db
  requirements.txt

data/processed/ Cleaned CSVs (restaurants, inspections, violations) + Nominatim cache
```

## Setup

### Prerequisites

- Python 3.10+
- Node.js 18+ and npm
- A free [Mapbox access token](https://account.mapbox.com/access-tokens/) for the frontend

### 1. Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

The DB file `backend/db/safety.db` is gitignored. Build it from the committed CSVs:

```bash
cd ..
pip install -r scripts/requirements.txt
python scripts/load_db.py
```

This produces `backend/db/safety.db` from the CSVs already in `data/processed/`. No network, no geocoding, no DataSF API call needed for this path. Takes a few seconds.

Then run the API:

```bash
cd backend
python run.py                      # binds 0.0.0.0:5001 by default
```

Override with env vars or flags:

```bash
PORT=8080 python run.py
python run.py --host 127.0.0.1 --port 5050 --no-debug
SAFETY_DB_PATH=/abs/path/to/safety.db python run.py
```

Sanity check: `curl http://localhost:5001/api/health` returns `{"status":"ok"}`.

### 2. Frontend

```bash
cd frontend
npm install
```

Create `frontend/.env` with your Mapbox token (this file is gitignored):

```
VITE_MAPBOX_TOKEN=pk.your_mapbox_public_token_here
```

Then start the dev server:

```bash
npm run dev                        # http://localhost:5173
```

The frontend currently hardcodes the API base URL to `http://localhost:5001` (see `API_BASE` in `frontend/src/App.jsx`). If you change the backend port, change it there too, or move it to `import.meta.env.VITE_API_BASE`.

### 3. (Optional) Refresh the data from DataSF

The committed CSVs are a snapshot. To pull the latest inspections and rebuild from scratch:

```bash
pip install -r scripts/requirements.txt

python scripts/fetch_data.py       # paginates the SODA API into data/raw/inspections_raw.json
python scripts/clean_data.py       # normalizes, then geocodes addresses missing lat/lng via Nominatim
python scripts/load_db.py          # rebuilds backend/db/safety.db
```

`clean_data.py` flags:
- `--skip-geocode` — skip the Nominatim step entirely (fast, but new restaurants without coordinates won't appear on the map).
- `--max-geocodes N` — cap NEW network calls at N (cache hits are free). Useful for smoke-testing.

Geocoding rate-limits to 1 request/second per Nominatim's usage policy and caches every result (hits and confirmed misses) in `data/processed/geocode_cache.json`, so re-runs only query addresses they haven't seen. A full first-time geocode of all missing addresses takes roughly an hour; subsequent runs finish in seconds.

## API reference

All endpoints are JSON. Base URL in development: `http://localhost:5001`.

### `GET /api/health`
Liveness check. Returns `{"status": "ok"}`.

### `GET /api/restaurants`
Paginated, filterable list of restaurants. Each row includes the latest scored inspection (joined via a `ROW_NUMBER() OVER (PARTITION BY business_id ORDER BY inspection_date DESC)` CTE).

Query params:
- `search` or `name` — substring match on `business_name` (case-insensitive `LIKE`).
- `postal_code` — exact match.
- `min_score` — numeric, filters on the latest score.
- `has_coordinates=true|false` — restrict to restaurants with or without lat/lng.
- `limit` (default 50, max 500; max 10,000 when `has_coordinates=true` so the whole map can render in one fetch).
- `offset` (default 0).

Response: `{ total, limit, offset, count, results: [...] }`.

### `GET /api/restaurants/<business_id>`
Full restaurant record plus every inspection, with violations grouped per inspection. 404 if the ID isn't found.

### `GET /api/restaurants/<business_id>/inspections`
Lighter endpoint used by the map popup: restaurant identity plus the most recent inspection and its violations only.

### `GET /api/inspections/<business_id>`
Every inspection for a restaurant, each with its violations attached. Same payload structure as the popup endpoint, but full history.

### `GET /api/stats`
Citywide rollup: total restaurants, average latest score, and the score distribution buckets (`90_plus`, `70_to_89`, `below_70`, `no_score`).

### `GET /api/stats/neighborhoods`
- Without `postal_code`: returns `{ postal_codes: [...] }` of every distinct ZIP in the data.
- With `?postal_code=941XX`: returns restaurant count, average latest score, and the top 3 / bottom 3 scoring restaurants in that ZIP. 404 if the ZIP isn't in the data.

## Data model

Three tables, all built from the DataSF feed:

- **restaurants** — one row per `business_id`. Identity, address, phone, lat/lng. Lat/lng are floats and may be NULL when DataSF didn't supply them and Nominatim couldn't resolve the address.
- **inspections** — one row per `inspection_id`, FK to `restaurants`. Has `inspection_date`, `inspection_score` (nullable; reinspections often have no score), `inspection_type`.
- **violations** — one row per `violation_id`, FK to `inspections` and `restaurants`. Has `violation_description` and `risk_category` ("High Risk" / "Moderate Risk" / "Low Risk").

## Security review

Findings from a sweep of the source tree and git history:

- **No leaked secrets.** Git history (6 commits) contains no API keys, no Mapbox tokens, no .env files, no credentials. The Mapbox token is read from `import.meta.env.VITE_MAPBOX_TOKEN` and is the only secret the app uses. Both `.env` and `frontend/.env` are gitignored.
- **SQL injection.** All queries use parameterized `?` placeholders via `sqlite3.Connection.execute(sql, params)`. The shared CTEs are static strings; user input never enters SQL via concatenation.
- **CORS is wide open.** `CORS(app)` with no config allows any origin. Fine for local dev. Before deploying, restrict it: `CORS(app, resources={r"/api/*": {"origins": ["https://yourdomain.com"]}})`.
- **Flask debug mode is on by default.** `run.py` calls `app.run(..., debug=True)` unless `--no-debug` is passed. Werkzeug's debugger allows arbitrary code execution if exposed; never run with debug on a public host. Use `--no-debug` (or a real WSGI server like gunicorn/uwsgi) in production.
- **Bound to 0.0.0.0 by default.** `run.py`'s default host is `0.0.0.0`, so the dev server is reachable from the local network. Combined with debug mode, that's worth knowing. For local-only dev, pass `--host 127.0.0.1` or set `HOST=127.0.0.1`.
- **Mapbox token exposure (by design).** `VITE_MAPBOX_TOKEN` is bundled into the client JS — it's a public token and that's how Mapbox works. Lock it down in the Mapbox dashboard with URL restrictions (only allow it to be used from your domain) so someone can't lift it from your bundle and run up your bill.
- **Geolocation, deny-by-default.** "Near Me" calls `navigator.geolocation.getCurrentPosition`, which the browser gates behind a user permission prompt. Coordinates stay client-side; nothing is sent to the backend.
- **No authentication.** All endpoints are open. That's appropriate for a read-only public-data viewer, but if you ever add write endpoints, add auth first.
- **DB file is read-only in practice.** The API only ever issues `SELECT` statements. Even so, the connection is opened in read/write mode by default; if you want belt-and-suspenders, switch to `sqlite3.connect(f"file:{path}?mode=ro", uri=True)` in `utils/db.py`.

Nothing critical to fix before publishing the repo. Before deploying anywhere public: turn off debug, lock CORS, restrict the Mapbox token by URL, and put the API behind a real WSGI server.

## Data source and license

Inspection data is published by the San Francisco Department of Public Health via [DataSF](https://datasf.org/opendata/) under their open-data terms. This project is an independent visualization of that data and is not affiliated with the City and County of San Francisco.
