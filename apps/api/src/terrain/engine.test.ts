import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MarsWeatherSnapshot,
  RoutePlanResponse,
  SiteDataset,
  SiteEnvironmentSummary,
} from "@nimbs/shared";
import { createApp } from "../index";
import { generateMartianWeather } from "../weather/generator";
import { WeatherService } from "../weather/service";
import { TerrainGraph } from "./engine";
import { computeSiteWeatherField, interpolateWeatherAtHour } from "./weatherField";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "nimbs-terrain-weather-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

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

function makeHighlandPassDataset(): SiteDataset {
  // 15x15 grid (~2 km spacing, 28x28 km) with a gentle highland barrier (-1300 m, ~11 deg ramps)
  // across rows 0..10 and a warm high-pressure valley pass (-2500 m) along rows 11..14.
  const rows = 15;
  const cols = 15;
  const elevationsM: number[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      let elev = -2500;
      if (r <= 10) {
        if (c === 4 || c === 10) elev = -2100;
        else if (c === 5 || c === 9) elev = -1700;
        else if (c >= 6 && c <= 8) elev = -1300;
      }
      elevationsM.push(elev);
    }
  }
  return {
    meta: {
      id: "jezero-synthetic-highland",
      name: "Jezero Synthetic Highland",
      sourceItemId: "test-highland",
      sourceTitle: "test-highland",
      dtmUrl: "https://example.invalid/dtm.tif",
      hillshadeUrl: "https://example.invalid/hs.tif",
      bbox: [77.2, 18.4, 77.7, 18.9],
      center: { lat: 18.65, lon: 77.45 },
      widthMeters: 28000,
      heightMeters: 28000,
      rows,
      cols,
      cellSizeMeters: 2000,
      minElevationM: -2500,
      maxElevationM: -1300,
      nodataValue: -99999,
    },
    elevationsM,
  };
}

