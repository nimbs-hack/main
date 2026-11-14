/**
 * Canonical Mars coordinate convention for the entire repository:
 * - Latitude: planetocentric degrees in [-90, 90] (north positive).
 * - Longitude: east-positive degrees in [-180, 180).
 * - Reference body: Mars (2015) sphere, radius = 3,396,190 m (matches USGS HiRISE COGs).
 * - Distances and elevations: SI meters.
 */

export const MARS_RADIUS_M = 3_396_190;

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/** Planetocentric coordinates with east-positive longitude in [-180, 180). */
export interface MarsCoord {
  lat: number;
  lon: number;
}

/** Bounding box in [west, south, east, north] using normalized [-180, 180) east-positive lon. */
export type MarsBBox = [west: number, south: number, east: number, north: number];

/** Normalize any east-positive longitude (including 0..360) into [-180, 180). */
export function normalizeLon180(lonDeg: number): number {
  const wrapped = ((((lonDeg + 180) % 360) + 360) % 360) - 180;
  return wrapped === 180 ? -180 : wrapped;
}

/** Convert normalized [-180, 180) longitude to [0, 360) east-positive for display. */
export function lon180To360(lonDeg: number): number {
  return ((lonDeg % 360) + 360) % 360;
}

/** Clamp planetocentric latitude to [-90, 90]. */
export function clampLat(latDeg: number): number {
  return Math.max(-90, Math.min(90, latDeg));
}

/** Convert equirectangular (clon=0, lat_ts=0, sphere R=3396190) meters to planetocentric degrees. */
export function equirectangularToCoord(xMeters: number, yMeters: number): MarsCoord {
  const lon = normalizeLon180((xMeters / MARS_RADIUS_M) * RAD_TO_DEG);
  const lat = clampLat((yMeters / MARS_RADIUS_M) * RAD_TO_DEG);
  return { lat, lon };
}

/** Convert planetocentric degrees to equirectangular (clon=0, lat_ts=0, sphere R=3396190) meters. */
export function coordToEquirectangular(coord: MarsCoord): { xMeters: number; yMeters: number } {
  return {
    xMeters: normalizeLon180(coord.lon) * DEG_TO_RAD * MARS_RADIUS_M,
    yMeters: clampLat(coord.lat) * DEG_TO_RAD * MARS_RADIUS_M,
  };
}

/** Great-circle surface distance in meters between two planetocentric points on the Mars sphere. */
export function surfaceDistanceMeters(a: MarsCoord, b: MarsCoord): number {
  const lat1 = a.lat * DEG_TO_RAD;
  const lat2 = b.lat * DEG_TO_RAD;
  const dLat = (b.lat - a.lat) * DEG_TO_RAD;
  const dLon = normalizeLon180(b.lon - a.lon) * DEG_TO_RAD;

  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * MARS_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Approximate degrees of planetocentric latitude per meter on the Mars sphere. */
export function metersToLatDeg(meters: number): number {
  return (meters / MARS_RADIUS_M) * RAD_TO_DEG;
}

/** Approximate degrees of east-positive longitude per meter at a given planetocentric latitude. */
export function metersToLonDeg(meters: number, atLatDeg: number): number {
  const cosLat = Math.max(1e-6, Math.cos(atLatDeg * DEG_TO_RAD));
  return (meters / (MARS_RADIUS_M * cosLat)) * RAD_TO_DEG;
}
