import type {
  MarsWeatherSnapshot,
  MissionUnitId,
  SoilTypeId,
  UnitSimulationSample,
  UnitTraverseTimeline,
} from "@nimbs/shared";
import { sampleUnitTimelineAt } from "@nimbs/shared";

const MARS_SCALE_HEIGHT_M = 10_800;
const MARS_LAPSE_RATE_K_PER_M = -0.0025;

export const UNIT_ACCENT_COLORS: Record<MissionUnitId, string> = {
  1: "#de233d",
  2: "#38bdf8",
};

export interface LocalWeatherTelemetry {
  tempC: number;
  pressurePa: number;
  windSpeedMps: number;
  uvIndex: number;
  isDaylight: boolean;
}

export interface DualSimTrackPoint {
  elapsedHours: number;
  arrived: boolean;
  progressRatio: number;
  distanceM: number;
  elevationM: number;
  slopeDeg: number;
  speedKmPerH: number;
  soilType: SoilTypeId;
  soilSpeedFactor: number;
  tempC: number | null;
  pressurePa: number | null;
  windSpeedMps: number | null;
}

export interface DualSimUnitSeries {
  unitId: MissionUnitId;
  timeline: UnitTraverseTimeline;
  samples: DualSimTrackPoint[];
  minElevM: number;
  maxElevM: number;
  maxSlopeDeg: number;
  maxSpeedKmPerH: number;
  minTempC: number | null;
  maxTempC: number | null;
}

export interface DualSimTimelineBundle {
  totalDurationHours: number;
  unit1: DualSimUnitSeries | null;
  unit2: DualSimUnitSeries | null;
}

