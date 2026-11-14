import type {
  MarsWeatherSnapshot,
  SiteEnvironmentSummary,
  WeatherHourlyPoint,
  WeatherScenario,
} from "@nimbs/shared";
import { encodeRgbaPng } from "../utils/png";
import {
  MARS_LAPSE_RATE_K_PER_M,
  MARS_OBLIQUITY_RAD,
  MARS_SCALE_HEIGHT_M,
  celsiusToKelvin,
  kelvinToCelsius,
} from "../weather/generator";
import type { TerrainGraph } from "./engine";

const MAX_FIELD_CACHE_ENTRIES = 8;
const MAX_PNG_CACHE_ENTRIES = 16;
const IS_LITTLE_ENDIAN = new Uint32Array(new Uint8Array([1, 2, 3, 4]).buffer)[0] === 0x04030201;

export interface SiteWeatherField {
  siteId: string;
  sol: number;
  lmstHour: number;
  lmstLabel: string;
  scenario: WeatherScenario;
  isSimulated: boolean;
  tempK: Float32Array;
  pressurePa: Float32Array;
  minTempC: number;
  maxTempC: number;
  meanTempC: number;
  minPressurePa: number;
  maxPressurePa: number;
  meanPressurePa: number;
}

export interface InterpolatedWeatherSample {
  sol: number;
  lmstHour: number;
  lmstLabel: string;
  lsDeg: number;
  dustOpacityTau: number;
  referenceElevationM: number;
  tempK: number;
  pressurePa: number;
  solarIrradianceWm2: number;
  isDaylight: boolean;
}

interface SpatialTerrainCache {
  graphId: number;
  normalX: Float32Array;
  normalY: Float32Array;
  normalZ: Float32Array;
  basinDepthM: Float32Array;
  expHeightFactor: Float32Array;
}

interface CachedFieldEntry {
  cacheKey: string;
  field: SiteWeatherField;
}

class LruCache<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly maxEntries: number) {}

  get(key: K): V | undefined {
    const val = this.map.get(key);
    if (val === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, val);
    return val;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        this.map.delete(oldest);
      }
    }
    this.map.set(key, value);
  }
}

const spatialCacheByGraph = new WeakMap<TerrainGraph, SpatialTerrainCache>();
const fieldKeyByField = new WeakMap<SiteWeatherField, string>();
const fieldLruCache = new LruCache<string, CachedFieldEntry>(MAX_FIELD_CACHE_ENTRIES);
const pngLruCache = new LruCache<string, Uint8Array>(MAX_PNG_CACHE_ENTRIES);
let nextGraphId = 1;

function roundTo(val: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(val * factor) / factor;
}

function clampLmstHour(lmstHour: number): number {
  if (!Number.isFinite(lmstHour)) return 12;
  return Math.max(0, Math.min(48, lmstHour));
}

