import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Map, { Marker, Popup, Source, Layer } from 'react-map-gl';
import axios from 'axios';
import 'mapbox-gl/dist/mapbox-gl.css';
import {
  LANDMARK_MIN_ZOOM,
  LandmarkPin,
  SF_LANDMARKS,
  landmarkPinSize,
} from './landmarks';

const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');
const MAP_POINTS_URL = `${API_BASE}/api/restaurants?has_coordinates=true&limit=10000&view=map`;
const META_URL = `${API_BASE}/api/meta`;
const MAP_POLL_MS = 10 * 60 * 1000;
const RESTAURANT_QUERY_PARAM = 'r';

function readRestaurantQuery() {
  if (typeof window === 'undefined') return '';
  return (new URLSearchParams(window.location.search).get(RESTAURANT_QUERY_PARAM) || '').trim();
}

function replaceRestaurantQuery(businessId) {
  if (typeof window === 'undefined' || !window.history?.replaceState) return;
  const url = new URL(window.location.href);
  if (businessId) url.searchParams.set(RESTAURANT_QUERY_PARAM, String(businessId));
  else url.searchParams.delete(RESTAURANT_QUERY_PARAM);
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) window.history.replaceState({}, '', next);
}

function restaurantShareHref(businessId) {
  const url = new URL(window.location.href);
  url.searchParams.set(RESTAURANT_QUERY_PARAM, String(businessId));
  url.hash = '';
  return url.toString();
}

function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => copyTextFallback(text)
    );
  }
  return Promise.resolve(copyTextFallback(text));
}

function copyTextFallback(text) {
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.left = '-9999px';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    el.remove();
    return ok;
  } catch {
    return false;
  }
}

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

/** Closures and conditional passes weigh more so they stand out. */
const heatmapWeightExpression = [
  'match',
  ['coalesce', ['get', 'rating'], ''],
  'Closure',
  1,
  'Conditional Pass',
  0.65,
  'Pass',
  0.18,
  0.08,
];

const restaurantsHeatmapPaint = {
  'heatmap-weight': heatmapWeightExpression,
  'heatmap-intensity': [
    'interpolate',
    ['linear'],
    ['zoom'],
    10,
    0.55,
    12,
    0.95,
    14,
    1.25,
    16,
    1.6,
    18,
    1.9,
  ],
  'heatmap-radius': [
    'interpolate',
    ['linear'],
    ['zoom'],
    10,
    10,
    12,
    16,
    14,
    22,
    16,
    28,
    18,
    34,
  ],
  'heatmap-opacity': 0.8,
  'heatmap-color': [
    'interpolate',
    ['linear'],
    ['heatmap-density'],
    0,
    'rgba(33,102,172,0)',
    0.15,
    'rgba(147,197,253,0.45)',
    0.35,
    'rgba(251,191,36,0.7)',
    0.6,
    'rgba(249,115,22,0.85)',
    1,
    'rgba(220,38,38,0.95)',
  ],
};

const circleColorExpression = [
  'match',
  ['coalesce', ['get', 'rating'], ''],
  'Pass',
  '#22c55e',
  'Conditional Pass',
  '#eab308',
  'Closure',
  '#ef4444',
  '#9ca3af',
];

function circleSortKeyForTarget(stackMode) {
  const order =
    stackMode === 'pass'
      ? ['Pass', 'Conditional Pass', 'Closure']
      : stackMode === 'conditional'
        ? ['Conditional Pass', 'Closure', 'Pass']
        : ['Closure', 'Conditional Pass', 'Pass'];
  return [
    'match',
    ['coalesce', ['get', 'rating'], ''],
    order[0],
    3,
    order[1],
    2,
    order[2],
    1,
    0,
  ];
}

function circleRadiusByRating(base) {
  return [
    'match',
    ['coalesce', ['get', 'rating'], ''],
    'Closure',
    base + 3.25,
    'Conditional Pass',
    base + 1.25,
    'Pass',
    Math.max(3.25, base - 0.5),
    base,
  ];
}

function stackBandLabel(mode) {
  if (mode === 'pass') return 'Passes on top';
  if (mode === 'conditional') return 'Conditional on top';
  return 'Closures on top';
}

function stackLegendHint(mode) {
  if (mode === 'pass') return 'Passes sit on top';
  if (mode === 'conditional') return 'Conditional passes sit on top';
  return 'Closures sit on top';
}

const DOT_RADIUS_DESKTOP = 5;
const DOT_RADIUS_MOBILE = 7;

const SPLASH_MIN_MS = 3200;
const SPLASH_FADE_MS = 1000;
const SPLASH_MAX_MS = 8000;

const defaultMapFilters = {
  pass: true,
  conditional: true,
  closure: true,
  noRating: true,
};

/** Mapbox filter: visible restaurants by latest rating. */
function buildRatingCategoryFilter({ pass, conditional, closure, noRating }) {
  const parts = [];
  if (pass) parts.push(['==', ['get', 'rating'], 'Pass']);
  if (conditional) parts.push(['==', ['get', 'rating'], 'Conditional Pass']);
  if (closure) parts.push(['==', ['get', 'rating'], 'Closure']);
  if (noRating) {
    parts.push([
      'any',
      ['==', ['get', 'rating'], null],
      ['!', ['has', 'rating']],
      ['==', ['get', 'rating'], ''],
    ]);
  }
  if (parts.length === 0) return ['==', 1, 0];
  if (parts.length === 1) return parts[0];
  return ['any', ...parts];
}

function computeNeighborhoodCentroid(rows, neighborhood) {
  let sumLat = 0;
  let sumLon = 0;
  let n = 0;
  for (const r of rows) {
    const z = String(r.analysis_neighborhood ?? '').trim();
    if (z !== neighborhood) continue;
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
    r.analysis_neighborhood,
    [r.business_city, r.business_state].filter(Boolean).join(', ') || null,
  ].filter(Boolean);
  return parts.join(', ');
}

function formatInspectionDate(iso) {
  if (iso == null || iso === '') return '—';
  const raw = String(iso);
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (ymd) {
    const d = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toLocaleDateString();
}

function prefersAppleMaps() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) {
    return true;
  }
  return /Macintosh|Mac OS X/.test(ua) && !/Windows/.test(ua);
}

