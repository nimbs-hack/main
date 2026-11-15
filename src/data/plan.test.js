import { expect, test } from 'bun:test'
import { distance, resample } from './geo'
import {
  DEFAULT_LIMITS, PRESETS, assess, formatDuration, insertWaypoint, legStats, moveVertex,
  planPath, presetFor, removeWaypoint, stopPath, userWaypoints, walkSpeed, walkTime,
} from './plan'

// Flat ground along the equator, with an optional slope between two distances.
function samples(path, { count = 101, slope = () => 5, rise = () => 0 } = {}) {
  return resample(path, count).map((s) => ({ ...s, elevation: rise(s.d), slope: slope(s.d), layers: {} }))
}

test('plan path keeps walking order and skips missing ends', () => {
  expect(planPath({ start: null, target: null, waypoints: [] })).toEqual([])
  expect(planPath({ start: [0, 0], target: [0, 2], waypoints: [[0, 1]] })).toEqual([[0, 0], [0, 1], [0, 2]])
})

test('a waypoint goes into the leg it lengthens least', () => {
  const plan = { start: [0, 0], target: [0, 0.1], waypoints: [[0, 0.05]] }
  expect(insertWaypoint(plan, [0.001, 0.08]).waypoints).toEqual([[0, 0.05], [0.001, 0.08]])
  expect(insertWaypoint(plan, [0.001, 0.02]).waypoints).toEqual([[0.001, 0.02], [0, 0.05]])
  expect(removeWaypoint(plan, 0).waypoints).toEqual([])
})

test('moving a vertex updates the start, a waypoint or the target', () => {
  const plan = { start: [0, 0], target: [0, 0.1], waypoints: [[0, 0.05]] }
  expect(moveVertex(plan, 0, [1, 1]).start).toEqual([1, 1])
  expect(moveVertex(plan, 1, [1, 1]).waypoints).toEqual([[1, 1]])
  expect(moveVertex(plan, 2, [1, 1]).target).toEqual([1, 1])
})

test('walk speed is the pace on flat ground and slower up steep grades', () => {
  expect(walkSpeed(0, 1)).toBeCloseTo(1, 6)
  expect(walkSpeed(0.3, 1)).toBeLessThan(0.4)
  expect(walkSpeed(-0.05, 1)).toBeGreaterThan(1)
})

test('climbing out takes longer than walking back down', () => {
  const path = [[0, 0], [0, 0.03]]
  const route = samples(path, { rise: (d) => d * 0.1 })
  expect(walkTime(route, 1)).toBeGreaterThan(walkTime(route, 1, true))
  const flat = samples(path)
  expect(walkTime(flat, 1)).toBeCloseTo(flat.at(-1).d, 3)
})

test('legs split the slope stats at waypoints', () => {
  const path = [[0, 0], [0, 0.02], [0, 0.04]]
  const half = distance(path[0], path[1])
  const legs = legStats(samples(path, { slope: (d) => (d > half + 50 ? 25 : 5) }), path, 20)
  expect(legs).toHaveLength(2)
  expect(legs[0].over).toBe(0)
  expect(legs[1].over).toBeGreaterThan(0)
  expect(legs[1].maxSlope).toBe(25)
})

test('a short flat route is a go', () => {
  const path = [[0, 0], [0, 0.01]]
  const result = assess(samples(path), path, DEFAULT_LIMITS, 0.00067)
  expect(result.verdict).toBe('go')
  expect(result.reasons).toEqual([])
  expect(result.total).toBeCloseTo(result.timeOut + result.timeBack + DEFAULT_LIMITS.work, 6)
  expect(result.dose).toBeCloseTo(0.00067 * result.total / 86400, 12)
})

test('steep legs, long walks and far targets are no-go', () => {
  const path = [[0, 0], [0, 0.01]]
  const steep = assess(samples(path, { slope: () => 30 }), path, DEFAULT_LIMITS)
  expect(steep.verdict).toBe('no-go')
  expect(steep.reasons[0].text).toMatch(/^Leg 1: .* over 20°$/)

  const far = [[0, 0], [0, 0.2]]
  const long = assess(samples(far), far, DEFAULT_LIMITS)
  expect(long.verdict).toBe('no-go')
  expect(long.reasons.map((r) => r.text).join(' ')).toMatch(/budget/)
  expect(long.reasons.map((r) => r.text).join(' ')).toMatch(/walk-back limit/)
})

test('slopes near the limit and missing terrain are caution', () => {
  const path = [[0, 0], [0, 0.01]]
  expect(assess(samples(path, { slope: () => 17 }), path, DEFAULT_LIMITS).verdict).toBe('caution')
  expect(assess(samples(path, { slope: () => null }), path, DEFAULT_LIMITS).verdict).toBe('caution')
})

test('presets are recognized and durations read as hours and minutes', () => {
  expect(presetFor(PRESETS[0].limits)?.id).toBe('conservative')
  expect(presetFor({ ...DEFAULT_LIMITS, slope: 18 })).toBeNull()
  expect(formatDuration(45 * 60)).toBe('45 min')
  expect(formatDuration(3 * 3600)).toBe('3 h')
  expect(formatDuration(3 * 3600 + 5 * 60)).toBe('3 h 05 min')
})

test('legs on coarse terrain are a caution with the detail named', async () => {
  const { assess, DEFAULT_LIMITS: limits } = await import('./plan')
  const { resample } = await import('./geo')
  const path = [[0, 0], [0, 0.01]]
  const samples = resample(path, 51).map((s) => ({ ...s, elevation: 0, slope: 2, layers: {}, detail: s.d > 300 ? 326 : 1.3 }))
  const result = assess(samples, path, limits)
  expect(result.verdict).toBe('caution')
  expect(result.legs[0].coarsest).toBe(326)
  expect(result.reasons.map((r) => r.text).join()).toMatch(/^Leg 1: .* on 326 m terrain$/)
})

test('outside reasons merge, no-go first, and set the verdict', async () => {
  const { withReasons } = await import('./plan')
  const base = { verdict: 'caution', reasons: [{ level: 'caution', text: 'route' }] }
  const merged = withReasons(base, [{ level: 'no-go', text: 'storm' }])
  expect(merged.verdict).toBe('no-go')
  expect(merged.reasons.map((r) => r.text)).toEqual(['storm', 'route'])
  expect(withReasons(base, [])).toBe(base)
})

test('edits act on stops and drop the turn points of a picked route', () => {
  const turn = [0.002, 0.03]
  const plan = { start: [0, 0], target: [0, 0.1], waypoints: [turn, [0, 0.05], [0.002, 0.07]], generated: [turn, [0.002, 0.07]], route: 'fast' }
  expect(userWaypoints(plan)).toEqual([[0, 0.05]])
  expect(stopPath(plan)).toEqual([[0, 0], [0, 0.05], [0, 0.1]])
  const added = insertWaypoint(plan, [0.001, 0.08])
  expect(added.waypoints).toEqual([[0, 0.05], [0.001, 0.08]])
  expect(added.route).toBe('fast')
  expect(moveVertex(plan, 1, [1, 1]).waypoints).toEqual([[1, 1]])
  expect(removeWaypoint(plan, 0).waypoints).toEqual([])
})
