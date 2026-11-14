import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ElevationResponse,
  RoutePlanResponse,
  SiteDataset,
  SiteMetadata,
} from "@nimbs/shared";
import { createApp } from "../index";
import { TerrainGraph } from "./engine";

const DATA_DIR = resolve(import.meta.dir, "../../../../data");
const TERRAIN_JSON_PATH = resolve(DATA_DIR, "site-terrain.json");
const HILLSHADE_PNG_PATH = resolve(DATA_DIR, "site-hillshade.png");
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const hasRealSite = existsSync(TERRAIN_JSON_PATH);

describe.skipIf(!hasRealSite)("Real Jezero Crater site dataset", () => {
  const dataset = hasRealSite
    ? (JSON.parse(readFileSync(TERRAIN_JSON_PATH, "utf8")) as SiteDataset)
    : null;

  test("loads 3x3 km Jezero Crater DEM grid and answers elevation queries", async () => {
    if (!dataset) return;
    const graph = new TerrainGraph(dataset);
    const app = createApp();

    const siteRes = await app.request("/api/site");
    expect(siteRes.status).toBe(200);
    const { meta } = (await siteRes.json()) as { meta: SiteMetadata };
    expect(meta.rows).toBe(151);
    expect(meta.cols).toBe(151);
    expect(meta.widthMeters).toBeGreaterThan(2900);
    expect(meta.widthMeters).toBeLessThan(3100);

    const elevRes = await app.request(
      `/api/terrain/elevation?lat=${meta.center.lat}&lon=${meta.center.lon}`,
    );
    expect(elevRes.status).toBe(200);
    const elevBody = (await elevRes.json()) as ElevationResponse;
    expect(elevBody.insideSite).toBe(true);
    expect(elevBody.elevationM).not.toBeNull();
    expect(graph.elevationAt(meta.center)).not.toBeNull();

    const outsideRes = await app.request("/api/terrain/elevation?lat=0&lon=0");
    expect(outsideRes.status).toBe(200);
    const outsideBody = (await outsideRes.json()) as ElevationResponse;
    expect(outsideBody.insideSite).toBe(false);
    expect(outsideBody.elevationM).toBeNull();
  });

  test("plans routes respecting maxSlopeDeg and reports unreachable minimum slope", async () => {
    if (!dataset) return;
    const graph = new TerrainGraph(dataset);
    const a = graph.coordForCell(20, 20);
    const b = graph.coordForCell(130, 130);

    const permissive = graph.planRoutes(a, b, 30);
    expect(permissive.status).toBe("ok");
    const first = permissive.routes[0];
    expect(first).toBeDefined();
    if (first) {
      expect(first.totalDistanceM).toBeGreaterThan(2500);
      expect(first.maxSlopeDeg).toBeLessThanOrEqual(30);
      expect(first.points.length).toBeGreaterThan(20);
    }

    const strict = graph.planRoutes(a, b, 0.5);
    expect(strict.status).toBe("unreachable");
    expect(strict.routes).toHaveLength(0);
    expect(strict.passableEdgeRatio).toBeLessThan(permissive.passableEdgeRatio);
    expect(strict.minRequiredSlopeDeg).toBeGreaterThan(0.5);

    if (strict.minRequiredSlopeDeg !== undefined) {
      const recovered = graph.planRoutes(a, b, strict.minRequiredSlopeDeg);
      expect(recovered.status).toBe("ok");
    }
  });

  test("serves passability and hillshade PNG overlays and API route plan", async () => {
    if (!dataset) return;
    const app = createApp();
    const graph = new TerrainGraph(dataset);
    const a = graph.coordForCell(25, 30);
    const b = graph.coordForCell(120, 120);

    const routeRes = await app.request("/api/graph/routes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ waypointA: a, waypointB: b, maxSlopeDeg: 25 }),
    });
    expect(routeRes.status).toBe(200);
    const routeBody = (await routeRes.json()) as RoutePlanResponse;
    expect(routeBody.status).toBe("ok");
    expect(routeBody.routes.length).toBeGreaterThanOrEqual(1);

    const maskRes = await app.request("/api/site/passability.png?maxSlopeDeg=10");
    expect(maskRes.status).toBe(200);
    expect(maskRes.headers.get("content-type")).toBe("image/png");
    const maskBytes = new Uint8Array(await maskRes.arrayBuffer());
    expect(Array.from(maskBytes.slice(0, 8))).toEqual(PNG_MAGIC);

    if (existsSync(HILLSHADE_PNG_PATH)) {
      const hsRes = await app.request("/api/site/hillshade.png");
      expect(hsRes.status).toBe(200);
      expect(hsRes.headers.get("content-type")).toBe("image/png");
      const hsBytes = new Uint8Array(await hsRes.arrayBuffer());
      expect(Array.from(hsBytes.slice(0, 8))).toEqual(PNG_MAGIC);
    }
  });
});
