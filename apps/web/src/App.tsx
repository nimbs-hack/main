import {
  DEFAULT_MARS_BASE_LAYER,
  type LonFormat,
  MARS_BASE_LAYERS,
  type MarsCoord,
  type MissionUnitId,
  type RoutePlanResponse,
  type RoutePoint,
  type SiteMetadata,
  lon180To360,
} from "@nimbs/shared";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ContextMenu } from "./components/ContextMenu";
import { DualSimulationPanel } from "./components/DualSimulationPanel";
import { type MapUnitDisplay, MapView } from "./components/MapView";
import { PointsPanel } from "./components/PointsPanel";
import { RoutePlannerPanel } from "./components/RoutePlannerPanel";
import {
  clampSimLmstHour,
  estimateLocalWeatherAtElevation,
  formatLmstClock,
  resolveSolDisplay,
} from "./components/TimeSimulationControl";
import { WeatherPanel, evaStatusClass } from "./components/WeatherPanel";
import { ToolRegistry } from "./registry/toolRegistry";
import {
  type ComputedRoute,
  DEFAULT_HUMAN_SOIL_SPEED_FACTORS,
  type EvaRouteWeatherContext,
  type EvaWeatherEvaluation,
  type EvaWeatherLimits,
  type MarsWeatherSnapshot,
  SOIL_TYPE_CATALOG,
  SOIL_TYPE_ORDER,
  type SiteEnvironmentSummary,
  type SoilTypeId,
  TRAVERSE_PRESETS,
  type TraversePointSample,
  type TraversePresetId,
  type UiMode,
  type WeatherScenario,
  buildUnitTraverseTimeline,
  evaluateWeatherConstraints,
  fetchBaseLayers,
  fetchElevation,
  fetchEnvironmentSummary,
  fetchSiteMeta,
  fetchWeatherSnapshot,
  findBestWaypointInsertIndex,
  planGraphRoutes,
  resolveSoilSpeedFactors,
} from "./services/api";
import {
  type PersistedUnitMissionState,
  loadMissionState,
  saveMissionState,
} from "./services/browserCache";
import { UNIT_ACCENT_COLORS, buildDualSimBundle, evaluateDualSimFrame } from "./services/dualSim";
import {
  type MapPoint,
  type MapPointClass,
  type PointIconKey,
  createCustomPointClass,
  createMapPoint,
  filterVisiblePoints,
  loadPointState,
  savePointState,
  setAllClassesVisible,
  toggleClassVisibility,
} from "./services/pointStore";

function formatLon(lonDeg: number, fmt: LonFormat): string {
  const val = fmt === "360" ? lon180To360(lonDeg) : lonDeg;
  return `${val.toFixed(5)}°`;
}

const DEFAULT_THERMAL_WEIGHT = 0.35;
const EMPTY_ROUTES: ComputedRoute[] = [];

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function cloneWeatherLimits(limits: EvaWeatherLimits): EvaWeatherLimits {
  return {
    ...limits,
    soilSpeedFactors: resolveSoilSpeedFactors(
      limits.soilSpeedFactors,
      DEFAULT_HUMAN_SOIL_SPEED_FACTORS,
    ),
  };
}

interface UnitMissionState {
  id: MissionUnitId;
  presetId: TraversePresetId;
  maxSlopeDeg: number;
  weatherRoutingEnabled: boolean;
  weatherLimits: EvaWeatherLimits;
  waypoints: MarsCoord[];
  routePlan: RoutePlanResponse | null;
  selectedRouteId: string | null;
  routingBusy: boolean;
  weatherEval: EvaWeatherEvaluation | null;
  weatherError: string | null;
}

function createInitialUnitState(
  id: MissionUnitId,
  presetIdOrPersisted: TraversePresetId | PersistedUnitMissionState,
): UnitMissionState {
  if (typeof presetIdOrPersisted === "string") {
    const preset = TRAVERSE_PRESETS[presetIdOrPersisted];
    return {
      id,
      presetId: presetIdOrPersisted,
      maxSlopeDeg: preset.maxSlopeDeg,
      weatherRoutingEnabled: true,
      weatherLimits: cloneWeatherLimits(preset.limits),
      waypoints: [],
      routePlan: null,
      selectedRouteId: null,
      routingBusy: false,
      weatherEval: null,
      weatherError: null,
    };
  }
  return {
    id,
    presetId: presetIdOrPersisted.presetId,
    maxSlopeDeg: presetIdOrPersisted.maxSlopeDeg,
    weatherRoutingEnabled: presetIdOrPersisted.weatherRoutingEnabled,
    weatherLimits: cloneWeatherLimits(presetIdOrPersisted.weatherLimits),
    waypoints: presetIdOrPersisted.waypoints,
    routePlan: null,
    selectedRouteId: presetIdOrPersisted.selectedRouteId,
    routingBusy: false,
    weatherEval: null,
    weatherError: null,
  };
}

function resolveSelectedRoute(unit: UnitMissionState): ComputedRoute | null {
  return (
    unit.routePlan?.routes.find((r) => r.id === unit.selectedRouteId) ??
    unit.routePlan?.routes[0] ??
    null
  );
}

function buildRouteWeatherContext(route: ComputedRoute | null): EvaRouteWeatherContext | undefined {
  if (!route) return undefined;
  let minElevationM = Number.POSITIVE_INFINITY;
  let maxElevationM = Number.NEGATIVE_INFINITY;
  for (const pt of route.points) {
    if (pt.elevationM < minElevationM) minElevationM = pt.elevationM;
    if (pt.elevationM > maxElevationM) maxElevationM = pt.elevationM;
  }
  return {
    totalDistanceM: route.totalDistanceM,
    elevationGainM: route.elevationGainM,
    elevationLossM: route.elevationLossM,
    minElevationM: Number.isFinite(minElevationM) ? minElevationM : undefined,
    maxElevationM: Number.isFinite(maxElevationM) ? maxElevationM : undefined,
    soilBreakdown: route.soilBreakdown,
    points: sampleRoutePoints(route.points, 80),
  };
}

type UnitPatchUpdater = (
  updater: Partial<UnitMissionState> | ((prev: UnitMissionState) => UnitMissionState),
) => void;

