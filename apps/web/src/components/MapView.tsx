import {
  type ComputedRoute,
  type MapLayerMeta,
  type MarsCoord,
  type RoutePoint,
  type SiteMetadata,
  type WeatherScenario,
  normalizeLon180,
  surfaceDistanceMeters,
} from "@nimbs/shared";
import L from "leaflet";
import { type RefObject, useEffect, useMemo, useRef } from "react";
import type { MapPoint, MapPointClass } from "../services/pointStore";
import { createPointIconSvgElement } from "./PointClassIcon";
import { formatRouteDistance, getRouteStrategyVisual } from "./routeVisuals";

interface MapViewProps {
  site: SiteMetadata | null;
  activeBaseLayer: MapLayerMeta;
  showHillshade: boolean;
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
  waypointA: MarsCoord | null;
  waypointB: MarsCoord | null;
  routes: ComputedRoute[];
  selectedRouteId: string | null;
  hoveredProfilePoint: RoutePoint | null;
  points: MapPoint[];
  pointClasses: MapPointClass[];
  selectedPointId: string | null;
  pickMode: boolean;
  readOnlyPoints?: boolean;
  focusPointTrigger: { coord: MarsCoord; seq: number } | null;
  leftInsetPx?: number;
  focusRequestCount: number;
  zoomStepTrigger: { delta: number; seq: number } | null;
  onCursorMove: (coord: MarsCoord | null) => void;
  onScaleUpdate: (label: string, widthPx: number, zoom: number) => void;
  onOpenContextMenu: (x: number, y: number, coord: MarsCoord) => void;
  onCloseContextMenu: () => void;
  onSelectRoute?: (routeId: string) => void;
  onPickPointCoord: (coord: MarsCoord) => void;
  onSelectPoint: (pointId: string) => void;
  onPointSetA: (coord: MarsCoord) => void;
  onPointSetB: (coord: MarsCoord) => void;
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
  showEditActions: boolean,
  actions: {
    onSetA: (coord: MarsCoord) => void;
    onSetB: (coord: MarsCoord) => void;
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
  addAction("SET A", () => actions.onSetA(point.coord));
  addAction("SET B", () => actions.onSetB(point.coord));
  if (showEditActions) {
    addAction("EDIT", () => actions.onEdit(point));
    addAction("DEL", () => actions.onDelete(point.id));
  }
  root.appendChild(bar);

  return root;
}

const RASTER_PANE_NAME = "terrainRasterPane";

function useDebouncedSiteOverlay(options: {
  mapRef: RefObject<L.Map | null>;
  site: SiteMetadata | null;
  visible: boolean;
  url: string;
  opacity: number;
  zIndex: number;
  debounceMs: number;
}) {
  const { mapRef, site, visible, url, opacity, zIndex, debounceMs } = options;
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

    const applyOverlay = () => {
      if (overlayRef.current) {
        overlayRef.current.setBounds(bounds);
        overlayRef.current.setOpacity(opacity);
        overlayRef.current.setZIndex(zIndex);
        overlayRef.current.setUrl(url);
      } else {
        overlayRef.current = L.imageOverlay(url, bounds, {
          opacity,
          pane: RASTER_PANE_NAME,
          zIndex,
        }).addTo(map);
      }
    };

    if (!overlayRef.current) {
      applyOverlay();
      return;
    }

    const timer = window.setTimeout(applyOverlay, debounceMs);
    return () => window.clearTimeout(timer);
  }, [mapRef, site, visible, url, opacity, zIndex, debounceMs]);
}

