import {
  type ComputedRoute,
  type MapLayerMeta,
  type MarsCoord,
  type MissionUnitId,
  type RoutePoint,
  type SiteMetadata,
  type UnitSimulationSample,
  type WeatherScenario,
  buildDirectMarsTileUrl,
  normalizeLon180,
  surfaceDistanceMeters,
} from "@nimbs/shared";
import L from "leaflet";
import { type RefObject, useCallback, useEffect, useRef } from "react";
import {
  STATIC_HILLSHADE_URL,
  renderPressureMaskUrl,
  renderSlopeMaskUrl,
  renderSoilMaskUrl,
  renderTemperatureMaskUrl,
} from "../services/api";
import { UNIT_ACCENT_COLORS } from "../services/dualSim";
import type { MapPoint, MapPointClass } from "../services/pointStore";
import { createPointIconSvgElement } from "./PointClassIcon";
import { formatRouteDistance, getRouteStrategyVisual } from "./routeVisuals";

export interface MapUnitDisplay {
  unitId: MissionUnitId;
  waypoints: MarsCoord[];
  routes: ComputedRoute[];
  selectedRouteId: string | null;
  simPosition?: UnitSimulationSample | null;
}

interface MapViewProps {
  site: SiteMetadata | null;
  activeBaseLayer: MapLayerMeta;
  showHillshade: boolean;
  showSoilLayer: boolean;
  showSlopeHazard: boolean;
  showPressureLayer: boolean;
  showTemperatureLayer: boolean;
  showSiteBounds: boolean;
  maxSlopeDeg: number;
  weatherScenario: WeatherScenario;
  simLmstHour: number;
  weatherSol?: number;
  minPressurePa: number;
  minAirTempC: number;
  activeUnitId: MissionUnitId;
  unit1: MapUnitDisplay;
  unit2: MapUnitDisplay;
  isSimMode: boolean;
  moveWaypoints?: boolean;
  hoveredProfilePoint: RoutePoint | null;
  points: MapPoint[];
  pointClasses: MapPointClass[];
  selectedPointId: string | null;
  readOnlyPoints?: boolean;
  focusPointTrigger: { coord: MarsCoord; seq: number } | null;
  leftInsetPx?: number;
  focusRequestCount: number;
  zoomStepTrigger: { delta: number; seq: number } | null;
  onCursorMove: (coord: MarsCoord | null) => void;
  onScaleUpdate: (label: string, widthPx: number, zoom: number) => void;
  onOpenContextMenu: (x: number, y: number, coord: MarsCoord) => void;
  onCloseContextMenu: () => void;
  onSelectRoute?: (unitId: MissionUnitId, routeId: string) => void;
  onDragWaypoint?: (unitId: MissionUnitId, index: number, coord: MarsCoord) => void;
  onSelectPoint: (pointId: string) => void;
  onPointAppendWaypoint: (coord: MarsCoord) => void;
  onPointInsertWaypoint: (coord: MarsCoord) => void;
  onEditPoint: (point: MapPoint) => void;
  onDeletePoint: (pointId: string) => void;
}

const NICE_SCALE_METERS = [
  50, 100, 200, 500, 1000, 2000, 5000, 10000, 25000, 50000, 100000, 500000,
];

function buildPointIconHtml(
  point: MapPoint,
  cls: MapPointClass | undefined,
  selected: boolean,
): string {
  const color = cls?.color ?? "#38bdf8";
  const wrap = document.createElement("div");
  wrap.className = `poi-marker-wrap${selected ? " is-selected" : ""}`;

  const pin = document.createElement("div");
  pin.className = "poi-pin";
  pin.style.borderColor = color;
  pin.appendChild(createPointIconSvgElement(point.icon ?? cls?.icon ?? "marker", color, 13));

  const label = document.createElement("span");
  label.className = "poi-label";
  label.textContent = point.name;

  wrap.appendChild(pin);
  wrap.appendChild(label);
  return wrap.outerHTML;
}

