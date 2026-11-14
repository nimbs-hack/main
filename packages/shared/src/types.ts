import type { MarsBBox, MarsCoord } from "./coords";

export type LonFormat = "180" | "360";

/** Metadata describing a preprocessed local elevation patch (e.g. 20x20 km site). */
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

export type RouteStrategy = "shortest" | "gentlest" | "alternate" | "weather-safe";

export type WeatherSourceType = "real" | "hybrid" | "simulated";
export type WeatherScenario = "auto" | "nominal" | "dust-storm" | "cold-snap";
export type EvaStatus = "GO" | "DEGRADED" | "NO-GO";
export type WeatherCheckId =
  | "air_temp"
  | "wind_speed"
  | "pressure"
  | "pressure_swing"
  | "eva_duration";

export interface WeatherHourlyPoint {
  lmstHour: number;
  lmstLabel: string;
  tempK: number;
  windSpeedMps: number;
  pressurePa: number;
  solarIrradianceWm2: number;
  uvIndex: number;
  isDaylight: boolean;
}

export interface MarsWeatherSolForecast {
  sol: number;
  lsDeg: number;
  season: string;
  terrestrialDate: string;
  airTemp: {
    minK: number;
    avgK: number;
    maxK: number;
  };
  wind: {
    minMps: number;
    avgMps: number;
    maxMps: number;
    compassDeg: number;
    compassPoint: string;
  };
  pressure: {
    minPa: number;
    avgPa: number;
    maxPa: number;
    swingPa: number;
    referenceElevationM: number;
  };
  dustOpacityTau: number;
  uvIndexMax: number;
  solarIrradiancePeakWm2: number;
  daylight: {
    sunriseLmst: string;
    sunsetLmst: string;
    sunriseUtc: string;
    sunsetUtc: string;
    durationHours: number;
  };
  hourly: WeatherHourlyPoint[];
}

export interface MarsWeatherSnapshot {
  site: {
    siteId: "jezero" | "gale";
    name: string;
    center: { lat: number; lon: number };
    referenceElevationM: number;
    minElevationM: number;
    maxElevationM: number;
  };
  sol: number;
  lsDeg: number;
  season: string;
  terrestrialDate: string;
  fetchedAt: string;
  scenario: WeatherScenario;
  isSimulated: boolean;
  sourceType: WeatherSourceType;
  sourceLabel: string;
  sourceUrl?: string;
  disclaimer?: string;
  realChannels: string[];
  simulatedChannels: string[];
  airTemp: {
    minK: number;
    avgK: number;
    maxK: number;
  };
  wind: {
    minMps: number;
    avgMps: number;
    maxMps: number;
    compassDeg: number;
    compassPoint: string;
  };
  pressure: {
    minPa: number;
    avgPa: number;
    maxPa: number;
    swingPa: number;
    referenceElevationM: number;
  };
  dustOpacityTau: number;
  uvIndexMax: number;
  solarIrradiancePeakWm2: number;
  daylight: {
    sunriseLmst: string;
    sunsetLmst: string;
    sunriseUtc: string;
    sunsetUtc: string;
    durationHours: number;
  };
  hourly: WeatherHourlyPoint[];
  /** Optional next-sol weather forecast for 48-hour traverse window simulation. */
  nextSol?: MarsWeatherSolForecast;
}

export interface EvaWeatherLimits {
  minAirTempC: number;
  maxWindSpeedMps: number;
  minPressurePa: number;
  maxPressureSwingPa: number;
  maxEvaHours: number;
}

export const DEFAULT_EVA_WEATHER_LIMITS: EvaWeatherLimits = {
  minAirTempC: -75,
  maxWindSpeedMps: 15,
  minPressurePa: 650,
  maxPressureSwingPa: 35,
  maxEvaHours: 4,
};

export interface TraversePointSample {
  distanceM: number;
  elevationM: number;
  slopeDeg?: number;
  lat?: number;
  lon?: number;
}

export interface EvaRouteContext {
  totalDistanceM?: number;
  elevationGainM?: number;
  elevationLossM?: number;
  minElevationM?: number;
  maxElevationM?: number;
  /** Optional sampled points along the route for time-varying traverse simulation. */
  points?: TraversePointSample[];
}

export type EvaRouteWeatherContext = EvaRouteContext;

export interface EvaWeatherCheck {
  id: WeatherCheckId;
  label: string;
  status: EvaStatus;
  measuredValue: number;
  limitValue: number;
  unit: string;
  margin: number;
  reason: string;
}

export interface EvaSafeWindow {
  startLmstHour: number | null;
  endLmstHour: number | null;
  startLmst: string | null;
  endLmst: string | null;
  durationHours: number;
  minTempK: number | null;
  maxTempK: number | null;
  maxWindMps: number | null;
  note: string;
}