export function MapView({
  site,
  activeBaseLayer,
  showHillshade,
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
  waypointA,
  waypointB,
  routes,
  selectedRouteId,
  hoveredProfilePoint,
  points,
  pointClasses,
  selectedPointId,
  pickMode,
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
  onPickPointCoord,
  onSelectPoint,
  onPointSetA,
  onPointSetB,
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
  const pointsGroupRef = useRef<L.LayerGroup | null>(null);
  const hoverMarkerRef = useRef<L.Marker | null>(null);
  const leftInsetRef = useRef(leftInsetPx);
  leftInsetRef.current = leftInsetPx;
  const pickModeRef = useRef(pickMode);
  pickModeRef.current = pickMode;

  const callbacksRef = useRef({
    onCursorMove,
    onScaleUpdate,
    onOpenContextMenu,
    onCloseContextMenu,
    onSelectRoute,
    onPickPointCoord,
    onSelectPoint,
    onPointSetA,
    onPointSetB,
    onEditPoint,
    onDeletePoint,
  });
  callbacksRef.current = {
    onCursorMove,
    onScaleUpdate,
    onOpenContextMenu,
    onCloseContextMenu,
    onSelectRoute,
    onPickPointCoord,
    onSelectPoint,
    onPointSetA,
    onPointSetB,
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

    map.on("click", (e: L.LeafletMouseEvent) => {
      callbacksRef.current.onCloseContextMenu();
      if (pickModeRef.current) {
        callbacksRef.current.onPickPointCoord({
          lat: e.latlng.lat,
          lon: normalizeLon180(e.latlng.lng),
        });
      }
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

    const tileLayer = L.tileLayer(activeBaseLayer.tileUrlTemplate, {
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
      hillshadeRef.current = L.imageOverlay("/api/site/hillshade.png", bounds, {
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

  const slopeMaskUrl = `/api/site/passability.png?maxSlopeDeg=${maxSlopeDeg.toFixed(1)}`;
  const temperatureUrl = useMemo(() => {
    const params = new URLSearchParams({
      scenario: weatherScenario,
      lmstHour: simLmstHour.toFixed(1),
      minAirTempC: String(Math.round(minAirTempC)),
    });
    if (weatherSol !== undefined) params.set("sol", String(weatherSol));
    return `/api/site/temperature.png?${params.toString()}`;
  }, [weatherScenario, simLmstHour, minAirTempC, weatherSol]);

  const pressureUrl = useMemo(() => {
    const params = new URLSearchParams({
      scenario: weatherScenario,
      lmstHour: simLmstHour.toFixed(1),
      minPressurePa: String(Math.round(minPressurePa)),
    });
    if (weatherSol !== undefined) params.set("sol", String(weatherSol));
    return `/api/site/pressure.png?${params.toString()}`;
  }, [weatherScenario, simLmstHour, minPressurePa, weatherSol]);

  const fieldOverlayOpacity = showPressureLayer && showTemperatureLayer ? 0.56 : 0.74;

  useDebouncedSiteOverlay({
    mapRef,
    site,
    visible: showTemperatureLayer,
    url: temperatureUrl,
    opacity: fieldOverlayOpacity,
    zIndex: 2,
    debounceMs: 160,
  });

  useDebouncedSiteOverlay({
    mapRef,
    site,
    visible: showPressureLayer,
    url: pressureUrl,
    opacity: fieldOverlayOpacity,
    zIndex: 3,
    debounceMs: 160,
  });

  useDebouncedSiteOverlay({
    mapRef,
    site,
    visible: showSlopeHazard,
    url: slopeMaskUrl,
    opacity: 0.78,
    zIndex: 4,
    debounceMs: 150,
  });

  // Render candidate and selected routes with visual contrast halo + click selection
  useEffect(() => {
    const group = routesGroupRef.current;
    if (!group) return;
    group.clearLayers();

    const ordered = [...routes].sort((a, b) =>
      a.id === selectedRouteId ? 1 : b.id === selectedRouteId ? -1 : 0,
    );

    for (const route of ordered) {
      const isSelected = route.id === selectedRouteId;
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
        `${visual.shortLabel} · ${formatRouteDistance(route.totalDistanceM)} · ${route.maxSlopeDeg.toFixed(1)}°`,
        {
          sticky: true,
          className: "route-map-tooltip",
          direction: "top",
          offset: [0, -6],
        },
      );

      line.on("click", (ev) => {
        L.DomEvent.stopPropagation(ev);
        callbacksRef.current.onSelectRoute?.(route.id);
      });

      line.addTo(group);
    }
  }, [routes, selectedRouteId]);

  // Render Waypoint A and Waypoint B pins
  useEffect(() => {
    const group = markersGroupRef.current;
    if (!group) return;
    group.clearLayers();

    if (waypointA) {
      L.marker([waypointA.lat, waypointA.lon], {
        icon: L.divIcon({
          className: "",
          html: '<div class="waypoint-pin">A</div>',
          iconSize: [24, 24],
          iconAnchor: [12, 12],
        }),
        interactive: false,
      }).addTo(group);
    }

    if (waypointB) {
      L.marker([waypointB.lat, waypointB.lon], {
        icon: L.divIcon({
          className: "",
          html: '<div class="waypoint-pin is-b">B</div>',
          iconSize: [24, 24],
          iconAnchor: [12, 12],
        }),
        interactive: false,
      }).addTo(group);
    }
  }, [waypointA, waypointB]);

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

  // Toggle crosshair cursor when picking a point coordinate on the map
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.getContainer().style.cursor = pickMode ? "crosshair" : "";
  }, [pickMode]);

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
          buildPointPopupElement(point, cls, !readOnlyPoints, {
            onSetA: (coord) => {
              marker.closePopup();
              callbacksRef.current.onPointSetA(coord);
            },
            onSetB: (coord) => {
              marker.closePopup();
              callbacksRef.current.onPointSetB(coord);
            },
            onEdit: (pt) => {
              marker.closePopup();
              callbacksRef.current.onEditPoint(pt);
            },
            onDelete: (id) => {
              marker.closePopup();
              callbacksRef.current.onDeletePoint(id);
            },
          }),
        { closeButton: false, minWidth: 210, maxWidth: 260 },
      );

      marker.addTo(group);
    }
  }, [points, pointClasses, selectedPointId, readOnlyPoints]);

  return <div ref={containerRef} className="map-root" />;
}
