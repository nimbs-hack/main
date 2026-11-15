import type { MarsCoord } from "./coords";
import {
  SOIL_SPEED_FACTOR_MAX,
  SOIL_SPEED_FACTOR_MIN,
  type SoilSpeedFactors,
  type SoilTypeId,
  resolveSoilSpeedFactors,
} from "./soil";
import type { ComputedRoute, EvaWeatherLimits, TraversePointSample } from "./types";

export type MissionUnitId = 1 | 2;

export interface RouteTimelineSample {
  elapsedHours: number;
  distanceM: number;
  lat: number;
  lon: number;
  elevationM: number;
  slopeDeg: number;
  soilType: SoilTypeId;
  soilSpeedFactor: number;
  /** Effective horizontal progress speed over this segment in meters per hour. */
  speedMPerH: number;
}

export interface UnitTraverseTimeline {
  unitId: MissionUnitId;
  totalDurationHours: number;
  totalDistanceM: number;
  maxSlopeDeg: number;
  samples: RouteTimelineSample[];
}

export interface UnitSimulationSample {
  unitId: MissionUnitId;
  elapsedHours: number;
  remainingHours: number;
  totalDurationHours: number;
  progressRatio: number;
  arrived: boolean;
  lat: number;
  lon: number;
  elevationM: number;
  distanceM: number;
  slopeDeg: number;
  soilType: SoilTypeId;
  soilSpeedFactor: number;
  speedMPerH: number;
}

export function resolvePointSoilFactor(
  point: Pick<TraversePointSample, "soilType" | "soilSpeedFactor">,
  factors: SoilSpeedFactors,
): number {
  if (point.soilType) {
    return factors[point.soilType];
  }
  if (
    point.soilSpeedFactor !== undefined &&
    Number.isFinite(point.soilSpeedFactor) &&
    point.soilSpeedFactor > 0
  ) {
    return Math.max(SOIL_SPEED_FACTOR_MIN, Math.min(SOIL_SPEED_FACTOR_MAX, point.soilSpeedFactor));
  }
  return 1;
}

export function computeSegmentHours(
  distM: number,
  gainM: number,
  lossM: number,
  limits: Pick<EvaWeatherLimits, "flatSpeedMPerH" | "climbSpeedMPerH" | "descentSpeedMPerH">,
  soilMultiplier = 1,
): number {
  const effectiveFlatSpeed =
    Math.max(1e-6, limits.flatSpeedMPerH) *
    Math.max(SOIL_SPEED_FACTOR_MIN, Math.min(SOIL_SPEED_FACTOR_MAX, soilMultiplier));
  return (
    distM / effectiveFlatSpeed +
    gainM / Math.max(1e-6, limits.climbSpeedMPerH) +
    lossM / Math.max(1e-6, limits.descentSpeedMPerH)
  );
}

/**
 * Build a monotonic elapsed-time timeline along every node of a computed route
 * using active speeds and per-soil multipliers.
 */
export function buildUnitTraverseTimeline(
  unitId: MissionUnitId,
  route: ComputedRoute,
  limits: EvaWeatherLimits,
  targetTotalHours?: number | null,
): UnitTraverseTimeline {
  const factors = resolveSoilSpeedFactors(limits.soilSpeedFactors);
  const pts = route.points;

  if (pts.length === 0) {
    return {
      unitId,
      totalDurationHours: 0,
      totalDistanceM: route.totalDistanceM,
      maxSlopeDeg: route.maxSlopeDeg,
      samples: [],
    };
  }

  const first = pts[0];
  if (!first) {
    return {
      unitId,
      totalDurationHours: 0,
      totalDistanceM: route.totalDistanceM,
      maxSlopeDeg: route.maxSlopeDeg,
      samples: [],
    };
  }
  const firstFactor = resolvePointSoilFactor(first, factors);
  const samples: RouteTimelineSample[] = [
    {
      elapsedHours: 0,
      distanceM: first.distanceM,
      lat: first.lat,
      lon: first.lon,
      elevationM: first.elevationM,
      slopeDeg: first.slopeDeg,
      soilType: first.soilType ?? "coarse-regolith",
      soilSpeedFactor: firstFactor,
      speedMPerH: limits.flatSpeedMPerH * firstFactor,
    },
  ];

  let cumHours = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const prev = pts[i - 1];
    const curr = pts[i];
    if (!prev || !curr) continue;
    const dDist = Math.max(0, curr.distanceM - prev.distanceM);
    const dElev = curr.elevationM - prev.elevationM;
    const gain = Math.max(0, dElev);
    const loss = Math.max(0, -dElev);
    const prevFactor = resolvePointSoilFactor(prev, factors);
    const currFactor = resolvePointSoilFactor(curr, factors);
    const segFactor = (prevFactor + currFactor) * 0.5;
    const dt = computeSegmentHours(dDist, gain, loss, limits, segFactor);
    cumHours += dt;
    const speedMPerH = dt > 1e-9 ? dDist / dt : limits.flatSpeedMPerH * currFactor;

    samples.push({
      elapsedHours: cumHours,
      distanceM: curr.distanceM,
      lat: curr.lat,
      lon: curr.lon,
      elevationM: curr.elevationM,
      slopeDeg: curr.slopeDeg,
      soilType: curr.soilType ?? prev.soilType ?? "coarse-regolith",
      soilSpeedFactor: currFactor,
      speedMPerH,
    });
  }

  const headSample = samples[0];
  const secondSample = samples[1];
  if (headSample && secondSample) {
    headSample.speedMPerH = secondSample.speedMPerH;
  }

  if (
    targetTotalHours !== null &&
    targetTotalHours !== undefined &&
    Number.isFinite(targetTotalHours) &&
    targetTotalHours > 0 &&
    cumHours > 1e-6 &&
    Math.abs(cumHours - targetTotalHours) > 1e-4
  ) {
    const scale = targetTotalHours / cumHours;
    for (let i = 0; i < samples.length; i += 1) {
      const s = samples[i];
      if (!s) continue;
      s.elapsedHours *= scale;
      if (i > 0) {
        s.speedMPerH /= scale;
      }
    }
    if (headSample && secondSample) {
      headSample.speedMPerH = secondSample.speedMPerH;
    }
    cumHours = targetTotalHours;
  }

  return {
    unitId,
    totalDurationHours: cumHours,
    totalDistanceM: route.totalDistanceM,
    maxSlopeDeg: route.maxSlopeDeg,
    samples,
  };
}

