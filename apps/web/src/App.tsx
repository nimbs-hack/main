import {
  DEFAULT_MARS_BASE_LAYER,
  type LonFormat,
  MARS_BASE_LAYERS,
  type MarsCoord,
  type RoutePlanResponse,
  type RoutePoint,
  type SiteMetadata,
  lon180To360,
} from "@nimbs/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ContextMenu } from "./components/ContextMenu";
import { MapView } from "./components/MapView";
import { MaxSlopeControl } from "./components/MaxSlopeControl";
import { PointsPanel } from "./components/PointsPanel";
import { RoutePlannerPanel } from "./components/RoutePlannerPanel";
import {
  TimeSimulationControl,
  clampSimLmstHour,
  estimateLocalWeatherAtElevation,
  formatLmstClock,
  resolveSolDisplay,
} from "./components/TimeSimulationControl";
import { TraversePresetControl } from "./components/TraversePresetControl";
import { WeatherPanel, evaStatusClass } from "./components/WeatherPanel";
import { ToolRegistry } from "./registry/toolRegistry";
import {
  DEFAULT_EVA_WEATHER_LIMITS,
  type EvaRouteWeatherContext,
  type EvaWeatherEvaluation,
  type EvaWeatherLimits,
  type MarsWeatherSnapshot,
  type SiteEnvironmentSummary,
  TRAVERSE_PRESETS,
  type TraversePointSample,
  type TraversePresetId,
  type UiMode,
  type WeatherScenario,
  evaluateWeatherConstraints,
  fetchBaseLayers,
  fetchElevation,
  fetchEnvironmentSummary,
  fetchSiteMeta,
  fetchWeatherSnapshot,
  planGraphRoutes,
} from "./services/api";
import { loadMissionState, saveMissionState } from "./services/browserCache";
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

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
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
  const [showSlopeHazard, setShowSlopeHazard] = useState(initialMissionState.showSlopeHazard);
  const [showPressureLayer, setShowPressureLayer] = useState(initialMissionState.showPressureLayer);
  const [showTemperatureLayer, setShowTemperatureLayer] = useState(
    initialMissionState.showTemperatureLayer,
  );
  const [showSiteBounds, setShowSiteBounds] = useState(initialMissionState.showSiteBounds);

  const [uiMode, setUiMode] = useState<UiMode>(initialMissionState.uiMode);
  const [presetId, setPresetId] = useState<TraversePresetId>(initialMissionState.presetId);
  const [activeToolId, setActiveToolId] = useState(initialMissionState.activeToolId);
  const [panelOpen, setPanelOpen] = useState(initialMissionState.panelOpen);
  const [lonFormat, setLonFormat] = useState<LonFormat>(initialMissionState.lonFormat);

  const [maxSlopeDeg, setMaxSlopeDeg] = useState<number>(initialMissionState.maxSlopeDeg);
  const [weatherRoutingEnabled, setWeatherRoutingEnabled] = useState(
    initialMissionState.weatherRoutingEnabled,
  );
  const [waypointA, setWaypointA] = useState<MarsCoord | null>(initialMissionState.waypointA);
  const [waypointB, setWaypointB] = useState<MarsCoord | null>(initialMissionState.waypointB);
  const [routePlan, setRoutePlan] = useState<RoutePlanResponse | null>(null);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(
    initialMissionState.selectedRouteId,
  );
  const [routingBusy, setRoutingBusy] = useState(false);
  const [hoveredProfilePoint, setHoveredProfilePoint] = useState<RoutePoint | null>(null);

  const [cursorCoord, setCursorCoord] = useState<MarsCoord | null>(null);
  const [cursorElevM, setCursorElevM] = useState<number | null>(null);
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
  const [pickPointMode, setPickPointMode] = useState(false);
  const [focusPointTrigger, setFocusPointTrigger] = useState<{
    coord: MarsCoord;
    seq: number;
  } | null>(null);

  const [simLmstHour, setSimLmstHour] = useState(initialMissionState.simLmstHour);
  const [isPlayingTime, setIsPlayingTime] = useState(false);
  const [weatherLimits, setWeatherLimits] = useState<EvaWeatherLimits>(
    initialMissionState.weatherLimits,
  );
  const [weatherScenario, setWeatherScenario] = useState<WeatherScenario>(
    initialMissionState.weatherScenario,
  );
  const [weatherSnapshot, setWeatherSnapshot] = useState<MarsWeatherSnapshot | null>(null);
  const [weatherSnapshotRev, setWeatherSnapshotRev] = useState(0);
  const [weatherEval, setWeatherEval] = useState<EvaWeatherEvaluation | null>(null);
  const [weatherBusy, setWeatherBusy] = useState(false);
  const [weatherError, setWeatherError] = useState<string | null>(null);
  const [envSummary, setEnvSummary] = useState<SiteEnvironmentSummary | null>(null);

  const weatherSnapshotRef = useRef<MarsWeatherSnapshot | null>(null);
  const simLmstHourRef = useRef(simLmstHour);
  simLmstHourRef.current = simLmstHour;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      saveMissionState({
        version: 1,
        activeLayerId,
        showHillshade,
        showSlopeHazard,
        showPressureLayer,
        showTemperatureLayer,
        showSiteBounds,
        showPointsOverlay,
        uiMode,
        presetId,
        activeToolId,
        panelOpen,
        lonFormat,
        maxSlopeDeg,
        weatherRoutingEnabled,
        waypointA,
        waypointB,
        selectedRouteId,
        simLmstHour,
        weatherScenario,
        weatherLimits,
      });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [
    activeLayerId,
    showHillshade,
    showSlopeHazard,
    showPressureLayer,
    showTemperatureLayer,
    showSiteBounds,
    showPointsOverlay,
    uiMode,
    presetId,
    activeToolId,
    panelOpen,
    lonFormat,
    maxSlopeDeg,
    weatherRoutingEnabled,
    waypointA,
    waypointB,
    selectedRouteId,
    simLmstHour,
    weatherScenario,
    weatherLimits,
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
        return;
      }
      const [west, south, east, north] = site.bbox;
      if (coord.lat < south || coord.lat > north || coord.lon < west || coord.lon > east) {
        setCursorElevM(null);
        return;
      }
      if (elevTimerRef.current !== null) {
        window.clearTimeout(elevTimerRef.current);
      }
      elevTimerRef.current = window.setTimeout(() => {
        fetchElevation(coord.lat, coord.lon)
          .then((res) => setCursorElevM(res.elevationM))
          .catch(() => setCursorElevM(null));
      }, 45);
    },
    [site],
  );

  // Recompute weather-constrained terrain graph routes with 120ms debounce
  useEffect(() => {
    if (!waypointA || !waypointB) {
      setRoutePlan(null);
      setSelectedRouteId(null);
      setRoutingBusy(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setRoutingBusy(true);
      planGraphRoutes(
        {
          waypointA,
          waypointB,
          maxSlopeDeg,
          weatherConstraints: {
            enabled: weatherRoutingEnabled,
            scenario: weatherScenario,
            sol: weatherSnapshotRef.current?.sol,
            lmstHour: simLmstHour,
            minAirTempC: weatherLimits.minAirTempC,
            minPressurePa: weatherLimits.minPressurePa,
            thermalWeight: DEFAULT_THERMAL_WEIGHT,
          },
        },
        controller.signal,
      )
        .then((res) => {
          if (cancelled) return;
          setRoutePlan(res);
          setSelectedRouteId((prev) =>
            res.routes.some((r) => r.id === prev) ? prev : (res.routes[0]?.id ?? null),
          );
        })
        .catch((err: unknown) => {
          if (cancelled || isAbortError(err)) return;
          setRoutePlan({
            status: "unreachable",
            maxSlopeDeg,
            passableEdgeRatio: 0,
            routes: [],
            message: err instanceof Error ? err.message : "Route request failed",
          });
        })
        .finally(() => {
          if (!cancelled) setRoutingBusy(false);
        });
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    waypointA,
    waypointB,
    maxSlopeDeg,
    weatherRoutingEnabled,
    weatherScenario,
    simLmstHour,
    weatherLimits.minAirTempC,
    weatherLimits.minPressurePa,
  ]);

  const activeBaseLayer = useMemo(
    () => layers.find((l) => l.id === activeLayerId) ?? layers[0] ?? DEFAULT_MARS_BASE_LAYER,
    [layers, activeLayerId],
  );

  const selectedRoute = useMemo(
    () => routePlan?.routes.find((r) => r.id === selectedRouteId) ?? routePlan?.routes[0] ?? null,
    [routePlan, selectedRouteId],
  );

  const routeWeatherContext = useMemo<EvaRouteWeatherContext | undefined>(() => {
    if (!selectedRoute) return undefined;
    let minElevationM = Number.POSITIVE_INFINITY;
    let maxElevationM = Number.NEGATIVE_INFINITY;
    for (const pt of selectedRoute.points) {
      if (pt.elevationM < minElevationM) minElevationM = pt.elevationM;
      if (pt.elevationM > maxElevationM) maxElevationM = pt.elevationM;
    }
    return {
      totalDistanceM: selectedRoute.totalDistanceM,
      elevationGainM: selectedRoute.elevationGainM,
      elevationLossM: selectedRoute.elevationLossM,
      minElevationM: Number.isFinite(minElevationM) ? minElevationM : undefined,
      maxElevationM: Number.isFinite(maxElevationM) ? maxElevationM : undefined,
      points: sampleRoutePoints(selectedRoute.points, 80),
    };
  }, [selectedRoute]);

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
        setWeatherEval(res.evaluation);
        setWeatherSnapshotRev((rev) => rev + 1);
      } catch (err: unknown) {
        setWeatherError(err instanceof Error ? err.message : "Failed to load weather");
      } finally {
        setWeatherBusy(false);
      }
    },
    [site?.id, weatherScenario],
  );

  useEffect(() => {
    void loadWeatherSnapshot(false);
  }, [loadWeatherSnapshot]);

  // Re-evaluate EVA weather feasibility dynamically as sliders, routes, or sim time change
  useEffect(() => {
    const snapshot = weatherSnapshotRef.current;
    if (!snapshot || weatherSnapshotRev === 0) return;
    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      evaluateWeatherConstraints(
        {
          limits: weatherLimits,
          site: site?.id,
          scenario: weatherScenario,
          lmstHour: simLmstHour,
          route: routeWeatherContext,
          weather: snapshot,
        },
        controller.signal,
      )
        .then((res) => {
          if (cancelled) return;
          setWeatherEval(res.evaluation);
          setWeatherError(null);
        })
        .catch((err: unknown) => {
          if (cancelled || isAbortError(err)) return;
          setWeatherError(err instanceof Error ? err.message : "Weather evaluation failed");
        });
    }, 80);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    weatherLimits,
    routeWeatherContext,
    site?.id,
    weatherScenario,
    simLmstHour,
    weatherSnapshotRev,
  ]);

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
          lmstHour: simLmstHour,
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
    simLmstHour,
    weatherSnapshot?.sol,
  ]);

  const visiblePoints = useMemo(() => {
    if (!showPointsOverlay) return [];
    return filterVisiblePoints(points, hiddenClassIds);
  }, [points, hiddenClassIds, showPointsOverlay]);

  const handleSelectPreset = useCallback((nextId: TraversePresetId) => {
    const preset = TRAVERSE_PRESETS[nextId];
    setPresetId(nextId);
    setMaxSlopeDeg(preset.maxSlopeDeg);
    setWeatherLimits({ ...preset.limits });
  }, []);

  const handleChangeUiMode = useCallback(
    (nextMode: UiMode) => {
      if (nextMode === uiMode) return;
      setUiMode(nextMode);
      if (nextMode === "basic") {
        const preset = TRAVERSE_PRESETS[presetId];
        setMaxSlopeDeg(preset.maxSlopeDeg);
        setWeatherLimits({ ...preset.limits });
        setEditingPoint(null);
        setPendingPointCoord(null);
        setPendingPointElevM(null);
        setPickPointMode(false);
      }
    },
    [uiMode, presetId],
  );

  const openPointComposerAtCoord = useCallback(
    (coord: MarsCoord) => {
      if (uiMode === "basic") return;
      setEditingPoint(null);
      setPendingPointCoord(coord);
      setPendingPointElevM(null);
      setPickPointMode(false);
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
      setPickPointMode(false);
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

  const simSolDisplay = resolveSolDisplay(weatherSnapshot?.sol, simLmstHour);
  const simClockLabel = formatLmstClock(simLmstHour);

  const localCursorWeather = useMemo(() => {
    if (cursorElevM === null || !weatherSnapshot) return null;
    return estimateLocalWeatherAtElevation(cursorElevM, simLmstHour, weatherSnapshot);
  }, [cursorElevM, simLmstHour, weatherSnapshot]);

  const registry = useMemo(() => {
    const reg = new ToolRegistry();

    reg.register({
      id: "route",
      shortLabel: "RTE",
      title: "Route Planner",
      order: 1,
      render: () => (
        <RoutePlannerPanel
          uiMode={uiMode}
          presetId={presetId}
          onSelectPreset={handleSelectPreset}
          siteCompactLabel={siteLabels.sizeCompact}
          maxSlopeDeg={maxSlopeDeg}
          onChangeMaxSlopeDeg={setMaxSlopeDeg}
          weatherRoutingEnabled={weatherRoutingEnabled}
          onToggleWeatherRouting={() => setWeatherRoutingEnabled((v) => !v)}
          weatherLimits={weatherLimits}
          simClockLabel={simClockLabel}
          waypointA={waypointA}
          waypointB={waypointB}
          onSwapWaypoints={() => {
            if (!waypointA || !waypointB) return;
            setWaypointA(waypointB);
            setWaypointB(waypointA);
            setHoveredProfilePoint(null);
          }}
          onClearWaypoints={() => {
            setWaypointA(null);
            setWaypointB(null);
            setHoveredProfilePoint(null);
          }}
          lonFormat={lonFormat}
          routePlan={routePlan}
          selectedRoute={selectedRoute}
          onSelectRoute={setSelectedRouteId}
          routingBusy={routingBusy}
          siteError={siteError}
          onHoverProfilePoint={setHoveredProfilePoint}
          weatherEval={weatherEval}
          onOpenWeatherPanel={() => {
            setActiveToolId("weather");
            setPanelOpen(true);
          }}
        />
      ),
    });

    reg.register({
      id: "points",
      shortLabel: "PTS",
      title: "Points",
      order: 2,
      render: () => (
        <PointsPanel
          readOnly={uiMode === "basic"}
          classes={pointClasses}
          points={points}
          hiddenClassIds={hiddenClassIds}
          lonFormat={lonFormat}
          pendingCoord={pendingPointCoord}
          pendingElevM={pendingPointElevM}
          editingPoint={editingPoint}
          selectedPointId={selectedPointId}
          pickMode={pickPointMode}
          onTogglePickMode={() => setPickPointMode((v) => !v)}
          onCancelDraft={() => {
            setEditingPoint(null);
            setPendingPointCoord(null);
            setPendingPointElevM(null);
            setPickPointMode(false);
          }}
          onSavePoint={handleSavePoint}
          onStartEditPoint={handleStartEditPoint}
          onDeletePoint={handleDeletePoint}
          onFocusPoint={handleFocusPoint}
          onUseAsWaypointA={(c) => {
            setWaypointA(c);
            setActiveToolId("route");
            setPanelOpen(true);
          }}
          onUseAsWaypointB={(c) => {
            setWaypointB(c);
            setActiveToolId("route");
            setPanelOpen(true);
          }}
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
      id: "weather",
      shortLabel: "WXR",
      title: "Weather & EVA",
      order: 3,
      render: () => (
        <WeatherPanel
          uiMode={uiMode}
          presetId={presetId}
          onSelectPreset={handleSelectPreset}
          weather={weatherSnapshot}
          evaluation={weatherEval}
          limits={weatherLimits}
          scenario={weatherScenario}
          simLmstHour={simLmstHour}
          isPlayingTime={isPlayingTime}
          loading={weatherBusy}
          error={weatherError}
          hasSelectedRoute={selectedRoute !== null}
          onChangeLimits={setWeatherLimits}
          onResetLimits={() => setWeatherLimits(DEFAULT_EVA_WEATHER_LIMITS)}
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
      id: "layers",
      shortLabel: "LYR",
      title: "Map Layers",
      order: 4,
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

          <TimeSimulationControl
            compact
            lmstHour={simLmstHour}
            isPlaying={isPlayingTime}
            baseSol={weatherSnapshot?.sol}
            weather={weatherSnapshot}
            evaluation={weatherEval}
            onChangeHour={handleChangeSimHour}
            onJumpHour={handleJumpSimHour}
            onTogglePlay={handleTogglePlayTime}
          />
        </>
      ),
    });

    reg.register({
      id: "settings",
      shortLabel: "SET",
      title: "Settings",
      order: 5,
      render: () => (
        <>
          <div className="panel-header">
            <h1 className="panel-title">Settings</h1>
            <p className="panel-desc">
              {uiMode === "basic"
                ? `Mission preset filters passable edges in the ${siteLabels.sizeCompact} km terrain graph.`
                : `Slope threshold in degrees filters passable edges in the ${siteLabels.sizeCompact} km terrain graph.`}
            </p>
            <div className="panel-rule" />
          </div>

          {uiMode === "basic" ? (
            <TraversePresetControl presetId={presetId} onSelectPreset={handleSelectPreset} />
          ) : (
            <MaxSlopeControl valueDeg={maxSlopeDeg} onChange={setMaxSlopeDeg} />
          )}

          {routePlan && (
            <div className="readout-card">
              <span className="value-label">GRAPH PASSABILITY</span>
              <span className="readout-number">
                {(routePlan.passableEdgeRatio * 100).toFixed(1)}%
              </span>
              <span className="readout-sub">Edges at or below {maxSlopeDeg.toFixed(1)}°</span>
            </div>
          )}

          <div className="divider" />

          <div className="field-label-row">
            <span className="value-label">LONGITUDE CONVENTION</span>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                type="button"
                className={`compact-btn ${lonFormat === "180" ? "is-active" : ""}`}
                onClick={() => setLonFormat("180")}
              >
                -180..180
              </button>
              <button
                type="button"
                className={`compact-btn ${lonFormat === "360" ? "is-active" : ""}`}
                onClick={() => setLonFormat("360")}
              >
                0..360E
              </button>
            </div>
          </div>

          {site && (
            <div className="readout-card">
              <span className="value-label">TERRAIN GRAPH GRID</span>
              <span className="mono-value">
                {site.cols} x {site.rows} NODES ({site.cellSizeMeters} m)
              </span>
              <span className="readout-sub">
                ELEV {site.minElevationM.toFixed(0)} m .. {site.maxElevationM.toFixed(0)} m
              </span>
            </div>
          )}

          <button
            type="button"
            className="chamfer-btn is-primary"
            onClick={() => setFocusCount((c) => c + 1)}
          >
            <span className="chamfer-btn-body">
              <span className="chamfer-btn-label">FOCUS {siteLabels.sizeUpper} SITE</span>
            </span>
            <span className="chamfer-btn-arrow">→</span>
          </button>
        </>
      ),
    });

    return reg;
  }, [
    maxSlopeDeg,
    weatherRoutingEnabled,
    simLmstHour,
    simClockLabel,
    isPlayingTime,
    handleChangeSimHour,
    handleJumpSimHour,
    handleTogglePlayTime,
    waypointA,
    waypointB,
    lonFormat,
    routePlan,
    selectedRoute,
    routingBusy,
    siteError,
    layers,
    uiMode,
    presetId,
    handleSelectPreset,
    activeLayerId,
    showHillshade,
    showSlopeHazard,
    showPressureLayer,
    showTemperatureLayer,
    showSiteBounds,
    showPointsOverlay,
    site,
    siteLabels,
    pointClasses,
    points,
    hiddenClassIds,
    pendingPointCoord,
    pendingPointElevM,
    editingPoint,
    selectedPointId,
    pickPointMode,
    handleSavePoint,
    handleStartEditPoint,
    handleDeletePoint,
    handleFocusPoint,
    handleCreateCustomClass,
    handleDeleteCustomClass,
    weatherSnapshot,
    weatherEval,
    weatherLimits,
    weatherScenario,
    weatherBusy,
    weatherError,
    loadWeatherSnapshot,
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
          {weatherEval && (
            <button
              type="button"
              className={`topbar-wxr-btn ${evaStatusClass(weatherEval.status)}`}
              onClick={() => {
                setActiveToolId("weather");
                setPanelOpen(true);
              }}
              title={weatherEval.weatherSource.sourceLabel}
            >
              <span>EVA {weatherEval.status}</span>
              {weatherEval.weatherSource.isSimulated && <span>SIM</span>}
            </button>
          )}
        </div>
      </header>

      <main className="workspace">
        <MapView
          site={site}
          activeBaseLayer={activeBaseLayer}
          showHillshade={showHillshade}
          showSlopeHazard={showSlopeHazard}
          showPressureLayer={showPressureLayer}
          showTemperatureLayer={showTemperatureLayer}
          showSiteBounds={showSiteBounds}
          maxSlopeDeg={maxSlopeDeg}
          weatherScenario={weatherScenario}
          simLmstHour={simLmstHour}
          weatherSol={weatherSnapshot?.sol}
          minPressurePa={weatherLimits.minPressurePa}
          minAirTempC={weatherLimits.minAirTempC}
          waypointA={waypointA}
          waypointB={waypointB}
          routes={routePlan?.routes ?? []}
          selectedRouteId={selectedRoute?.id ?? null}
          hoveredProfilePoint={hoveredProfilePoint}
          points={visiblePoints}
          pointClasses={pointClasses}
          selectedPointId={selectedPointId}
          pickMode={uiMode === "advance" && pickPointMode}
          readOnlyPoints={uiMode === "basic"}
          focusPointTrigger={focusPointTrigger}
          leftInsetPx={leftHudOffset}
          focusRequestCount={focusCount}
          zoomStepTrigger={zoomTrigger}
          onCursorMove={handleCursorMove}
          onScaleUpdate={(label, widthPx, zoom) => setScaleHud({ label, widthPx, zoom })}
          onOpenContextMenu={(x, y, coord) => setContextMenu({ x, y, coord })}
          onCloseContextMenu={() => setContextMenu(null)}
          onSelectRoute={setSelectedRouteId}
          onPickPointCoord={openPointComposerAtCoord}
          onSelectPoint={(id) => setSelectedPointId(id)}
          onPointSetA={(c) => {
            setWaypointA(c);
            setActiveToolId("route");
            setPanelOpen(true);
          }}
          onPointSetB={(c) => {
            setWaypointB(c);
            setActiveToolId("route");
            setPanelOpen(true);
          }}
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
              {localCursorWeather && (
                <span className="hud-sub">
                  {localCursorWeather.pressurePa.toFixed(0)} Pa ·{" "}
                  {localCursorWeather.tempC.toFixed(1)} °C
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
              {(showPressureLayer || showTemperatureLayer) && (
                <div className="hud-legend-stack">
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
                        <span>LIMIT &gt;= {weatherLimits.minPressurePa.toFixed(0)} Pa</span>
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
                        <span>LIMIT &gt;= {weatherLimits.minAirTempC.toFixed(0)} °C</span>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="hud-readout is-right is-interactive">
                <span className="value-label">MAX SLOPE LIMIT</span>
                <span className="hud-number">{maxSlopeDeg.toFixed(1)}°</span>
              </div>
            </div>
          </div>
        </div>

        {contextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            coord={contextMenu.coord}
            hasWaypoints={waypointA !== null || waypointB !== null}
            canAddPoint={uiMode === "advance"}
            onSetA={(c) => {
              setWaypointA(c);
              setActiveToolId("route");
              setPanelOpen(true);
            }}
            onSetB={(c) => {
              setWaypointB(c);
              setActiveToolId("route");
              setPanelOpen(true);
            }}
            onAddPoint={openPointComposerAtCoord}
            onClear={() => {
              setWaypointA(null);
              setWaypointB(null);
              setHoveredProfilePoint(null);
            }}
            onClose={() => setContextMenu(null)}
          />
        )}
      </main>
    </div>
  );
}
