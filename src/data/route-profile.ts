import type { TerrainProvider } from 'cesium'
import { bearing, resample } from './geo'
import type { LatLon } from './geo'
import { sampleRaster } from './raster-sample'
import type { TileLoader } from './raster-sample'
import type { ScienceRaster } from './science-types'
import { sampleSurface } from './terrain-sample'

// Planning assumptions, not suit certifications. Lunar traverse studies plan
// walking routes under 20°. No Mars suit limit is published, so we use the
// same value and flag 15° as the start of caution.
export const SLOPE_CAUTION = 15
export const SLOPE_LIMIT = 20

export type ProfileSample = {
  d: number
  point: LatLon
  elevation: number | null
  slope: number | null
  layers: Record<string, number | null>
  // Terrain detail at the sample in meters, from the tile level available
  // there. Missing when the profile was built without it.
  detail?: number | null
}

export async function buildProfile(path: LatLon[], options: {
  provider: TerrainProvider
  rasters: ScienceRaster[]
  count?: number
  level?: number
  baseline?: number
  detail?: (point: LatLon) => number | null
  load?: TileLoader
}): Promise<ProfileSample[]> {
  const stations = resample(path, options.count ?? 160)
  const points = stations.map((s) => s.point)
  const [surface, ...layers] = await Promise.all([
    sampleSurface(options.provider, points, options.level, options.baseline),
    ...options.rasters.map((source) => sampleRaster(source, points, options.load)),
  ])
  return stations.map((station, i) => ({
    ...station,
    elevation: surface[i].elevation,
    slope: surface[i].slope,
    layers: Object.fromEntries(options.rasters.map((source, k) => [source.id, layers[k][i]])),
    detail: options.detail?.(station.point) ?? null,
  }))
}

// Caution starts 5° under the limit, as SLOPE_CAUTION does under SLOPE_LIMIT.
export function slopeLevel(slope: number | null, limit = SLOPE_LIMIT) {
  if (slope === null) return 'unknown'
  if (slope > limit) return 'hazard'
  if (slope >= limit - (SLOPE_LIMIT - SLOPE_CAUTION)) return 'caution'
  return 'ok'
}

export function summarize(samples: ProfileSample[]) {
  let climb = 0
  let descent = 0
  let overLimit = 0
  let caution = 0
  let maxSlope: number | null = null
  let low = Infinity
  let high = -Infinity
  for (let i = 0; i < samples.length; i++) {
    const { elevation, slope } = samples[i]
    if (elevation !== null) {
      low = Math.min(low, elevation)
      high = Math.max(high, elevation)
    }
    if (slope !== null) maxSlope = Math.max(maxSlope ?? 0, slope)
    if (i === 0) continue
    const previous = samples[i - 1]
    const step = samples[i].d - previous.d
    if (elevation !== null && previous.elevation !== null) {
      const rise = elevation - previous.elevation
      if (rise > 0) climb += rise
      else descent -= rise
    }
    const level = slopeLevel(slope)
    if (level === 'hazard') overLimit += step
    if (level === 'caution') caution += step
  }
  return {
    distance: samples.at(-1)?.d ?? 0,
    climb,
    descent,
    maxSlope,
    overLimit,
    caution,
    low: Number.isFinite(low) ? low : null,
    high: Number.isFinite(high) ? high : null,
  }
}

// Index of the sample closest to a distance along the route.
export function sampleIndexAt(samples: ProfileSample[], d: number) {
  let best = 0
  for (let i = 1; i < samples.length; i++) {
    if (Math.abs(samples[i].d - d) < Math.abs(samples[best].d - d)) best = i
  }
  return best
}

// Waypoints every `spacing` meters plus the end, for in-suit guidance.
// Planned routes pass their own waypoint distances as `marks` instead.
export function waypoints(samples: ProfileSample[], spacing = 250, marks?: number[]) {
  const total = samples.at(-1)?.d ?? 0
  const at: number[] = marks ? marks.filter((d) => d > 0 && d < total) : []
  if (!marks) for (let d = spacing; d < total; d += spacing) at.push(d)
  at.push(total)
  return at.map((d, i) => ({ index: i + 1, d, sample: samples[sampleIndexAt(samples, d)] }))
}

// Guidance from a position along the route to the next waypoint.
export function guidance(samples: ProfileSample[], at: number, spacing = 250, lookAhead = 100, marks?: number[]) {
  const here = samples[sampleIndexAt(samples, at)]
  const next = waypoints(samples, spacing, marks).find((w) => w.d > at + 1) ?? null
  const ahead = samples.filter((s) => s.d >= at && s.d <= at + lookAhead)
  const slopes = ahead.map((s) => s.slope).filter((s): s is number => s !== null)
  return {
    here,
    next,
    toNext: next ? next.d - at : 0,
    heading: next ? bearing(here.point, next.sample.point) : null,
    slopeAhead: slopes.length ? Math.max(...slopes) : null,
    remaining: (samples.at(-1)?.d ?? 0) - at,
  }
}
