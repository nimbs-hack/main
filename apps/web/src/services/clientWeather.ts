import {
  MEDA_RSS_URL,
  type MarsWeatherSnapshot,
  type PersistedSiteWeatherRecord,
  REMS_RSS_URL,
  type SiteMetadata,
  type SiteWeatherFile,
  type WeatherScenario,
  ensureNextSolForecast,
  generateMartianWeather,
  parseMedaRssLatest,
  parseRemsRssLatest,
  persistedWeatherToObservedInput,
  resolveSiteWeatherProfile,
} from "@nimbs/shared";
import { readCachedWeather, writeCachedWeather } from "./browserCache";

const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_LIVE_TIMEOUT_MS = 4000;

export interface ClientWeatherOptions {
  fallbackUrl?: string;
  cacheTtlMs?: number;
  liveTimeoutMs?: number;
  fetcher?: typeof fetch;
  enableLiveFetch?: boolean;
}

interface MemWeatherEntry {
  cachedAtMs: number;
  snapshot: MarsWeatherSnapshot;
}

/**
 * Browser-side weather service using direct CORS NASA RSS feeds, static fallback JSON,
 * IndexedDB caching with TTL, and deterministic physics synthesis when offline.
 */
export class ClientWeatherService {
  private readonly fallbackUrl: string;
  private readonly cacheTtlMs: number;
  private readonly liveTimeoutMs: number;
  private readonly fetcher: typeof fetch;
  private readonly enableLiveFetch: boolean;
  private readonly memCache = new Map<string, MemWeatherEntry>();
  private fallbackFilePromise: Promise<SiteWeatherFile | null> | null = null;

  constructor(options: ClientWeatherOptions = {}) {
    this.fallbackUrl = options.fallbackUrl ?? "/data/site-weather.json";
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.liveTimeoutMs = options.liveTimeoutMs ?? DEFAULT_LIVE_TIMEOUT_MS;
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.enableLiveFetch = options.enableLiveFetch ?? true;
  }

  private async readBundledSiteWeather(
    siteId: "jezero" | "gale",
  ): Promise<PersistedSiteWeatherRecord | null> {
    if (!this.fallbackFilePromise) {
      this.fallbackFilePromise = (async () => {
        try {
          const res = await this.fetcher(this.fallbackUrl, { cache: "no-cache" });
          if (!res.ok) return null;
          return (await res.json()) as SiteWeatherFile;
        } catch {
          return null;
        }
      })();
    }

    const file = await this.fallbackFilePromise;
    if (!file) {
      this.fallbackFilePromise = null;
      return null;
    }
    return file.sites?.[siteId] ?? null;
  }

  private async fetchLiveRecord(
    siteId: "jezero" | "gale",
  ): Promise<PersistedSiteWeatherRecord | null> {
    if (!this.enableLiveFetch) return null;
    const url = siteId === "gale" ? REMS_RSS_URL : MEDA_RSS_URL;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.liveTimeoutMs);
      try {
        const res = await this.fetcher(url, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (!res.ok) return null;
        const json = (await res.json()) as unknown;
        return siteId === "gale" ? parseRemsRssLatest(json) : parseMedaRssLatest(json);
      } finally {
        clearTimeout(timeoutId);
      }
    } catch {
      return null;
    }
  }

  async getWeather(params?: {
    site?: string | null;
    scenario?: WeatherScenario;
    sol?: number;
    refresh?: boolean;
    siteMeta?: SiteMetadata | null;
  }): Promise<MarsWeatherSnapshot> {
    const profile = resolveSiteWeatherProfile(params?.site, params?.siteMeta);
    const scenario: WeatherScenario = params?.scenario ?? "auto";

    // Explicit simulation scenarios bypass cached real observations
    if (scenario !== "auto") {
      return generateMartianWeather({
        site: profile.siteId,
        siteMeta: params?.siteMeta,
        sol: params?.sol,
        scenario,
      });
    }

    const nowMs = Date.now();
    const cacheKey = `${profile.siteId}:${params?.siteMeta?.id ?? "default"}`;

    if (params?.sol === undefined && !params?.refresh) {
      const mem = this.memCache.get(cacheKey);
      if (mem && nowMs - mem.cachedAtMs < this.cacheTtlMs) {
        const ready = ensureNextSolForecast(mem.snapshot);
        if (ready !== mem.snapshot) {
          this.memCache.set(cacheKey, { cachedAtMs: mem.cachedAtMs, snapshot: ready });
        }
        return ready;
      }
    }

    const idbCached = params?.sol === undefined ? await readCachedWeather(profile.siteId) : null;

    if (idbCached && params?.sol === undefined && !params?.refresh) {
      if (nowMs - idbCached.cachedAtMs < this.cacheTtlMs) {
        const aligned =
          params?.siteMeta && idbCached.snapshot.site.name !== params.siteMeta.name
            ? { ...idbCached.snapshot, site: profile }
            : idbCached.snapshot;
        const upgraded = ensureNextSolForecast(aligned);
        this.memCache.set(cacheKey, { cachedAtMs: idbCached.cachedAtMs, snapshot: upgraded });
        if (upgraded !== aligned) {
          await writeCachedWeather({
            key: profile.siteId,
            snapshot: upgraded,
            cachedAtMs: idbCached.cachedAtMs,
          });
        }
        return upgraded;
      }
    }

    const persisted = await this.readBundledSiteWeather(profile.siteId);
    const live =
      params?.sol === undefined || (persisted && persisted.sol === params.sol)
        ? await this.fetchLiveRecord(profile.siteId)
        : null;

    let chosenReal: PersistedSiteWeatherRecord | null = null;
    if (params?.sol !== undefined) {
      if (live && live.sol === params.sol) chosenReal = live;
      else if (persisted && persisted.sol === params.sol) chosenReal = persisted;
    } else if (live && persisted) {
      chosenReal = persisted.sol >= live.sol ? persisted : live;
    } else {
      chosenReal = live ?? persisted;
    }

    // If neither live RSS nor bundled file succeeded offline, reuse stale IndexedDB snapshot
    if (!chosenReal && idbCached) {
      const aligned =
        params?.siteMeta && idbCached.snapshot.site.name !== params.siteMeta.name
          ? { ...idbCached.snapshot, site: profile }
          : idbCached.snapshot;
      const upgraded = ensureNextSolForecast(aligned);
      this.memCache.set(cacheKey, { cachedAtMs: nowMs, snapshot: upgraded });
      return upgraded;
    }

    const snapshot = chosenReal
      ? generateMartianWeather({
          site: profile.siteId,
          siteMeta: params?.siteMeta,
          sol: chosenReal.sol,
          scenario: "auto",
          observedOverrides: persistedWeatherToObservedInput(chosenReal),
        })
      : generateMartianWeather({
          site: profile.siteId,
          siteMeta: params?.siteMeta,
          sol: params?.sol,
          scenario: "auto",
        });

    if (params?.sol === undefined) {
      this.memCache.set(cacheKey, { cachedAtMs: nowMs, snapshot });
      await writeCachedWeather({
        key: profile.siteId,
        snapshot,
        cachedAtMs: nowMs,
      });
    }

    return snapshot;
  }
}

export const defaultClientWeatherService = new ClientWeatherService();
