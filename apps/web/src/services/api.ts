import type {
  ElevationResponse,
  EvaRouteWeatherContext,
  EvaWeatherLimits,
  MapLayerMeta,
  MarsWeatherSnapshot,
  RoutePlanRequest,
  RoutePlanResponse,
  SiteEnvironmentSummary,
  SiteMetadata,
  WeatherApiResponse,
  WeatherScenario,
} from "@nimbs/shared";

export {
  type ComputedRoute,
  DEFAULT_EVA_WEATHER_LIMITS,
  DEFAULT_HUMAN_SOIL_SPEED_FACTORS,
  DEFAULT_ROVER_SOIL_SPEED_FACTORS,
  type ElevationResponse,
  type EvaRouteContext,
  type EvaRouteWeatherContext,
  type EvaSafeWindow,
  type EvaStatus,
  type EvaWeatherCheck,
  type EvaWeatherEvaluation,
  type EvaWeatherLimits,
  type MapLayerMeta,
  type MarsWeatherSnapshot,
  type MarsWeatherSolForecast,
  type MissionUnitId,
  type RouteBlockedReason,
  type RoutePlanRequest,
  type RoutePlanResponse,
  type RoutePoint,
  type RouteStrategy,
  type RouteWeatherConstraints,
  SOIL_SPEED_FACTOR_MAX,
  SOIL_SPEED_FACTOR_MIN,
  SOIL_TYPE_CATALOG,
  SOIL_TYPE_ORDER,
  type SelectedHourWeatherSummary,
  type SiteEnvironmentSummary,
  type SiteMetadata,
  type SoilSpeedFactors,
  type SoilTypeId,
  TRAVERSE_PRESETS,
  type TraverseDepartureSlot,
  type TraversePointSample,
  type TraversePreset,
  type TraversePresetId,
  type TraverseWindowRecommendation,
  type UiMode,
  type UnitSimulationSample,
  type UnitTraverseTimeline,
  type WeatherApiResponse,
  type WeatherCheckId,
  type WeatherHourlyPoint,
  type WeatherScenario,
  type WeatherSourceType,
  buildUnitTraverseTimeline,
  findBestWaypointInsertIndex,
  resolveSoilSpeedFactors,
  sampleUnitTimelineAt,
} from "@nimbs/shared";

export async function fetchSiteMeta(): Promise<SiteMetadata> {
  const res = await fetch("/api/site");
  if (!res.ok) {
    throw new Error(`Failed to load site metadata (${res.status})`);
  }
  const data = (await res.json()) as { meta: SiteMetadata };
  return data.meta;
}

export async function fetchBaseLayers(): Promise<MapLayerMeta[]> {
  const res = await fetch("/api/layers");
  if (!res.ok) {
    throw new Error(`Failed to load layers (${res.status})`);
  }
  const data = (await res.json()) as { layers: MapLayerMeta[] };
  return data.layers;
}

export async function fetchElevation(lat: number, lon: number): Promise<ElevationResponse> {
  const res = await fetch(`/api/terrain/elevation?lat=${lat}&lon=${lon}`);
  if (!res.ok) {
    throw new Error(`Elevation query failed (${res.status})`);
  }
  return (await res.json()) as ElevationResponse;
}

export async function planGraphRoutes(
  payload: RoutePlanRequest,
  signal?: AbortSignal,
): Promise<RoutePlanResponse> {
  const res = await fetch("/api/graph/routes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) {
    throw new Error(`Route calculation failed (${res.status})`);
  }
  return (await res.json()) as RoutePlanResponse;
}

export async function fetchWeatherSnapshot(
  params?: {
    site?: string;
    scenario?: WeatherScenario;
    sol?: number;
    lmstHour?: number;
    refresh?: boolean;
  },
  signal?: AbortSignal,
): Promise<WeatherApiResponse> {
  const query = new URLSearchParams();
  if (params?.site) query.set("site", params.site);
  if (params?.scenario) query.set("scenario", params.scenario);
  if (params?.sol !== undefined) query.set("sol", String(params.sol));
  if (params?.lmstHour !== undefined && Number.isFinite(params.lmstHour)) {
    query.set("lmstHour", String(params.lmstHour));
  }
  if (params?.refresh) query.set("refresh", "1");
  const qs = query.toString();
  const res = await fetch(`/api/weather${qs ? `?${qs}` : ""}`, { signal });
  if (!res.ok) {
    throw new Error(`Weather query failed (${res.status})`);
  }
  return (await res.json()) as WeatherApiResponse;
}

export async function evaluateWeatherConstraints(
  payload: {
    limits: EvaWeatherLimits;
    site?: string;
    scenario?: WeatherScenario;
    sol?: number;
    lmstHour?: number;
    elevationM?: number;
    route?: EvaRouteWeatherContext;
    weather?: MarsWeatherSnapshot;
  },
  signal?: AbortSignal,
): Promise<WeatherApiResponse> {
  const res = await fetch("/api/weather/evaluate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) {
    throw new Error(`Weather evaluation failed (${res.status})`);
  }
  return (await res.json()) as WeatherApiResponse;
}

export async function fetchEnvironmentSummary(
  params?: {
    scenario?: WeatherScenario;
    sol?: number;
    lmstHour?: number;
  },
  signal?: AbortSignal,
): Promise<SiteEnvironmentSummary> {
  const query = new URLSearchParams();
  if (params?.scenario) query.set("scenario", params.scenario);
  if (params?.sol !== undefined) query.set("sol", String(params.sol));
  if (params?.lmstHour !== undefined && Number.isFinite(params.lmstHour)) {
    query.set("lmstHour", String(params.lmstHour));
  }
  const qs = query.toString();
  const res = await fetch(`/api/site/environment-summary${qs ? `?${qs}` : ""}`, { signal });
  if (!res.ok) {
    throw new Error(`Environment summary query failed (${res.status})`);
  }
  return (await res.json()) as SiteEnvironmentSummary;
}
