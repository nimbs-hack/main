import {
  DEFAULT_EVA_WEATHER_LIMITS,
  DEFAULT_MARS_BASE_LAYER,
  type EvaWeatherLimits,
  type LonFormat,
  MARS_BASE_LAYERS,
  type MarsCoord,
  type MarsWeatherSnapshot,
  type RoutePlanResponse,
  type StaticSiteManifest,
  TRAVERSE_PRESETS,
  type TraversePresetId,
  type UiMode,
  type WeatherScenario,
} from "@nimbs/shared";

const DB_NAME = "nimbs-mars-cache-v1";
const DB_VERSION = 1;
const STORE_DATASETS = "datasets";
const STORE_WEATHER = "weather";
const STORE_OVERLAYS = "overlays";
const STORE_ROUTES = "routes";

const MAX_OVERLAY_ENTRIES = 24;
const MAX_ROUTE_ENTRIES = 32;

export const MISSION_STATE_STORAGE_KEY = "nimbs.mars-mission-state.v1";

export interface CachedTerrainDatasetRecord {
  key: string;
  manifest: StaticSiteManifest;
  terrainBuffer: ArrayBuffer;
  cachedAtMs: number;
}

export interface CachedWeatherRecord {
  key: string;
  snapshot: MarsWeatherSnapshot;
  cachedAtMs: number;
}

export interface CachedOverlayRecord {
  key: string;
  blob: Blob;
  createdAtMs: number;
}

export interface CachedRouteRecord {
  key: string;
  response: RoutePlanResponse;
  createdAtMs: number;
}

export interface PersistedMissionState {
  version: 1;
  activeLayerId: string;
  showHillshade: boolean;
  showSlopeHazard: boolean;
  showPressureLayer: boolean;
  showTemperatureLayer: boolean;
  showSiteBounds: boolean;
  showPointsOverlay: boolean;
  uiMode: UiMode;
  presetId: TraversePresetId;
  activeToolId: string;
  panelOpen: boolean;
  lonFormat: LonFormat;
  maxSlopeDeg: number;
  weatherRoutingEnabled: boolean;
  waypointA: MarsCoord | null;
  waypointB: MarsCoord | null;
  selectedRouteId: string | null;
  simLmstHour: number;
  weatherScenario: WeatherScenario;
  weatherLimits: EvaWeatherLimits;
}

const VALID_LAYER_IDS = new Set(MARS_BASE_LAYERS.map((l) => l.id));
const VALID_SCENARIOS = new Set<WeatherScenario>(["auto", "nominal", "dust-storm", "cold-snap"]);

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openCacheDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") {
    return Promise.resolve(null);
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_DATASETS)) {
          db.createObjectStore(STORE_DATASETS, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(STORE_WEATHER)) {
          db.createObjectStore(STORE_WEATHER, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(STORE_OVERLAYS)) {
          const store = db.createObjectStore(STORE_OVERLAYS, { keyPath: "key" });
          store.createIndex("createdAtMs", "createdAtMs", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_ROUTES)) {
          const store = db.createObjectStore(STORE_ROUTES, { keyPath: "key" });
          store.createIndex("createdAtMs", "createdAtMs", { unique: false });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });

  return dbPromise;
}

