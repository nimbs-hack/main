import {
  DEFAULT_EVA_WEATHER_LIMITS,
  type ElevationResponse,
  type MarsCoord,
  type MarsWeatherSnapshot,
  type RoutePlanRequest,
  type RoutePlanResponse,
  type SiteEnvironmentSummary,
  type SiteMetadata,
  TerrainGraph,
  type TerrainWeatherFilter,
  computeSiteWeatherField,
  decodeTerrainBinary,
  renderPressureMaskRgba,
  renderTemperatureMaskRgba,
  toSiteEnvironmentSummary,
} from "@nimbs/shared";

export type WorkerRequest =
  | {
      id: number;
      type: "init";
      meta: SiteMetadata;
      terrainBuffer: ArrayBuffer;
    }
  | {
      id: number;
      type: "elevation";
      coord: MarsCoord;
    }
  | {
      id: number;
      type: "planRoutes";
      payload: RoutePlanRequest;
      snapshot?: MarsWeatherSnapshot;
    }
  | {
      id: number;
      type: "environmentSummary";
      snapshot: MarsWeatherSnapshot;
      lmstHour: number;
    }
  | {
      id: number;
      type: "renderSlopeMask";
      maxSlopeDeg: number;
    }
  | {
      id: number;
      type: "renderPressureMask";
      snapshot: MarsWeatherSnapshot;
      lmstHour: number;
      minPressurePa: number;
    }
  | {
      id: number;
      type: "renderTemperatureMask";
      snapshot: MarsWeatherSnapshot;
      lmstHour: number;
      minAirTempC: number;
    };

export type WorkerResponse =
  | { id: number; ok: true; type: "init"; meta: SiteMetadata }
  | { id: number; ok: true; type: "elevation"; data: ElevationResponse }
  | { id: number; ok: true; type: "planRoutes"; data: RoutePlanResponse }
  | { id: number; ok: true; type: "environmentSummary"; data: SiteEnvironmentSummary }
  | {
      id: number;
      ok: true;
      type: "renderMask";
      cols: number;
      rows: number;
      rgbaBuffer: ArrayBuffer;
    }
  | { id: number; ok: false; error: string };

interface WorkerScopeMinimal {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
}

const workerScope = self as unknown as WorkerScopeMinimal;

let graph: TerrainGraph | null = null;

function requireGraph(): TerrainGraph {
  if (!graph) {
    throw new Error("Terrain graph is not initialized in worker");
  }
  return graph;
}

workerScope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  try {
    switch (req.type) {
      case "init": {
        const expectedCells = req.meta.rows * req.meta.cols;
        const elevationsM = decodeTerrainBinary(req.terrainBuffer, expectedCells);
        graph = new TerrainGraph({ meta: req.meta, elevationsM });
        workerScope.postMessage({ id: req.id, ok: true, type: "init", meta: graph.meta });
        return;
      }

      case "elevation": {
        const activeGraph = requireGraph();
        const insideSite = activeGraph.isInsideBounds(req.coord);
        const elevationM = activeGraph.elevationAt(req.coord);
        workerScope.postMessage({
          id: req.id,
          ok: true,
          type: "elevation",
          data: {
            lat: req.coord.lat,
            lon: req.coord.lon,
            insideSite,
            elevationM,
          },
        });
        return;
      }

      case "planRoutes": {
        const activeGraph = requireGraph();
        const { payload, snapshot } = req;
        const wc = payload.weatherConstraints;
        let weatherFilter: TerrainWeatherFilter | undefined;

        if (wc?.enabled && snapshot) {
          const lmstHour = wc.lmstHour ?? 12;
          const field = computeSiteWeatherField(activeGraph, snapshot, lmstHour);
          weatherFilter = {
            lmstHour: field.lmstHour,
            lmstLabel: field.lmstLabel,
            minAirTempC: wc.minAirTempC ?? DEFAULT_EVA_WEATHER_LIMITS.minAirTempC,
            minPressurePa: wc.minPressurePa ?? DEFAULT_EVA_WEATHER_LIMITS.minPressurePa,
            thermalWeight: wc.thermalWeight ?? 0.35,
            cellTempK: field.tempK,
            cellPressurePa: field.pressurePa,
          };
        }

        const result = activeGraph.planRoutes(
          payload.waypointA,
          payload.waypointB,
          payload.maxSlopeDeg,
          weatherFilter,
        );
        workerScope.postMessage({ id: req.id, ok: true, type: "planRoutes", data: result });
        return;
      }

      case "environmentSummary": {
        const activeGraph = requireGraph();
        const field = computeSiteWeatherField(activeGraph, req.snapshot, req.lmstHour);
        workerScope.postMessage({
          id: req.id,
          ok: true,
          type: "environmentSummary",
          data: toSiteEnvironmentSummary(field),
        });
        return;
      }

      case "renderSlopeMask": {
        const activeGraph = requireGraph();
        const rgba = activeGraph.renderSlopeMaskRgba(req.maxSlopeDeg);
        workerScope.postMessage(
          {
            id: req.id,
            ok: true,
            type: "renderMask",
            cols: activeGraph.cols,
            rows: activeGraph.rows,
            rgbaBuffer: rgba.buffer,
          },
          [rgba.buffer],
        );
        return;
      }

      case "renderPressureMask": {
        const activeGraph = requireGraph();
        const field = computeSiteWeatherField(activeGraph, req.snapshot, req.lmstHour);
        const rgba = renderPressureMaskRgba(activeGraph, field, req.minPressurePa);
        workerScope.postMessage(
          {
            id: req.id,
            ok: true,
            type: "renderMask",
            cols: activeGraph.cols,
            rows: activeGraph.rows,
            rgbaBuffer: rgba.buffer,
          },
          [rgba.buffer],
        );
        return;
      }

      case "renderTemperatureMask": {
        const activeGraph = requireGraph();
        const field = computeSiteWeatherField(activeGraph, req.snapshot, req.lmstHour);
        const rgba = renderTemperatureMaskRgba(activeGraph, field, req.minAirTempC);
        workerScope.postMessage(
          {
            id: req.id,
            ok: true,
            type: "renderMask",
            cols: activeGraph.cols,
            rows: activeGraph.rows,
            rgbaBuffer: rgba.buffer,
          },
          [rgba.buffer],
        );
        return;
      }
    }
  } catch (err: unknown) {
    workerScope.postMessage({
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : "Worker operation failed",
    });
  }
};