function buildPointPopupElement(
  point: MapPoint,
  cls: MapPointClass | undefined,
  activeUnitId: MissionUnitId,
  nextWaypointNumber: number,
  showEditActions: boolean,
  actions: {
    onAppendWaypoint: (coord: MarsCoord) => void;
    onInsertWaypoint: (coord: MarsCoord) => void;
    onEdit: (point: MapPoint) => void;
    onDelete: (id: string) => void;
  },
): HTMLElement {
  const color = cls?.color ?? "#38bdf8";
  const root = document.createElement("div");
  root.className = "poi-popup";

  const head = document.createElement("div");
  head.className = "poi-popup-head";
  const badge = document.createElement("span");
  badge.className = "poi-badge";
  badge.style.borderColor = color;
  badge.style.color = color;
  badge.appendChild(createPointIconSvgElement(point.icon ?? cls?.icon ?? "marker", color, 12));
  const badgeLabel = document.createElement("span");
  badgeLabel.textContent = `${cls?.shortCode ?? "POI"} · ${cls?.name ?? point.classId}`;
  badge.appendChild(badgeLabel);
  head.appendChild(badge);
  root.appendChild(head);

  const title = document.createElement("div");
  title.className = "poi-popup-title";
  title.textContent = point.name;
  root.appendChild(title);

  if (point.description) {
    const desc = document.createElement("div");
    desc.className = "poi-popup-desc";
    desc.textContent = point.description;
    root.appendChild(desc);
  }

  const coords = document.createElement("div");
  coords.className = "poi-popup-coords";
  const elevPart =
    point.elevationM !== null && point.elevationM !== undefined
      ? ` · ${point.elevationM.toFixed(1)} m`
      : "";
  coords.textContent = `${point.coord.lat.toFixed(5)}°, ${point.coord.lon.toFixed(5)}°${elevPart}`;
  root.appendChild(coords);

  const bar = document.createElement("div");
  bar.className = "poi-popup-actions";
  const addAction = (label: string, fn: () => void) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "compact-btn";
    btn.textContent = label;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      fn();
    });
    bar.appendChild(btn);
  };
  addAction(`+ U${activeUnitId} #${nextWaypointNumber}`, () =>
    actions.onAppendWaypoint(point.coord),
  );
  if (nextWaypointNumber > 2) {
    addAction("MID", () => actions.onInsertWaypoint(point.coord));
  }
  if (showEditActions) {
    addAction("EDIT", () => actions.onEdit(point));
    addAction("DEL", () => actions.onDelete(point.id));
  }
  root.appendChild(bar);

  return root;
}

const RASTER_PANE_NAME = "terrainRasterPane";

class DirectMarsTileLayer extends L.TileLayer {
  private readonly layerId: string;

  constructor(layerId: string, urlTemplate: string, options?: L.TileLayerOptions) {
    super(urlTemplate, options);
    this.layerId = layerId;
  }

  override getTileUrl(coords: L.Coords): string {
    return buildDirectMarsTileUrl(this.layerId, coords.z, coords.x, coords.y) ?? "";
  }
}

function useDebouncedSiteOverlay(options: {
  mapRef: RefObject<L.Map | null>;
  site: SiteMetadata | null;
  visible: boolean;
  renderUrl: (signal: AbortSignal) => Promise<string>;
  opacity: number;
  zIndex: number;
  debounceMs: number;
}) {
  const { mapRef, site, visible, renderUrl, opacity, zIndex, debounceMs } = options;
  const overlayRef = useRef<L.ImageOverlay | null>(null);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !site) return;

    if (!visible) {
      if (overlayRef.current) {
        overlayRef.current.removeFrom(map);
        overlayRef.current = null;
      }
      return;
    }

    const [west, south, east, north] = site.bbox;
    const bounds = L.latLngBounds([south, west], [north, east]);
    let cancelled = false;
    const controller = new AbortController();

    const applyOverlay = () => {
      renderUrl(controller.signal)
        .then((blobUrl) => {
          if (cancelled) return;
          if (overlayRef.current) {
            overlayRef.current.setBounds(bounds);
            overlayRef.current.setOpacity(opacity);
            overlayRef.current.setZIndex(zIndex);
            overlayRef.current.setUrl(blobUrl);
          } else {
            overlayRef.current = L.imageOverlay(blobUrl, bounds, {
              opacity,
              pane: RASTER_PANE_NAME,
              zIndex,
            }).addTo(map);
          }
        })
        .catch(() => {
          // Ignore aborted or failed intermediate overlay updates
        });
    };

    if (!overlayRef.current) {
      applyOverlay();
      return () => {
        cancelled = true;
        controller.abort();
      };
    }

    const timer = window.setTimeout(applyOverlay, debounceMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [mapRef, site, visible, renderUrl, opacity, zIndex, debounceMs]);
}

