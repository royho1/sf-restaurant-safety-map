import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Map, { Marker, Popup, Source, Layer } from 'react-map-gl';
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

const MAP_STYLE_LIGHT = 'mapbox://styles/mapbox/streets-v12';
const MAP_STYLE_DARK = 'mapbox://styles/mapbox/navigation-night-v1';

const RESTAURANTS_LAYER_ID = 'restaurants-layer';
const RESTAURANTS_HEATMAP_LAYER_ID = 'restaurants-heatmap-layer';
const RESTAURANTS_HIT_LAYER_ID = 'restaurants-hit-layer';

/** Lower inspection score ⇒ higher heatmap weight (numeric stops for interpolate). */
const heatmapWeightExpression = [
  'case',
  ['any', ['==', ['get', 'score'], null], ['!', ['has', 'score']]],
  0.05,
  [
    'interpolate',
    ['linear'],
    ['to-number', ['get', 'score'], 85],
    100,
    0.02,
    90,
    0.12,
    70,
    0.45,
    50,
    0.72,
    0,
    1,
  ],
];

const restaurantsHeatmapPaint = {
  'heatmap-weight': heatmapWeightExpression,
  'heatmap-intensity': [
    'interpolate',
    ['linear'],
    ['zoom'],
    10,
    1,
    12,
    1.6,
    14,
    2.1,
    16,
    2.6,
    18,
    3,
    20,
    3,
  ],
  'heatmap-radius': [
    'interpolate',
    ['linear'],
    ['zoom'],
    10,
    15,
    13,
    22,
    16,
    28,
    18,
    34,
    22,
    40,
  ],
  'heatmap-opacity': 0.7,
  'heatmap-color': [
    'interpolate',
    ['linear'],
    ['heatmap-density'],
    0,
    'rgba(33,102,172,0)',
    0.2,
    'rgba(147,197,253,0.45)',
    0.45,
    'rgba(251,191,36,0.65)',
    0.7,
    'rgba(249,115,22,0.82)',
    1,
    'rgba(220,38,38,0.95)',
  ],
};

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

const DOT_RADIUS_DESKTOP = 5;
const DOT_RADIUS_MOBILE = 7;

const defaultMapFilters = {
  good: true,
  mid: true,
  bad: true,
  noScore: true,
};

/** Mapbox filter: visible restaurants by latest score category. */
function buildScoreCategoryFilter({ good, mid, bad, noScore }) {
  const parts = [];
  if (good) parts.push(['>=', ['get', 'score'], 90]);
  if (mid) {
    parts.push(['all', ['>=', ['get', 'score'], 70], ['<', ['get', 'score'], 90]]);
  }
  if (bad) {
    parts.push([
      'all',
      ['<', ['get', 'score'], 70],
      ['!', ['==', ['get', 'score'], null]],
    ]);
  }
  if (noScore) parts.push(['==', ['get', 'score'], null]);
  if (parts.length === 0) return ['==', 1, 0];
  if (parts.length === 1) return parts[0];
  return ['any', ...parts];
}

/** Pins / Heatmap / Off — IDs must match imperative addLayer / setLayoutProperty. */
function applyRestaurantOverlayLayoutVisibility(map, mode) {
  if (!map) return;
  const pinsVis = mode === 'pins' ? 'visible' : 'none';
  const heatVis = mode === 'heatmap' ? 'visible' : 'none';
  if (map.getLayer(RESTAURANTS_LAYER_ID)) {
    map.setLayoutProperty(RESTAURANTS_LAYER_ID, 'visibility', pinsVis);
  }
  if (map.getLayer(RESTAURANTS_HIT_LAYER_ID)) {
    map.setLayoutProperty(RESTAURANTS_HIT_LAYER_ID, 'visibility', heatVis);
  }
  if (map.getLayer(RESTAURANTS_HEATMAP_LAYER_ID)) {
    map.setLayoutProperty(
      RESTAURANTS_HEATMAP_LAYER_ID,
      'visibility',
      heatVis
    );
  }
}

