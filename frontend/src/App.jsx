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

/** Lower inspection score ⇒ higher heatmap weight. Stops must be ascending. */
const heatmapWeightExpression = [
  'case',
  ['any', ['==', ['get', 'score'], null], ['!', ['has', 'score']]],
  0.08,
  [
    'interpolate',
    ['linear'],
    ['to-number', ['get', 'score'], 85],
    0,
    1,
    50,
    0.8,
    70,
    0.5,
    90,
    0.28,
    100,
    0.18,
  ],
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

/** Continuous color so 90 and 100 are not the same green blob. */
const circleColorExpression = [
  'case',
  ['any', ['==', ['get', 'score'], null], ['!', ['has', 'score']]],
  '#9ca3af',
  [
    'interpolate',
    ['linear'],
    ['to-number', ['get', 'score']],
    50,
    '#ef4444',
    70,
    '#f97316',
    80,
    '#eab308',
    90,
    '#84cc16',
    96,
    '#22c55e',
    100,
    '#166534',
  ],
];

function circleSortKeyForTarget(targetScore) {
  return [
    'case',
    ['any', ['==', ['get', 'score'], null], ['!', ['has', 'score']]],
    0,
    [
      '-',
      110,
      ['abs', ['-', ['to-number', ['get', 'score']], targetScore]],
    ],
  ];
}

function circleRadiusByScore(base) {
  return [
    'interpolate',
    ['linear'],
    ['coalesce', ['to-number', ['get', 'score']], 100],
    50,
    base + 3.25,
    80,
    base + 1.25,
    90,
    base,
    100,
    Math.max(3.25, base - 0.75),
  ];
}

function stackBandLabel(target) {
  if (target < 70) return 'Reds on top';
  if (target < 90) return 'Yellows on top';
  return 'Greens on top';
}

function stackLegendHint(target) {
  if (target < 70) return 'Weaker scores sit on top';
  if (target < 90) return 'Mid-range scores sit on top';
  return 'Higher scores sit on top';
}

const DOT_RADIUS_DESKTOP = 5;
const DOT_RADIUS_MOBILE = 7;

const SPLASH_MIN_MS = 3200;
const SPLASH_FADE_MS = 1000;
const SPLASH_MAX_MS = 8000;

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

function clampStackTarget(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 50;
  return Math.min(100, Math.max(50, n));
}

function loadMapPrefs() {
  const defaults = {
    basemapDark: false,
    mapLayerMode: 'pins',
    mapFilters: { ...defaultMapFilters },
    dotStackTarget: 50,
    uniformDotSize: false,
  };
  if (typeof localStorage === 'undefined') return defaults;
  try {
    const parsed = JSON.parse(localStorage.getItem(MAP_PREFS_STORAGE_KEY) || 'null');
    if (!parsed || typeof parsed !== 'object') return defaults;
    const mode = parsed.mapLayerMode;
    const filters = parsed.mapFilters && typeof parsed.mapFilters === 'object'
      ? {
          good: parsed.mapFilters.good !== false,
          mid: parsed.mapFilters.mid !== false,
          bad: parsed.mapFilters.bad !== false,
          noScore: parsed.mapFilters.noScore !== false,
        }
      : { ...defaultMapFilters };
    return {
      basemapDark: parsed.basemapDark === true,
      mapLayerMode:
        mode === 'heatmap' || mode === 'off' || mode === 'pins' ? mode : 'pins',
      mapFilters: filters,
      dotStackTarget: clampStackTarget(parsed.dotStackTarget),
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
    latest_inspection_score:
      source.latest_inspection_score ?? source.score ?? null,
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

/** Matches map coloring: 96+ dark green, 90–95 green, 70–89 yellow, below 70 red. */
function scoreClassName(score) {
  if (score == null || score === '') return 'popup-score popup-score--na';
  const n = Number(score);
  if (!Number.isFinite(n)) return 'popup-score popup-score--na';
  if (n >= 96) return 'popup-score popup-score--excellent';
  if (n >= 90) return 'popup-score popup-score--good';
  if (n >= 70) return 'popup-score popup-score--mid';
  return 'popup-score popup-score--bad';
}

function tooltipScoreClassName(score) {
  if (score == null || score === '') return 'map-dot-tooltip-score map-dot-tooltip-score--na';
  const n = Number(score);
  if (!Number.isFinite(n)) return 'map-dot-tooltip-score map-dot-tooltip-score--na';
  if (n >= 96) return 'map-dot-tooltip-score map-dot-tooltip-score--excellent';
  if (n >= 90) return 'map-dot-tooltip-score map-dot-tooltip-score--good';
  if (n >= 70) return 'map-dot-tooltip-score map-dot-tooltip-score--mid';
  return 'map-dot-tooltip-score map-dot-tooltip-score--bad';
}

/** Plain-language LIVES band next to the numeric score. */
function scoreBandLabel(score) {
  if (score == null || score === '') return 'No score';
  const n = Number(score);
  if (!Number.isFinite(n)) return 'No score';
  if (n >= 96) return 'Excellent';
  if (n >= 90) return 'Good';
  if (n >= 70) return 'Adequate';
  return 'Poor';
}

function restaurantScoreValue(r) {
  const raw = r?.latest_inspection_score ?? r?.score ?? r?.inspection_score;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function restaurantMatchesFilters(r, filters) {
  const n = restaurantScoreValue(r);
  if (n == null) return Boolean(filters?.noScore);
  if (n >= 90) return Boolean(filters?.good);
  if (n >= 70) return Boolean(filters?.mid);
  return Boolean(filters?.bad);
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

const NEARBY_RADIUS_OPTIONS = [0.25, 0.5, 1];
const NEARBY_DEFAULT_RADIUS_MILES = 0.5;
const NEARBY_LIST_LIMIT = 8;
const SAFER_NEARBY_MILES = 0.4;
const SAFER_NEARBY_LIMIT = 3;

function formatRadiusChip(miles) {
  if (miles === 0.25) return '¼ mi';
  if (miles === 0.5) return '½ mi';
  if (miles === 1) return '1 mi';
  return `${miles} mi`;
}

function readMapCenter(mapRef) {
  const map = mapRef?.current;
  if (!map) return null;
  const center =
    typeof map.getCenter === 'function'
      ? map.getCenter()
      : map.getMap?.()?.getCenter?.();
  if (!center) return null;
  const lng = Number(center.lng ?? center.lon);
  const lat = Number(center.lat);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function nearestRestaurants(rows, lat, lng, filters, options = {}) {
  const {
    limit = 5,
    maxMiles = null,
    sort = 'distance',
    excludeId = null,
    minScoreExclusive = null,
    requireScore = false,
  } = options;
  const exclude = excludeId == null ? null : String(excludeId);
  const scored = [];
  for (const r of rows) {
    if (exclude && String(r.business_id) === exclude) continue;
    if (filters && !restaurantMatchesFilters(r, filters)) continue;
    const score = restaurantScoreValue(r);
    if (requireScore && score == null) continue;
    if (
      minScoreExclusive != null &&
      (score == null || score <= minScoreExclusive)
    ) {
      continue;
    }
    const rLat = Number(r.business_latitude ?? r.latitude ?? r.lat);
    const rLng = Number(r.business_longitude ?? r.longitude ?? r.lon ?? r.lng);
    if (!Number.isFinite(rLat) || !Number.isFinite(rLng)) continue;
    const miles = haversineMiles(lat, lng, rLat, rLng);
    if (maxMiles != null && miles > maxMiles) continue;
    scored.push({ r, miles, score });
  }
  if (sort === 'score') {
    scored.sort((a, b) => {
      if (a.score == null && b.score == null) return a.miles - b.miles;
      if (a.score == null) return 1;
      if (b.score == null) return -1;
      return b.score - a.score || a.miles - b.miles;
    });
  } else {
    scored.sort(
      (a, b) => a.miles - b.miles || (b.score ?? -1) - (a.score ?? -1)
    );
  }
  return {
    results: scored.slice(0, limit),
    total: scored.length,
  };
}

function formatNearbyCountLabel(shown, total, miles) {
  const radius = formatRadiusChip(miles);
  if (total === 0) return `None within ${radius}`;
  if (total > shown) return `${shown} of ${total} within ${radius}`;
  return `${total} within ${radius}`;
}

function filtersAreAllOn(filters) {
  return Boolean(filters?.good && filters?.mid && filters?.bad && filters?.noScore);
}

const LEGEND_FILTER_CHIPS = [
  { key: 'good', label: '90+', color: '#22c55e' },
  { key: 'mid', label: '70–89', color: '#eab308' },
  { key: 'bad', label: '<70', color: '#ef4444' },
  { key: 'noScore', label: 'No score', color: '#9ca3af' },
];

function formatDataThrough(iso) {
  if (iso == null || iso === '') return null;
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (!ymd) return null;
  const d = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
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
    let rank;
    if (name.startsWith(q)) rank = 0;
    else if (name.includes(q)) rank = 1;
    else if (addr.includes(q)) rank = 2;
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
  const [nearbyAnchor, setNearbyAnchor] = useState(null);
  const [nearbyRadiusMiles, setNearbyRadiusMiles] = useState(
    NEARBY_DEFAULT_RADIUS_MILES
  );
  const [nearbySort, setNearbySort] = useState('distance');
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
  const [postalCodes, setPostalCodes] = useState([]);
  const [zipInput, setZipInput] = useState('');
  const [zipMenuOpen, setZipMenuOpen] = useState(false);
  const [selectedPostal, setSelectedPostal] = useState('');
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

  const scoreLayerFilter = useMemo(
    () => buildScoreCategoryFilter(mapFilters),
    [mapFilters]
  );

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
    if (isSfZipSearchQuery(debouncedSearch)) {
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
  }, [debouncedSearch, restaurants, restaurantsLoading, pinnedIdSet]);

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
          setZipMenuOpen(false);
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
        if (!cancelled) setPostalCodes(res.data.postal_codes || []);
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
  }, [sidebarOpen, selectedPostal, statsEpoch]);

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
          const rawScore =
            r.score ?? r.latest_inspection_score ?? r.inspection_score ?? null;
          const score =
            rawScore === null || rawScore === undefined || rawScore === ''
              ? null
              : Number(rawScore);
          const postal_code = String(r.business_postal_code ?? '').trim();
          return {
            type: 'Feature',
            id: r.business_id,
            geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: {
              business_id: r.business_id,
              business_name: r.business_name,
              business_address: r.business_address || '',
              score: Number.isFinite(score) ? score : null,
              postal_code,
            },
          };
        })
        .filter(Boolean),
    };
  }, [restaurants]);

  const nearbyMatch = useMemo(() => {
    if (!nearbyAnchor) return { results: [], total: 0 };
    return nearestRestaurants(
      restaurants,
      nearbyAnchor.lat,
      nearbyAnchor.lng,
      mapFilters,
      {
        limit: NEARBY_LIST_LIMIT,
        maxMiles: nearbyRadiusMiles,
        sort: nearbySort,
      }
    );
  }, [nearbyAnchor, restaurants, mapFilters, nearbyRadiusMiles, nearbySort]);
  const nearbyPlaces = nearbyMatch.results;

  const saferNearby = useMemo(() => {
    if (!popup) return [];
    const lat = Number(popup.lat);
    const lng = Number(popup.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
    const currentScore = restaurantScoreValue(popup);
    if (currentScore == null) return [];
    return nearestRestaurants(restaurants, lat, lng, null, {
      limit: SAFER_NEARBY_LIMIT,
      maxMiles: SAFER_NEARBY_MILES,
      sort: 'score',
      excludeId: popup.businessId,
      requireScore: true,
      minScoreExclusive: currentScore,
    }).results;
  }, [popup, restaurants]);

  const restaurantsCirclePaint = useMemo(() => {
    const radiusCore = uniformDotSize
      ? dotRadiusBase
      : circleRadiusByScore(dotRadiusBase);
    const radiusExpr = [
      '+',
      radiusCore,
      ['case', ['boolean', ['feature-state', 'hover'], false], 3, 0],
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
  }, [zipForMapPaint, dotRadiusBase, uniformDotSize]);

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
      score: null,
      date: null,
      violations: [],
      history: [],
    });
    try {
      const { data } = await axios.get(
        `${API_BASE}/api/restaurants/${encodeURIComponent(businessId)}/inspections`
      );
      const latest = data.latest_inspection;
      const scoredInspection = data.scored_inspection;
      const history = Array.isArray(data.inspections) ? data.inspections : [];
      const scored =
        scoredInspection ||
        history.find(
          (insp) => insp.inspection_score != null && insp.inspection_score !== ''
        );
      setPopup({
        businessId,
        lng: lon,
        lat,
        loading: false,
        name: data.business_name,
        address: formatAddress(data),
        score: scored?.inspection_score ?? latest?.inspection_score ?? null,
        date: scored?.inspection_date ?? latest?.inspection_date ?? null,
        inspectionType: scored?.inspection_type ?? latest?.inspection_type ?? null,
        lastVisit:
          latest?.inspection_date &&
          scored?.inspection_date &&
          latest.inspection_date !== scored.inspection_date
            ? latest.inspection_date
            : null,
        violations: scored?.violations ?? latest?.violations ?? [],
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
        score:
          fallback?.latest_inspection_score ??
          fallback?.score ??
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
      const score = f.properties?.score;
      const scoreLabel =
        score != null && score !== '' ? String(score) : 'No score';
      setHoverTooltip({
        x,
        y,
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
    const zipMode =
      isSfZipSearchQuery(searchQuery.trim()) ||
      isSfZipSearchQuery(debouncedSearch);
    if (e.key === 'ArrowDown') {
      if (zipMode) return;
      e.preventDefault();
      setSearchOpen(true);
      setSearchActiveIndex((i) => {
        if (!searchResults.length) return -1;
        return i < 0 ? 0 : (i + 1) % searchResults.length;
      });
      return;
    }
    if (e.key === 'ArrowUp') {
      if (zipMode || !searchOpen) return;
      e.preventDefault();
      setSearchActiveIndex((i) => {
        if (!searchResults.length) return -1;
        return i <= 0 ? searchResults.length - 1 : i - 1;
      });
      return;
    }
    if (e.key === 'Enter') {
      if (zipMode) {
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

  const openNearbyFromMap = useCallback(() => {
    const center = readMapCenter(mapRef);
    if (!center) return false;
    setNearbyAnchor({ ...center, source: 'map' });
    setNearbyOpen(true);
    return true;
  }, []);

  const handleNearbyThisView = useCallback(() => {
    if (openNearbyFromMap()) setGeoToast(null);
  }, [openNearbyFromMap]);

  const handleNearMe = useCallback(() => {
    if (geoLoading) return;
    if (userLocation) {
      setNearbyAnchor({
        lat: userLocation.lat,
        lng: userLocation.lng,
        source: 'gps',
      });
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
      openNearbyFromMap();
      setGeoToast('Geolocation is not supported — showing this map view');
      return;
    }
    setGeoLoading(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { longitude, latitude } = pos.coords;
        setGeoLoading(false);
        setUserLocation({ lng: longitude, lat: latitude });
        setNearbyAnchor({ lat: latitude, lng: longitude, source: 'gps' });
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
        const opened = openNearbyFromMap();
        if (err?.code === 1) {
          setGeoToast(
            opened
              ? 'Location denied — showing restaurants in this map view'
              : 'Location access denied'
          );
        } else if (err?.code === 3) {
          setGeoToast(
            opened
              ? 'Location timed out — showing this map view'
              : 'Location timed out — try again'
          );
        } else {
          setGeoToast(
            opened
              ? 'Could not find your location — showing this map view'
              : 'Could not find your location'
          );
        }
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
    );
  }, [geoLoading, userLocation, openNearbyFromMap]);

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
              filter={scoreLayerFilter}
              layout={heatmapLayerLayout}
            />
            <Layer
              id={RESTAURANTS_LAYER_ID}
              type="circle"
              paint={restaurantsCirclePaint}
              filter={scoreLayerFilter}
              layout={pinsLayerLayout}
            />
            <Layer
              id={RESTAURANTS_HIT_LAYER_ID}
              type="circle"
              paint={restaurantHitCirclePaint}
              filter={scoreLayerFilter}
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
                              score: popup.score,
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
                        <dt>Latest score</dt>
                        <dd>
                          <span className={scoreClassName(popup.score)}>
                            {popup.score != null && popup.score !== ''
                              ? popup.score
                              : '—'}
                          </span>
                          <span className="popup-score-band">
                            {scoreBandLabel(popup.score)}
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
                        Last visit {formatInspectionDate(popup.lastVisit)} (no
                        score)
                      </p>
                    )}
                    {saferNearby.length > 0 && (
                      <div className="popup-safer">
                        <h3>Safer nearby</h3>
                        <p className="popup-safer-hint">
                          Higher scores within {formatRadiusChip(SAFER_NEARBY_MILES)}
                        </p>
                        <ul className="popup-safer-list">
                          {saferNearby.map(({ r, miles, score }) => (
                            <li key={`safer-${r.business_id}`}>
                              <button
                                type="button"
                                className="popup-safer-btn"
                                onClick={() => handleSelectRankedRestaurant(r)}
                              >
                                <span className="popup-safer-name">
                                  {r.business_name}
                                </span>
                                <span className="popup-safer-meta">
                                  <span className="popup-safer-dist">
                                    {formatDistanceMiles(miles)}
                                  </span>
                                  <span
                                    className={`popup-safer-score ${scoreClassName(score)}`}
                                  >
                                    {score != null ? score : '—'}
                                  </span>
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {popup.fetchError && (
                      <p className="popup-note">
                        Could not load inspection data from the server.
                      </p>
                    )}
                    <div className="popup-violations">
                      <h3>Violations (latest scored inspection)</h3>
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
                              <span className={scoreClassName(insp.inspection_score)}>
                                {insp.inspection_score != null &&
                                insp.inspection_score !== ''
                                  ? insp.inspection_score
                                  : '—'}
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
            <div className={tooltipScoreClassName(hoverTooltip.score)}>
              {hoverTooltip.scoreLabel === 'No score'
                ? 'No score'
                : `Score ${hoverTooltip.scoreLabel} · ${scoreBandLabel(hoverTooltip.score)}`}
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
                        className={`sidebar-rank-score ${scoreClassName(r.latest_inspection_score)}`}
                      >
                        {r.latest_inspection_score != null &&
                        r.latest_inspection_score !== ''
                          ? r.latest_inspection_score
                          : '—'}
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
                  Avg latest score:{' '}
                  <strong>
                    {citywideStats.avg_latest_inspection_score != null
                      ? citywideStats.avg_latest_inspection_score
                      : '—'}
                  </strong>
                </p>
                {dataThrough && (
                  <p className="sidebar-muted">Scores through {dataThrough}</p>
                )}
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
                <p className="sidebar-chart-label">Lowest scores citywide</p>
                <p className="sidebar-help">
                  Most places score 90+. These are the inspections that stand
                  out.
                </p>
                {(citywideStats.lowest_restaurants || []).length === 0 ? (
                  <p className="sidebar-muted">No scored restaurants.</p>
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
                            className={`sidebar-rank-score ${scoreClassName(r.latest_inspection_score)}`}
                          >
                            {r.latest_inspection_score}
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
                        <button
                          type="button"
                          className="sidebar-rank-btn"
                          onClick={() => handleSelectRankedRestaurant(r)}
                          title={`Show ${r.business_name} on the map`}
                        >
                          <span className="sidebar-rank-name">{r.business_name}</span>
                          <span className={`sidebar-rank-score ${scoreClassName(r.latest_inspection_score)}`}>
                            {r.latest_inspection_score}
                          </span>
                        </button>
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
                      <li key={`bottom-${r.business_id}`}>
                        <button
                          type="button"
                          className="sidebar-rank-btn"
                          onClick={() => handleSelectRankedRestaurant(r)}
                          title={`Show ${r.business_name} on the map`}
                        >
                          <span className="sidebar-rank-name">{r.business_name}</span>
                          <span className={`sidebar-rank-score ${scoreClassName(r.latest_inspection_score)}`}>
                            {r.latest_inspection_score}
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
                      good: false,
                      mid: true,
                      bad: true,
                      noScore: false,
                    })
                  }
                >
                  Below 90
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
              Show dots by latest inspection score. 90+ is still good on the
              LIVES scale; colors get darker green as scores approach 100.
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
                min="50"
                max="100"
                step="1"
                value={dotStackTarget}
                aria-valuemin={50}
                aria-valuemax={100}
                aria-valuenow={dotStackTarget}
                aria-valuetext={stackBandLabel(dotStackTarget)}
                onChange={(e) => setDotStackTarget(Number(e.target.value))}
              />
              <div className="sidebar-stack-labels" aria-hidden>
                <span>Red</span>
                <span>Yellow</span>
                <span>Green</span>
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
            <span className="app-brand-sub">Health inspection scores</span>
          </span>
        </button>
        <div className="search-input-wrap">
          <input
            ref={searchInputRef}
            type="search"
            className="search-input"
            placeholder="Search restaurants or ZIP…"
            value={searchQuery}
            autoComplete="off"
            role="combobox"
            aria-label="Search restaurants or ZIP code"
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
        {searchZipHighlight && (
          <div className="search-zip-badge" role="status">
            <span className="search-zip-badge-text">
              Showing {searchZipRestaurantCount} restaurant
              {searchZipRestaurantCount === 1 ? '' : 's'} in {searchZipHighlight}
            </span>
            <button
              type="button"
              className="search-zip-badge-clear"
              onClick={clearSearch}
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
                    <span className={`search-result-score ${scoreClassName(r.latest_inspection_score)}`}>
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
        {nearbyAnchor && nearbyOpen && !showDropdown && !searchZipHighlight && (
          <div className="nearby-panel">
            <div className="nearby-panel-header">
              <div className="nearby-panel-heading">
                <h2 className="nearby-panel-title">
                  {nearbyAnchor.source === 'gps' ? 'Near you' : 'This view'}
                </h2>
                <p className="nearby-panel-count">
                  {formatNearbyCountLabel(
                    nearbyPlaces.length,
                    nearbyMatch.total,
                    nearbyRadiusMiles
                  )}
                </p>
              </div>
              <button
                type="button"
                className="nearby-panel-close"
                onClick={() => setNearbyOpen(false)}
                aria-label="Hide nearby list"
              >
                ×
              </button>
            </div>
            <div className="nearby-panel-tools">
              <div
                className="nearby-chip-row"
                role="radiogroup"
                aria-label="Straight-line radius"
              >
                {NEARBY_RADIUS_OPTIONS.map((miles) => (
                  <button
                    key={miles}
                    type="button"
                    role="radio"
                    className="nearby-chip"
                    aria-checked={nearbyRadiusMiles === miles}
                    onClick={() => setNearbyRadiusMiles(miles)}
                  >
                    {formatRadiusChip(miles)}
                  </button>
                ))}
              </div>
              <div
                className="nearby-chip-row"
                role="radiogroup"
                aria-label="Sort nearby restaurants"
              >
                <button
                  type="button"
                  role="radio"
                  className="nearby-chip"
                  aria-checked={nearbySort === 'distance'}
                  onClick={() => setNearbySort('distance')}
                >
                  Closest
                </button>
                <button
                  type="button"
                  role="radio"
                  className="nearby-chip"
                  aria-checked={nearbySort === 'score'}
                  onClick={() => setNearbySort('score')}
                >
                  Highest score
                </button>
              </div>
              <div className="nearby-chip-row">
                <button
                  type="button"
                  className={`nearby-chip${nearbyAnchor.source === 'map' ? ' is-on' : ''}`}
                  onClick={handleNearbyThisView}
                >
                  Use map center
                </button>
              </div>
            </div>
            {nearbyPlaces.length === 0 ? (
              <p className="nearby-panel-empty">
                No restaurants match the current score filters within{' '}
                {formatRadiusChip(nearbyRadiusMiles)}. Widen the radius or turn
                score bands back on.
              </p>
            ) : (
              <ul className="nearby-panel-list">
                {nearbyPlaces.map(({ r, miles, score }) => {
                  const selected =
                    popup?.businessId != null &&
                    String(popup.businessId) === String(r.business_id);
                  return (
                    <li key={`near-${r.business_id}`}>
                      <button
                        type="button"
                        className={`nearby-panel-btn${selected ? ' is-selected' : ''}`}
                        onClick={() => handleSelectRankedRestaurant(r)}
                      >
                        <span className="nearby-panel-name">
                          {isPinned(r.business_id) ? '★ ' : ''}
                          {r.business_name}
                        </span>
                        <span className="nearby-panel-meta">
                          <span className="nearby-panel-dist">
                            {formatDistanceMiles(miles)}
                          </span>
                          <span className={`nearby-panel-score ${scoreClassName(score)}`}>
                            {score != null ? score : '—'}
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
              Hotter areas are denser or have lower scores
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
              Inspection score ({restaurants.length})
            </div>
            <p className="map-legend-hint">
              {dataThrough
                ? `Through ${dataThrough}. ${stackLegendHint(dotStackTarget)}.`
                : stackLegendHint(dotStackTarget)}
            </p>
            <div className="legend-score-bar" aria-hidden />
            <div className="legend-heat-labels">
              <span>Low</span>
              <span>90</span>
              <span>100</span>
            </div>
          </>
        )}
        {mapLayerMode !== 'off' && (
          <>
            <div
              className="legend-filter-row"
              role="group"
              aria-label="Filter by inspection score"
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
                Show all scores
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
              Tap a pin for the latest inspection score, or search by name or
              ZIP.
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