function useUnitMissionSync(
  unit: UnitMissionState,
  updateUnit: UnitPatchUpdater,
  env: {
    siteId?: string;
    weatherScenario: WeatherScenario;
    simLmstHour: number;
    weatherSnapshotRef: RefObject<MarsWeatherSnapshot | null>;
    weatherSnapshotRev: number;
  },
): ComputedRoute | null {
  const { siteId, weatherScenario, simLmstHour, weatherSnapshotRef, weatherSnapshotRev } = env;

  useEffect(() => {
    const wps = unit.waypoints;
    if (wps.length < 2) {
      updateUnit({ routePlan: null, selectedRouteId: null, routingBusy: false });
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      updateUnit({ routingBusy: true });
      planGraphRoutes(
        {
          waypoints: wps,
          maxSlopeDeg: unit.maxSlopeDeg,
          soilSpeedFactors: unit.weatherLimits.soilSpeedFactors,
          weatherConstraints: {
            enabled: unit.weatherRoutingEnabled,
            scenario: weatherScenario,
            sol: weatherSnapshotRef.current?.sol,
            lmstHour: simLmstHour,
            minAirTempC: unit.weatherLimits.minAirTempC,
            minPressurePa: unit.weatherLimits.minPressurePa,
            thermalWeight: DEFAULT_THERMAL_WEIGHT,
          },
        },
        controller.signal,
      )
        .then((res) => {
          if (cancelled) return;
          updateUnit((prev) => ({
            ...prev,
            routePlan: res,
            selectedRouteId: res.routes.some((r) => r.id === prev.selectedRouteId)
              ? prev.selectedRouteId
              : (res.routes[0]?.id ?? null),
          }));
        })
        .catch((err: unknown) => {
          if (cancelled || isAbortError(err)) return;
          updateUnit({
            routePlan: {
              status: "unreachable",
              maxSlopeDeg: unit.maxSlopeDeg,
              passableEdgeRatio: 0,
              routes: [],
              message: err instanceof Error ? err.message : "Route request failed",
            },
          });
        })
        .finally(() => {
          if (!cancelled) updateUnit({ routingBusy: false });
        });
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    unit.waypoints,
    unit.maxSlopeDeg,
    unit.weatherLimits.soilSpeedFactors,
    unit.weatherRoutingEnabled,
    unit.weatherLimits.minAirTempC,
    unit.weatherLimits.minPressurePa,
    weatherScenario,
    simLmstHour,
    weatherSnapshotRef,
    updateUnit,
  ]);

  const selectedRoute = useMemo(() => resolveSelectedRoute(unit), [unit]);
  const routeContext = useMemo(() => buildRouteWeatherContext(selectedRoute), [selectedRoute]);

  useEffect(() => {
    const snapshot = weatherSnapshotRef.current;
    if (!snapshot || weatherSnapshotRev === 0) return;
    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      evaluateWeatherConstraints(
        {
          limits: unit.weatherLimits,
          site: siteId,
          scenario: weatherScenario,
          lmstHour: simLmstHour,
          route: routeContext,
          weather: snapshot,
        },
        controller.signal,
      )
        .then((res) => {
          if (cancelled) return;
          updateUnit({ weatherEval: res.evaluation, weatherError: null });
        })
        .catch((err: unknown) => {
          if (cancelled || isAbortError(err)) return;
          updateUnit({
            weatherError: err instanceof Error ? err.message : "Weather evaluation failed",
          });
        });
    }, 80);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    unit.weatherLimits,
    routeContext,
    siteId,
    weatherScenario,
    simLmstHour,
    weatherSnapshotRev,
    weatherSnapshotRef,
    updateUnit,
  ]);

  return selectedRoute;
}

function sampleRoutePoints(points: RoutePoint[], maxSamples = 80): TraversePointSample[] {
  if (points.length === 0) return [];
  if (points.length <= maxSamples) {
    return points.map((pt) => ({
      distanceM: pt.distanceM,
      elevationM: pt.elevationM,
      slopeDeg: pt.slopeDeg,
      lat: pt.lat,
      lon: pt.lon,
      soilType: pt.soilType,
      soilSpeedFactor: pt.soilSpeedFactor,
    }));
  }

  const sampled: TraversePointSample[] = [];
  const step = (points.length - 1) / (maxSamples - 1);
  let lastIdx = -1;
  for (let i = 0; i < maxSamples; i += 1) {
    const idx = i === maxSamples - 1 ? points.length - 1 : Math.round(i * step);
    if (idx === lastIdx) continue;
    lastIdx = idx;
    const pt = points[idx];
    if (!pt) continue;
    sampled.push({
      distanceM: pt.distanceM,
      elevationM: pt.elevationM,
      slopeDeg: pt.slopeDeg,
      lat: pt.lat,
      lon: pt.lon,
      soilType: pt.soilType,
      soilSpeedFactor: pt.soilSpeedFactor,
    });
  }
  return sampled;
}

