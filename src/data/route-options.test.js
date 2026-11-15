import { expect, test } from 'bun:test'
import { distance } from './geo'
import { DEFAULT_LIMITS } from './plan'
import {
  areaStats, buildGrid, findPath, gridSlopes, joinLegs, minRequiredSlope, overlapRatio, routeOptions, sameReason, simplify,
} from './route-options'

const start = [0, 0]
const target = [0, 0.05]

function field(grid, { elevation = () => 0, thermal = () => 0.5 } = {}) {
  const at = (i) => [Math.floor(i / grid.cols), i % grid.cols]
  const elev = grid.points.map((_, i) => elevation(...at(i)))
  return { elevation: elev, slope: gridSlopes(grid, elev), thermal: grid.points.map((_, i) => thermal(...at(i))) }
}

test('the grid puts start and target on nodes', () => {
  const grid = buildGrid(start, target)
  expect(grid.points[grid.start]).toEqual(start)
  expect(grid.points[grid.target][0]).toBeCloseTo(0, 6)
  expect(grid.points[grid.target][1]).toBeCloseTo(0.05, 6)
})

test('grid slope follows a uniform ramp', () => {
  const grid = buildGrid(start, target)
  const elevation = grid.points.map((_, i) => (i % grid.cols) * grid.cell * 0.1)
  expect(gridSlopes(grid, elevation)[grid.start]).toBeCloseTo(Math.atan(0.1) * 180 / Math.PI, 3)
})

test('on flat ground Fast is straight and the others collapse into it', () => {
  const grid = buildGrid(start, target)
  const plan = routeOptions(grid, field(grid), DEFAULT_LIMITS)
  expect(plan.status).toBe('ok')
  const [fast, ...rest] = plan.options
  expect(fast.waypoints).toHaveLength(0)
  expect(fast.distance).toBeCloseTo(grid.cell * 40, 0)
  // Flat repeats Fast. Thermal is left out: night IR is uniform. Detour
  // finds its own corridor.
  expect(rest.map((o) => [o.id, o.sameAs])).toEqual([['flat', 'Fast'], ['detour', null]])
})

test('steps steeper than the limit are walls, and blocked routes report the limit they need', () => {
  const grid = buildGrid(start, target)
  // A cliff across the whole grid between columns 29 and 30.
  const cliff = (r, c) => (c >= 30 ? grid.cell * Math.tan(40 * Math.PI / 180) : 0)
  const f = field(grid, { elevation: cliff })
  expect(findPath(grid, f, 'fast', 25)).toBeNull()
  const plan = routeOptions(grid, f, { ...DEFAULT_LIMITS, slope: 25 })
  expect(plan.status).toBe('blocked')
  // Crossing diagonally spreads the rise over √2 more ground.
  expect(plan.needs).toBeCloseTo(Math.atan(Math.tan(40 * Math.PI / 180) / Math.SQRT2) * 180 / Math.PI, 0)
})

test('paths go through the gap in a ridge', () => {
  const grid = buildGrid(start, target)
  // A ridge too steep to cross, open only in the top rows.
  const ridge = (r, c) => (c >= 28 && c < 32 && r > 2 ? 200 : 0)
  const plan = routeOptions(grid, field(grid, { elevation: ridge }), DEFAULT_LIMITS)
  expect(plan.status).toBe('ok')
  for (const option of plan.options) expect(option.maxSlope).toBeLessThanOrEqual(DEFAULT_LIMITS.slope)
  expect(plan.options[0].waypoints.length).toBeGreaterThan(0)
})

test('thermal keeps to ground that reads warm in night IR', () => {
  const grid = buildGrid(start, target)
  const band = (r) => (r <= 4 ? 1 : 0)
  const f = field(grid, { thermal: band })
  const plan = routeOptions(grid, f, DEFAULT_LIMITS)
  const thermal = plan.options.find((o) => o.id === 'thermal')
  expect(thermal.sameAs).toBeNull()
  const fast = findPath(grid, f, 'fast', 20)
  const mean = (nodes) => nodes.reduce((sum, i) => sum + f.thermal[i], 0) / nodes.length
  const path = findPath(grid, f, 'thermal', 20, { risk: f.thermal.map((t) => 1 - t) })
  expect(mean(path)).toBeGreaterThan(mean(fast))
})

