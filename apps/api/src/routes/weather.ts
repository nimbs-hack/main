import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { SiteDataset, SiteMetadata } from "@nimbs/shared";
import { Hono } from "hono";
import {
  DEFAULT_EVA_LIMITS,
  DEFAULT_EVA_WEATHER_LIMITS,
  type EvaRouteContext,
  type EvaWeatherEvaluation,
  type EvaWeatherLimits,
  type MarsWeatherSnapshot,
  type TraversePointSample,
  type WeatherApiResponse,
  type WeatherScenario,
  ensureNextSolForecast,
  evaluateEvaWeather,
} from "../weather/generator";
import { WeatherService, defaultWeatherService } from "../weather/service";

const VALID_SCENARIOS = new Set<WeatherScenario>(["auto", "nominal", "dust-storm", "cold-snap"]);
const DEFAULT_TERRAIN_JSON_PATH = resolve(import.meta.dir, "../../../../data/site-terrain.json");

export interface WeatherEvaluateRequest {
  limits?: Partial<EvaWeatherLimits>;
  site?: string;
  scenario?: WeatherScenario;
  sol?: number;
  lmstHour?: number;
  elevationM?: number;
  route?: EvaRouteContext;
  weather?: MarsWeatherSnapshot;
}

export interface WeatherRouterOptions {
  service?: WeatherService;
  getSiteMeta?: () => Promise<SiteMetadata | null>;
}

let cachedFallbackMeta: SiteMetadata | null | undefined;

async function readFallbackSiteMeta(): Promise<SiteMetadata | null> {
  if (cachedFallbackMeta !== undefined) return cachedFallbackMeta;
  if (!existsSync(DEFAULT_TERRAIN_JSON_PATH)) {
    cachedFallbackMeta = null;
    return null;
  }
  try {
    const raw = await readFile(DEFAULT_TERRAIN_JSON_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<SiteDataset>;
    cachedFallbackMeta = parsed.meta ?? null;
    return cachedFallbackMeta;
  } catch {
    cachedFallbackMeta = null;
    return null;
  }
}

function parseScenario(raw: string | undefined): WeatherScenario | null {
  if (raw === undefined || raw === "") return "auto";
  if (VALID_SCENARIOS.has(raw as WeatherScenario)) {
    return raw as WeatherScenario;
  }
  return null;
}

function parseOptionalSol(raw: unknown): number | undefined | null {
  if (raw === undefined || raw === "") return undefined;
  const num = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(num) || num < 0 || num > 100_000) return null;
  return num;
}

function parseQueryLmstHour(raw: string | undefined): number | undefined | null {
  if (raw === undefined || raw === "") return undefined;
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0 || num > 48) return null;
  return num;
}

