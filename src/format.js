// Mars maps conventionally use east longitude from 0 to 360.
export function formatLatLon(lat, lon) {
  const east = ((lon % 360) + 360) % 360
  const hemisphere = lat >= 0 ? 'N' : 'S'
  return `${Math.abs(lat).toFixed(3)}°${hemisphere}  ${east.toFixed(3)}°E`
}

const KM_PER_DEGREE = (2 * Math.PI * 3389.5) / 360
const DEGREES_PER_PIXEL_AT_ZOOM_0 = 360 / 512

export function formatScale(zoom) {
  const km = (KM_PER_DEGREE * DEGREES_PER_PIXEL_AT_ZOOM_0) / 2 ** zoom
  return km >= 1 ? `${km.toFixed(1)} km/px` : `${Math.round(km * 1000)} m/px`
}
