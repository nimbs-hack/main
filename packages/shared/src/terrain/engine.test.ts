import { describe, expect, test } from "bun:test";
import type { MarsWeatherSnapshot, SiteDataset } from "../types";
import { generateMartianWeather } from "../weather/generator";
import { decodeTerrainBinary, encodeTerrainBinary } from "./binary";
import { TerrainGraph } from "./engine";
import {
  computeSiteWeatherField,
  interpolateWeatherAtHour,
  renderPressureMaskRgba,
  renderTemperatureMaskRgba,
  toSiteEnvironmentSummary,
} from "./weatherField";

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

  test("client slope mask RGBA renders hazardous pixels and binary terrain roundtrips cleanly", () => {
    const rgba = graph.renderSlopeMaskRgba(10);
    expect(rgba.byteLength).toBe(graph.totalCells * 4);
    let nonZeroAlpha = 0;
    for (let i = 3; i < rgba.length; i += 4) {
      if ((rgba[i] ?? 0) > 0) nonZeroAlpha += 1;
    }
    expect(nonZeroAlpha).toBeGreaterThan(0);

    const encoded = encodeTerrainBinary(graph.elevations);
    const decoded = decodeTerrainBinary(encoded.buffer as ArrayBuffer, graph.totalCells);
    expect(decoded.length).toBe(graph.totalCells);
    expect(decoded[0]).toBeCloseTo(graph.elevations[0] ?? 0, 5);
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

  test("client pressure, temperature RGBA masks and environment summary stay consistent", () => {
    const snapshot = generateMartianWeather({
      site: "jezero",
      scenario: "nominal",
      sol: 1859,
      siteMeta: graph.meta,
    });
    const field = computeSiteWeatherField(graph, snapshot, 14);

    const pressureRgba = renderPressureMaskRgba(graph, field, 700);
    expect(pressureRgba.byteLength).toBe(graph.totalCells * 4);
    expect(pressureRgba[3]).toBeGreaterThan(0);

    const tempRgba = renderTemperatureMaskRgba(graph, field, -75);
    expect(tempRgba.byteLength).toBe(graph.totalCells * 4);
    expect(tempRgba[3]).toBeGreaterThan(0);

    const summary = toSiteEnvironmentSummary(field);
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

    // Cold night field at 03:00 -> unreachable by temperature
    const coldField = computeSiteWeatherField(graph, snapshot, 3);
    const coldRes = graph.planRoutes(a, b, 20, {
      lmstHour: coldField.lmstHour,
      lmstLabel: coldField.lmstLabel,
      minAirTempC: -75,
      minPressurePa: 400,
      cellTempK: coldField.tempK,
      cellPressurePa: coldField.pressurePa,
    });
    expect(coldRes.status).toBe("unreachable");
    expect(coldRes.blockedReason).toBe("temperature");
    expect(coldRes.weatherApplied).toBe(true);

    // Warm afternoon field at 14:00 -> navigable with thermal metrics attached
    const warmRes = graph.planRoutes(a, b, 20, {
      lmstHour: field.lmstHour,
      lmstLabel: field.lmstLabel,
      minAirTempC: -75,
      minPressurePa: 400,
      thermalWeight: 0.35,
      cellTempK: field.tempK,
      cellPressurePa: field.pressurePa,
    });
    expect(warmRes.status).toBe("ok");
    expect(warmRes.weatherApplied).toBe(true);
    expect(warmRes.appliedLmstHour).toBe(14);
    expect(warmRes.routes[0]?.points[0]?.tempC).toBeDefined();
    expect(warmRes.routes[0]?.points[0]?.pressurePa).toBeDefined();
  });
});
