import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MARS_BASE_LAYERS, type RoutePlanRequest, type SiteDataset } from "@nimbs/shared";
import { Hono } from "hono";
import { tilesRouter } from "./routes/tiles";
import { TerrainGraph } from "./terrain/engine";

const DATA_DIR = resolve(import.meta.dir, "../../../data");
const TERRAIN_JSON_PATH = resolve(DATA_DIR, "site-terrain.json");
const HILLSHADE_PNG_PATH = resolve(DATA_DIR, "site-hillshade.png");

let cachedGraph: TerrainGraph | null = null;

async function getTerrainGraph(): Promise<TerrainGraph | null> {
  if (cachedGraph) return cachedGraph;
  if (!existsSync(TERRAIN_JSON_PATH)) return null;
  const raw = await readFile(TERRAIN_JSON_PATH, "utf8");
  const dataset = JSON.parse(raw) as SiteDataset;
  cachedGraph = new TerrainGraph(dataset);
  return cachedGraph;
}

export function createApp(injectedGraph?: TerrainGraph): Hono {
  const app = new Hono();

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
    const maxSlopeDeg = Number.isFinite(rawSlope) ? Math.max(0.5, Math.min(89, rawSlope)) : 15;
    const png = graph.renderSlopeMaskPng(maxSlopeDeg);
    return new Response(new Uint8Array(png), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=300",
      },
    });
  });

  app.get("/api/terrain/elevation", async (c) => {
    const graph = await resolveGraph();
    if (!graph) {
      return c.json({ error: "Site terrain dataset not found." }, 503);
    }
    const lat = Number(c.req.query("lat"));
    const lon = Number(c.req.query("lon"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
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

    const result = graph.planRoutes(body.waypointA, body.waypointB, Number(body.maxSlopeDeg));
    return c.json(result);
  });

  app.route("/api/tiles", tilesRouter);

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
