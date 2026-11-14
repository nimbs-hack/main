import { Cartographic, sampleTerrain } from 'cesium'
import type { TerrainData, TerrainProvider } from 'cesium'
import { indexTerrainHeights } from './terrain-height'
import { offset } from './geo'
import type { LatLon } from './geo'
import { DATUM_OFFSET } from './terrain.js'

// Elevation and slope from the Mars Trek terrain mesh the globe renders.
// Elevation is meters above the MOLA areoid. Slope is the steepest slope at
// the point in degrees, from a centered difference over SLOPE_BASELINE.
// Trek blends MOLA, HRSC and HiRISE, so slope detail depends on location.

export const SLOPE_BASELINE = 60 // meters between the point and each neighbor

export function slopeFromNeighbors(north: number, south: number, east: number, west: number, spacing: number) {
  const dx = (east - west) / (2 * spacing)
  const dy = (north - south) / (2 * spacing)
  return Math.atan(Math.hypot(dx, dy)) * 180 / Math.PI
}

export type SurfaceSample = { elevation: number | null; slope: number | null }

// Sampling owns these tiles. Sharing mutable TerrainData with the renderer
// would let mesh creation discard the buffers while another caller uses them.
const samplers = new WeakMap<TerrainProvider, TerrainProvider>()

export function samplingProvider(provider: TerrainProvider): TerrainProvider {
  const existing = samplers.get(provider)
  if (existing) return existing
  const tiles = new Map<string, Promise<TerrainData>>()
  const sampler: TerrainProvider = Object.create(provider)
  sampler.requestTileGeometry = (x, y, level) => {
    // A single-layer Cesium provider still downloads tiles explicitly marked
    // absent. Skip those requests so sampleSurface can try its next level now.
    if (provider.getTileDataAvailable?.(x, y, level) === false) {
      return Promise.reject(new Error('Terrain tile outside measured coverage'))
    }
    const key = `${level}/${x}/${y}`
    const hit = tiles.get(key)
    if (hit) {
      tiles.delete(key)
      tiles.set(key, hit)
      return hit
    }
    const request = provider.requestTileGeometry(x, y, level)
    if (!request) return undefined
    const pending = request.then(indexTerrainHeights).catch((error: unknown) => {
      if (tiles.get(key) === pending) tiles.delete(key)
      throw error
    })
    tiles.set(key, pending)
    // Keep a bounded working set across the profile, tools and route edits.
    if (tiles.size > 64) tiles.delete(tiles.keys().next().value!)
    return pending
  }
  samplers.set(provider, sampler)
  return sampler
}

async function sampleAt(provider: TerrainProvider, level: number, points: LatLon[]) {
  const positions = points.flatMap((point) => [point,
    offset(point, SLOPE_BASELINE, 0), offset(point, -SLOPE_BASELINE, 0),
    offset(point, 0, SLOPE_BASELINE), offset(point, 0, -SLOPE_BASELINE),
  ].map(([lat, lon]) => Cartographic.fromDegrees(lon, lat)))
  const heights = (await sampleTerrain(samplingProvider(provider), level, positions)).map((c) => c.height)
  return points.map((_, i): SurfaceSample => {
    const [center, north, south, east, west] = heights.slice(i * 5, i * 5 + 5)
    const known = (h: number | undefined): h is number => typeof h === 'number' && Number.isFinite(h)
    return {
      elevation: known(center) ? center - DATUM_OFFSET : null,
      slope: [north, south, east, west].every(known)
        ? slopeFromNeighbors(north as number, south as number, east as number, west as number, SLOPE_BASELINE)
        : null,
    }
  })
}

// Tries a detailed level first, then coarser ones where tiles are missing.
export async function sampleSurface(provider: TerrainProvider, points: LatLon[], level = 14) {
  let samples = points.map((): SurfaceSample => ({ elevation: null, slope: null }))
  for (let current = level; current >= 8; current -= 2) {
    const missing = samples.map((s, i) => (s.elevation === null ? i : -1)).filter((i) => i >= 0)
    if (missing.length === 0) break
    const found = await sampleAt(provider, current, missing.map((i) => points[i])).catch(() => [])
    missing.forEach((index, k) => { if (found[k]) samples[index] = found[k] })
    samples = [...samples]
  }
  return samples
}