describe("Spatial weather fields and weather-constrained routing", () => {
  const graph = new TerrainGraph(makeHighlandPassDataset());
  const a = graph.coordForCell(2, 1);
  const b = graph.coordForCell(2, 13);
  const summit = graph.coordForCell(2, 7);

  const snapshot = generateMartianWeather({
    site: "jezero",
    siteMeta: graph.meta,
    sol: 1859,
    lsDeg: 137,
    scenario: "nominal",
  }) as MarsWeatherSnapshot;

  test("detours around high-altitude cold/low-pressure ridge and attaches route weather metrics", () => {
    const field = computeSiteWeatherField(graph, snapshot, 14);
    const summitIdx = 2 * graph.cols + 7;
    const valleyIdx = 13 * graph.cols + 7;
    const summitP = field.pressurePa[summitIdx] ?? 0;
    const valleyP = field.pressurePa[valleyIdx] ?? 0;
    expect(valleyP).toBeGreaterThan(summitP + 40);

    // Unconstrained slope-only route crosses straight over the highland at row 2
    const slopeOnly = graph.planRoutes(a, b, 20);
    expect(slopeOnly.status).toBe("ok");
    const directFirst = slopeOnly.routes[0];
    if (!directFirst) throw new Error("Expected direct slope route");
    expect(directFirst.points.every((pt) => pt.lat > graph.coordForCell(5, 7).lat)).toBe(true);

    // Setting minPressurePa between summit and valley forces a detour south through row 11..14
    const strictMinP = Math.round(((summitP + valleyP) / 2) * 10) / 10;
    const pressureDetour = graph.planRoutes(a, b, 20, {
      lmstHour: 14,
      lmstLabel: field.lmstLabel,
      minAirTempC: -150,
      minPressurePa: strictMinP,
      thermalWeight: 0.35,
      cellTempK: field.tempK,
      cellPressurePa: field.pressurePa,
    });
    expect(pressureDetour.status).toBe("ok");
    expect(pressureDetour.weatherApplied).toBe(true);
    expect(pressureDetour.appliedLmstHour).toBe(14);
    expect(pressureDetour.minPressureFilterPa).toBe(strictMinP);

    const detoured = pressureDetour.routes[0];
    if (!detoured) throw new Error("Expected detoured route");
    expect(detoured.totalDistanceM).toBeGreaterThan(directFirst.totalDistanceM);
    expect(detoured.minPressurePa).toBeGreaterThanOrEqual(strictMinP);
    expect(detoured.points.some((pt) => pt.lat < graph.coordForCell(10, 7).lat)).toBe(true);
    expect(
      detoured.points.every((pt) => pt.tempC !== undefined && pt.pressurePa !== undefined),
    ).toBe(true);

    // With permissive thresholds and thermalWeight > 0, weather-safe strategy finds warmer/higher-pressure corridor
    const thermalWeighted = graph.planRoutes(a, b, 20, {
      lmstHour: 14,
      lmstLabel: field.lmstLabel,
      minAirTempC: -150,
      minPressurePa: 100,
      thermalWeight: 0.85,
      cellTempK: field.tempK,
      cellPressurePa: field.pressurePa,
    });
    expect(thermalWeighted.status).toBe("ok");
    const thermalSafe = thermalWeighted.routes.find((r) => r.strategy === "weather-safe");
    expect(thermalSafe).toBeDefined();
    expect(thermalSafe?.id).toBe("route-weather-safe");
    expect(thermalSafe?.label).toBe("THERMAL SAFE");
    if (thermalSafe && thermalWeighted.routes[0]) {
      expect(thermalSafe.minPressurePa).toBeGreaterThan(
        thermalWeighted.routes[0].minPressurePa ?? 0,
      );
    }
  });

  test("classifies unreachable pressure and temperature bottlenecks with exact feasible limits", () => {
    const field = computeSiteWeatherField(graph, snapshot, 14);
    const summitIdx = 2 * graph.cols + 7;
    const summitP = field.pressurePa[summitIdx] ?? 0;
    const summitTempC = (field.tempK[summitIdx] ?? 273.15) - 273.15;

    // Route to summit is slope-passable, but fails a pressure limit set above summit pressure
    const strictP = Math.round((summitP + 20) * 10) / 10;
    const pressBlocked = graph.planRoutes(a, summit, 20, {
      lmstHour: 14,
      lmstLabel: field.lmstLabel,
      minAirTempC: -150,
      minPressurePa: strictP,
      thermalWeight: 0.35,
      cellTempK: field.tempK,
      cellPressurePa: field.pressurePa,
    });
    expect(pressBlocked.status).toBe("unreachable");
    expect(pressBlocked.blockedReason).toBe("pressure");
    expect(pressBlocked.maxFeasibleMinPressurePa).toBeDefined();
    expect(pressBlocked.maxFeasibleMinPressurePa).toBeLessThan(strictP);
    expect(pressBlocked.message).toContain("Pa");

    // Relaxing minPressurePa to maxFeasibleMinPressurePa recovers a valid route
    const recoveredP = graph.planRoutes(a, summit, 20, {
      lmstHour: 14,
      lmstLabel: field.lmstLabel,
      minAirTempC: -150,
      minPressurePa: pressBlocked.maxFeasibleMinPressurePa ?? 0,
      thermalWeight: 0.35,
      cellTempK: field.tempK,
      cellPressurePa: field.pressurePa,
    });
    expect(recoveredP.status).toBe("ok");

    // Same for temperature blocking on the summit
    const strictT = Math.round((summitTempC + 1.5) * 10) / 10;
    const tempBlocked = graph.planRoutes(a, summit, 20, {
      lmstHour: 14,
      lmstLabel: field.lmstLabel,
      minAirTempC: strictT,
      minPressurePa: 100,
      thermalWeight: 0.35,
      cellTempK: field.tempK,
      cellPressurePa: field.pressurePa,
    });
    expect(tempBlocked.status).toBe("unreachable");
    expect(tempBlocked.blockedReason).toBe("temperature");
    expect(tempBlocked.maxFeasibleMinTempC).toBeDefined();
    expect(tempBlocked.maxFeasibleMinTempC).toBeLessThan(strictT);
    expect(tempBlocked.message).toContain("C");

    const recoveredT = graph.planRoutes(a, summit, 20, {
      lmstHour: 14,
      lmstLabel: field.lmstLabel,
      minAirTempC: tempBlocked.maxFeasibleMinTempC ?? -150,
      minPressurePa: 100,
      thermalWeight: 0.35,
      cellTempK: field.tempK,
      cellPressurePa: field.pressurePa,
    });
    expect(recoveredT.status).toBe("ok");
  });

  test("warmer afternoon hour lmstHour=14 unlocks route thermally blocked at lmstHour=3", () => {
    const coldField = computeSiteWeatherField(graph, snapshot, 3);
    const warmField = computeSiteWeatherField(graph, snapshot, 14);
    expect(warmField.meanTempC).toBeGreaterThan(coldField.meanTempC + 20);

    const limitC = -75;
    const coldAttempt = graph.planRoutes(a, b, 20, {
      lmstHour: 3,
      lmstLabel: coldField.lmstLabel,
      minAirTempC: limitC,
      minPressurePa: 400,
      thermalWeight: 0.35,
      cellTempK: coldField.tempK,
      cellPressurePa: coldField.pressurePa,
    });
    expect(coldAttempt.status).toBe("unreachable");
    expect(coldAttempt.blockedReason).toBe("temperature");

    const warmAttempt = graph.planRoutes(a, b, 20, {
      lmstHour: 14,
      lmstLabel: warmField.lmstLabel,
      minAirTempC: limitC,
      minPressurePa: 400,
      thermalWeight: 0.35,
      cellTempK: warmField.tempK,
      cellPressurePa: warmField.pressurePa,
    });
    expect(warmAttempt.status).toBe("ok");
    expect(warmAttempt.routes.length).toBeGreaterThanOrEqual(1);
    expect(warmAttempt.routes[0]?.minTempC).toBeGreaterThanOrEqual(limitC);

    // Also verify smooth wrapping beyond 24h when nextSol is present or absent
    const wrappedNoNext = interpolateWeatherAtHour(snapshot, 38);
    expect(wrappedNoNext.lmstHour).toBe(38);
    expect(wrappedNoNext.lmstLabel).toBe("14:00");
    expect(wrappedNoNext.sol).toBe(snapshot.sol + 1);
  });

  test("HTTP pressure, temperature, environment-summary, and weather-constrained route endpoints", async () => {
    const dir = makeTempDir();
    const service = new WeatherService({
      cacheDir: join(dir, "cache"),
      siteWeatherPath: join(dir, "missing.json"),
      enableLiveFetch: false,
    });
    const app = createApp(graph, service);

    const pressureRes = await app.request(
      "/api/site/pressure.png?scenario=nominal&sol=1859&lmstHour=14&minPressurePa=700",
    );
    expect(pressureRes.status).toBe(200);
    expect(pressureRes.headers.get("content-type")).toBe("image/png");
    expect(pressureRes.headers.get("cache-control")).toBe("public, max-age=120");
    expect(pressureRes.headers.get("x-layer-unit")).toBe("Pa");
    expect(pressureRes.headers.get("x-layer-lmst")).toBe("14:00");
    expect(Number.isFinite(Number(pressureRes.headers.get("x-layer-min")))).toBe(true);
    expect(Number.isFinite(Number(pressureRes.headers.get("x-layer-max")))).toBe(true);
    expect(Number.isFinite(Number(pressureRes.headers.get("x-layer-mean")))).toBe(true);
    const pressureBytes = new Uint8Array(await pressureRes.arrayBuffer());
    expect(Array.from(pressureBytes.slice(0, 8))).toEqual(PNG_MAGIC);

    const tempRes = await app.request(
      "/api/site/temperature.png?scenario=nominal&sol=1859&lmstHour=14&minAirTempC=-75",
    );
    expect(tempRes.status).toBe(200);
    expect(tempRes.headers.get("content-type")).toBe("image/png");
    expect(tempRes.headers.get("cache-control")).toBe("public, max-age=120");
    expect(tempRes.headers.get("x-layer-unit")).toBe("C");
    expect(tempRes.headers.get("x-layer-lmst")).toBe("14:00");
    const tempBytes = new Uint8Array(await tempRes.arrayBuffer());
    expect(Array.from(tempBytes.slice(0, 8))).toEqual(PNG_MAGIC);

    const summaryRes = await app.request(
      "/api/site/environment-summary?scenario=nominal&sol=1859&lmstHour=14",
    );
    expect(summaryRes.status).toBe(200);
    const summary = (await summaryRes.json()) as SiteEnvironmentSummary;
    expect(summary.siteId).toBe("jezero");
    expect(summary.sol).toBe(1859);
    expect(summary.lmstHour).toBe(14);
    expect(summary.lmstLabel).toBe("14:00");
    expect(summary.scenario).toBe("nominal");
    expect(summary.isSimulated).toBe(true);
    expect(summary.minTempC).toBeLessThanOrEqual(summary.meanTempC);
    expect(summary.meanTempC).toBeLessThanOrEqual(summary.maxTempC);
    expect(summary.minPressurePa).toBeLessThanOrEqual(summary.meanPressurePa);
    expect(summary.meanPressurePa).toBeLessThanOrEqual(summary.maxPressurePa);

    // Weather-constrained POST /api/graph/routes: cold at 03:00 -> unreachable, warm at 14:00 -> ok
    const coldRouteRes = await app.request("/api/graph/routes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        waypointA: a,
        waypointB: b,
        maxSlopeDeg: 20,
        weatherConstraints: {
          enabled: true,
          scenario: "nominal",
          sol: 1859,
          lmstHour: 3,
          minAirTempC: -75,
          minPressurePa: 400,
        },
      }),
    });
    expect(coldRouteRes.status).toBe(200);
    const coldBody = (await coldRouteRes.json()) as RoutePlanResponse;
    expect(coldBody.status).toBe("unreachable");
    expect(coldBody.blockedReason).toBe("temperature");
    expect(coldBody.weatherApplied).toBe(true);

    const warmRouteRes = await app.request("/api/graph/routes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        waypointA: a,
        waypointB: b,
        maxSlopeDeg: 20,
        weatherConstraints: {
          enabled: true,
          scenario: "nominal",
          sol: 1859,
          lmstHour: 14,
          minAirTempC: -75,
          minPressurePa: 400,
          thermalWeight: 0.35,
        },
      }),
    });
    expect(warmRouteRes.status).toBe(200);
    const warmBody = (await warmRouteRes.json()) as RoutePlanResponse;
    expect(warmBody.status).toBe("ok");
    expect(warmBody.weatherApplied).toBe(true);
    expect(warmBody.appliedLmstHour).toBe(14);
    expect(warmBody.routes[0]?.points[0]?.tempC).toBeDefined();
    expect(warmBody.routes[0]?.points[0]?.pressurePa).toBeDefined();

    // Validation errors return 400
    const badScenario = await app.request("/api/site/pressure.png?scenario=invalid");
    expect(badScenario.status).toBe(400);
    const badWc = await app.request("/api/graph/routes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        waypointA: a,
        waypointB: b,
        maxSlopeDeg: 20,
        weatherConstraints: { enabled: true, lmstHour: 99 },
      }),
    });
    expect(badWc.status).toBe(400);
  });
});