test('overlap is the share of the shorter path in common', () => {
  expect(overlapRatio([1, 2, 3, 4], [3, 4, 5])).toBeCloseTo(2 / 3, 6)
  expect(overlapRatio([1, 2], [3, 4])).toBe(0)
})

test('minimax slope matches the steepest step on the easiest path', () => {
  const grid = buildGrid(start, target)
  const step = (r, c) => (c >= 30 ? grid.cell * Math.tan(12 * Math.PI / 180) : 0)
  // The easiest crossing is diagonal, which spreads the rise over √2 more ground.
  expect(minRequiredSlope(grid, field(grid, { elevation: step }))).toBeCloseTo(Math.atan(Math.tan(12 * Math.PI / 180) / Math.SQRT2) * 180 / Math.PI, 0)
})

test('identical routes on flat, uniform ground come with a reason', () => {
  const grid = buildGrid(start, target)
  expect(sameReason(areaStats(field(grid)))).toMatch(/night IR is uniform/)
})

test('simplify keeps the ends and drops collinear nodes', () => {
  const grid = buildGrid(start, target)
  const straight = Array.from({ length: 41 }, (_, k) => grid.start + k)
  expect(simplify(grid, straight, 0.5)).toEqual([grid.start, grid.target])
})

test('a finer grid keeps its proportions and puts the ends on nodes', () => {
  const grid = buildGrid(start, target, 160)
  expect(grid.cols).toBe(160 + 2 * 40 + 1)
  expect(grid.rows).toBe(2 * 56 + 1)
  expect(grid.points[grid.start]).toEqual(start)
  expect(grid.points[grid.target][1]).toBeCloseTo(0.05, 6)
})

test('legs join through the stop into one route per strategy', () => {
  const stop = [0.01, 0.03]
  const legs = [[start, stop], [stop, target]].map(([a, b]) => {
    const grid = buildGrid(a, b)
    return routeOptions(grid, field(grid), DEFAULT_LIMITS)
  })
  const joined = joinLegs(legs, [stop])
  expect(joined.status).toBe('ok')
  const fast = joined.options[0]
  expect(fast.waypoints).toEqual([...legs[0].options[0].waypoints, stop, ...legs[1].options[0].waypoints])
  expect(fast.generated).not.toContainEqual(stop)
  expect(fast.distance).toBeCloseTo(legs[0].options[0].distance + legs[1].options[0].distance, 6)
  expect(fast.line[0]).toEqual(legs[0].options[0].line[0])
  expect(fast.line.at(-1)).toEqual(legs[1].options[0].line.at(-1))
})

test('a blocked leg blocks the joined route and asks for the larger limit', () => {
  const ok = { status: 'ok', options: [] }
  expect(joinLegs([ok, { status: 'blocked', options: [], needs: 22 }, { status: 'blocked', options: [], needs: 27 }], [[0, 1], [0, 2]]))
    .toEqual({ status: 'blocked', options: [], needs: 27 })
})

test('a leg a quarter of the way around the planet still ends on its target', () => {
  const far = [30, 60]
  const grid = buildGrid(start, far)
  expect(grid.points[grid.target]).toEqual(far)
  // The node before the target is one cell short of it, along the same line.
  const before = grid.points[grid.target - 1]
  expect(distance(before, far) / grid.cell).toBeCloseTo(1, 6)
  expect((distance(start, before) + distance(before, far)) / distance(start, far)).toBeCloseTo(1, 9)
  // A node a row to the side is one cell off the line.
  expect(distance(grid.points[grid.start + grid.cols], start) / grid.cell).toBeCloseTo(1, 6)
})