function validateRoute(rawRoute: unknown): { route?: EvaRouteContext; error?: string } {
  if (rawRoute === undefined) return { route: undefined };
  if (rawRoute === null || typeof rawRoute !== "object" || Array.isArray(rawRoute)) {
    return { error: "route must be an object" };
  }
  const r = rawRoute as Record<string, unknown>;
  const out: EvaRouteContext = {};

  if (r.totalDistanceM !== undefined) {
    if (
      typeof r.totalDistanceM !== "number" ||
      !Number.isFinite(r.totalDistanceM) ||
      r.totalDistanceM < 0
    ) {
      return { error: "route.totalDistanceM must be a non-negative finite number" };
    }
    out.totalDistanceM = r.totalDistanceM;
  }
  if (r.elevationGainM !== undefined) {
    if (
      typeof r.elevationGainM !== "number" ||
      !Number.isFinite(r.elevationGainM) ||
      r.elevationGainM < 0
    ) {
      return { error: "route.elevationGainM must be a non-negative finite number" };
    }
    out.elevationGainM = r.elevationGainM;
  }
  if (r.elevationLossM !== undefined) {
    if (
      typeof r.elevationLossM !== "number" ||
      !Number.isFinite(r.elevationLossM) ||
      r.elevationLossM < 0
    ) {
      return { error: "route.elevationLossM must be a non-negative finite number" };
    }
    out.elevationLossM = r.elevationLossM;
  }
  if (r.minElevationM !== undefined) {
    if (typeof r.minElevationM !== "number" || !Number.isFinite(r.minElevationM)) {
      return { error: "route.minElevationM must be a finite number" };
    }
    out.minElevationM = r.minElevationM;
  }
  if (r.maxElevationM !== undefined) {
    if (typeof r.maxElevationM !== "number" || !Number.isFinite(r.maxElevationM)) {
      return { error: "route.maxElevationM must be a finite number" };
    }
    out.maxElevationM = r.maxElevationM;
  }

  if (r.points !== undefined) {
    if (!Array.isArray(r.points)) {
      return { error: "route.points must be an array" };
    }
    const sanitizedPoints: TraversePointSample[] = [];
    let prevDistance = -1;
    for (let i = 0; i < r.points.length; i += 1) {
      const item = r.points[i];
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return { error: `route.points[${i}] must be an object` };
      }
      const pt = item as Record<string, unknown>;
      if (typeof pt.distanceM !== "number" || !Number.isFinite(pt.distanceM) || pt.distanceM < 0) {
        return { error: `route.points[${i}].distanceM must be a non-negative finite number` };
      }
      if (pt.distanceM < prevDistance) {
        return { error: `route.points[${i}].distanceM must be non-decreasing` };
      }
      prevDistance = pt.distanceM;

      if (typeof pt.elevationM !== "number" || !Number.isFinite(pt.elevationM)) {
        return { error: `route.points[${i}].elevationM must be a finite number` };
      }

      const sample: TraversePointSample = {
        distanceM: pt.distanceM,
        elevationM: pt.elevationM,
      };

      if (pt.slopeDeg !== undefined) {
        if (
          typeof pt.slopeDeg !== "number" ||
          !Number.isFinite(pt.slopeDeg) ||
          pt.slopeDeg < 0 ||
          pt.slopeDeg > 90
        ) {
          return { error: `route.points[${i}].slopeDeg must be a finite number in [0, 90]` };
        }
        sample.slopeDeg = pt.slopeDeg;
      }
      if (pt.lat !== undefined) {
        if (typeof pt.lat !== "number" || !Number.isFinite(pt.lat) || pt.lat < -90 || pt.lat > 90) {
          return { error: `route.points[${i}].lat must be a finite number in [-90, 90]` };
        }
        sample.lat = pt.lat;
      }
      if (pt.lon !== undefined) {
        if (
          typeof pt.lon !== "number" ||
          !Number.isFinite(pt.lon) ||
          pt.lon < -360 ||
          pt.lon > 360
        ) {
          return { error: `route.points[${i}].lon must be a finite number in [-360, 360]` };
        }
        sample.lon = pt.lon;
      }

      sanitizedPoints.push(sample);
    }
    out.points = sanitizedPoints;
  }

  return { route: out };
}

function validateLimits(rawLimits: Partial<EvaWeatherLimits> | undefined): {
  limits: Partial<EvaWeatherLimits>;
  error?: string;
} {
  if (!rawLimits) return { limits: {} };
  if (typeof rawLimits !== "object" || Array.isArray(rawLimits)) {
    return { limits: {}, error: "limits must be an object" };
  }

  const out: Partial<EvaWeatherLimits> = {};
  if (rawLimits.minAirTempC !== undefined) {
    if (
      !Number.isFinite(rawLimits.minAirTempC) ||
      rawLimits.minAirTempC < -180 ||
      rawLimits.minAirTempC > 60
    ) {
      return { limits: {}, error: "minAirTempC must be a finite number in [-180, 60]" };
    }
    out.minAirTempC = rawLimits.minAirTempC;
  }
  if (rawLimits.maxWindSpeedMps !== undefined) {
    if (
      !Number.isFinite(rawLimits.maxWindSpeedMps) ||
      rawLimits.maxWindSpeedMps < 0 ||
      rawLimits.maxWindSpeedMps > 100
    ) {
      return { limits: {}, error: "maxWindSpeedMps must be a finite number in [0, 100]" };
    }
    out.maxWindSpeedMps = rawLimits.maxWindSpeedMps;
  }
  if (rawLimits.minPressurePa !== undefined) {
    if (
      !Number.isFinite(rawLimits.minPressurePa) ||
      rawLimits.minPressurePa < 0 ||
      rawLimits.minPressurePa > 2500
    ) {
      return { limits: {}, error: "minPressurePa must be a finite number in [0, 2500]" };
    }
    out.minPressurePa = rawLimits.minPressurePa;
  }
  if (rawLimits.maxPressureSwingPa !== undefined) {
    if (
      !Number.isFinite(rawLimits.maxPressureSwingPa) ||
      rawLimits.maxPressureSwingPa < 0 ||
      rawLimits.maxPressureSwingPa > 500
    ) {
      return { limits: {}, error: "maxPressureSwingPa must be a finite number in [0, 500]" };
    }
    out.maxPressureSwingPa = rawLimits.maxPressureSwingPa;
  }
  if (rawLimits.maxEvaHours !== undefined) {
    if (
      !Number.isFinite(rawLimits.maxEvaHours) ||
      rawLimits.maxEvaHours <= 0 ||
      rawLimits.maxEvaHours > 24
    ) {
      return { limits: {}, error: "maxEvaHours must be a finite number in (0, 24]" };
    }
    out.maxEvaHours = rawLimits.maxEvaHours;
  }

  return { limits: out };
}