function formatLmstLabel(lmstHour: number): string {
  const wrapped = ((lmstHour % 24) + 24) % 24;
  const totalMinutes = Math.round(wrapped * 60);
  const hh = Math.floor(totalMinutes / 60) % 24;
  const mm = totalMinutes % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function pickHourPoint(
  hourly: readonly WeatherHourlyPoint[],
  targetHour: number,
): WeatherHourlyPoint | null {
  if (hourly.length === 0) return null;
  const direct = hourly[targetHour];
  if (direct && direct.lmstHour === targetHour) return direct;
  const matched = hourly.find((pt) => pt.lmstHour === targetHour);
  if (matched) return matched;
  return hourly[targetHour % hourly.length] ?? hourly[0] ?? null;
}

function resolveTimelinePoint(
  snapshot: MarsWeatherSnapshot,
  hourIdx: number,
): WeatherHourlyPoint | null {
  const nextHourly = snapshot.nextSol?.hourly;
  const hasNext = Array.isArray(nextHourly) && nextHourly.length > 0;
  if (hourIdx < 24) {
    return pickHourPoint(snapshot.hourly, hourIdx);
  }
  const wrappedHour = hourIdx % 24;
  if (hasNext) {
    return pickHourPoint(nextHourly, wrappedHour);
  }
  return pickHourPoint(snapshot.hourly, wrappedHour);
}

/**
 * Interpolate hourly Mars weather fields over [0, 48] LMST hours,
 * chaining into snapshot.nextSol when available and wrapping smoothly if absent.
 */
export function interpolateWeatherAtHour(
  snapshot: MarsWeatherSnapshot,
  lmstHour: number,
): InterpolatedWeatherSample {
  const clampedHour = clampLmstHour(lmstHour);
  const h0 = Math.floor(clampedHour);
  const h1 = h0 >= 48 ? 48 : h0 + 1;
  const frac = clampedHour - h0;

  const pt0 = resolveTimelinePoint(snapshot, h0);
  const pt1 = resolveTimelinePoint(snapshot, h1) ?? pt0;

  const fallbackTempK = snapshot.airTemp.avgK;
  const fallbackPressurePa = snapshot.pressure.avgPa;
  const tempK =
    pt0 && pt1 ? pt0.tempK * (1 - frac) + pt1.tempK * frac : (pt0?.tempK ?? fallbackTempK);
  const pressurePa =
    pt0 && pt1
      ? pt0.pressurePa * (1 - frac) + pt1.pressurePa * frac
      : (pt0?.pressurePa ?? fallbackPressurePa);
  const solarIrradianceWm2 =
    pt0 && pt1
      ? pt0.solarIrradianceWm2 * (1 - frac) + pt1.solarIrradianceWm2 * frac
      : (pt0?.solarIrradianceWm2 ?? 0);
  const isDaylight =
    solarIrradianceWm2 > 0 && Boolean((pt0?.isDaylight ?? false) || (pt1?.isDaylight ?? false));

  let lsDeg = snapshot.lsDeg;
  if (snapshot.nextSol) {
    const dLs = ((snapshot.nextSol.lsDeg - snapshot.lsDeg + 540) % 360) - 180;
    lsDeg = (((snapshot.lsDeg + dLs * (clampedHour / 24)) % 360) + 360) % 360;
  }

  const isSecondSol = clampedHour >= 24;
  const sol = isSecondSol ? (snapshot.nextSol?.sol ?? snapshot.sol + 1) : snapshot.sol;
  const dustOpacityTau =
    isSecondSol && snapshot.nextSol ? snapshot.nextSol.dustOpacityTau : snapshot.dustOpacityTau;
  const referenceElevationM =
    isSecondSol && snapshot.nextSol
      ? snapshot.nextSol.pressure.referenceElevationM
      : snapshot.pressure.referenceElevationM;

  return {
    sol,
    lmstHour: roundTo(clampedHour, 2),
    lmstLabel: formatLmstLabel(clampedHour),
    lsDeg: roundTo(lsDeg, 2),
    dustOpacityTau,
    referenceElevationM,
    tempK,
    pressurePa,
    solarIrradianceWm2,
    isDaylight,
  };
}

function computeSpatialTerrainCache(graph: TerrainGraph): SpatialTerrainCache {
  const existing = spatialCacheByGraph.get(graph);
  if (existing) return existing;

  const rows = graph.rows;
  const cols = graph.cols;
  const totalCells = graph.totalCells;
  const elev = graph.elevations;
  const valid = graph.getValidMask();
  const dxM = Math.max(1e-6, graph.dxM);
  const dyM = Math.max(1e-6, graph.dyM);
  const inv2Dx = 1 / (2 * dxM);
  const inv2Dy = 1 / (2 * dyM);
  const invDx = 1 / dxM;
  const invDy = 1 / dyM;

  const normalX = new Float32Array(totalCells);
  const normalY = new Float32Array(totalCells);
  const normalZ = new Float32Array(totalCells);
  const basinDepthM = new Float32Array(totalCells);
  const expHeightFactor = new Float32Array(totalCells);

  // 1. Precompute barometric height exponential factor and ENU surface unit normals
  for (let r = 0; r < rows; r += 1) {
    const rowBase = r * cols;
    const hasNorth = r > 0;
    const hasSouth = r + 1 < rows;

    for (let c = 0; c < cols; c += 1) {
      const u = rowBase + c;
      if (!valid[u]) {
        normalZ[u] = 1;
        continue;
      }

      const elevU = elev[u] ?? 0;
      expHeightFactor[u] = Math.exp(-elevU / MARS_SCALE_HEIGHT_M);

      const leftValid = c > 0 && valid[u - 1] === 1;
      const rightValid = c + 1 < cols && valid[u + 1] === 1;
      let dzdx = 0;
      if (leftValid && rightValid) {
        dzdx = ((elev[u + 1] ?? elevU) - (elev[u - 1] ?? elevU)) * inv2Dx;
      } else if (rightValid) {
        dzdx = ((elev[u + 1] ?? elevU) - elevU) * invDx;
      } else if (leftValid) {
        dzdx = (elevU - (elev[u - 1] ?? elevU)) * invDx;
      }

      const northValid = hasNorth && valid[u - cols] === 1;
      const southValid = hasSouth && valid[u + cols] === 1;
      let dzdy = 0;
      if (northValid && southValid) {
        dzdy = ((elev[u - cols] ?? elevU) - (elev[u + cols] ?? elevU)) * inv2Dy;
      } else if (northValid) {
        dzdy = ((elev[u - cols] ?? elevU) - elevU) * invDy;
      } else if (southValid) {
        dzdy = (elevU - (elev[u + cols] ?? elevU)) * invDy;
      }

      const invLen = 1 / Math.hypot(dzdx, dzdy, 1);
      normalX[u] = -dzdx * invLen;
      normalY[u] = -dzdy * invLen;
      normalZ[u] = invLen;
    }
  }

  // 2. O(N) separable sliding-window local mean to extract topographic concavity / basin depth
  const radius = Math.max(
    2,
    Math.min(10, Math.round(200 / Math.max(10, graph.meta.cellSizeMeters))),
  );
  const hSum = new Float32Array(totalCells);
  const hCnt = new Uint16Array(totalCells);

  for (let r = 0; r < rows; r += 1) {
    const rowBase = r * cols;
    let sum = 0;
    let cnt = 0;
    const initEnd = Math.min(cols - 1, radius);
    for (let k = 0; k <= initEnd; k += 1) {
      const idx = rowBase + k;
      if (valid[idx] === 1) {
        sum += elev[idx] ?? 0;
        cnt += 1;
      }
    }
    for (let c = 0; c < cols; c += 1) {
      const u = rowBase + c;
      hSum[u] = sum;
      hCnt[u] = cnt;

      const remC = c - radius;
      if (remC >= 0) {
        const remIdx = rowBase + remC;
        if (valid[remIdx] === 1) {
          sum -= elev[remIdx] ?? 0;
          cnt -= 1;
        }
      }
      const addC = c + 1 + radius;
      if (addC < cols) {
        const addIdx = rowBase + addC;
        if (valid[addIdx] === 1) {
          sum += elev[addIdx] ?? 0;
          cnt += 1;
        }
      }
    }
  }

  for (let c = 0; c < cols; c += 1) {
    let sum = 0;
    let cnt = 0;
    const initEnd = Math.min(rows - 1, radius);
    for (let k = 0; k <= initEnd; k += 1) {
      const idx = k * cols + c;
      sum += hSum[idx] ?? 0;
      cnt += hCnt[idx] ?? 0;
    }
    for (let r = 0; r < rows; r += 1) {
      const u = r * cols + c;
      if (valid[u] === 1 && cnt > 0) {
        const localMean = sum / cnt;
        const depth = localMean - (elev[u] ?? 0);
        basinDepthM[u] = depth > 0 ? depth : 0;
      }

      const remR = r - radius;
      if (remR >= 0) {
        const remIdx = remR * cols + c;
        sum -= hSum[remIdx] ?? 0;
        cnt -= hCnt[remIdx] ?? 0;
      }
      const addR = r + 1 + radius;
      if (addR < rows) {
        const addIdx = addR * cols + c;
        sum += hSum[addIdx] ?? 0;
        cnt += hCnt[addIdx] ?? 0;
      }
    }
  }

  const cache: SpatialTerrainCache = {
    graphId: nextGraphId,
    normalX,
    normalY,
    normalZ,
    basinDepthM,
    expHeightFactor,
  };
  nextGraphId += 1;
  spatialCacheByGraph.set(graph, cache);
  return cache;
}

/**
 * Compute per-cell Martian air temperature (K) and surface pressure (Pa) over a TerrainGraph
 * for a given weather snapshot and LMST simulation hour [0, 48].
 */
export function computeSiteWeatherField(
  graph: TerrainGraph,
  snapshot: MarsWeatherSnapshot,
  lmstHour: number,
): SiteWeatherField {
  const spatial = computeSpatialTerrainCache(graph);
  const sample = interpolateWeatherAtHour(snapshot, lmstHour);

  const cacheKey = [
    spatial.graphId,
    snapshot.site.siteId,
    sample.sol,
    snapshot.scenario,
    sample.lsDeg.toFixed(2),
    sample.dustOpacityTau.toFixed(2),
    sample.referenceElevationM.toFixed(1),
    sample.tempK.toFixed(3),
    sample.pressurePa.toFixed(3),
    sample.solarIrradianceWm2.toFixed(2),
    sample.isDaylight ? "1" : "0",
    sample.lmstHour.toFixed(2),
  ].join("|");

  const cached = fieldLruCache.get(cacheKey);
  if (cached) return cached.field;

  const totalCells = graph.totalCells;
  const elev = graph.elevations;
  const valid = graph.getValidMask();
  const { normalX, normalY, normalZ, basinDepthM, expHeightFactor } = spatial;

  const tempK = new Float32Array(totalCells);
  const pressurePa = new Float32Array(totalCells);

  const pScale = sample.pressurePa * Math.exp(sample.referenceElevationM / MARS_SCALE_HEIGHT_M);
  const baseTempAtZero = sample.tempK - MARS_LAPSE_RATE_K_PER_M * sample.referenceElevationM;

  // Sun unit vector in local ENU coordinates (+x east, +y north, +z up)
  const lsRad = (sample.lsDeg * Math.PI) / 180;
  const declRad = Math.asin(Math.sin(MARS_OBLIQUITY_RAD) * Math.sin(lsRad));
  const latRad = (graph.meta.center.lat * Math.PI) / 180;
  const hourOfSol = ((sample.lmstHour % 24) + 24) % 24;
  const hourAngle = ((hourOfSol - 12.0) * Math.PI) / 12;

  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const sinDecl = Math.sin(declRad);
  const cosDecl = Math.cos(declRad);
  const cosH = Math.cos(hourAngle);
  const sinH = Math.sin(hourAngle);

  const sunX = -cosDecl * sinH;
  const sunY = cosLat * sinDecl - sinLat * cosDecl * cosH;
  const sunZ = sinLat * sinDecl + cosLat * cosDecl * cosH;

  const hasSolar = sample.isDaylight && sample.solarIrradianceWm2 > 0 && sunZ > 0.02;
  const cosFlat = sunZ;
  const invCosFlatDenom = 1 / Math.max(0.2, cosFlat);
  const directFrac = Math.exp(-0.55 * sample.dustOpacityTau);
  const irradScale = Math.min(1.15, sample.solarIrradianceWm2 / 350);
  const solarAmp = hasSolar ? 5.0 * directFrac * irradScale : 0;

  // Mild nocturnal cold-air pooling in topographic depressions under clear skies
  const nightStrength = sample.isDaylight
    ? Math.max(0, 1 - sample.solarIrradianceWm2 / 120) * 0.35
    : 1.0;
  const clearSkyFactor = Math.exp(-0.3 * sample.dustOpacityTau);
  const nightMaxCooling = 2.5 * nightStrength * clearSkyFactor;
  const nightPoolSlope = 0.02 * nightStrength * clearSkyFactor;

  let validCount = 0;
  let sumTempK = 0;
  let minTempK = Number.POSITIVE_INFINITY;
  let maxTempK = Number.NEGATIVE_INFINITY;
  let sumPressurePa = 0;
  let minPressure = Number.POSITIVE_INFINITY;
  let maxPressure = Number.NEGATIVE_INFINITY;

  for (let u = 0; u < totalCells; u += 1) {
    if (!valid[u]) continue;

    const p = pScale * (expHeightFactor[u] ?? 1);
    pressurePa[u] = p;

    let t = baseTempAtZero + MARS_LAPSE_RATE_K_PER_M * (elev[u] ?? 0);
    if (hasSolar) {
      const cosInc = (normalX[u] ?? 0) * sunX + (normalY[u] ?? 0) * sunY + (normalZ[u] ?? 1) * sunZ;
      const cosPos = cosInc > 0 ? cosInc : 0;
      let delta = (cosPos - cosFlat) * invCosFlatDenom;
      if (delta > 1.2) delta = 1.2;
      else if (delta < -1.0) delta = -1.0;
      t += solarAmp * delta;
    }
    if (nightMaxCooling > 0) {
      const depth = basinDepthM[u] ?? 0;
      if (depth > 0) {
        const pool = depth * nightPoolSlope;
        t -= pool < nightMaxCooling ? pool : nightMaxCooling;
      }
    }
    tempK[u] = t;

    validCount += 1;
    sumTempK += t;
    if (t < minTempK) minTempK = t;
    if (t > maxTempK) maxTempK = t;
    sumPressurePa += p;
    if (p < minPressure) minPressure = p;
    if (p > maxPressure) maxPressure = p;
  }

  const field: SiteWeatherField = {
    siteId: snapshot.site.siteId,
    sol: sample.sol,
    lmstHour: sample.lmstHour,
    lmstLabel: sample.lmstLabel,
    scenario: snapshot.scenario,
    isSimulated: snapshot.isSimulated,
    tempK,
    pressurePa,
    minTempC: validCount > 0 ? roundTo(kelvinToCelsius(minTempK), 2) : 0,
    maxTempC: validCount > 0 ? roundTo(kelvinToCelsius(maxTempK), 2) : 0,
    meanTempC: validCount > 0 ? roundTo(kelvinToCelsius(sumTempK / validCount), 2) : 0,
    minPressurePa: validCount > 0 ? roundTo(minPressure, 2) : 0,
    maxPressurePa: validCount > 0 ? roundTo(maxPressure, 2) : 0,
    meanPressurePa: validCount > 0 ? roundTo(sumPressurePa / validCount, 2) : 0,
  };

  fieldKeyByField.set(field, cacheKey);
  fieldLruCache.set(cacheKey, { cacheKey, field });
  return field;
}

export function toSiteEnvironmentSummary(field: SiteWeatherField): SiteEnvironmentSummary {
  return {
    siteId: field.siteId,
    sol: field.sol,
    lmstHour: field.lmstHour,
    lmstLabel: field.lmstLabel,
    scenario: field.scenario,
    isSimulated: field.isSimulated,
    minTempC: field.minTempC,
    maxTempC: field.maxTempC,
    meanTempC: field.meanTempC,
    minPressurePa: field.minPressurePa,
    maxPressurePa: field.maxPressurePa,
    meanPressurePa: field.meanPressurePa,
  };
}

function packRgba(r: number, g: number, b: number, a: number): number {
  return (((a & 0xff) << 24) | ((b & 0xff) << 16) | ((g & 0xff) << 8) | (r & 0xff)) >>> 0;
}

function lerpChannel(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function writeLutGradient(
  lut32: Uint32Array,
  lutBytes: Uint8Array,
  startBin: number,
  endBin: number,
  c0: readonly [number, number, number, number],
  c1: readonly [number, number, number, number],
): void {
  const span = Math.max(1, endBin - startBin);
  for (let i = startBin; i <= endBin; i += 1) {
    const t = (i - startBin) / span;
    const r = lerpChannel(c0[0], c1[0], t);
    const g = lerpChannel(c0[1], c1[1], t);
    const b = lerpChannel(c0[2], c1[2], t);
    const a = lerpChannel(c0[3], c1[3], t);
    lut32[i] = packRgba(r, g, b, a);
    const base = i * 4;
    lutBytes[base] = r;
    lutBytes[base + 1] = g;
    lutBytes[base + 2] = b;
    lutBytes[base + 3] = a;
  }
}

function encodeMaskFromBins(
  graph: TerrainGraph,
  values: Float32Array,
  lut32: Uint32Array,
  lutBytes: Uint8Array,
  binOf: (val: number) => number,
): Uint8Array {
  const totalCells = graph.totalCells;
  const valid = graph.getValidMask();
  const rgba = new Uint8Array(totalCells * 4);

  if (IS_LITTLE_ENDIAN) {
    const rgba32 = new Uint32Array(rgba.buffer);
    for (let u = 0; u < totalCells; u += 1) {
      if (!valid[u]) continue;
      const bin = binOf(values[u] ?? 0);
      rgba32[u] = lut32[bin] ?? 0;
    }
  } else {
    for (let u = 0; u < totalCells; u += 1) {
      if (!valid[u]) continue;
      const bin = binOf(values[u] ?? 0);
      const src = bin * 4;
      const dst = u * 4;
      rgba[dst] = lutBytes[src] ?? 0;
      rgba[dst + 1] = lutBytes[src + 1] ?? 0;
      rgba[dst + 2] = lutBytes[src + 2] ?? 0;
      rgba[dst + 3] = lutBytes[src + 3] ?? 0;
    }
  }

  return encodeRgbaPng(graph.cols, graph.rows, rgba, 1);
}

/**
 * Render an RGBA PNG highlighting atmospheric pressure limits:
 * - Blocked (< minPressurePa): magenta/violet (#d946ef -> #a21caf, alpha ~175)
 * - Caution (< minPressurePa * 1.04): warm yellow (#eab308, alpha ~115)
 * - Safe (>= minPressurePa * 1.04): teal/cyan gradient (#38bdf8 .. #0d9488, alpha ~45..95)
 */
export function renderPressureMaskPng(
  graph: TerrainGraph,
  field: SiteWeatherField,
  minPressurePa: number,
): Uint8Array {
  const fieldKey = fieldKeyByField.get(field) ?? `${field.siteId}|${field.sol}|${field.lmstHour}`;
  const pngKey = `${fieldKey}|p|${minPressurePa.toFixed(2)}`;
  const cached = pngLruCache.get(pngKey);
  if (cached) return cached;

  const lut32 = new Uint32Array(256);
  const lutBytes = new Uint8Array(256 * 4);
  // 0..85: blocked (#d946ef -> #a21caf), 86..127: caution (#eab308), 128..255: safe (#38bdf8 -> #0d9488)
  writeLutGradient(lut32, lutBytes, 0, 85, [217, 70, 239, 170], [162, 28, 175, 185]);
  writeLutGradient(lut32, lutBytes, 86, 127, [234, 179, 8, 115], [234, 179, 8, 115]);
  writeLutGradient(lut32, lutBytes, 128, 255, [56, 189, 248, 95], [13, 148, 136, 45]);

  const cautionTop = minPressurePa * 1.04;
  const blockedSpan = Math.max(10, minPressurePa - field.minPressurePa);
  const cautionSpan = Math.max(1e-6, cautionTop - minPressurePa);
  const safeSpan = Math.max(10, field.maxPressurePa - cautionTop);

  const png = encodeMaskFromBins(graph, field.pressurePa, lut32, lutBytes, (p) => {
    if (p < minPressurePa) {
      const t = Math.max(0, Math.min(1, (minPressurePa - p) / blockedSpan));
      return Math.min(85, Math.round(t * 85));
    }
    if (p < cautionTop) {
      const t = (p - minPressurePa) / cautionSpan;
      return 86 + Math.min(41, Math.floor(t * 42));
    }
    const t = Math.max(0, Math.min(1, (p - cautionTop) / safeSpan));
    return 128 + Math.min(127, Math.round(t * 127));
  });

  pngLruCache.set(pngKey, png);
  return png;
}

/**
 * Render an RGBA PNG highlighting modeled surface air temperature:
 * - Blocked cold (< minAirTempC): icy blue/sapphire (#0284c7 -> #2563eb, alpha ~175)
 * - Near-limit (minAirTempC .. minAirTempC + 5 C): cyan-teal (#38bdf8, alpha ~95)
 * - Warm safe (>= minAirTempC + 5 C): amber-orange glow (#f59e0b -> #fb923c, alpha ~60..130)
 */
export function renderTemperatureMaskPng(
  graph: TerrainGraph,
  field: SiteWeatherField,
  minAirTempC: number,
): Uint8Array {
  const fieldKey = fieldKeyByField.get(field) ?? `${field.siteId}|${field.sol}|${field.lmstHour}`;
  const pngKey = `${fieldKey}|t|${minAirTempC.toFixed(2)}`;
  const cached = pngLruCache.get(pngKey);
  if (cached) return cached;

  const lut32 = new Uint32Array(256);
  const lutBytes = new Uint8Array(256 * 4);
  // 0..85: blocked cold (#0284c7 -> #2563eb), 86..127: near limit (#38bdf8), 128..255: warm safe (#f59e0b -> #fb923c)
  writeLutGradient(lut32, lutBytes, 0, 85, [2, 132, 199, 170], [37, 99, 235, 185]);
  writeLutGradient(lut32, lutBytes, 86, 127, [56, 189, 248, 95], [56, 189, 248, 95]);
  writeLutGradient(lut32, lutBytes, 128, 255, [245, 158, 11, 60], [251, 146, 60, 130]);

  const minTempK = celsiusToKelvin(minAirTempC);
  const cautionTopK = minTempK + 5;
  const fieldMinK = celsiusToKelvin(field.minTempC);
  const fieldMaxK = celsiusToKelvin(field.maxTempC);
  const blockedSpan = Math.max(5, minTempK - fieldMinK);
  const safeSpan = Math.max(5, fieldMaxK - cautionTopK);

  const png = encodeMaskFromBins(graph, field.tempK, lut32, lutBytes, (tK) => {
    if (tK < minTempK) {
      const t = Math.max(0, Math.min(1, (minTempK - tK) / blockedSpan));
      return Math.min(85, Math.round(t * 85));
    }
    if (tK < cautionTopK) {
      const t = (tK - minTempK) / 5;
      return 86 + Math.min(41, Math.floor(t * 42));
    }
    const t = Math.max(0, Math.min(1, (tK - cautionTopK) / safeSpan));
    return 128 + Math.min(127, Math.round(t * 127));
  });

  pngLruCache.set(pngKey, png);
  return png;
}
