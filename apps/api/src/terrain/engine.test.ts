import { describe, expect, test } from "bun:test";
import type { SiteDataset } from "@nimbs/shared";
import { createApp } from "../index";
import { TerrainGraph } from "./engine";

function makeRidgeDataset(): SiteDataset {
  // 11x11 grid (~1000m x 1000m, ~100m spacing) with a steep ridge down the middle col=5
  // except a low pass at row=9 (slope <= 5 deg through row=9, ~20 deg across rows 0..8)
  const rows = 11;
  const cols = 11;
  const elevationsM: number[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      if (c === 5 && r !== 9) {
        elevationsM.push(45); // ~24 deg step from flat 0m neighbors (~100m away)
      } else if (c === 5 && r === 9) {
        elevationsM.push(5); // gentle ~2.8 deg pass
      } else {
        elevationsM.push(0);
      }
    }
  }
  return {
    meta: {
      id: "synthetic-ridge",
      name: "Synthetic Ridge",
      sourceItemId: "test",
      sourceTitle: "test",
      dtmUrl: "https://example.invalid/dtm.tif",
      hillshadeUrl: "https://example.invalid/hs.tif",
      bbox: [77.5, 18.4, 77.5178, 18.4169],
      center: { lat: 18.40845, lon: 77.5089 },
      widthMeters: 1000,
      heightMeters: 1000,
      rows,
      cols,
      cellSizeMeters: 100,
      minElevationM: 0,
      maxElevationM: 45,
      nodataValue: -99999,
    },
    elevationsM,
  };
}

describe("TerrainGraph and slope routing", () => {
  const graph = new TerrainGraph(makeRidgeDataset());
  const a = graph.coordForCell(2, 1);
  const b = graph.coordForCell(2, 9);

  test("detours around steep ridge when maxSlopeDeg is strict", () => {
    const res = graph.planRoutes(a, b, 10);
    expect(res.status).toBe("ok");
    expect(res.routes.length).toBeGreaterThanOrEqual(1);
    const shortest = res.routes[0];
    if (!shortest) throw new Error("Expected shortest route");
    expect(shortest.maxSlopeDeg).toBeLessThanOrEqual(10);
    // Must pass south through row 9 instead of crossing the 45m wall at row 2
    const passedSouth = shortest.points.some((p) => p.lat < graph.coordForCell(7, 5).lat);
    expect(passedSouth).toBe(true);
  });

  test("crosses ridge directly when maxSlopeDeg allows steep slope", () => {
    const strict = graph.planRoutes(a, b, 10);
    const permissive = graph.planRoutes(a, b, 30);
    expect(permissive.status).toBe("ok");
    const strictFirst = strict.routes[0];
    const permissiveFirst = permissive.routes[0];
    if (!strictFirst || !permissiveFirst) throw new Error("Expected routes for both thresholds");
    expect(permissiveFirst.totalDistanceM).toBeLessThan(strictFirst.totalDistanceM);
  });

  test("returns unreachable and minimum required slope when threshold is too low", () => {
    const res = graph.planRoutes(a, b, 1);
    expect(res.status).toBe("unreachable");
    expect(res.routes).toHaveLength(0);
    expect(res.minRequiredSlopeDeg).toBeGreaterThan(1);
    expect(res.minRequiredSlopeDeg).toBeLessThan(5);
  });

  test("rejects waypoints outside bounds", () => {
    const res = graph.planRoutes({ lat: 0, lon: 0 }, b, 15);
    expect(res.status).toBe("out_of_bounds");
  });

  test("API route endpoints respond cleanly", async () => {
    const app = createApp(graph);
    const health = await app.request("/api/health");
    expect(health.status).toBe(200);
    const healthJson = (await health.json()) as { ok: boolean; siteLoaded: boolean };
    expect(healthJson.ok).toBe(true);
    expect(healthJson.siteLoaded).toBe(true);

    const routeRes = await app.request("/api/graph/routes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ waypointA: a, waypointB: b, maxSlopeDeg: 10 }),
    });
    expect(routeRes.status).toBe(200);
    const body = (await routeRes.json()) as { status: string; routes: unknown[] };
    expect(body.status).toBe("ok");
    expect(body.routes.length).toBeGreaterThanOrEqual(1);

    const pngRes = await app.request("/api/site/passability.png?maxSlopeDeg=10");
    expect(pngRes.status).toBe(200);
    expect(pngRes.headers.get("content-type")).toBe("image/png");
  });
});
