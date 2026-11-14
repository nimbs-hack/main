import {
  type ComputedRoute,
  type MapLayerMeta,
  type MarsCoord,
  type RoutePoint,
  type SiteMetadata,
  normalizeLon180,
  surfaceDistanceMeters,
} from "@nimbs/shared";
import L from "leaflet";
import { useEffect, useRef } from "react";

interface MapViewProps {
  site: SiteMetadata | null;
  activeBaseLayer: MapLayerMeta;
  showHillshade: boolean;
  showSlopeHazard: boolean;
  showSiteBounds: boolean;
  maxSlopeDeg: number;
  waypointA: MarsCoord | null;
  waypointB: MarsCoord | null;
  routes: ComputedRoute[];
  selectedRouteId: string | null;
  hoveredProfilePoint: RoutePoint | null;
  leftInsetPx?: number;
  focusRequestCount: number;
  zoomStepTrigger: { delta: number; seq: number } | null;
  onCursorMove: (coord: MarsCoord | null) => void;
  onScaleUpdate: (label: string, widthPx: number, zoom: number) => void;
  onOpenContextMenu: (x: number, y: number, coord: MarsCoord) => void;
  onCloseContextMenu: () => void;
}

const NICE_SCALE_METERS = [
  50, 100, 200, 500, 1000, 2000, 5000, 10000, 25000, 50000, 100000, 500000,
];

export function MapView({
  site,
  activeBaseLayer,
  showHillshade,
  showSlopeHazard,
  showSiteBounds,
  maxSlopeDeg,
  waypointA,
  waypointB,
  routes,
  selectedRouteId,
  hoveredProfilePoint,
  leftInsetPx = 0,
  focusRequestCount,
  zoomStepTrigger,
  onCursorMove,
  onScaleUpdate,
  onOpenContextMenu,
  onCloseContextMenu,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const baseLayerRef = useRef<L.TileLayer | null>(null);
  const hillshadeRef = useRef<L.ImageOverlay | null>(null);
  const slopeMaskRef = useRef<L.ImageOverlay | null>(null);
  const boundsRectRef = useRef<L.Rectangle | null>(null);
  const routesGroupRef = useRef<L.LayerGroup | null>(null);
  const markersGroupRef = useRef<L.LayerGroup | null>(null);
  const hoverMarkerRef = useRef<L.Marker | null>(null);
  const leftInsetRef = useRef(leftInsetPx);
  leftInsetRef.current = leftInsetPx;

  const callbacksRef = useRef({
    onCursorMove,
    onScaleUpdate,
    onOpenContextMenu,
    onCloseContextMenu,
  });
  callbacksRef.current = {
    onCursorMove,
    onScaleUpdate,
    onOpenContextMenu,
    onCloseContextMenu,
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

    map.on("click movestart zoomstart", () => {
      callbacksRef.current.onCloseContextMenu();
    });

    map.on("zoomend moveend resize", updateScale);

    routesGroupRef.current = L.layerGroup().addTo(map);
    markersGroupRef.current = L.layerGroup().addTo(map);
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

  // Render 3x3 km HiRISE hillshade, slope mask, and boundary box
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
      }).addTo(map);
    }

    if (slopeMaskRef.current) {
      slopeMaskRef.current.removeFrom(map);
      slopeMaskRef.current = null;
    }
    if (showSlopeHazard) {
      slopeMaskRef.current = L.imageOverlay(
        `/api/site/passability.png?maxSlopeDeg=${maxSlopeDeg.toFixed(1)}`,
        bounds,
        { opacity: 0.78 },
      ).addTo(map);
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
  }, [site, showHillshade, showSlopeHazard, showSiteBounds, maxSlopeDeg]);

  // Render routes
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
      L.polyline(latlngs, {
        color: isSelected ? "#de233d" : "#fff8f3",
        weight: isSelected ? 3.5 : 2,
        opacity: isSelected ? 0.96 : 0.45,
        dashArray: isSelected ? undefined : "5 5",
        interactive: false,
      }).addTo(group);
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

  return <div ref={containerRef} className="map-root" />;
}
