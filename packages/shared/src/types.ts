import type { MarsBBox, MarsCoord } from "./coords";

export type LonFormat = "180" | "360";

/** Metadata describing a preprocessed local elevation patch (e.g. 3x3 km site). */
export interface SiteMetadata {
  id: string;
  name: string;
  sourceItemId: string;
  sourceTitle: string;
  dtmUrl: string;
  hillshadeUrl: string;
  bbox: MarsBBox;
  center: MarsCoord;
  widthMeters: number;
  heightMeters: number;
  rows: number;
  cols: number;
  cellSizeMeters: number;
  minElevationM: number;
  maxElevationM: number;
  nodataValue: number;
}

/** Serialized 2D elevation grid stored under data/site-terrain.json. */
export interface SiteDataset {
  meta: SiteMetadata;
  /** Row-major (north-to-south, west-to-east) elevations in SI meters relative to Mars areoid. */
  elevationsM: number[];
}

export interface ElevationResponse {
  lat: number;
  lon: number;
  insideSite: boolean;
  elevationM: number | null;
}

export type RouteStrategy = "shortest" | "gentlest" | "alternate";

export interface RoutePoint {
  lat: number;
  lon: number;
  elevationM: number;
  distanceM: number;
  /** Unsigned local segment slope in degrees. */
  slopeDeg: number;
}

export interface ComputedRoute {
  id: string;
  label: string;
  strategy: RouteStrategy;
  totalDistanceM: number;
  elevationGainM: number;
  elevationLossM: number;
  maxSlopeDeg: number;
  meanSlopeDeg: number;
  points: RoutePoint[];
}

export interface RoutePlanRequest {
  waypointA: MarsCoord;
  waypointB: MarsCoord;
  maxSlopeDeg: number;
}

export interface RoutePlanResponse {
  status: "ok" | "out_of_bounds" | "unreachable";
  message?: string;
  maxSlopeDeg: number;
  minRequiredSlopeDeg?: number;
  passableEdgeRatio: number;
  snappedA?: MarsCoord & { elevationM: number };
  snappedB?: MarsCoord & { elevationM: number };
  routes: ComputedRoute[];
}

export interface MapLayerMeta {
  id: string;
  label: string;
  attribution: string;
  maxNativeZoom: number;
  tileUrlTemplate: string;
}