function nativeMapsHref({ lat, lng, name, address }) {
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
  const label = [name, address].filter(Boolean).join(', ');
  if (!hasCoords && !label) return null;
  const q = encodeURIComponent(label || `${lat},${lng}`);
  if (prefersAppleMaps()) {
    if (hasCoords) {
      return `https://maps.apple.com/?daddr=${lat},${lng}&q=${q}&dirflg=d`;
    }
    return `https://maps.apple.com/?daddr=${q}&dirflg=d`;
  }
  if (hasCoords) {
    return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&destination_place_id=`;
  }
  return `https://www.google.com/maps/dir/?api=1&destination=${q}`;
}

const PINNED_STORAGE_KEY = 'sf-restaurant-safety-pinned';
const MAP_PREFS_STORAGE_KEY = 'sf-restaurant-safety-map-prefs';
const SPLASH_SEEN_KEY = 'sf-restaurant-safety-splash-seen';

function shouldShowSplashOnBoot() {
  if (typeof window === 'undefined') return true;
  if (readRestaurantQuery()) return false;
  try {
    return localStorage.getItem(SPLASH_SEEN_KEY) !== '1';
  } catch {
    return true;
  }
}

function markSplashSeen() {
  try {
    localStorage.setItem(SPLASH_SEEN_KEY, '1');
  } catch {
    /* private mode / quota */
  }
}

function loadPinnedRestaurants() {
  if (typeof localStorage === 'undefined') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(PINNED_STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((row) => row && row.business_id);
  } catch {
    return [];
  }
}

function clampStackMode(value) {
  if (value === 'pass' || value === 'conditional' || value === 'closure') {
    return value;
  }
  const n = Number(value);
  if (Number.isFinite(n)) {
    if (n < 70) return 'closure';
    if (n < 90) return 'conditional';
    return 'pass';
  }
  return 'closure';
}

function normalizeMapFilters(parsed) {
  if (!parsed || typeof parsed !== 'object') return { ...defaultMapFilters };
  if ('pass' in parsed || 'closure' in parsed || 'conditional' in parsed) {
    return {
      pass: parsed.pass !== false,
      conditional: parsed.conditional !== false,
      closure: parsed.closure !== false,
      noRating: parsed.noRating !== false,
    };
  }
  return {
    pass: parsed.good !== false,
    conditional: parsed.mid !== false,
    closure: parsed.bad !== false,
    noRating: parsed.noScore !== false && parsed.noRating !== false,
  };
}

function loadMapPrefs() {
  const defaults = {
    basemapDark: false,
    mapLayerMode: 'pins',
    mapFilters: { ...defaultMapFilters },
    dotStackTarget: 'closure',
    uniformDotSize: false,
  };
  if (typeof localStorage === 'undefined') return defaults;
  try {
    const parsed = JSON.parse(localStorage.getItem(MAP_PREFS_STORAGE_KEY) || 'null');
    if (!parsed || typeof parsed !== 'object') return defaults;
    const mode = parsed.mapLayerMode;
    return {
      basemapDark: parsed.basemapDark === true,
      mapLayerMode:
        mode === 'heatmap' || mode === 'off' || mode === 'pins' ? mode : 'pins',
      mapFilters: normalizeMapFilters(parsed.mapFilters),
      dotStackTarget: clampStackMode(parsed.dotStackTarget),
      uniformDotSize: parsed.uniformDotSize === true,
    };
  } catch {
    return defaults;
  }
}

function toPinnedRestaurant(source, extras = {}) {
  const lat = Number(
    source.lat ?? source.business_latitude ?? source.latitude
  );
  const lng = Number(
    source.lng ?? source.business_longitude ?? source.longitude
  );
  return {
    business_id: source.business_id || source.businessId,
    business_name: source.business_name || source.name || 'Restaurant',
    business_address: source.business_address || source.address || '',
    business_latitude: Number.isFinite(lat) ? lat : null,
    business_longitude: Number.isFinite(lng) ? lng : null,
    analysis_neighborhood: source.analysis_neighborhood || '',
    latest_rating_status:
      source.latest_rating_status ?? source.rating ?? source.score ?? null,
    pinnedAt: Date.now(),
    ...extras,
  };
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

function ratingClassName(rating) {
  const r = normalizeRating(rating);
  if (r === 'Pass') return 'popup-score popup-score--good';
  if (r === 'Conditional Pass') return 'popup-score popup-score--mid';
  if (r === 'Closure') return 'popup-score popup-score--bad';
  return 'popup-score popup-score--na';
}

function tooltipRatingClassName(rating) {
  const r = normalizeRating(rating);
  if (r === 'Pass') return 'map-dot-tooltip-score map-dot-tooltip-score--good';
  if (r === 'Conditional Pass') return 'map-dot-tooltip-score map-dot-tooltip-score--mid';
  if (r === 'Closure') return 'map-dot-tooltip-score map-dot-tooltip-score--bad';
  return 'map-dot-tooltip-score map-dot-tooltip-score--na';
}

function normalizeRating(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower === 'pass') return 'Pass';
  if (lower === 'conditional pass' || lower === 'conditional') return 'Conditional Pass';
  if (lower === 'closure' || lower === 'closed') return 'Closure';
  return s;
}

function restaurantRatingValue(r) {
  return normalizeRating(
    r?.latest_rating_status ?? r?.rating ?? r?.facility_rating_status
  );
}

function restaurantMatchesFilters(r, filters) {
  const rating = restaurantRatingValue(r);
  if (rating == null) return Boolean(filters?.noRating);
  if (rating === 'Pass') return Boolean(filters?.pass);
  if (rating === 'Conditional Pass') return Boolean(filters?.conditional);
  if (rating === 'Closure') return Boolean(filters?.closure);
  return Boolean(filters?.noRating);
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function formatDistanceMiles(mi) {
  if (!Number.isFinite(mi)) return '';
  const feet = mi * 5280;
  if (feet < 800) return `${Math.max(50, Math.round(feet / 50) * 50)} ft`;
  if (mi < 10) return `${mi.toFixed(1)} mi`;
  return `${Math.round(mi)} mi`;
}

function nearestRestaurants(rows, lat, lng, filters, limit = 5) {
  const scored = [];
  for (const r of rows) {
    if (!restaurantMatchesFilters(r, filters)) continue;
    const rLat = Number(r.business_latitude ?? r.latitude ?? r.lat);
    const rLng = Number(r.business_longitude ?? r.longitude ?? r.lon ?? r.lng);
    if (!Number.isFinite(rLat) || !Number.isFinite(rLng)) continue;
    scored.push({ r, miles: haversineMiles(lat, lng, rLat, rLng) });
  }
  scored.sort((a, b) => a.miles - b.miles);
  return scored.slice(0, limit);
}

function filtersAreAllOn(filters) {
  return Boolean(
    filters?.pass && filters?.conditional && filters?.closure && filters?.noRating
  );
}

const LEGEND_FILTER_CHIPS = [
  { key: 'pass', label: 'Pass', color: '#22c55e' },
  { key: 'conditional', label: 'Conditional', color: '#eab308' },
  { key: 'closure', label: 'Closure', color: '#ef4444' },
  { key: 'noRating', label: 'No rating', color: '#9ca3af' },
];

function formatDataThrough(iso) {
  if (iso == null || iso === '') return null;
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (!ymd) return null;
  const d = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function neighborhoodNamesFromList(rawList) {
  const seen = new Set();
  const out = [];
  for (const raw of rawList || []) {
    const s = String(raw ?? '').trim();
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function matchNeighborhoodQuery(query, names) {
  const q = String(query ?? '').trim().toLowerCase();
  if (q.length < 3) return '';
  const exact = names.filter((n) => n.toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  const prefix = names.filter((n) => n.toLowerCase().startsWith(q));
  if (prefix.length === 1) return prefix[0];
  return '';
}

function restaurantsFromResponse(data) {
  if (Array.isArray(data)) return data;
  return data?.results || data?.restaurants || data?.data || [];
}

function searchLoadedRestaurants(rows, query, limit = 10, pinnedIds) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [];
  const scored = [];
  for (const r of rows) {
    const name = String(r.business_name || '').toLowerCase();
    const addr = String(r.business_address || '').toLowerCase();
    const hood = String(r.analysis_neighborhood || '').toLowerCase();
    let rank;
    if (name.startsWith(q)) rank = 0;
    else if (name.includes(q)) rank = 1;
    else if (addr.includes(q)) rank = 2;
    else if (hood.includes(q)) rank = 3;
    else continue;
    const pinned = pinnedIds?.has(String(r.business_id)) ? 0 : 1;
    scored.push({ r, rank, pinned, name });
  }
  scored.sort(
    (a, b) => a.rank - b.rank || a.pinned - b.pinned || a.name.localeCompare(b.name)
  );
  return scored.slice(0, limit).map((row) => row.r);
}

function metaFingerprint(meta) {
  if (!meta || meta.status === 'error') return '';
  return `${meta.db_mtime ?? ''}:${meta.latest_inspection_date ?? ''}:${meta.restaurant_count ?? ''}`;
}

function App() {
  const mapRef = useRef(null);
  const searchInputRef = useRef(null);
  const hoveredBusinessIdRef = useRef(null);
  const hoverTooltipElRef = useRef(null);
  const pendingShareIdRef = useRef(readRestaurantQuery());
  const [restaurants, setRestaurants] = useState([]);
  const [restaurantsLoading, setRestaurantsLoading] = useState(true);
  const [isMobile, setIsMobile] = useState(false);
  const [userLocation, setUserLocation] = useState(null);
  const [geoToast, setGeoToast] = useState(null);
  const [geoLoading, setGeoLoading] = useState(false);
  const [nearbyOpen, setNearbyOpen] = useState(false);
  const [mapLoadError, setMapLoadError] = useState(null);
  const [mapStyleReady, setMapStyleReady] = useState(false);
  const [searchNotice, setSearchNotice] = useState(null);
  const [savedMapPrefs] = useState(loadMapPrefs);
  const [basemapDark, setBasemapDark] = useState(savedMapPrefs.basemapDark);

  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchActiveIndex, setSearchActiveIndex] = useState(-1);

  const [popup, setPopup] = useState(null);
  const [hoverTooltip, setHoverTooltip] = useState(null);
  const [linkCopied, setLinkCopied] = useState(false);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [citywideStats, setCitywideStats] = useState(null);
  const [statsError, setStatsError] = useState(null);
  const [neighborhoodNames, setNeighborhoodNames] = useState([]);
  const [neighborhoodInput, setNeighborhoodInput] = useState('');
  const [neighborhoodMenuOpen, setNeighborhoodMenuOpen] = useState(false);
  const [selectedNeighborhood, setSelectedNeighborhood] = useState('');
  const [neighborhoodDetail, setNeighborhoodDetail] = useState(null);
  const [neighborhoodLoading, setNeighborhoodLoading] = useState(false);
  const [neighborhoodError, setNeighborhoodError] = useState(null);
  const [mapFilters, setMapFilters] = useState(savedMapPrefs.mapFilters);
  const [mapLayerMode, setMapLayerMode] = useState(savedMapPrefs.mapLayerMode);
  const [dotStackTarget, setDotStackTarget] = useState(savedMapPrefs.dotStackTarget);
  const [uniformDotSize, setUniformDotSize] = useState(savedMapPrefs.uniformDotSize);
  const [pinnedRestaurants, setPinnedRestaurants] = useState(loadPinnedRestaurants);
  const [mapZoom, setMapZoom] = useState(SF_CENTER.zoom);
  const [statsEpoch, setStatsEpoch] = useState(0);
  const [dataMeta, setDataMeta] = useState(null);
  const mapDataFingerprint = useRef('');
  const splashStartedAt = useRef(
    typeof performance !== 'undefined' ? performance.now() : 0
  );
  const [splash, setSplash] = useState(() =>
    shouldShowSplashOnBoot()
      ? { show: true, fading: false, sticky: false }
      : { show: false, fading: false, sticky: false }
  );

  const ratingLayerFilter = useMemo(
    () => buildRatingCategoryFilter(mapFilters),
    [mapFilters]
  );

  const knownNeighborhoods = useMemo(() => {
    const fromMap = neighborhoodNamesFromList(
      restaurants.map((r) => r.analysis_neighborhood)
    );
    if (fromMap.length) return fromMap;
    return neighborhoodNamesFromList(neighborhoodNames);
  }, [restaurants, neighborhoodNames]);

  const filteredNeighborhoods = useMemo(() => {
    if (!neighborhoodInput) return knownNeighborhoods;
    const q = neighborhoodInput.trim().toLowerCase();
    return knownNeighborhoods.filter((n) => n.toLowerCase().includes(q));
  }, [knownNeighborhoods, neighborhoodInput]);

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
        'interpolate',
        ['linear'],
        ['zoom'],
        11,
        18,
        14,
        12,
        16,
        Math.max(dotRadiusHover, 10),
      ],
      'circle-opacity': 0,
      'circle-stroke-width': 0,
      'circle-stroke-opacity': 0,
    }),
    [dotRadiusHover]
  );

  const heatmapLayerLayout = useMemo(
    () => ({
      visibility: mapLayerMode === 'heatmap' ? 'visible' : 'none',
    }),
    [mapLayerMode]
  );

  const pinsLayerLayout = useMemo(
    () => ({
      visibility: mapLayerMode === 'pins' ? 'visible' : 'none',
      'circle-sort-key': circleSortKeyForTarget(dotStackTarget),
    }),
    [mapLayerMode, dotStackTarget]
  );

  const hitLayerLayout = useMemo(
    () => ({
      visibility: mapLayerMode === 'heatmap' ? 'visible' : 'none',
    }),
    [mapLayerMode]
  );

  useEffect(() => {
    try {
      localStorage.setItem(
        PINNED_STORAGE_KEY,
        JSON.stringify(pinnedRestaurants)
      );
    } catch {
      /* private mode / quota */
    }
  }, [pinnedRestaurants]);

  useEffect(() => {
    try {
      localStorage.setItem(
        MAP_PREFS_STORAGE_KEY,
        JSON.stringify({
          basemapDark,
          mapLayerMode,
          mapFilters,
          dotStackTarget,
          uniformDotSize,
        })
      );
    } catch {
      /* private mode / quota */
    }
  }, [basemapDark, mapLayerMode, mapFilters, dotStackTarget, uniformDotSize]);

  const pinnedIdSet = useMemo(
    () => new Set(pinnedRestaurants.map((row) => String(row.business_id))),
    [pinnedRestaurants]
  );

  const isPinned = useCallback(
    (id) => (id == null ? false : pinnedIdSet.has(String(id))),
    [pinnedIdSet]
  );

  const togglePinnedRestaurant = useCallback((record) => {
    const id = record?.business_id || record?.businessId;
    if (!id) return;
    setPinnedRestaurants((prev) => {
      const exists = prev.some((row) => String(row.business_id) === String(id));
      if (exists) {
        return prev.filter((row) => String(row.business_id) !== String(id));
      }
      return [toPinnedRestaurant(record), ...prev];
    });
  }, []);

  const handleMapMove = useCallback((evt) => {
    const z = evt.viewState?.zoom;
    if (!Number.isFinite(z)) return;
    setMapZoom((prev) => (Math.abs(prev - z) < 0.1 ? prev : z));
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639px)');
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  useEffect(() => {
    if (splash.show || splash.fading) return;
    markSplashSeen();
  }, [splash.show, splash.fading]);

  useEffect(() => {
    if (!geoToast) return;
    const t = window.setTimeout(() => setGeoToast(null), 4000);
    return () => window.clearTimeout(t);
  }, [geoToast]);

  useEffect(() => {
    if (!searchNotice) return;
    const t = window.setTimeout(() => setSearchNotice(null), 4000);
    return () => window.clearTimeout(t);
  }, [searchNotice]);

  const dismissSplash = useCallback(() => {
    setSplash((s) => {
      if (!s.show || s.fading) return s;
      return { ...s, fading: true };
    });
  }, []);

  const openSplash = useCallback(() => {
    setSplash({ show: true, fading: false, sticky: true });
  }, []);

  useEffect(() => {
    if (!splash.show || splash.fading) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape' || e.key === 'Enter') dismissSplash();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [splash.show, splash.fading, dismissSplash]);

  useEffect(() => {
    if (!splash.show || splash.fading || splash.sticky) return undefined;
    const dataReady = !restaurantsLoading || Boolean(mapLoadError);
    const mapReady = mapStyleReady || Boolean(mapLoadError);
    const elapsed = performance.now() - splashStartedAt.current;
    const minWait = Math.max(0, SPLASH_MIN_MS - elapsed);
    const maxWait = Math.max(0, SPLASH_MAX_MS - elapsed);
    const wait = dataReady && mapReady ? minWait : maxWait;
    const id = window.setTimeout(dismissSplash, wait);
    return () => window.clearTimeout(id);
  }, [
    restaurantsLoading,
    mapLoadError,
    mapStyleReady,
    splash.show,
    splash.fading,
    splash.sticky,
    dismissSplash,
  ]);

  useEffect(() => {
    if (!splash.fading) return;
    const id = window.setTimeout(() => {
      setSplash({ show: false, fading: false, sticky: false });
    }, SPLASH_FADE_MS);
    return () => window.clearTimeout(id);
  }, [splash.fading]);

  useEffect(() => {
    if (!pendingShareIdRef.current) return undefined;
    dismissSplash();
  }, [dismissSplash]);

  useEffect(() => {
    const id = popup?.businessId ? String(popup.businessId) : '';
    if (id) {
      replaceRestaurantQuery(id);
      return;
    }
    if (pendingShareIdRef.current) return;
    replaceRestaurantQuery(null);
  }, [popup?.businessId]);

  useEffect(() => {
    setLinkCopied(false);
  }, [popup?.businessId]);

  useEffect(() => {
    if (!linkCopied) return undefined;
    const t = window.setTimeout(() => setLinkCopied(false), 2000);
    return () => window.clearTimeout(t);
  }, [linkCopied]);

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

  const fetchRestaurants = useCallback(async ({ showLoading } = {}) => {
    if (showLoading) setRestaurantsLoading(true);
    try {
      const res = await axios.get(MAP_POINTS_URL);
      setRestaurants(restaurantsFromResponse(res.data));
      setMapLoadError(null);
    } catch (err) {
      console.error('Failed to load restaurants:', err);
      const networkHint =
        err.code === 'ERR_NETWORK' || err.message === 'Network Error'
          ? 'Could not reach the API. Start the Flask server (`python run.py` in backend/) and confirm VITE_API_BASE if you changed ports.'
          : err.message || 'Failed to load restaurants';
      setMapLoadError(networkHint);
      throw err;
    } finally {
      if (showLoading) setRestaurantsLoading(false);
    }
  }, []);

  const syncFromSource = useCallback(
    async ({ initial } = {}) => {
      try {
        const { data: meta } = await axios.get(META_URL);
        setDataMeta(meta);
        const fp = metaFingerprint(meta);
        if (!fp) return;
        if (initial) {
          mapDataFingerprint.current = fp;
          return;
        }
        if (fp === mapDataFingerprint.current) return;
        const previous = mapDataFingerprint.current;
        mapDataFingerprint.current = fp;
        try {
          await fetchRestaurants({ showLoading: false });
          setStatsEpoch((n) => n + 1);
        } catch {
          mapDataFingerprint.current = previous;
        }
      } catch {
        /* keep the last good map payload if meta is unreachable */
      }
    },
    [fetchRestaurants]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await fetchRestaurants({ showLoading: true });
        if (!cancelled) await syncFromSource({ initial: true });
      } catch {
        /* fetchRestaurants already recorded mapLoadError */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchRestaurants, syncFromSource]);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') syncFromSource();
    };
    const id = window.setInterval(() => syncFromSource(), MAP_POLL_MS);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [syncFromSource]);

  useEffect(() => {
    if (!debouncedSearch) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }
    if (matchNeighborhoodQuery(debouncedSearch, knownNeighborhoods)) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }
    if (restaurantsLoading) {
      setSearchLoading(true);
      return;
    }
    setSearchLoading(false);
    setSearchResults(
      searchLoadedRestaurants(restaurants, debouncedSearch, 10, pinnedIdSet)
    );
  }, [debouncedSearch, restaurants, restaurantsLoading, pinnedIdSet, knownNeighborhoods]);

  useEffect(() => {
    setSearchActiveIndex(searchResults.length ? 0 : -1);
  }, [searchResults]);

  useEffect(() => {
    if (!searchOpen || searchActiveIndex < 0) return;
    const id = searchResults[searchActiveIndex]?.business_id;
    if (id == null) return;
    document
      .getElementById(`search-option-${id}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [searchActiveIndex, searchResults, searchOpen]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const tag = e.target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) {
          return;
        }
        e.preventDefault();
        searchInputRef.current?.focus();
        setSearchOpen(true);
        return;
      }
      if (e.key === 'Escape') {
        if (splash.show && !splash.fading) return;
        if (searchOpen) {
          setSearchOpen(false);
          searchInputRef.current?.blur();
          return;
        }
        if (popup) {
          setPopup(null);
          setHoverTooltip(null);
          const map = mapRef.current?.getMap();
          clearDotHover(map);
          return;
        }
        if (sidebarOpen) {
          setSidebarOpen(false);
          setNeighborhoodMenuOpen(false);
          return;
        }
        setHoverTooltip(null);
        const map = mapRef.current?.getMap();
        clearDotHover(map);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clearDotHover, searchOpen, popup, sidebarOpen, splash.show, splash.fading]);

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
        if (!cancelled) setNeighborhoodNames(res.data.neighborhoods || []);
      })
      .catch((err) => {
        if (!cancelled) console.error(err);
      });
    return () => {
      cancelled = true;
    };
  }, [sidebarOpen, statsEpoch]);

  useEffect(() => {
    if (!sidebarOpen) {
      setNeighborhoodInput('');
      setSelectedNeighborhood('');
      setNeighborhoodMenuOpen(false);
    }
  }, [sidebarOpen]);

  useEffect(() => {
    if (!sidebarOpen || !selectedNeighborhood) {
      setNeighborhoodDetail(null);
      setNeighborhoodError(null);
      return;
    }
    let cancelled = false;
    setNeighborhoodLoading(true);
    setNeighborhoodError(null);
    axios
      .get(`${API_BASE}/api/stats/neighborhoods`, {
        params: { neighborhood: selectedNeighborhood },
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
  }, [sidebarOpen, selectedNeighborhood, statsEpoch]);

  const searchNeighborhoodHighlight = useMemo(() => {
    return matchNeighborhoodQuery(searchQuery, knownNeighborhoods);
  }, [searchQuery, knownNeighborhoods]);

  const neighborhoodForMapPaint =
    searchNeighborhoodHighlight || selectedNeighborhood;

  const searchNeighborhoodRestaurantCount = useMemo(() => {
    if (!searchNeighborhoodHighlight) return 0;
    return restaurants.filter(
      (r) =>
        String(r.analysis_neighborhood ?? '').trim() ===
        searchNeighborhoodHighlight
    ).length;
  }, [searchNeighborhoodHighlight, restaurants]);

  useEffect(() => {
    if (!searchNeighborhoodHighlight) return;
    const c = computeNeighborhoodCentroid(
      restaurants,
      searchNeighborhoodHighlight
    );
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
  }, [searchNeighborhoodHighlight, restaurants]);

  useEffect(() => {
    if (!selectedNeighborhood || !neighborhoodDetail) return;
    if (neighborhoodDetail.neighborhood !== selectedNeighborhood) return;
    if (searchNeighborhoodHighlight) return;
    const map = mapRef.current?.getMap?.();
    if (!map) return;
    const c = computeNeighborhoodCentroid(restaurants, selectedNeighborhood);
    if (!c) return;
    map.flyTo({
      center: [c.lng, c.lat],
      zoom: 14,
      duration: 1400,
      essential: true,
    });
  }, [
    selectedNeighborhood,
    neighborhoodDetail,
    restaurants,
    searchNeighborhoodHighlight,
  ]);

  useEffect(() => {
    const map = mapRef.current?.getMap();
    clearDotHover(map);
    setHoverTooltip(null);
  }, [mapFilters, mapLayerMode, dotStackTarget, uniformDotSize, clearDotHover]);

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
          const rating = restaurantRatingValue(r);
          const neighborhood = String(r.analysis_neighborhood ?? '').trim();
          return {
            type: 'Feature',
            id: r.business_id,
            geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: {
              business_id: r.business_id,
              business_name: r.business_name,
              business_address: r.business_address || '',
              rating: rating || '',
              neighborhood,
            },
          };
        })
        .filter(Boolean),
    };
  }, [restaurants]);

  const nearbyPlaces = useMemo(() => {
    if (!userLocation) return [];
    return nearestRestaurants(
      restaurants,
      userLocation.lat,
      userLocation.lng,
      mapFilters,
      5
    );
  }, [userLocation, restaurants, mapFilters]);

  const restaurantsCirclePaint = useMemo(() => {
    const radiusCore = uniformDotSize
      ? dotRadiusBase
      : circleRadiusByRating(dotRadiusBase);
    const radiusExpr = [
      '+',
      radiusCore,
      ['case', ['boolean', ['feature-state', 'hover'], false], 3, 0],
    ];
    if (!neighborhoodForMapPaint) {
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
    const inHood = ['==', ['get', 'neighborhood'], neighborhoodForMapPaint];
    return {
      'circle-radius': radiusExpr,
      'circle-color': circleColorExpression,
      'circle-opacity': ['case', inHood, 0.92, 0.3],
      'circle-stroke-width': [
        'case',
        ['boolean', ['feature-state', 'hover'], false],
        ['case', inHood, 4, 2],
        ['case', inHood, 3, 1.5],
      ],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-opacity': ['case', inHood, 1, 0.35],
    };
  }, [neighborhoodForMapPaint, dotRadiusBase, uniformDotSize]);

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
      businessId,
      lng: lon,
      lat,
      loading: true,
      name: fallback?.business_name || 'Restaurant',
      address: fallback ? formatAddress(fallback) : '',
      rating: null,
      date: null,
      violations: [],
      history: [],
    });
    try {
      const { data } = await axios.get(
        `${API_BASE}/api/restaurants/${encodeURIComponent(businessId)}/inspections`
      );
      const latest = data.latest_inspection;
      const ratedInspection = data.rated_inspection;
      const history = Array.isArray(data.inspections) ? data.inspections : [];
      const rated =
        ratedInspection ||
        history.find((insp) => normalizeRating(insp.facility_rating_status));
      setPopup({
        businessId,
        lng: lon,
        lat,
        loading: false,
        name: data.business_name,
        address: formatAddress(data),
        rating:
          rated?.facility_rating_status ??
          latest?.facility_rating_status ??
          null,
        date: rated?.inspection_date ?? latest?.inspection_date ?? null,
        inspectionType: rated?.inspection_type ?? latest?.inspection_type ?? null,
        permitType: data.permit_type || fallback?.permit_type || null,
        notes:
          rated?.inspection_notes ||
          rated?.suspension_notes ||
          latest?.inspection_notes ||
          latest?.suspension_notes ||
          null,
        lastVisit:
          latest?.inspection_date &&
          rated?.inspection_date &&
          latest.inspection_date !== rated.inspection_date
            ? latest.inspection_date
            : null,
        lastVisitType: latest?.inspection_type || null,
        violations: rated?.violations ?? latest?.violations ?? [],
        history,
        fetchError: false,
      });
    } catch (err) {
      console.error(err);
      setPopup({
        businessId,
        lng: lon,
        lat,
        loading: false,
        name: fallback?.business_name || 'Restaurant',
        address: fallback ? formatAddress(fallback) : '',
        rating:
          fallback?.latest_rating_status ??
          fallback?.rating ??
          null,
        date: fallback?.latest_inspection_date ?? null,
        inspectionType: null,
        violations: [],
        history: [],
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

      map.getCanvas().style.cursor = 'pointer';

      const x = event.point.x;
      const y = event.point.y;
      if (id === hoveredBusinessIdRef.current && hoverTooltipElRef.current) {
        hoverTooltipElRef.current.style.left = `${x}px`;
        hoverTooltipElRef.current.style.top = `${y}px`;
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
      const rating = normalizeRating(f.properties?.rating);
      setHoverTooltip({
        x,
        y,
        name,
        rating,
        ratingLabel: rating || 'No rating',
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

  const handleSearchKeyDown = (e) => {
    if (e.key === 'Escape') {
      if (searchOpen || searchQuery) {
        e.preventDefault();
        e.stopPropagation();
        setSearchOpen(false);
        searchInputRef.current?.blur();
      }
      return;
    }
    const neighborhoodMode = Boolean(
      matchNeighborhoodQuery(searchQuery.trim(), knownNeighborhoods) ||
        matchNeighborhoodQuery(debouncedSearch, knownNeighborhoods)
    );
    if (e.key === 'ArrowDown') {
      if (neighborhoodMode) return;
      e.preventDefault();
      setSearchOpen(true);
      setSearchActiveIndex((i) => {
        if (!searchResults.length) return -1;
        return i < 0 ? 0 : (i + 1) % searchResults.length;
      });
      return;
    }
    if (e.key === 'ArrowUp') {
      if (neighborhoodMode || !searchOpen) return;
      e.preventDefault();
      setSearchActiveIndex((i) => {
        if (!searchResults.length) return -1;
        return i <= 0 ? searchResults.length - 1 : i - 1;
      });
      return;
    }
    if (e.key === 'Enter') {
      if (neighborhoodMode) {
        searchInputRef.current?.blur();
        setSearchOpen(false);
        return;
      }
      if (
        searchOpen &&
        searchActiveIndex >= 0 &&
        searchResults[searchActiveIndex]
      ) {
        e.preventDefault();
        handleSelectSearchResult(searchResults[searchActiveIndex]);
      }
    }
  };

  const clearSearch = useCallback(() => {
    setSearchQuery('');
    setSearchOpen(false);
    setSearchNotice(null);
    searchInputRef.current?.focus();
  }, []);

  const handleSelectRankedRestaurant = async (r) => {
    const lon = Number(r.business_longitude ?? r.lon ?? r.lng);
    const lat = Number(r.business_latitude ?? r.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      setSearchNotice('This listing has no coordinates on the map.');
      return;
    }
    setSearchNotice(null);
    setSidebarOpen(false);
    mapRef.current?.flyTo({
      center: [lon, lat],
      zoom: 16,
      duration: 1600,
      essential: true,
    });
    await loadPopupFromInspectionsEndpoint(r.business_id, lon, lat, r);
  };

  useEffect(() => {
    const id = pendingShareIdRef.current;
    if (!id || restaurantsLoading || !mapStyleReady) return;

    let cancelled = false;

    const openAt = (row, lon, lat, businessId) => {
      if (cancelled) return;
      pendingShareIdRef.current = '';
      mapRef.current?.flyTo({
        center: [lon, lat],
        zoom: 16,
        duration: 1600,
        essential: true,
      });
      loadPopupFromInspectionsEndpoint(businessId, lon, lat, row);
    };

    dismissSplash();

    const row = restaurants.find((r) => String(r.business_id) === String(id));
    if (row) {
      const lon = Number(row.business_longitude ?? row.lon ?? row.lng);
      const lat = Number(row.business_latitude ?? row.lat);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        pendingShareIdRef.current = '';
        setSearchNotice('This listing has no coordinates on the map.');
        replaceRestaurantQuery(null);
        return;
      }
      openAt(row, lon, lat, row.business_id);
      return () => {
        cancelled = true;
      };
    }

    axios
      .get(`${API_BASE}/api/restaurants/${encodeURIComponent(id)}`)
      .then(({ data }) => {
        if (cancelled) return;
        const lon = Number(data.business_longitude);
        const lat = Number(data.business_latitude);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
          pendingShareIdRef.current = '';
          setSearchNotice('This listing has no coordinates on the map.');
          replaceRestaurantQuery(null);
          return;
        }
        openAt(data, lon, lat, id);
      })
      .catch(() => {
        if (cancelled) return;
        pendingShareIdRef.current = '';
        setSearchNotice('That restaurant was not found.');
        replaceRestaurantQuery(null);
      });

    return () => {
      cancelled = true;
    };
  }, [restaurants, restaurantsLoading, mapStyleReady, dismissSplash]);

  const copyRestaurantLink = useCallback(async () => {
    const id = popup?.businessId;
    if (!id) return;
    const ok = await copyTextToClipboard(restaurantShareHref(id));
    if (ok) {
      setLinkCopied(true);
      setSearchNotice(null);
    } else {
      setSearchNotice('Could not copy link');
    }
  }, [popup?.businessId]);

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
    !matchNeighborhoodQuery(searchQuery.trim(), knownNeighborhoods) &&
    !matchNeighborhoodQuery(debouncedSearch, knownNeighborhoods);

  const dist = citywideStats?.restaurant_rating_distribution;
  const distMax = dist
    ? Math.max(dist.pass, dist.conditional, dist.closure, dist.no_rating, 1)
    : 1;
  const dataThrough = formatDataThrough(dataMeta?.latest_inspection_date);
  const filtersAllOn = filtersAreAllOn(mapFilters);
  const activeSearchOptionId =
    showDropdown &&
    searchActiveIndex >= 0 &&
    searchResults[searchActiveIndex]?.business_id
      ? `search-option-${searchResults[searchActiveIndex].business_id}`
      : undefined;

  const toggleSidebar = () => setSidebarOpen((o) => !o);

  const setFilter = (key, checked) => {
    setMapFilters((prev) => ({ ...prev, [key]: checked }));
  };

  const pickNeighborhood = useCallback((name) => {
    setNeighborhoodInput(name);
    setSelectedNeighborhood(name);
    setNeighborhoodMenuOpen(false);
  }, []);

  const handleNeighborhoodInputChange = useCallback((e) => {
    const value = e.target.value;
    setNeighborhoodInput(value);
    setNeighborhoodMenuOpen(true);
    setSelectedNeighborhood((prev) => (value === prev ? prev : ''));
  }, []);

  const handleNeighborhoodInputBlur = useCallback(
    (e) => {
      window.setTimeout(() => {
        setNeighborhoodMenuOpen(false);
        const match = matchNeighborhoodQuery(e.target.value, knownNeighborhoods);
        if (match) {
          setNeighborhoodInput(match);
          setSelectedNeighborhood(match);
        }
      }, 180);
    },
    [knownNeighborhoods]
  );

  const handleResetView = useCallback(() => {
    setPopup(null);
    setHoverTooltip(null);
    mapRef.current?.flyTo({
      center: [SF_CENTER.longitude, SF_CENTER.latitude],
      zoom: SF_CENTER.zoom,
      duration: 1000,
      essential: true,
    });
  }, []);

  const handleNearMe = useCallback(() => {
    if (geoLoading) return;
    if (userLocation) {
      setNearbyOpen(true);
      mapRef.current?.flyTo({
        center: [userLocation.lng, userLocation.lat],
        zoom: 15,
        duration: 800,
        essential: true,
      });
      return;
    }
    if (!navigator.geolocation) {
      setGeoToast('Geolocation is not supported in this browser');
      return;
    }
    setGeoLoading(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { longitude, latitude } = pos.coords;
        setGeoLoading(false);
        setUserLocation({ lng: longitude, lat: latitude });
        setNearbyOpen(true);
        mapRef.current?.flyTo({
          center: [longitude, latitude],
          zoom: 15,
          duration: 1200,
          essential: true,
        });
      },
      (err) => {
        setGeoLoading(false);
        if (err?.code === 1) {
          setGeoToast('Location access denied');
        } else if (err?.code === 3) {
          setGeoToast('Location timed out — try again');
        } else {
          setGeoToast('Could not find your location');
        }
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
    );
  }, [geoLoading, userLocation]);

  const mapStyleUrl = basemapDark ? MAP_STYLE_DARK : MAP_STYLE_LIGHT;
  const popupMapsHref = popup
    ? nativeMapsHref({
        lat: popup.lat,
        lng: popup.lng,
        name: popup.name,
        address: popup.address,
      })
    : null;
  const popupIsPinned = popup?.businessId ? isPinned(popup.businessId) : false;
  const showLandmarks =
    mapZoom >= LANDMARK_MIN_ZOOM && mapLayerMode !== 'off';
  const landmarkSize = landmarkPinSize(mapZoom);

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
          onClick={handleMapClick}
          onMouseMove={handleMapMouseMove}
          onMouseLeave={handleMapMouseLeave}
          onLoad={() => setMapStyleReady(true)}
          onMove={handleMapMove}
        >
          <Source
            id="restaurants"
            type="geojson"
            data={geojson}
            promoteId="business_id"
          >
            <Layer
              id={RESTAURANTS_HEATMAP_LAYER_ID}
              type="heatmap"
              paint={restaurantsHeatmapPaint}
              filter={ratingLayerFilter}
              layout={heatmapLayerLayout}
            />
            <Layer
              id={RESTAURANTS_LAYER_ID}
              type="circle"
              paint={restaurantsCirclePaint}
              filter={ratingLayerFilter}
              layout={pinsLayerLayout}
            />
            <Layer
              id={RESTAURANTS_HIT_LAYER_ID}
              type="circle"
              paint={restaurantHitCirclePaint}
              filter={ratingLayerFilter}
              layout={hitLayerLayout}
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
          {showLandmarks &&
            SF_LANDMARKS.map((place) => (
              <Marker
                key={place.id}
                longitude={place.lng}
                latitude={place.lat}
                anchor="bottom"
                style={{ pointerEvents: 'none' }}
              >
                <LandmarkPin
                  name={place.name}
                  icon={place.icon}
                  size={landmarkSize}
                />
              </Marker>
            ))}
          {pinnedRestaurants.map((place) => {
            const lat = Number(place.business_latitude);
            const lng = Number(place.business_longitude);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
            return (
              <Marker
                key={`pin-${place.business_id}`}
                longitude={lng}
                latitude={lat}
                anchor="bottom"
                onClick={(e) => {
                  e.originalEvent?.stopPropagation?.();
                  handleSelectRankedRestaurant(place);
                }}
              >
                <div
                  className="pinned-map-marker"
                  title={place.business_name}
                >
                  <span aria-hidden>★</span>
                </div>
              </Marker>
            );
          })}
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
                    <div className="popup-actions">
                      {popup.businessId && (
                        <button
                          type="button"
                          className={`popup-action-btn${popupIsPinned ? ' is-pinned' : ''}`}
                          onClick={() =>
                            togglePinnedRestaurant({
                              business_id: popup.businessId,
                              name: popup.name,
                              address: popup.address,
                              lat: popup.lat,
                              lng: popup.lng,
                              rating: popup.rating,
                            })
                          }
                        >
                          {popupIsPinned ? 'Unpin' : 'Pin'}
                        </button>
                      )}
                      {popupMapsHref && (
                        <a
                          className="popup-action-btn popup-action-btn--primary"
                          href={popupMapsHref}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Directions
                        </a>
                      )}
                      {popup.businessId && (
                        <button
                          type="button"
                          className={`popup-action-btn${linkCopied ? ' is-copied' : ''}`}
                          onClick={copyRestaurantLink}
                        >
                          {linkCopied ? 'Copied' : 'Copy link'}
                        </button>
                      )}
                    </div>
                    <dl className="popup-meta">
                      <div>
                        <dt>Latest rating</dt>
                        <dd>
                          <span className={ratingClassName(popup.rating)}>
                            {normalizeRating(popup.rating) || '—'}
                          </span>
                        </dd>
                      </div>
                      <div>
                        <dt>Inspection date</dt>
                        <dd>{formatInspectionDate(popup.date)}</dd>
                      </div>
                    </dl>
                    {popup.inspectionType && (
                      <p className="popup-type">{popup.inspectionType}</p>
                    )}
                    {popup.lastVisit && (
                      <p className="popup-type">
                        Last visit {formatInspectionDate(popup.lastVisit)}
                        {popup.lastVisitType ? ` (${popup.lastVisitType})` : ''}{' '}
                        (no rating)
                      </p>
                    )}
                    {popup.permitType && (
                      <p className="popup-type">{popup.permitType}</p>
                    )}
                    {popup.notes && (
                      <p className="popup-note">{popup.notes}</p>
                    )}
                    {popup.fetchError && (
                      <p className="popup-note">
                        Could not load inspection data from the server.
                      </p>
                    )}
                    <div className="popup-violations">
                      <h3>Violations (this rating)</h3>
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
                    {(popup.history || []).length > 1 && (
                      <details className="popup-history">
                        <summary>
                          {(popup.history || []).length} inspections on record
                        </summary>
                        <ol className="popup-history-list">
                          {(popup.history || []).slice(0, 8).map((insp) => (
                            <li key={insp.inspection_id}>
                              <span className="popup-history-date">
                                {formatInspectionDate(insp.inspection_date)}
                              </span>
                              <span className={ratingClassName(insp.facility_rating_status)}>
                                {normalizeRating(insp.facility_rating_status) || '—'}
                              </span>
                            </li>
                          ))}
                        </ol>
                      </details>
                    )}
                  </>
                )}
              </div>
            </Popup>
          )}
        </Map>
        {hoverTooltip && !popup && (
          <div
            ref={hoverTooltipElRef}
            className="map-dot-tooltip"
            style={{
              left: hoverTooltip.x,
              top: hoverTooltip.y,
            }}
            role="tooltip"
          >
            <div className="map-dot-tooltip-name">{hoverTooltip.name}</div>
            <div className={tooltipRatingClassName(hoverTooltip.rating)}>
              {hoverTooltip.ratingLabel}
            </div>
          </div>
        )}
        {restaurantsLoading && !mapLoadError && !splash.show && (
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
        <div className="map-fab-stack">
          <button
            type="button"
            className="map-reset-btn"
            onClick={handleResetView}
            aria-label="Reset map to San Francisco"
            title="Reset view"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M3 11.5 12 4l9 7.5" />
              <path d="M6 10.5V20h12v-9.5" />
            </svg>
            <span className="near-me-label">SF</span>
          </button>
          <button
            type="button"
            className={`near-me-btn${geoLoading ? ' is-loading' : ''}`}
            onClick={handleNearMe}
            disabled={geoLoading}
            aria-busy={geoLoading}
            aria-label={
              geoLoading
                ? 'Finding your location'
                : 'Near me: center map on your location'
            }
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
            <span className="near-me-label">
              {geoLoading ? 'Locating' : 'Near Me'}
            </span>
          </button>
        </div>
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
        className={`sidebar-menu-btn${filtersAllOn ? '' : ' has-filter-badge'}`}
        onClick={toggleSidebar}
        aria-expanded={sidebarOpen}
        aria-controls="map-sidebar-panel"
        aria-label={sidebarOpen ? 'Close insights panel' : 'Open insights panel'}
        title={filtersAllOn ? 'Insights' : 'Insights (filters on)'}
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
            <h3 className="sidebar-section-title">Pinned restaurants</h3>
            {pinnedRestaurants.length === 0 ? (
              <p className="sidebar-muted">
                Pin a place from its inspection popup to save it here.
              </p>
            ) : (
              <ul className="sidebar-pinned-list">
                {pinnedRestaurants.map((r) => {
                  const pinMapsHref = nativeMapsHref({
                    lat: Number(r.business_latitude),
                    lng: Number(r.business_longitude),
                    name: r.business_name,
                    address: r.business_address,
                  });
                  return (
                  <li key={`pin-list-${r.business_id}`}>
                    <button
                      type="button"
                      className="sidebar-rank-btn"
                      onClick={() => handleSelectRankedRestaurant(r)}
                      title={`Show ${r.business_name} on the map`}
                    >
                      <span className="sidebar-rank-name">{r.business_name}</span>
                      <span
                        className={`sidebar-rank-score ${ratingClassName(r.latest_rating_status)}`}
                      >
                        {normalizeRating(r.latest_rating_status) || '—'}
                      </span>
                    </button>
                    {pinMapsHref && (
                      <a
                        className="sidebar-pin-dir"
                        href={pinMapsHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Directions to ${r.business_name}`}
                        title="Directions"
                      >
                        Go
                      </a>
                    )}
                    <button
                      type="button"
                      className="sidebar-unpin-btn"
                      onClick={() => togglePinnedRestaurant(r)}
                      aria-label={`Unpin ${r.business_name}`}
                    >
                      ×
                    </button>
                  </li>
                  );
                })}
              </ul>
            )}
          </section>
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
                  Latest pass rate:{' '}
                  <strong>
                    {citywideStats.pass_rate != null
                      ? `${citywideStats.pass_rate}%`
                      : '—'}
                  </strong>
                </p>
                {dataThrough && (
                  <p className="sidebar-muted">Ratings through {dataThrough}</p>
                )}
                <p className="sidebar-chart-label">Rating distribution</p>
                <div className="sidebar-bars" role="img" aria-label="Rating distribution">
                  {[
                    { key: 'pass', label: 'Pass', color: '#22c55e' },
                    { key: 'conditional', label: 'Conditional', color: '#eab308' },
                    { key: 'closure', label: 'Closure', color: '#ef4444' },
                    { key: 'no_rating', label: 'No rating', color: '#9ca3af' },
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
                <p className="sidebar-chart-label">Needs attention citywide</p>
                <p className="sidebar-help">
                  Closures and conditional passes, most recent inspection first.
                </p>
                {(citywideStats.lowest_restaurants || []).length === 0 ? (
                  <p className="sidebar-muted">No rated restaurants.</p>
                ) : (
                  <ol className="sidebar-rank-list">
                    {citywideStats.lowest_restaurants.map((r) => (
                      <li key={`city-low-${r.business_id}`}>
                        <button
                          type="button"
                          className="sidebar-rank-btn"
                          onClick={() => handleSelectRankedRestaurant(r)}
                          title={`Show ${r.business_name} on the map`}
                        >
                          <span className="sidebar-rank-name">{r.business_name}</span>
                          <span
                            className={`sidebar-rank-score ${ratingClassName(r.latest_rating_status)}`}
                          >
                            {normalizeRating(r.latest_rating_status) || '—'}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
              </>
            )}
          </section>

          <section className="sidebar-section">
            <h3 className="sidebar-section-title">Neighborhood breakdown</h3>
            <div className="sidebar-zip-wrap">
              <label className="sidebar-select-label" htmlFor="neighborhood-input">
                Neighborhood
              </label>
              <input
                id="neighborhood-input"
                type="text"
                autoComplete="off"
                placeholder="Search Mission, Tenderloin…"
                className="sidebar-zip-input"
                value={neighborhoodInput}
                aria-expanded={neighborhoodMenuOpen}
                aria-controls="neighborhood-suggestions"
                aria-autocomplete="list"
                role="combobox"
                onChange={handleNeighborhoodInputChange}
                onFocus={() => setNeighborhoodMenuOpen(true)}
                onBlur={handleNeighborhoodInputBlur}
              />
              {neighborhoodMenuOpen && (
                <ul
                  id="neighborhood-suggestions"
                  className="sidebar-zip-dropdown"
                  role="listbox"
                  onMouseDown={(e) => e.preventDefault()}
                >
                  {filteredNeighborhoods.length === 0 ? (
                    <li className="sidebar-zip-dropdown-status">
                      {knownNeighborhoods.length === 0
                        ? 'No neighborhoods in data'
                        : !neighborhoodInput
                          ? 'Start typing to filter…'
                          : 'No matching neighborhood'}
                    </li>
                  ) : (
                    filteredNeighborhoods.map((name) => (
                      <li key={name} role="presentation">
                        <button
                          type="button"
                          className="sidebar-zip-option"
                          role="option"
                          aria-selected={selectedNeighborhood === name}
                          onClick={() => pickNeighborhood(name)}
                        >
                          {name}
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
                  Pass rate:{' '}
                  <strong>
                    {neighborhoodDetail.pass_rate != null
                      ? `${neighborhoodDetail.pass_rate}%`
                      : '—'}
                  </strong>
                </p>
                <p className="sidebar-subheading">Highest ratings</p>
                {(neighborhoodDetail.top_restaurants || []).length === 0 ? (
                  <p className="sidebar-muted">No rated restaurants here.</p>
                ) : (
                  <ol className="sidebar-rank-list">
                    {neighborhoodDetail.top_restaurants.map((r) => (
                      <li key={r.business_id}>
                        <button
                          type="button"
                          className="sidebar-rank-btn"
                          onClick={() => handleSelectRankedRestaurant(r)}
                          title={`Show ${r.business_name} on the map`}
                        >
                          <span className="sidebar-rank-name">{r.business_name}</span>
                          <span className={`sidebar-rank-score ${ratingClassName(r.latest_rating_status)}`}>
                            {normalizeRating(r.latest_rating_status) || '—'}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
                <p className="sidebar-subheading">Needs attention</p>
                {(neighborhoodDetail.bottom_restaurants || []).length === 0 ? (
                  <p className="sidebar-muted">No rated restaurants here.</p>
                ) : (
                  <ol className="sidebar-rank-list">
                    {neighborhoodDetail.bottom_restaurants.map((r) => (
                      <li key={`bottom-${r.business_id}`}>
                        <button
                          type="button"
                          className="sidebar-rank-btn"
                          onClick={() => handleSelectRankedRestaurant(r)}
                          title={`Show ${r.business_name} on the map`}
                        >
                          <span className="sidebar-rank-name">{r.business_name}</span>
                          <span className={`sidebar-rank-score ${ratingClassName(r.latest_rating_status)}`}>
                            {normalizeRating(r.latest_rating_status) || '—'}
                          </span>
                        </button>
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
                  onClick={() =>
                    setMapFilters({
                      pass: false,
                      conditional: true,
                      closure: true,
                      noRating: false,
                    })
                  }
                >
                  Not a Pass
                </button>
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
                      pass: false,
                      conditional: false,
                      closure: false,
                      noRating: false,
                    })
                  }
                >
                  Select None
                </button>
              </div>
            </div>
            <p className="sidebar-help">
              Show dots by the latest inspection rating. Closures render larger
              so they stay visible among a Pass majority.
            </p>
            <ul className="sidebar-checklist">
              {[
                { key: 'pass', label: 'Pass (green)' },
                { key: 'conditional', label: 'Conditional Pass (yellow)' },
                { key: 'closure', label: 'Closure (red)' },
                { key: 'noRating', label: 'No rating (gray)' },
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
            <div className="sidebar-dot-display">
              <label className="sidebar-slider-label" htmlFor="dot-stack-slider">
                <span>On top</span>
                <span className="sidebar-slider-value">
                  {stackBandLabel(dotStackTarget)}
                </span>
              </label>
              <input
                id="dot-stack-slider"
                className="sidebar-stack-slider"
                type="range"
                min="0"
                max="2"
                step="1"
                value={Math.max(
                  0,
                  ['closure', 'conditional', 'pass'].indexOf(dotStackTarget)
                )}
                aria-valuemin={0}
                aria-valuemax={2}
                aria-valuenow={Math.max(
                  0,
                  ['closure', 'conditional', 'pass'].indexOf(dotStackTarget)
                )}
                aria-valuetext={stackBandLabel(dotStackTarget)}
                onChange={(e) =>
                  setDotStackTarget(
                    ['closure', 'conditional', 'pass'][Number(e.target.value)]
                  )
                }
              />
              <div className="sidebar-stack-labels" aria-hidden>
                <span>Closure</span>
                <span>Conditional</span>
                <span>Pass</span>
              </div>
              <label className="sidebar-check-label sidebar-check-label--spaced">
                <input
                  type="checkbox"
                  checked={uniformDotSize}
                  onChange={(e) => setUniformDotSize(e.target.checked)}
                />
                Same size for every dot
              </label>
            </div>
          </section>
        </div>
      </aside>

      <div className="search-panel">
        <button
          type="button"
          className="app-brand"
          onClick={openSplash}
          aria-label="Back to home screen"
        >
          <span className="app-brand-mark" aria-hidden />
          <span>
            <span className="app-brand-title">SF Restaurant Safety</span>
            <span className="app-brand-sub">Health inspection ratings</span>
          </span>
        </button>
        <div className="search-input-wrap">
          <input
            ref={searchInputRef}
            type="search"
            className="search-input"
            placeholder="Search restaurants or neighborhood…"
            value={searchQuery}
            autoComplete="off"
            role="combobox"
            aria-label="Search restaurants or neighborhood"
            aria-expanded={showDropdown}
            aria-controls="search-results-list"
            aria-activedescendant={activeSearchOptionId}
            aria-autocomplete="list"
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setSearchOpen(true);
            }}
            onKeyDown={handleSearchKeyDown}
            onFocus={() => setSearchOpen(true)}
            onBlur={() => {
              window.setTimeout(() => setSearchOpen(false), 180);
            }}
          />
          {searchQuery ? (
            <button
              type="button"
              className="search-clear-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={clearSearch}
              aria-label="Clear search"
            >
              ×
            </button>
          ) : (
            <kbd className="search-kbd-hint" title="Press / to search">
              /
            </kbd>
          )}
        </div>
        {searchNeighborhoodHighlight && (
          <div className="search-zip-badge" role="status">
            <span className="search-zip-badge-text">
              Showing {searchNeighborhoodRestaurantCount} restaurant
              {searchNeighborhoodRestaurantCount === 1 ? '' : 's'} in{' '}
              {searchNeighborhoodHighlight}
            </span>
            <button
              type="button"
              className="search-zip-badge-clear"
              onClick={clearSearch}
              aria-label="Clear neighborhood search"
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
              searchResults.map((r, index) => (
                <li key={r.business_id}>
                  <button
                    type="button"
                    id={`search-option-${r.business_id}`}
                    className={`search-result-btn${
                      index === searchActiveIndex ? ' is-active' : ''
                    }`}
                    role="option"
                    aria-selected={index === searchActiveIndex}
                    onMouseEnter={() => setSearchActiveIndex(index)}
                    onClick={() => handleSelectSearchResult(r)}
                  >
                    <span className="search-result-name">
                      {isPinned(r.business_id) ? '★ ' : ''}
                      {r.business_name}
                    </span>
                    <span className="search-result-address">
                      {formatAddress(r)}
                    </span>
                    <span className={`search-result-score ${ratingClassName(r.latest_rating_status)}`}>
                      {normalizeRating(r.latest_rating_status) || '—'}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        )}
        {userLocation && nearbyOpen && !showDropdown && !searchNeighborhoodHighlight && (
          <div className="nearby-panel">
            <div className="nearby-panel-header">
              <h2 className="nearby-panel-title">Nearby</h2>
              <button
                type="button"
                className="nearby-panel-close"
                onClick={() => setNearbyOpen(false)}
                aria-label="Hide nearby list"
              >
                ×
              </button>
            </div>
            {nearbyPlaces.length === 0 ? (
              <p className="nearby-panel-empty">
                No restaurants match the current rating filters near you.
              </p>
            ) : (
              <ul className="nearby-panel-list">
                {nearbyPlaces.map(({ r, miles }) => {
                  const rating = restaurantRatingValue(r);
                  return (
                    <li key={`near-${r.business_id}`}>
                      <button
                        type="button"
                        className="nearby-panel-btn"
                        onClick={() => handleSelectRankedRestaurant(r)}
                      >
                        <span className="nearby-panel-name">
                          {r.business_name}
                        </span>
                        <span className="nearby-panel-meta">
                          <span className="nearby-panel-dist">
                            {formatDistanceMiles(miles)}
                          </span>
                          <span className={`nearby-panel-score ${ratingClassName(rating)}`}>
                            {rating || '—'}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
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
            <p className="app-error-text">{mapLoadError}</p>
            <button
              type="button"
              className="app-error-retry"
              onClick={() => {
                fetchRestaurants({ showLoading: true }).catch(() => {});
              }}
            >
              Retry
            </button>
          </div>
        )}
        {searchNotice && (
          <div className="app-notice" role="status">
            {searchNotice}
          </div>
        )}
      </div>

      <div className="map-legend">
        {mapLayerMode === 'heatmap' ? (
          <>
            <div className="map-legend-title">
              Inspection heat ({restaurants.length})
            </div>
            <p className="map-legend-hint">
              Hotter areas are denser or have more Closures / Conditional Passes
            </p>
            <div className="legend-heat-bar" aria-hidden />
            <div className="legend-heat-labels">
              <span>Cooler</span>
              <span>Hotter</span>
            </div>
          </>
        ) : mapLayerMode === 'off' ? (
          <div className="map-legend-title">Overlay hidden</div>
        ) : (
          <>
            <div className="map-legend-title">
              Inspection rating ({restaurants.length})
            </div>
            <p className="map-legend-hint">
              {dataThrough
                ? `Through ${dataThrough}. ${stackLegendHint(dotStackTarget)}.`
                : stackLegendHint(dotStackTarget)}
            </p>
            <div className="legend-rating-bar" aria-hidden />
            <div className="legend-heat-labels">
              <span>Closure</span>
              <span>Conditional</span>
              <span>Pass</span>
            </div>
          </>
        )}
        {mapLayerMode !== 'off' && (
          <>
            <div
              className="legend-filter-row"
              role="group"
              aria-label="Filter by inspection rating"
            >
              {LEGEND_FILTER_CHIPS.map(({ key, label, color }) => (
                <button
                  key={key}
                  type="button"
                  className={`legend-chip${mapFilters[key] ? '' : ' is-off'}`}
                  aria-pressed={mapFilters[key]}
                  onClick={() => setFilter(key, !mapFilters[key])}
                >
                  <span
                    className="legend-chip-swatch"
                    style={{ background: color }}
                    aria-hidden
                  />
                  {label}
                </button>
              ))}
            </div>
            {!filtersAllOn && (
              <button
                type="button"
                className="legend-show-all"
                onClick={() => setMapFilters({ ...defaultMapFilters })}
              >
                Show all ratings
              </button>
            )}
          </>
        )}
      </div>

      {splash.show && (
        <div
          className={`app-splash${splash.fading ? ' is-leaving' : ''}`}
          role="dialog"
          aria-modal="true"
          aria-labelledby="app-splash-title"
          onClick={dismissSplash}
        >
          <div className="app-splash-inner">
            <h1 id="app-splash-title" className="app-splash-title">
              SF Restaurant Safety Map
            </h1>
            <p className="app-splash-sub">
              Tap a pin for the latest inspection rating, or search by name or
              neighborhood.
            </p>
            <div className="app-splash-dots" aria-hidden>
              <span className="app-splash-dot app-splash-dot--good" />
              <span className="app-splash-dot app-splash-dot--mid" />
              <span className="app-splash-dot app-splash-dot--bad" />
            </div>
            <p className="app-splash-continue">Click anywhere to continue</p>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
