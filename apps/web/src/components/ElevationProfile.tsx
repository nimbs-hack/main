import type { ComputedRoute, RoutePoint } from "@nimbs/shared";
import { useMemo } from "react";

interface ElevationProfileProps {
  route: ComputedRoute;
  maxSlopeDeg: number;
  onHoverPoint: (pt: RoutePoint | null) => void;
}

const CHART_WIDTH = 328;
const CHART_HEIGHT = 128;
const PAD_X = 8;
const PAD_Y = 12;

function toChartX(distM: number, totalD: number): number {
  return PAD_X + (distM / totalD) * (CHART_WIDTH - PAD_X * 2);
}

function toChartY(elevM: number, minE: number, spanE: number): number {
  return CHART_HEIGHT - PAD_Y - ((elevM - minE) / spanE) * (CHART_HEIGHT - PAD_Y * 2);
}

export function ElevationProfile({ route, maxSlopeDeg, onHoverPoint }: ElevationProfileProps) {
  const width = CHART_WIDTH;
  const height = CHART_HEIGHT;
  const padX = PAD_X;
  const padY = PAD_Y;

  const stats = useMemo(() => {
    let minE = Number.POSITIVE_INFINITY;
    let maxE = Number.NEGATIVE_INFINITY;
    for (const p of route.points) {
      if (p.elevationM < minE) minE = p.elevationM;
      if (p.elevationM > maxE) maxE = p.elevationM;
    }
    const spanE = Math.max(1, maxE - minE);
    const totalD = Math.max(1, route.totalDistanceM);
    return { minE, maxE, spanE, totalD };
  }, [route]);

  const toX = (distM: number) => toChartX(distM, stats.totalD);
  const toY = (elevM: number) => toChartY(elevM, stats.minE, stats.spanE);

  const { polyPoints, areaPath } = useMemo(() => {
    const first = route.points[0];
    const last = route.points[route.points.length - 1];
    if (!first || !last) return { polyPoints: "", areaPath: "" };
    const coords = route.points.map(
      (p) =>
        `${toChartX(p.distanceM, stats.totalD).toFixed(1)},${toChartY(p.elevationM, stats.minE, stats.spanE).toFixed(1)}`,
    );
    const lastX = toChartX(last.distanceM, stats.totalD).toFixed(1);
    const firstX = toChartX(first.distanceM, stats.totalD).toFixed(1);
    const baseY = (CHART_HEIGHT - PAD_Y).toFixed(1);
    return {
      polyPoints: coords.join(" "),
      areaPath: `M ${firstX},${baseY} L ${coords.join(" L ")} L ${lastX},${baseY} Z`,
    };
  }, [route.points, stats]);

  const handleMouseMove = (clientX: number, rect: DOMRect) => {
    let closest = route.points[0];
    if (!closest) return;
    const relX = Math.max(0, Math.min(1, (clientX - rect.left - padX) / (rect.width - padX * 2)));
    const targetDist = relX * stats.totalD;
    let bestDiff = Math.abs(closest.distanceM - targetDist);
    for (const p of route.points) {
      const diff = Math.abs(p.distanceM - targetDist);
      if (diff < bestDiff) {
        bestDiff = diff;
        closest = p;
      }
    }
    onHoverPoint(closest);
  };

  return (
    <div className="chart-box">
      <div className="field-label-row" style={{ marginBottom: 0 }}>
        <span className="value-label">ELEVATION PROFILE</span>
        <span className="readout-sub">
          {stats.minE.toFixed(0)} m .. {stats.maxE.toFixed(0)} m
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        style={{ display: "block", cursor: "crosshair" }}
        onMouseMove={(e) => handleMouseMove(e.clientX, e.currentTarget.getBoundingClientRect())}
        onMouseLeave={() => onHoverPoint(null)}
      >
        <title>Route elevation profile</title>
        <line
          x1={padX}
          y1={height - padY}
          x2={width - padX}
          y2={height - padY}
          stroke="var(--color-line)"
          strokeWidth={1}
        />
        {areaPath && <path d={areaPath} fill="rgb(222 35 61 / 0.14)" />}
        <polyline fill="none" stroke="var(--color-accent)" strokeWidth={2} points={polyPoints} />
        {route.points.map((pt, i) => {
          const prev = i > 0 ? route.points[i - 1] : undefined;
          if (!prev || pt.slopeDeg <= maxSlopeDeg * 0.8) return null;
          return (
            <line
              key={`${pt.distanceM}-${i}`}
              x1={toX(prev.distanceM)}
              y1={toY(prev.elevationM)}
              x2={toX(pt.distanceM)}
              y2={toY(pt.elevationM)}
              stroke="#f59e0b"
              strokeWidth={2.5}
            />
          );
        })}
      </svg>
    </div>
  );
}
