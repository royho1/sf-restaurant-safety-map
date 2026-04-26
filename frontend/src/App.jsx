import { useEffect, useMemo, useState } from 'react';
import Map, { Source, Layer } from 'react-map-gl';
import axios from 'axios';
import 'mapbox-gl/dist/mapbox-gl.css';

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;
const API_URL =
  'http://localhost:5001/api/restaurants?has_coordinates=true&limit=10000';

const SF_CENTER = {
  longitude: -122.4194,
  latitude: 37.7749,
  zoom: 12,
};

const RESTAURANTS_LAYER_ID = 'restaurants-layer';

// Circle color expression: green 90+, yellow 70-89, red <70, gray no score.
// `score` may be null/missing in feature properties; we default to -1 to fall
// into the "no score" bucket.
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

const layerStyle = {
  id: RESTAURANTS_LAYER_ID,
  type: 'circle',
  paint: {
    'circle-radius': 5,
    'circle-color': circleColorExpression,
    'circle-stroke-width': 1,
    'circle-stroke-color': '#ffffff',
    'circle-opacity': 0.9,
  },
};

function App() {
  const [restaurants, setRestaurants] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    axios
      .get(API_URL)
      .then((res) => {
        if (cancelled) return;
        // The API may return either an array or a paginated object. Handle both.
        const data = Array.isArray(res.data)
          ? res.data
          : res.data.results || res.data.restaurants || res.data.data || [];
        setRestaurants(data);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Failed to load restaurants:', err);
        setError(err.message || 'Failed to load restaurants');
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  const handleClick = (event) => {
    const feature = event.features && event.features[0];
    if (!feature) return;
    console.log('Restaurant clicked:', feature.properties);
  };

  if (!MAPBOX_TOKEN) {
    return (
      <div style={{ padding: 16 }}>
        Missing <code>VITE_MAPBOX_TOKEN</code>. Set it in{' '}
        <code>frontend/.env</code>.
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh' }}>
      <Map
        initialViewState={SF_CENTER}
        mapStyle="mapbox://styles/mapbox/streets-v12"
        mapboxAccessToken={MAPBOX_TOKEN}
        interactiveLayerIds={[RESTAURANTS_LAYER_ID]}
        onClick={handleClick}
        cursor="auto"
      >
        <Source id="restaurants" type="geojson" data={geojson}>
          <Layer {...layerStyle} />
        </Source>
      </Map>
      {error && (
        <div
          style={{
            position: 'absolute',
            top: 12,
            left: 12,
            padding: '8px 12px',
            background: 'rgba(239, 68, 68, 0.95)',
            color: 'white',
            borderRadius: 6,
            fontSize: 14,
          }}
        >
          {error}
        </div>
      )}
      <div
        style={{
          position: 'absolute',
          bottom: 24,
          left: 12,
          padding: '10px 12px',
          background: 'rgba(255,255,255,0.95)',
          borderRadius: 6,
          fontSize: 13,
          boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 6 }}>
          Inspection Score ({restaurants.length})
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
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
      <span
        style={{
          width: 12,
          height: 12,
          borderRadius: '50%',
          background: color,
          border: '1px solid white',
          boxShadow: '0 0 0 1px rgba(0,0,0,0.2)',
          display: 'inline-block',
        }}
      />
      <span>{label}</span>
    </div>
  );
}

export default App;
