import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DEFAULT_EVA_WEATHER_LIMITS,
  MARS_BASE_LAYERS,
  type RoutePlanRequest,
  type RouteWeatherConstraints,
  type SiteDataset,
  type WeatherScenario,
} from "@nimbs/shared";
import { type Context, Hono } from "hono";
import { tilesRouter } from "./routes/tiles";
import { createWeatherRouter } from "./routes/weather";
import { TerrainGraph, type TerrainWeatherFilter } from "./terrain/engine";
import {
  type SiteWeatherField,
  computeSiteWeatherField,
  renderPressureMaskPng,
  renderTemperatureMaskPng,
  toSiteEnvironmentSummary,
} from "./terrain/weatherField";
import { type WeatherService, defaultWeatherService } from "./weather/service";

const DATA_DIR = resolve(import.meta.dir, "../../../data");
const TERRAIN_JSON_PATH = resolve(DATA_DIR, "site-terrain.json");
const HILLSHADE_PNG_PATH = resolve(DATA_DIR, "site-hillshade.png");
const VALID_SCENARIOS = new Set<WeatherScenario>(["auto", "nominal", "dust-storm", "cold-snap"]);

let cachedGraph: TerrainGraph | null = null;

async function getTerrainGraph(): Promise<TerrainGraph | null> {
  if (cachedGraph) return cachedGraph;
  if (!existsSync(TERRAIN_JSON_PATH)) return null;
  const raw = await readFile(TERRAIN_JSON_PATH, "utf8");
  const dataset = JSON.parse(raw) as SiteDataset;
  cachedGraph = new TerrainGraph(dataset);
  return cachedGraph;
}

function parseScenario(raw: unknown): WeatherScenario | null {
  if (raw === undefined || raw === "") return "auto";
  if (typeof raw === "string" && VALID_SCENARIOS.has(raw as WeatherScenario)) {
    return raw as WeatherScenario;
  }
  return null;
}

function parseOptionalSol(raw: unknown): number | undefined | null {
  if (raw === undefined || raw === "") return undefined;
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  const num = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(num) || num < 0 || num > 100_000) return null;
  return num;
}

function parseClampedQueryNumber(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw === "") return fallback;
  const num = Number(raw);
  return Number.isFinite(num) ? Math.max(min, Math.min(max, num)) : fallback;
}

function validateRouteWeatherConstraints(raw: unknown): {
  constraints?: RouteWeatherConstraints;
  error?: string;
} {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "weatherConstraints must be an object" };
  }

  const candidate = raw as Partial<RouteWeatherConstraints>;
  if (typeof candidate.enabled !== "boolean") {
    return { error: "weatherConstraints.enabled must be a boolean" };
  }

  const scenario = parseScenario(candidate.scenario);
  if (!scenario) {
    return {
      error:
        "Invalid weatherConstraints.scenario. Expected auto, nominal, dust-storm, or cold-snap",
    };
  }

  const sol = parseOptionalSol(candidate.sol);
  if (sol === null) {
    return { error: "weatherConstraints.sol must be a non-negative integer" };
  }

  if (
    candidate.lmstHour !== undefined &&
    (!Number.isFinite(candidate.lmstHour) || candidate.lmstHour < 0 || candidate.lmstHour > 48)
  ) {
    return { error: "weatherConstraints.lmstHour must be a finite number in [0, 48]" };
  }

  if (
    candidate.minAirTempC !== undefined &&
    (!Number.isFinite(candidate.minAirTempC) ||
      candidate.minAirTempC < -180 ||
      candidate.minAirTempC > 60)
  ) {
    return { error: "weatherConstraints.minAirTempC must be a finite number in [-180, 60]" };
  }

  if (
    candidate.minPressurePa !== undefined &&
    (!Number.isFinite(candidate.minPressurePa) ||
      candidate.minPressurePa < 0 ||
      candidate.minPressurePa > 2500)
  ) {
    return { error: "weatherConstraints.minPressurePa must be a finite number in [0, 2500]" };
  }

  if (
    candidate.thermalWeight !== undefined &&
    (!Number.isFinite(candidate.thermalWeight) ||
      candidate.thermalWeight < 0 ||
      candidate.thermalWeight > 1)
  ) {
    return { error: "weatherConstraints.thermalWeight must be a finite number in [0, 1]" };
  }

  return {
    constraints: {
      enabled: candidate.enabled,
      scenario,
      sol,
      lmstHour: candidate.lmstHour,
      minAirTempC: candidate.minAirTempC,
      minPressurePa: candidate.minPressurePa,
      thermalWeight: candidate.thermalWeight,
    },
  };
}

