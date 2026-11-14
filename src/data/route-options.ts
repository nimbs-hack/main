import { bearing, distance, offset } from './geo'
import type { LatLon } from './geo'
import { stepTime } from './plan'
import type { Limits } from './plan'

// Route alternatives between a start and a target. A grid is laid along the
// start-to-target line and every node gets terrain elevation and a night IR
// value. The search is ported from TerrainGraph on the deploy-v1 branch
// (packages/shared/src/terrain/engine.ts): A* over 8-connected nodes, a hard
// slope limit per edge, four strategies, and overlap checks that drop
// near-duplicate routes. Coordinates are planetocentric latitude and east
// longitude, -180 to 180. Meters, SI.

export type Strategy = 'fast' | 'flat' | 'thermal' | 'detour'

// deploy-v1 names in brackets: shortest, gentlest, weather-safe, alternate.
export const STRATEGIES: { id: Strategy, name: string, note: string }[] = [
  { id: 'fast', name: 'Fast', note: 'Shortest path under the slope limit' },
  { id: 'flat', name: 'Flat', note: 'Lowest slopes under the limit' },
  { id: 'thermal', name: 'Thermal', note: 'Avoids ground that reads cold in night IR' },
  { id: 'detour', name: 'Detour', note: 'A separate corridor from the other routes' },
]

// Grid shape: steps between start and target, and extra steps around them.
const ALONG = 40
const MARGIN = 10
const HALF_WIDTH = 14

export type Grid = {
  cols: number
  rows: number
  cell: number
  points: LatLon[]
  start: number
  target: number
}

// Nodes on a grid aligned with the start-to-target line. Offsets are flat
// east and north meters, fine for routes of a few tens of kilometers.
export function buildGrid(start: LatLon, target: LatLon): Grid {
  const length = Math.max(1, distance(start, target))
  const cell = length / ALONG
  const heading = bearing(start, target) * Math.PI / 180
  const cols = ALONG + 2 * MARGIN + 1
  const rows = 2 * HALF_WIDTH + 1
  const points: LatLon[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const u = (c - MARGIN) * cell
      const v = (r - HALF_WIDTH) * cell
      points.push(offset(start, u * Math.cos(heading) - v * Math.sin(heading), u * Math.sin(heading) + v * Math.cos(heading)))
    }
  }
  const startIndex = HALF_WIDTH * cols + MARGIN
  return { cols, rows, cell, points, start: startIndex, target: startIndex + ALONG }
}

// Steepest slope at each node in degrees, from neighbors on the grid.
export function gridSlopes(grid: Grid, elevation: (number | null)[]) {
  const { cols, rows, cell } = grid
  const at = (r: number, c: number) => (r < 0 || c < 0 || r >= rows || c >= cols ? null : elevation[r * cols + c])
  return elevation.map((center, i) => {
    if (center === null) return null
    const r = Math.floor(i / cols)
    const c = i % cols
    const e = at(r, c + 1) ?? center
    const w = at(r, c - 1) ?? center
    const n = at(r + 1, c) ?? center
    const s = at(r - 1, c) ?? center
    const dx = (e - w) / (2 * cell)
    const dy = (n - s) / (2 * cell)
    return Math.atan(Math.hypot(dx, dy)) * 180 / Math.PI
  })
}

export type Field = {
  elevation: (number | null)[]
  slope: (number | null)[]
  thermal: (number | null)[]
}

// Night IR spread below this is noise, not a signal to route on.
const THERMAL_SIGNAL = 0.05

function quantile(values: number[], q: number) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
}

// What the ground around the route looks like. Costs are scaled to it, so
// gentle terrain still separates the strategies instead of reducing all of
// them to plain distance.
export type Area = {
  slopeTypical: number
  slopeSteep: number
  slopeMax: number
  thermalLow: number
  thermalHigh: number
}

export function areaStats(field: Field): Area {
  const slopes = field.slope.filter((s): s is number => s !== null)
  const thermal = field.thermal.filter((t): t is number => t !== null)
  return {
    slopeTypical: quantile(slopes, 0.5),
    slopeSteep: quantile(slopes, 0.9),
    slopeMax: slopes.length ? Math.max(...slopes) : 0,
    thermalLow: quantile(thermal, 0.05),
    thermalHigh: quantile(thermal, 0.95),
  }
}

