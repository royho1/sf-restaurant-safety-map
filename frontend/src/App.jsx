import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Map, { Popup, Source, Layer } from 'react-map-gl';
import axios from 'axios';
import 'mapbox-gl/dist/mapbox-gl.css';

const API_BASE = 'http://localhost:5001';
const MAP_POINTS_URL = `${API_BASE}/api/restaurants?has_coordinates=true&limit=10000`;

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;

const SF_CENTER = {
  longitude: -122.4194,
  latitude: 37.7749,
  zoom: 12,
};

const RESTAURANTS_LAYER_ID = 'restaurants-layer';

const circleColorExpression = [
  'case',
  ['==', ['get', 'score'], null],
  '#9ca3af',
  ['>=', ['get', 'score'], 90],
  '#22c55e',
  ['>=', ['get', 'score'], 70],
  '#eab308',
  '#ef4444',
];

const DOT_RADIUS_BASE = 5;
const DOT_RADIUS_HOVER = DOT_RADIUS_BASE * 1.5;

const layerStyle = {
  id: RESTAURANTS_LAYER_ID,
  type: 'circle',
  paint: {
    'circle-radius': [
      'case',
      ['boolean', ['feature-state', 'hover'], false],
      DOT_RADIUS_HOVER,
      DOT_RADIUS_BASE,
    ],
    'circle-color': circleColorExpression,
    'circle-stroke-width': [
      'case',
      ['boolean', ['feature-state', 'hover'], false],
      1.5,
      1,
    ],
    'circle-stroke-color': '#ffffff',
    'circle-opacity': 0.9,
  },
};

function formatAddress(r) {
  const parts = [
    r.business_address,
    [r.business_city, r.business_state].filter(Boolean).join(', ') || null,
    r.business_postal_code,
  ].filter(Boolean);
  return parts.join(', ');
}

function formatInspectionDate(iso) {
  if (iso == null || iso === '') return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString();
}

/** API uses values like "High Risk"; show as High / Moderate / Low. */
function formatRiskCategoryLabel(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().toLowerCase();
  if (s.startsWith('high')) return 'High';
  if (s.startsWith('moderate')) return 'Moderate';
  if (s.startsWith('low')) return 'Low';
  return String(raw).trim();
}

function riskCategoryClassName(label) {
  if (label === 'High') return 'violation-risk violation-risk--high';
  if (label === 'Moderate') return 'violation-risk violation-risk--moderate';
  if (label === 'Low') return 'violation-risk violation-risk--low';
  return 'violation-risk violation-risk--other';
}

/** Matches map dot colors: green 90+, yellow 70–89, red below 70, gray no score. */
function scoreClassName(score) {
  if (score == null || score === '') return 'popup-score popup-score--na';
  const n = Number(score);
  if (!Number.isFinite(n)) return 'popup-score popup-score--na';
  if (n >= 90) return 'popup-score popup-score--good';
  if (n >= 70) return 'popup-score popup-score--mid';
  return 'popup-score popup-score--bad';
}

function tooltipScoreClassName(score) {
  if (score == null || score === '') return 'map-dot-tooltip-score map-dot-tooltip-score--na';
  const n = Number(score);
  if (!Number.isFinite(n)) return 'map-dot-tooltip-score map-dot-tooltip-score--na';
  if (n >= 90) return 'map-dot-tooltip-score map-dot-tooltip-score--good';
  if (n >= 70) return 'map-dot-tooltip-score map-dot-tooltip-score--mid';
  return 'map-dot-tooltip-score map-dot-tooltip-score--bad';
}