export interface SelectedHourWeatherSummary {
  offsetHours: number;
  sol: number;
  lmstLabel: string;
  floorTempC: number;
  rimTempC: number;
  floorPressurePa: number;
  rimPressurePa: number;
  windSpeedMps: number;
  uvIndex: number;
  isDaylight: boolean;
}

export interface TraverseDepartureSlot {
  offsetHours: number;
  solOffset: 0 | 1;
  sol: number;
  startLmstHour: number;
  startLmstLabel: string;
  endLmstHour: number;
  endLmstLabel: string;
  durationHours: number;
  status: EvaStatus;
  score: number;
  minEncounteredTempC: number;
  maxEncounteredTempC: number;
  minEncounteredPressurePa: number;
  maxEncounteredWindMps: number;
  maxUvIndex: number;
  daylightFraction: number;
  reason: string;
}

export interface TraverseWindowRecommendation {
  id: string;
  rank: number;
  solOffset: 0 | 1;
  sol: number;
  startOffsetHours: number;
  endOffsetHours: number;
  bestDepartureOffsetHours: number;
  bestDepartureLmst: string;
  windowStartLmst: string;
  windowEndLmst: string;
  windowSpanHours: number;
  estimatedDurationHours: number;
  status: EvaStatus;
  score: number;
  minTempC: number;
  maxTempC: number;
  minPressurePa: number;
  maxWindMps: number;
  daylightFraction: number;
  summary: string;
}

export interface EvaWeatherEvaluation {
  status: EvaStatus;
  limits: EvaWeatherLimits;
  evaluationElevationM: number;
  floorElevationM: number;
  rimPressureMinPa: number;
  rimPressureAvgPa: number;
  rimTempMinK: number;
  rimTempMaxK: number;
  estimatedRouteHours: number | null;
  safeWindow: EvaSafeWindow;
  checks: EvaWeatherCheck[];
  summary: string;
  selectedLmstHour?: number;
  selectedHourWeather?: SelectedHourWeatherSummary;
  departureSlots?: TraverseDepartureSlot[];
  recommendedWindows?: TraverseWindowRecommendation[];
  weatherSource: {
    isSimulated: boolean;
    sourceType: WeatherSourceType;
    sourceLabel: string;
    disclaimer?: string;
  };
}

export interface WeatherApiResponse {
  weather: MarsWeatherSnapshot;
  evaluation: EvaWeatherEvaluation;
}

export interface SiteEnvironmentSummary {
  siteId: string;
  sol: number;
  lmstHour: number;
  lmstLabel: string;
  scenario: WeatherScenario;
  isSimulated: boolean;
  minTempC: number;
  maxTempC: number;
  meanTempC: number;
  minPressurePa: number;
  maxPressurePa: number;
  meanPressurePa: number;
}

export interface RouteWeatherConstraints {
  enabled: boolean;
  scenario?: WeatherScenario;
  sol?: number;
  /** Simulation hour offset from 00:00 of base sol (0..48). */
  lmstHour?: number;
  minAirTempC?: number;
  minPressurePa?: number;
  /** Weight in [0, 1] biasing routes toward warmer and higher-pressure corridors. */
  thermalWeight?: number;
}

export interface RoutePoint {
  lat: number;
  lon: number;
  elevationM: number;
  distanceM: number;
  /** Unsigned local segment slope in degrees. */
  slopeDeg: number;
  /** Modeled surface air temperature (C) at the planned simulation hour. */
  tempC?: number;
  /** Modeled local surface pressure (Pa) at the planned simulation hour. */
  pressurePa?: number;
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
  minTempC?: number;
  maxTempC?: number;
  minPressurePa?: number;
  maxPressurePa?: number;
  /** Suited walking time in Earth hours from the shared walk-rate model. */
  walkHours: number;
  /** Point index of each stop: A, intermediate stops, B, then A again on a round trip. */
  stopIndices: number[];
  points: RoutePoint[];
}

export interface RoutePlanRequest {
  waypointA: MarsCoord;
  waypointB: MarsCoord;
  /** Ordered stops between A and B, at most 8. */
  via?: MarsCoord[];
  /** Return to A by retracing the outbound path. */
  roundTrip?: boolean;
  maxSlopeDeg: number;
  weatherConstraints?: RouteWeatherConstraints;
}

export type RouteBlockedReason = "slope" | "temperature" | "pressure" | "combined" | "nodata";

export interface RoutePlanResponse {
  status: "ok" | "out_of_bounds" | "unreachable";
  message?: string;
  blockedReason?: RouteBlockedReason;
  maxSlopeDeg: number;
  minRequiredSlopeDeg?: number;
  maxFeasibleMinTempC?: number;
  maxFeasibleMinPressurePa?: number;
  weatherApplied?: boolean;
  appliedLmstHour?: number;
  minTempFilterC?: number;
  minPressureFilterPa?: number;
  passableEdgeRatio: number;
  roundTrip?: boolean;
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
