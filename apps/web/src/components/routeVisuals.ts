import type { ComputedRoute, LonFormat, MarsCoord, RoutePoint, RouteStrategy } from "@nimbs/shared";
import { lon180To360 } from "@nimbs/shared";

export interface RouteStrategyVisual {
  shortLabel: string;
  color: string;
  selectedColor: string;
}

export const ROUTE_STRATEGY_VISUALS: Record<RouteStrategy, RouteStrategyVisual> = {
  shortest: {
    shortLabel: "FASTEST",
    color: "#e5e0dc",
    selectedColor: "#de233d",
  },
  gentlest: {
    shortLabel: "FLATTEST",
    color: "#38bdf8",
    selectedColor: "#de233d",
  },
  alternate: {
    shortLabel: "DETOUR",
    color: "#eab308",
    selectedColor: "#de233d",
  },
  "weather-safe": {
    shortLabel: "THERMAL",
    color: "#3fb68b",
    selectedColor: "#de233d",
  },
};

export function getRouteStrategyVisual(strategy: RouteStrategy): RouteStrategyVisual {
  return ROUTE_STRATEGY_VISUALS[strategy];
}

export function formatRouteDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`;
}

export function formatShortCoord(coord: MarsCoord, fmt: LonFormat): string {
  const lon = fmt === "360" ? lon180To360(coord.lon) : coord.lon;
  return `${coord.lat.toFixed(3)}° ${lon.toFixed(3)}°`;
}

export interface SparklineGeometry {
  linePath: string;
  areaPath: string;
  peakSlopeX: number;
  peakSlopeY: number;
}

export function buildSparklineGeometry(
  route: ComputedRoute,
  width: number,
  height: number,
): SparklineGeometry | null {
  const pts = route.points;
  if (pts.length < 2) return null;

  let minE = Number.POSITIVE_INFINITY;
  let maxE = Number.NEGATIVE_INFINITY;
  let maxSlopeIdx = 0;
  let maxSlopeVal = -1;

  for (let i = 0; i < pts.length; i += 1) {
    const pt = pts[i];
    if (!pt) continue;
    if (pt.elevationM < minE) minE = pt.elevationM;
    if (pt.elevationM > maxE) maxE = pt.elevationM;
    if (pt.slopeDeg > maxSlopeVal) {
      maxSlopeVal = pt.slopeDeg;
      maxSlopeIdx = i;
    }
  }

  const totalDist = Math.max(1, route.totalDistanceM);
  const elevSpan = Math.max(1, maxE - minE);
  const padX = 2;
  const padY = 3;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;

  const stride = Math.max(1, Math.floor(pts.length / 44));
  const coords: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < pts.length; i += stride) {
    const pt = pts[i];
    if (!pt) continue;
    const x = padX + (pt.distanceM / totalDist) * innerW;
    const y = padY + innerH - ((pt.elevationM - minE) / elevSpan) * innerH;
    coords.push({ x, y });
  }
  const last = pts[pts.length - 1];
  if (last) {
    coords.push({
      x: padX + innerW,
      y: padY + innerH - ((last.elevationM - minE) / elevSpan) * innerH,
    });
  }

  if (coords.length < 2) return null;

  const linePath = coords
    .map((c, idx) => `${idx === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
    .join(" ");
  const first = coords[0];
  const end = coords[coords.length - 1];
  const baseY = (height - 1).toFixed(1);
  const areaPath =
    first && end
      ? `${linePath} L${end.x.toFixed(1)},${baseY} L${first.x.toFixed(1)},${baseY} Z`
      : linePath;

  const peakPt: RoutePoint | undefined = pts[maxSlopeIdx];
  const peakSlopeX = peakPt ? padX + (peakPt.distanceM / totalDist) * innerW : width / 2;
  const peakSlopeY = peakPt
    ? padY + innerH - ((peakPt.elevationM - minE) / elevSpan) * innerH
    : height / 2;

  return { linePath, areaPath, peakSlopeX, peakSlopeY };
}