// Why the strategies agree, when they do. Null when nothing explains it.
export function sameReason(area: Area) {
  const flat = area.slopeSteep - area.slopeTypical < 2
  const uniform = area.thermalHigh - area.thermalLow < THERMAL_SIGNAL
  if (flat && uniform) return `Ground here varies under ${Math.max(1, Math.ceil(area.slopeMax))}° and night IR is uniform at this resolution.`
  if (flat) return `Ground here varies under ${Math.max(1, Math.ceil(area.slopeMax))}° at this resolution.`
  return null
}

// deploy-v1 weights. THERMAL_GAIN is WEATHER_SAFE_THERMAL_GAIN there.
const GENTLE_WEIGHT = 4.5
const THERMAL_GAIN = 80
const THERMAL_SLOPE_WEIGHT = 0.5
const ALTERNATE_COST = 3.5
// A route is kept only when it shares less than this share of its nodes
// with every route found before it.
const KEEP_FLAT = 0.9
const KEEP_THERMAL = 0.88
const KEEP_DETOUR = 0.85

const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]]

class MinHeap {
  private nodes: number[] = []
  private scores: number[] = []
  get size() { return this.nodes.length }
  push(node: number, score: number) {
    this.nodes.push(node)
    this.scores.push(score)
    let i = this.nodes.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.scores[p] <= this.scores[i]) break
      this.swap(i, p)
      i = p
    }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.nodes[0], this.scores[0]]
    const node = this.nodes.pop()!
    const score = this.scores.pop()!
    if (this.nodes.length) {
      this.nodes[0] = node
      this.scores[0] = score
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < this.nodes.length && this.scores[l] < this.scores[m]) m = l
        if (r < this.nodes.length && this.scores[r] < this.scores[m]) m = r
        if (m === i) break
        this.swap(i, m)
        i = m
      }
    }
    return top
  }
  private swap(a: number, b: number) {
    ;[this.nodes[a], this.nodes[b]] = [this.nodes[b], this.nodes[a]]
    ;[this.scores[a], this.scores[b]] = [this.scores[b], this.scores[a]]
  }
}

const RAD = 180 / Math.PI

// Slope of the step between two nodes, from their elevations, in degrees.
function edgeSlope(dh: number, run: number) {
  return Math.atan(Math.abs(dh) / Math.max(1e-6, run)) * RAD
}

// Cold-at-night risk, 0 to 1, from night IR scaled across the area. Null when
// night IR barely varies, which leaves Thermal out, as deploy-v1 does
// without a weather field.
export function thermalRisk(field: Field) {
  const area = areaStats(field)
  const spread = area.thermalHigh - area.thermalLow
  if (spread < THERMAL_SIGNAL) return null
  return field.thermal.map((t) => (t === null ? 0.5 : 1 - Math.min(1, Math.max(0, (t - area.thermalLow) / spread))))
}

type SearchOptions = { risk?: number[] | null, penalty?: Uint8Array }

/**
 * A* from start to target. Steps steeper than the limit are impassable.
 * Every step costs at least its length, so the straight-line heuristic in
 * meters never overestimates.
 *
 * On deploy-v1 the grid is a 20 m elevation model, so the slope of a step
 * is the slope of the ground. Here a cell can be 200 m, and a step between
 * two nodes averages out a scarp that lies between them. So a node whose
 * own measured slope is over the limit is impassable too. The start and the
 * target are exempt: they are where the route has to go.
 */
