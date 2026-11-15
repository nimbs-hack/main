import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SiteDataset } from "../types";
import {
  decodeSoilBinary,
  decodeTerrainBinary,
  encodeSoilBinary,
  encodeTerrainBinary,
} from "./binary";
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

  test("loads 20x20 km Jezero Crater DEM grid, roundtrips binary, and answers elevation queries", () => {
    if (!dataset) return;
    const graph = new TerrainGraph(dataset);
    const meta = graph.meta;

    expect(meta.rows).toBe(1001);
    expect(meta.cols).toBe(1001);
    expect(meta.widthMeters).toBeGreaterThan(19900);
    expect(meta.widthMeters).toBeLessThan(20100);

    expect(graph.isInsideBounds(meta.center)).toBe(true);
    expect(graph.elevationAt(meta.center)).not.toBeNull();
    expect(graph.soilAt(meta.center)).not.toBeNull();
    expect(dataset.soilTypes?.length).toBe(meta.rows * meta.cols);
    expect(graph.isInsideBounds({ lat: 0, lon: 0 })).toBe(false);
    expect(graph.elevationAt({ lat: 0, lon: 0 })).toBeNull();

    const encoded = encodeTerrainBinary(dataset.elevationsM);
    expect(encoded.byteLength).toBe(meta.rows * meta.cols * 4);
    const decoded = decodeTerrainBinary(encoded.buffer as ArrayBuffer, meta.rows * meta.cols);
    const soilBytes = encodeSoilBinary(dataset.soilTypes ?? []);
    expect(soilBytes.byteLength).toBe(meta.rows * meta.cols);
    const decodedSoil = decodeSoilBinary(soilBytes.buffer as ArrayBuffer, meta.rows * meta.cols);
    const binGraph = new TerrainGraph({ meta, elevationsM: decoded, soilTypes: decodedSoil });
    expect(binGraph.elevationAt(meta.center)).toBeCloseTo(graph.elevationAt(meta.center) ?? 0, 3);
    expect(binGraph.soilAt(meta.center)).toBe(graph.soilAt(meta.center));
  });

  test("plans routes respecting maxSlopeDeg and reports unreachable minimum slope", () => {
    if (!dataset) return;
    const graph = new TerrainGraph(dataset);
    const a = graph.coordForCell(100, 100);
    const b = graph.coordForCell(900, 900);

    const permissive = graph.planRoutes(a, b, 30);
    expect(permissive.status).toBe("ok");
    const first = permissive.routes[0];
    expect(first).toBeDefined();
    if (first) {
      expect(first.totalDistanceM).toBeGreaterThan(15000);
      expect(first.maxSlopeDeg).toBeLessThanOrEqual(30);
      expect(first.points.length).toBeGreaterThan(200);
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

  test("renders passability RGBA overlay and validates static hillshade asset", () => {
    if (!dataset) return;
    const graph = new TerrainGraph(dataset);
    const a = graph.coordForCell(150, 150);
    const b = graph.coordForCell(850, 850);

    const routeBody = graph.planRoutes(a, b, 25);
    expect(routeBody.status).toBe("ok");
    expect(routeBody.routes.length).toBeGreaterThanOrEqual(1);

    const maskRgba = graph.renderSlopeMaskRgba(10);
    expect(maskRgba.byteLength).toBe(graph.totalCells * 4);

    const soilRgba = graph.renderSoilMaskRgba();
    expect(soilRgba.byteLength).toBe(graph.totalCells * 4);

    if (existsSync(HILLSHADE_PNG_PATH)) {
      const hsBytes = new Uint8Array(readFileSync(HILLSHADE_PNG_PATH));
      expect(Array.from(hsBytes.slice(0, 8))).toEqual(PNG_MAGIC);
    }
  });
});
