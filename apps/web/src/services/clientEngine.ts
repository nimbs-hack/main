import {
  DEFAULT_EVA_WEATHER_LIMITS,
  type ElevationResponse,
  type MarsCoord,
  type MarsWeatherSnapshot,
  type RoutePlanRequest,
  type RoutePlanResponse,
  SOIL_TYPE_CATALOG,
  type SiteEnvironmentSummary,
  type SiteMetadata,
  type StaticSiteManifest,
  TerrainGraph,
  type WeatherScenario,
  computeSiteWeatherField,
  decodeSoilBinary,
  decodeTerrainBinary,
  renderPressureMaskRgba,
  renderTemperatureMaskRgba,
  resolveSoilSpeedFactors,
  toSiteEnvironmentSummary,
} from "@nimbs/shared";
import type { WorkerRequest, WorkerResponse } from "../workers/terrainWorker";
import {
  readCachedDataset,
  readCachedOverlay,
  readCachedRoute,
  writeCachedDataset,
  writeCachedOverlay,
  writeCachedRoute,
} from "./browserCache";
import { defaultClientWeatherService } from "./clientWeather";
import { cacheOverlayBlob, encodeRgbaBufferToPngBlob, runCoalescedOverlayRender } from "./rgbaBlob";

const SITE_MANIFEST_URL = "/data/site-meta.json";

function abortError(): DOMException {
  return new DOMException("Operation aborted", "AbortError");
}

type WorkerPayload =
  | {
      type: "init";
      meta: SiteMetadata;
      terrainBuffer: ArrayBuffer;
      soilBuffer?: ArrayBuffer;
    }
  | { type: "elevation"; coord: MarsCoord }
  | { type: "planRoutes"; payload: RoutePlanRequest; snapshot?: MarsWeatherSnapshot }
  | { type: "environmentSummary"; snapshot: MarsWeatherSnapshot; lmstHour: number }
  | { type: "renderSlopeMask"; maxSlopeDeg: number }
  | { type: "renderSoilMask" }
  | {
      type: "renderPressureMask";
      snapshot: MarsWeatherSnapshot;
      lmstHour: number;
      minPressurePa: number;
    }
  | {
      type: "renderTemperatureMask";
      snapshot: MarsWeatherSnapshot;
      lmstHour: number;
      minAirTempC: number;
    };

type WorkerSuccessResponse = Extract<WorkerResponse, { ok: true }>;