function makeGrid(
  rows: number,
  cols: number,
  elevationsM: number[],
  nodataValue = -99999,
): SiteDataset {
  return {
    meta: {
      ...makeRidgeDataset().meta,
      rows,
      cols,
      bbox: [0, 0, (cols - 1) * 0.001, (rows - 1) * 0.001],
      nodataValue,
    },
    elevationsM,
  };
}

function weatherFor(graph: TerrainGraph, pressure: number[], temperature?: number[]) {
  return {
    lmstHour: 12,
    minAirTempC: -150,
    minPressurePa: 600,
    cellTempK: Float32Array.from(temperature ?? Array(graph.totalCells).fill(250)),
    cellPressurePa: Float32Array.from(pressure),
  };
}

describe("Terrain graph safety and search correctness", () => {
  test("nodata is a sentinel, not an elevation cutoff", () => {
    const graph = new TerrainGraph(makeGrid(1, 4, [-20, -5, 0, 10], 0));
    expect(Array.from(graph.getValidMask())).toEqual([1, 1, 0, 1]);
    const decimal = new TerrainGraph(makeGrid(1, 2, [-9999.9, 0], -9999.9));
    expect(Array.from(decimal.getValidMask())).toEqual([0, 1]);
  });

  test("missing endpoints and interpolation samples cannot silently snap across nodata", () => {
    const graph = new TerrainGraph(makeGrid(2, 2, [0, -99999, 0, 0]));
    const result = graph.planRoutes(graph.coordForCell(0, 1), graph.coordForCell(1, 1), 10);
    expect(result.status).toBe("unreachable");
    expect(result.blockedReason).toBe("nodata");
    expect(graph.elevationAt(graph.coordForCell(0, 0))).toBe(0);
    expect(graph.elevationAt({ lat: 0.0009, lon: 0.0001 })).toBeNull();
  });

  test("diagonal nodata corners disconnect A* and minimax", () => {
    const graph = new TerrainGraph(makeGrid(2, 2, [0, -99999, -99999, 0]));
    const result = graph.planRoutes(graph.coordForCell(0, 0), graph.coordForCell(1, 1), 89);
    expect(result.status).toBe("unreachable");
    expect(result.blockedReason).toBe("nodata");
    expect(result.minRequiredSlopeDeg).toBeUndefined();
    expect(result.passableEdgeRatio).toBe(0);
  });

  test("diagonals cannot bypass cardinal slope barriers, and minimax returns a usable limit", () => {
    const graph = new TerrainGraph(makeGrid(2, 2, [0, 100, 100, 0]));
    const a = graph.coordForCell(0, 0);
    const b = graph.coordForCell(1, 1);
    const blocked = graph.planRoutes(a, b, 10);
    expect(blocked.status).toBe("unreachable");
    expect(blocked.blockedReason).toBe("slope");
    expect(blocked.passableEdgeRatio).toBe(0);
    const required = blocked.minRequiredSlopeDeg;
    if (required === undefined) throw new Error("Expected a slope limit");
    expect(required).toBeGreaterThan(50);
    expect(graph.planRoutes(a, b, required).status).toBe("ok");
    expect(graph.planRoutes(a, b, required - 0.1).status).toBe("unreachable");
  });

  test("minimax does not round an intermediate slope down before reporting its limit", () => {
    const dataset = makeGrid(1, 3, [0, 10, 10]);
    const base = new TerrainGraph(dataset);
    const targetSpacing = 10 / Math.tan((10.0000001 * Math.PI) / 180);
    dataset.meta.bbox = [0, 0, (0.002 * targetSpacing) / base.dxM, 0];
    const graph = new TerrainGraph(dataset);
    const a = graph.coordForCell(0, 0);
    const b = graph.coordForCell(0, 2);
    const result = graph.planRoutes(a, b, 9);
    expect(result.minRequiredSlopeDeg).toBe(10.1);
    expect(graph.planRoutes(a, b, result.minRequiredSlopeDeg ?? 0).status).toBe("ok");
  });

  test("A* finds the octile shortest path on a rectangular grid across repeated queries", () => {
    const dataset = makeGrid(4, 6, Array(24).fill(0));
    dataset.meta.bbox = [0, 0, 0.01, 0.003];
    const graph = new TerrainGraph(dataset);
    const a = graph.coordForCell(0, 0);
    const b = graph.coordForCell(3, 5);
    const expectedDistance = 3 * graph.diagM + 2 * graph.dxM;
    for (const [start, end] of [
      [a, b],
      [b, a],
      [a, b],
    ] as const) {
      const route = graph.planRoutes(start, end, 0).routes[0];
      expect(route?.totalDistanceM).toBe(Math.round(expectedDistance * 10) / 10);
      expect(route?.points).toHaveLength(6);
    }
  });

  test("zero slope is respected and nonfinite safety limits are rejected", () => {
    const graph = new TerrainGraph(makeGrid(1, 2, [0, 0.1]));
    const a = graph.coordForCell(0, 0);
    const b = graph.coordForCell(0, 1);
    expect(graph.planRoutes(a, b, 0).status).toBe("unreachable");
    expect(() => graph.planRoutes(a, b, Number.NaN)).toThrow("finite");
    expect(() =>
      graph.planRoutes(a, b, 10, {
        ...weatherFor(graph, [900, 900]),
        thermalWeight: Number.NaN,
      }),
    ).toThrow("finite");
  });

  test("zero-slope overlays leave flats clear and mark nonzero slopes", () => {
    const flat = new TerrainGraph(makeGrid(1, 2, [0, 0]));
    const slope = new TerrainGraph(makeGrid(1, 2, [0, 0.1]));
    expect(flat.renderSlopeMaskPng(0)).toEqual(flat.renderSlopeMaskPng(0.5));
    expect(slope.renderSlopeMaskPng(0)).not.toEqual(slope.renderSlopeMaskPng(0.5));
    expect(slope.renderSlopeMaskPng(-1)).toEqual(slope.renderSlopeMaskPng(0));
    expect(() => slope.renderSlopeMaskPng(Number.NaN)).toThrow("finite");
  });

  test("weather diagonal clearance and bottlenecks include both side cells", () => {
    const graph = new TerrainGraph(makeGrid(2, 2, [0, 0, 0, 0]));
    const a = graph.coordForCell(0, 0);
    const b = graph.coordForCell(1, 1);
    const filter = weatherFor(graph, [900, 500, 500, 900]);
    const blocked = graph.planRoutes(a, b, 10, filter);
    expect(blocked.status).toBe("unreachable");
    expect(blocked.blockedReason).toBe("pressure");
    expect(blocked.maxFeasibleMinPressurePa).toBe(500);
    expect(graph.planRoutes(a, b, 10, { ...filter, minPressurePa: 500 }).status).toBe("ok");
  });

  test("bottleneck recommendations preserve the other active weather constraint", () => {
    const graph = new TerrainGraph(makeGrid(3, 3, [0, 0, 0, 0, -99999, 0, 0, 0, 0]));
    const a = graph.coordForCell(1, 0);
    const b = graph.coordForCell(1, 2);
    const filter = {
      ...weatherFor(
        graph,
        [400, 400, 400, 900, 900, 900, 800, 800, 800],
        [250, 250, 250, 260, 260, 260, 220, 220, 220],
      ),
      minAirTempC: -33.15,
    };
    const blocked = graph.planRoutes(a, b, 10, filter);
    expect(blocked.status).toBe("unreachable");
    expect(blocked.blockedReason).toBe("combined");
    expect(blocked.maxFeasibleMinPressurePa).toBe(400);
    expect(blocked.maxFeasibleMinTempC).toBeCloseTo(-53.15, 1);
    expect(
      graph.planRoutes(a, b, 10, {
        ...filter,
        minPressurePa: blocked.maxFeasibleMinPressurePa ?? 0,
      }).status,
    ).toBe("ok");
    expect(
      graph.planRoutes(a, b, 10, {
        ...filter,
        minAirTempC: blocked.maxFeasibleMinTempC ?? -150,
      }).status,
    ).toBe("ok");
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "unknown weather value %s blocks traversal",
    (value) => {
      const graph = new TerrainGraph(makeGrid(1, 3, [0, 0, 0]));
      const result = graph.planRoutes(
        graph.coordForCell(0, 0),
        graph.coordForCell(0, 2),
        10,
        weatherFor(graph, [900, value, 900]),
      );
      expect(result.status).toBe("unreachable");
      expect(result.maxFeasibleMinPressurePa).toBeUndefined();
    },
  );

  test("route metrics account for both ascent and descent and handle a stationary route", () => {
    const graph = new TerrainGraph(makeGrid(1, 3, [0, 10, 0]));
    const a = graph.coordForCell(0, 0);
    const route = graph.planRoutes(a, graph.coordForCell(0, 2), 20).routes[0];
    if (!route) throw new Error("Expected route");
    expect(route.elevationGainM).toBe(10);
    expect(route.elevationLossM).toBe(10);
    expect(route.totalDistanceM).toBeCloseTo(graph.dxM * 2, 0);
    expect(route.points.at(-1)?.distanceM).toBe(route.totalDistanceM);
    expect(route.meanSlopeDeg).toBe(route.maxSlopeDeg);
    expect(route.maxSlopeDeg).toBeCloseTo((Math.atan(10 / graph.dxM) * 180) / Math.PI, 2);
    const stationary = graph.planRoutes(a, a, 0).routes[0];
    expect(stationary?.points).toHaveLength(1);
    expect(stationary?.totalDistanceM).toBe(0);
    expect(stationary?.meanSlopeDeg).toBe(0);
  });
});
