import type { MarsCoord } from "../coords";
import {
  DEFAULT_EVA_WEATHER_LIMITS,
  type EvaRouteContext,
  type EvaSafeWindow,
  type EvaStatus,
  type EvaWeatherCheck,
  type EvaWeatherEvaluation,
  type EvaWeatherLimits,
  type MarsWeatherSnapshot,
  type MarsWeatherSolForecast,
  type SelectedHourWeatherSummary,
  type SiteMetadata,
  type TraverseDepartureSlot,
  type TraversePointSample,
  type TraverseWindowRecommendation,
  type WeatherApiResponse,
  type WeatherCheckId,
  type WeatherHourlyPoint,
  type WeatherScenario,
  type WeatherSourceType,
} from "../types";

export {
  DEFAULT_EVA_WEATHER_LIMITS,
  type EvaRouteContext,
  type EvaSafeWindow,
  type EvaStatus,
  type EvaWeatherCheck,
  type EvaWeatherEvaluation,
  type EvaWeatherLimits,
  type MarsWeatherSnapshot,
  type MarsWeatherSolForecast,
  type SelectedHourWeatherSummary,
  type TraverseDepartureSlot,
  type TraversePointSample,
  type TraverseWindowRecommendation,
  type WeatherApiResponse,
  type WeatherCheckId,
  type WeatherHourlyPoint,
  type WeatherScenario,
  type WeatherSourceType,
};

export const MARS_SCALE_HEIGHT_M = 10_800;
export const MARS_SOL_SECONDS = 88_775.244;
export const MARS_SOL_EARTH_HOURS = MARS_SOL_SECONDS / 3600;
export const MARS_OBLIQUITY_RAD = (25.19 * Math.PI) / 180;
export const MARS_ECCENTRICITY = 0.0934;
export const MARS_PERIHELION_LS_DEG = 251;
export const MARS_SOLAR_CONSTANT_WM2 = 589;
export const MARS_LAPSE_RATE_K_PER_M = -0.0025;

export const COMPASS_SECTORS = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
] as const;

export type CompassSector = (typeof COMPASS_SECTORS)[number];
export type MarsSeason =
  | "northern spring"
  | "northern summer"
  | "northern autumn"
  | "northern winter";

export interface SiteWeatherProfile {
  siteId: "jezero" | "gale";
  name: string;
  center: MarsCoord;
  referenceElevationM: number;
  minElevationM: number;
  maxElevationM: number;
}

export const DEFAULT_EVA_LIMITS: EvaWeatherLimits = DEFAULT_EVA_WEATHER_LIMITS;

export interface ObservedWeatherInput {
  sol: number;
  lsDeg?: number;
  terrestrialDate?: string;
  tempMinK?: number;
  tempAvgK?: number;
  tempMaxK?: number;
  pressureMinPa?: number;
  pressureAvgPa?: number;
  pressureMaxPa?: number;
  windMinMps?: number;
  windAvgMps?: number;
  windMaxMps?: number;
  windCompassDeg?: number;
  sunriseLmst?: string;
  sunsetLmst?: string;
  sourceLabel: string;
  sourceUrl?: string;
  realChannels?: string[];
  hourlyTempK?: ReadonlyMap<number, number>;
  hourlyPressurePa?: ReadonlyMap<number, number>;
}

const JEZERO_PRESET: SiteWeatherProfile = {
  siteId: "jezero",
  name: "Jezero Crater (Perseverance)",
  center: { lat: 18.664, lon: 77.445 },
  referenceElevationM: -2500,
  minElevationM: -2590,
  maxElevationM: -1696,
};

const GALE_PRESET: SiteWeatherProfile = {
  siteId: "gale",
  name: "Gale Crater / Mount Sharp (Curiosity)",
  center: { lat: -4.81, lon: 137.16 },
  referenceElevationM: -4500,
  minElevationM: -4550,
  maxElevationM: 800,
};

function roundTo(val: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(val * factor) / factor;
}

export function kelvinToCelsius(kelvin: number): number {
  return kelvin - 273.15;
}

export function celsiusToKelvin(celsius: number): number {
  return celsius + 273.15;
}

/** Scale Martian atmospheric pressure from reference elevation to target elevation using H = 10,800 m. */
export function scalePressureByElevation(
  pressurePa: number,
  targetElevationM: number,
  referenceElevationM: number,
): number {
  return pressurePa * Math.exp(-(targetElevationM - referenceElevationM) / MARS_SCALE_HEIGHT_M);
}

/** Adjust Martian surface air temperature for elevation change using -2.5 K/km boundary-layer lapse rate. */
export function lapseTempByElevation(
  tempK: number,
  targetElevationM: number,
  referenceElevationM: number,
): number {
  return tempK + MARS_LAPSE_RATE_K_PER_M * (targetElevationM - referenceElevationM);
}

export function degreesToCompassSector(deg: number): CompassSector {
  const normalized = ((deg % 360) + 360) % 360;
  const idx = Math.round(normalized / 22.5) % 16;
  return COMPASS_SECTORS[idx] ?? "N";
}

export function seasonFromLs(lsDeg: number): MarsSeason {
  const ls = ((lsDeg % 360) + 360) % 360;
  if (ls < 90) return "northern spring";
  if (ls < 180) return "northern summer";
  if (ls < 270) return "northern autumn";
  return "northern winter";
}

/** Estimate Mars areocentric solar longitude Ls in [0, 360) from a UTC terrestrial date (Allison & McEwen 2000). */
export function estimateLsFromDate(date: Date = new Date()): number {
  const jdUt = date.getTime() / 86_400_000 + 2440587.5;
  const deltaT = jdUt - 2451545.0;
  const meanAnomalyDeg = (19.387 + 0.52402075 * deltaT) % 360;
  const mRad = (meanAnomalyDeg * Math.PI) / 180;
  const fmsDeg = (270.3863 + 0.5240384 * deltaT) % 360;
  const pbsDeg = 0.0071 * Math.cos(((0.985626 * deltaT) / 2.2353 + 49.409) * (Math.PI / 180));
  const nuMinusM =
    (10.691 + 3.0e-7 * deltaT) * Math.sin(mRad) +
    0.623 * Math.sin(2 * mRad) +
    0.05 * Math.sin(3 * mRad) +
    pbsDeg;
  return (((fmsDeg + nuMinusM) % 360) + 360) % 360;
}

/** Approximate Perseverance Sol from UTC date (landing Sol 0 = 2021-02-18T20:55:00Z). */
export function estimatePerseveranceSol(date: Date = new Date()): number {
  const landingMs = Date.UTC(2021, 1, 18, 20, 55, 0);
  const elapsedSeconds = Math.max(0, (date.getTime() - landingMs) / 1000);
  return Math.floor(elapsedSeconds / MARS_SOL_SECONDS);
}

/** Approximate Curiosity Sol from UTC date (landing Sol 0 = 2012-08-06T05:17:57Z). */
export function estimateCuriositySol(date: Date = new Date()): number {
  const landingMs = Date.UTC(2012, 7, 6, 5, 17, 57);
  const elapsedSeconds = Math.max(0, (date.getTime() - landingMs) / 1000);
  return Math.floor(elapsedSeconds / MARS_SOL_SECONDS);
}

export function resolveSiteWeatherProfile(
  siteHint?: string | null,
  activeSiteMeta?: SiteMetadata | null,
): SiteWeatherProfile {
  const key = (siteHint ?? activeSiteMeta?.id ?? "jezero").toLowerCase();
  const isGale =
    key.includes("gale") ||
    key.includes("mount-sharp") ||
    key.includes("msl") ||
    key === "curiosity";
  const base = isGale ? GALE_PRESET : JEZERO_PRESET;

  if (
    activeSiteMeta &&
    ((isGale && activeSiteMeta.id.toLowerCase().includes("mount-sharp")) ||
      (!isGale && activeSiteMeta.id.toLowerCase().includes("jezero")))
  ) {
    return {
      siteId: base.siteId,
      name: activeSiteMeta.name,
      center: activeSiteMeta.center,
      referenceElevationM: base.referenceElevationM,
      minElevationM: roundTo(activeSiteMeta.minElevationM, 1),
      maxElevationM: roundTo(activeSiteMeta.maxElevationM, 1),
    };
  }

  return { ...base };
}

