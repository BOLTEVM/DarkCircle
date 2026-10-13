/**
 * Parcel geometry: RFC 7946 polygon validation, area, and the projections the site's 2D plan and
 * 3D massing views use.
 */

export type Position = [number, number]; // [lng, lat]

export interface ParcelPolygon {
  type: 'Polygon';
  coordinates: Position[][];
}

export interface GeoResult {
  ok: boolean;
  polygon?: ParcelPolygon;
  error?: string;
}

/** A parcel boundary on chain is capped so a deed stays affordable to mint and to read. */
export const MAX_GEOJSON_BYTES = 16_384;
export const MAX_RING_VERTICES = 512;

export function parseParcelGeoJson(raw: string): GeoResult {
  if (!raw || !raw.trim()) return { ok: false, error: 'The boundary GeoJSON is empty.' };
  if (new TextEncoder().encode(raw).length > MAX_GEOJSON_BYTES) {
    return { ok: false, error: `The boundary GeoJSON is larger than ${MAX_GEOJSON_BYTES.toLocaleString('en-US')} bytes; simplify it.` };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'The boundary is not valid JSON.' };
  }
  const geometry = parsed?.type === 'Feature' ? parsed.geometry : parsed;
  if (!geometry || geometry.type !== 'Polygon' || !Array.isArray(geometry.coordinates)) {
    return { ok: false, error: 'The boundary must be a GeoJSON Polygon (or a Feature whose geometry is one).' };
  }
  const rings = geometry.coordinates as unknown[];
  if (rings.length === 0 || !Array.isArray(rings[0])) return { ok: false, error: 'The polygon has no outer ring.' };

  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    if (!Array.isArray(ring)) return { ok: false, error: `Ring ${r} is not a list of positions.` };
    if (ring.length < 4) return { ok: false, error: `Ring ${r} needs at least 4 positions (a closed triangle).` };
    if (ring.length > MAX_RING_VERTICES) return { ok: false, error: `Ring ${r} has more than ${MAX_RING_VERTICES} positions.` };
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      if (!Array.isArray(p) || p.length < 2) return { ok: false, error: `Ring ${r}, position ${i} is not [longitude, latitude].` };
      const [lng, lat] = p;
      if (typeof lng !== 'number' || typeof lat !== 'number' || !Number.isFinite(lng) || !Number.isFinite(lat)) {
        return { ok: false, error: `Ring ${r}, position ${i} is not numeric.` };
      }
      if (lng < -180 || lng > 180) return { ok: false, error: `Longitude ${lng} is outside -180..180.` };
      if (lat < -90 || lat > 90) return { ok: false, error: `Latitude ${lat} is outside -90..90.` };
    }
    const first = ring[0] as Position;
    const last = ring[ring.length - 1] as Position;
    if (first[0] !== last[0] || first[1] !== last[1]) {
      return { ok: false, error: `Ring ${r} is not closed: its first and last positions must be identical.` };
    }
  }
  const polygon: ParcelPolygon = { type: 'Polygon', coordinates: rings as Position[][] };
  if (ringAreaSqm(polygon.coordinates[0]!) < 1) return { ok: false, error: 'The outer ring encloses no area.' };
  return { ok: true, polygon };
}

const EARTH_RADIUS_M = 6_378_137;

/** Spherical-excess area of a closed ring in square metres (the formula GeoJSON tools use). */
export function ringAreaSqm(ring: Position[]): number {
  if (ring.length < 4) return 0;
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [lon1, lat1] = ring[i]!;
    const [lon2, lat2] = ring[i + 1]!;
    sum += toRad(lon2 - lon1) * (2 + Math.sin(toRad(lat1)) + Math.sin(toRad(lat2)));
  }
  return Math.abs((sum * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2);
}

/** Outer ring minus holes. */
export function parcelAreaSqm(polygon: ParcelPolygon): number {
  const [outer, ...holes] = polygon.coordinates;
  if (!outer) return 0;
  return Math.max(0, ringAreaSqm(outer) - holes.reduce((s, h) => s + ringAreaSqm(h), 0));
}

export function centroid(polygon: ParcelPolygon): { lng: number; lat: number } {
  const ring = polygon.coordinates[0] ?? [];
  const n = Math.max(ring.length - 1, 1); // the closing vertex repeats the first
  let lng = 0;
  let lat = 0;
  for (let i = 0; i < n; i++) {
    lng += ring[i]![0];
    lat += ring[i]![1];
  }
  return { lng: lng / n, lat: lat / n };
}

/** Outer ring in metres east (x) and north (z, negated for three.js) of the centroid. */
export function toLocalMetres(polygon: ParcelPolygon): { x: number; z: number }[] {
  const c = centroid(polygon);
  const mPerLat = 111_320;
  const mPerLng = 111_320 * Math.cos(toRad(c.lat));
  return (polygon.coordinates[0] ?? []).map(([lng, lat]) => ({ x: (lng - c.lng) * mPerLng, z: -(lat - c.lat) * mPerLat }));
}

/** Projects the outer ring into a width x height box, keeping the true aspect ratio. */
export function toViewBox(polygon: ParcelPolygon, width: number, height: number, padding = 0.08): Position[] {
  return projectParcel(polygon, width, height, padding).points;
}

/** Like toViewBox, plus how many metres one view-box unit spans (for a scale bar). */
export function projectParcel(polygon: ParcelPolygon, width: number, height: number, padding = 0.08): { points: Position[]; metresPerUnit: number } {
  const local = toLocalMetres(polygon);
  const xs = local.map((p) => p.x);
  const zs = local.map((p) => p.z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const spanX = maxX - minX || 1;
  const spanZ = maxZ - minZ || 1;
  const scale = Math.min((width * (1 - 2 * padding)) / spanX, (height * (1 - 2 * padding)) / spanZ);
  const offX = (width - spanX * scale) / 2;
  const offZ = (height - spanZ * scale) / 2;
  return {
    points: local.map((p) => [offX + (p.x - minX) * scale, offZ + (p.z - minZ) * scale] as Position),
    metresPerUnit: 1 / scale,
  };
}

/** A round scale-bar length (1, 2 or 5 x 10^n metres) close to `targetMetres`. */
export function niceScaleMetres(targetMetres: number): number {
  if (!(targetMetres > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(targetMetres));
  const n = targetMetres / pow;
  return (n >= 5 ? 5 : n >= 2 ? 2 : 1) * pow;
}

export function formatArea(sqm: number): string {
  if (sqm >= 10_000) return `${(sqm / 10_000).toLocaleString('en-US', { maximumFractionDigits: 2 })} ha`;
  return `${Math.round(sqm).toLocaleString('en-US')} m²`;
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}