export function findPath(grid: Grid, field: Field, strategy: Strategy, limit: number, options: SearchOptions = {}) {
  const { cols, rows, cell } = grid
  const total = cols * rows
  const elevation = field.elevation
  const g = new Float64Array(total).fill(Infinity)
  const parent = new Int32Array(total).fill(-1)
  const closed = new Uint8Array(total)
  const heap = new MinHeap()
  const tanMax = Math.tan(limit / RAD)
  const goalR = Math.floor(grid.target / cols)
  const goalC = grid.target % cols
  const h = (r: number, c: number) => Math.hypot(r - goalR, c - goalC) * cell
  if (elevation[grid.start] === null || elevation[grid.target] === null) return null

  g[grid.start] = 0
  heap.push(grid.start, h(Math.floor(grid.start / cols), grid.start % cols))
  while (heap.size) {
    const [u] = heap.pop()
    if (u === grid.target) {
      const path: number[] = []
      for (let i = u; i !== -1; i = parent[i]) path.push(i)
      return path.reverse()
    }
    if (closed[u]) continue
    closed[u] = 1
    const r = Math.floor(u / cols)
    const c = u % cols
    const eu = elevation[u]!
    for (const [dr, dc] of DIRS) {
      const nr = r + dr
      const nc = c + dc
      if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue
      const v = nr * cols + nc
      const ev = elevation[v]
      if (closed[v] || ev === null) continue
      if (v !== grid.target && (field.slope[v] ?? 0) > limit) continue
      const run = Math.hypot(dr, dc) * cell
      const dh = ev - eu
      if (Math.abs(dh) > run * tanMax + 1e-9) continue
      let step = run
      if (strategy === 'flat') {
        const ratio = edgeSlope(dh, run) / Math.max(1, limit)
        step = run * (1 + GENTLE_WEIGHT * ratio * ratio)
      } else if (strategy === 'thermal') {
        const ratio = edgeSlope(dh, run) / Math.max(1, limit)
        step = run * (1 + THERMAL_GAIN * (options.risk?.[v] ?? 0) + THERMAL_SLOPE_WEIGHT * ratio * ratio)
      } else if (strategy === 'detour' && options.penalty?.[v]) {
        step = run * ALTERNATE_COST
      }
      const next = g[u] + step
      if (next < g[v]) {
        g[v] = next
        parent[v] = u
        heap.push(v, next + h(nr, nc))
      }
    }
  }
  return null
}

/**
 * Lowest slope limit that still connects start and target: a minimax
 * Dijkstra where a path costs its steepest step. Rounded up to 0.1°.
 */
export function minRequiredSlope(grid: Grid, field: Field) {
  const { cols, rows, cell } = grid
  const best = new Float64Array(cols * rows).fill(Infinity)
  const visited = new Uint8Array(cols * rows)
  const heap = new MinHeap()
  if (field.elevation[grid.start] === null || field.elevation[grid.target] === null) return null
  best[grid.start] = 0
  heap.push(grid.start, 0)
  while (heap.size) {
    const [u, score] = heap.pop()
    if (u === grid.target) return Math.ceil(score * 10) / 10
    if (visited[u]) continue
    visited[u] = 1
    const r = Math.floor(u / cols)
    const c = u % cols
    for (const [dr, dc] of DIRS) {
      const nr = r + dr
      const nc = c + dc
      if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue
      const v = nr * cols + nc
      const ev = field.elevation[v]
      if (visited[v] || ev === null) continue
      // The ground at the node counts as well as the step to it, as in findPath.
      const ground = v === grid.target ? 0 : field.slope[v] ?? 0
      const slope = Math.max(best[u], ground, edgeSlope(ev - field.elevation[u]!, Math.hypot(dr, dc) * cell))
      if (slope < best[v]) {
        best[v] = slope
        heap.push(v, slope)
      }
    }
  }
  return null
}

// Share of the shorter path's nodes that the two paths have in common.
export function overlapRatio(a: number[], b: number[]) {
  const other = new Set(b)
  let shared = 0
  for (const node of a) if (other.has(node)) shared++
  return shared / Math.max(1, Math.min(a.length, b.length))
}

// Marks nodes within a square block around each path, ends excluded, so the
// Detour search pays extra to reuse those corridors.
function corridorPenalty(grid: Grid, paths: number[][]) {
  const { cols, rows } = grid
  const mask = new Uint8Array(cols * rows)
  const radius = Math.max(2, Math.min(8, Math.round(cols / 100)))
  for (const path of paths) {
    for (const i of path) {
      if (i === grid.start || i === grid.target) continue
      const r = Math.floor(i / cols)
      const c = i % cols
      for (let dr = -radius; dr <= radius; dr++) {
        const nr = r + dr
        if (nr < 0 || nr >= rows) continue
        for (let dc = -radius; dc <= radius; dc++) {
          const nc = c + dc
          if (nc >= 0 && nc < cols) mask[nr * cols + nc] = 1
        }
      }
    }
  }
  return mask
}

