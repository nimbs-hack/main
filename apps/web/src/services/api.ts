import {
  DEFAULT_EVA_LIMITS,
  type ElevationResponse,
  type EvaRouteWeatherContext,
  type EvaWeatherLimits,
  MARS_BASE_LAYERS,
  type MapLayerMeta,
  type MarsWeatherSnapshot,
  type RoutePlanRequest,
  type RoutePlanResponse,
  type SiteEnvironmentSummary,
  type SiteMetadata,
  type WeatherApiResponse,
  type WeatherScenario,
  ensureNextSolForecast,
  evaluateEvaWeather,
} from "@nimbs/shared";
import { clientEngine } from "./clientEngine";
import { defaultClientWeatherService } from "./clientWeather";

export {
  type ComputedRoute,
  DEFAULT_EVA_WEATHER_LIMITS,
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
  type RouteBlockedReason,
  type RoutePlanRequest,
  type RoutePlanResponse,
  type RoutePoint,
  type RouteStrategy,
  type RouteWeatherConstraints,
  type SelectedHourWeatherSummary,
  type SiteEnvironmentSummary,
  type SiteMetadata,
  TRAVERSE_PRESETS,
  type TraverseDepartureSlot,
  type TraversePointSample,
  type TraversePreset,
  type TraversePresetId,
  type TraverseWindowRecommendation,
  type UiMode,
  type WeatherApiResponse,
  type WeatherCheckId,
  type WeatherHourlyPoint,
  type WeatherScenario,
  type WeatherSourceType,
} from "@nimbs/shared";

export const STATIC_HILLSHADE_URL = "/data/site-hillshade.png";

export async function fetchSiteMeta(): Promise<SiteMetadata> {
  return clientEngine.ensureInitialized();
}

export async function fetchBaseLayers(): Promise<MapLayerMeta[]> {
  return [...MARS_BASE_LAYERS];
}

export async function fetchElevation(lat: number, lon: number): Promise<ElevationResponse> {
  return clientEngine.queryElevation(lat, lon);
}

export async function planGraphRoutes(
  payload: RoutePlanRequest,
  signal?: AbortSignal,
): Promise<RoutePlanResponse> {
  return clientEngine.planRoutes(payload, signal);
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
  if (signal?.aborted) {
    throw new DOMException("Operation aborted", "AbortError");
  }
  const siteMeta = await clientEngine.ensureInitialized().catch(() => null);
  const weather = await defaultClientWeatherService.getWeather({
    site: params?.site ?? siteMeta?.id,
    scenario: params?.scenario,
    sol: params?.sol,
    refresh: params?.refresh,
    siteMeta,
  });
  const evaluation = evaluateEvaWeather(weather, {
    limits: DEFAULT_EVA_LIMITS,
    siteMeta,
    lmstHour: params?.lmstHour,
  });
  return { weather, evaluation };
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
  if (signal?.aborted) {
    throw new DOMException("Operation aborted", "AbortError");
  }
  const siteMeta = await clientEngine.ensureInitialized().catch(() => null);
  const weather = payload.weather
    ? ensureNextSolForecast(payload.weather)
    : await defaultClientWeatherService.getWeather({
        site: payload.site ?? siteMeta?.id,
        scenario: payload.scenario,
        sol: payload.sol,
        siteMeta,
      });

  const evaluation = evaluateEvaWeather(weather, {
    limits: payload.limits,
    elevationM: payload.elevationM,
    route: payload.route,
    siteMeta,
    lmstHour: payload.lmstHour,
  });
  return { weather, evaluation };
}

export async function fetchEnvironmentSummary(
  params?: {
    scenario?: WeatherScenario;
    sol?: number;
    lmstHour?: number;
  },
  signal?: AbortSignal,
): Promise<SiteEnvironmentSummary> {
  return clientEngine.computeEnvironmentSummary(params, signal);
}

export async function renderSlopeMaskUrl(
  maxSlopeDeg: number,
  signal?: AbortSignal,
): Promise<string> {
  return clientEngine.renderSlopeMaskUrl(maxSlopeDeg, signal);
}

export async function renderPressureMaskUrl(
  params: {
    scenario?: WeatherScenario;
    sol?: number;
    lmstHour: number;
    minPressurePa: number;
  },
  signal?: AbortSignal,
): Promise<string> {
  return clientEngine.renderPressureMaskUrl(params, signal);
}

export async function renderTemperatureMaskUrl(
  params: {
    scenario?: WeatherScenario;
    sol?: number;
    lmstHour: number;
    minAirTempC: number;
  },
  signal?: AbortSignal,
): Promise<string> {
  return clientEngine.renderTemperatureMaskUrl(params, signal);
}