class ClientTerrainEngine {
  private initPromise: Promise<SiteMetadata> | null = null;
  private worker: Worker | null = null;
  private fallbackGraph: TerrainGraph | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (res: WorkerSuccessResponse) => void;
      reject: (err: Error) => void;
    }
  >();

  private spawnWorker(): Worker | null {
    if (typeof Worker === "undefined") return null;
    if (this.worker) return this.worker;

    const worker = new Worker(new URL("../workers/terrainWorker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.ok) {
        entry.resolve(msg);
      } else {
        entry.reject(new Error(msg.error));
      }
    };
    worker.onerror = (event: ErrorEvent) => {
      const err = new Error(event.message || "Terrain worker failed");
      for (const [id, entry] of this.pending) {
        this.pending.delete(id);
        entry.reject(err);
      }
      this.worker = null;
    };
    this.worker = worker;
    return worker;
  }

  private callWorker(
    payload: WorkerPayload,
    transfer: Transferable[] = [],
    signal?: AbortSignal,
  ): Promise<WorkerSuccessResponse> {
    if (signal?.aborted) {
      return Promise.reject(abortError());
    }

    const worker = this.spawnWorker();
    if (!worker) {
      return this.runInThreadFallback(payload);
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const request = { ...payload, id } as WorkerRequest;

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        reject(abortError());
      };
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.pending.set(id, {
        resolve: (res) => {
          if (signal) signal.removeEventListener("abort", onAbort);
          resolve(res);
        },
        reject: (err) => {
          if (signal) signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      });
      worker.postMessage(request, transfer);
    });
  }

  private async runInThreadFallback(payload: WorkerPayload): Promise<WorkerSuccessResponse> {
    if (payload.type === "init") {
      const expectedCells = payload.meta.rows * payload.meta.cols;
      const elevationsM = decodeTerrainBinary(payload.terrainBuffer, expectedCells);
      const soilTypes = payload.soilBuffer
        ? decodeSoilBinary(payload.soilBuffer, expectedCells)
        : undefined;
      this.fallbackGraph = new TerrainGraph({ meta: payload.meta, elevationsM, soilTypes });
      return { id: 0, ok: true, type: "init", meta: this.fallbackGraph.meta };
    }
    const graph = this.fallbackGraph;
    if (!graph) {
      throw new Error("Terrain graph is not initialized");
    }
    switch (payload.type) {
      case "elevation": {
        const insideSite = graph.isInsideBounds(payload.coord);
        const soilType = insideSite ? graph.soilAt(payload.coord) : null;
        return {
          id: 0,
          ok: true,
          type: "elevation",
          data: {
            lat: payload.coord.lat,
            lon: payload.coord.lon,
            insideSite,
            elevationM: graph.elevationAt(payload.coord),
            soilType,
            soilLabel: soilType ? SOIL_TYPE_CATALOG[soilType].label : null,
            soilSpeedFactor: soilType ? SOIL_TYPE_CATALOG[soilType].humanSpeedFactor : null,
          },
        };
      }
      case "planRoutes": {
        const wc = payload.payload.weatherConstraints;
        const filter =
          wc?.enabled && payload.snapshot
            ? (() => {
                const field = computeSiteWeatherField(graph, payload.snapshot, wc.lmstHour ?? 12);
                return {
                  lmstHour: field.lmstHour,
                  lmstLabel: field.lmstLabel,
                  minAirTempC: wc.minAirTempC ?? DEFAULT_EVA_WEATHER_LIMITS.minAirTempC,
                  minPressurePa: wc.minPressurePa ?? DEFAULT_EVA_WEATHER_LIMITS.minPressurePa,
                  thermalWeight: wc.thermalWeight ?? 0.35,
                  cellTempK: field.tempK,
                  cellPressurePa: field.pressurePa,
                };
              })()
            : undefined;
        const waypoints =
          payload.payload.waypoints && payload.payload.waypoints.length > 0
            ? payload.payload.waypoints
            : payload.payload.waypointA && payload.payload.waypointB
              ? [payload.payload.waypointA, payload.payload.waypointB]
              : [];
        return {
          id: 0,
          ok: true,
          type: "planRoutes",
          data: graph.planWaypointsRoutes(
            waypoints,
            payload.payload.maxSlopeDeg,
            filter,
            payload.payload.soilSpeedFactors,
          ),
        };
      }
      case "environmentSummary": {
        const field = computeSiteWeatherField(graph, payload.snapshot, payload.lmstHour);
        return {
          id: 0,
          ok: true,
          type: "environmentSummary",
          data: toSiteEnvironmentSummary(field),
        };
      }
      case "renderSlopeMask": {
        const rgba = graph.renderSlopeMaskRgba(payload.maxSlopeDeg);
        return {
          id: 0,
          ok: true,
          type: "renderMask",
          cols: graph.cols,
          rows: graph.rows,
          rgbaBuffer: rgba.buffer,
        };
      }
      case "renderSoilMask": {
        const rgba = graph.renderSoilMaskRgba();
        return {
          id: 0,
          ok: true,
          type: "renderMask",
          cols: graph.cols,
          rows: graph.rows,
          rgbaBuffer: rgba.buffer,
        };
      }
      case "renderPressureMask": {
        const field = computeSiteWeatherField(graph, payload.snapshot, payload.lmstHour);
        const rgba = renderPressureMaskRgba(graph, field, payload.minPressurePa);
        return {
          id: 0,
          ok: true,
          type: "renderMask",
          cols: graph.cols,
          rows: graph.rows,
          rgbaBuffer: rgba.buffer,
        };
      }
      case "renderTemperatureMask": {
        const field = computeSiteWeatherField(graph, payload.snapshot, payload.lmstHour);
        const rgba = renderTemperatureMaskRgba(graph, field, payload.minAirTempC);
        return {
          id: 0,
          ok: true,
          type: "renderMask",
          cols: graph.cols,
          rows: graph.rows,
          rgbaBuffer: rgba.buffer,
        };
      }
    }
  }

  private async fetchManifestOnline(): Promise<StaticSiteManifest | null> {
    try {
      const res = await fetch(SITE_MANIFEST_URL, { cache: "no-cache" });
      if (!res.ok) return null;
      return (await res.json()) as StaticSiteManifest;
    } catch {
      return null;
    }
  }

  async ensureInitialized(): Promise<SiteMetadata> {
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const [cached, onlineManifest] = await Promise.all([
        readCachedDataset("active"),
        this.fetchManifestOnline(),
      ]);

      let manifest: StaticSiteManifest | null = onlineManifest ?? cached?.manifest ?? null;
      if (!manifest) {
        throw new Error(
          "Site terrain dataset not found. Run bun run build:data before building or serving.",
        );
      }

      let terrainBuffer: ArrayBuffer | null = null;
      let soilBuffer: ArrayBuffer | undefined;
      const cacheMatchesManifest =
        cached &&
        cached.manifest.generatedAt === manifest.generatedAt &&
        cached.terrainBuffer.byteLength === manifest.terrainByteLength &&
        (!manifest.soilBinFile ||
          (cached.soilBuffer !== undefined &&
            cached.soilBuffer.byteLength === manifest.soilByteLength));

      if (cacheMatchesManifest && cached) {
        terrainBuffer = cached.terrainBuffer;
        soilBuffer = cached.soilBuffer;
      } else {
        const binUrl = `/data/${manifest.terrainBinFile}`;
        const soilUrl = manifest.soilBinFile ? `/data/${manifest.soilBinFile}` : null;
        try {
          const [binRes, soilRes] = await Promise.all([
            fetch(binUrl),
            soilUrl ? fetch(soilUrl).catch(() => null) : Promise.resolve(null),
          ]);
          if (!binRes.ok) {
            throw new Error(`Failed to fetch terrain dataset (${binRes.status})`);
          }
          terrainBuffer = await binRes.arrayBuffer();
          if (soilRes?.ok) {
            soilBuffer = await soilRes.arrayBuffer();
          }
          await writeCachedDataset({
            key: "active",
            manifest,
            terrainBuffer,
            soilBuffer,
            cachedAtMs: Date.now(),
          });
        } catch (err) {
          // Offline fallback to previously cached DEM even if newer manifest was seen
          if (cached) {
            manifest = cached.manifest;
            terrainBuffer = cached.terrainBuffer;
            soilBuffer = cached.soilBuffer;
          } else {
            throw err;
          }
        }
      }

      // Send transferable clones so IndexedDB record / retry stays valid
      const workerBuffer = terrainBuffer.slice(0);
      const workerSoilBuffer = soilBuffer ? soilBuffer.slice(0) : undefined;
      const transfer: Transferable[] = workerSoilBuffer
        ? [workerBuffer, workerSoilBuffer]
        : [workerBuffer];
      const res = await this.callWorker(
        {
          type: "init",
          meta: manifest.meta,
          terrainBuffer: workerBuffer,
          soilBuffer: workerSoilBuffer,
        },
        transfer,
      );
      if (res.type !== "init") {
        throw new Error("Unexpected response during terrain worker initialization");
      }
      return res.meta;
    })().catch((err) => {
      this.initPromise = null;
      throw err;
    });

    return this.initPromise;
  }

  async queryElevation(lat: number, lon: number): Promise<ElevationResponse> {
    await this.ensureInitialized();
    const res = await this.callWorker({ type: "elevation", coord: { lat, lon } });
    if (res.type !== "elevation") {
      throw new Error("Unexpected elevation response");
    }
    return res.data;
  }

  async planRoutes(payload: RoutePlanRequest, signal?: AbortSignal): Promise<RoutePlanResponse> {
    const meta = await this.ensureInitialized();
    const waypoints =
      payload.waypoints && payload.waypoints.length > 0
        ? payload.waypoints
        : payload.waypointA && payload.waypointB
          ? [payload.waypointA, payload.waypointB]
          : [];
    const wpKey = waypoints.map((w) => `${w.lat.toFixed(6)},${w.lon.toFixed(6)}`).join("->");
    const soilFactors = resolveSoilSpeedFactors(payload.soilSpeedFactors);
    const soilKey = `${soilFactors.bedrock.toFixed(2)},${soilFactors["coarse-regolith"].toFixed(2)},${soilFactors["fine-regolith"].toFixed(2)},${soilFactors["loose-sand"].toFixed(2)}`;
    const wc = payload.weatherConstraints;
    const wcKey = wc?.enabled
      ? `${wc.scenario ?? "auto"}:${wc.sol ?? "latest"}:${(wc.lmstHour ?? 12).toFixed(1)}:${Math.round(wc.minAirTempC ?? DEFAULT_EVA_WEATHER_LIMITS.minAirTempC)}:${Math.round(wc.minPressurePa ?? DEFAULT_EVA_WEATHER_LIMITS.minPressurePa)}:${(wc.thermalWeight ?? 0.35).toFixed(2)}`
      : "off";
    const cacheKey = `${meta.id}|${wpKey}|s=${payload.maxSlopeDeg.toFixed(2)}|soil=${soilKey}|w=${wcKey}`;

    const cachedRoute = await readCachedRoute(cacheKey);
    if (cachedRoute) {
      if (signal?.aborted) throw abortError();
      return cachedRoute;
    }

    const snapshot = wc?.enabled
      ? await defaultClientWeatherService.getWeather({
          site: meta.id,
          scenario: wc.scenario ?? "auto",
          sol: wc.sol,
          siteMeta: meta,
        })
      : undefined;

    if (signal?.aborted) throw abortError();

    const res = await this.callWorker(
      {
        type: "planRoutes",
        payload,
        snapshot,
      },
      [],
      signal,
    );
    if (res.type !== "planRoutes") {
      throw new Error("Unexpected route plan response");
    }

    void writeCachedRoute(cacheKey, res.data);
    return res.data;
  }

  async computeEnvironmentSummary(
    params?: {
      scenario?: WeatherScenario;
      sol?: number;
      lmstHour?: number;
    },
    signal?: AbortSignal,
  ): Promise<SiteEnvironmentSummary> {
    const meta = await this.ensureInitialized();
    const snapshot = await defaultClientWeatherService.getWeather({
      site: meta.id,
      scenario: params?.scenario ?? "auto",
      sol: params?.sol,
      siteMeta: meta,
    });
    if (signal?.aborted) throw abortError();

    const res = await this.callWorker(
      {
        type: "environmentSummary",
        snapshot,
        lmstHour: params?.lmstHour ?? 12,
      },
      [],
      signal,
    );
    if (res.type !== "environmentSummary") {
      throw new Error("Unexpected environment summary response");
    }
    return res.data;
  }

  private async renderMaskUrl(
    cacheKey: string,
    payloadBuilder: () => Promise<WorkerPayload>,
    signal?: AbortSignal,
  ): Promise<string> {
    return runCoalescedOverlayRender(cacheKey, async () => {
      if (signal?.aborted) throw abortError();

      const idbBlob = await readCachedOverlay(cacheKey);
      if (idbBlob) {
        return cacheOverlayBlob(cacheKey, idbBlob);
      }

      if (signal?.aborted) throw abortError();
      const payload = await payloadBuilder();
      const res = await this.callWorker(payload, [], signal);
      if (res.type !== "renderMask") {
        throw new Error("Unexpected renderMask response");
      }

      const blob = await encodeRgbaBufferToPngBlob(res.cols, res.rows, res.rgbaBuffer);
      void writeCachedOverlay(cacheKey, blob);
      return cacheOverlayBlob(cacheKey, blob);
    });
  }

  async renderSlopeMaskUrl(maxSlopeDeg: number, signal?: AbortSignal): Promise<string> {
    const meta = await this.ensureInitialized();
    const clamped = Math.max(0.5, Math.min(89, maxSlopeDeg));
    const key = `${meta.id}|slope|${clamped.toFixed(1)}`;
    return this.renderMaskUrl(
      key,
      async () => ({ type: "renderSlopeMask", maxSlopeDeg: clamped }),
      signal,
    );
  }

  async renderSoilMaskUrl(signal?: AbortSignal): Promise<string> {
    const meta = await this.ensureInitialized();
    const key = `${meta.id}|soil`;
    return this.renderMaskUrl(key, async () => ({ type: "renderSoilMask" }), signal);
  }

  async renderPressureMaskUrl(
    params: {
      scenario?: "auto" | "nominal" | "dust-storm" | "cold-snap";
      sol?: number;
      lmstHour: number;
      minPressurePa: number;
    },
    signal?: AbortSignal,
  ): Promise<string> {
    const meta = await this.ensureInitialized();
    const scenario = params.scenario ?? "auto";
    const snapshot = await defaultClientWeatherService.getWeather({
      site: meta.id,
      scenario,
      sol: params.sol,
      siteMeta: meta,
    });
    const lmstHour = Math.max(0, Math.min(48, params.lmstHour));
    const minPressurePa = Math.round(params.minPressurePa);
    const key = `${meta.id}|press|${scenario}|${snapshot.sol}|${lmstHour.toFixed(1)}|${minPressurePa}`;

    return this.renderMaskUrl(
      key,
      async () => ({
        type: "renderPressureMask",
        snapshot,
        lmstHour,
        minPressurePa,
      }),
      signal,
    );
  }

  async renderTemperatureMaskUrl(
    params: {
      scenario?: "auto" | "nominal" | "dust-storm" | "cold-snap";
      sol?: number;
      lmstHour: number;
      minAirTempC: number;
    },
    signal?: AbortSignal,
  ): Promise<string> {
    const meta = await this.ensureInitialized();
    const scenario = params.scenario ?? "auto";
    const snapshot = await defaultClientWeatherService.getWeather({
      site: meta.id,
      scenario,
      sol: params.sol,
      siteMeta: meta,
    });
    const lmstHour = Math.max(0, Math.min(48, params.lmstHour));
    const minAirTempC = Math.round(params.minAirTempC);
    const key = `${meta.id}|temp|${scenario}|${snapshot.sol}|${lmstHour.toFixed(1)}|${minAirTempC}`;

    return this.renderMaskUrl(
      key,
      async () => ({
        type: "renderTemperatureMask",
        snapshot,
        lmstHour,
        minAirTempC,
      }),
      signal,
    );
  }
}

export const clientEngine = new ClientTerrainEngine();
