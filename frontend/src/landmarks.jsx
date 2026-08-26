/** Orientation landmarks shown as circular pins with labels. */
export const LANDMARK_MIN_ZOOM = 11.15;

export const SF_LANDMARKS = [
  {
    id: 'golden-gate',
    name: 'Golden Gate Bridge',
    lng: -122.4783,
    lat: 37.8199,
    icon: 'bridge',
  },
  {
    id: 'alcatraz',
    name: 'Alcatraz',
    lng: -122.423,
    lat: 37.8267,
    icon: 'island',
  },
  {
    id: 'coit-tower',
    name: 'Coit Tower',
    lng: -122.4058,
    lat: 37.8024,
    icon: 'coit',
  },
  {
    id: 'ferry-building',
    name: 'Ferry Building',
    lng: -122.3937,
    lat: 37.7955,
    icon: 'ferry',
  },
  {
    id: 'transamerica',
    name: 'Transamerica Pyramid',
    lng: -122.4028,
    lat: 37.7952,
    icon: 'pyramid',
  },
  {
    id: 'palace',
    name: 'Palace of Fine Arts',
    lng: -122.4487,
    lat: 37.802,
    icon: 'palace',
  },
  {
    id: 'city-hall',
    name: 'City Hall',
    lng: -122.4193,
    lat: 37.7793,
    icon: 'dome',
  },
  {
    id: 'painted-ladies',
    name: 'Painted Ladies',
    lng: -122.4333,
    lat: 37.7763,
    icon: 'victorian',
  },
  {
    id: 'sutro-tower',
    name: 'Sutro Tower',
    lng: -122.4528,
    lat: 37.7552,
    icon: 'sutro',
  },
  {
    id: 'castro-theatre',
    name: 'The Castro Theatre',
    lng: -122.4349,
    lat: 37.762,
    icon: 'theatre',
  },
  {
    id: 'oracle-park',
    name: 'Oracle Park',
    lng: -122.3893,
    lat: 37.7786,
    icon: 'park',
  },
];