function App() {
  const mapRef = useRef(null);
  const hoveredBusinessIdRef = useRef(null);
  const [restaurants, setRestaurants] = useState([]);
  const [mapLoadError, setMapLoadError] = useState(null);
  const [searchNotice, setSearchNotice] = useState(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const [popup, setPopup] = useState(null);
  const [hoverTooltip, setHoverTooltip] = useState(null);

  const clearDotHover = useCallback((map) => {
    const prev = hoveredBusinessIdRef.current;
    if (prev != null && map?.getSource?.('restaurants')) {
      try {
        map.setFeatureState({ source: 'restaurants', id: prev }, { hover: false });
      } catch {
        /* source may not be ready */
      }
    }
    hoveredBusinessIdRef.current = null;
    if (map) map.getCanvas().style.cursor = '';
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery.trim()), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  useEffect(() => {
    let cancelled = false;
    axios
      .get(MAP_POINTS_URL)
      .then((res) => {
        if (cancelled) return;
        const data = Array.isArray(res.data)
          ? res.data
          : res.data.results || res.data.restaurants || res.data.data || [];
        setRestaurants(data);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Failed to load restaurants:', err);
        setMapLoadError(err.message || 'Failed to load restaurants');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!debouncedSearch) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }
    let cancelled = false;
    setSearchLoading(true);
    axios
      .get(`${API_BASE}/api/restaurants`, {
        params: { search: debouncedSearch, limit: 10 },
      })
      .then((res) => {
        if (cancelled) return;
        const rows = res.data.results || [];
        setSearchResults(rows);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Search failed:', err);
        setSearchResults([]);
      })
      .finally(() => {
        if (!cancelled) setSearchLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedSearch]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setSearchOpen(false);
        setPopup(null);
        setHoverTooltip(null);
        const map = mapRef.current?.getMap();
        clearDotHover(map);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clearDotHover]);

  const geojson = useMemo(() => {
    return {
      type: 'FeatureCollection',
      features: restaurants
        .map((r) => {
          const lon = Number(
            r.longitude ?? r.business_longitude ?? r.lon ?? r.lng
          );
          const lat = Number(r.latitude ?? r.business_latitude ?? r.lat);
          if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
          const rawScore =
            r.score ?? r.latest_inspection_score ?? r.inspection_score ?? null;
          const score =
            rawScore === null || rawScore === undefined || rawScore === ''
              ? null
              : Number(rawScore);
          return {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: {
              ...r,
              score: Number.isFinite(score) ? score : null,
            },
          };
        })
        .filter(Boolean),
    };
  }, [restaurants]);

  const loadPopupFromInspectionsEndpoint = async (
    businessId,
    lon,
    lat,
    fallback
  ) => {
    const map = mapRef.current?.getMap();
    clearDotHover(map);
    setHoverTooltip(null);
    setPopup({
      lng: lon,
      lat,
      loading: true,
      name: fallback?.business_name || 'Restaurant',
      address: fallback ? formatAddress(fallback) : '',
      score: null,
      date: null,
      violations: [],
    });
    try {
      const { data } = await axios.get(
        `${API_BASE}/api/restaurants/${encodeURIComponent(businessId)}/inspections`
      );
      const latest = data.latest_inspection;
      setPopup({
        lng: lon,
        lat,
        loading: false,
        name: data.business_name,
        address: formatAddress(data),
        score: latest?.inspection_score ?? null,
        date: latest?.inspection_date ?? null,
        violations: latest?.violations ?? [],
        fetchError: false,
      });
    } catch (err) {
      console.error(err);
      setPopup({
        lng: lon,
        lat,
        loading: false,
        name: fallback?.business_name || 'Restaurant',
        address: fallback ? formatAddress(fallback) : '',
        score:
          fallback?.latest_inspection_score ??
          fallback?.score ??
          null,
        date: fallback?.latest_inspection_date ?? null,
        violations: [],
        fetchError: true,
      });
    }
  };

  const handleMapMouseMove = useCallback(
    (event) => {
      const map = event.target;
      if (!map?.getSource?.('restaurants')) return;

      if (popup) {
        clearDotHover(map);
        setHoverTooltip(null);
        return;
      }

      const features = map.queryRenderedFeatures(event.point, {
        layers: [RESTAURANTS_LAYER_ID],
      });

      if (!features.length) {
        clearDotHover(map);
        setHoverTooltip(null);
        return;
      }

      const f = features[0];
      const id = f.properties?.business_id;
      if (id == null) {
        clearDotHover(map);
        setHoverTooltip(null);
        return;
      }

      if (id !== hoveredBusinessIdRef.current) {
        clearDotHover(map);
        hoveredBusinessIdRef.current = id;
        try {
          map.setFeatureState({ source: 'restaurants', id }, { hover: true });
        } catch {
          hoveredBusinessIdRef.current = null;
        }
      }

      map.getCanvas().style.cursor = 'pointer';

      const name = f.properties?.business_name ?? 'Restaurant';
      const score = f.properties?.score;
      const scoreLabel =
        score != null && score !== '' ? String(score) : 'No score';
      setHoverTooltip({
        x: event.point.x,
        y: event.point.y,
        name,
        score,
        scoreLabel,
      });
    },
    [popup, clearDotHover]
  );

  const handleMapMouseLeave = useCallback(
    (event) => {
      const map = event.target;
      clearDotHover(map);
      setHoverTooltip(null);
    },
    [clearDotHover]
  );

  const handleMapClick = async (event) => {
    setHoverTooltip(null);
    const feature = event.features?.[0];
    if (!feature) {
      clearDotHover(mapRef.current?.getMap());
      setPopup(null);
      return;
    }
    const p = feature.properties;
    const id = p.business_id;
    if (!id) return;
    const [lon, lat] = feature.geometry.coordinates;
    mapRef.current?.flyTo({
      center: [lon, lat],
      zoom: 16,
      duration: 1600,
      essential: true,
    });
    await loadPopupFromInspectionsEndpoint(id, lon, lat, p);
  };

  const handleSelectSearchResult = async (r) => {
    setSearchNotice(null);
    setSearchQuery(r.business_name || '');
    setSearchOpen(false);
    setSearchResults([]);

    const lon = Number(r.business_longitude ?? r.lon ?? r.lng);
    const lat = Number(r.business_latitude ?? r.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      setSearchNotice('This listing has no coordinates on the map.');
      return;
    }

    mapRef.current?.flyTo({
      center: [lon, lat],
      zoom: 16,
      duration: 1600,
      essential: true,
    });

    await loadPopupFromInspectionsEndpoint(r.business_id, lon, lat, r);
  };

  if (!MAPBOX_TOKEN) {
    return (
      <div style={{ padding: 16 }}>
        Missing <code>VITE_MAPBOX_TOKEN</code>. Set it in{' '}
        <code>frontend/.env</code>.
      </div>
    );
  }

  const showDropdown = searchOpen && Boolean(debouncedSearch);

  return (
    <div className="app-root">
      <div className="map-surface">
        <Map
          ref={mapRef}
          initialViewState={SF_CENTER}
          mapStyle="mapbox://styles/mapbox/streets-v12"
          mapboxAccessToken={MAPBOX_TOKEN}
          interactiveLayerIds={[RESTAURANTS_LAYER_ID]}
          onClick={handleMapClick}
          onMouseMove={handleMapMouseMove}
          onMouseLeave={handleMapMouseLeave}
        >
          <Source
            id="restaurants"
            type="geojson"
            data={geojson}
            promoteId="business_id"
          >
            <Layer {...layerStyle} />
          </Source>
          {popup && (
            <Popup
              longitude={popup.lng}
              latitude={popup.lat}
              anchor="bottom"
              onClose={() => setPopup(null)}
              closeButton
              closeOnClick={false}
              maxWidth="min(360px, calc(100vw - 48px))"
              className="restaurant-popup restaurant-popup--detail"
            >
              <div className="popup-inner">
                <p className="popup-kicker">Inspection details</p>
                <h2 className="popup-title">{popup.name}</h2>
                {popup.loading ? (
                  <p className="popup-loading">Loading inspection data…</p>
                ) : (
                  <>
                    <p className="popup-address">{popup.address || '—'}</p>
                    <dl className="popup-meta">
                      <div>
                        <dt>Latest score</dt>
                        <dd>
                          <span className={scoreClassName(popup.score)}>
                            {popup.score != null && popup.score !== ''
                              ? popup.score
                              : '—'}
                          </span>
                        </dd>
                      </div>
                      <div>
                        <dt>Inspection date</dt>
                        <dd>{formatInspectionDate(popup.date)}</dd>
                      </div>
                    </dl>
                    {popup.fetchError && (
                      <p className="popup-note">
                        Could not load inspection data from the server.
                      </p>
                    )}
                    <div className="popup-violations">
                      <h3>Violations (latest inspection)</h3>
                      {popup.violations.length === 0 ? (
                        <p className="popup-empty">No violations recorded.</p>
                      ) : (
                        <ul className="popup-violations-list">
                          {popup.violations.map((v) => {
                            const riskLabel = formatRiskCategoryLabel(
                              v.risk_category
                            );
                            return (
                              <li key={v.violation_id}>
                                <span className="violation-desc">
                                  {v.violation_description}
                                </span>
                                {riskLabel && (
                                  <span
                                    className={riskCategoryClassName(riskLabel)}
                                  >
                                    {riskLabel}
                                  </span>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  </>
                )}
              </div>
            </Popup>
          )}
        </Map>
        {hoverTooltip && !popup && (
          <div
            className="map-dot-tooltip"
            style={{
              left: hoverTooltip.x,
              top: hoverTooltip.y,
            }}
            role="tooltip"
          >
            <div className="map-dot-tooltip-name">{hoverTooltip.name}</div>
            <div className={tooltipScoreClassName(hoverTooltip.score)}>
              {hoverTooltip.scoreLabel === 'No score'
                ? 'No score'
                : `Score ${hoverTooltip.scoreLabel}`}
            </div>
          </div>
        )}
      </div>

      <div className="search-panel">
        <input
          type="search"
          className="search-input"
          placeholder="Search restaurants by name…"
          value={searchQuery}
          autoComplete="off"
          aria-label="Search restaurants"
          aria-expanded={showDropdown}
          aria-controls="search-results-list"
          onChange={(e) => {
            setSearchQuery(e.target.value);
            setSearchOpen(true);
          }}
          onFocus={() => setSearchOpen(true)}
          onBlur={() => {
            window.setTimeout(() => setSearchOpen(false), 180);
          }}
        />
        {showDropdown && (
          <ul
            id="search-results-list"
            className="search-dropdown"
            role="listbox"
            onMouseDown={(e) => e.preventDefault()}
          >
            {searchLoading && (
              <li className="search-dropdown-status">Searching…</li>
            )}
            {!searchLoading && searchResults.length === 0 && (
              <li className="search-dropdown-status">No matches</li>
            )}
            {!searchLoading &&
              searchResults.map((r) => (
                <li key={r.business_id}>
                  <button
                    type="button"
                    className="search-result-btn"
                    role="option"
                    onClick={() => handleSelectSearchResult(r)}
                  >
                    <span className="search-result-name">
                      {r.business_name}
                    </span>
                    <span className="search-result-address">
                      {formatAddress(r)}
                    </span>
                    <span className="search-result-score">
                      Score:{' '}
                      {r.latest_inspection_score != null &&
                      r.latest_inspection_score !== ''
                        ? r.latest_inspection_score
                        : '—'}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        )}
      </div>

      <div className="app-messages" aria-live="polite">
        {mapLoadError && (
          <div className="app-error" role="alert">
            {mapLoadError}
          </div>
        )}
        {searchNotice && (
          <div className="app-notice" role="status">
            {searchNotice}
          </div>
        )}
      </div>

      <div className="map-legend">
        <div className="map-legend-title">
          Inspection score ({restaurants.length})
        </div>
        <LegendItem color="#22c55e" label="90+" />
        <LegendItem color="#eab308" label="70–89" />
        <LegendItem color="#ef4444" label="Below 70" />
        <LegendItem color="#9ca3af" label="No score" />
      </div>
    </div>
  );
}

function LegendItem({ color, label }) {
  return (
    <div className="legend-item">
      <span
        className="legend-swatch"
        style={{ background: color }}
        aria-hidden
      />
      <span>{label}</span>
    </div>
  );
}

export default App;