export function MapView({
  site,
  activeBaseLayer,
  showHillshade,
  showSoilLayer,
  showSlopeHazard,
  showPressureLayer,
  showTemperatureLayer,
  showSiteBounds,
  maxSlopeDeg,
  weatherScenario,
  simLmstHour,
  weatherSol,
  minPressurePa,
  minAirTempC,
  activeUnitId,
  unit1,
  unit2,
  isSimMode,
  moveWaypoints = false,
  hoveredProfilePoint,
  points,
  pointClasses,
  selectedPointId,
  readOnlyPoints = false,
  focusPointTrigger,
  leftInsetPx = 0,
  focusRequestCount,
  zoomStepTrigger,
  onCursorMove,
  onScaleUpdate,
  onOpenContextMenu,
  onCloseContextMenu,
  onSelectRoute,
  onDragWaypoint,
  onSelectPoint,
  onPointAppendWaypoint,
  onPointInsertWaypoint,
  onEditPoint,
  onDeletePoint,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const baseLayerRef = useRef<L.TileLayer | null>(null);
  const hillshadeRef = useRef<L.ImageOverlay | null>(null);
  const boundsRectRef = useRef<L.Rectangle | null>(null);
  const routesGroupRef = useRef<L.LayerGroup | null>(null);
  const markersGroupRef = useRef<L.LayerGroup | null>(null);
  const simMoversGroupRef = useRef<L.LayerGroup | null>(null);
  const pointsGroupRef = useRef<L.LayerGroup | null>(null);
  const hoverMarkerRef = useRef<L.Marker | null>(null);
  const leftInsetRef = useRef(leftInsetPx);
  leftInsetRef.current = leftInsetPx;
  const activeNextNumRef = useRef(1);
  activeNextNumRef.current =
    (activeUnitId === 1 ? unit1.waypoints.length : unit2.waypoints.length) + 1;

  const callbacksRef = useRef({
    onCursorMove,
    onScaleUpdate,
    onOpenContextMenu,
    onCloseContextMenu,
    onSelectRoute,
    onDragWaypoint,
    onSelectPoint,
    onPointAppendWaypoint,
    onPointInsertWaypoint,
    onEditPoint,
    onDeletePoint,
  });
  callbacksRef.current = {
    onCursorMove,
    onScaleUpdate,
    onOpenContextMenu,
    onCloseContextMenu,
    onSelectRoute,
    onDragWaypoint,
    onSelectPoint,
    onPointAppendWaypoint,
    onPointInsertWaypoint,
    onEditPoint,
    onDeletePoint,
  };

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      crs: L.CRS.EPSG4326,
      center: [18.46, 77.523],
      zoom: 13,
      minZoom: 1,
      maxZoom: 17,
      zoomControl: false,
      attributionControl: false,
    });

    const updateScale = () => {
      const size = map.getSize();
      const y = Math.floor(size.y / 2);
      const p1 = map.containerPointToLatLng([Math.floor(size.x / 2), y]);
      const p2 = map.containerPointToLatLng([Math.floor(size.x / 2) + 120, y]);
      const meters120 = surfaceDistanceMeters(
        { lat: p1.lat, lon: normalizeLon180(p1.lng) },
        { lat: p2.lat, lon: normalizeLon180(p2.lng) },
      );
      const metersPerPx = meters120 / 120;
      if (!Number.isFinite(metersPerPx) || metersPerPx <= 0) return;

      let chosen = NICE_SCALE_METERS[0] ?? 100;
      for (const m of NICE_SCALE_METERS) {
        if (m / metersPerPx <= 110) {
          chosen = m;
        }
      }
      const widthPx = Math.max(24, Math.round(chosen / metersPerPx));
      const label = chosen >= 1000 ? `${chosen / 1000} km` : `${chosen} m`;
      callbacksRef.current.onScaleUpdate(label, widthPx, map.getZoom());
    };

    map.on("mousemove", (e: L.LeafletMouseEvent) => {
      callbacksRef.current.onCursorMove({
        lat: e.latlng.lat,
        lon: normalizeLon180(e.latlng.lng),
      });
    });

    map.on("mouseout", () => {
      callbacksRef.current.onCursorMove(null);
    });

    map.on("contextmenu", (e: L.LeafletMouseEvent) => {
      e.originalEvent.preventDefault();
      callbacksRef.current.onOpenContextMenu(e.originalEvent.clientX, e.originalEvent.clientY, {
        lat: e.latlng.lat,
        lon: normalizeLon180(e.latlng.lng),
      });
    });

    map.on("click", () => {
      callbacksRef.current.onCloseContextMenu();
    });

    map.on("movestart zoomstart", () => {
      callbacksRef.current.onCloseContextMenu();
    });

    map.on("zoomend moveend resize", updateScale);

    const rasterPane = map.createPane(RASTER_PANE_NAME);
    rasterPane.style.zIndex = "250";
    rasterPane.style.pointerEvents = "none";

    routesGroupRef.current = L.layerGroup().addTo(map);
    markersGroupRef.current = L.layerGroup().addTo(map);
    pointsGroupRef.current = L.layerGroup().addTo(map);
    simMoversGroupRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    updateScale();

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Update active basemap layer
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (baseLayerRef.current) {
      baseLayerRef.current.removeFrom(map);
    }

    const tileLayer = new DirectMarsTileLayer(activeBaseLayer.id, activeBaseLayer.tileUrlTemplate, {
      crossOrigin: "anonymous",
      tileSize: 256,
      minZoom: 0,
      maxZoom: 17,
      maxNativeZoom: activeBaseLayer.maxNativeZoom,
      noWrap: true,
      bounds: [
        [-90, -180],
        [90, 180],
      ],
    });
    tileLayer.addTo(map);
    tileLayer.bringToBack();
    baseLayerRef.current = tileLayer;
  }, [activeBaseLayer]);

  // Fit bounds when site loads or user requests focus
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !site) return;
    const [west, south, east, north] = site.bbox;
    map.fitBounds(
      [
        [south, west],
        [north, east],
      ],
      {
        paddingTopLeft: [leftInsetRef.current + 40, 48],
        paddingBottomRight: [40, 48],
        animate: focusRequestCount > 0,
      },
    );
  }, [site, focusRequestCount]);

  // Handle zoom buttons
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !zoomStepTrigger) return;
    map.setZoom(map.getZoom() + zoomStepTrigger.delta);
  }, [zoomStepTrigger]);

  // Render local DEM hillshade and site boundary box
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !site) return;
    const [west, south, east, north] = site.bbox;
    const bounds: L.LatLngBoundsExpression = [
      [south, west],
      [north, east],
    ];

    if (hillshadeRef.current) {
      hillshadeRef.current.removeFrom(map);
      hillshadeRef.current = null;
    }
    if (showHillshade) {
      hillshadeRef.current = L.imageOverlay(STATIC_HILLSHADE_URL, bounds, {
        opacity: 0.9,
        pane: RASTER_PANE_NAME,
        zIndex: 1,
      }).addTo(map);
    }

    if (boundsRectRef.current) {
      boundsRectRef.current.removeFrom(map);
      boundsRectRef.current = null;
    }
    if (showSiteBounds) {
      boundsRectRef.current = L.rectangle(bounds, {
        color: "#fff8f3",
        weight: 1,
        opacity: 0.6,
        fill: false,
        dashArray: "6 4",
        interactive: false,
      }).addTo(map);
    }
  }, [site, showHillshade, showSiteBounds]);

  const renderSlopeOverlay = useCallback(
    (signal: AbortSignal) => renderSlopeMaskUrl(maxSlopeDeg, signal),
    [maxSlopeDeg],
  );
  const renderSoilOverlay = useCallback((signal: AbortSignal) => renderSoilMaskUrl(signal), []);
  const renderTemperatureOverlay = useCallback(
    (signal: AbortSignal) =>
      renderTemperatureMaskUrl(
        {
          scenario: weatherScenario,
          sol: weatherSol,
          lmstHour: simLmstHour,
          minAirTempC,
        },
        signal,
      ),
    [weatherScenario, weatherSol, simLmstHour, minAirTempC],
  );
  const renderPressureOverlay = useCallback(
    (signal: AbortSignal) =>
      renderPressureMaskUrl(
        {
          scenario: weatherScenario,
          sol: weatherSol,
          lmstHour: simLmstHour,
          minPressurePa,
        },
        signal,
      ),
    [weatherScenario, weatherSol, simLmstHour, minPressurePa],
  );

  const fieldOverlayOpacity = showPressureLayer && showTemperatureLayer ? 0.56 : 0.74;

  useDebouncedSiteOverlay({
    mapRef,
    site,
    visible: showSoilLayer,
    renderUrl: renderSoilOverlay,
    opacity: 0.56,
    zIndex: 1,
    debounceMs: 80,
  });

  useDebouncedSiteOverlay({
    mapRef,
    site,
    visible: showTemperatureLayer,
    renderUrl: renderTemperatureOverlay,
    opacity: fieldOverlayOpacity,
    zIndex: 2,
    debounceMs: 160,
  });

  useDebouncedSiteOverlay({
    mapRef,
    site,
    visible: showPressureLayer,
    renderUrl: renderPressureOverlay,
    opacity: fieldOverlayOpacity,
    zIndex: 3,
    debounceMs: 160,
  });

  useDebouncedSiteOverlay({
    mapRef,
    site,
    visible: showSlopeHazard,
    renderUrl: renderSlopeOverlay,
    opacity: 0.78,
    zIndex: 4,
    debounceMs: 150,
  });

  const {
    unitId: u1Id,
    waypoints: u1Waypoints,
    routes: u1Routes,
    selectedRouteId: u1SelectedRouteId,
    simPosition: simPos1,
  } = unit1;
  const {
    unitId: u2Id,
    waypoints: u2Waypoints,
    routes: u2Routes,
    selectedRouteId: u2SelectedRouteId,
    simPosition: simPos2,
  } = unit2;

  // Render candidate and selected routes for both units with visual contrast halo + click selection
  useEffect(() => {
    const group = routesGroupRef.current;
    if (!group) return;
    group.clearLayers();

    const unitsToDraw = [
      { unitId: u1Id, routes: u1Routes, selectedRouteId: u1SelectedRouteId },
      { unitId: u2Id, routes: u2Routes, selectedRouteId: u2SelectedRouteId },
    ].sort((a, b) => (a.unitId === activeUnitId ? 1 : b.unitId === activeUnitId ? -1 : 0));

    for (const unit of unitsToDraw) {
      if (unit.routes.length === 0) continue;
      const isUnitActive = unit.unitId === activeUnitId;
      const unitColor = UNIT_ACCENT_COLORS[unit.unitId];
      const selectedRoute =
        unit.routes.find((r) => r.id === unit.selectedRouteId) ?? unit.routes[0] ?? null;

      if (isSimMode || !isUnitActive) {
        if (!selectedRoute) continue;
        const latlngs = selectedRoute.points.map((p): [number, number] => [p.lat, p.lon]);
        if (isSimMode) {
          L.polyline(latlngs, {
            color: "#050709",
            weight: 6.5,
            opacity: 0.78,
            interactive: false,
          }).addTo(group);
        }
        const line = L.polyline(latlngs, {
          color: unitColor,
          weight: isSimMode ? 3.5 : 2.5,
          opacity: isSimMode ? 0.96 : 0.62,
          dashArray: isSimMode ? undefined : "5 5",
          interactive: true,
        });
        line.bindTooltip(
          `U${unit.unitId} · ${formatRouteDistance(selectedRoute.totalDistanceM)} · ${selectedRoute.maxSlopeDeg.toFixed(1)}°`,
          {
            sticky: true,
            className: "route-map-tooltip",
            direction: "top",
            offset: [0, -6],
          },
        );
        line.on("click", (ev) => {
          L.DomEvent.stopPropagation(ev);
          callbacksRef.current.onSelectRoute?.(unit.unitId, selectedRoute.id);
        });
        line.addTo(group);
        continue;
      }

      const ordered = [...unit.routes].sort((a, b) =>
        a.id === selectedRoute?.id ? 1 : b.id === selectedRoute?.id ? -1 : 0,
      );

      for (const route of ordered) {
        const isSelected = route.id === selectedRoute?.id;
        const latlngs = route.points.map((p): [number, number] => [p.lat, p.lon]);
        const visual = getRouteStrategyVisual(route.strategy);
        const strokeColor = isSelected ? visual.selectedColor : visual.color;

        if (isSelected) {
          L.polyline(latlngs, {
            color: "#050709",
            weight: 6.5,
            opacity: 0.72,
            interactive: false,
          }).addTo(group);
        }

        const line = L.polyline(latlngs, {
          color: strokeColor,
          weight: isSelected ? 3.5 : 2.3,
          opacity: isSelected ? 0.98 : 0.78,
          dashArray: isSelected ? undefined : "6 5",
          interactive: true,
        });

        line.bindTooltip(
          `U${unit.unitId} ${visual.shortLabel} · ${formatRouteDistance(route.totalDistanceM)} · ${route.maxSlopeDeg.toFixed(1)}°`,
          {
            sticky: true,
            className: "route-map-tooltip",
            direction: "top",
            offset: [0, -6],
          },
        );

        line.on("click", (ev) => {
          L.DomEvent.stopPropagation(ev);
          callbacksRef.current.onSelectRoute?.(unit.unitId, route.id);
        });

        line.addTo(group);
      }
    }
  }, [
    u1Id,
    u1Routes,
    u1SelectedRouteId,
    u2Id,
    u2Routes,
    u2SelectedRouteId,
    activeUnitId,
    isSimMode,
  ]);

  // Render numbered waypoint pins (1, 2, 3...) colored by character
  useEffect(() => {
    const group = markersGroupRef.current;
    if (!group) return;
    group.clearLayers();

    for (const unit of [
      { unitId: u1Id, waypoints: u1Waypoints },
      { unitId: u2Id, waypoints: u2Waypoints },
    ]) {
      const secondaryClass = !isSimMode && unit.unitId !== activeUnitId ? " is-secondary" : "";
      const zBase = unit.unitId === activeUnitId ? 200 : 100;
      const total = unit.waypoints.length;

      unit.waypoints.forEach((wp, idx) => {
        const num = idx + 1;
        const isEnd = total > 1 && idx === total - 1;
        const roleClass = idx === 0 ? "is-start" : isEnd ? "is-end" : "is-mid";
        const canDrag = moveWaypoints && !isSimMode && unit.unitId === activeUnitId;
        const marker = L.marker([wp.lat, wp.lon], {
          zIndexOffset: (canDrag ? 700 : zBase) + idx,
          draggable: canDrag,
          autoPan: canDrag,
          icon: L.divIcon({
            className: "",
            html: `<div class="waypoint-pin is-u${unit.unitId} ${roleClass}${secondaryClass}${canDrag ? " is-draggable" : ""}">${num}</div>`,
            iconSize: [26, 24],
            iconAnchor: [13, 12],
          }),
          interactive: true,
        });
        marker.bindTooltip(canDrag ? `#${num} · DRAG` : `#${num}`, {
          direction: "top",
          offset: [0, -12],
          className: "route-map-tooltip",
        });
        if (canDrag) {
          marker.on("dragstart", () => {
            marker.closeTooltip();
            callbacksRef.current.onCloseContextMenu();
          });
          marker.on("drag", () => {
            const ll = marker.getLatLng();
            callbacksRef.current.onCursorMove({
              lat: ll.lat,
              lon: normalizeLon180(ll.lng),
            });
          });
          marker.on("dragend", () => {
            const ll = marker.getLatLng();
            callbacksRef.current.onDragWaypoint?.(unit.unitId, idx, {
              lat: ll.lat,
              lon: normalizeLon180(ll.lng),
            });
          });
        }
        marker.addTo(group);
      });
    }
  }, [u1Id, u1Waypoints, u2Id, u2Waypoints, activeUnitId, isSimMode, moveWaypoints]);

  // Render animated character simulation positions along routes
  const wpCount1 = u1Waypoints.length;
  const wpCount2 = u2Waypoints.length;
  useEffect(() => {
    const group = simMoversGroupRef.current;
    if (!group) return;
    group.clearLayers();

    for (const item of [
      { unitId: 1 as const, pos: simPos1, wpCount: wpCount1 },
      { unitId: 2 as const, pos: simPos2, wpCount: wpCount2 },
    ]) {
      const { unitId, pos, wpCount } = item;
      if (!pos) continue;
      if (!isSimMode && pos.elapsedHours <= 0) continue;

      const endTag = wpCount >= 2 ? `AT #${wpCount}` : "ARRIVED";
      const label = pos.arrived
        ? `U${unitId} ${endTag}`
        : `U${unitId} ${(pos.progressRatio * 100).toFixed(0)}% · ${(pos.speedMPerH / 1000).toFixed(1)} km/h`;

      const marker = L.marker([pos.lat, pos.lon], {
        zIndexOffset: 900 + unitId,
        icon: L.divIcon({
          className: "",
          html: `<div class="sim-mover-pin is-u${unitId} ${pos.arrived ? "is-arrived" : "is-walking"}"><span>U${unitId}</span></div>`,
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        }),
        interactive: true,
      });
      marker.bindTooltip(label, {
        direction: "top",
        offset: [0, -14],
        className: "route-map-tooltip",
      });
      marker.addTo(group);
    }
  }, [simPos1, simPos2, wpCount1, wpCount2, isSimMode]);

  // Render hovered point from Elevation Profile
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (hoverMarkerRef.current) {
      hoverMarkerRef.current.removeFrom(map);
      hoverMarkerRef.current = null;
    }

    if (hoveredProfilePoint) {
      hoverMarkerRef.current = L.marker([hoveredProfilePoint.lat, hoveredProfilePoint.lon], {
        icon: L.divIcon({
          className: "",
          html: '<div class="profile-hover-dot"></div>',
          iconSize: [10, 10],
          iconAnchor: [5, 5],
        }),
        interactive: false,
      }).addTo(map);
    }
  }, [hoveredProfilePoint]);

  // Pan map when user clicks FOCUS on a classified point card
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focusPointTrigger) return;
    map.panTo([focusPointTrigger.coord.lat, focusPointTrigger.coord.lon], { animate: true });
  }, [focusPointTrigger]);

  // Render classified user points filtered by visible classes
  useEffect(() => {
    const group = pointsGroupRef.current;
    if (!group) return;
    group.clearLayers();

    const classMap = new Map(pointClasses.map((c) => [c.id, c]));
    for (const point of points) {
      const cls = classMap.get(point.classId);
      const isSelected = point.id === selectedPointId;
      const marker = L.marker([point.coord.lat, point.coord.lon], {
        icon: L.divIcon({
          className: "",
          html: buildPointIconHtml(point, cls, isSelected),
          iconSize: [22, 22],
          iconAnchor: [11, 11],
        }),
      });

      marker.on("click", () => {
        callbacksRef.current.onSelectPoint(point.id);
      });

      marker.bindPopup(
        () =>
          buildPointPopupElement(
            point,
            cls,
            activeUnitId,
            activeNextNumRef.current,
            !readOnlyPoints,
            {
              onAppendWaypoint: (coord) => {
                marker.closePopup();
                callbacksRef.current.onPointAppendWaypoint(coord);
              },
              onInsertWaypoint: (coord) => {
                marker.closePopup();
                callbacksRef.current.onPointInsertWaypoint(coord);
              },
              onEdit: (pt) => {
                marker.closePopup();
                callbacksRef.current.onEditPoint(pt);
              },
              onDelete: (id) => {
                marker.closePopup();
                callbacksRef.current.onDeletePoint(id);
              },
            },
          ),
        { closeButton: false, minWidth: 210, maxWidth: 260 },
      );

      marker.addTo(group);
    }
  }, [points, pointClasses, selectedPointId, readOnlyPoints, activeUnitId]);

  return <div ref={containerRef} className="map-root" />;
}