function LandmarkArt({ icon }) {
  switch (icon) {
    case 'bridge':
      return (
        <svg viewBox="0 0 64 64" aria-hidden>
          <rect width="64" height="64" rx="32" fill="#7dd3fc" />
          <rect y="38" width="64" height="26" fill="#38bdf8" />
          <path d="M6 40 L18 22 H22 L34 40" fill="#c2410c" />
          <path d="M30 40 L42 18 H46 L58 40" fill="#c2410c" />
          <rect x="17" y="16" width="6" height="28" fill="#ea580c" />
          <rect x="41" y="12" width="6" height="32" fill="#ea580c" />
          <path d="M8 32 H56" stroke="#9a3412" strokeWidth="2" />
          <path d="M20 22 Q32 30 44 18" fill="none" stroke="#9a3412" strokeWidth="1.5" />
        </svg>
      );
    case 'island':
      return (
        <svg viewBox="0 0 64 64" aria-hidden>
          <rect width="64" height="64" rx="32" fill="#7dd3fc" />
          <rect y="40" width="64" height="24" fill="#0ea5e9" />
          <ellipse cx="32" cy="44" rx="22" ry="8" fill="#a8a29e" />
          <rect x="22" y="24" width="20" height="16" fill="#e7e5e4" />
          <rect x="28" y="16" width="8" height="10" fill="#d6d3d1" />
          <rect x="18" y="30" width="6" height="10" fill="#d6d3d1" />
          <rect x="40" y="30" width="6" height="10" fill="#d6d3d1" />
        </svg>
      );
    case 'coit':
      return (
        <svg viewBox="0 0 64 64" aria-hidden>
          <rect width="64" height="64" rx="32" fill="#bae6fd" />
          <rect y="42" width="64" height="22" fill="#86efac" />
          <path d="M26 46 L28 14 H36 L38 46 Z" fill="#e7e5e4" />
          <rect x="29" y="10" width="6" height="6" fill="#d6d3d1" />
          <rect x="30" y="18" width="2" height="20" fill="#a8a29e" />
        </svg>
      );
    case 'ferry':
      return (
        <svg viewBox="0 0 64 64" aria-hidden>
          <rect width="64" height="64" rx="32" fill="#7dd3fc" />
          <rect y="40" width="64" height="24" fill="#38bdf8" />
          <rect x="14" y="28" width="36" height="16" fill="#f5f5f4" />
          <polygon points="28,12 36,12 40,28 24,28" fill="#e7e5e4" />
          <rect x="30" y="8" width="4" height="8" fill="#a8a29e" />
          <rect x="18" y="32" width="6" height="8" fill="#bae6fd" />
          <rect x="29" y="32" width="6" height="8" fill="#bae6fd" />
          <rect x="40" y="32" width="6" height="8" fill="#bae6fd" />
        </svg>
      );
    case 'pyramid':
      return (
        <svg viewBox="0 0 64 64" aria-hidden>
          <rect width="64" height="64" rx="32" fill="#bae6fd" />
          <rect y="44" width="64" height="20" fill="#94a3b8" />
          <polygon points="32,8 50,46 14,46" fill="#e7e5e4" />
          <polygon points="32,8 38,46 26,46" fill="#d6d3d1" />
        </svg>
      );
    case 'palace':
      return (
        <svg viewBox="0 0 64 64" aria-hidden>
          <rect width="64" height="64" rx="32" fill="#7dd3fc" />
          <rect y="42" width="64" height="22" fill="#86efac" />
          <path d="M14 42 A18 18 0 0 1 50 42" fill="none" stroke="#f5f5f4" strokeWidth="5" />
          <rect x="30" y="22" width="4" height="20" fill="#e7e5e4" />
          <circle cx="32" cy="20" r="4" fill="#e7e5e4" />
        </svg>
      );
    case 'dome':
      return (
        <svg viewBox="0 0 64 64" aria-hidden>
          <rect width="64" height="64" rx="32" fill="#bae6fd" />
          <rect y="44" width="64" height="20" fill="#86efac" />
          <rect x="16" y="32" width="32" height="16" fill="#f5f5f4" />
          <path d="M20 32 A12 12 0 0 1 44 32" fill="#e7e5e4" />
          <rect x="30" y="14" width="4" height="8" fill="#d6d3d1" />
          <circle cx="32" cy="13" r="3" fill="#facc15" />
        </svg>
      );
    case 'victorian':
      return (
        <svg viewBox="0 0 64 64" aria-hidden>
          <rect width="64" height="64" rx="32" fill="#bae6fd" />
          <rect y="44" width="64" height="20" fill="#86efac" />
          <rect x="10" y="30" width="12" height="18" fill="#f472b6" />
          <rect x="24" y="26" width="12" height="22" fill="#22d3ee" />
          <rect x="38" y="28" width="14" height="20" fill="#fbbf24" />
          <polygon points="10,30 16,22 22,30" fill="#be185d" />
          <polygon points="24,26 30,18 36,26" fill="#0e7490" />
          <polygon points="38,28 45,20 52,28" fill="#d97706" />
        </svg>
      );
    case 'sutro':
      return (
        <svg viewBox="0 0 64 64" aria-hidden>
          <rect width="64" height="64" rx="32" fill="#7dd3fc" />
          <rect y="46" width="64" height="18" fill="#4ade80" />
          <path d="M24 50 L30 10 H34 L40 50" fill="#f8fafc" />
          <path d="M24 50 L30 10 H34 L40 50" fill="none" stroke="#dc2626" strokeWidth="2" />
          <path d="M26 22 H38 M25 32 H39 M24 42 H40" stroke="#dc2626" strokeWidth="1.5" />
        </svg>
      );
    case 'theatre':
      return (
        <svg viewBox="0 0 64 64" aria-hidden>
          <rect width="64" height="64" rx="32" fill="#1e293b" />
          <rect x="12" y="28" width="40" height="24" fill="#e7e5e4" />
          <rect x="28" y="8" width="8" height="36" fill="#facc15" />
          <rect x="16" y="30" width="32" height="8" fill="#111827" />
          <rect x="18" y="42" width="6" height="8" fill="#7c3aed" />
          <rect x="29" y="42" width="6" height="8" fill="#7c3aed" />
          <rect x="40" y="42" width="6" height="8" fill="#7c3aed" />
        </svg>
      );
    case 'park':
      return (
        <svg viewBox="0 0 64 64" aria-hidden>
          <rect width="64" height="64" rx="32" fill="#86efac" />
          <ellipse cx="32" cy="36" rx="20" ry="14" fill="#15803d" />
          <ellipse cx="32" cy="36" rx="12" ry="8" fill="#166534" />
          <rect x="14" y="22" width="36" height="6" fill="#e7e5e4" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 64 64" aria-hidden>
          <rect width="64" height="64" rx="32" fill="#94a3b8" />
        </svg>
      );
  }
}

export function LandmarkPin({ name, icon, size }) {
  return (
    <div className="landmark-pin" style={{ width: size }}>
      <div className="landmark-pin-disc" style={{ width: size, height: size }}>
        <LandmarkArt icon={icon} />
      </div>
      <span className="landmark-pin-label">{name}</span>
    </div>
  );
}

export function landmarkPinSize(zoom) {
  if (zoom >= 14.5) return 56;
  if (zoom >= 13) return 50;
  if (zoom >= 12) return 44;
  return 38;
}
