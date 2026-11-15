import { expect, test } from 'bun:test'
import { distance, resample } from './geo'
import {
  DEFAULT_LIMITS, PRESETS, SUIT, WALK_BACK_REFERENCE, assess, suitLoad, formatDuration, insertWaypoint, legStats, moveVertex,
  planPath, presetFor, removeWaypoint, stepTime, stopPath, traverseTime, userWaypoints,
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

test('a step costs its length at the flat speed, plus height at the climb or descent rate', () => {
  const limits = { ...DEFAULT_LIMITS, pace: 1, climb: 0.1, descent: 0.25 }
  expect(stepTime(100, 0, limits)).toBeCloseTo(100, 6)
  expect(stepTime(100, 10, limits)).toBeCloseTo(100 + 10 / 0.1, 6)
  expect(stepTime(100, -10, limits)).toBeCloseTo(100 + 10 / 0.25, 6)
})

test('climbing out takes longer than coming back down', () => {
  const limits = { ...DEFAULT_LIMITS, pace: 1 }
  const path = [[0, 0], [0, 0.03]]
  const route = samples(path, { rise: (d) => d * 0.1 })
  expect(traverseTime(route, limits)).toBeGreaterThan(traverseTime(route, limits, true))
  const flat = samples(path)
  expect(traverseTime(flat, limits)).toBeCloseTo(flat.at(-1).d, 3)
})

test('with stops, legs run between the stops and the turns between them belong to a leg', () => {
  const path = [[0, 0], [0, 0.01], [0, 0.02], [0, 0.03], [0, 0.04]]
  const legs = legStats(samples(path), path, 20, [0, 2, 4])
  expect(legs).toHaveLength(2)
  expect(legs[0].length).toBeCloseTo(distance(path[0], path[2]), 0)
  expect(legs[1].to).toBeCloseTo(distance(path[0], path[4]), 0)
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
  expect(long.reasons.map((r) => r.text).join(' ')).toMatch(/walk back, limit/)
})

test('walk-back follows the route, not the straight line home', () => {
  // A dogleg: 2 km out along the equator, then 2 km north. The straight line
  // from the start is 2.8 km, the walk back 4 km.
  const path = [[0, 0], [0, 0.0337], [0.0337, 0.0337]]
  const limits = { ...DEFAULT_LIMITS, range: 3000, eva: 24 * 3600 }
  const result = assess(samples(path), path, limits)
  expect(result.maxFromStart).toBeLessThan(3000)
  expect(result.walkBack).toBeGreaterThan(3900)
  expect(result.reasons.map((r) => r.text)).toContain('4.0 km walk back, limit 3.0 km')
})

test('no preset allows more than the 10 km NASA walk-back', () => {
  for (const preset of PRESETS) expect(preset.limits.range).toBeLessThanOrEqual(WALK_BACK_REFERENCE)
})

test('suit load: flat ground is the base rate, climbing adds lifting work', () => {
  const path = [[0, 0], [0, 0.01]]
  const flat = samples(path)
  const total = traverseTime(flat, DEFAULT_LIMITS) * 2
  const level = suitLoad(flat, DEFAULT_LIMITS, total)
  expect(level.averageW).toBeCloseTo(SUIT.baseW, 6)
  expect(level.peakW).toBeCloseTo(SUIT.baseW, 6)
  // 240 mL drinking plus 625 mL cooling water per hour.
  expect(level.waterKg).toBeCloseTo(0.865 * total / 3600, 9)

  // Height climbed on the way out is descended on the way back: lifted once.
  const hill = samples(path, { rise: (d) => d / 10 })
  const height = hill.at(-1).elevation
  const climb = suitLoad(hill, DEFAULT_LIMITS, total)
  expect(climb.energyJ - level.energyJ).toBeCloseTo((SUIT.massKg * SUIT.gravity * height) / SUIT.efficiency, 3)
  expect(climb.peakW).toBeGreaterThan(SUIT.baseW)
})

test('a peak rate past the suit cooling range is a caution, never a no-go', () => {
  const path = [[0, 0], [0, 0.01]]
  const limits = { ...DEFAULT_LIMITS, climb: 2000 / 3600, slope: 35 }
  const steep = assess(samples(path, { rise: (d) => d / 2, slope: () => 10 }), path, limits)
  expect(steep.suit.peakW).toBeGreaterThan(SUIT.limitW)
  expect(steep.reasons.some((r) => r.level === 'caution' && /suit cooling range/.test(r.text))).toBe(true)
  expect(steep.reasons.some((r) => r.level === 'no-go' && /suit/.test(r.text))).toBe(false)
})

test('slopes near the limit and missing terrain are caution', () => {
  const path = [[0, 0], [0, 0.01]]
  expect(assess(samples(path, { slope: () => 17 }), path, DEFAULT_LIMITS).verdict).toBe('caution')
  expect(assess(samples(path, { slope: () => null }), path, DEFAULT_LIMITS).verdict).toBe('caution')
})

test('presets are recognized and durations read as hours and minutes', () => {
  expect(presetFor(PRESETS.find((preset) => preset.id === 'rover').limits)?.id).toBe('rover')
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