async function idbGet<T>(storeName: string, key: string): Promise<T | null> {
  const db = await openCacheDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbPut<T>(storeName: string, record: T): Promise<void> {
  const db = await openCacheDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function idbPruneOldest(storeName: string, maxEntries: number): Promise<void> {
  const db = await openCacheDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      const countReq = store.count();
      countReq.onsuccess = () => {
        let excess = countReq.result - maxEntries;
        if (excess <= 0) return;
        const idx = store.index("createdAtMs");
        const cursorReq = idx.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor || excess <= 0) return;
          cursor.delete();
          excess -= 1;
          cursor.continue();
        };
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function readCachedDataset(
  key = "active",
): Promise<CachedTerrainDatasetRecord | null> {
  const rec = await idbGet<CachedTerrainDatasetRecord>(STORE_DATASETS, key);
  if (!rec || !rec.manifest || !(rec.terrainBuffer instanceof ArrayBuffer)) {
    return null;
  }
  return rec;
}

export async function writeCachedDataset(record: CachedTerrainDatasetRecord): Promise<void> {
  await idbPut(STORE_DATASETS, record);
}

export async function readCachedWeather(key: string): Promise<CachedWeatherRecord | null> {
  const rec = await idbGet<CachedWeatherRecord>(STORE_WEATHER, key);
  if (!rec || !rec.snapshot || typeof rec.cachedAtMs !== "number") {
    return null;
  }
  return rec;
}

export async function writeCachedWeather(record: CachedWeatherRecord): Promise<void> {
  await idbPut(STORE_WEATHER, record);
}

export async function readCachedOverlay(key: string): Promise<Blob | null> {
  const rec = await idbGet<CachedOverlayRecord>(STORE_OVERLAYS, key);
  if (!rec || !(rec.blob instanceof Blob)) return null;
  return rec.blob;
}

export async function writeCachedOverlay(key: string, blob: Blob): Promise<void> {
  await idbPut<CachedOverlayRecord>(STORE_OVERLAYS, {
    key,
    blob,
    createdAtMs: Date.now(),
  });
  await idbPruneOldest(STORE_OVERLAYS, MAX_OVERLAY_ENTRIES);
}

export async function readCachedRoute(key: string): Promise<RoutePlanResponse | null> {
  const rec = await idbGet<CachedRouteRecord>(STORE_ROUTES, key);
  if (!rec || !rec.response) return null;
  return rec.response;
}

export async function writeCachedRoute(key: string, response: RoutePlanResponse): Promise<void> {
  await idbPut<CachedRouteRecord>(STORE_ROUTES, {
    key,
    response,
    createdAtMs: Date.now(),
  });
  await idbPruneOldest(STORE_ROUTES, MAX_ROUTE_ENTRIES);
}

export function createDefaultMissionState(): PersistedMissionState {
  return {
    version: 1,
    activeLayerId: DEFAULT_MARS_BASE_LAYER.id,
    showHillshade: true,
    showSlopeHazard: true,
    showPressureLayer: false,
    showTemperatureLayer: false,
    showSiteBounds: true,
    showPointsOverlay: true,
    uiMode: "basic",
    presetId: "human",
    activeToolId: "route",
    panelOpen: true,
    lonFormat: "180",
    maxSlopeDeg: TRAVERSE_PRESETS.human.maxSlopeDeg,
    weatherRoutingEnabled: true,
    waypointA: null,
    waypointB: null,
    selectedRouteId: null,
    simLmstHour: 12,
    weatherScenario: "auto",
    weatherLimits: { ...DEFAULT_EVA_WEATHER_LIMITS },
  };
}

function sanitizeCoord(raw: unknown): MarsCoord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const lat = (raw as { lat?: unknown }).lat;
  const lon = (raw as { lon?: unknown }).lon;
  if (
    typeof lat === "number" &&
    Number.isFinite(lat) &&
    lat >= -90 &&
    lat <= 90 &&
    typeof lon === "number" &&
    Number.isFinite(lon) &&
    lon >= -180 &&
    lon <= 360
  ) {
    return { lat, lon };
  }
  return null;
}

function sanitizeWeatherLimits(raw: unknown): EvaWeatherLimits {
  const base: EvaWeatherLimits = { ...DEFAULT_EVA_WEATHER_LIMITS };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const rec = raw as Record<string, unknown>;

  const assignBounded = (
    key: keyof EvaWeatherLimits,
    minVal: number,
    maxVal: number,
    exclusiveMin = false,
  ) => {
    const val = rec[key];
    if (typeof val !== "number" || !Number.isFinite(val)) return;
    if (exclusiveMin ? val > minVal && val <= maxVal : val >= minVal && val <= maxVal) {
      base[key] = val;
    }
  };

  assignBounded("minAirTempC", -180, 60);
  assignBounded("maxWindSpeedMps", 0, 100);
  assignBounded("minPressurePa", 0, 2500);
  assignBounded("maxPressureSwingPa", 0, 500);
  assignBounded("maxEvaHours", 0, 24, true);
  assignBounded("flatSpeedMPerH", 100, 50_000);
  assignBounded("climbSpeedMPerH", 25, 10_000);
  assignBounded("descentSpeedMPerH", 25, 15_000);
  return base;
}

function resolveStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  try {
    if (
      typeof globalThis !== "undefined" &&
      "localStorage" in globalThis &&
      globalThis.localStorage
    ) {
      return globalThis.localStorage;
    }
  } catch {
    return null;
  }
  return null;
}

