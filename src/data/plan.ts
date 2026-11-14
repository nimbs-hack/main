import { cumulative, distance } from './geo'
import type { LatLon } from './geo'
import { slopeLevel } from './route-profile'
import type { ProfileSample } from './route-profile'

// An EVA plan: walk from start through the waypoints to the target, work
// there, then walk the same path back. Coordinates are planetocentric
// latitude and east longitude, -180 to 180, as in src/data/geo.ts.
export type Plan = {
  start: LatLon | null
  // Where the start came from, like "Curiosity · sol 5073". Null once moved.
  startName?: string | null
  target: LatLon | null
  waypoints: LatLon[]
}

// SI units: degrees for slope, m/s for the three speeds, seconds for time,
// meters for range. `pace` is speed over flat ground. `climb` and `descent`
// are vertical rates, meters of height per second.
export type Limits = {
  slope: number
  pace: number
  climb: number
  descent: number
  eva: number
  work: number
  range: number
}

export const EMPTY_PLAN: Plan = { start: null, target: null, waypoints: [] }

const perHour = (meters: number) => meters / 3600

// Planning assumptions, not suit certifications. No Mars suit limits are
// published.
//
// Human and Rover are the two traverse presets of the algorithms branch
// (TRAVERSE_PRESETS in packages/shared/src/types.ts): slope limit, flat,
// climb and descent speed, and longest EVA. Their work time and walk-back
// range are ASSUMED here, since that branch has neither.
//
// The other three came with the route planner. Their slope limits follow
// lunar traverse studies, and they use the algorithms branch's default
// climb and descent rates.
export const PRESETS: { id: string, name: string, limits: Limits }[] = [
  { id: 'human', name: 'Human, EVA suit', limits: { slope: 7, pace: perHour(2500), climb: perHour(350), descent: perHour(800), eva: 4 * 3600, work: 60 * 60, range: 3000 } },
  { id: 'rover', name: 'Rover, pressurized', limits: { slope: 15, pace: perHour(5000), climb: perHour(700), descent: perHour(1200), eva: 8 * 3600, work: 60 * 60, range: 20_000 } },
  { id: 'conservative', name: 'Conservative', limits: { slope: 15, pace: 0.7, climb: perHour(350), descent: perHour(800), eva: 3 * 3600, work: 45 * 60, range: 1500 } },
  { id: 'nominal', name: 'Nominal', limits: { slope: 20, pace: 0.85, climb: perHour(350), descent: perHour(800), eva: 4 * 3600, work: 60 * 60, range: 3000 } },
  { id: 'extended', name: 'Extended', limits: { slope: 25, pace: 1, climb: perHour(350), descent: perHour(800), eva: 6 * 3600, work: 90 * 60, range: 5000 } },
]

export const DEFAULT_PRESET = 'nominal'
export const DEFAULT_LIMITS = PRESETS.find((preset) => preset.id === DEFAULT_PRESET)!.limits

export function presetFor(limits: Limits) {
  return PRESETS.find((preset) => (Object.keys(limits) as (keyof Limits)[]).every((key) => preset.limits[key] === limits[key])) ?? null
}

// Start, waypoints and target in walking order. Missing ends are left out.
export function planPath(plan: Plan): LatLon[] {
  return [plan.start, ...plan.waypoints, plan.target].filter((point): point is LatLon => point !== null)
}

// Puts the point into the leg where it adds the least walking.
export function insertWaypoint(plan: Plan, point: LatLon): Plan {
  const path = planPath(plan)
  if (!plan.start || !plan.target) return { ...plan, waypoints: [...plan.waypoints, point] }
  let best = 0
  let bestDetour = Infinity
  for (let i = 0; i < path.length - 1; i++) {
    const detour = distance(path[i], point) + distance(point, path[i + 1]) - distance(path[i], path[i + 1])
    if (detour < bestDetour) {
      bestDetour = detour
      best = i
    }
  }
  const waypoints = [...plan.waypoints]
  waypoints.splice(best, 0, point)
  return { ...plan, waypoints }
}

// Moves one vertex of planPath(plan): 0 is the start, the last is the target.
export function moveVertex(plan: Plan, index: number, point: LatLon): Plan {
  const count = planPath(plan).length
  if (index === 0 && plan.start) return { ...plan, start: point, startName: null }
  if (index === count - 1 && plan.target) return { ...plan, target: point }
  const waypoints = [...plan.waypoints]
  waypoints[index - (plan.start ? 1 : 0)] = point
  return { ...plan, waypoints }
}

export function removeWaypoint(plan: Plan, index: number): Plan {
  return { ...plan, waypoints: plan.waypoints.filter((_, i) => i !== index) }
}

// Seconds to cover `run` meters of ground while going up or down by `rise`
// meters. The model of the algorithms branch (evaluateEvaWeather in
// apps/api/src/weather/generator.ts): the distance at the flat speed, plus
// the height gained at the climb rate, plus the height lost at the descent
// rate.
export function stepTime(run: number, rise: number, limits: Limits) {
  return run / limits.pace + Math.max(0, rise) / limits.climb + Math.max(0, -rise) / limits.descent
}