export function formatElapsedClock(hours: number): string {
  const safe = Math.max(0, Number.isFinite(hours) ? hours : 0);
  const totalMin = Math.round(safe * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function estimateWeatherAtElevationAndHour(
  elevationM: number,
  offsetHours: number,
  weather: MarsWeatherSnapshot | null,
): LocalWeatherTelemetry | null {
  if (!weather || !Number.isFinite(elevationM) || weather.hourly.length === 0) {
    return null;
  }

  const sol0 = weather.hourly;
  const sol1 = weather.nextSol?.hourly ?? weather.hourly;
  const getPoint = (idx48: number) => {
    const wrapped = ((idx48 % 48) + 48) % 48;
    if (wrapped < 24) {
      return sol0[wrapped] ?? sol0[0];
    }
    return sol1[wrapped - 24] ?? sol1[0] ?? sol0[0];
  };

  const clamped = Math.max(0, Math.min(47.999, offsetHours));
  const h0 = Math.floor(clamped);
  const h1 = h0 + 1;
  const frac = clamped - h0;
  const p0 = getPoint(h0);
  const p1 = getPoint(h1);
  if (!p0 || !p1) return null;

  const refTempK = p0.tempK + (p1.tempK - p0.tempK) * frac;
  const refPressurePa = p0.pressurePa + (p1.pressurePa - p0.pressurePa) * frac;
  const windSpeedMps = p0.windSpeedMps + (p1.windSpeedMps - p0.windSpeedMps) * frac;
  const uvIndex = p0.uvIndex + (p1.uvIndex - p0.uvIndex) * frac;
  const deltaElevM = elevationM - weather.pressure.referenceElevationM;

  const pressurePa = refPressurePa * Math.exp(-deltaElevM / MARS_SCALE_HEIGHT_M);
  const tempK = refTempK + MARS_LAPSE_RATE_K_PER_M * deltaElevM;

  return {
    tempC: tempK - 273.15,
    pressurePa,
    windSpeedMps,
    uvIndex,
    isDaylight: frac < 0.5 ? p0.isDaylight : p1.isDaylight,
  };
}

function buildUnitTrackSeries(
  timeline: UnitTraverseTimeline,
  totalDurationHours: number,
  departureLmstHour: number,
  weather: MarsWeatherSnapshot | null,
  sampleCount: number,
): DualSimUnitSeries {
  const samples: DualSimTrackPoint[] = [];
  let minElevM = Number.POSITIVE_INFINITY;
  let maxElevM = Number.NEGATIVE_INFINITY;
  let maxSlopeDeg = 0;
  let maxSpeedKmPerH = 0;
  let minTempC = Number.POSITIVE_INFINITY;
  let maxTempC = Number.NEGATIVE_INFINITY;

  const steps = Math.max(2, sampleCount);
  const span = Math.max(1e-6, totalDurationHours);

  for (let i = 0; i < steps; i += 1) {
    const t = totalDurationHours <= 0 ? 0 : (i / (steps - 1)) * span;
    const state = sampleUnitTimelineAt(timeline, t);
    if (!state) continue;

    const wxr = estimateWeatherAtElevationAndHour(state.elevationM, departureLmstHour + t, weather);
    const speedKmPerH = state.speedMPerH / 1000;

    if (state.elevationM < minElevM) minElevM = state.elevationM;
    if (state.elevationM > maxElevM) maxElevM = state.elevationM;
    if (state.slopeDeg > maxSlopeDeg) maxSlopeDeg = state.slopeDeg;
    if (speedKmPerH > maxSpeedKmPerH) maxSpeedKmPerH = speedKmPerH;
    if (wxr) {
      if (wxr.tempC < minTempC) minTempC = wxr.tempC;
      if (wxr.tempC > maxTempC) maxTempC = wxr.tempC;
    }

    samples.push({
      elapsedHours: t,
      arrived: state.arrived,
      progressRatio: state.progressRatio,
      distanceM: state.distanceM,
      elevationM: state.elevationM,
      slopeDeg: state.slopeDeg,
      speedKmPerH,
      soilType: state.soilType,
      soilSpeedFactor: state.soilSpeedFactor,
      tempC: wxr?.tempC ?? null,
      pressurePa: wxr?.pressurePa ?? null,
      windSpeedMps: wxr?.windSpeedMps ?? null,
    });
  }

  return {
    unitId: timeline.unitId,
    timeline,
    samples,
    minElevM: Number.isFinite(minElevM) ? minElevM : 0,
    maxElevM: Number.isFinite(maxElevM) ? maxElevM : 0,
    maxSlopeDeg: Math.max(maxSlopeDeg, timeline.maxSlopeDeg),
    maxSpeedKmPerH,
    minTempC: Number.isFinite(minTempC) ? minTempC : null,
    maxTempC: Number.isFinite(maxTempC) ? maxTempC : null,
  };
}

/**
 * Align both units onto one shared timeline starting simultaneously at t = 0
 * and ending when the slower unit reaches its B waypoint.
 */
export function buildDualSimBundle(options: {
  timeline1: UnitTraverseTimeline | null;
  timeline2: UnitTraverseTimeline | null;
  departureLmstHour: number;
  weather: MarsWeatherSnapshot | null;
  sampleCount?: number;
}): DualSimTimelineBundle {
  const { timeline1, timeline2, departureLmstHour, weather, sampleCount = 72 } = options;
  const totalDurationHours = Math.max(
    timeline1?.totalDurationHours ?? 0,
    timeline2?.totalDurationHours ?? 0,
  );

  return {
    totalDurationHours,
    unit1: timeline1
      ? buildUnitTrackSeries(timeline1, totalDurationHours, departureLmstHour, weather, sampleCount)
      : null,
    unit2: timeline2
      ? buildUnitTrackSeries(timeline2, totalDurationHours, departureLmstHour, weather, sampleCount)
      : null,
  };
}

export interface LiveUnitSimFrame {
  sample: UnitSimulationSample | null;
  weather: LocalWeatherTelemetry | null;
}

export function evaluateDualSimFrame(
  timeline1: UnitTraverseTimeline | null,
  timeline2: UnitTraverseTimeline | null,
  elapsedHours: number,
  departureLmstHour: number,
  weather: MarsWeatherSnapshot | null,
): {
  unit1: LiveUnitSimFrame;
  unit2: LiveUnitSimFrame;
  bothArrived: boolean;
} {
  const s1 = timeline1 ? sampleUnitTimelineAt(timeline1, elapsedHours) : null;
  const s2 = timeline2 ? sampleUnitTimelineAt(timeline2, elapsedHours) : null;
  const currentLmst = departureLmstHour + Math.max(0, elapsedHours);

  const w1 = s1 ? estimateWeatherAtElevationAndHour(s1.elevationM, currentLmst, weather) : null;
  const w2 = s2 ? estimateWeatherAtElevationAndHour(s2.elevationM, currentLmst, weather) : null;

  const hasAny = s1 !== null || s2 !== null;
  const bothArrived = hasAny && (s1 === null || s1.arrived) && (s2 === null || s2.arrived);

  return {
    unit1: { sample: s1, weather: w1 },
    unit2: { sample: s2, weather: w2 },
    bothArrived,
  };
}
