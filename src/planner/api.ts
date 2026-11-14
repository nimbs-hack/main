import type { MarsCoord, ComputedRoute, RoutePlanResponse, SiteMetadata } from '../../packages/shared/src'
import type { ProfileSample } from '../data/route-profile'

export type { MarsCoord, ComputedRoute, RoutePlanResponse, SiteMetadata }

export const ROUTE_LABELS: Record<ComputedRoute['strategy'], string> = {
  shortest: 'Shortest route',
  gentlest: 'Lower slopes',
  alternate: 'Alternate corridor',
  'weather-safe': 'More weather margin',
}

export async function request<T>(path: string, signal: AbortSignal, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    signal,
    ...(body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`)
  return data
}

// Planetocentric latitude and east-positive longitude in [-180, 180).
export function insideSite(point: MarsCoord, meta: SiteMetadata): boolean {
  const [west, south, east, north] = meta.bbox
  return Number.isFinite(point.lat) && Number.isFinite(point.lon) &&
    point.lat >= south && point.lat <= north && point.lon >= west && point.lon <= east
}

// Keep the planning DEM's elevations and grades. Display terrain is smoothed
// and may use another datum or resolution, so it must not replace route metrics.
export function routeProfile(route: ComputedRoute): ProfileSample[] {
  return route.points.map((point) => ({
    d: point.distanceM,
    point: [point.lat, point.lon],
    elevation: point.elevationM,
    slope: point.slopeDeg,
    ...(point.tempC === undefined ? {} : { tempC: point.tempC }),
    ...(point.pressurePa === undefined ? {} : { pressurePa: point.pressurePa }),
    layers: {},
  }))
}

// Earth hours as "1 h 25 min" for route cards.
export function formatHours(hours: number): string {
  const minutes = Math.max(0, Math.round(hours * 60))
  if (minutes < 60) return `${minutes} min`
  return minutes % 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes / 60} h`
}
