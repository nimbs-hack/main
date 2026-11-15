import { Cartographic, sampleTerrain } from 'cesium'
import type { TerrainProvider } from 'cesium'
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

async function sampleAt(provider: TerrainProvider, level: number, points: LatLon[]) {
  const positions = points.flatMap((point) => [point,
    offset(point, SLOPE_BASELINE, 0), offset(point, -SLOPE_BASELINE, 0),
    offset(point, 0, SLOPE_BASELINE), offset(point, 0, -SLOPE_BASELINE),
  ].map(([lat, lon]) => Cartographic.fromDegrees(lon, lat)))
  const heights = (await sampleTerrain(provider, level, positions)).map((c) => c.height)
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

// The mesh level whose points are about ten times closer together than
// samples `spacing` meters apart, so a slope read there is the ground's and
// not the sampling's. Level 14 is about 10 m between mesh points, and each
// level down doubles that. Samples far apart read a coarse level, so a long
// route asks for no more tiles than a short one.
export function levelFor(spacing: number) {
  return Math.max(0, Math.min(14, Math.round(14 - Math.log2(Math.max(1, spacing / 100)))))
}

// Tries the level asked for first, then coarser ones where tiles are missing,
// down to level 8 or six levels under the one asked for. Coarser than that
// the mesh would be too smooth to stand in for it, and the point stays unknown.
export async function sampleSurface(provider: TerrainProvider, points: LatLon[], level = 14) {
  let samples = points.map((): SurfaceSample => ({ elevation: null, slope: null }))
  const floor = Math.max(0, Math.min(8, level - 6))
  for (let current = level; current >= floor; current -= 2) {
    const missing = samples.map((s, i) => (s.elevation === null ? i : -1)).filter((i) => i >= 0)
    if (missing.length === 0) break
    const found = await sampleAt(provider, current, missing.map((i) => points[i])).catch(() => [])
    missing.forEach((index, k) => { if (found[k]) samples[index] = found[k] })
    samples = [...samples]
  }
  return samples
}
