import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { SiteMetadata } from "@nimbs/shared";
import {
  type MarsWeatherSnapshot,
  type ObservedWeatherInput,
  type WeatherScenario,
  celsiusToKelvin,
  ensureNextSolForecast,
  generateMartianWeather,
  resolveSiteWeatherProfile,
} from "./generator";

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

interface CacheEntry {
  cachedAtMs: number;
  snapshot: MarsWeatherSnapshot;
}

export interface GetWeatherParams {
  site?: string | null;
  scenario?: WeatherScenario;
  sol?: number;
  refresh?: boolean;
  siteMeta?: SiteMetadata | null;
}

export interface WeatherServiceOptions {
  cacheDir?: string;
  siteWeatherPath?: string;
  cacheTtlMs?: number;
  liveTimeoutMs?: number;
  fetcher?: typeof fetch;
  enableLiveFetch?: boolean;
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

export function parseMedaRssLatest(payload: unknown): PersistedSiteWeatherRecord | null {
  if (!payload || typeof payload !== "object") return null;
  const sols = (payload as { sols?: unknown }).sols;
  if (!Array.isArray(sols) || sols.length === 0) return null;

  // Walk newest-to-oldest until a sol with at least temperature or pressure is found
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

function toObservedInput(record: PersistedSiteWeatherRecord): ObservedWeatherInput {
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

const DEFAULT_CACHE_DIR = resolve(import.meta.dir, "../../../../data/cache/weather");
const DEFAULT_SITE_WEATHER_PATH = resolve(import.meta.dir, "../../../../data/site-weather.json");

export class WeatherService {
  private readonly cacheDir: string;
  private readonly siteWeatherPath: string;
  private readonly cacheTtlMs: number;
  private readonly liveTimeoutMs: number;
  private readonly fetcher: typeof fetch;
  private readonly enableLiveFetch: boolean;
  private readonly memCache = new Map<string, CacheEntry>();

  constructor(options: WeatherServiceOptions = {}) {
    this.cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
    this.siteWeatherPath = options.siteWeatherPath ?? DEFAULT_SITE_WEATHER_PATH;
    this.cacheTtlMs = options.cacheTtlMs ?? 15 * 60 * 1000;
    this.liveTimeoutMs = options.liveTimeoutMs ?? 4000;
    this.fetcher = options.fetcher ?? fetch;
    this.enableLiveFetch = options.enableLiveFetch ?? true;
  }

  private async readDiskCache(siteId: string): Promise<CacheEntry | null> {
    const cacheFile = resolve(this.cacheDir, `${siteId}.json`);
    if (!existsSync(cacheFile)) return null;
    try {
      const raw = await readFile(cacheFile, "utf8");
      const parsed = JSON.parse(raw) as CacheEntry;
      if (
        parsed &&
        typeof parsed.cachedAtMs === "number" &&
        parsed.snapshot &&
        parsed.snapshot.site &&
        parsed.snapshot.airTemp &&
        parsed.snapshot.pressure &&
        parsed.snapshot.wind &&
        parsed.snapshot.daylight &&
        Array.isArray(parsed.snapshot.hourly) &&
        parsed.snapshot.hourly.length > 0
      ) {
        return parsed;
      }
    } catch {
      return null;
    }
    return null;
  }

  private async writeDiskCache(siteId: string, entry: CacheEntry): Promise<void> {
    try {
      await mkdir(this.cacheDir, { recursive: true });
      await writeFile(resolve(this.cacheDir, `${siteId}.json`), JSON.stringify(entry), "utf8");
    } catch {
      // Cache write errors should never fail weather serving
    }
  }

  private async readPersistedSiteWeather(
    siteId: "jezero" | "gale",
  ): Promise<PersistedSiteWeatherRecord | null> {
    if (!existsSync(this.siteWeatherPath)) return null;
    try {
      const raw = await readFile(this.siteWeatherPath, "utf8");
      const file = JSON.parse(raw) as SiteWeatherFile;
      return file.sites?.[siteId] ?? null;
    } catch {
      return null;
    }
  }

  private async fetchLiveRecord(
    siteId: "jezero" | "gale",
  ): Promise<PersistedSiteWeatherRecord | null> {
    if (!this.enableLiveFetch) return null;
    const url = siteId === "gale" ? REMS_RSS_URL : MEDA_RSS_URL;
    try {
      const res = await this.fetcher(url, {
        signal: AbortSignal.timeout(this.liveTimeoutMs),
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return null;
      const json = (await res.json()) as unknown;
      return siteId === "gale" ? parseRemsRssLatest(json) : parseMedaRssLatest(json);
    } catch {
      return null;
    }
  }

  async getWeather(params: GetWeatherParams = {}): Promise<MarsWeatherSnapshot> {
    const profile = resolveSiteWeatherProfile(params.site, params.siteMeta);
    const scenario: WeatherScenario = params.scenario ?? "auto";

    // Explicit simulation scenarios bypass real-data blending and flag simulated provenance
    if (scenario !== "auto") {
      return generateMartianWeather({
        site: profile.siteId,
        siteMeta: params.siteMeta,
        sol: params.sol,
        scenario,
      });
    }

    const nowMs = Date.now();
    const cacheKey = `${profile.siteId}:${params.siteMeta?.id ?? "default"}`;

    if (params.sol === undefined && !params.refresh) {
      const mem = this.memCache.get(cacheKey);
      if (mem && nowMs - mem.cachedAtMs < this.cacheTtlMs) {
        const ready = ensureNextSolForecast(mem.snapshot);
        if (ready !== mem.snapshot) {
          this.memCache.set(cacheKey, { cachedAtMs: mem.cachedAtMs, snapshot: ready });
        }
        return ready;
      }
      const disk = await this.readDiskCache(profile.siteId);
      if (disk && nowMs - disk.cachedAtMs < this.cacheTtlMs) {
        // Re-align site profile if active terrain metadata differs
        const aligned =
          params.siteMeta && disk.snapshot.site.name !== params.siteMeta.name
            ? { ...disk.snapshot, site: profile }
            : disk.snapshot;
        // Lazily backfill nextSol for cached snapshots written before 48-hour forecast support
        const upgraded = ensureNextSolForecast(aligned);
        const entry = { cachedAtMs: disk.cachedAtMs, snapshot: upgraded };
        this.memCache.set(cacheKey, entry);
        if (upgraded !== aligned) {
          await this.writeDiskCache(profile.siteId, entry);
        }
        return upgraded;
      }
    }

    const persisted = await this.readPersistedSiteWeather(profile.siteId);
    const live =
      params.sol === undefined || (persisted && persisted.sol === params.sol)
        ? await this.fetchLiveRecord(profile.siteId)
        : null;

    // Choose whichever real telemetry record matches requested sol or has newer sol
    let chosenReal: PersistedSiteWeatherRecord | null = null;
    if (params.sol !== undefined) {
      if (live && live.sol === params.sol) chosenReal = live;
      else if (persisted && persisted.sol === params.sol) chosenReal = persisted;
    } else if (live && persisted) {
      chosenReal = persisted.sol >= live.sol ? persisted : live;
    } else {
      chosenReal = live ?? persisted;
    }

    const snapshot = chosenReal
      ? generateMartianWeather({
          site: profile.siteId,
          siteMeta: params.siteMeta,
          sol: chosenReal.sol,
          scenario: "auto",
          observedOverrides: toObservedInput(chosenReal),
        })
      : generateMartianWeather({
          site: profile.siteId,
          siteMeta: params.siteMeta,
          sol: params.sol,
          scenario: "auto",
        });

    if (params.sol === undefined) {
      const entry: CacheEntry = { cachedAtMs: nowMs, snapshot };
      this.memCache.set(cacheKey, entry);
      await this.writeDiskCache(profile.siteId, entry);
    }

    return snapshot;
  }
}

export const defaultWeatherService = new WeatherService();