async function resolveSiteWeatherField(
  c: Context,
  resolveGraph: () => Promise<TerrainGraph | null>,
  activeWeatherService: WeatherService,
): Promise<{ graph: TerrainGraph; field: SiteWeatherField } | Response> {
  const graph = await resolveGraph();
  if (!graph) {
    return c.json({ error: "Site terrain dataset not found. Run bun run fetch-site." }, 503);
  }

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

  const lmstHour = parseClampedQueryNumber(c.req.query("lmstHour"), 12, 0, 48);
  const site = c.req.query("site");
  const snapshot = await activeWeatherService.getWeather({
    site,
    scenario,
    sol,
    siteMeta: graph.meta,
  });
  const field = computeSiteWeatherField(graph, snapshot, lmstHour);
  return { graph, field };
}

export function createApp(injectedGraph?: TerrainGraph, weatherService?: WeatherService): Hono {
  const app = new Hono();
  const activeWeatherService = weatherService ?? defaultWeatherService;

  const resolveGraph = async (): Promise<TerrainGraph | null> =>
    injectedGraph ?? (await getTerrainGraph());

  app.get("/api/health", async (c) => {
    const graph = await resolveGraph();
    return c.json({
      ok: true,
      siteLoaded: graph !== null,
      siteId: graph?.meta.id ?? null,
    });
  });

  app.get("/api/layers", (c) => c.json({ layers: MARS_BASE_LAYERS }));

  app.get("/api/site", async (c) => {
    const graph = await resolveGraph();
    if (!graph) {
      return c.json({ error: "Site terrain dataset not found. Run bun run fetch-site." }, 503);
    }
    return c.json({ meta: graph.meta });
  });

  app.get("/api/site/hillshade.png", async (c) => {
    if (!existsSync(HILLSHADE_PNG_PATH)) {
      return c.json({ error: "Site hillshade image not found." }, 404);
    }
    const bytes = await readFile(HILLSHADE_PNG_PATH);
    return new Response(bytes, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=3600",
      },
    });
  });

  app.get("/api/site/passability.png", async (c) => {
    const graph = await resolveGraph();
    if (!graph) {
      return c.json({ error: "Site terrain dataset not found." }, 503);
    }
    const rawSlope = Number(c.req.query("maxSlopeDeg") ?? "15");
    const maxSlopeDeg = Number.isFinite(rawSlope) ? Math.max(0, Math.min(89, rawSlope)) : 15;
    const png = graph.renderSlopeMaskPng(maxSlopeDeg);
    return new Response(new Uint8Array(png), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=300",
      },
    });
  });

  app.get("/api/site/pressure.png", async (c) => {
    const resolved = await resolveSiteWeatherField(c, resolveGraph, activeWeatherService);
    if (resolved instanceof Response) return resolved;

    const minPressurePa = parseClampedQueryNumber(
      c.req.query("minPressurePa"),
      DEFAULT_EVA_WEATHER_LIMITS.minPressurePa,
      0,
      2500,
    );
    const png = renderPressureMaskPng(resolved.graph, resolved.field, minPressurePa);
    return new Response(new Uint8Array(png), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=120",
        "X-Layer-Min": String(resolved.field.minPressurePa),
        "X-Layer-Max": String(resolved.field.maxPressurePa),
        "X-Layer-Mean": String(resolved.field.meanPressurePa),
        "X-Layer-Lmst": resolved.field.lmstLabel,
        "X-Layer-Unit": "Pa",
      },
    });
  });

  app.get("/api/site/temperature.png", async (c) => {
    const resolved = await resolveSiteWeatherField(c, resolveGraph, activeWeatherService);
    if (resolved instanceof Response) return resolved;

    const minAirTempC = parseClampedQueryNumber(
      c.req.query("minAirTempC"),
      DEFAULT_EVA_WEATHER_LIMITS.minAirTempC,
      -180,
      60,
    );
    const png = renderTemperatureMaskPng(resolved.graph, resolved.field, minAirTempC);
    return new Response(new Uint8Array(png), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=120",
        "X-Layer-Min": String(resolved.field.minTempC),
        "X-Layer-Max": String(resolved.field.maxTempC),
        "X-Layer-Mean": String(resolved.field.meanTempC),
        "X-Layer-Lmst": resolved.field.lmstLabel,
        "X-Layer-Unit": "C",
      },
    });
  });

  app.get("/api/site/environment-summary", async (c) => {
    const resolved = await resolveSiteWeatherField(c, resolveGraph, activeWeatherService);
    if (resolved instanceof Response) return resolved;
    return c.json(toSiteEnvironmentSummary(resolved.field));
  });

  app.get("/api/terrain/elevation", async (c) => {
    const graph = await resolveGraph();
    if (!graph) {
      return c.json({ error: "Site terrain dataset not found." }, 503);
    }
    const rawLat = c.req.query("lat");
    const rawLon = c.req.query("lon");
    const lat = Number(rawLat);
    const lon = Number(rawLon);
    if (!rawLat?.trim() || !rawLon?.trim() || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      return c.json({ error: "lat and lon query params must be finite numbers" }, 400);
    }
    const insideSite = graph.isInsideBounds({ lat, lon });
    const elevationM = graph.elevationAt({ lat, lon });
    return c.json({ lat, lon, insideSite, elevationM });
  });

  app.post("/api/graph/routes", async (c) => {
    const graph = await resolveGraph();
    if (!graph) {
      return c.json({ error: "Site terrain dataset not found." }, 503);
    }
    const body = (await c.req.json().catch(() => null)) as Partial<RoutePlanRequest> | null;
    if (
      !body?.waypointA ||
      !body?.waypointB ||
      !Number.isFinite(body.waypointA.lat) ||
      !Number.isFinite(body.waypointA.lon) ||
      !Number.isFinite(body.waypointB.lat) ||
      !Number.isFinite(body.waypointB.lon) ||
      !Number.isFinite(body.maxSlopeDeg)
    ) {
      return c.json({ error: "Invalid waypointA, waypointB, or maxSlopeDeg payload" }, 400);
    }

    const { constraints, error: wcError } = validateRouteWeatherConstraints(
      body.weatherConstraints,
    );
    if (wcError) {
      return c.json({ error: wcError }, 400);
    }

    let weatherFilter: TerrainWeatherFilter | undefined;
    if (constraints?.enabled) {
      const snapshot = await activeWeatherService.getWeather({
        scenario: constraints.scenario ?? "auto",
        sol: constraints.sol,
        siteMeta: graph.meta,
      });
      const lmstHour = constraints.lmstHour ?? 12;
      const field = computeSiteWeatherField(graph, snapshot, lmstHour);
      weatherFilter = {
        lmstHour: field.lmstHour,
        lmstLabel: field.lmstLabel,
        minAirTempC: constraints.minAirTempC ?? DEFAULT_EVA_WEATHER_LIMITS.minAirTempC,
        minPressurePa: constraints.minPressurePa ?? DEFAULT_EVA_WEATHER_LIMITS.minPressurePa,
        thermalWeight: constraints.thermalWeight ?? 0.35,
        cellTempK: field.tempK,
        cellPressurePa: field.pressurePa,
      };
    }

    const result = graph.planRoutes(
      body.waypointA,
      body.waypointB,
      Number(body.maxSlopeDeg),
      weatherFilter,
    );
    return c.json(result);
  });

  app.route("/api/tiles", tilesRouter);
  app.route(
    "/api/weather",
    createWeatherRouter({
      service: activeWeatherService,
      getSiteMeta: async () => (await resolveGraph())?.meta ?? null,
    }),
  );

  return app;
}

export const app = createApp();

if (import.meta.main) {
  const port = Number(process.env.API_PORT ?? 3001);
  console.log(`NIMBS Mars API listening on http://localhost:${port}`);
  Bun.serve({
    port,
    fetch: app.fetch,
  });
}
