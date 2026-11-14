import { type ObservedWeatherInput, celsiusToKelvin } from "./generator";

export const MEDA_RSS_URL =
  "https://mars.nasa.gov/rss/api/?feed=weather&category=mars2020&feedtype=json";
export const REMS_RSS_URL =
  "https://mars.nasa.gov/rss/api/?feed=weather&category=msl&feedtype=json";
export const INSIGHT_RSS_URL =
  "https://mars.nasa.gov/rss/api/?feed=weather&category=insight&feedtype=json";

export interface PersistedSiteWeatherRecord {
  siteId: "jezero" | "gale";
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
  realChannels: string[];
  fetchedAt: string;
}

export interface SiteWeatherFile {
  generatedAt: string;
  sites: {
    jezero?: PersistedSiteWeatherRecord;
    gale?: PersistedSiteWeatherRecord;
  };
  probes?: Array<{
    id: string;
    url: string;
    ok: boolean;
    status: number;
    elapsedMs: number;
    note: string;
  }>;
}

interface MedaRssSol {
  terrestrial_date?: string;
  sol?: string | number;
  ls?: string | number;
  min_temp?: string | number;
  max_temp?: string | number;
  pressure?: string | number;
  sunrise?: string;
  sunset?: string;
}

interface MslRssSol {
  terrestrial_date?: string;
  sol?: string | number;
  ls?: string | number;
  min_temp?: string | number;
  max_temp?: string | number;
  pressure?: string | number;
  wind_speed?: string | number;
  wind_direction?: string;
  sunrise?: string;
  sunset?: string;
}

function parseFiniteField(val: unknown): number | undefined {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed || trimmed === "--" || trimmed.toUpperCase() === "NA") return undefined;
    const num = Number(trimmed);
    if (Number.isFinite(num)) return num;
  }
  return undefined;
}

/** Parse newest valid sol from NASA Mars 2020 Perseverance MEDA RSS JSON. */
export function parseMedaRssLatest(payload: unknown): PersistedSiteWeatherRecord | null {
  if (!payload || typeof payload !== "object") return null;
  const sols = (payload as { sols?: unknown }).sols;
  if (!Array.isArray(sols) || sols.length === 0) return null;

  const sorted = [...(sols as MedaRssSol[])].sort((a, b) => {
    const sa = parseFiniteField(a.sol) ?? -1;
    const sb = parseFiniteField(b.sol) ?? -1;
    return sb - sa;
  });

  for (const entry of sorted) {
    const sol = parseFiniteField(entry.sol);
    if (sol === undefined) continue;
    const minC = parseFiniteField(entry.min_temp);
    const maxC = parseFiniteField(entry.max_temp);
    const pressurePa = parseFiniteField(entry.pressure);
    if (minC === undefined && maxC === undefined && pressurePa === undefined) continue;

    const realChannels: string[] = [];
    if (minC !== undefined || maxC !== undefined) realChannels.push("airTemp");
    if (pressurePa !== undefined) realChannels.push("pressure");
    const lsDeg = parseFiniteField(entry.ls);
    if (lsDeg !== undefined) realChannels.push("ls");
    if (entry.sunrise && entry.sunset) realChannels.push("daylight");

    return {
      siteId: "jezero",
      sol: Math.round(sol),
      lsDeg,
      terrestrialDate: entry.terrestrial_date,
      tempMinK: minC !== undefined ? Math.round(celsiusToKelvin(minC) * 100) / 100 : undefined,
      tempMaxK: maxC !== undefined ? Math.round(celsiusToKelvin(maxC) * 100) / 100 : undefined,
      pressureAvgPa: pressurePa,
      sunriseLmst: entry.sunrise,
      sunsetLmst: entry.sunset,
      sourceLabel: `NASA Mars 2020 MEDA RSS (Sol ${Math.round(sol)})`,
      sourceUrl: MEDA_RSS_URL,
      realChannels,
      fetchedAt: new Date().toISOString(),
    };
  }

  return null;
}

/** Parse newest valid sol from NASA MSL Curiosity REMS RSS JSON. */
export function parseRemsRssLatest(payload: unknown): PersistedSiteWeatherRecord | null {
  if (!payload || typeof payload !== "object") return null;
  const soles =
    (payload as { soles?: unknown; sols?: unknown }).soles ?? (payload as { sols?: unknown }).sols;
  if (!Array.isArray(soles) || soles.length === 0) return null;

  for (const entry of soles as MslRssSol[]) {
    const sol = parseFiniteField(entry.sol);
    if (sol === undefined) continue;
    const minC = parseFiniteField(entry.min_temp);
    const maxC = parseFiniteField(entry.max_temp);
    const pressurePa = parseFiniteField(entry.pressure);
    if (minC === undefined && maxC === undefined && pressurePa === undefined) continue;

    const realChannels: string[] = [];
    if (minC !== undefined || maxC !== undefined) realChannels.push("airTemp");
    if (pressurePa !== undefined) realChannels.push("pressure");
    const lsDeg = parseFiniteField(entry.ls);
    if (lsDeg !== undefined) realChannels.push("ls");
    if (entry.sunrise && entry.sunset) realChannels.push("daylight");

    return {
      siteId: "gale",
      sol: Math.round(sol),
      lsDeg,
      terrestrialDate: entry.terrestrial_date,
      tempMinK: minC !== undefined ? Math.round(celsiusToKelvin(minC) * 100) / 100 : undefined,
      tempMaxK: maxC !== undefined ? Math.round(celsiusToKelvin(maxC) * 100) / 100 : undefined,
      pressureAvgPa: pressurePa,
      sunriseLmst: entry.sunrise,
      sunsetLmst: entry.sunset,
      sourceLabel: `NASA MSL REMS RSS (Sol ${Math.round(sol)})`,
      sourceUrl: REMS_RSS_URL,
      realChannels,
      fetchedAt: new Date().toISOString(),
    };
  }

  return null;
}

/** Convert persisted weather record into generator observed input. */
export function persistedWeatherToObservedInput(
  record: PersistedSiteWeatherRecord,
): ObservedWeatherInput {
  return {
    sol: record.sol,
    lsDeg: record.lsDeg,
    terrestrialDate: record.terrestrialDate,
    tempMinK: record.tempMinK,
    tempAvgK: record.tempAvgK,
    tempMaxK: record.tempMaxK,
    pressureMinPa: record.pressureMinPa,
    pressureAvgPa: record.pressureAvgPa,
    pressureMaxPa: record.pressureMaxPa,
    windMinMps: record.windMinMps,
    windAvgMps: record.windAvgMps,
    windMaxMps: record.windMaxMps,
    windCompassDeg: record.windCompassDeg,
    sunriseLmst: record.sunriseLmst,
    sunsetLmst: record.sunsetLmst,
    sourceLabel: record.sourceLabel,
    sourceUrl: record.sourceUrl,
    realChannels: record.realChannels,
  };
}