export function createWeatherRouter(options: WeatherRouterOptions = {}): Hono {
  const router = new Hono();
  const service = options.service ?? defaultWeatherService;
  const resolveSiteMeta = options.getSiteMeta ?? readFallbackSiteMeta;

  router.get("/", async (c) => {
    const scenario = parseScenario(c.req.query("scenario"));
    if (!scenario) {
      return c.json(
        { error: "Invalid scenario. Expected one of: auto, nominal, dust-storm, cold-snap" },
        400,
      );
    }

    const sol = parseOptionalSol(c.req.query("sol"));
    if (sol === null) {
      return c.json({ error: "sol query param must be a non-negative integer" }, 400);
    }

    const lmstHour = parseQueryLmstHour(c.req.query("lmstHour"));
    if (lmstHour === null) {
      return c.json({ error: "lmstHour query param must be a finite number in [0, 48]" }, 400);
    }

    const site = c.req.query("site");
    const refreshRaw = c.req.query("refresh");
    const refresh = refreshRaw === "1" || refreshRaw === "true";

    const siteMeta = await resolveSiteMeta();
    const weather = await service.getWeather({
      site,
      scenario,
      sol,
      refresh,
      siteMeta,
    });
    const evaluation = evaluateEvaWeather(weather, {
      limits: DEFAULT_EVA_LIMITS,
      siteMeta,
      lmstHour,
    });

    const response: WeatherApiResponse = { weather, evaluation };
    return c.json(response);
  });

  router.post("/evaluate", async (c) => {
    const body = (await c.req.json().catch(() => null)) as WeatherEvaluateRequest | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "Invalid JSON payload" }, 400);
    }

    const scenario = parseScenario(body.scenario);
    if (!scenario) {
      return c.json(
        { error: "Invalid scenario. Expected one of: auto, nominal, dust-storm, cold-snap" },
        400,
      );
    }

    const sol = parseOptionalSol(body.sol);
    if (sol === null) {
      return c.json({ error: "sol must be a non-negative integer" }, 400);
    }

    if (
      body.lmstHour !== undefined &&
      (typeof body.lmstHour !== "number" ||
        !Number.isFinite(body.lmstHour) ||
        body.lmstHour < 0 ||
        body.lmstHour > 48)
    ) {
      return c.json({ error: "lmstHour must be a finite number in [0, 48]" }, 400);
    }

    const { limits, error: limitsError } = validateLimits(body.limits);
    if (limitsError) {
      return c.json({ error: limitsError }, 400);
    }

    if (body.elevationM !== undefined && !Number.isFinite(body.elevationM)) {
      return c.json({ error: "elevationM must be a finite number" }, 400);
    }

    const { route, error: routeError } = validateRoute(body.route);
    if (routeError) {
      return c.json({ error: routeError }, 400);
    }

    const siteMeta = await resolveSiteMeta();
    const weather =
      body.weather &&
      typeof body.weather === "object" &&
      body.weather.airTemp &&
      body.weather.pressure &&
      body.weather.wind &&
      Array.isArray(body.weather.hourly)
        ? ensureNextSolForecast(body.weather)
        : await service.getWeather({
            site: body.site,
            scenario,
            sol,
            siteMeta,
          });

    const evaluation = evaluateEvaWeather(weather, {
      limits,
      elevationM: body.elevationM,
      route,
      siteMeta,
      lmstHour: body.lmstHour,
    });

    const response: WeatherApiResponse = { weather, evaluation };
    return c.json(response);
  });

  return router;
}

export const weatherRouter = createWeatherRouter();

export {
  DEFAULT_EVA_WEATHER_LIMITS,
  WeatherService,
  type MarsWeatherSnapshot,
  type EvaWeatherEvaluation,
  type EvaWeatherLimits,
  type EvaRouteContext,
  type WeatherApiResponse,
  type WeatherScenario,
};
