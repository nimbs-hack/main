import { cumulative, distance } from './geo'
import type { LatLon } from './geo'
import type { Ground } from './ground'
import { slopeLevel } from './route-profile'
import { COARSE_DETAIL, detailLabel } from './terrain-detail'
import type { ProfileSample } from './route-profile'
import { SLOPE_BASELINE } from './terrain-sample'
import { formatDuration } from './duration'

// An EVA plan: walk from start through the waypoints to the target, work
// there, then walk the same path back. Coordinates are planetocentric
// latitude and east longitude, -180 to 180, as in src/data/geo.ts.
export type Plan = {
  // Optional UTC start from the Schedule tab.
  when?: string | null
  start: LatLon | null
  // Where the start came from, like "Curiosity · sol 5073". Null once moved.
  startName?: string | null
  target: LatLon | null
  // Every point between start and target in walking order: the user's stops
  // and, once a route is picked, the turn points it routes between them.
  waypoints: LatLon[]
  // Turn points from the picked route. They shape the path but get no handle
  // or number. Stops the user places are never here.
  generated?: LatLon[]
  // The picked route strategy. It stays picked while stops change, and the
  // new turn points replace the old ones once the route is found again.
  route?: string | null
}

// SI units: degrees for slope, m/s for the three speeds, seconds for time,
// meters for range. `pace` is speed over flat ground. `climb` and `descent`
// are vertical rates, meters of height per second. `rocks` and `ripples`
// are the share of `pace` kept on that ground, from 0 to 1.
export type Limits = {
  slope: number
  pace: number
  climb: number
  descent: number
  eva: number
  work: number
  range: number
  rocks: number
  ripples: number
}

export const EMPTY_PLAN: Plan = { start: null, target: null, waypoints: [] }

const perHour = (meters: number) => meters / 3600

// NASA-STD-3001 Vol 2 [V2 11030] rationale: suit water sized for "a 10-km
// walk-back in case of rover failure", from the Apollo Medical Summit. No
// preset may allow more.
export const WALK_BACK_REFERENCE = 10_000

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
//
// Speed on rough ground is the same share of the flat speed in every preset.
// Ripples are loose sand. Soule and Goldman (J Appl Physiol 1972) measured
// walking on loose sand at 2.1 times the energy of a paved road, and at the
// same effort that is 1 / sqrt(2.1) of the speed, by the speed-squared term
// of the Pandolf load carriage equation. The share on rocks is ASSUMED: no
// suited walking speed over rocks is published.
export const ROUGH_PACE = { rocks: 0.5, ripples: 0.69 }