/**
 * Inserts `restaurants-heatmap-layer` under the pin layer (z-order: heatmap below pins).
 * Source id must match GeoJSON source `"restaurants"` used by circle layers.
 */
function upsertRestaurantHeatmapLayer(map, scoreFilter, mapMode) {
  if (!map?.isStyleLoaded?.()) return false;
  try {
    if (!map.getSource('restaurants')) return false;
    if (!map.getLayer(RESTAURANTS_LAYER_ID)) return false;

    if (!map.getLayer(RESTAURANTS_HEATMAP_LAYER_ID)) {
      map.addLayer(
        {
          id: RESTAURANTS_HEATMAP_LAYER_ID,
          type: 'heatmap',
          source: 'restaurants',
          layout: { visibility: 'none' },
          paint: restaurantsHeatmapPaint,
          filter: scoreFilter,
        },
        RESTAURANTS_LAYER_ID
      );
    } else {
      map.setFilter(RESTAURANTS_HEATMAP_LAYER_ID, scoreFilter);
      for (const [key, value] of Object.entries(restaurantsHeatmapPaint)) {
        map.setPaintProperty(RESTAURANTS_HEATMAP_LAYER_ID, key, value);
      }
    }
  } catch (err) {
    console.warn('[heatmap] upsertRestaurantHeatmapLayer', err);
    return false;
  }
  applyRestaurantOverlayLayoutVisibility(map, mapMode);
  return true;
}

function computeZipCentroid(rows, zip) {
  let sumLat = 0;
  let sumLon = 0;
  let n = 0;
  for (const r of rows) {
    const z = String(r.business_postal_code ?? '').trim();
    if (z !== zip) continue;
    const lon = Number(
      r.longitude ?? r.business_longitude ?? r.lon ?? r.lng
    );
    const lat = Number(r.latitude ?? r.business_latitude ?? r.lat);
    if (Number.isFinite(lon) && Number.isFinite(lat)) {
      sumLon += lon;
      sumLat += lat;
      n += 1;
    }
  }
  if (n === 0) return null;
  return { lng: sumLon / n, lat: sumLat / n };
}

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