/** Sample interpolated spatial and kinematic state of a unit at `elapsedHours`. */
export function sampleUnitTimelineAt(
  timeline: UnitTraverseTimeline,
  elapsedHours: number,
): UnitSimulationSample | null {
  const { samples, totalDurationHours, totalDistanceM, unitId } = timeline;
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last) return null;
  const clampedT = Math.max(0, elapsedHours);

  if (samples.length === 1 || totalDurationHours <= 1e-9) {
    return {
      unitId,
      elapsedHours: 0,
      remainingHours: 0,
      totalDurationHours: 0,
      progressRatio: 1,
      arrived: true,
      lat: last.lat,
      lon: last.lon,
      elevationM: last.elevationM,
      distanceM: last.distanceM,
      slopeDeg: 0,
      soilType: last.soilType,
      soilSpeedFactor: last.soilSpeedFactor,
      speedMPerH: 0,
    };
  }

  if (clampedT <= 0) {
    return {
      unitId,
      elapsedHours: 0,
      remainingHours: totalDurationHours,
      totalDurationHours,
      progressRatio: 0,
      arrived: false,
      lat: first.lat,
      lon: first.lon,
      elevationM: first.elevationM,
      distanceM: 0,
      slopeDeg: first.slopeDeg,
      soilType: first.soilType,
      soilSpeedFactor: first.soilSpeedFactor,
      speedMPerH: first.speedMPerH,
    };
  }

  if (clampedT >= totalDurationHours - 1e-7) {
    return {
      unitId,
      elapsedHours: totalDurationHours,
      remainingHours: 0,
      totalDurationHours,
      progressRatio: 1,
      arrived: true,
      lat: last.lat,
      lon: last.lon,
      elevationM: last.elevationM,
      distanceM: totalDistanceM,
      slopeDeg: 0,
      soilType: last.soilType,
      soilSpeedFactor: last.soilSpeedFactor,
      speedMPerH: 0,
    };
  }

  let lo = 0;
  let hi = samples.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    const midSample = samples[mid];
    if (midSample && midSample.elapsedHours <= clampedT) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  const s0 = samples[lo] ?? first;
  const s1 = samples[Math.min(lo + 1, samples.length - 1)] ?? last;
  const dt = s1.elapsedHours - s0.elapsedHours;
  const frac = dt > 1e-9 ? Math.max(0, Math.min(1, (clampedT - s0.elapsedHours) / dt)) : 0;
  const distM = s0.distanceM + (s1.distanceM - s0.distanceM) * frac;
  const progressRatio =
    totalDistanceM > 0 ? Math.min(1, distM / totalDistanceM) : clampedT / totalDurationHours;

  return {
    unitId,
    elapsedHours: clampedT,
    remainingHours: Math.max(0, totalDurationHours - clampedT),
    totalDurationHours,
    progressRatio,
    arrived: false,
    lat: s0.lat + (s1.lat - s0.lat) * frac,
    lon: s0.lon + (s1.lon - s0.lon) * frac,
    elevationM: s0.elevationM + (s1.elevationM - s0.elevationM) * frac,
    distanceM: distM,
    slopeDeg: s1.slopeDeg,
    soilType: frac < 0.5 ? s0.soilType : s1.soilType,
    soilSpeedFactor: frac < 0.5 ? s0.soilSpeedFactor : s1.soilSpeedFactor,
    speedMPerH: s1.speedMPerH,
  };
}

/**
 * Find the splice index in `1 .. waypoints.length - 1` where inserting `coord`
 * falls closest to an existing leg segment in local Mars tangent coordinates.
 */
export function findBestWaypointInsertIndex(waypoints: MarsCoord[], coord: MarsCoord): number {
  if (waypoints.length <= 1) return waypoints.length;
  const cosLat = Math.max(0.1, Math.cos((coord.lat * Math.PI) / 180));
  let bestIdx = 1;
  let bestDistSq = Number.POSITIVE_INFINITY;

  for (let i = 0; i < waypoints.length - 1; i += 1) {
    const a = waypoints[i];
    const b = waypoints[i + 1];
    if (!a || !b) continue;
    const ax = a.lon * cosLat;
    const ay = a.lat;
    const bx = b.lon * cosLat;
    const by = b.lat;
    const px = coord.lon * cosLat;
    const py = coord.lat;
    const vx = bx - ax;
    const vy = by - ay;
    const lenSq = vx * vx + vy * vy;
    const t =
      lenSq > 1e-16 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / lenSq)) : 0;
    const dx = px - (ax + t * vx);
    const dy = py - (ay + t * vy);
    const dSq = dx * dx + dy * dy;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestIdx = i + 1;
    }
  }

  return bestIdx;
}