function deterministicNoise(seedA: number, seedB: number): number {
  const x = Math.sin(seedA * 12.9898 + seedB * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function parseLmstHours(clockStr: string | undefined): number | null {
  if (!clockStr) return null;
  const parts = clockStr.trim().split(":").map(Number);
  const h = parts[0];
  const m = parts[1] ?? 0;
  const s = parts[2] ?? 0;
  if (h === undefined || !Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s)) {
    return null;
  }
  return Math.max(0, Math.min(24, h + m / 60 + s / 3600));
}

function formatLmstClock(hours: number): string {
  const wrapped = ((hours % 24) + 24) % 24;
  const totalSec = Math.round(wrapped * 3600);
  const h = Math.floor(totalSec / 3600) % 24;
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatLmstHHMM(hours: number, allow24 = false): string {
  if (allow24 && Math.abs(hours - 24) < 1e-4) {
    return "24:00";
  }
  const wrapped = ((hours % 24) + 24) % 24;
  const totalMin = Math.round(wrapped * 60);
  const h = Math.floor(totalMin / 60) % 24;
  const m = totalMin % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function incrementTerrestrialDate(dateStr: string): string {
  const baseMs = Date.parse(`${dateStr}T00:00:00Z`);
  const anchorMs = Number.isFinite(baseMs) ? baseMs : Date.now();
  return new Date(anchorMs + 86_400_000).toISOString().slice(0, 10);
}

function computeSolarDeclinationRad(lsDeg: number): number {
  const lsRad = (lsDeg * Math.PI) / 180;
  return Math.asin(Math.sin(MARS_OBLIQUITY_RAD) * Math.sin(lsRad));
}

function computeSolarNoonLmst(lsDeg: number): number {
  const eotHours =
    -0.35 * Math.sin(((lsDeg - MARS_PERIHELION_LS_DEG) * Math.PI) / 180) +
    0.15 * Math.sin((2 * lsDeg * Math.PI) / 180);
  return 12.0 + eotHours;
}

function computeMarsSolarFactor(lsDeg: number): number {
  const nuRad = ((lsDeg - MARS_PERIHELION_LS_DEG) * Math.PI) / 180;
  const rRatio = (1 + MARS_ECCENTRICITY * Math.cos(nuRad)) / (1 - MARS_ECCENTRICITY ** 2);
  return rRatio * rRatio;
}

export interface SolarGeometry {
  declinationRad: number;
  solarElevationSin: number;
  solarAzimuthRad: number;
  sunDirX: number;
  sunDirY: number;
  sunDirZ: number;
}

/**
 * Compute Martian solar elevation, azimuth (clockwise from North), and unit direction vector
 * in local East-North-Up coordinates at a given latitude, Ls, and LMST hour.
 */
export function computeSolarGeometryAtLmst(
  latDeg: number,
  lsDeg: number,
  lmstHour: number,
): SolarGeometry {
  const declinationRad = computeSolarDeclinationRad(lsDeg);
  const latRad = (latDeg * Math.PI) / 180;
  const solarNoon = computeSolarNoonLmst(lsDeg);
  const hourAngle = ((lmstHour - solarNoon) * Math.PI) / 12;

  const sinAlt =
    Math.sin(latRad) * Math.sin(declinationRad) +
    Math.cos(latRad) * Math.cos(declinationRad) * Math.cos(hourAngle);
  const solarElevationSin = Math.max(-1, Math.min(1, sinAlt));

  const sunDirX = -Math.cos(declinationRad) * Math.sin(hourAngle);
  const sunDirY =
    Math.cos(latRad) * Math.sin(declinationRad) -
    Math.sin(latRad) * Math.cos(declinationRad) * Math.cos(hourAngle);
  const sunDirZ = solarElevationSin;

  const rawAz = Math.atan2(sunDirX, sunDirY);
  const solarAzimuthRad = ((rawAz % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

  return {
    declinationRad,
    solarElevationSin,
    solarAzimuthRad,
    sunDirX,
    sunDirY,
    sunDirZ,
  };
}

/** Compute sunrise/sunset LMST hours and UTC ISO timestamps anchored to terrestrialDate. */
function computeDaylightWindow(
  latDeg: number,
  lsDeg: number,
  terrestrialDate: string,
  overrideSunrise?: string,
  overrideSunset?: string,
): {
  sunriseHour: number;
  sunsetHour: number;
  sunriseLmst: string;
  sunsetLmst: string;
  sunriseUtc: string;
  sunsetUtc: string;
  durationHours: number;
} {
  const decl = computeSolarDeclinationRad(lsDeg);
  const latRad = (latDeg * Math.PI) / 180;
  const cosH0 = Math.max(-0.98, Math.min(0.98, -Math.tan(latRad) * Math.tan(decl)));
  const halfDayHours = (12 / Math.PI) * Math.acos(cosH0);

  const solarNoon = computeSolarNoonLmst(lsDeg);

  const parsedRise = parseLmstHours(overrideSunrise);
  const parsedSet = parseLmstHours(overrideSunset);
  const sunriseHour = parsedRise ?? Math.max(4.0, Math.min(8.5, solarNoon - halfDayHours));
  const sunsetHour = parsedSet ?? Math.min(20.0, Math.max(15.5, solarNoon + halfDayHours));
  const durationHours = roundTo(Math.max(1, sunsetHour - sunriseHour), 2);

  const baseDateMs = Date.parse(`${terrestrialDate}T00:00:00Z`);
  const anchorMs = Number.isFinite(baseDateMs) ? baseDateMs : Date.UTC(2026, 0, 1);
  const earthScale = MARS_SOL_EARTH_HOURS / 24;
  const sunriseUtc = new Date(anchorMs + sunriseHour * earthScale * 3600_000).toISOString();
  const sunsetUtc = new Date(anchorMs + sunsetHour * earthScale * 3600_000).toISOString();

  return {
    sunriseHour,
    sunsetHour,
    sunriseLmst: overrideSunrise ?? formatLmstClock(sunriseHour),
    sunsetLmst: overrideSunset ?? formatLmstClock(sunsetHour),
    sunriseUtc,
    sunsetUtc,
    durationHours,
  };
}

/**
 * Seasonal surface pressure baseline (Pa) at Jezero reference elevation (-2500 m),
 * calibrated to the Martian CO2 condensation cycle (Sol 1859 Ls 137 -> ~734 Pa, Sol 1133 Ls 244 -> ~810-820 Pa).
 */
function jezeroSeasonalPressurePa(lsDeg: number): number {
  const rad = (lsDeg * Math.PI) / 180;
  return (
    788 +
    42 * Math.cos(rad - (295 * Math.PI) / 180) +
    18 * Math.cos(2 * (rad - (210 * Math.PI) / 180))
  );
}

/** Seasonal surface air temperature baseline (K) at reference elevation for given lat and Ls. */
function climatologyAirTempRangeK(
  latDeg: number,
  lsDeg: number,
  tau: number,
  scenario: WeatherScenario,
  sol: number,
): { minK: number; maxK: number } {
  const declDeg = (computeSolarDeclinationRad(lsDeg) * 180) / Math.PI;
  const solarFactor = computeMarsSolarFactor(lsDeg);
  const noonCos = Math.max(0.25, Math.cos(((latDeg - declDeg) * Math.PI) / 180));
  const jitter = (deterministicNoise(sol, 17) - 0.5) * 4.0;

  let baseMinK = 171 + 12 * solarFactor + 6 * noonCos + jitter;
  let baseMaxK = 229 + 30 * solarFactor * noonCos + 7 * Math.sin((lsDeg * Math.PI) / 180) + jitter;

  // Higher dust opacity warms Martian night via IR trapping and cools daytime peak via shortwave scattering
  const dustDelta = Math.max(0, tau - 0.45);
  baseMinK += Math.min(14, dustDelta * 5.2);
  baseMaxK -= Math.min(24, dustDelta * 9.5);

  if (scenario === "cold-snap") {
    baseMinK -= 11;
    baseMaxK -= 21;
  } else if (scenario === "dust-storm") {
    baseMinK += 4;
    baseMaxK -= 14;
  }

  const minK = Math.max(150, Math.min(230, baseMinK));
  const maxK = Math.max(minK + 18, Math.min(295, baseMaxK));
  return { minK: roundTo(minK, 2), maxK: roundTo(maxK, 2) };
}

function defaultDustTau(lsDeg: number, scenario: WeatherScenario, sol: number): number {
  const jitter = (deterministicNoise(sol, 31) - 0.5) * 0.08;
  if (scenario === "dust-storm") {
    return roundTo(2.65 + deterministicNoise(sol, 41) * 0.75, 2);
  }
  if (scenario === "cold-snap") {
    return roundTo(0.28 + deterministicNoise(sol, 43) * 0.08, 2);
  }
  // Dustier perihelion season (Ls 180..330), clearer aphelion (Ls 30..140)
  const seasonal = 0.52 - 0.18 * Math.cos(((lsDeg - 255) * Math.PI) / 180);
  return roundTo(Math.max(0.2, seasonal + jitter), 2);
}

function buildHourlyDiurnalSeries(params: {
  latDeg: number;
  lsDeg: number;
  sunriseHour: number;
  sunsetHour: number;
  tempMinK: number;
  tempMaxK: number;
  pressureMinPa: number;
  pressureAvgPa: number;
  pressureMaxPa: number;
  windMinMps: number;
  windAvgMps: number;
  windMaxMps: number;
  tau: number;
  hourlyTempOverride?: ReadonlyMap<number, number>;
  hourlyPressureOverride?: ReadonlyMap<number, number>;
}): WeatherHourlyPoint[] {
  const {
    latDeg,
    lsDeg,
    sunriseHour,
    sunsetHour,
    tempMinK,
    tempMaxK,
    pressureMinPa,
    pressureAvgPa,
    pressureMaxPa,
    windMinMps,
    windAvgMps,
    windMaxMps,
    tau,
    hourlyTempOverride,
    hourlyPressureOverride,
  } = params;

  const decl = computeSolarDeclinationRad(lsDeg);
  const latRad = (latDeg * Math.PI) / 180;
  const solarFactor = computeMarsSolarFactor(lsDeg);
  const solarNoon = (sunriseHour + sunsetHour) / 2;
  const halfDay = Math.max(3, (sunsetHour - sunriseHour) / 2);

  // Trough just before sunrise, afternoon peak around 14:30 LMST
  const hMin = Math.max(1.5, sunriseHour - 0.75);
  const hPeak = Math.min(sunsetHour - 1.2, 14.5);
  const coolingSpan = 24 - (hPeak - hMin);
  const decayDenom = 1 - Math.exp(-2.6);

  // Raw pressure thermal tide shape: diurnal (peak ~08:30) + semidiurnal (peaks ~09:00 / ~21:00)
  const rawTide: number[] = [];
  for (let h = 0; h < 24; h += 1) {
    const p1 = Math.cos(((h - 8.5) * 2 * Math.PI) / 24);
    const p2 = 0.35 * Math.cos(((h - 9.0) * 4 * Math.PI) / 24);
    rawTide.push(p1 + p2);
  }
  const rawMin = Math.min(...rawTide);
  const rawMax = Math.max(...rawTide);
  const rawSpan = Math.max(1e-6, rawMax - rawMin);

  const hourly: WeatherHourlyPoint[] = [];
  for (let h = 0; h < 24; h += 1) {
    // Temperature diurnal curve
    let tempK: number;
    const overrideT = hourlyTempOverride?.get(h);
    if (overrideT !== undefined && Number.isFinite(overrideT)) {
      tempK = overrideT;
    } else {
      let norm = 0;
      if (h >= hMin && h <= hPeak) {
        const u = (h - hMin) / Math.max(0.5, hPeak - hMin);
        norm = Math.sin((Math.PI / 2) * u) ** 1.2;
      } else {
        const dt = h > hPeak ? h - hPeak : 24 - hPeak + h;
        const v = Math.max(0, Math.min(1, dt / Math.max(1, coolingSpan)));
        norm = (Math.exp(-2.6 * v) - Math.exp(-2.6)) / decayDenom;
      }
      tempK = tempMinK + (tempMaxK - tempMinK) * norm;
    }

    // Pressure tide curve
    let pressurePa: number;
    const overrideP = hourlyPressureOverride?.get(h);
    if (overrideP !== undefined && Number.isFinite(overrideP)) {
      pressurePa = overrideP;
    } else {
      const frac = ((rawTide[h] ?? 0) - rawMin) / rawSpan;
      const mapped = pressureMinPa + frac * (pressureMaxPa - pressureMinPa);
      // Anchor mean lightly while honoring observed min/max bounds
      pressurePa = 0.85 * mapped + 0.15 * pressureAvgPa;
    }

    // Wind speed curve: peaks during afternoon thermal convection (12:00-15:30 LMST)
    const convective = Math.max(0, Math.cos(((h - 14.0) * Math.PI) / 14)) ** 1.3;
    const nocturnalSlope = 0.25 * Math.max(0, Math.cos(((h - 2.0) * Math.PI) / 12));
    const windWeight = Math.min(1, convective + nocturnalSlope);
    const windSpeedMps = windMinMps + (windMaxMps - windMinMps) * (0.2 + 0.8 * windWeight);

    // Solar irradiance and UV index
    const isDaylight = h >= sunriseHour && h <= sunsetHour;
    let solarIrradianceWm2 = 0;
    let uvIndex = 0;
    if (isDaylight) {
      const hourAngle = ((h - solarNoon) * Math.PI) / 12;
      const cosZenith = Math.max(
        0.04,
        Math.sin(latRad) * Math.sin(decl) + Math.cos(latRad) * Math.cos(decl) * Math.cos(hourAngle),
      );
      const dayShape = Math.max(0, Math.cos(((h - solarNoon) * (Math.PI / 2)) / halfDay));
      const directTrans = Math.exp(-tau / Math.max(0.2, cosZenith));
      const diffuseFrac = 0.18 * (1 - Math.exp(-0.5 * tau));
      solarIrradianceWm2 =
        MARS_SOLAR_CONSTANT_WM2 *
        solarFactor *
        cosZenith *
        (directTrans + diffuseFrac) *
        (0.85 + 0.15 * dayShape);
      uvIndex = Math.max(0.1, 11.5 * solarFactor * cosZenith * Math.exp(-0.85 * tau));
    }

    hourly.push({
      lmstHour: h,
      lmstLabel: `${String(h).padStart(2, "0")}:00`,
      tempK: roundTo(tempK, 2),
      windSpeedMps: roundTo(
        Math.max(windMinMps, Math.min(windMaxMps, 0.75 * windSpeedMps + 0.25 * windAvgMps)),
        2,
      ),
      pressurePa: roundTo(pressurePa, 2),
      solarIrradianceWm2: roundTo(solarIrradianceWm2, 1),
      uvIndex: roundTo(uvIndex, 2),
      isDaylight,
    });
  }

  return hourly;
}

export interface GenerateWeatherOptions {
  site?: string | null;
  siteMeta?: SiteMetadata | null;
  sol?: number;
  lsDeg?: number;
  scenario?: WeatherScenario;
  terrestrialDate?: string;
  observedOverrides?: ObservedWeatherInput;
}

/**
 * Generate physically calibrated Martian weather for Jezero or Gale Crater,
 * or synthesize missing channels on top of real spacecraft telemetry.
 */
export function generateMartianWeather(options: GenerateWeatherOptions = {}): MarsWeatherSnapshot {
  const site = resolveSiteWeatherProfile(options.site, options.siteMeta);
  const scenario: WeatherScenario = options.scenario ?? "auto";
  const effectiveScenario = scenario === "auto" ? "nominal" : scenario;
  const now = new Date();
  const obs = options.observedOverrides;

  const terrestrialDate =
    obs?.terrestrialDate ?? options.terrestrialDate ?? now.toISOString().slice(0, 10);
  const defaultSol =
    site.siteId === "gale" ? estimateCuriositySol(now) : estimatePerseveranceSol(now);
  const sol = obs?.sol ?? options.sol ?? defaultSol;
  const lsDeg = roundTo(
    (((obs?.lsDeg ?? options.lsDeg ?? estimateLsFromDate(now)) % 360) + 360) % 360,
    2,
  );
  const season = seasonFromLs(lsDeg);

  const tau = defaultDustTau(lsDeg, effectiveScenario, sol);

  // Base pressure scaled from Jezero (-2500 m) to target site reference elevation using H = 10,800 m
  const jezeroBaselinePa = jezeroSeasonalPressurePa(lsDeg);
  const siteBaselinePa = scalePressureByElevation(
    jezeroBaselinePa,
    site.referenceElevationM,
    JEZERO_PRESET.referenceElevationM,
  );
  const stormPressureOffset =
    effectiveScenario === "dust-storm" ? -6 : effectiveScenario === "cold-snap" ? 4 : 0;
  const genAvgPa = siteBaselinePa + stormPressureOffset;
  const genSwingPa = genAvgPa * (0.022 + 0.0155 * Math.min(4, tau));

  const hasObsPressAvg = obs?.pressureAvgPa !== undefined && Number.isFinite(obs.pressureAvgPa);
  const hasObsPressBounds =
    obs?.pressureMinPa !== undefined &&
    obs?.pressureMaxPa !== undefined &&
    Number.isFinite(obs.pressureMinPa) &&
    Number.isFinite(obs.pressureMaxPa);

  const pressureAvgPa = roundTo(hasObsPressAvg ? (obs.pressureAvgPa ?? genAvgPa) : genAvgPa, 2);
  const pressureMinPa = roundTo(
    hasObsPressBounds
      ? (obs.pressureMinPa ?? pressureAvgPa - genSwingPa / 2)
      : pressureAvgPa - genSwingPa / 2,
    2,
  );
  const pressureMaxPa = roundTo(
    hasObsPressBounds
      ? (obs.pressureMaxPa ?? pressureAvgPa + genSwingPa / 2)
      : pressureAvgPa + genSwingPa / 2,
    2,
  );
  const pressureSwingPa = roundTo(Math.max(0, pressureMaxPa - pressureMinPa), 2);

  // Air temperature in SI Kelvin
  const genTemp = climatologyAirTempRangeK(site.center.lat, lsDeg, tau, effectiveScenario, sol);
  const tempMinK = roundTo(obs?.tempMinK ?? genTemp.minK, 2);
  const tempMaxK = roundTo(obs?.tempMaxK ?? genTemp.maxK, 2);

  // Wind speed & direction
  const baseGustBias = deterministicNoise(sol, 53) * 2.2;
  let genWindMin = 0.8 + deterministicNoise(sol, 61) * 0.8;
  let genWindAvg = 4.4 + deterministicNoise(sol, 67) * 2.0;
  let genWindMax = 9.5 + baseGustBias;

  if (effectiveScenario === "dust-storm") {
    genWindMin = 4.2 + deterministicNoise(sol, 71) * 1.8;
    genWindAvg = 11.4 + deterministicNoise(sol, 73) * 2.4;
    genWindMax = 18.5 + deterministicNoise(sol, 79) * 5.2;
  } else if (effectiveScenario === "cold-snap") {
    genWindMin = 0.6 + deterministicNoise(sol, 83) * 0.6;
    genWindAvg = 3.2 + deterministicNoise(sol, 89) * 1.4;
    genWindMax = 7.4 + deterministicNoise(sol, 97) * 2.0;
  }

  const windMinMps = roundTo(obs?.windMinMps ?? genWindMin, 2);
  const windAvgMps = roundTo(obs?.windAvgMps ?? genWindAvg, 2);
  const windMaxMps = roundTo(obs?.windMaxMps ?? genWindMax, 2);

  const baseDir = site.siteId === "gale" ? 315 : 108;
  const compassDeg = roundTo(
    (((obs?.windCompassDeg ?? baseDir + (deterministicNoise(sol, 101) - 0.5) * 44) % 360) + 360) %
      360,
    1,
  );
  const compassPoint = degreesToCompassSector(compassDeg);

  // Daylight window
  const daylight = computeDaylightWindow(
    site.center.lat,
    lsDeg,
    terrestrialDate,
    obs?.sunriseLmst,
    obs?.sunsetLmst,
  );

  // Build 24-hour diurnal series
  const hourly = buildHourlyDiurnalSeries({
    latDeg: site.center.lat,
    lsDeg,
    sunriseHour: daylight.sunriseHour,
    sunsetHour: daylight.sunsetHour,
    tempMinK,
    tempMaxK,
    pressureMinPa,
    pressureAvgPa,
    pressureMaxPa,
    windMinMps,
    windAvgMps,
    windMaxMps,
    tau,
    hourlyTempOverride: obs?.hourlyTempK,
    hourlyPressureOverride: obs?.hourlyPressurePa,
  });

  const computedTempAvgK = roundTo(
    obs?.tempAvgK ?? hourly.reduce((acc, pt) => acc + pt.tempK, 0) / Math.max(1, hourly.length),
    2,
  );
  const uvIndexMax = roundTo(Math.max(...hourly.map((pt) => pt.uvIndex)), 2);
  const solarIrradiancePeakWm2 = roundTo(Math.max(...hourly.map((pt) => pt.solarIrradianceWm2)), 1);

  // Provenance tagging (AGENTS.md: never mask simulated or hybrid values as raw telemetry)
  const realChannels = obs?.realChannels ? [...obs.realChannels] : [];
  const allChannels = [
    "airTemp",
    "pressure",
    "pressureSwing",
    "windSpeed",
    "windDirection",
    "dustOpacity",
    "uvIndex",
    "daylight",
    "hourlyCurve",
  ];
  const simulatedChannels = obs
    ? allChannels.filter((ch) => !realChannels.includes(ch))
    : allChannels;

  let sourceType: WeatherSourceType = "simulated";
  if (obs && realChannels.length > 0) {
    const hasCoreReal =
      realChannels.includes("airTemp") &&
      realChannels.includes("pressure") &&
      realChannels.includes("windSpeed");
    sourceType = hasCoreReal ? "real" : "hybrid";
  }

  const isSimulated = sourceType !== "real";
  const sourceLabel = obs
    ? `${obs.sourceLabel}${sourceType === "hybrid" ? " + modeled channels" : ""}`
    : `Simulated Mars climatology (${effectiveScenario})`;

  const disclaimer =
    sourceType === "real"
      ? undefined
      : sourceType === "hybrid"
        ? `Real spacecraft telemetry for ${realChannels.join(", ")}. Modeled values used for ${simulatedChannels.join(", ")}.`
        : `Simulated ${effectiveScenario} weather calibrated to Mars climatology. Not live spacecraft telemetry.`;

  const baseSnapshotCore = {
    site,
    sol,
    lsDeg,
    season,
    terrestrialDate,
    fetchedAt: now.toISOString(),
    scenario,
    isSimulated,
    sourceType,
    sourceLabel,
    sourceUrl: obs?.sourceUrl,
    disclaimer,
    realChannels,
    simulatedChannels,
    airTemp: {
      minK: tempMinK,
      avgK: computedTempAvgK,
      maxK: tempMaxK,
    },
    wind: {
      minMps: windMinMps,
      avgMps: windAvgMps,
      maxMps: windMaxMps,
      compassDeg,
      compassPoint,
    },
    pressure: {
      minPa: pressureMinPa,
      avgPa: pressureAvgPa,
      maxPa: pressureMaxPa,
      swingPa: pressureSwingPa,
      referenceElevationM: site.referenceElevationM,
    },
    dustOpacityTau: tau,
    uvIndexMax,
    solarIrradiancePeakWm2,
    daylight: {
      sunriseLmst: daylight.sunriseLmst,
      sunsetLmst: daylight.sunsetLmst,
      sunriseUtc: daylight.sunriseUtc,
      sunsetUtc: daylight.sunsetUtc,
      durationHours: daylight.durationHours,
    },
    hourly,
  };

  const nextSol = synthesizeNextSolForecast(baseSnapshotCore);

  return {
    ...baseSnapshotCore,
    nextSol,
  };
}

function synthesizeNextSolForecast(
  base: Omit<MarsWeatherSnapshot, "nextSol">,
): MarsWeatherSolForecast {
  const effectiveScenario: WeatherScenario = base.scenario === "auto" ? "nominal" : base.scenario;
  const nextSolNum = base.sol + 1;
  const nextLsDeg = roundTo((((base.lsDeg + 0.51) % 360) + 360) % 360, 2);
  const nextSeason = seasonFromLs(nextLsDeg);
  const nextTerrestrialDate = incrementTerrestrialDate(base.terrestrialDate);

  const baseClimTau = defaultDustTau(base.lsDeg, effectiveScenario, base.sol);
  const nextClimTau = defaultDustTau(nextLsDeg, effectiveScenario, nextSolNum);
  const maxTauStep = effectiveScenario === "dust-storm" ? 0.3 : 0.12;
  const tauDelta = Math.max(-maxTauStep, Math.min(maxTauStep, nextClimTau - baseClimTau));
  const nextTau = roundTo(Math.max(0.2, base.dustOpacityTau + tauDelta), 2);

  const refElevM = base.pressure.referenceElevationM;
  const baseSitePa = scalePressureByElevation(
    jezeroSeasonalPressurePa(base.lsDeg),
    refElevM,
    JEZERO_PRESET.referenceElevationM,
  );
  const nextSitePa = scalePressureByElevation(
    jezeroSeasonalPressurePa(nextLsDeg),
    refElevM,
    JEZERO_PRESET.referenceElevationM,
  );
  const seasonalPressureDelta = nextSitePa - baseSitePa;
  const synopticDrift = (deterministicNoise(nextSolNum, 131) - 0.5) * 2.2;
  const nextPressureAvgPa = roundTo(base.pressure.avgPa + seasonalPressureDelta + synopticDrift, 2);

  const swingDenom = Math.max(0.01, 0.022 + 0.0155 * Math.min(4, base.dustOpacityTau));
  const swingScale = (0.022 + 0.0155 * Math.min(4, nextTau)) / swingDenom;
  const nextSwingTarget = Math.max(
    2,
    base.pressure.swingPa * swingScale + (deterministicNoise(nextSolNum, 137) - 0.5) * 1.4,
  );
  const nextPressureMinPa = roundTo(nextPressureAvgPa - nextSwingTarget / 2, 2);
  const nextPressureMaxPa = roundTo(nextPressureAvgPa + nextSwingTarget / 2, 2);

  const baseClimTemp = climatologyAirTempRangeK(
    base.site.center.lat,
    base.lsDeg,
    base.dustOpacityTau,
    effectiveScenario,
    base.sol,
  );
  const nextClimTemp = climatologyAirTempRangeK(
    base.site.center.lat,
    nextLsDeg,
    nextTau,
    effectiveScenario,
    nextSolNum,
  );
  const deltaMinK = Math.max(-2.2, Math.min(2.2, nextClimTemp.minK - baseClimTemp.minK));
  const deltaMaxK = Math.max(-2.8, Math.min(2.8, nextClimTemp.maxK - baseClimTemp.maxK));
  const nextTempMinTarget = roundTo(Math.max(150, Math.min(230, base.airTemp.minK + deltaMinK)), 2);
  const nextTempMaxTarget = roundTo(
    Math.max(nextTempMinTarget + 18, Math.min(295, base.airTemp.maxK + deltaMaxK)),
    2,
  );

  const windShift = (deterministicNoise(nextSolNum, 149) - 0.5) * 1.4;
  const nextWindMin = roundTo(Math.max(0.4, base.wind.minMps + windShift * 0.35), 2);
  const nextWindAvg = roundTo(Math.max(nextWindMin + 0.5, base.wind.avgMps + windShift * 0.7), 2);
  const nextWindMax = roundTo(Math.max(nextWindAvg + 1.0, base.wind.maxMps + windShift * 1.2), 2);
  const nextCompassDeg = roundTo(
    (((base.wind.compassDeg + (deterministicNoise(nextSolNum, 151) - 0.5) * 18) % 360) + 360) % 360,
    1,
  );
  const nextCompassPoint = degreesToCompassSector(nextCompassDeg);

  const nextDaylight = computeDaylightWindow(base.site.center.lat, nextLsDeg, nextTerrestrialDate);

  const rawHourly = buildHourlyDiurnalSeries({
    latDeg: base.site.center.lat,
    lsDeg: nextLsDeg,
    sunriseHour: nextDaylight.sunriseHour,
    sunsetHour: nextDaylight.sunsetHour,
    tempMinK: nextTempMinTarget,
    tempMaxK: nextTempMaxTarget,
    pressureMinPa: nextPressureMinPa,
    pressureAvgPa: nextPressureAvgPa,
    pressureMaxPa: nextPressureMaxPa,
    windMinMps: nextWindMin,
    windAvgMps: nextWindAvg,
    windMaxMps: nextWindMax,
    tau: nextTau,
  });

  // Smooth the midnight seam (hour 23 of base sol -> hour 0..3 of next sol)
  const h22 = base.hourly[Math.max(0, base.hourly.length - 2)];
  const h23 = base.hourly[base.hourly.length - 1];
  const n0 = rawHourly[0];
  const n1 = rawHourly[1];

  const hourly: WeatherHourlyPoint[] = rawHourly.map((pt) => ({ ...pt }));
  if (h22 && h23 && n0 && n1) {
    const tempStep = Math.max(-3.5, Math.min(1.0, (h23.tempK - h22.tempK) * 0.85));
    const expectedTemp0 = h23.tempK + tempStep;
    const tempGap = expectedTemp0 - n0.tempK;

    const pressStep = Math.max(-4.0, Math.min(4.0, (n1.pressurePa - n0.pressurePa) * 0.5));
    const expectedPress0 = h23.pressurePa - pressStep;
    const pressGap = expectedPress0 - n0.pressurePa;

    const windStep = Math.max(-1.5, Math.min(1.5, (n1.windSpeedMps - n0.windSpeedMps) * 0.5));
    const expectedWind0 = h23.windSpeedMps - windStep;
    const windGap = expectedWind0 - n0.windSpeedMps;

    const blendWeights = [1.0, 0.6, 0.3, 0.1];
    for (let i = 0; i < blendWeights.length; i += 1) {
      const w = blendWeights[i] ?? 0;
      const pt = hourly[i];
      if (!pt) continue;
      pt.tempK = roundTo(Math.max(145, pt.tempK + w * tempGap), 2);
      pt.pressurePa = roundTo(Math.max(100, pt.pressurePa + w * pressGap), 2);
      pt.windSpeedMps = roundTo(Math.max(0.2, pt.windSpeedMps + w * windGap), 2);
    }
  }

  const temps = hourly.map((pt) => pt.tempK);
  const pressures = hourly.map((pt) => pt.pressurePa);
  const winds = hourly.map((pt) => pt.windSpeedMps);

  const minK = roundTo(Math.min(...temps), 2);
  const maxK = roundTo(Math.max(...temps), 2);
  const avgK = roundTo(temps.reduce((a, b) => a + b, 0) / Math.max(1, temps.length), 2);

  const minPa = roundTo(Math.min(...pressures), 2);
  const maxPa = roundTo(Math.max(...pressures), 2);
  const avgPa = roundTo(pressures.reduce((a, b) => a + b, 0) / Math.max(1, pressures.length), 2);

  const minMps = roundTo(Math.min(...winds), 2);
  const maxMps = roundTo(Math.max(...winds), 2);
  const avgMps = roundTo(winds.reduce((a, b) => a + b, 0) / Math.max(1, winds.length), 2);

  return {
    sol: nextSolNum,
    lsDeg: nextLsDeg,
    season: nextSeason,
    terrestrialDate: nextTerrestrialDate,
    airTemp: {
      minK,
      avgK,
      maxK,
    },
    wind: {
      minMps,
      avgMps,
      maxMps,
      compassDeg: nextCompassDeg,
      compassPoint: nextCompassPoint,
    },
    pressure: {
      minPa,
      avgPa,
      maxPa,
      swingPa: roundTo(Math.max(0, maxPa - minPa), 2),
      referenceElevationM: refElevM,
    },
    dustOpacityTau: nextTau,
    uvIndexMax: roundTo(Math.max(...hourly.map((pt) => pt.uvIndex)), 2),
    solarIrradiancePeakWm2: roundTo(Math.max(...hourly.map((pt) => pt.solarIrradianceWm2)), 1),
    daylight: {
      sunriseLmst: nextDaylight.sunriseLmst,
      sunsetLmst: nextDaylight.sunsetLmst,
      sunriseUtc: nextDaylight.sunriseUtc,
      sunsetUtc: nextDaylight.sunsetUtc,
      durationHours: nextDaylight.durationHours,
    },
    hourly,
  };
}

/** Backfill nextSol lazily when reading older snapshots that lack a 48-hour forecast. */
export function ensureNextSolForecast(snapshot: MarsWeatherSnapshot): MarsWeatherSnapshot {
  if (
    snapshot.nextSol &&
    Array.isArray(snapshot.nextSol.hourly) &&
    snapshot.nextSol.hourly.length >= 24
  ) {
    return snapshot;
  }
  return {
    ...snapshot,
    nextSol: synthesizeNextSolForecast(snapshot),
  };
}

export interface SampledWeatherPoint {
  offsetHours: number;
  solOffset: 0 | 1;
  sol: number;
  lmstHour: number;
  lmstLabel: string;
  tempK: number;
  pressurePa: number;
  windSpeedMps: number;
  solarIrradianceWm2: number;
  uvIndex: number;
  isDaylight: boolean;
}

function normalizeHourly24(
  hourly: readonly WeatherHourlyPoint[],
  fallback?: readonly WeatherHourlyPoint[],
): WeatherHourlyPoint[] {
  const source = hourly.length > 0 ? hourly : (fallback ?? []);
  const byHour = new Map<number, WeatherHourlyPoint>();
  for (const pt of source) {
    const h = Math.max(0, Math.min(23, Math.round(pt.lmstHour)));
    if (!byHour.has(h)) byHour.set(h, pt);
  }
  const out: WeatherHourlyPoint[] = [];
  for (let h = 0; h < 24; h += 1) {
    const found = byHour.get(h) ?? source[h] ?? source[source.length - 1];
    if (found) {
      out.push(found);
    } else {
      out.push({
        lmstHour: h,
        lmstLabel: `${String(h).padStart(2, "0")}:00`,
        tempK: 210,
        windSpeedMps: 4,
        pressurePa: 750,
        solarIrradianceWm2: 0,
        uvIndex: 0,
        isDaylight: h >= 6 && h <= 18,
      });
    }
  }
  return out;
}

/**
 * Sample continuously interpolated Martian weather at any offset in [0, 48] hours
 * from 00:00 LMST of the base sol. Wraps base sol hourly data if nextSol is absent.
 */
export function sampleWeatherAtOffset(
  snapshot: MarsWeatherSnapshot,
  offsetHours: number,
): SampledWeatherPoint {
  const clamped = Number.isFinite(offsetHours) ? Math.max(0, Math.min(48, offsetHours)) : 0;
  const sol0 = normalizeHourly24(snapshot.hourly);
  const sol1 =
    snapshot.nextSol && snapshot.nextSol.hourly.length > 0
      ? normalizeHourly24(snapshot.nextSol.hourly, sol0)
      : sol0;

  const isSol1 = clamped >= 24;
  const solOffset: 0 | 1 = isSol1 ? 1 : 0;
  const sol = isSol1 ? (snapshot.nextSol?.sol ?? snapshot.sol + 1) : snapshot.sol;
  const isEnd48 = Math.abs(clamped - 48) < 1e-6;
  const lmstHour = isEnd48 ? 24 : roundTo(clamped - solOffset * 24, 4);
  const lmstLabel = formatLmstHHMM(lmstHour, isEnd48);

  const i0 = Math.min(47, Math.floor(clamped));
  const alpha = isEnd48 ? 1 : clamped - i0;
  const fallbackPoint = sol0[0] ?? {
    lmstHour: 0,
    lmstLabel: "00:00",
    tempK: 210,
    windSpeedMps: 4,
    pressurePa: 750,
    solarIrradianceWm2: 0,
    uvIndex: 0,
    isDaylight: false,
  };
  const p0 = (i0 < 24 ? sol0[i0] : sol1[i0 - 24]) ?? fallbackPoint;
  const p1 =
    (i0 + 1 < 24 ? sol0[i0 + 1] : i0 + 1 < 48 ? sol1[i0 + 1 - 24] : sol1[0]) ?? fallbackPoint;

  if (alpha <= 1e-6) {
    return {
      offsetHours: roundTo(clamped, 4),
      solOffset,
      sol,
      lmstHour,
      lmstLabel,
      tempK: p0.tempK,
      pressurePa: p0.pressurePa,
      windSpeedMps: p0.windSpeedMps,
      solarIrradianceWm2: p0.solarIrradianceWm2,
      uvIndex: p0.uvIndex,
      isDaylight: p0.isDaylight,
    };
  }

  let isDaylight = p0.isDaylight;
  if (p0.isDaylight !== p1.isDaylight) {
    const daylightInfo = isSol1
      ? (snapshot.nextSol?.daylight ?? snapshot.daylight)
      : snapshot.daylight;
    const sunriseHour = parseLmstHours(daylightInfo.sunriseLmst);
    const sunsetHour = parseLmstHours(daylightInfo.sunsetLmst);
    const localBase = i0 % 24;
    if (sunriseHour !== null && sunriseHour >= localBase && sunriseHour <= localBase + 1) {
      isDaylight = lmstHour >= sunriseHour;
    } else if (sunsetHour !== null && sunsetHour >= localBase && sunsetHour <= localBase + 1) {
      isDaylight = lmstHour <= sunsetHour;
    } else {
      isDaylight = alpha < 0.5 ? p0.isDaylight : p1.isDaylight;
    }
  }

  return {
    offsetHours: roundTo(clamped, 4),
    solOffset,
    sol,
    lmstHour,
    lmstLabel,
    tempK: roundTo(p0.tempK + alpha * (p1.tempK - p0.tempK), 2),
    pressurePa: roundTo(p0.pressurePa + alpha * (p1.pressurePa - p0.pressurePa), 2),
    windSpeedMps: roundTo(p0.windSpeedMps + alpha * (p1.windSpeedMps - p0.windSpeedMps), 2),
    solarIrradianceWm2: roundTo(
      p0.solarIrradianceWm2 + alpha * (p1.solarIrradianceWm2 - p0.solarIrradianceWm2),
      1,
    ),
    uvIndex: roundTo(p0.uvIndex + alpha * (p1.uvIndex - p0.uvIndex), 2),
    isDaylight,
  };
}

export interface EvaluateEvaOptions {
  limits?: Partial<EvaWeatherLimits>;
  elevationM?: number;
  route?: EvaRouteContext;
  siteMeta?: SiteMetadata | null;
  lmstHour?: number;
}

export interface ComputeTraverseWindowsOptions {
  limits?: Partial<EvaWeatherLimits>;
  elevationM?: number;
  floorElevationM?: number;
  route?: EvaRouteContext;
  siteMeta?: SiteMetadata | null;
  stepHours?: number;
}

export interface TraverseWindowsResult {
  estimatedDurationHours: number;
  departureSlots: TraverseDepartureSlot[];
  recommendedWindows: TraverseWindowRecommendation[];
}

interface WalkTimeSample {
  elapsedHours: number;
  elevationM: number;
}

function resolvePositiveSpeed(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolveLimits(partial?: Partial<EvaWeatherLimits>): EvaWeatherLimits {
  return {
    minAirTempC: partial?.minAirTempC ?? DEFAULT_EVA_LIMITS.minAirTempC,
    maxWindSpeedMps: partial?.maxWindSpeedMps ?? DEFAULT_EVA_LIMITS.maxWindSpeedMps,
    minPressurePa: partial?.minPressurePa ?? DEFAULT_EVA_LIMITS.minPressurePa,
    maxPressureSwingPa: partial?.maxPressureSwingPa ?? DEFAULT_EVA_LIMITS.maxPressureSwingPa,
    maxEvaHours: partial?.maxEvaHours ?? DEFAULT_EVA_LIMITS.maxEvaHours,
    flatSpeedMPerH: resolvePositiveSpeed(
      partial?.flatSpeedMPerH,
      DEFAULT_EVA_LIMITS.flatSpeedMPerH,
    ),
    climbSpeedMPerH: resolvePositiveSpeed(
      partial?.climbSpeedMPerH,
      DEFAULT_EVA_LIMITS.climbSpeedMPerH,
    ),
    descentSpeedMPerH: resolvePositiveSpeed(
      partial?.descentSpeedMPerH,
      DEFAULT_EVA_LIMITS.descentSpeedMPerH,
    ),
  };
}

function computeSegmentHours(
  distM: number,
  gainM: number,
  lossM: number,
  limits: EvaWeatherLimits,
): number {
  return (
    distM / limits.flatSpeedMPerH +
    gainM / limits.climbSpeedMPerH +
    lossM / limits.descentSpeedMPerH
  );
}

function computePointsDurationHours(
  points: readonly TraversePointSample[],
  limits: EvaWeatherLimits,
): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const curr = points[i];
    if (!prev || !curr) continue;
    const dDist = Math.max(0, curr.distanceM - prev.distanceM);
    const dElev = curr.elevationM - prev.elevationM;
    const gain = Math.max(0, dElev);
    const loss = Math.max(0, -dElev);
    total += computeSegmentHours(dDist, gain, loss, limits);
  }
  return total;
}

function resolveRouteDurationHours(
  route: EvaRouteContext | undefined,
  limits: EvaWeatherLimits,
): number | null {
  if (route?.totalDistanceM !== undefined && Number.isFinite(route.totalDistanceM)) {
    const distM = Math.max(0, route.totalDistanceM);
    const gainM = Math.max(0, route.elevationGainM ?? 0);
    const lossM = Math.max(0, route.elevationLossM ?? 0);
    return roundTo(computeSegmentHours(distM, gainM, lossM, limits), 2);
  }
  if (route?.points && route.points.length >= 2) {
    return roundTo(computePointsDurationHours(route.points, limits), 2);
  }
  return null;
}

function buildWalkTimeProfile(
  route: EvaRouteContext | undefined,
  floorElevationM: number,
  evaluationElevationM: number,
  fallbackDurationHours: number,
  limits: EvaWeatherLimits,
): {
  durationHours: number;
  timeGrid: WalkTimeSample[];
  extremaPoints: WalkTimeSample[];
} {
  if (route?.points && route.points.length >= 2) {
    const pts = route.points;
    const rawVertices: WalkTimeSample[] = [
      { elapsedHours: 0, elevationM: pts[0]?.elevationM ?? floorElevationM },
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
      cumHours += computeSegmentHours(dDist, gain, loss, limits);
      rawVertices.push({ elapsedHours: cumHours, elevationM: curr.elevationM });
    }

    const totalDuration = cumHours > 0 ? cumHours : Math.max(0.25, fallbackDurationHours);
    if (cumHours <= 0) {
      for (let i = 0; i < rawVertices.length; i += 1) {
        const v = rawVertices[i];
        if (v) v.elapsedHours = (i / Math.max(1, rawVertices.length - 1)) * totalDuration;
      }
    }

    const numSteps = Math.max(8, Math.min(64, Math.ceil(totalDuration / 0.25)));
    const timeGrid: WalkTimeSample[] = [];
    let vIdx = 0;
    for (let s = 0; s <= numSteps; s += 1) {
      const t = (s / numSteps) * totalDuration;
      while (vIdx + 1 < rawVertices.length - 1 && (rawVertices[vIdx + 1]?.elapsedHours ?? 0) < t) {
        vIdx += 1;
      }
      const v0 = rawVertices[vIdx] ?? { elapsedHours: 0, elevationM: floorElevationM };
      const v1 = rawVertices[Math.min(vIdx + 1, rawVertices.length - 1)] ?? v0;
      const dt = v1.elapsedHours - v0.elapsedHours;
      const frac = dt > 1e-9 ? Math.max(0, Math.min(1, (t - v0.elapsedHours) / dt)) : 0;
      timeGrid.push({
        elapsedHours: t,
        elevationM: v0.elevationM + frac * (v1.elevationM - v0.elevationM),
      });
    }

    const vertexExtrema =
      rawVertices.length <= 120
        ? rawVertices
        : rawVertices.filter(
            (_, idx) =>
              idx === 0 ||
              idx === rawVertices.length - 1 ||
              idx % Math.ceil(rawVertices.length / 60) === 0,
          );

    return {
      durationHours: totalDuration,
      timeGrid,
      extremaPoints: [...timeGrid, ...vertexExtrema],
    };
  }

  const durationHours = Math.max(0.25, fallbackDurationHours);
  let numSteps = Math.max(8, Math.min(64, Math.ceil(durationHours / 0.25)));
  if (numSteps % 2 === 1) numSteps += 1;

  const timeGrid: WalkTimeSample[] = [];
  for (let s = 0; s <= numSteps; s += 1) {
    const u = s / numSteps;
    const elev =
      u <= 0.5
        ? floorElevationM + 2 * u * (evaluationElevationM - floorElevationM)
        : evaluationElevationM + 2 * (u - 0.5) * (floorElevationM - evaluationElevationM);
    timeGrid.push({
      elapsedHours: u * durationHours,
      elevationM: elev,
    });
  }

  return {
    durationHours,
    timeGrid,
    extremaPoints: timeGrid,
  };
}

function statusPriority(status: EvaStatus): number {
  if (status === "GO") return 0;
  if (status === "DEGRADED") return 1;
  return 2;
}

/**
 * Compute time-varying EVA departure slots across 48 hours and rank top traverse windows.
 * Models how air temperature, pressure, wind, UV, and daylight evolve during the walk.
 */
export function computeTraverseWindows(
  snapshot: MarsWeatherSnapshot,
  options: ComputeTraverseWindowsOptions = {},
): TraverseWindowsResult {
  const limits = resolveLimits(options.limits);
  const pts = options.route?.points;
  const pointMinElev =
    pts && pts.length >= 2 ? Math.min(...pts.map((p) => p.elevationM)) : undefined;
  const pointMaxElev =
    pts && pts.length >= 2 ? Math.max(...pts.map((p) => p.elevationM)) : undefined;

  const floorElevationM =
    options.floorElevationM ??
    options.route?.minElevationM ??
    pointMinElev ??
    options.siteMeta?.minElevationM ??
    snapshot.site.minElevationM;
  const evaluationElevationM =
    options.elevationM ??
    options.route?.maxElevationM ??
    pointMaxElev ??
    options.siteMeta?.maxElevationM ??
    snapshot.site.maxElevationM;

  const routeDuration = resolveRouteDurationHours(options.route, limits);
  const targetDuration = routeDuration ?? limits.maxEvaHours;
  const profile = buildWalkTimeProfile(
    options.route,
    floorElevationM,
    evaluationElevationM,
    targetDuration,
    limits,
  );

  const walkDuration = roundTo(profile.durationHours, 2);
  const stepHours = Math.max(
    0.25,
    Math.min(4, options.stepHours ?? (walkDuration <= 12 ? 0.5 : 1.0)),
  );
  const refElevM = snapshot.pressure.referenceElevationM;

  const departureSlots: TraverseDepartureSlot[] = [];
  for (let offset = 0; offset < 48 - 1e-6; offset = roundTo(offset + stepHours, 4)) {
    const solOffset: 0 | 1 = offset >= 24 ? 1 : 0;
    const sol = solOffset === 0 ? snapshot.sol : (snapshot.nextSol?.sol ?? snapshot.sol + 1);
    const startLmstHour = roundTo(offset % 24, 2);
    const startLmstLabel = formatLmstHHMM(startLmstHour);

    const clampedEnd = Math.min(48, offset + walkDuration);
    const endLocal =
      clampedEnd === 24 && offset < 24 ? 24 : clampedEnd === 48 ? 24 : clampedEnd % 24;
    const endLmstHour = roundTo(endLocal, 2);
    const endLmstLabel = formatLmstHHMM(endLocal, endLocal === 24);
    const coveredDuration = roundTo(clampedEnd - offset, 2);
    const timelineCoverage = walkDuration > 0 ? coveredDuration / walkDuration : 1;

    let daylightHits = 0;
    for (const sample of profile.timeGrid) {
      const t = Math.min(48, offset + sample.elapsedHours);
      const w = sampleWeatherAtOffset(snapshot, t);
      if (w.isDaylight) daylightHits += 1;
    }
    const daylightFraction = roundTo(daylightHits / Math.max(1, profile.timeGrid.length), 2);

    let minTempC = Number.POSITIVE_INFINITY;
    let maxTempC = Number.NEGATIVE_INFINITY;
    let minPressurePa = Number.POSITIVE_INFINITY;
    let maxWindMps = Number.NEGATIVE_INFINITY;
    let maxUvIndex = 0;

    for (const sample of profile.extremaPoints) {
      const t = Math.min(48, offset + sample.elapsedHours);
      const w = sampleWeatherAtOffset(snapshot, t);
      const tempC = kelvinToCelsius(lapseTempByElevation(w.tempK, sample.elevationM, refElevM));
      const pressPa = scalePressureByElevation(w.pressurePa, sample.elevationM, refElevM);
      if (tempC < minTempC) minTempC = tempC;
      if (tempC > maxTempC) maxTempC = tempC;
      if (pressPa < minPressurePa) minPressurePa = pressPa;
      if (w.windSpeedMps > maxWindMps) maxWindMps = w.windSpeedMps;
      if (w.uvIndex > maxUvIndex) maxUvIndex = w.uvIndex;
    }

    minTempC = roundTo(minTempC, 1);
    maxTempC = roundTo(maxTempC, 1);
    minPressurePa = roundTo(minPressurePa, 1);
    maxWindMps = roundTo(maxWindMps, 2);
    maxUvIndex = roundTo(maxUvIndex, 2);

    const activeSwingPa =
      solOffset === 1
        ? (snapshot.nextSol?.pressure.swingPa ?? snapshot.pressure.swingPa)
        : snapshot.pressure.swingPa;
    const activeTau =
      solOffset === 1
        ? (snapshot.nextSol?.dustOpacityTau ?? snapshot.dustOpacityTau)
        : snapshot.dustOpacityTau;

    // Classify slot feasibility against suit and route limits
    const hardBlockers: string[] = [];
    const cautionNotes: string[] = [];

    if (walkDuration > limits.maxEvaHours) {
      hardBlockers.push(`walk ${walkDuration} h exceeds ${limits.maxEvaHours} h limit`);
    }
    if (minTempC < limits.minAirTempC) {
      hardBlockers.push(`temp drops to ${minTempC} C (< ${limits.minAirTempC} C)`);
    } else if (minTempC < limits.minAirTempC + 5) {
      cautionNotes.push(`min temp ${minTempC} C near ${limits.minAirTempC} C limit`);
    }

    if (minPressurePa < limits.minPressurePa) {
      hardBlockers.push(`pressure drops to ${minPressurePa} Pa (< ${limits.minPressurePa} Pa)`);
    } else if (minPressurePa < limits.minPressurePa * 1.04) {
      cautionNotes.push(`min pressure ${minPressurePa} Pa within 4% of ${limits.minPressurePa} Pa`);
    }

    if (maxWindMps > limits.maxWindSpeedMps) {
      hardBlockers.push(`wind ${maxWindMps} m/s (> ${limits.maxWindSpeedMps} m/s)`);
    } else if (maxWindMps > limits.maxWindSpeedMps * 0.8) {
      cautionNotes.push(`wind ${maxWindMps} m/s near ${limits.maxWindSpeedMps} m/s limit`);
    }

    if (activeSwingPa > limits.maxPressureSwingPa) {
      hardBlockers.push(`baro swing ${activeSwingPa} Pa (> ${limits.maxPressureSwingPa} Pa)`);
    } else if (activeSwingPa > limits.maxPressureSwingPa * 0.85) {
      cautionNotes.push(`baro swing ${activeSwingPa} Pa near ${limits.maxPressureSwingPa} Pa`);
    }

    if (daylightFraction < 0.5) {
      hardBlockers.push(`only ${Math.round(daylightFraction * 100)}% daylight`);
    } else if (daylightFraction < 1) {
      cautionNotes.push(`${Math.round(daylightFraction * 100)}% daylight`);
    }

    if (activeTau > 1.5) {
      cautionNotes.push(`high dust tau ${roundTo(activeTau, 2)}`);
    }

    if (timelineCoverage < 0.5) {
      hardBlockers.push("exceeds 48 h forecast horizon");
    } else if (timelineCoverage < 1) {
      cautionNotes.push("truncated at 48 h horizon");
    }

    const status: EvaStatus =
      hardBlockers.length > 0 ? "NO-GO" : cautionNotes.length > 0 ? "DEGRADED" : "GO";

    // Composite safety score in [0, 100]
    const tempMargin = minTempC - limits.minAirTempC;
    const tempScore =
      tempMargin >= 0
        ? 0.5 + 0.5 * Math.min(1, tempMargin / 30)
        : Math.max(0, 0.4 * (1 + tempMargin / 30));

    const pressMargin = minPressurePa - limits.minPressurePa;
    const pressScore =
      pressMargin >= 0
        ? 0.5 + 0.5 * Math.min(1, pressMargin / 120)
        : Math.max(0, 0.4 * (1 + pressMargin / 100));

    const windMargin = limits.maxWindSpeedMps - maxWindMps;
    const windScore =
      windMargin >= 0
        ? 0.5 + 0.5 * Math.min(1, windMargin / Math.max(4, limits.maxWindSpeedMps * 0.6))
        : Math.max(0, 0.4 * (1 + windMargin / 10));

    const dustScore = Math.max(0.1, Math.min(1, 1 - Math.max(0, activeTau - 0.35) * 0.32));

    let rawScore =
      100 *
      (0.3 * tempScore +
        0.25 * daylightFraction +
        0.2 * windScore +
        0.15 * pressScore +
        0.1 * dustScore);

    if (activeSwingPa > limits.maxPressureSwingPa) {
      rawScore *= 0.85;
    }
    if (walkDuration > limits.maxEvaHours) {
      rawScore *= 0.75;
    }

    const score = roundTo(
      status === "GO"
        ? Math.min(100, Math.max(70, rawScore))
        : status === "DEGRADED"
          ? Math.min(79, Math.max(35, rawScore * 0.88))
          : Math.min(48, Math.max(0, rawScore * 0.65)),
      1,
    );

    const reason =
      status === "GO"
        ? `Min ${minTempC} C, min ${minPressurePa} Pa, max wind ${maxWindMps} m/s, 100% daylight.`
        : status === "DEGRADED"
          ? `${cautionNotes.join("; ")}.`
          : `${hardBlockers.join("; ")}.`;

    departureSlots.push({
      offsetHours: roundTo(offset, 2),
      solOffset,
      sol,
      startLmstHour,
      startLmstLabel,
      endLmstHour,
      endLmstLabel,
      durationHours: coveredDuration,
      status,
      score,
      minEncounteredTempC: minTempC,
      maxEncounteredTempC: maxTempC,
      minEncounteredPressurePa: minPressurePa,
      maxEncounteredWindMps: maxWindMps,
      maxUvIndex,
      daylightFraction,
      reason,
    });
  }

  const groupContiguousRuns = (
    predicate: (slot: TraverseDepartureSlot) => boolean,
  ): TraverseDepartureSlot[][] => {
    const runs: TraverseDepartureSlot[][] = [];
    let current: TraverseDepartureSlot[] = [];
    for (const slot of departureSlots) {
      const prev = current[current.length - 1];
      if (
        predicate(slot) &&
        (!prev ||
          (prev.solOffset === slot.solOffset &&
            prev.status === slot.status &&
            slot.offsetHours - prev.offsetHours <= stepHours + 1e-4))
      ) {
        current.push(slot);
      } else {
        if (current.length > 0) runs.push(current);
        current = predicate(slot) ? [slot] : [];
      }
    }
    if (current.length > 0) runs.push(current);
    return runs;
  };

  const goRuns = groupContiguousRuns((s) => s.status === "GO");
  const degradedRuns = groupContiguousRuns((s) => s.status === "DEGRADED");

  const candidateRuns: TraverseDepartureSlot[][] = [...goRuns, ...degradedRuns];
  if (candidateRuns.length === 0) {
    // Everything is NO-GO: surface peak-scoring emergency intervals per sol
    for (const solOff of [0, 1] as const) {
      const solSlots = departureSlots.filter((s) => s.solOffset === solOff);
      if (solSlots.length === 0) continue;
      const peak = Math.max(...solSlots.map((s) => s.score));
      const threshold = peak - Math.max(4, peak * 0.12);
      const runs = groupContiguousRuns((s) => s.solOffset === solOff && s.score >= threshold);
      candidateRuns.push(...runs);
    }
  }

  const recommendations: TraverseWindowRecommendation[] = candidateRuns
    .flatMap((run): TraverseWindowRecommendation[] => {
      const first = run[0];
      const last = run[run.length - 1];
      if (!first || !last) return [];
      const midOffset = (first.offsetHours + last.offsetHours) / 2;

      let best = first;
      for (const candidate of run) {
        if (
          candidate.score > best.score + 0.05 ||
          (Math.abs(candidate.score - best.score) <= 0.05 &&
            Math.abs(candidate.offsetHours - midOffset) < Math.abs(best.offsetHours - midOffset))
        ) {
          best = candidate;
        }
      }

      const solBoundary = first.solOffset === 0 ? 24 : 48;
      const startOffsetHours = first.offsetHours;
      const endOffsetHours = roundTo(Math.min(solBoundary, last.offsetHours + stepHours), 2);
      const windowSpanHours = roundTo(endOffsetHours - startOffsetHours, 2);
      const windowStartLmst = formatLmstHHMM(startOffsetHours % 24);
      const endIsBoundary = endOffsetHours === 24 || endOffsetHours === 48;
      const windowEndLmst = formatLmstHHMM(endIsBoundary ? 24 : endOffsetHours % 24, endIsBoundary);

      const minTempC = roundTo(Math.min(...run.map((s) => s.minEncounteredTempC)), 1);
      const maxTempC = roundTo(Math.max(...run.map((s) => s.maxEncounteredTempC)), 1);
      const minPressurePa = roundTo(Math.min(...run.map((s) => s.minEncounteredPressurePa)), 1);
      const maxWindMps = roundTo(Math.max(...run.map((s) => s.maxEncounteredWindMps)), 2);

      return [
        {
          id: `sol${first.sol}-${first.status.toLowerCase()}-${Math.round(startOffsetHours * 10)}`,
          rank: 0,
          solOffset: first.solOffset,
          sol: first.sol,
          startOffsetHours,
          endOffsetHours,
          bestDepartureOffsetHours: best.offsetHours,
          bestDepartureLmst: best.startLmstLabel,
          windowStartLmst,
          windowEndLmst,
          windowSpanHours,
          estimatedDurationHours: walkDuration,
          status: first.status,
          score: best.score,
          minTempC,
          maxTempC,
          minPressurePa,
          maxWindMps,
          daylightFraction: best.daylightFraction,
          summary: `Depart ${windowStartLmst}-${windowEndLmst} LMST (best ${best.startLmstLabel}), ${walkDuration} h EVA, ${minTempC} to ${maxTempC} C, min ${minPressurePa} Pa, max wind ${maxWindMps} m/s.`,
        },
      ];
    })
    .sort((a, b) => {
      const statusDiff = statusPriority(a.status) - statusPriority(b.status);
      if (statusDiff !== 0) return statusDiff;
      if (b.score !== a.score) return b.score - a.score;
      if (b.windowSpanHours !== a.windowSpanHours) return b.windowSpanHours - a.windowSpanHours;
      return a.startOffsetHours - b.startOffsetHours;
    })
    .slice(0, 4)
    .map((win, idx) => ({ ...win, rank: idx + 1 }));

  return {
    estimatedDurationHours: walkDuration,
    departureSlots,
    recommendedWindows: recommendations,
  };
}

function worstStatus(statuses: readonly EvaStatus[]): EvaStatus {
  if (statuses.includes("NO-GO")) return "NO-GO";
  if (statuses.includes("DEGRADED")) return "DEGRADED";
  return "GO";
}

/** Find longest contiguous safe traverse window across the 24-hour Martian sol. */
function findSafeTraverseWindow(
  hourly: readonly WeatherHourlyPoint[],
  referenceElevationM: number,
  targetElevationM: number,
  minAirTempK: number,
  maxWindSpeedMps: number,
): { window: EvaSafeWindow; thermalDaylightHours: number } {
  let thermalDaylightHours = 0;

  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;

  for (let i = 0; i < hourly.length; i += 1) {
    const pt = hourly[i];
    if (!pt) continue;
    const rimTempK = lapseTempByElevation(pt.tempK, targetElevationM, referenceElevationM);
    if (pt.isDaylight && rimTempK >= minAirTempK) {
      thermalDaylightHours += 1;
    }

    const hourSafe = pt.isDaylight && rimTempK >= minAirTempK && pt.windSpeedMps <= maxWindSpeedMps;
    if (hourSafe) {
      if (curStart === -1) curStart = pt.lmstHour;
      curLen += 1;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }

  if (bestLen === 0 || bestStart === -1) {
    return {
      thermalDaylightHours,
      window: {
        startLmstHour: null,
        endLmstHour: null,
        startLmst: null,
        endLmst: null,
        durationHours: 0,
        minTempK: null,
        maxTempK: null,
        maxWindMps: null,
        note: "No daylight hour meets thermal and wind limits.",
      },
    };
  }

  const endHour = Math.min(24, bestStart + bestLen);
  const windowPoints = hourly.filter((pt) => pt.lmstHour >= bestStart && pt.lmstHour < endHour);
  const rimTemps = windowPoints.map((pt) =>
    lapseTempByElevation(pt.tempK, targetElevationM, referenceElevationM),
  );
  const maxWindMps = Math.max(...windowPoints.map((pt) => pt.windSpeedMps));
  const minTempK = roundTo(Math.min(...rimTemps), 2);
  const maxTempK = roundTo(Math.max(...rimTemps), 2);
  const startLmst = `${String(bestStart).padStart(2, "0")}:00`;
  const endLmst = `${String(endHour).padStart(2, "0")}:00`;

  return {
    thermalDaylightHours,
    window: {
      startLmstHour: bestStart,
      endLmstHour: endHour,
      startLmst,
      endLmst,
      durationHours: bestLen,
      minTempK,
      maxTempK,
      maxWindMps: roundTo(maxWindMps, 2),
      note: `Safe traverse window ${startLmst}-${endLmst} LMST (${bestLen} h, ${roundTo(kelvinToCelsius(minTempK), 1)} to ${roundTo(kelvinToCelsius(maxTempK), 1)} C).`,
    },
  };
}

/**
 * Evaluate Martian weather snapshot against astronaut suit and EVA limits,
 * accounting for crater rim elevation scaling and optional route traverse duration.
 */
export function evaluateEvaWeather(
  snapshot: MarsWeatherSnapshot,
  options: EvaluateEvaOptions = {},
): EvaWeatherEvaluation {
  const limits = resolveLimits(options.limits);
  const pts = options.route?.points;
  const pointMinElev =
    pts && pts.length >= 2 ? Math.min(...pts.map((p) => p.elevationM)) : undefined;
  const pointMaxElev =
    pts && pts.length >= 2 ? Math.max(...pts.map((p) => p.elevationM)) : undefined;

  const minAirTempK = celsiusToKelvin(limits.minAirTempC);
  const floorElevationM = roundTo(
    options.route?.minElevationM ??
      pointMinElev ??
      options.siteMeta?.minElevationM ??
      snapshot.site.minElevationM,
    1,
  );
  const evaluationElevationM = roundTo(
    options.route?.maxElevationM ??
      options.elevationM ??
      pointMaxElev ??
      options.siteMeta?.maxElevationM ??
      snapshot.site.maxElevationM,
    1,
  );

  const refElevM = snapshot.pressure.referenceElevationM;
  const rimPressureMinPa = roundTo(
    scalePressureByElevation(snapshot.pressure.minPa, evaluationElevationM, refElevM),
    1,
  );
  const rimPressureAvgPa = roundTo(
    scalePressureByElevation(snapshot.pressure.avgPa, evaluationElevationM, refElevM),
    1,
  );
  const rimTempMinK = roundTo(
    lapseTempByElevation(snapshot.airTemp.minK, evaluationElevationM, refElevM),
    2,
  );
  const rimTempMaxK = roundTo(
    lapseTempByElevation(snapshot.airTemp.maxK, evaluationElevationM, refElevM),
    2,
  );

  const estimatedRouteHours = resolveRouteDurationHours(options.route, limits);

  const requiredHours = estimatedRouteHours ?? limits.maxEvaHours;
  const { window: safeWindow, thermalDaylightHours } = findSafeTraverseWindow(
    snapshot.hourly,
    refElevM,
    evaluationElevationM,
    minAirTempK,
    limits.maxWindSpeedMps,
  );

  // Selected hour weather summary in [0, 48] (defaults to 12:00 LMST of base sol)
  const selectedLmstHour =
    options.lmstHour !== undefined && Number.isFinite(options.lmstHour)
      ? roundTo(Math.max(0, Math.min(48, options.lmstHour)), 2)
      : 12;
  const sampled = sampleWeatherAtOffset(snapshot, selectedLmstHour);
  const selectedHourWeather: SelectedHourWeatherSummary = {
    offsetHours: sampled.offsetHours,
    sol: sampled.sol,
    lmstLabel: sampled.lmstLabel,
    floorTempC: roundTo(
      kelvinToCelsius(lapseTempByElevation(sampled.tempK, floorElevationM, refElevM)),
      1,
    ),
    rimTempC: roundTo(
      kelvinToCelsius(lapseTempByElevation(sampled.tempK, evaluationElevationM, refElevM)),
      1,
    ),
    floorPressurePa: roundTo(
      scalePressureByElevation(sampled.pressurePa, floorElevationM, refElevM),
      1,
    ),
    rimPressurePa: roundTo(
      scalePressureByElevation(sampled.pressurePa, evaluationElevationM, refElevM),
      1,
    ),
    windSpeedMps: sampled.windSpeedMps,
    uvIndex: sampled.uvIndex,
    isDaylight: sampled.isDaylight,
  };

  // Time-varying 48-hour traverse window simulation
  const { departureSlots, recommendedWindows } = computeTraverseWindows(snapshot, {
    limits,
    elevationM: evaluationElevationM,
    floorElevationM,
    route: options.route,
    siteMeta: options.siteMeta,
  });

  // 1. Air temperature check (evaluated in Kelvin internally, reported in °C)
  const rimTempMinC = roundTo(kelvinToCelsius(rimTempMinK), 1);
  const rimTempMaxC = roundTo(kelvinToCelsius(rimTempMaxK), 1);
  let tempStatus: EvaStatus = "GO";
  let tempReason = `AT MIN ${rimTempMinC} C ABOVE ${limits.minAirTempC} C LIMIT`;
  if (rimTempMaxK < minAirTempK || thermalDaylightHours === 0) {
    tempStatus = "NO-GO";
    tempReason = `PEAK ${rimTempMaxC} C BELOW ${limits.minAirTempC} C LIMIT; 0 SAFE HOURS`;
  } else if (thermalDaylightHours < requiredHours) {
    tempStatus = "NO-GO";
    tempReason = `ONLY ${thermalDaylightHours} h ABOVE ${limits.minAirTempC} C; NEED ${requiredHours} h`;
  } else if (rimTempMinK < minAirTempK) {
    tempStatus = "DEGRADED";
    tempReason = `NIGHT LOW ${rimTempMinC} C BELOW ${limits.minAirTempC} C; USE ${safeWindow.startLmst ?? "DAY"}-${safeWindow.endLmst ?? "LIGHT"} LMST`;
  }

  // 2. Wind speed check
  let windStatus: EvaStatus = "GO";
  let windReason = `PEAK GUST ${snapshot.wind.maxMps} m/s (${snapshot.wind.compassPoint}) WITHIN ${limits.maxWindSpeedMps} m/s`;
  if (snapshot.wind.maxMps > limits.maxWindSpeedMps) {
    windStatus = "NO-GO";
    windReason = `GUST ${snapshot.wind.maxMps} m/s EXCEEDS ${limits.maxWindSpeedMps} m/s LIMIT`;
  } else if (snapshot.wind.maxMps > limits.maxWindSpeedMps * 0.8) {
    windStatus = "DEGRADED";
    windReason = `GUST ${snapshot.wind.maxMps} m/s NEAR ${limits.maxWindSpeedMps} m/s LIMIT`;
  }

  // 3. Rim pressure check
  let pressureStatus: EvaStatus = "GO";
  let pressureReason = `RIM MIN ${rimPressureMinPa} Pa AT ${Math.round(evaluationElevationM)} m ABOVE ${limits.minPressurePa} Pa`;
  if (rimPressureMinPa < limits.minPressurePa) {
    pressureStatus = "NO-GO";
    pressureReason = `RIM MIN ${rimPressureMinPa} Pa AT ${Math.round(evaluationElevationM)} m BELOW ${limits.minPressurePa} Pa`;
  } else if (rimPressureMinPa < limits.minPressurePa * 1.04) {
    pressureStatus = "DEGRADED";
    pressureReason = `RIM MIN ${rimPressureMinPa} Pa WITHIN 4% OF ${limits.minPressurePa} Pa`;
  }

  // 4. Diurnal pressure swing check
  let swingStatus: EvaStatus = "GO";
  let swingReason = `SWING ${snapshot.pressure.swingPa} Pa WITHIN ${limits.maxPressureSwingPa} Pa`;
  if (snapshot.pressure.swingPa > limits.maxPressureSwingPa) {
    swingStatus = "NO-GO";
    swingReason = `SWING ${snapshot.pressure.swingPa} Pa EXCEEDS ${limits.maxPressureSwingPa} Pa LIMIT`;
  } else if (snapshot.pressure.swingPa > limits.maxPressureSwingPa * 0.85) {
    swingStatus = "DEGRADED";
    swingReason = `SWING ${snapshot.pressure.swingPa} Pa NEAR ${limits.maxPressureSwingPa} Pa LIMIT`;
  }

  // 5. EVA duration & safe window check
  let durationStatus: EvaStatus = "GO";
  let durationReason =
    estimatedRouteHours !== null
      ? `ROUTE ${estimatedRouteHours} h FITS ${safeWindow.durationHours} h WINDOW`
      : `WINDOW ${safeWindow.durationHours} h MEETS ${limits.maxEvaHours} h EVA LIMIT`;
  if (estimatedRouteHours !== null && estimatedRouteHours > limits.maxEvaHours) {
    durationStatus = "NO-GO";
    durationReason = `ROUTE ${estimatedRouteHours} h EXCEEDS ${limits.maxEvaHours} h SUIT LIMIT`;
  } else if (safeWindow.durationHours < requiredHours) {
    durationStatus = "NO-GO";
    durationReason = `SAFE WINDOW ${safeWindow.durationHours} h SHORTER THAN ${requiredHours} h EVA`;
  } else if (safeWindow.durationHours < requiredHours + 1.0) {
    durationStatus = "DEGRADED";
    durationReason = `TIGHT MARGIN: ${safeWindow.durationHours} h WINDOW FOR ${requiredHours} h EVA`;
  }

  const checks: EvaWeatherCheck[] = [
    {
      id: "air_temp",
      label: "AIR TEMP",
      status: tempStatus,
      measuredValue:
        tempStatus === "NO-GO" && rimTempMaxK < minAirTempK ? rimTempMaxC : rimTempMinC,
      limitValue: roundTo(limits.minAirTempC, 1),
      unit: "C",
      margin: roundTo(
        (tempStatus === "NO-GO" && rimTempMaxK < minAirTempK ? rimTempMaxC : rimTempMinC) -
          limits.minAirTempC,
        1,
      ),
      reason: tempReason,
    },
    {
      id: "wind_speed",
      label: "WIND",
      status: windStatus,
      measuredValue: snapshot.wind.maxMps,
      limitValue: roundTo(limits.maxWindSpeedMps, 1),
      unit: "m/s",
      margin: roundTo(limits.maxWindSpeedMps - snapshot.wind.maxMps, 2),
      reason: windReason,
    },
    {
      id: "pressure",
      label: "PRESSURE",
      status: pressureStatus,
      measuredValue: rimPressureMinPa,
      limitValue: roundTo(limits.minPressurePa, 1),
      unit: "Pa",
      margin: roundTo(rimPressureMinPa - limits.minPressurePa, 1),
      reason: pressureReason,
    },
    {
      id: "pressure_swing",
      label: "PRESSURE SWING",
      status: swingStatus,
      measuredValue: snapshot.pressure.swingPa,
      limitValue: roundTo(limits.maxPressureSwingPa, 1),
      unit: "Pa",
      margin: roundTo(limits.maxPressureSwingPa - snapshot.pressure.swingPa, 1),
      reason: swingReason,
    },
    {
      id: "eva_duration",
      label: "EVA WINDOW",
      status: durationStatus,
      measuredValue: estimatedRouteHours ?? safeWindow.durationHours,
      limitValue: roundTo(limits.maxEvaHours, 2),
      unit: "h",
      margin: roundTo(
        estimatedRouteHours !== null
          ? limits.maxEvaHours - estimatedRouteHours
          : safeWindow.durationHours - limits.maxEvaHours,
        2,
      ),
      reason: durationReason,
    },
  ];

  const status = worstStatus(checks.map((c) => c.status));
  const blockers = checks.filter((c) => c.status !== "GO");
  const summary =
    blockers.length === 0
      ? `EVA GO. Safe traverse window ${safeWindow.startLmst ?? "daylight"}-${safeWindow.endLmst ?? ""} LMST (${safeWindow.durationHours} h).`
      : `EVA ${status}: ${blockers.map((b) => `${b.label} (${b.reason})`).join("; ")}.`;

  return {
    status,
    limits,
    evaluationElevationM,
    floorElevationM,
    rimPressureMinPa,
    rimPressureAvgPa,
    rimTempMinK,
    rimTempMaxK,
    estimatedRouteHours,
    safeWindow,
    checks,
    summary,
    selectedLmstHour,
    selectedHourWeather,
    departureSlots,
    recommendedWindows,
    weatherSource: {
      isSimulated: snapshot.isSimulated,
      sourceType: snapshot.sourceType,
      sourceLabel: snapshot.sourceLabel,
      disclaimer: snapshot.disclaimer,
    },
  };
}