/** Valid San Francisco ZIPs from API data: exactly 5 digits, prefix 941. */
function filterSfZipCodes(rawList) {
  const seen = new Set();
  const out = [];
  for (const raw of rawList || []) {
    const s = String(raw ?? '').trim();
    if (s.length !== 5 || !/^\d{5}$/.test(s) || !s.startsWith('941')) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  out.sort();
  return out;
}

/** Search bar: 5-digit SF ZIP (941xx), same rule as neighborhood list. */
function isSfZipSearchQuery(query) {
  const s = String(query ?? '').trim();
  return s.length === 5 && /^\d{5}$/.test(s) && s.startsWith('941');
}

function App() {
  const mapRef = useRef(null);
  const hoveredBusinessIdRef = useRef(null);
  const [restaurants, setRestaurants] = useState([]);
  const [restaurantsLoading, setRestaurantsLoading] = useState(true);
  const [isMobile, setIsMobile] = useState(false);
  const [userLocation, setUserLocation] = useState(null);
  const [geoToast, setGeoToast] = useState(null);
  const [mapLoadError, setMapLoadError] = useState(null);
  const [searchNotice, setSearchNotice] = useState(null);
  const [basemapDark, setBasemapDark] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const [popup, setPopup] = useState(null);
  const [hoverTooltip, setHoverTooltip] = useState(null);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [citywideStats, setCitywideStats] = useState(null);
  const [statsError, setStatsError] = useState(null);
  const [postalCodes, setPostalCodes] = useState([]);
  const [zipInput, setZipInput] = useState('');
  const [zipMenuOpen, setZipMenuOpen] = useState(false);
  const [selectedPostal, setSelectedPostal] = useState('');
  const [neighborhoodDetail, setNeighborhoodDetail] = useState(null);
  const [neighborhoodLoading, setNeighborhoodLoading] = useState(false);
  const [neighborhoodError, setNeighborhoodError] = useState(null);
  const [mapFilters, setMapFilters] = useState(() => ({ ...defaultMapFilters }));
  const [mapLayerMode, setMapLayerMode] = useState('pins');

  const scoreLayerFilter = useMemo(
    () => buildScoreCategoryFilter(mapFilters),
    [mapFilters]
  );

  const overlayHeatmapRefs = useRef({
    scoreFilter: [],
    layerMode: 'pins',
  });
  overlayHeatmapRefs.current.scoreFilter = scoreLayerFilter;
  overlayHeatmapRefs.current.layerMode = mapLayerMode;

  const sfZipCodes = useMemo(
    () => filterSfZipCodes(postalCodes),
    [postalCodes]
  );

  const filteredSfZips = useMemo(() => {
    if (!zipInput) return sfZipCodes;
    return sfZipCodes.filter((z) => z.startsWith(zipInput));
  }, [sfZipCodes, zipInput]);

  const dotRadiusBase = isMobile ? DOT_RADIUS_MOBILE : DOT_RADIUS_DESKTOP;
  const dotRadiusHover = dotRadiusBase * 1.5;

  const interactiveRestaurantLayerIds = useMemo(() => {
    if (mapLayerMode === 'pins') return [RESTAURANTS_LAYER_ID];
    if (mapLayerMode === 'heatmap') return [RESTAURANTS_HIT_LAYER_ID];
    return [];
  }, [mapLayerMode]);

  const restaurantHitCirclePaint = useMemo(
    () => ({
      'circle-radius': [
        'case',
        ['boolean', ['feature-state', 'hover'], false],
        dotRadiusHover,
        dotRadiusBase,
      ],
      'circle-opacity': 0,
      'circle-stroke-width': 0,
      'circle-stroke-opacity': 0,
    }),
    [dotRadiusBase, dotRadiusHover]
  );

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639px)');
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  useEffect(() => {
    if (!geoToast) return;
    const t = window.setTimeout(() => setGeoToast(null), 4000);
    return () => window.clearTimeout(t);
  }, [geoToast]);

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
    setRestaurantsLoading(true);
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
      })
      .finally(() => {
        if (!cancelled) setRestaurantsLoading(false);
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
    if (isSfZipSearchQuery(debouncedSearch)) {
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
        setZipMenuOpen(false);
        setPopup(null);
        setHoverTooltip(null);
        setSidebarOpen(false);
        const map = mapRef.current?.getMap();
        clearDotHover(map);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clearDotHover]);

  useEffect(() => {
    if (!sidebarOpen) return;
    let cancelled = false;
    setStatsError(null);
    axios
      .get(`${API_BASE}/api/stats`)
      .then((res) => {
        if (!cancelled) setCitywideStats(res.data);
      })
      .catch((err) => {
        if (!cancelled) {
          console.error(err);
          setStatsError(err.message || 'Failed to load stats');
        }
      });
    axios
      .get(`${API_BASE}/api/stats/neighborhoods`)
      .then((res) => {
        if (!cancelled) setPostalCodes(res.data.postal_codes || []);
      })
      .catch((err) => {
        if (!cancelled) console.error(err);
      });
    return () => {
      cancelled = true;
    };
  }, [sidebarOpen]);

  useEffect(() => {
    if (!sidebarOpen) {
      setZipInput('');
      setSelectedPostal('');
      setZipMenuOpen(false);
    }
  }, [sidebarOpen]);

  useEffect(() => {
    if (!sidebarOpen || !selectedPostal) {
      setNeighborhoodDetail(null);
      setNeighborhoodError(null);
      return;
    }
    let cancelled = false;
    setNeighborhoodLoading(true);
    setNeighborhoodError(null);
    axios
      .get(`${API_BASE}/api/stats/neighborhoods`, {
        params: { postal_code: selectedPostal },
      })
      .then((res) => {
        if (!cancelled) setNeighborhoodDetail(res.data);
      })
      .catch((err) => {
        if (!cancelled) {
          setNeighborhoodDetail(null);
          setNeighborhoodError(
            err.response?.data?.error || err.message || 'Request failed'
          );
        }
      })
      .finally(() => {
        if (!cancelled) setNeighborhoodLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sidebarOpen, selectedPostal]);

  const searchZipHighlight = useMemo(() => {
    return isSfZipSearchQuery(searchQuery) ? searchQuery.trim() : '';
  }, [searchQuery]);

  const zipForMapPaint = searchZipHighlight || selectedPostal;

  const searchZipRestaurantCount = useMemo(() => {
    if (!searchZipHighlight) return 0;
    return restaurants.filter(
      (r) => String(r.business_postal_code ?? '').trim() === searchZipHighlight
    ).length;
  }, [searchZipHighlight, restaurants]);

  useEffect(() => {
    if (!searchZipHighlight) return;
    const c = computeZipCentroid(restaurants, searchZipHighlight);
    if (!c) return;

    const fly = () => {
      mapRef.current?.flyTo({
        center: [c.lng, c.lat],
        zoom: 14,
        duration: 1200,
        essential: true,
      });
    };

    fly();
    const retryId = window.setTimeout(fly, 0);

    return () => {
      window.clearTimeout(retryId);
    };
  }, [searchZipHighlight, restaurants]);

  useEffect(() => {
    if (!selectedPostal || !neighborhoodDetail) return;
    if (neighborhoodDetail.postal_code !== selectedPostal) return;
    if (searchZipHighlight) return;
    const map = mapRef.current?.getMap?.();
    if (!map) return;
    const c = computeZipCentroid(restaurants, selectedPostal);
    if (!c) return;
    map.flyTo({
      center: [c.lng, c.lat],
      zoom: 14,
      duration: 1400,
      essential: true,
    });
  }, [selectedPostal, neighborhoodDetail, restaurants, searchZipHighlight]);

  useEffect(() => {
    const map = mapRef.current?.getMap();
    clearDotHover(map);
    setHoverTooltip(null);
  }, [mapFilters, mapLayerMode, clearDotHover]);

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
          const postal_code = String(r.business_postal_code ?? '').trim();
          return {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: {
              ...r,
              score: Number.isFinite(score) ? score : null,
              postal_code,
            },
          };
        })
        .filter(Boolean),
    };
  }, [restaurants]);

  const restaurantsCirclePaint = useMemo(() => {
    const radiusExpr = [
      'case',
      ['boolean', ['feature-state', 'hover'], false],
      dotRadiusHover,
      dotRadiusBase,
    ];
    if (!zipForMapPaint) {
      return {
        'circle-radius': radiusExpr,
        'circle-color': circleColorExpression,
        'circle-stroke-width': [
          'case',
          ['boolean', ['feature-state', 'hover'], false],
          2,
          1.5,
        ],
        'circle-stroke-color': '#ffffff',
        'circle-opacity': 0.9,
      };
    }
    const inZip = ['==', ['get', 'postal_code'], zipForMapPaint];
    return {
      'circle-radius': radiusExpr,
      'circle-color': circleColorExpression,
      'circle-opacity': ['case', inZip, 0.92, 0.3],
      'circle-stroke-width': [
        'case',
        ['boolean', ['feature-state', 'hover'], false],
        ['case', inZip, 4, 2],
        ['case', inZip, 3, 1.5],
      ],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-opacity': ['case', inZip, 1, 0.35],
    };
  }, [zipForMapPaint, dotRadiusBase, dotRadiusHover]);

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

      const hoverLayerId =
        mapLayerMode === 'pins'
          ? RESTAURANTS_LAYER_ID
          : mapLayerMode === 'heatmap'
            ? RESTAURANTS_HIT_LAYER_ID
            : null;

      if (hoverLayerId === null) {
        clearDotHover(map);
        setHoverTooltip(null);
        return;
      }

      if (popup) {
        clearDotHover(map);
        setHoverTooltip(null);
        return;
      }

      const features = map.queryRenderedFeatures(event.point, {
        layers: [hoverLayerId],
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
    [popup, clearDotHover, mapLayerMode]
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

  const showDropdown =
    searchOpen &&
    Boolean(debouncedSearch) &&
    !isSfZipSearchQuery(searchQuery.trim()) &&
    !isSfZipSearchQuery(debouncedSearch);

  const dist = citywideStats?.restaurant_score_distribution;
  const distMax = dist
    ? Math.max(
        dist['90_plus'],
        dist['70_to_89'],
        dist.below_70,
        dist.no_score,
        1
      )
    : 1;

  const toggleSidebar = () => setSidebarOpen((o) => !o);

  const setFilter = (key, checked) => {
    setMapFilters((prev) => ({ ...prev, [key]: checked }));
  };

  const pickNeighborhoodZip = useCallback((z) => {
    setZipInput(z);
    setSelectedPostal(z);
    setZipMenuOpen(false);
  }, []);

  const handleZipInputChange = useCallback((e) => {
    const digits = e.target.value.replace(/\D/g, '').slice(0, 5);
    setZipInput(digits);
    setZipMenuOpen(true);
    setSelectedPostal((prev) => (digits === prev ? prev : ''));
  }, []);

  const handleZipInputBlur = useCallback(
    (e) => {
      window.setTimeout(() => {
        setZipMenuOpen(false);
        const d = e.target.value.replace(/\D/g, '').slice(0, 5);
        if (d.length === 5 && sfZipCodes.includes(d)) {
          setZipInput(d);
          setSelectedPostal(d);
        }
      }, 180);
    },
    [sfZipCodes]
  );

  const handleNearMe = useCallback(() => {
    if (!navigator.geolocation) {
      setGeoToast('Geolocation is not supported in this browser');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { longitude, latitude } = pos.coords;
        setUserLocation({ lng: longitude, lat: latitude });
        mapRef.current?.flyTo({
          center: [longitude, latitude],
          zoom: 14,
          duration: 1200,
          essential: true,
        });
      },
      () => {
        setGeoToast('Location access denied');
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
    );
  }, []);

  const mapStyleUrl = basemapDark ? MAP_STYLE_DARK : MAP_STYLE_LIGHT;

  /** Fires once the Mapbox Map is ready — ensures map.addLayer(heatmap) actually runs after style load. */
  const handleMapLoad = useCallback(
    (event) => {
      upsertRestaurantHeatmapLayer(event.target, scoreLayerFilter, mapLayerMode);
    },
    [scoreLayerFilter, mapLayerMode]
  );

  /**
   * Keeps heatmap paint/filter/layout in sync (and re-adds the layer after setStyle erases it).
   */
  useEffect(() => {
    const map = mapRef.current?.getMap();
    upsertRestaurantHeatmapLayer(map, scoreLayerFilter, mapLayerMode);
  }, [
    geojson,
    mapStyleUrl,
    scoreLayerFilter,
    mapLayerMode,
    restaurants.length,
  ]);

  return (
    <div
      className={`app-root ${basemapDark ? 'app-root--map-dark' : 'app-root--map-light'}`}
    >
      <div className="map-surface">
        <Map
          ref={mapRef}
          initialViewState={SF_CENTER}
          mapStyle={mapStyleUrl}
          mapboxAccessToken={MAPBOX_TOKEN}
          interactiveLayerIds={interactiveRestaurantLayerIds}
          onLoad={handleMapLoad}
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
            <Layer
              id={RESTAURANTS_LAYER_ID}
              type="circle"
              paint={restaurantsCirclePaint}
              filter={scoreLayerFilter}
            />
            <Layer
              id={RESTAURANTS_HIT_LAYER_ID}
              type="circle"
              paint={restaurantHitCirclePaint}
              filter={scoreLayerFilter}
            />
          </Source>
          {userLocation && (
            <Marker
              longitude={userLocation.lng}
              latitude={userLocation.lat}
              anchor="center"
            >
              <div className="user-location-marker" title="Your location">
                <span className="user-location-pulse" aria-hidden />
                <span className="user-location-dot" aria-hidden />
              </div>
            </Marker>
          )}
          {popup && (
            <Popup
              longitude={popup.lng}
              latitude={popup.lat}
              anchor="bottom"
              onClose={() => setPopup(null)}
              closeButton
              closeOnClick={false}
              maxWidth="min(360px, calc(100vw - 48px))"
              className={`restaurant-popup restaurant-popup--detail${basemapDark ? ' restaurant-popup--dark' : ''}`}
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
        {restaurantsLoading && !mapLoadError && (
          <div className="map-loading-overlay" role="status" aria-live="polite">
            <div className="map-loading-inner">
              <div className="map-loading-spinner" aria-hidden />
              <p className="map-loading-text">Loading restaurants…</p>
            </div>
          </div>
        )}
        <div
          className="map-layer-mode"
          role="radiogroup"
          aria-label="Restaurant overlay"
        >
          {[
            { mode: 'pins', label: 'Pins' },
            { mode: 'heatmap', label: 'Heatmap' },
            { mode: 'off', label: 'Off' },
          ].map(({ mode, label }) => (
            <button
              key={mode}
              type="button"
              role="radio"
              className="map-layer-mode__btn"
              aria-checked={mapLayerMode === mode}
              aria-label={label}
              onClick={() => setMapLayerMode(mode)}
              title={label}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="near-me-btn"
          onClick={handleNearMe}
          aria-label="Near me: center map on your location"
          title="Near me"
        >
          <svg
            className="near-me-icon"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
          </svg>
          <span className="near-me-label">Near Me</span>
        </button>
      </div>

      <button
        type="button"
        className="map-theme-toggle"
        onClick={() => setBasemapDark((d) => !d)}
        aria-label={basemapDark ? 'Use streets map' : 'Use dark map'}
        title={basemapDark ? 'Streets map' : 'Dark map'}
      >
        {basemapDark ? (
          <svg
            className="map-theme-icon"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden
          >
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 6.34l1.41 1.41M16.24 16.24l1.41 1.41" />
          </svg>
        ) : (
          <svg
            className="map-theme-icon"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        )}
      </button>

      <button
        type="button"
        className="sidebar-menu-btn"
        onClick={toggleSidebar}
        aria-expanded={sidebarOpen}
        aria-controls="map-sidebar-panel"
        aria-label={sidebarOpen ? 'Close insights panel' : 'Open insights panel'}
      >
        {sidebarOpen ? (
          <span className="sidebar-menu-icon sidebar-menu-icon--close" aria-hidden>
            ×
          </span>
        ) : (
          <span className="sidebar-menu-icon" aria-hidden>
            <span />
            <span />
            <span />
          </span>
        )}
      </button>

      <div
        className={`sidebar-backdrop ${sidebarOpen ? 'is-visible' : ''}`}
        onClick={() => setSidebarOpen(false)}
        aria-hidden={!sidebarOpen}
      />

      <aside
        id="map-sidebar-panel"
        className={`sidebar-panel ${sidebarOpen ? 'is-open' : ''}`}
        aria-hidden={!sidebarOpen}
      >
        <div className="sidebar-panel-header">
          <h2 className="sidebar-panel-title">Insights</h2>
          <button
            type="button"
            className="sidebar-panel-close"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close panel"
          >
            ×
          </button>
        </div>
        <div className="sidebar-panel-body">
          <section className="sidebar-section">
            <h3 className="sidebar-section-title">Citywide overview</h3>
            {statsError && (
              <p className="sidebar-muted sidebar-error">{statsError}</p>
            )}
            {!citywideStats && !statsError && (
              <p className="sidebar-muted">Loading…</p>
            )}
            {citywideStats && (
              <>
                <p className="sidebar-stat-line">
                  <strong>{citywideStats.total_restaurants?.toLocaleString()}</strong>{' '}
                  restaurants
                </p>
                <p className="sidebar-stat-line">
                  Avg latest score:{' '}
                  <strong>
                    {citywideStats.avg_latest_inspection_score != null
                      ? citywideStats.avg_latest_inspection_score
                      : '—'}
                  </strong>
                </p>
                <p className="sidebar-chart-label">Score distribution</p>
                <div className="sidebar-bars" role="img" aria-label="Score distribution">
                  {[
                    { key: '90_plus', label: '90+', color: '#22c55e' },
                    { key: '70_to_89', label: '70–89', color: '#eab308' },
                    { key: 'below_70', label: '<70', color: '#ef4444' },
                    { key: 'no_score', label: 'No score', color: '#9ca3af' },
                  ].map(({ key, label, color }) => {
                    const n = dist?.[key] ?? 0;
                    const pct = Math.round((n / distMax) * 100);
                    return (
                      <div key={key} className="sidebar-bar-row">
                        <span className="sidebar-bar-label">{label}</span>
                        <div className="sidebar-bar-track">
                          <div
                            className="sidebar-bar-fill"
                            style={{
                              width: `${pct}%`,
                              background: color,
                            }}
                          />
                        </div>
                        <span className="sidebar-bar-count">{n}</span>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </section>

          <section className="sidebar-section">
            <h3 className="sidebar-section-title">Neighborhood breakdown</h3>
            <div className="sidebar-zip-wrap">
              <label className="sidebar-select-label" htmlFor="zip-input">
                ZIP code
              </label>
              <input
                id="zip-input"
                type="text"
                inputMode="numeric"
                autoComplete="postal-code"
                placeholder="Search 941xx…"
                className="sidebar-zip-input"
                value={zipInput}
                aria-expanded={zipMenuOpen}
                aria-controls="zip-suggestions"
                aria-autocomplete="list"
                role="combobox"
                onChange={handleZipInputChange}
                onFocus={() => setZipMenuOpen(true)}
                onBlur={handleZipInputBlur}
              />
              {zipMenuOpen && (
                <ul
                  id="zip-suggestions"
                  className="sidebar-zip-dropdown"
                  role="listbox"
                  onMouseDown={(e) => e.preventDefault()}
                >
                  {filteredSfZips.length === 0 ? (
                    <li className="sidebar-zip-dropdown-status">
                      {sfZipCodes.length === 0
                        ? 'No valid 941xx ZIPs in data'
                        : !zipInput
                          ? 'Start typing to filter…'
                          : 'No matching ZIP'}
                    </li>
                  ) : (
                    filteredSfZips.map((z) => (
                      <li key={z} role="presentation">
                        <button
                          type="button"
                          className="sidebar-zip-option"
                          role="option"
                          aria-selected={selectedPostal === z}
                          onClick={() => pickNeighborhoodZip(z)}
                        >
                          {z}
                        </button>
                      </li>
                    ))
                  )}
                </ul>
              )}
            </div>
            {neighborhoodLoading && (
              <p className="sidebar-muted">Loading neighborhood…</p>
            )}
            {neighborhoodError && (
              <p className="sidebar-muted sidebar-error">{neighborhoodError}</p>
            )}
            {neighborhoodDetail && !neighborhoodLoading && (
              <div className="sidebar-neighborhood-detail">
                <p className="sidebar-stat-line">
                  <strong>
                    {neighborhoodDetail.restaurant_count?.toLocaleString()}
                  </strong>{' '}
                  restaurants
                </p>
                <p className="sidebar-stat-line">
                  Avg latest score:{' '}
                  <strong>
                    {neighborhoodDetail.avg_latest_inspection_score != null
                      ? neighborhoodDetail.avg_latest_inspection_score
                      : '—'}
                  </strong>
                </p>
                <p className="sidebar-subheading">Highest scores</p>
                {(neighborhoodDetail.top_restaurants || []).length === 0 ? (
                  <p className="sidebar-muted">No scored restaurants in this ZIP.</p>
                ) : (
                  <ol className="sidebar-rank-list">
                    {neighborhoodDetail.top_restaurants.map((r) => (
                      <li key={r.business_id}>
                        <span className="sidebar-rank-name">{r.business_name}</span>
                        <span className="sidebar-rank-score">{r.latest_inspection_score}</span>
                      </li>
                    ))}
                  </ol>
                )}
                <p className="sidebar-subheading">Lowest scores</p>
                {(neighborhoodDetail.bottom_restaurants || []).length === 0 ? (
                  <p className="sidebar-muted">No scored restaurants in this ZIP.</p>
                ) : (
                  <ol className="sidebar-rank-list">
                    {neighborhoodDetail.bottom_restaurants.map((r) => (
                      <li key={r.business_id}>
                        <span className="sidebar-rank-name">{r.business_name}</span>
                        <span className="sidebar-rank-score">{r.latest_inspection_score}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            )}
          </section>

          <section className="sidebar-section">
            <div className="sidebar-heading-with-actions">
              <h3 className="sidebar-section-title">Map filters</h3>
              <div
                className="sidebar-pill-group"
                role="group"
                aria-label="Map filter shortcuts"
              >
                <button
                  type="button"
                  className="sidebar-pill-btn"
                  onClick={() => setMapFilters({ ...defaultMapFilters })}
                >
                  Select All
                </button>
                <button
                  type="button"
                  className="sidebar-pill-btn"
                  onClick={() =>
                    setMapFilters({
                      good: false,
                      mid: false,
                      bad: false,
                      noScore: false,
                    })
                  }
                >
                  Select None
                </button>
              </div>
            </div>
            <p className="sidebar-help">
              Show dots by latest inspection score category.
            </p>
            <ul className="sidebar-checklist">
              {[
                { key: 'good', label: '90+ (green)' },
                { key: 'mid', label: '70–89 (yellow)' },
                { key: 'bad', label: 'Below 70 (red)' },
                { key: 'noScore', label: 'No score (gray)' },
              ].map(({ key, label }) => (
                <li key={key}>
                  <label className="sidebar-check-label">
                    <input
                      type="checkbox"
                      checked={mapFilters[key]}
                      onChange={(e) => setFilter(key, e.target.checked)}
                    />
                    {label}
                  </label>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </aside>

      <div className="search-panel">
        <input
          type="search"
          className="search-input"
          placeholder="Search restaurants or ZIP code..."
          value={searchQuery}
          autoComplete="off"
          aria-label="Search restaurants or ZIP code"
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
        {searchZipHighlight && (
          <div className="search-zip-badge" role="status">
            <span className="search-zip-badge-text">
              Showing {searchZipRestaurantCount} restaurant
              {searchZipRestaurantCount === 1 ? '' : 's'} in {searchZipHighlight}
            </span>
            <button
              type="button"
              className="search-zip-badge-clear"
              onClick={() => {
                setSearchQuery('');
                setSearchOpen(false);
              }}
              aria-label="Clear ZIP search"
            >
              ×
            </button>
          </div>
        )}
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
        {geoToast && (
          <div className="app-toast app-toast--neutral" role="status">
            {geoToast}
          </div>
        )}
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