// Douglas-Peucker on node indices, in grid units, keeping both ends.
export function simplify(grid: Grid, nodes: number[], tolerance: number): number[] {
  if (nodes.length < 3) return nodes
  const xy = (i: number) => [i % grid.cols, Math.floor(i / grid.cols)]
  const [ax, ay] = xy(nodes[0])
  const [bx, by] = xy(nodes.at(-1)!)
  const length = Math.hypot(bx - ax, by - ay) || 1
  let worst = 0
  let index = 0
  for (let k = 1; k < nodes.length - 1; k++) {
    const [px, py] = xy(nodes[k])
    const d = Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / length
    if (d > worst) {
      worst = d
      index = k
    }
  }
  if (worst <= tolerance) return [nodes[0], nodes.at(-1)!]
  return [...simplify(grid, nodes.slice(0, index + 1), tolerance).slice(0, -1), ...simplify(grid, nodes.slice(index), tolerance)]
}

export type RouteOption = {
  id: Strategy
  name: string
  note: string
  // Interior turn points, ready to become plan waypoints.
  waypoints: LatLon[]
  // Every node on the path, for drawing.
  line: LatLon[]
  distance: number
  time: number
  maxSlope: number | null
  // Name of the earlier route this one overlaps, when it was dropped as a
  // near-duplicate. Its line and numbers are those of the earlier route.
  sameAs: string | null
}

export type RoutePlan =
  | { status: 'ok', options: RouteOption[] }
  // No path under the limit. `needs` is the lowest limit that has one.
  | { status: 'blocked', options: [], needs: number | null }

// Most turn points a suggested route may hand to the plan.
const MAX_WAYPOINTS = 10

function summarize(grid: Grid, field: Field, nodes: number[], limits: Limits, strategy: typeof STRATEGIES[number]): RouteOption {
  let tolerance = 0.75
  let turns = simplify(grid, nodes, tolerance)
  while (turns.length - 2 > MAX_WAYPOINTS) {
    tolerance *= 1.5
    turns = simplify(grid, nodes, tolerance)
  }
  let length = 0
  let time = 0
  let maxSlope: number | null = null
  for (let k = 1; k < nodes.length; k++) {
    const a = nodes[k - 1]
    const b = nodes[k]
    const run = distance(grid.points[a], grid.points[b])
    const rise = (field.elevation[b] ?? 0) - (field.elevation[a] ?? 0)
    length += run
    time += stepTime(run, rise, limits)
    maxSlope = Math.max(maxSlope ?? 0, edgeSlope(rise, run))
  }
  return {
    ...strategy,
    waypoints: turns.slice(1, -1).map((i) => grid.points[i]),
    line: nodes.map((i) => grid.points[i]),
    distance: length,
    time,
    maxSlope,
    sameAs: null,
  }
}

/**
 * Up to four routes, as planRoutes on deploy-v1 builds them: Fast first,
 * Flat if it differs from Fast, Thermal if night IR varies and it differs
 * from both, then Detour through a corridor the others don't use. A route
 * that overlaps an earlier one too much comes back marked `sameAs`.
 */
export function routeOptions(grid: Grid, field: Field, limits: Limits): RoutePlan {
  const limit = Math.max(0.5, Math.min(89, limits.slope))
  const meta = (id: Strategy) => STRATEGIES.find((s) => s.id === id)!
  const fastPath = findPath(grid, field, 'fast', limit)
  if (!fastPath) return { status: 'blocked', options: [], needs: minRequiredSlope(grid, field) }

  const fast = summarize(grid, field, fastPath, limits, meta('fast'))
  const options: RouteOption[] = [fast]
  const found: { path: number[], option: RouteOption }[] = [{ path: fastPath, option: fast }]
  const consider = (id: Strategy, path: number[] | null, keepBelow: number) => {
    if (!path) return
    const overlaps = found.map((f) => ({ f, ratio: overlapRatio(path, f.path) }))
    const twin = overlaps.find((o) => o.ratio >= keepBelow)
    if (twin) {
      options.push({ ...twin.f.option, ...meta(id), sameAs: twin.f.option.name })
      return
    }
    const option = summarize(grid, field, path, limits, meta(id))
    options.push(option)
    found.push({ path, option })
  }

  consider('flat', findPath(grid, field, 'flat', limit), KEEP_FLAT)
  const risk = thermalRisk(field)
  if (risk) consider('thermal', findPath(grid, field, 'thermal', limit, { risk }), KEEP_THERMAL)
  const penalty = corridorPenalty(grid, found.map((f) => f.path))
  consider('detour', findPath(grid, field, 'detour', limit, { penalty }), KEEP_DETOUR)
  return { status: 'ok', options }
}
