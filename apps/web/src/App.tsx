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
import { ToolRegistry } from "./registry/toolRegistry";
import { fetchBaseLayers, fetchElevation, fetchSiteMeta, planGraphRoutes } from "./services/api";

function formatLon(lonDeg: number, fmt: LonFormat): string {
  const val = fmt === "360" ? lon180To360(lonDeg) : lonDeg;
  return `${val.toFixed(5)}°`;
}

function formatDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`;
}

export function App() {
  const [site, setSite] = useState<SiteMetadata | null>(null);
  const [siteError, setSiteError] = useState<string | null>(null);
  const [layers, setLayers] = useState([...MARS_BASE_LAYERS]);
  const [activeLayerId, setActiveLayerId] = useState(DEFAULT_MARS_BASE_LAYER.id);
  const [showHillshade, setShowHillshade] = useState(true);
  const [showSlopeHazard, setShowSlopeHazard] = useState(true);
  const [showSiteBounds, setShowSiteBounds] = useState(true);

  const [activeToolId, setActiveToolId] = useState("route");
  const [panelOpen, setPanelOpen] = useState(true);
  const [lonFormat, setLonFormat] = useState<LonFormat>("180");

  const [maxSlopeDeg, setMaxSlopeDeg] = useState(15);
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

  // Debounced elevation readout for cursor inside 3x3 km bounds
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

  // Recompute terrain graph routes whenever A, B, or maxSlopeDeg changes
  useEffect(() => {
    if (!waypointA || !waypointB) {
      setRoutePlan(null);
      setSelectedRouteId(null);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      setRoutingBusy(true);
      planGraphRoutes({ waypointA, waypointB, maxSlopeDeg })
        .then((res) => {
          if (cancelled) return;
          setRoutePlan(res);
          setSelectedRouteId((prev) =>
            res.routes.some((r) => r.id === prev) ? prev : (res.routes[0]?.id ?? null),
          );
        })
        .catch((err: unknown) => {
          if (cancelled) return;
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
    }, 80);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [waypointA, waypointB, maxSlopeDeg]);

  const activeBaseLayer = useMemo(
    () => layers.find((l) => l.id === activeLayerId) ?? layers[0] ?? DEFAULT_MARS_BASE_LAYER,
    [layers, activeLayerId],
  );

  const selectedRoute = useMemo(
    () => routePlan?.routes.find((r) => r.id === selectedRouteId) ?? routePlan?.routes[0] ?? null,
    [routePlan, selectedRouteId],
  );

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
              Right-click the map to place A and B inside the 3x3 km terrain graph.
            </p>
            <div className="panel-rule" />
          </div>

          <MaxSlopeControl valueDeg={maxSlopeDeg} onChange={setMaxSlopeDeg} />

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
            <div className="alert-box">{routePlan.message}</div>
          )}

          {routingBusy && <span className="value-label">COMPUTING GRAPH PATHS...</span>}

          {routePlan && routePlan.routes.length > 0 && (
            <>
              <div className="nav-button-list">
                {routePlan.routes.map((rt) => {
                  const isPrimary = rt.id === selectedRoute?.id;
                  return (
                    <button
                      key={rt.id}
                      type="button"
                      className={`chamfer-btn ${isPrimary ? "is-primary" : ""}`}
                      onClick={() => setSelectedRouteId(rt.id)}
                    >
                      <span className="chamfer-btn-body">
                        <span className="chamfer-btn-label">{rt.label}</span>
                        <span className="chamfer-btn-meta">
                          {formatDistance(rt.totalDistanceM)} · {rt.maxSlopeDeg.toFixed(1)}°
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
                  </div>

                  <ElevationProfile
                    route={selectedRoute}
                    maxSlopeDeg={maxSlopeDeg}
                    onHoverPoint={setHoveredProfilePoint}
                  />
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
      id: "layers",
      shortLabel: "LYR",
      title: "Map Layers",
      order: 2,
      render: () => (
        <>
          <div className="panel-header">
            <h1 className="panel-title">Map Layers</h1>
            <p className="panel-desc">
              Global USGS and Mars Trek basemaps paired with the 3x3 km HiRISE terrain patch.
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
              3X3 KM HIRISE HILLSHADE
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

          <button type="button" className="toggle-row" onClick={() => setShowSiteBounds((v) => !v)}>
            <span className="value-label" style={{ color: "var(--color-text)" }}>
              3X3 KM BOUNDARY FRAME
            </span>
            <span className={`toggle-state ${showSiteBounds ? "is-on" : ""}`}>
              {showSiteBounds ? "ON" : "OFF"}
            </span>
          </button>
        </>
      ),
    });

    reg.register({
      id: "settings",
      shortLabel: "SET",
      title: "Settings",
      order: 3,
      render: () => (
        <>
          <div className="panel-header">
            <h1 className="panel-title">Settings</h1>
            <p className="panel-desc">
              Slope threshold in degrees filters passable edges in the 3x3 km terrain graph.
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
              <span className="chamfer-btn-label">FOCUS 3X3 KM SITE</span>
            </span>
            <span className="chamfer-btn-arrow">→</span>
          </button>
        </>
      ),
    });

    return reg;
  }, [
    maxSlopeDeg,
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
    showSiteBounds,
    site,
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
                PATCH <strong>3.0 x 3.0 KM</strong>
              </span>
            </>
          )}
        </div>
      </header>

      <main className="workspace">
        <MapView
          site={site}
          activeBaseLayer={activeBaseLayer}
          showHillshade={showHillshade}
          showSlopeHazard={showSlopeHazard}
          showSiteBounds={showSiteBounds}
          maxSlopeDeg={maxSlopeDeg}
          waypointA={waypointA}
          waypointB={waypointB}
          routes={routePlan?.routes ?? []}
          selectedRouteId={selectedRoute?.id ?? null}
          hoveredProfilePoint={hoveredProfilePoint}
          leftInsetPx={leftHudOffset}
          focusRequestCount={focusCount}
          zoomStepTrigger={zoomTrigger}
          onCursorMove={handleCursorMove}
          onScaleUpdate={(label, widthPx, zoom) => setScaleHud({ label, widthPx, zoom })}
          onOpenContextMenu={(x, y, coord) => setContextMenu({ x, y, coord })}
          onCloseContextMenu={() => setContextMenu(null)}
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
                  3X3 KM
                </button>
              </div>
            </div>

            <div className="hud-readout is-right is-interactive">
              <span className="value-label">MAX SLOPE LIMIT</span>
              <span className="hud-number">{maxSlopeDeg.toFixed(1)}°</span>
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