// Seconds to travel the samples in order, or in reverse for the way back.
export function traverseTime(samples: ProfileSample[], limits: Limits, reverse = false) {
  let total = 0
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]
    const b = samples[i]
    const run = b.d - a.d
    if (run <= 0) continue
    const rise = a.elevation !== null && b.elevation !== null ? b.elevation - a.elevation : 0
    total += stepTime(run, reverse ? -rise : rise, limits)
  }
  return total
}

export type Leg = {
  index: number
  from: number
  to: number
  length: number
  maxSlope: number | null
  over: number
  caution: number
  unknown: number
}

// Per-leg slope stats. Leg i runs from vertex i to vertex i + 1 of the path.
// With `stops`, the positions in `path` where legs end, a leg runs from one
// stop to the next and the vertices between them are only turns in it.
export function legStats(samples: ProfileSample[], path: LatLon[], limit: number, stops?: number[]): Leg[] {
  const every = cumulative(path)
  const along = stops ? stops.map((index) => every[index]) : every
  const total = samples.at(-1)?.d ?? 0
  // Samples come from a resampled path. Scale vertex distances to match.
  const scale = every.at(-1) ? total / every.at(-1)! : 1
  const legs: Leg[] = along.slice(0, -1).map((from, i) => ({
    index: i + 1,
    from: from * scale,
    to: along[i + 1] * scale,
    length: (along[i + 1] - from) * scale,
    maxSlope: null,
    over: 0,
    caution: 0,
    unknown: 0,
  }))
  if (!legs.length) return legs
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i]
    const step = s.d - samples[i - 1].d
    const mid = (s.d + samples[i - 1].d) / 2
    const leg = legs.find((l) => mid <= l.to) ?? legs.at(-1)!
    if (s.slope !== null) leg.maxSlope = Math.max(leg.maxSlope ?? 0, s.slope)
    const level = slopeLevel(s.slope, limit)
    if (level === 'hazard') leg.over += step
    else if (level === 'caution') leg.caution += step
    else if (level === 'unknown') leg.unknown += step
  }
  return legs
}

export type Verdict = 'go' | 'caution' | 'no-go'
export type Reason = { level: Verdict, text: string }

export type Assessment = {
  verdict: Verdict
  reasons: Reason[]
  legs: Leg[]
  distance: number
  timeOut: number
  timeBack: number
  total: number
  maxSlope: number | null
  maxFromStart: number
  dose: number | null
}

export function formatDuration(seconds: number) {
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const m = minutes % 60
  return `${Math.floor(minutes / 60)} h${m ? ` ${String(m).padStart(2, '0')} min` : ''}`
}

function meters(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(1)} km` : `${Math.round(value)} m`
}

/**
 * Go or no-go for walking the samples out and back. `doseRate` is in Sv/day
 * and is optional, since only one site has a measured value.
 */
export function assess(samples: ProfileSample[], path: LatLon[], limits: Limits, doseRate: number | null = null, stops?: number[]): Assessment {
  const legs = legStats(samples, path, limits.slope, stops)
  const timeOut = traverseTime(samples, limits)
  const timeBack = traverseTime(samples, limits, true)
  const total = timeOut + limits.work + timeBack
  const start = samples[0]?.point
  const maxFromStart = start ? Math.max(0, ...samples.map((s) => distance(start, s.point))) : 0
  const slopes = legs.map((leg) => leg.maxSlope).filter((s): s is number => s !== null)
  const reasons: Reason[] = []

  for (const leg of legs) {
    if (leg.over > 0) reasons.push({ level: 'no-go', text: `Leg ${leg.index}: ${meters(leg.over)} over ${limits.slope}°` })
  }
  if (total > limits.eva) {
    reasons.push({ level: 'no-go', text: `EVA ${formatDuration(total)}, budget ${formatDuration(limits.eva)}` })
  }
  if (maxFromStart > limits.range) {
    reasons.push({ level: 'no-go', text: `${meters(maxFromStart)} from start, walk-back limit ${meters(limits.range)}` })
  }
  for (const leg of legs) {
    if (leg.over === 0 && leg.caution > 0) reasons.push({ level: 'caution', text: `Leg ${leg.index}: ${meters(leg.caution)} within 5° of limit` })
    if (leg.unknown > 0) reasons.push({ level: 'caution', text: `Leg ${leg.index}: no terrain for ${meters(leg.unknown)}` })
  }
  if (total <= limits.eva && total > limits.eva * 0.85) {
    reasons.push({ level: 'caution', text: `EVA uses ${Math.round((total / limits.eva) * 100)}% of the time budget` })
  }

  const verdict: Verdict = reasons.some((r) => r.level === 'no-go') ? 'no-go' : reasons.length ? 'caution' : 'go'
  return {
    verdict,
    reasons,
    legs,
    distance: samples.at(-1)?.d ?? 0,
    timeOut,
    timeBack,
    total,
    maxSlope: slopes.length ? Math.max(...slopes) : null,
    maxFromStart,
    dose: doseRate === null ? null : doseRate * (total / 86400),
  }
}