export function loadMissionState(storage?: Storage): PersistedMissionState {
  const defaults = createDefaultMissionState();
  const store = resolveStorage(storage);
  if (!store) return defaults;

  try {
    const raw = store.getItem(MISSION_STATE_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<PersistedMissionState> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaults;

    const presetId: TraversePresetId =
      parsed.presetId === "rover" || parsed.presetId === "human" ? parsed.presetId : "human";
    const uiMode: UiMode = parsed.uiMode === "advance" ? "advance" : "basic";
    const activeLayerId =
      typeof parsed.activeLayerId === "string" && VALID_LAYER_IDS.has(parsed.activeLayerId)
        ? parsed.activeLayerId
        : defaults.activeLayerId;

    return {
      version: 1,
      activeLayerId,
      showHillshade:
        typeof parsed.showHillshade === "boolean" ? parsed.showHillshade : defaults.showHillshade,
      showSlopeHazard:
        typeof parsed.showSlopeHazard === "boolean"
          ? parsed.showSlopeHazard
          : defaults.showSlopeHazard,
      showPressureLayer:
        typeof parsed.showPressureLayer === "boolean"
          ? parsed.showPressureLayer
          : defaults.showPressureLayer,
      showTemperatureLayer:
        typeof parsed.showTemperatureLayer === "boolean"
          ? parsed.showTemperatureLayer
          : defaults.showTemperatureLayer,
      showSiteBounds:
        typeof parsed.showSiteBounds === "boolean"
          ? parsed.showSiteBounds
          : defaults.showSiteBounds,
      showPointsOverlay:
        typeof parsed.showPointsOverlay === "boolean"
          ? parsed.showPointsOverlay
          : defaults.showPointsOverlay,
      uiMode,
      presetId,
      activeToolId:
        typeof parsed.activeToolId === "string" && parsed.activeToolId.length > 0
          ? parsed.activeToolId
          : defaults.activeToolId,
      panelOpen: typeof parsed.panelOpen === "boolean" ? parsed.panelOpen : defaults.panelOpen,
      lonFormat: parsed.lonFormat === "360" ? "360" : "180",
      maxSlopeDeg:
        typeof parsed.maxSlopeDeg === "number" &&
        Number.isFinite(parsed.maxSlopeDeg) &&
        parsed.maxSlopeDeg >= 0.5 &&
        parsed.maxSlopeDeg <= 89
          ? parsed.maxSlopeDeg
          : defaults.maxSlopeDeg,
      weatherRoutingEnabled:
        typeof parsed.weatherRoutingEnabled === "boolean"
          ? parsed.weatherRoutingEnabled
          : defaults.weatherRoutingEnabled,
      waypointA: sanitizeCoord(parsed.waypointA),
      waypointB: sanitizeCoord(parsed.waypointB),
      selectedRouteId: typeof parsed.selectedRouteId === "string" ? parsed.selectedRouteId : null,
      simLmstHour:
        typeof parsed.simLmstHour === "number" &&
        Number.isFinite(parsed.simLmstHour) &&
        parsed.simLmstHour >= 0 &&
        parsed.simLmstHour <= 48
          ? parsed.simLmstHour
          : defaults.simLmstHour,
      weatherScenario:
        typeof parsed.weatherScenario === "string" &&
        VALID_SCENARIOS.has(parsed.weatherScenario as WeatherScenario)
          ? (parsed.weatherScenario as WeatherScenario)
          : defaults.weatherScenario,
      weatherLimits: sanitizeWeatherLimits(parsed.weatherLimits),
    };
  } catch {
    return defaults;
  }
}

export function saveMissionState(state: PersistedMissionState, storage?: Storage): void {
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    store.setItem(MISSION_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore quota or private-mode errors
  }
}