export function App() {
  const initialMissionState = useMemo(() => loadMissionState(), []);

  const [site, setSite] = useState<SiteMetadata | null>(null);
  const [siteError, setSiteError] = useState<string | null>(null);
  const [layers, setLayers] = useState([...MARS_BASE_LAYERS]);
  const [activeLayerId, setActiveLayerId] = useState(initialMissionState.activeLayerId);
  const [showHillshade, setShowHillshade] = useState(initialMissionState.showHillshade);
  const [showSoilLayer, setShowSoilLayer] = useState(initialMissionState.showSoilLayer);
  const [showSlopeHazard, setShowSlopeHazard] = useState(initialMissionState.showSlopeHazard);
  const [showPressureLayer, setShowPressureLayer] = useState(initialMissionState.showPressureLayer);
  const [showTemperatureLayer, setShowTemperatureLayer] = useState(
    initialMissionState.showTemperatureLayer,
  );
  const [showSiteBounds, setShowSiteBounds] = useState(initialMissionState.showSiteBounds);

  const [uiMode, setUiMode] = useState<UiMode>(initialMissionState.uiMode);
  const [activeUnitId, setActiveUnitId] = useState<MissionUnitId>(initialMissionState.activeUnitId);
  const [unit1, setUnit1] = useState<UnitMissionState>(() =>
    createInitialUnitState(1, initialMissionState.unit1),
  );
  const [unit2, setUnit2] = useState<UnitMissionState>(() =>
    createInitialUnitState(2, initialMissionState.unit2),
  );
  const [activeToolId, setActiveToolId] = useState(
    initialMissionState.activeToolId === "settings" ? "route" : initialMissionState.activeToolId,
  );
  const [panelOpen, setPanelOpen] = useState(initialMissionState.panelOpen);
  const lonFormat: LonFormat = initialMissionState.lonFormat;

  const [hoveredProfilePoint, setHoveredProfilePoint] = useState<RoutePoint | null>(null);
  const [moveWaypointsMode, setMoveWaypointsMode] = useState(initialMissionState.moveWaypointsMode);
  const [dualSimElapsedHours, setDualSimElapsedHours] = useState(0);
  const [dualSimPlaying, setDualSimPlaying] = useState(false);
  const [dualSimSpeedMultiplier, setDualSimSpeedMultiplier] = useState(
    initialMissionState.dualSimSpeedMultiplier,
  );
  const [simDepartureLmstHour, setSimDepartureLmstHour] = useState(
    initialMissionState.simDepartureLmstHour,
  );

  const [cursorCoord, setCursorCoord] = useState<MarsCoord | null>(null);
  const [cursorElevM, setCursorElevM] = useState<number | null>(null);
  const [cursorSoilType, setCursorSoilType] = useState<SoilTypeId | null>(null);
  const [scaleHud, setScaleHud] = useState({ label: "500 m", widthPx: 80, zoom: 13 });
  const [focusCount, setFocusCount] = useState(0);
  const [zoomTrigger, setZoomTrigger] = useState<{ delta: number; seq: number } | null>(null);

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    coord: MarsCoord;
  } | null>(null);

  const initialPointState = useMemo(() => loadPointState(), []);
  const [pointClasses, setPointClasses] = useState<MapPointClass[]>(initialPointState.classes);
  const [points, setPoints] = useState<MapPoint[]>(initialPointState.points);
  const [hiddenClassIds, setHiddenClassIds] = useState<string[]>(initialPointState.hiddenClassIds);
  const [showPointsOverlay, setShowPointsOverlay] = useState(initialMissionState.showPointsOverlay);
  const [pendingPointCoord, setPendingPointCoord] = useState<MarsCoord | null>(null);
  const [pendingPointElevM, setPendingPointElevM] = useState<number | null>(null);
  const [editingPoint, setEditingPoint] = useState<MapPoint | null>(null);
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null);
  const [focusPointTrigger, setFocusPointTrigger] = useState<{
    coord: MarsCoord;
    seq: number;
  } | null>(null);

  const [simLmstHour, setSimLmstHour] = useState(initialMissionState.simLmstHour);
  const [isPlayingTime, setIsPlayingTime] = useState(false);
  const [weatherScenario, setWeatherScenario] = useState<WeatherScenario>(
    initialMissionState.weatherScenario,
  );
  const [weatherSnapshot, setWeatherSnapshot] = useState<MarsWeatherSnapshot | null>(null);
  const [weatherSnapshotRev, setWeatherSnapshotRev] = useState(0);
  const [weatherBusy, setWeatherBusy] = useState(false);
  const [weatherError, setWeatherError] = useState<string | null>(null);
  const [envSummary, setEnvSummary] = useState<SiteEnvironmentSummary | null>(null);

  const weatherSnapshotRef = useRef<MarsWeatherSnapshot | null>(null);
  const simLmstHourRef = useRef(simLmstHour);
  simLmstHourRef.current = simLmstHour;

  const patchUnit1 = useCallback<UnitPatchUpdater>((updater) => {
    setUnit1((prev) => (typeof updater === "function" ? updater(prev) : { ...prev, ...updater }));
  }, []);

  const patchUnit2 = useCallback<UnitPatchUpdater>((updater) => {
    setUnit2((prev) => (typeof updater === "function" ? updater(prev) : { ...prev, ...updater }));
  }, []);

  const patchUnitById = useCallback(
    (
      id: MissionUnitId,
      updater: Partial<UnitMissionState> | ((prev: UnitMissionState) => UnitMissionState),
    ) => {
      if (id === 1) patchUnit1(updater);
      else patchUnit2(updater);
    },
    [patchUnit1, patchUnit2],
  );

  const activeUnit = activeUnitId === 1 ? unit1 : unit2;
  const patchActiveUnit = useCallback<UnitPatchUpdater>(
    (updater) => {
      patchUnitById(activeUnitId, updater);
    },
    [activeUnitId, patchUnitById],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      saveMissionState({
        version: 2,
        activeLayerId,
        showHillshade,
        showSoilLayer,
        showSlopeHazard,
        showPressureLayer,
        showTemperatureLayer,
        showSiteBounds,
        showPointsOverlay,
        uiMode,
        activeUnitId,
        activeToolId,
        panelOpen,
        lonFormat,
        simLmstHour,
        weatherScenario,
        moveWaypointsMode,
        dualSimSpeedMultiplier,
        simDepartureLmstHour,
        unit1: {
          presetId: unit1.presetId,
          maxSlopeDeg: unit1.maxSlopeDeg,
          weatherRoutingEnabled: unit1.weatherRoutingEnabled,
          weatherLimits: unit1.weatherLimits,
          waypoints: unit1.waypoints,
          selectedRouteId: unit1.selectedRouteId,
        },
        unit2: {
          presetId: unit2.presetId,
          maxSlopeDeg: unit2.maxSlopeDeg,
          weatherRoutingEnabled: unit2.weatherRoutingEnabled,
          weatherLimits: unit2.weatherLimits,
          waypoints: unit2.waypoints,
          selectedRouteId: unit2.selectedRouteId,
        },
      });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [
    activeLayerId,
    showHillshade,
    showSoilLayer,
    showSlopeHazard,
    showPressureLayer,
    showTemperatureLayer,
    showSiteBounds,
    showPointsOverlay,
    uiMode,
    activeUnitId,
    activeToolId,
    panelOpen,
    lonFormat,
    simLmstHour,
    weatherScenario,
    moveWaypointsMode,
    dualSimSpeedMultiplier,
    simDepartureLmstHour,
    unit1.presetId,
    unit1.maxSlopeDeg,
    unit1.weatherRoutingEnabled,
    unit1.weatherLimits,
    unit1.waypoints,
    unit1.selectedRouteId,
    unit2.presetId,
    unit2.maxSlopeDeg,
    unit2.weatherRoutingEnabled,
    unit2.weatherLimits,
    unit2.waypoints,
    unit2.selectedRouteId,
  ]);

  useEffect(() => {
    savePointState({
      classes: pointClasses,
      points,
      hiddenClassIds,
    });
  }, [pointClasses, points, hiddenClassIds]);

  // Simulation time playback: 0.5h every 600ms, wrapping cleanly at 48h
  useEffect(() => {
    if (!isPlayingTime) return;
    const timer = window.setInterval(() => {
      setSimLmstHour((prev) => {
        const next = prev + 0.5;
        return next >= 48 ? 0 : Math.round(next * 2) / 2;
      });
    }, 600);
    return () => window.clearInterval(timer);
  }, [isPlayingTime]);

  const handleChangeSimHour = useCallback((nextHour: number) => {
    setSimLmstHour(clampSimLmstHour(nextHour));
  }, []);

  const handleJumpSimHour = useCallback((nextHour: number) => {
    setIsPlayingTime(false);
    setSimLmstHour(clampSimLmstHour(nextHour));
  }, []);

  const handleTogglePlayTime = useCallback(() => {
    setIsPlayingTime((v) => !v);
  }, []);

  // Load initial site metadata & layer definitions
  useEffect(() => {
    fetchSiteMeta()
      .then((meta) => setSite(meta))
      .catch((err: unknown) => {
        setSiteError(err instanceof Error ? err.message : "Failed to load site data");
      });

    fetchBaseLayers()
      .then((list) => {
        if (list.length > 0) setLayers(list);
      })
      .catch(() => {
        // Fallback to shared constant list
      });
  }, []);

  const siteLabels = useMemo(() => {
    const wKm = site ? Math.round(site.widthMeters / 100) / 10 : 20;
    const hKm = site ? Math.round(site.heightMeters / 100) / 10 : 20;
    const compactW = Math.round(wKm);
    const compactH = Math.round(hKm);
    const sizeCompact = `${compactW}x${compactH}`;
    const sizeUpper = `${compactW}X${compactH} KM`;
    const sizeExact = `${wKm.toFixed(1)} x ${hKm.toFixed(1)} KM`;
    const isCtx = site?.sourceTitle.includes("CTX") ?? true;
    const isHirise = site?.sourceTitle.includes("HiRISE") ?? false;
    const sourceLabel = isCtx ? "MRO CTX" : isHirise ? "HiRISE" : "local DEM";
    const sourceUpper = isCtx ? "CTX" : isHirise ? "HIRISE" : "DEM";
    return { sizeCompact, sizeUpper, sizeExact, sourceLabel, sourceUpper };
  }, [site]);

  // Debounced elevation readout for cursor inside local terrain bounds
  const elevTimerRef = useRef<number | null>(null);
  const handleCursorMove = useCallback(
    (coord: MarsCoord | null) => {
      setCursorCoord(coord);
      if (!coord || !site) {
        setCursorElevM(null);
        setCursorSoilType(null);
        return;
      }
      const [west, south, east, north] = site.bbox;
      if (coord.lat < south || coord.lat > north || coord.lon < west || coord.lon > east) {
        setCursorElevM(null);
        setCursorSoilType(null);
        return;
      }
      if (elevTimerRef.current !== null) {
        window.clearTimeout(elevTimerRef.current);
      }
      elevTimerRef.current = window.setTimeout(() => {
        fetchElevation(coord.lat, coord.lon)
          .then((res) => {
            setCursorElevM(res.elevationM);
            setCursorSoilType(res.soilType ?? null);
          })
          .catch(() => {
            setCursorElevM(null);
            setCursorSoilType(null);
          });
      }, 45);
    },
    [site],
  );

  const selectedRoute1 = useUnitMissionSync(unit1, patchUnit1, {
    siteId: site?.id,
    weatherScenario,
    simLmstHour,
    weatherSnapshotRef,
    weatherSnapshotRev,
  });

  const selectedRoute2 = useUnitMissionSync(unit2, patchUnit2, {
    siteId: site?.id,
    weatherScenario,
    simLmstHour,
    weatherSnapshotRef,
    weatherSnapshotRev,
  });

  const activeSelectedRoute = activeUnitId === 1 ? selectedRoute1 : selectedRoute2;

  const timeline1 = useMemo(
    () =>
      selectedRoute1
        ? buildUnitTraverseTimeline(
            1,
            selectedRoute1,
            unit1.weatherLimits,
            unit1.weatherEval?.estimatedRouteHours,
          )
        : null,
    [selectedRoute1, unit1.weatherLimits, unit1.weatherEval?.estimatedRouteHours],
  );

  const timeline2 = useMemo(
    () =>
      selectedRoute2
        ? buildUnitTraverseTimeline(
            2,
            selectedRoute2,
            unit2.weatherLimits,
            unit2.weatherEval?.estimatedRouteHours,
          )
        : null,
    [selectedRoute2, unit2.weatherLimits, unit2.weatherEval?.estimatedRouteHours],
  );

  const dualSimBundle = useMemo(
    () =>
      buildDualSimBundle({
        timeline1,
        timeline2,
        departureLmstHour: simDepartureLmstHour,
        weather: weatherSnapshot,
        sampleCount: 72,
      }),
    [timeline1, timeline2, simDepartureLmstHour, weatherSnapshot],
  );

  const effectiveDualElapsed =
    dualSimBundle.totalDurationHours > 0
      ? Math.max(0, Math.min(dualSimBundle.totalDurationHours, dualSimElapsedHours))
      : 0;

  useEffect(() => {
    setDualSimElapsedHours((prev) =>
      dualSimBundle.totalDurationHours > 0 ? Math.min(prev, dualSimBundle.totalDurationHours) : 0,
    );
  }, [dualSimBundle.totalDurationHours]);

  useEffect(() => {
    if (!dualSimPlaying || dualSimBundle.totalDurationHours <= 0) return;
    const total = dualSimBundle.totalDurationHours;
    const timer = window.setInterval(() => {
      setDualSimElapsedHours((prev) => {
        const next = prev + 0.025 * dualSimSpeedMultiplier;
        if (next >= total) {
          setDualSimPlaying(false);
          return total;
        }
        return next;
      });
    }, 100);
    return () => window.clearInterval(timer);
  }, [dualSimPlaying, dualSimSpeedMultiplier, dualSimBundle.totalDurationHours]);

  const dualSimFrame = useMemo(
    () =>
      evaluateDualSimFrame(
        timeline1,
        timeline2,
        effectiveDualElapsed,
        simDepartureLmstHour,
        weatherSnapshot,
      ),
    [timeline1, timeline2, effectiveDualElapsed, simDepartureLmstHour, weatherSnapshot],
  );

  const mapUnit1 = useMemo<MapUnitDisplay>(
    () => ({
      unitId: 1,
      waypoints: unit1.waypoints,
      routes: unit1.routePlan?.routes ?? EMPTY_ROUTES,
      selectedRouteId: selectedRoute1?.id ?? null,
      simPosition: dualSimFrame.unit1.sample,
    }),
    [unit1.waypoints, unit1.routePlan?.routes, selectedRoute1?.id, dualSimFrame.unit1.sample],
  );

  const mapUnit2 = useMemo<MapUnitDisplay>(
    () => ({
      unitId: 2,
      waypoints: unit2.waypoints,
      routes: unit2.routePlan?.routes ?? EMPTY_ROUTES,
      selectedRouteId: selectedRoute2?.id ?? null,
      simPosition: dualSimFrame.unit2.sample,
    }),
    [unit2.waypoints, unit2.routePlan?.routes, selectedRoute2?.id, dualSimFrame.unit2.sample],
  );

  const handleToggleDualPlay = useCallback(() => {
    if (dualSimBundle.totalDurationHours <= 0) return;
    setDualSimPlaying((prevPlaying) => {
      if (!prevPlaying && effectiveDualElapsed >= dualSimBundle.totalDurationHours - 1e-4) {
        setDualSimElapsedHours(0);
      }
      return !prevPlaying;
    });
  }, [dualSimBundle.totalDurationHours, effectiveDualElapsed]);

  const activeBaseLayer = useMemo(
    () => layers.find((l) => l.id === activeLayerId) ?? layers[0] ?? DEFAULT_MARS_BASE_LAYER,
    [layers, activeLayerId],
  );

  const loadWeatherSnapshot = useCallback(
    async (refresh = false) => {
      setWeatherBusy(true);
      setWeatherError(null);
      try {
        const res = await fetchWeatherSnapshot({
          site: site?.id,
          scenario: weatherScenario,
          lmstHour: simLmstHourRef.current,
          refresh,
        });
        weatherSnapshotRef.current = res.weather;
        setWeatherSnapshot(res.weather);
        patchUnit1((prev) => (prev.weatherEval ? prev : { ...prev, weatherEval: res.evaluation }));
        patchUnit2((prev) => (prev.weatherEval ? prev : { ...prev, weatherEval: res.evaluation }));
        setWeatherSnapshotRev((rev) => rev + 1);
      } catch (err: unknown) {
        setWeatherError(err instanceof Error ? err.message : "Failed to load weather");
      } finally {
        setWeatherBusy(false);
      }
    },
    [site?.id, weatherScenario, patchUnit1, patchUnit2],
  );

  useEffect(() => {
    void loadWeatherSnapshot(false);
  }, [loadWeatherSnapshot]);

  const isSimViewActive = panelOpen && activeToolId === "sim";
  const displayLmstHour =
    isSimViewActive && dualSimBundle.totalDurationHours > 0
      ? Math.min(47.99, simDepartureLmstHour + effectiveDualElapsed)
      : simLmstHour;

  // Fetch environment summary when pressure or temperature overlay is active
  useEffect(() => {
    if (!site || (!showPressureLayer && !showTemperatureLayer)) {
      setEnvSummary(null);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetchEnvironmentSummary(
        {
          scenario: weatherScenario,
          sol: weatherSnapshot?.sol,
          lmstHour: displayLmstHour,
        },
        controller.signal,
      )
        .then((summary) => {
          if (!cancelled) setEnvSummary(summary);
        })
        .catch((err: unknown) => {
          if (!cancelled && !isAbortError(err)) {
            setEnvSummary(null);
          }
        });
    }, 160);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    site,
    showPressureLayer,
    showTemperatureLayer,
    weatherScenario,
    displayLmstHour,
    weatherSnapshot?.sol,
  ]);

  const visiblePoints = useMemo(() => {
    if (!showPointsOverlay) return [];
    return filterVisiblePoints(points, hiddenClassIds);
  }, [points, hiddenClassIds, showPointsOverlay]);

  const handleSelectPreset = useCallback(
    (nextId: TraversePresetId) => {
      const preset = TRAVERSE_PRESETS[nextId];
      patchActiveUnit({
        presetId: nextId,
        maxSlopeDeg: preset.maxSlopeDeg,
        weatherLimits: cloneWeatherLimits(preset.limits),
      });
    },
    [patchActiveUnit],
  );

  const handleChangeActiveUnit = useCallback((nextId: MissionUnitId) => {
    setActiveUnitId(nextId);
    setHoveredProfilePoint(null);
  }, []);

  const handleAppendWaypoint = useCallback(
    (coord: MarsCoord, openRouteTab = true) => {
      patchActiveUnit((prev) => ({ ...prev, waypoints: [...prev.waypoints, coord] }));
      setHoveredProfilePoint(null);
      if (openRouteTab) {
        setActiveToolId("route");
        setPanelOpen(true);
      }
    },
    [patchActiveUnit],
  );

  const handleInsertIntermediateWaypoint = useCallback(
    (coord: MarsCoord, openRouteTab = true) => {
      patchActiveUnit((prev) => {
        if (prev.waypoints.length < 2) {
          return { ...prev, waypoints: [...prev.waypoints, coord] };
        }
        const idx = findBestWaypointInsertIndex(prev.waypoints, coord);
        const next = [...prev.waypoints];
        next.splice(idx, 0, coord);
        return { ...prev, waypoints: next };
      });
      setHoveredProfilePoint(null);
      if (openRouteTab) {
        setActiveToolId("route");
        setPanelOpen(true);
      }
    },
    [patchActiveUnit],
  );

  const handleMoveWaypoint = useCallback(
    (index: number, delta: -1 | 1) => {
      patchActiveUnit((prev) => {
        const target = index + delta;
        if (
          index < 0 ||
          index >= prev.waypoints.length ||
          target < 0 ||
          target >= prev.waypoints.length
        ) {
          return prev;
        }
        const next = [...prev.waypoints];
        const a = next[index];
        const b = next[target];
        if (!a || !b) return prev;
        next[index] = b;
        next[target] = a;
        return { ...prev, waypoints: next };
      });
      setHoveredProfilePoint(null);
    },
    [patchActiveUnit],
  );

  const handleUpdateWaypointCoord = useCallback(
    (unitId: MissionUnitId, index: number, coord: MarsCoord) => {
      patchUnitById(unitId, (prev) => {
        if (index < 0 || index >= prev.waypoints.length) return prev;
        const next = [...prev.waypoints];
        next[index] = coord;
        return { ...prev, waypoints: next };
      });
      setHoveredProfilePoint(null);
    },
    [patchUnitById],
  );

  const handleRemoveWaypoint = useCallback(
    (index: number) => {
      patchActiveUnit((prev) => ({
        ...prev,
        waypoints: prev.waypoints.filter((_, i) => i !== index),
      }));
      setHoveredProfilePoint(null);
    },
    [patchActiveUnit],
  );

  const handleReverseWaypoints = useCallback(() => {
    patchActiveUnit((prev) =>
      prev.waypoints.length >= 2 ? { ...prev, waypoints: [...prev.waypoints].reverse() } : prev,
    );
    setHoveredProfilePoint(null);
  }, [patchActiveUnit]);

  const handleClearWaypoints = useCallback(() => {
    patchActiveUnit({ waypoints: [] });
    setHoveredProfilePoint(null);
  }, [patchActiveUnit]);

  const handleChangeUiMode = useCallback(
    (nextMode: UiMode) => {
      if (nextMode === uiMode) return;
      setUiMode(nextMode);
      if (nextMode === "basic") {
        const resetForUnit = (prev: UnitMissionState): UnitMissionState => {
          const preset = TRAVERSE_PRESETS[prev.presetId];
          return {
            ...prev,
            maxSlopeDeg: preset.maxSlopeDeg,
            weatherLimits: cloneWeatherLimits(preset.limits),
          };
        };
        setUnit1(resetForUnit);
        setUnit2(resetForUnit);
        setEditingPoint(null);
        setPendingPointCoord(null);
        setPendingPointElevM(null);
      }
    },
    [uiMode],
  );

  const openPointComposerAtCoord = useCallback(
    (coord: MarsCoord) => {
      if (uiMode === "basic") return;
      setEditingPoint(null);
      setPendingPointCoord(coord);
      setPendingPointElevM(null);
      setActiveToolId("points");
      setPanelOpen(true);

      fetchElevation(coord.lat, coord.lon)
        .then((res) => setPendingPointElevM(res.elevationM))
        .catch(() => setPendingPointElevM(null));
    },
    [uiMode],
  );

  const handleSavePoint = useCallback(
    (payload: {
      id?: string;
      name: string;
      classId: string;
      icon?: PointIconKey;
      description: string;
      coord: MarsCoord;
      elevationM?: number | null;
    }) => {
      if (uiMode === "basic") return;
      if (payload.id) {
        const now = new Date().toISOString();
        setPoints((prev) =>
          prev.map((pt) =>
            pt.id === payload.id
              ? {
                  ...pt,
                  name: payload.name.trim(),
                  classId: payload.classId,
                  icon: payload.icon,
                  description: payload.description.trim(),
                  updatedAt: now,
                }
              : pt,
          ),
        );
        setSelectedPointId(payload.id);
      } else {
        setPoints((prev) => {
          const created = createMapPoint(payload, prev);
          setSelectedPointId(created.id);
          return [created, ...prev];
        });
      }
      // Make sure the saved point's class is visible immediately
      setHiddenClassIds((prev) => prev.filter((id) => id !== payload.classId));
      setEditingPoint(null);
      setPendingPointCoord(null);
      setPendingPointElevM(null);
    },
    [uiMode],
  );

  const handleDeletePoint = useCallback(
    (pointId: string) => {
      if (uiMode === "basic") return;
      setPoints((prev) => prev.filter((pt) => pt.id !== pointId));
      setSelectedPointId((prev) => (prev === pointId ? null : prev));
      setEditingPoint((prev) => (prev?.id === pointId ? null : prev));
    },
    [uiMode],
  );

  const handleStartEditPoint = useCallback(
    (point: MapPoint) => {
      if (uiMode === "basic") return;
      setPendingPointCoord(null);
      setPendingPointElevM(point.elevationM ?? null);
      setEditingPoint(point);
      setSelectedPointId(point.id);
      setActiveToolId("points");
      setPanelOpen(true);
    },
    [uiMode],
  );

  const handleFocusPoint = useCallback((point: MapPoint) => {
    setSelectedPointId(point.id);
    setHiddenClassIds((prev) => prev.filter((id) => id !== point.classId));
    setShowPointsOverlay(true);
    setFocusPointTrigger((prev) => ({
      coord: point.coord,
      seq: (prev?.seq ?? 0) + 1,
    }));
  }, []);

  const handleCreateCustomClass = useCallback(
    (payload: { name: string; shortCode: string; color: string; icon: PointIconKey }) => {
      if (uiMode === "basic") return;
      setPointClasses((prev) => [...prev, createCustomPointClass(payload, prev)]);
    },
    [uiMode],
  );

  const handleDeleteCustomClass = useCallback(
    (classId: string) => {
      if (uiMode === "basic") return;
      setPointClasses((prev) => prev.filter((c) => c.id !== classId || c.builtIn));
      setHiddenClassIds((prev) => prev.filter((id) => id !== classId));
    },
    [uiMode],
  );

  const simSolDisplay = resolveSolDisplay(weatherSnapshot?.sol, displayLmstHour);
  const simClockLabel = formatLmstClock(displayLmstHour);

  const localCursorWeather = useMemo(() => {
    if (cursorElevM === null || !weatherSnapshot) return null;
    return estimateLocalWeatherAtElevation(cursorElevM, displayLmstHour, weatherSnapshot);
  }, [cursorElevM, displayLmstHour, weatherSnapshot]);

  const registry = useMemo(() => {
    const reg = new ToolRegistry();

    reg.register({
      id: "route",
      shortLabel: "RTE",
      title: "Route Planner",
      order: 1,
      render: () => (
        <RoutePlannerPanel
          activeUnitId={activeUnitId}
          uiMode={uiMode}
          presetId={activeUnit.presetId}
          onSelectPreset={handleSelectPreset}
          siteCompactLabel={siteLabels.sizeCompact}
          maxSlopeDeg={activeUnit.maxSlopeDeg}
          onChangeMaxSlopeDeg={(deg) => patchActiveUnit({ maxSlopeDeg: deg })}
          weatherRoutingEnabled={activeUnit.weatherRoutingEnabled}
          onToggleWeatherRouting={() =>
            patchActiveUnit((prev) => ({
              ...prev,
              weatherRoutingEnabled: !prev.weatherRoutingEnabled,
            }))
          }
          weatherLimits={activeUnit.weatherLimits}
          simClockLabel={simClockLabel}
          waypoints={activeUnit.waypoints}
          moveWaypoints={moveWaypointsMode}
          onToggleMoveWaypoints={() => setMoveWaypointsMode((v) => !v)}
          onMoveWaypoint={handleMoveWaypoint}
          onRemoveWaypoint={handleRemoveWaypoint}
          onReverseWaypoints={handleReverseWaypoints}
          onClearWaypoints={handleClearWaypoints}
          lonFormat={lonFormat}
          routePlan={activeUnit.routePlan}
          selectedRoute={activeSelectedRoute}
          onSelectRoute={(id) => patchActiveUnit({ selectedRouteId: id })}
          routingBusy={activeUnit.routingBusy}
          siteError={siteError}
          onHoverProfilePoint={setHoveredProfilePoint}
          weatherEval={activeUnit.weatherEval}
          onOpenWeatherPanel={() => {
            setActiveToolId("weather");
            setPanelOpen(true);
          }}
        />
      ),
    });

    reg.register({
      id: "weather",
      shortLabel: "WXR",
      title: "Weather & EVA",
      order: 2,
      render: () => (
        <WeatherPanel
          activeUnitId={activeUnitId}
          uiMode={uiMode}
          presetId={activeUnit.presetId}
          onSelectPreset={handleSelectPreset}
          weather={weatherSnapshot}
          evaluation={activeUnit.weatherEval}
          limits={activeUnit.weatherLimits}
          scenario={weatherScenario}
          simLmstHour={simLmstHour}
          isPlayingTime={isPlayingTime}
          loading={weatherBusy}
          error={activeUnit.weatherError ?? weatherError}
          hasSelectedRoute={activeSelectedRoute !== null}
          waypointCount={activeUnit.waypoints.length}
          onChangeLimits={(nextLimits) => patchActiveUnit({ weatherLimits: nextLimits })}
          onResetLimits={() =>
            patchActiveUnit((prev) => ({
              ...prev,
              weatherLimits: cloneWeatherLimits(TRAVERSE_PRESETS[prev.presetId].limits),
            }))
          }
          onChangeScenario={setWeatherScenario}
          onChangeSimHour={handleChangeSimHour}
          onJumpSimHour={handleJumpSimHour}
          onTogglePlayTime={handleTogglePlayTime}
          onRefresh={() => {
            void loadWeatherSnapshot(true);
          }}
        />
      ),
    });

    reg.register({
      id: "sim",
      shortLabel: "SIM",
      title: "Dual Simulation",
      order: 3,
      render: () => (
        <DualSimulationPanel
          unit1={{
            unitId: 1,
            presetId: unit1.presetId,
            route: selectedRoute1,
            limits: unit1.weatherLimits,
            maxSlopeDeg: unit1.maxSlopeDeg,
            waypointCount: unit1.waypoints.length,
          }}
          unit2={{
            unitId: 2,
            presetId: unit2.presetId,
            route: selectedRoute2,
            limits: unit2.weatherLimits,
            maxSlopeDeg: unit2.maxSlopeDeg,
            waypointCount: unit2.waypoints.length,
          }}
          bundle={dualSimBundle}
          frame={dualSimFrame}
          elapsedHours={effectiveDualElapsed}
          departureLmstHour={simDepartureLmstHour}
          playing={dualSimPlaying}
          speedMultiplier={dualSimSpeedMultiplier}
          weather={weatherSnapshot}
          onChangeElapsed={(next) => {
            setDualSimPlaying(false);
            setDualSimElapsedHours(next);
          }}
          onTogglePlay={handleToggleDualPlay}
          onReset={() => {
            setDualSimPlaying(false);
            setDualSimElapsedHours(0);
          }}
          onChangeSpeed={setDualSimSpeedMultiplier}
          onChangeDepartureLmst={(nextHour) => {
            const wrapped = ((nextHour % 48) + 48) % 48;
            setSimDepartureLmstHour(Math.round(wrapped * 2) / 2);
          }}
          onSyncDepartureFromWxr={() => setSimDepartureLmstHour(simLmstHour)}
          onEditUnitRoute={(unitId) => {
            handleChangeActiveUnit(unitId);
            setActiveToolId("route");
            setPanelOpen(true);
          }}
        />
      ),
    });

    reg.register({
      id: "points",
      shortLabel: "PTS",
      title: "Points",
      order: 4,
      render: () => (
        <PointsPanel
          readOnly={uiMode === "basic"}
          activeUnitId={activeUnitId}
          classes={pointClasses}
          points={points}
          hiddenClassIds={hiddenClassIds}
          lonFormat={lonFormat}
          pendingCoord={pendingPointCoord}
          pendingElevM={pendingPointElevM}
          editingPoint={editingPoint}
          selectedPointId={selectedPointId}
          onCancelDraft={() => {
            setEditingPoint(null);
            setPendingPointCoord(null);
            setPendingPointElevM(null);
          }}
          onSavePoint={handleSavePoint}
          onStartEditPoint={handleStartEditPoint}
          onDeletePoint={handleDeletePoint}
          onFocusPoint={handleFocusPoint}
          nextWaypointNumber={activeUnit.waypoints.length + 1}
          onAppendWaypoint={(c) => handleAppendWaypoint(c, false)}
          onInsertIntermediate={(c) => handleInsertIntermediateWaypoint(c, false)}
          onToggleClass={(classId) =>
            setHiddenClassIds((prev) => toggleClassVisibility(prev, classId))
          }
          onSetAllClassesVisible={(visible) =>
            setHiddenClassIds(setAllClassesVisible(pointClasses, visible))
          }
          onCreateClass={handleCreateCustomClass}
          onDeleteCustomClass={handleDeleteCustomClass}
        />
      ),
    });

    reg.register({
      id: "layers",
      shortLabel: "LYR",
      title: "Map Layers",
      order: 5,
      render: () => (
        <>
          <div className="panel-header">
            <h1 className="panel-title">Map Layers</h1>
            <p className="panel-desc">
              Global USGS and Mars Trek basemaps paired with the {siteLabels.sizeCompact} km{" "}
              {siteLabels.sourceLabel} terrain patch.
            </p>
            <div className="panel-rule" />
          </div>

          <div className="nav-button-list">
            {layers.map((layer) => {
              const isSelected = layer.id === activeLayerId;
              return (
                <button
                  key={layer.id}
                  type="button"
                  className={`chamfer-btn ${isSelected ? "is-primary" : ""}`}
                  onClick={() => setActiveLayerId(layer.id)}
                >
                  <span className="chamfer-btn-body">
                    <span className="chamfer-btn-label">{layer.label}</span>
                  </span>
                  <span className="chamfer-btn-arrow">→</span>
                </button>
              );
            })}
          </div>

          <div className="divider" />

          <button type="button" className="toggle-row" onClick={() => setShowHillshade((v) => !v)}>
            <span className="value-label" style={{ color: "var(--color-text)" }}>
              {siteLabels.sizeUpper} {siteLabels.sourceUpper} HILLSHADE
            </span>
            <span className={`toggle-state ${showHillshade ? "is-on" : ""}`}>
              {showHillshade ? "ON" : "OFF"}
            </span>
          </button>

          <button
            type="button"
            className="toggle-row"
            onClick={() => setShowSlopeHazard((v) => !v)}
          >
            <span className="value-label" style={{ color: "var(--color-text)" }}>
              SLOPE HAZARD OVERLAY
            </span>
            <span className={`toggle-state ${showSlopeHazard ? "is-on" : ""}`}>
              {showSlopeHazard ? "ON" : "OFF"}
            </span>
          </button>

          <button type="button" className="toggle-row" onClick={() => setShowSoilLayer((v) => !v)}>
            <span className="value-label" style={{ color: "var(--color-text)" }}>
              SOIL SUBSTRATE MATRIX
            </span>
            <span className={`toggle-state ${showSoilLayer ? "is-on" : ""}`}>
              {showSoilLayer ? "ON" : "OFF"}
            </span>
          </button>

          <button
            type="button"
            className="toggle-row"
            onClick={() => setShowPressureLayer((v) => !v)}
          >
            <span className="value-label" style={{ color: "var(--color-text)" }}>
              PRESSURE OVERLAY (PA)
            </span>
            <span className={`toggle-state ${showPressureLayer ? "is-on" : ""}`}>
              {showPressureLayer ? "ON" : "OFF"}
            </span>
          </button>

          <button
            type="button"
            className="toggle-row"
            onClick={() => setShowTemperatureLayer((v) => !v)}
          >
            <span className="value-label" style={{ color: "var(--color-text)" }}>
              TEMPERATURE OVERLAY (°C)
            </span>
            <span className={`toggle-state ${showTemperatureLayer ? "is-on" : ""}`}>
              {showTemperatureLayer ? "ON" : "OFF"}
            </span>
          </button>

          {showPressureLayer && showTemperatureLayer && (
            <div className="readout-card lyr-overlap-notice">
              <span className="readout-sub">
                Pressure and temperature layers are stacked at 56% opacity.
              </span>
              <div className="lyr-overlap-actions">
                <button
                  type="button"
                  className="compact-btn"
                  onClick={() => setShowTemperatureLayer(false)}
                >
                  PRESSURE ONLY
                </button>
                <button
                  type="button"
                  className="compact-btn"
                  onClick={() => setShowPressureLayer(false)}
                >
                  TEMP ONLY
                </button>
              </div>
            </div>
          )}

          <button type="button" className="toggle-row" onClick={() => setShowSiteBounds((v) => !v)}>
            <span className="value-label" style={{ color: "var(--color-text)" }}>
              {siteLabels.sizeUpper} BOUNDARY FRAME
            </span>
            <span className={`toggle-state ${showSiteBounds ? "is-on" : ""}`}>
              {showSiteBounds ? "ON" : "OFF"}
            </span>
          </button>

          <button
            type="button"
            className="toggle-row"
            onClick={() => setShowPointsOverlay((v) => !v)}
          >
            <span className="value-label" style={{ color: "var(--color-text)" }}>
              CLASSIFIED MARKERS
            </span>
            <span className={`toggle-state ${showPointsOverlay ? "is-on" : ""}`}>
              {showPointsOverlay ? "ON" : "OFF"}
            </span>
          </button>
        </>
      ),
    });

    return reg;
  }, [
    activeUnitId,
    activeUnit,
    unit1,
    unit2,
    selectedRoute1,
    selectedRoute2,
    activeSelectedRoute,
    patchActiveUnit,
    handleChangeActiveUnit,
    handleAppendWaypoint,
    handleInsertIntermediateWaypoint,
    handleMoveWaypoint,
    moveWaypointsMode,
    handleRemoveWaypoint,
    handleReverseWaypoints,
    handleClearWaypoints,
    simLmstHour,
    simClockLabel,
    isPlayingTime,
    handleChangeSimHour,
    handleJumpSimHour,
    handleTogglePlayTime,
    lonFormat,
    siteError,
    layers,
    uiMode,
    handleSelectPreset,
    activeLayerId,
    showHillshade,
    showSoilLayer,
    showSlopeHazard,
    showPressureLayer,
    showTemperatureLayer,
    showSiteBounds,
    showPointsOverlay,
    siteLabels,
    pointClasses,
    points,
    hiddenClassIds,
    pendingPointCoord,
    pendingPointElevM,
    editingPoint,
    selectedPointId,
    handleSavePoint,
    handleStartEditPoint,
    handleDeletePoint,
    handleFocusPoint,
    handleCreateCustomClass,
    handleDeleteCustomClass,
    weatherSnapshot,
    weatherScenario,
    weatherBusy,
    weatherError,
    loadWeatherSnapshot,
    dualSimBundle,
    dualSimFrame,
    effectiveDualElapsed,
    simDepartureLmstHour,
    dualSimPlaying,
    dualSimSpeedMultiplier,
    handleToggleDualPlay,
  ]);

  const tools = registry.list();
  const activeTool = registry.get(activeToolId) ?? tools[0];

  const handleSelectTool = (id: string) => {
    if (id === activeToolId && panelOpen) {
      setPanelOpen(false);
    } else {
      setActiveToolId(id);
      setPanelOpen(true);
    }
  };

  const leftHudOffset = panelOpen ? 480 : 64;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-brand">
          <div className="topbar-mark" />
          <span className="topbar-title">MARS MISSION PLANNER</span>
        </div>
        <div className="topbar-meta">
          {site && (
            <>
              <span>
                SITE <strong>{site.name.toUpperCase()}</strong>
              </span>
              <span>
                PATCH <strong>{siteLabels.sizeExact}</strong>
              </span>
            </>
          )}
          <button
            type="button"
            className="topbar-clock-btn"
            onClick={() => {
              setActiveToolId("weather");
              setPanelOpen(true);
            }}
            title="Open weather and time simulation controls"
          >
            <span>
              {simSolDisplay.label} · {simClockLabel} LMST
            </span>
          </button>
          {activeUnit.weatherEval && (
            <button
              type="button"
              className={`topbar-wxr-btn ${evaStatusClass(activeUnit.weatherEval.status)}`}
              onClick={() => {
                setActiveToolId("weather");
                setPanelOpen(true);
              }}
              title={activeUnit.weatherEval.weatherSource.sourceLabel}
            >
              <span>
                U{activeUnitId} EVA {activeUnit.weatherEval.status}
              </span>
              {activeUnit.weatherEval.weatherSource.isSimulated && <span>SIM</span>}
            </button>
          )}
        </div>
      </header>

      <main className="workspace">
        <MapView
          site={site}
          activeBaseLayer={activeBaseLayer}
          showHillshade={showHillshade}
          showSoilLayer={showSoilLayer}
          showSlopeHazard={showSlopeHazard}
          showPressureLayer={showPressureLayer}
          showTemperatureLayer={showTemperatureLayer}
          showSiteBounds={showSiteBounds}
          maxSlopeDeg={activeUnit.maxSlopeDeg}
          weatherScenario={weatherScenario}
          simLmstHour={displayLmstHour}
          weatherSol={weatherSnapshot?.sol}
          minPressurePa={activeUnit.weatherLimits.minPressurePa}
          minAirTempC={activeUnit.weatherLimits.minAirTempC}
          activeUnitId={activeUnitId}
          unit1={mapUnit1}
          unit2={mapUnit2}
          isSimMode={isSimViewActive}
          moveWaypoints={moveWaypointsMode}
          hoveredProfilePoint={hoveredProfilePoint}
          points={visiblePoints}
          pointClasses={pointClasses}
          selectedPointId={selectedPointId}
          readOnlyPoints={uiMode === "basic"}
          focusPointTrigger={focusPointTrigger}
          leftInsetPx={leftHudOffset}
          focusRequestCount={focusCount}
          zoomStepTrigger={zoomTrigger}
          onCursorMove={handleCursorMove}
          onScaleUpdate={(label, widthPx, zoom) => setScaleHud({ label, widthPx, zoom })}
          onOpenContextMenu={(x, y, coord) => setContextMenu({ x, y, coord })}
          onCloseContextMenu={() => setContextMenu(null)}
          onSelectRoute={(unitId, routeId) => {
            patchUnitById(unitId, { selectedRouteId: routeId });
          }}
          onDragWaypoint={handleUpdateWaypointCoord}
          onSelectPoint={(id) => setSelectedPointId(id)}
          onPointAppendWaypoint={(c) => handleAppendWaypoint(c, true)}
          onPointInsertWaypoint={(c) => handleInsertIntermediateWaypoint(c, true)}
          onEditPoint={handleStartEditPoint}
          onDeletePoint={handleDeletePoint}
        />

        <aside className="left-dock">
          <nav className="tool-rail" aria-label="Map tools">
            <div className="tool-rail-group">
              {tools.map((tool) => (
                <button
                  key={tool.id}
                  type="button"
                  title={tool.title}
                  className={`rail-button ${panelOpen && activeToolId === tool.id ? "is-active" : ""}`}
                  onClick={() => handleSelectTool(tool.id)}
                >
                  <span>{tool.shortLabel}</span>
                </button>
              ))}
            </div>

            <div className="tool-rail-group">
              <fieldset className="rail-unit-switch" aria-label="Active character">
                <button
                  type="button"
                  title={`Character 1 · ${TRAVERSE_PRESETS[unit1.presetId].label}`}
                  aria-pressed={activeUnitId === 1}
                  className={`rail-unit-btn is-u1 ${activeUnitId === 1 ? "is-active" : ""}`}
                  onClick={() => handleChangeActiveUnit(1)}
                >
                  1
                </button>
                <button
                  type="button"
                  title={`Character 2 · ${TRAVERSE_PRESETS[unit2.presetId].label}`}
                  aria-pressed={activeUnitId === 2}
                  className={`rail-unit-btn is-u2 ${activeUnitId === 2 ? "is-active" : ""}`}
                  onClick={() => handleChangeActiveUnit(2)}
                >
                  2
                </button>
              </fieldset>

              <fieldset className="rail-mode-switch" aria-label="Interface mode">
                <button
                  type="button"
                  title="Basic mode: Human/Rover presets and read-only points"
                  aria-pressed={uiMode === "basic"}
                  className={`rail-mode-btn ${uiMode === "basic" ? "is-active" : ""}`}
                  onClick={() => handleChangeUiMode("basic")}
                >
                  BSC
                </button>
                <button
                  type="button"
                  title="Advance mode: all parameter sliders and point editing"
                  aria-pressed={uiMode === "advance"}
                  className={`rail-mode-btn ${uiMode === "advance" ? "is-active" : ""}`}
                  onClick={() => handleChangeUiMode("advance")}
                >
                  ADV
                </button>
              </fieldset>

              <button
                type="button"
                className="rail-button"
                title={panelOpen ? "Collapse panel" : "Expand panel"}
                onClick={() => setPanelOpen((v) => !v)}
              >
                <span>{panelOpen ? "<" : ">"}</span>
              </button>
            </div>
          </nav>

          {panelOpen && activeTool && (
            <section className="side-panel">{activeTool.render()}</section>
          )}
        </aside>

        <div className="map-hud" style={{ left: `${leftHudOffset}px` }}>
          <div className="corner-bracket tl" />
          <div className="corner-bracket tr" />
          <div className="corner-bracket bl" />
          <div className="corner-bracket br" />

          <div className="hud-row top">
            <div className="hud-readout">
              <span className="value-label">CURSOR</span>
              <span className="hud-number">
                {cursorCoord
                  ? `${cursorCoord.lat.toFixed(4)}° ${formatLon(cursorCoord.lon, lonFormat)}`
                  : "---"}
              </span>
            </div>

            <div className="hud-readout is-right">
              <span className="value-label">ELEVATION</span>
              <span className="hud-number">
                {cursorElevM !== null ? `${cursorElevM.toFixed(1)} m` : "---"}
              </span>
              {(localCursorWeather || cursorSoilType) && (
                <span className="hud-sub">
                  {cursorSoilType && (
                    <span className="hud-soil-inline">
                      <span
                        className="wx-soil-swatch"
                        style={{ backgroundColor: SOIL_TYPE_CATALOG[cursorSoilType].colorHex }}
                      />
                      {SOIL_TYPE_CATALOG[cursorSoilType].shortLabel}{" "}
                      {resolveSoilSpeedFactors(activeUnit.weatherLimits.soilSpeedFactors)[
                        cursorSoilType
                      ].toFixed(2)}
                      x{localCursorWeather ? " · " : ""}
                    </span>
                  )}
                  {localCursorWeather && (
                    <>
                      {localCursorWeather.pressurePa.toFixed(0)} Pa ·{" "}
                      {localCursorWeather.tempC.toFixed(1)} °C
                    </>
                  )}
                </span>
              )}
            </div>
          </div>

          <div className="hud-row bottom">
            <div className="hud-readout is-interactive">
              <span className="value-label">SCALE · Z{scaleHud.zoom}</span>
              <span className="mono-value">{scaleHud.label}</span>
              <div className="scale-line" style={{ width: `${scaleHud.widthPx}px` }} />
              <div className="hud-actions">
                <button
                  type="button"
                  className="compact-btn"
                  onClick={() => setZoomTrigger((z) => ({ delta: 1, seq: (z?.seq ?? 0) + 1 }))}
                >
                  +
                </button>
                <button
                  type="button"
                  className="compact-btn"
                  onClick={() => setZoomTrigger((z) => ({ delta: -1, seq: (z?.seq ?? 0) + 1 }))}
                >
                  -
                </button>
                <button
                  type="button"
                  className="compact-btn"
                  onClick={() => setFocusCount((c) => c + 1)}
                >
                  {siteLabels.sizeUpper}
                </button>
              </div>
            </div>

            <div className="hud-bottom-right">
              {(showPressureLayer || showTemperatureLayer || showSoilLayer) && (
                <div className="hud-legend-stack">
                  {showSoilLayer && (
                    <div className="hud-readout hud-legend-chip">
                      <div className="hud-legend-head">
                        <span className="value-label">SOIL SUBSTRATE</span>
                        <span className="hud-legend-time">U{activeUnitId} · THEMIS+CTX</span>
                      </div>
                      <div className="hud-soil-grid">
                        {SOIL_TYPE_ORDER.map((id) => {
                          const spec = SOIL_TYPE_CATALOG[id];
                          const factor = resolveSoilSpeedFactors(
                            activeUnit.weatherLimits.soilSpeedFactors,
                          )[id];
                          return (
                            <span key={id} className="hud-soil-item">
                              <span
                                className="wx-soil-swatch"
                                style={{ backgroundColor: spec.colorHex }}
                              />
                              <span>{spec.shortLabel}</span>
                              <span className="hud-soil-factor">{factor.toFixed(2)}x</span>
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {showPressureLayer && (
                    <div className="hud-readout hud-legend-chip">
                      <div className="hud-legend-head">
                        <span className="value-label">PRESSURE (PA)</span>
                        <span className="hud-legend-time">{simClockLabel} LMST</span>
                      </div>
                      <div className="hud-legend-bar is-pressure" />
                      <div className="hud-legend-scale">
                        <span>
                          {envSummary
                            ? `${envSummary.minPressurePa.toFixed(0)}..${envSummary.maxPressurePa.toFixed(0)} Pa`
                            : "SITE PA"}
                        </span>
                        <span>
                          LIMIT &gt;= {activeUnit.weatherLimits.minPressurePa.toFixed(0)} Pa
                        </span>
                      </div>
                    </div>
                  )}
                  {showTemperatureLayer && (
                    <div className="hud-readout hud-legend-chip">
                      <div className="hud-legend-head">
                        <span className="value-label">AIR TEMP (°C)</span>
                        <span className="hud-legend-time">{simClockLabel} LMST</span>
                      </div>
                      <div className="hud-legend-bar is-temperature" />
                      <div className="hud-legend-scale">
                        <span>
                          {envSummary
                            ? `${envSummary.minTempC.toFixed(0)}..${envSummary.maxTempC.toFixed(0)} °C`
                            : "SITE °C"}
                        </span>
                        <span>
                          LIMIT &gt;= {activeUnit.weatherLimits.minAirTempC.toFixed(0)} °C
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="hud-readout is-right is-interactive">
                <span className="value-label">MAX SLOPE · U{activeUnitId}</span>
                <span className="hud-number">{activeUnit.maxSlopeDeg.toFixed(1)}°</span>
              </div>
            </div>
          </div>
        </div>

        {contextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            coord={contextMenu.coord}
            activeUnitId={activeUnitId}
            waypointCount={activeUnit.waypoints.length}
            suggestedInsertIndex={
              activeUnit.waypoints.length >= 2
                ? findBestWaypointInsertIndex(activeUnit.waypoints, contextMenu.coord)
                : null
            }
            canAddPoint={uiMode === "advance"}
            onAppendWaypoint={(c) => handleAppendWaypoint(c, true)}
            onInsertIntermediate={(c) => handleInsertIntermediateWaypoint(c, true)}
            onRemoveLastWaypoint={() => {
              if (activeUnit.waypoints.length === 0) return;
              handleRemoveWaypoint(activeUnit.waypoints.length - 1);
            }}
            onAddPoint={openPointComposerAtCoord}
            onClear={handleClearWaypoints}
            onClose={() => setContextMenu(null)}
          />
        )}
      </main>
    </div>
  );
}
