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
import { ElevationProfile } from "./components/ElevationProfile";
import { MapView } from "./components/MapView";
import { MaxSlopeControl } from "./components/MaxSlopeControl";
import { PointsPanel } from "./components/PointsPanel";
import {
  TimeSimulationControl,
  clampSimLmstHour,
  estimateLocalWeatherAtElevation,
  formatLmstClock,
  resolveSolDisplay,
} from "./components/TimeSimulationControl";
import { WeatherPanel, evaStatusClass } from "./components/WeatherPanel";
import { ToolRegistry } from "./registry/toolRegistry";
import {
  DEFAULT_EVA_WEATHER_LIMITS,
  type EvaRouteWeatherContext,
  type EvaWeatherEvaluation,
  type EvaWeatherLimits,
  type MarsWeatherSnapshot,
  type RouteBlockedReason,
  type SiteEnvironmentSummary,
  type TraversePointSample,
  type WeatherScenario,
  evaluateWeatherConstraints,
  fetchBaseLayers,
  fetchElevation,
  fetchEnvironmentSummary,
  fetchSiteMeta,
  fetchWeatherSnapshot,
  planGraphRoutes,
} from "./services/api";
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

function formatDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`;
}

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

function formatBlockedReason(reason: RouteBlockedReason): string {
  if (reason === "slope") return "SLOPE LIMIT";
  if (reason === "temperature") return "AIR TEMP LIMIT";
  if (reason === "pressure") return "PRESSURE LIMIT";
  if (reason === "combined") return "SLOPE + WEATHER LIMITS";
  return "NO TERRAIN DATA";
}

export function App() {
  const [site, setSite] = useState<SiteMetadata | null>(null);
  const [siteError, setSiteError] = useState<string | null>(null);
  const [layers, setLayers] = useState([...MARS_BASE_LAYERS]);
  const [activeLayerId, setActiveLayerId] = useState(DEFAULT_MARS_BASE_LAYER.id);
  const [showHillshade, setShowHillshade] = useState(true);
  const [showSlopeHazard, setShowSlopeHazard] = useState(true);
  const [showPressureLayer, setShowPressureLayer] = useState(false);
  const [showTemperatureLayer, setShowTemperatureLayer] = useState(false);
  const [showSiteBounds, setShowSiteBounds] = useState(true);

  const [activeToolId, setActiveToolId] = useState("route");
  const [panelOpen, setPanelOpen] = useState(true);
  const [lonFormat, setLonFormat] = useState<LonFormat>("180");

  const [maxSlopeDeg, setMaxSlopeDeg] = useState(15);
  const [weatherRoutingEnabled, setWeatherRoutingEnabled] = useState(true);
  const [waypointA, setWaypointA] = useState<MarsCoord | null>(null);
  const [waypointB, setWaypointB] = useState<MarsCoord | null>(null);
  const [routePlan, setRoutePlan] = useState<RoutePlanResponse | null>(null);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
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
  const [showPointsOverlay, setShowPointsOverlay] = useState(true);
  const [pendingPointCoord, setPendingPointCoord] = useState<MarsCoord | null>(null);
  const [pendingPointElevM, setPendingPointElevM] = useState<number | null>(null);
  const [editingPoint, setEditingPoint] = useState<MapPoint | null>(null);
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null);
  const [pickPointMode, setPickPointMode] = useState(false);
  const [focusPointTrigger, setFocusPointTrigger] = useState<{
    coord: MarsCoord;
    seq: number;
  } | null>(null);

  const [simLmstHour, setSimLmstHour] = useState(12);
  const [isPlayingTime, setIsPlayingTime] = useState(false);
  const [weatherLimits, setWeatherLimits] = useState<EvaWeatherLimits>(DEFAULT_EVA_WEATHER_LIMITS);
  const [weatherScenario, setWeatherScenario] = useState<WeatherScenario>("auto");
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

  const openPointComposerAtCoord = useCallback((coord: MarsCoord) => {
    setEditingPoint(null);
    setPendingPointCoord(coord);
    setPendingPointElevM(null);
    setPickPointMode(false);
    setActiveToolId("points");
    setPanelOpen(true);

    fetchElevation(coord.lat, coord.lon)
      .then((res) => setPendingPointElevM(res.elevationM))
      .catch(() => setPendingPointElevM(null));
  }, []);

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
    [],
  );

  const handleDeletePoint = useCallback((pointId: string) => {
    setPoints((prev) => prev.filter((pt) => pt.id !== pointId));
    setSelectedPointId((prev) => (prev === pointId ? null : prev));
    setEditingPoint((prev) => (prev?.id === pointId ? null : prev));
  }, []);

  const handleStartEditPoint = useCallback((point: MapPoint) => {
    setPendingPointCoord(null);
    setPendingPointElevM(point.elevationM ?? null);
    setEditingPoint(point);
    setSelectedPointId(point.id);
    setPickPointMode(false);
    setActiveToolId("points");
    setPanelOpen(true);
  }, []);

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
      setPointClasses((prev) => [...prev, createCustomPointClass(payload, prev)]);
    },
    [],
  );

  const handleDeleteCustomClass = useCallback((classId: string) => {
    setPointClasses((prev) => prev.filter((c) => c.id !== classId || c.builtIn));
    setHiddenClassIds((prev) => prev.filter((id) => id !== classId));
  }, []);

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
        <>
          <div className="panel-header">
            <h1 className="panel-title">Route Planner</h1>
            <p className="panel-desc">
              Right-click the map to place A and B inside the {siteLabels.sizeCompact} km terrain
              graph.
            </p>
            <div className="panel-rule" />
          </div>

          <MaxSlopeControl valueDeg={maxSlopeDeg} onChange={setMaxSlopeDeg} />

          <div className="rte-weather-block">
            <button
              type="button"
              className="toggle-row"
              onClick={() => setWeatherRoutingEnabled((v) => !v)}
            >
              <span className="value-label" style={{ color: "var(--color-text)" }}>
                WEATHER ROUTING
              </span>
              <span className={`toggle-state ${weatherRoutingEnabled ? "is-on" : ""}`}>
                {weatherRoutingEnabled ? "ON" : "OFF"}
              </span>
            </button>
            <div className="rte-weather-strip">
              <span className="readout-sub">
                {weatherRoutingEnabled
                  ? `T >= ${weatherLimits.minAirTempC.toFixed(0)} °C · P >= ${weatherLimits.minPressurePa.toFixed(0)} Pa · ${simClockLabel} LMST`
                  : `SLOPE ONLY · ${simClockLabel} LMST`}
              </span>
              <button
                type="button"
                className="compact-btn"
                onClick={() => {
                  setActiveToolId("weather");
                  setPanelOpen(true);
                }}
              >
                WXR
              </button>
            </div>
          </div>

          <div className="readout-grid">
            <div className="readout-card">
              <span className="value-label">WAYPOINT A</span>
              <span className="mono-value">
                {waypointA
                  ? `${waypointA.lat.toFixed(4)}°, ${formatLon(waypointA.lon, lonFormat)}`
                  : "UNSET"}
              </span>
              <span className="readout-sub">
                {routePlan?.snappedA
                  ? `${routePlan.snappedA.elevationM.toFixed(1)} m`
                  : "Right-click map"}
              </span>
            </div>
            <div className="readout-card">
              <span className="value-label">WAYPOINT B</span>
              <span className="mono-value">
                {waypointB
                  ? `${waypointB.lat.toFixed(4)}°, ${formatLon(waypointB.lon, lonFormat)}`
                  : "UNSET"}
              </span>
              <span className="readout-sub">
                {routePlan?.snappedB
                  ? `${routePlan.snappedB.elevationM.toFixed(1)} m`
                  : "Right-click map"}
              </span>
            </div>
          </div>

          {siteError && <div className="alert-box">{siteError}</div>}

          {routePlan && routePlan.status !== "ok" && (
            <div className="alert-box">
              <div>{routePlan.message ?? "No passable route found."}</div>
              {routePlan.status === "unreachable" && (
                <div className="rte-unreachable-meta">
                  {routePlan.blockedReason && (
                    <span>BLOCKED: {formatBlockedReason(routePlan.blockedReason)}</span>
                  )}
                  {routePlan.minRequiredSlopeDeg !== undefined && (
                    <span>MIN SLOPE NEEDED {routePlan.minRequiredSlopeDeg.toFixed(1)}°</span>
                  )}
                  {routePlan.maxFeasibleMinTempC !== undefined && (
                    <span>MAX FEASIBLE TEMP {routePlan.maxFeasibleMinTempC.toFixed(1)} °C</span>
                  )}
                  {routePlan.maxFeasibleMinPressurePa !== undefined && (
                    <span>
                      MAX FEASIBLE PRESS {routePlan.maxFeasibleMinPressurePa.toFixed(0)} Pa
                    </span>
                  )}
                  <button
                    type="button"
                    className="compact-btn"
                    onClick={() => {
                      setActiveToolId("weather");
                      setPanelOpen(true);
                    }}
                  >
                    OPEN BEST WINDOWS (WXR)
                  </button>
                </div>
              )}
            </div>
          )}

          {routingBusy && <span className="value-label">COMPUTING GRAPH PATHS...</span>}

          {routePlan && routePlan.routes.length > 0 && (
            <>
              <div className="nav-button-list">
                {routePlan.routes.map((rt) => {
                  const isPrimary = rt.id === selectedRoute?.id;
                  const hasTemp = rt.minTempC !== undefined && rt.maxTempC !== undefined;
                  const hasPress = rt.minPressurePa !== undefined;
                  return (
                    <button
                      key={rt.id}
                      type="button"
                      className={`chamfer-btn ${isPrimary ? "is-primary" : ""}`}
                      onClick={() => setSelectedRouteId(rt.id)}
                    >
                      <span className="chamfer-btn-body">
                        <span className="chamfer-btn-label">{rt.label}</span>
                        <span className="chamfer-btn-meta-stack">
                          <span className="chamfer-btn-meta">
                            {formatDistance(rt.totalDistanceM)} · {rt.maxSlopeDeg.toFixed(1)}°
                          </span>
                          {(hasTemp || hasPress) && (
                            <span className="chamfer-btn-submeta">
                              {hasTemp
                                ? `${rt.minTempC?.toFixed(0)}..${rt.maxTempC?.toFixed(0)} °C`
                                : ""}
                              {hasTemp && hasPress ? " · " : ""}
                              {hasPress ? `${rt.minPressurePa?.toFixed(0)} Pa` : ""}
                            </span>
                          )}
                        </span>
                      </span>
                      <span className="chamfer-btn-arrow">→</span>
                    </button>
                  );
                })}
              </div>

              {selectedRoute && (
                <>
                  <div className="readout-grid">
                    <div className="readout-card">
                      <span className="value-label">LENGTH</span>
                      <span className="readout-number">
                        {formatDistance(selectedRoute.totalDistanceM)}
                      </span>
                    </div>
                    <div className="readout-card">
                      <span className="value-label">PEAK SLOPE</span>
                      <span className="readout-number">
                        {selectedRoute.maxSlopeDeg.toFixed(1)}°
                      </span>
                    </div>
                    <div className="readout-card">
                      <span className="value-label">ELEV GAIN</span>
                      <span className="readout-number">
                        +{selectedRoute.elevationGainM.toFixed(0)} m
                      </span>
                    </div>
                    <div className="readout-card">
                      <span className="value-label">ELEV LOSS</span>
                      <span className="readout-number">
                        -{selectedRoute.elevationLossM.toFixed(0)} m
                      </span>
                    </div>
                    {selectedRoute.minTempC !== undefined &&
                      selectedRoute.maxTempC !== undefined && (
                        <div className="readout-card">
                          <span className="value-label">ROUTE TEMP</span>
                          <span className="mono-value">
                            {selectedRoute.minTempC.toFixed(1)}..
                            {selectedRoute.maxTempC.toFixed(1)} °C
                          </span>
                        </div>
                      )}
                    {selectedRoute.minPressurePa !== undefined && (
                      <div className="readout-card">
                        <span className="value-label">MIN PRESSURE</span>
                        <span className="mono-value">
                          {selectedRoute.minPressurePa.toFixed(0)} Pa
                        </span>
                        {selectedRoute.maxPressurePa !== undefined && (
                          <span className="readout-sub">
                            MAX {selectedRoute.maxPressurePa.toFixed(0)} Pa
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  <ElevationProfile
                    route={selectedRoute}
                    maxSlopeDeg={maxSlopeDeg}
                    onHoverPoint={setHoveredProfilePoint}
                  />

                  {weatherEval && (
                    <div className={`wx-verdict-card ${evaStatusClass(weatherEval.status)}`}>
                      <div className="wx-verdict-top">
                        <span className="value-label">ROUTE WEATHER</span>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span className={`wx-status-tag ${evaStatusClass(weatherEval.status)}`}>
                            {weatherEval.status}
                          </span>
                          <button
                            type="button"
                            className="compact-btn"
                            onClick={() => {
                              setActiveToolId("weather");
                              setPanelOpen(true);
                            }}
                          >
                            WXR
                          </button>
                        </div>
                      </div>
                      <span className="readout-sub">{weatherEval.summary}</span>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {(waypointA || waypointB) && (
            <button
              type="button"
              className="compact-btn"
              onClick={() => {
                setWaypointA(null);
                setWaypointB(null);
                setHoveredProfilePoint(null);
              }}
            >
              CLEAR WAYPOINTS
            </button>
          )}
        </>
      ),
    });

    reg.register({
      id: "points",
      shortLabel: "PTS",
      title: "Points",
      order: 2,
      render: () => (
        <PointsPanel
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
              Slope threshold in degrees filters passable edges in the {siteLabels.sizeCompact} km
              terrain graph.
            </p>
            <div className="panel-rule" />
          </div>

          <MaxSlopeControl valueDeg={maxSlopeDeg} onChange={setMaxSlopeDeg} />

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
          pickMode={pickPointMode}
          focusPointTrigger={focusPointTrigger}
          leftInsetPx={leftHudOffset}
          focusRequestCount={focusCount}
          zoomStepTrigger={zoomTrigger}
          onCursorMove={handleCursorMove}
          onScaleUpdate={(label, widthPx, zoom) => setScaleHud({ label, widthPx, zoom })}
          onOpenContextMenu={(x, y, coord) => setContextMenu({ x, y, coord })}
          onCloseContextMenu={() => setContextMenu(null)}
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