export const PRESETS: { id: string, name: string, limits: Limits }[] = [
  { id: 'human', name: 'Human, EVA suit', limits: { slope: 7, pace: perHour(2500), climb: perHour(350), descent: perHour(800), eva: 4 * 3600, work: 60 * 60, range: 3000, ...ROUGH_PACE } },
  { id: 'rover', name: 'Rover, pressurized', limits: { slope: 15, pace: perHour(5000), climb: perHour(700), descent: perHour(1200), eva: 8 * 3600, work: 60 * 60, range: WALK_BACK_REFERENCE, ...ROUGH_PACE } },
  { id: 'conservative', name: 'Conservative', limits: { slope: 15, pace: 0.7, climb: perHour(350), descent: perHour(800), eva: 3 * 3600, work: 45 * 60, range: 1500, ...ROUGH_PACE } },
  { id: 'nominal', name: 'Nominal', limits: { slope: 20, pace: 0.85, climb: perHour(350), descent: perHour(800), eva: 4 * 3600, work: 60 * 60, range: 3000, ...ROUGH_PACE } },
  { id: 'extended', name: 'Extended', limits: { slope: 25, pace: 1, climb: perHour(350), descent: perHour(800), eva: 6 * 3600, work: 90 * 60, range: 5000, ...ROUGH_PACE } },
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

// True for a waypoint the route suggestion made rather than the user.
export function isGenerated(plan: Plan, point: LatLon) {
  return (plan.generated ?? []).some((p) => p[0] === point[0] && p[1] === point[1])
}

// Waypoints the user placed, in walking order. The route must visit each.
export function userWaypoints(plan: Plan): LatLon[] {
  return plan.waypoints.filter((point) => !isGenerated(plan, point))
}

// The plan with its turn points dropped, keeping the stops and the pick.
export function stopsOnly(plan: Plan): Plan {
  return plan.generated?.length ? { ...plan, waypoints: userWaypoints(plan), generated: [] } : plan
}

// Start, stops and target: the points the route has to pass, in order.
export function stopPath(plan: Plan): LatLon[] {
  return planPath(stopsOnly(plan))
}

// Puts the stop into the leg between stops where it adds the least walking.
// The edits below act on stops only and drop the old turn points.
export function insertWaypoint(input: Plan, point: LatLon): Plan {
  const plan = stopsOnly(input)
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

// Moves one vertex of stopPath(plan): 0 is the start, the last is the target.
export function moveVertex(input: Plan, index: number, point: LatLon): Plan {
  const plan = stopsOnly(input)
  const count = planPath(plan).length
  if (index === 0 && plan.start) return { ...plan, start: point, startName: null }
  if (index === count - 1 && plan.target) return { ...plan, target: point }
  const waypoints = [...plan.waypoints]
  waypoints[index - (plan.start ? 1 : 0)] = point
  return { ...plan, waypoints }
}

// Removes one stop, counted among the stops only.
export function removeWaypoint(input: Plan, index: number): Plan {
  const plan = stopsOnly(input)
  return { ...plan, waypoints: plan.waypoints.filter((_, i) => i !== index) }
}

// Seconds to cover `run` meters of ground while going up or down by `rise`
// meters. The model of the algorithms branch (evaluateEvaWeather in
// apps/api/src/weather/generator.ts): the distance at the flat speed, plus
// the height gained at the climb rate, plus the height lost at the descent
// rate. Rocks and ripples under the step slow the flat speed.
export function stepTime(run: number, rise: number, limits: Limits, ground?: Ground | null) {
  return run / groundPace(limits, ground) + Math.max(0, rise) / limits.climb + Math.max(0, -rise) / limits.descent
}

// Speed over the ground in m/s. Never faster than the flat speed, and never
// under a twentieth of it, so a zero in a limit cannot stop the clock.
export function groundPace(limits: Limits, ground?: Ground | null) {
  const share = ground === 'rocks' ? limits.rocks : ground === 'ripples' ? limits.ripples : 1
  return limits.pace * Math.min(1, Math.max(0.05, share))
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
    total += stepTime(run, reverse ? -rise : rise, limits, b.ground)
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
  // Distance on terrain coarser than COARSE_DETAIL, and the coarsest detail
  // on the leg in meters. Slope there is a smoothed lower bound.
  coarse: number
  coarsest: number | null
  // Distance over rocks and over ripples seen in HiRISE, and distance where
  // no image was read, so rocks there are unknown.
  rocks: number
  ripples: number
  unchecked: number
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
    coarse: 0,
    coarsest: null,
    rocks: 0,
    ripples: 0,
    unchecked: 0,
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
    if (s.detail != null) {
      leg.coarsest = Math.max(leg.coarsest ?? 0, s.detail)
      if (s.detail > COARSE_DETAIL) leg.coarse += step
    }
    // Undefined means the profile was built without a ground check.
    if (s.ground === 'rocks') leg.rocks += step
    else if (s.ground === 'ripples') leg.ripples += step
    else if (s.ground === null) leg.unchecked += step
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
  // Meters walked home from the farthest point, along the route, not in a
  // straight line. The walk-back limit applies to this.
  walkBack: number
  dose: number | null
  suit: SuitLoad
}

// In its own file so the HUD page can use it without the terrain code.
export { formatDuration }

// ESTIMATED suit load, from [V2 11037] and [V2 11038] of NASA-STD-3001 Vol 2:
// the system has to work out and show the suited crew's metabolic rate. We
// have no suit telemetry, so this is a planning model, not a measurement.
//
// Rate = a flat walking rate plus the work of lifting crew and suit up the
// climbs. The flat rate is the Apollo lunar EVA average, 234 kcal/h (Waligora
// and Horrigan, NASA TN D-7883, via NASA TM 1991). Lifting work follows Mars
// gravity and a muscle efficiency of 25%. Mass is ASSUMED: 80 kg crew plus
// 90 kg suit and pack, about an Apollo A7LB with its PLSS.
export const SUIT = {
  baseW: (234 * 4184) / 3600,
  massKg: 170,
  gravity: 3.711,
  efficiency: 0.25,
  // Top of the nominal suited range NASA-STD-3001 sizes heat rejection for,
  // 2220 kJ/h ([V2 11011] rationale).
  limitW: 2_220_000 / 3600,
  // BVAD (NASA/TP-2015-218570) Table 3-33 ratio of oxygen to food energy,
  // and Table 4-75 suit oxygen loss and cooling water per EVA hour.
  oxygenKgPerJ: 0.816 / 12.59e6,
  suitOxygenKgPerHour: 0.092,
  coolingKgPerHour: 0.625,
  // [V2 11030]: 240 mL of drinking water per EVA hour.
  drinkKgPerHour: 0.24,
}

export type SuitLoad = {
  // Watts. Average over the whole EVA, and the highest over one step.
  averageW: number
  peakW: number
  // Leg with the highest rate, counted on the way out.
  peakLeg: number | null
  energyJ: number
  oxygenKg: number
  waterKg: number
}

// Rate while climbing `rise` meters during `seconds`.
function stepRate(rise: number, seconds: number) {
  if (seconds <= 0) return SUIT.baseW
  return SUIT.baseW + (SUIT.massKg * SUIT.gravity * Math.max(0, rise)) / (SUIT.efficiency * seconds)
}

export function suitLoad(samples: ProfileSample[], limits: Limits, total: number, legs: Leg[] = []): SuitLoad {
  let climbed = 0
  let peakW = total > 0 ? SUIT.baseW : 0
  let peakAt = -1
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]
    const b = samples[i]
    const run = b.d - a.d
    if (run <= 0 || a.elevation === null || b.elevation === null) continue
    const rise = b.elevation - a.elevation
    // Both directions: what is a descent out is a climb back.
    climbed += Math.abs(rise)
    const rate = stepRate(Math.abs(rise), stepTime(run, Math.abs(rise), limits))
    if (rate > peakW) {
      peakW = rate
      peakAt = b.d
    }
  }
  const energyJ = SUIT.baseW * total + (SUIT.massKg * SUIT.gravity * climbed) / SUIT.efficiency
  const hours = total / 3600
  const peakLeg = peakAt < 0 ? null : legs.find((leg) => peakAt > leg.from && peakAt <= leg.to)?.index ?? null
  return {
    averageW: total > 0 ? energyJ / total : 0,
    peakW,
    peakLeg,
    energyJ,
    oxygenKg: energyJ * SUIT.oxygenKgPerJ + SUIT.suitOxygenKgPerHour * hours,
    waterKg: (SUIT.drinkKgPerHour + SUIT.coolingKgPerHour) * hours,
  }
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
  // The route comes back the way it went, so the farthest walk home is the
  // whole route from the target.
  const walkBack = samples.at(-1)?.d ?? 0
  const slopes = legs.map((leg) => leg.maxSlope).filter((s): s is number => s !== null)
  const reasons: Reason[] = []

  for (const leg of legs) {
    if (leg.over > 0) reasons.push({ level: 'no-go', text: `Leg ${leg.index}: ${meters(leg.over)} over ${limits.slope}°` })
  }
  if (total > limits.eva) {
    reasons.push({ level: 'no-go', text: `EVA ${formatDuration(total)}, budget ${formatDuration(limits.eva)}` })
  }
  if (walkBack > limits.range) {
    reasons.push({ level: 'no-go', text: `${meters(walkBack)} walk back, limit ${meters(limits.range)}` })
  }
  // Each sample measures slope over a short baseline. Farther apart than
  // that, the ground between two samples is not measured at all.
  const spacing = samples.length > 1 ? samples[1].d - samples[0].d : 0
  if (spacing > 2 * SLOPE_BASELINE) {
    reasons.push({ level: 'caution', text: `Slope checked every ${meters(spacing)}. Ground between is unknown` })
  }
  for (const leg of legs) {
    if (leg.over === 0 && leg.caution > 0) reasons.push({ level: 'caution', text: `Leg ${leg.index}: ${meters(leg.caution)} within 5° of limit` })
    if (leg.unknown > 0) reasons.push({ level: 'caution', text: `Leg ${leg.index}: no terrain for ${meters(leg.unknown)}` })
    if (leg.coarse > 0 && leg.coarsest !== null) {
      reasons.push({ level: 'caution', text: `Leg ${leg.index}: ${meters(leg.coarse)} on ${detailLabel(leg.coarsest)} terrain` })
    }
    // Read from image shadows, so these caution and never block.
    if (leg.rocks > 0) reasons.push({ level: 'caution', text: `Leg ${leg.index}: ${meters(leg.rocks)} over rocks` })
    if (leg.ripples > 0) reasons.push({ level: 'caution', text: `Leg ${leg.index}: ${meters(leg.ripples)} over ripples` })
    if (leg.unchecked > 0) reasons.push({ level: 'caution', text: `Leg ${leg.index}: no HiRISE image for ${meters(leg.unchecked)}. Rocks unknown` })
  }
  if (total <= limits.eva && total > limits.eva * 0.85) {
    reasons.push({ level: 'caution', text: `EVA uses ${Math.round((total / limits.eva) * 100)}% of the time budget` })
  }

  // An estimate, so it cautions and never blocks on its own.
  const suit = suitLoad(samples, limits, total, legs)
  if (suit.peakW > SUIT.limitW) {
    const where = suit.peakLeg ? `Leg ${suit.peakLeg}: ` : ''
    reasons.push({ level: 'caution', text: `${where}est. ${Math.round(suit.peakW)} W, over the ${Math.round(SUIT.limitW)} W suit cooling range` })
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
    walkBack,
    dose: doseRate === null ? null : doseRate * (total / 86400),
    suit,
  }
}

// Adds reasons from outside the route, such as space weather, and takes the
// worst verdict of the two.
export function withReasons(assessment: Assessment, extra: Reason[]): Assessment {
  if (!extra.length) return assessment
  const reasons = [...extra.filter((r) => r.level === 'no-go'), ...assessment.reasons, ...extra.filter((r) => r.level !== 'no-go')]
  const verdict: Verdict = reasons.some((r) => r.level === 'no-go') ? 'no-go' : reasons.some((r) => r.level === 'caution') ? 'caution' : 'go'
  return { ...assessment, reasons, verdict }
}
