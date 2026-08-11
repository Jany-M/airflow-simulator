// ── Live local weather ─────────────────────────────────────────────────────
// Uses the browser Geolocation API for the user's position, then queries
// Open-Meteo (https://open-meteo.com) — free, open, no API key, CORS-enabled.
// Returns current wind speed/direction + temperature + relative humidity.

export interface GeoPlace {
  label: string;      // "Torre dell'Orso, Lecce, Italy"
  latitude: number;
  longitude: number;
}

const LOC_KEY = 'airflow-simulator:location:v1';
const LOC_KEY_LEGACY = 'airflow-planner:location:v1';

/** Manually chosen location (survives reloads). Null = use browser geolocation. */
export function loadSavedLocation(): GeoPlace | null {
  try {
    let raw = localStorage.getItem(LOC_KEY);
    if (!raw) {
      raw = localStorage.getItem(LOC_KEY_LEGACY);
      if (raw) {
        localStorage.setItem(LOC_KEY, raw);
        localStorage.removeItem(LOC_KEY_LEGACY);
      }
    }
    if (raw) {
      const p = JSON.parse(raw) as GeoPlace;
      if (p && typeof p.latitude === 'number' && typeof p.longitude === 'number' && p.label) return p;
    }
  } catch { /* ignore */ }
  return null;
}

export function saveLocation(p: GeoPlace | null) {
  try {
    if (p) localStorage.setItem(LOC_KEY, JSON.stringify(p));
    else localStorage.removeItem(LOC_KEY);
  } catch { /* ignore */ }
}

/**
 * Town/city search via the free Open-Meteo geocoding API (no key).
 * Use when browser geolocation lands in the wrong place — e.g. desktop on a
 * tethered/mobile connection resolves to the carrier's gateway city.
 */
export async function searchPlaces(query: string): Promise<GeoPlace[]> {
  const r = await fetch(
    'https://geocoding-api.open-meteo.com/v1/search' +
    `?name=${encodeURIComponent(query)}&count=6&language=en&format=json`,
  );
  if (!r.ok) throw new Error(`Location search failed (HTTP ${r.status}).`);
  const j = await r.json();
  const results: Array<{ name: string; admin1?: string; admin2?: string; country?: string; latitude: number; longitude: number }> =
    j.results ?? [];
  return results.map(res => ({
    label: [res.name, res.admin2 || res.admin1, res.country].filter(Boolean).join(', '),
    latitude: res.latitude,
    longitude: res.longitude,
  }));
}

export interface LocalWeather {
  windSpeed: number;   // m/s
  windFromDeg: number; // meteorological (direction wind comes FROM)
  temperature: number; // °C
  humidity: number;    // % RH
  latitude: number;
  longitude: number;
  time: string;
  /** "Torre dell'Orso, LE, Italy" — best effort, null if geocoding failed. */
  place: string | null;
}

/**
 * Reverse geocode → "Locality, Province, Country".
 * Primary: BigDataCloud client API (free, no key, made for browser use).
 * Fallback: OSM Nominatim. Both best-effort — a null just means we show
 * coordinates-free wording instead.
 */
async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  try {
    const r = await fetch(
      'https://api.bigdatacloud.net/data/reverse-geocode-client' +
      `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&localityLanguage=en`,
    );
    if (r.ok) {
      const j = await r.json();
      const town = j.locality || j.city;
      // Prefer a short province code like "LE" from the most specific
      // ISO 3166-2 admin entry (e.g. "IT-LE"); fall back to region name.
      let province: string | null = null;
      const admins: Array<{ adminLevel?: number; isoCode?: string; name?: string }> =
        j.localityInfo?.administrative ?? [];
      const iso = admins
        .filter(a => a.isoCode && /^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(a.isoCode))
        .sort((a, b) => (b.adminLevel ?? 0) - (a.adminLevel ?? 0))[0];
      if (iso?.isoCode) province = iso.isoCode.split('-')[1];
      else if (j.principalSubdivision) province = j.principalSubdivision;
      const parts = [town, province, j.countryName].filter(Boolean);
      if (parts.length) return parts.join(', ');
    }
  } catch { /* try fallback */ }
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&zoom=14&accept-language=en`,
    );
    if (r.ok) {
      const j = await r.json();
      const a = j.address ?? {};
      const town = a.village || a.town || a.city || a.hamlet || a.suburb;
      const isoKey = Object.keys(a).filter(k => k.startsWith('ISO3166-2-lvl')).sort().pop();
      const province = isoKey ? String(a[isoKey]).split('-')[1] : (a.county || a.state);
      const parts = [town, province, a.country].filter(Boolean);
      if (parts.length) return parts.join(', ');
    }
  } catch { /* give up gracefully */ }
  return null;
}

/** Current weather for explicit coordinates (used for manually set locations). */
export async function fetchWeatherAt(latitude: number, longitude: number, placeLabel?: string): Promise<LocalWeather> {
  const url =
    'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${latitude.toFixed(4)}&longitude=${longitude.toFixed(4)}` +
    '&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m' +
    '&wind_speed_unit=ms&timezone=auto';

  // Weather and place name fetched in parallel; the place is optional.
  const [res, place] = await Promise.all([
    fetch(url),
    placeLabel ? Promise.resolve(placeLabel) : reverseGeocode(latitude, longitude),
  ]);
  if (!res.ok) throw new Error(`Open-Meteo request failed (HTTP ${res.status}).`);
  const data = await res.json();
  const c = data?.current;
  if (!c || typeof c.wind_speed_10m !== 'number') {
    throw new Error('Open-Meteo returned an unexpected response.');
  }
  return {
    windSpeed: c.wind_speed_10m,
    windFromDeg: Math.round(c.wind_direction_10m ?? 0),
    temperature: c.temperature_2m,
    humidity: c.relative_humidity_2m,
    latitude, longitude,
    time: c.time ?? '',
    place,
  };
}

export async function fetchLocalWeather(): Promise<LocalWeather> {
  if (!('geolocation' in navigator)) {
    throw new Error('Geolocation is not available in this browser.');
  }
  const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      // High accuracy uses GPS/Wi-Fi positioning where available. Note that
      // desktops without GPS fall back to IP-based location, which can be far
      // off on tethered/mobile connections — the manual town search covers
      // that case.
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 0,
    }),
  ).catch((e: GeolocationPositionError) => {
    const why = e && e.code === 1
      ? 'location permission denied'
      : 'could not determine your position';
    throw new Error(`Geolocation failed: ${why}. (Tip: geolocation needs HTTPS or localhost — or set your town manually below.)`);
  });

  return fetchWeatherAt(pos.coords.latitude, pos.coords.longitude);
}
