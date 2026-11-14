import type { ComputedRoute, RoutePoint } from "@nimbs/shared";
import { type MouseEvent, useMemo, useState } from "react";
import { formatRouteDistance } from "./routeVisuals";

interface ElevationProfileProps {
  route: ComputedRoute;
  maxSlopeDeg: number;
  minAirTempC?: number;
  minPressurePa?: number;
  onHoverPoint: (pt: RoutePoint | null) => void;
}

type ProfileOverlayMode = "all" | "temp" | "press" | "slope";

const W = 384;
const H = 148;
const PAD_L = 36;
const PAD_R = 10;
const PAD_T = 10;
const PAD_B = 22;
const SLOPE_BAND_H = 6;

function downsamplePoints(points: RoutePoint[], maxCount: number): RoutePoint[] {
  if (points.length <= maxCount) return points;
  const out: RoutePoint[] = [];
  const step = (points.length - 1) / (maxCount - 1);
  let last = -1;
  for (let i = 0; i < maxCount; i += 1) {
    const idx = i === maxCount - 1 ? points.length - 1 : Math.round(i * step);
    if (idx === last) continue;
    last = idx;
    const pt = points[idx];
    if (pt) out.push(pt);
  }
  return out;
}

function findNearestByDistance(points: RoutePoint[], targetM: number): RoutePoint | null {
  if (points.length === 0) return null;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const midPt = points[mid];
    if (!midPt) break;
    if (midPt.distanceM < targetM) lo = mid + 1;
    else hi = mid;
  }
  const candA = points[lo];
  const candB = points[Math.max(0, lo - 1)];
  if (!candA) return candB ?? null;
  if (!candB) return candA;
  return Math.abs(candA.distanceM - targetM) <= Math.abs(candB.distanceM - targetM) ? candA : candB;
}

function slopeBandColor(slopeDeg: number, maxSlopeDeg: number): string {
  const ratio = maxSlopeDeg > 0 ? slopeDeg / maxSlopeDeg : 0;
  if (ratio > 1) return "#de233d";
  if (ratio >= 0.72) return "#eab308";
  return "#3fb68b";
}

export function ElevationProfile({
  route,
  maxSlopeDeg,
  minAirTempC,
  minPressurePa,
  onHoverPoint,
}: ElevationProfileProps) {
  const [hoverPoint, setHoverPoint] = useState<RoutePoint | null>(null);
  const [overlayMode, setOverlayMode] = useState<ProfileOverlayMode>("all");

  const hasTemp = useMemo(() => route.points.some((p) => p.tempC !== undefined), [route.points]);
  const hasPress = useMemo(
    () => route.points.some((p) => p.pressurePa !== undefined),
    [route.points],
  );

  const chart = useMemo(() => {
    const pts = downsamplePoints(route.points, 96);
    if (pts.length < 2) return null;

    let minE = Number.POSITIVE_INFINITY;
    let maxE = Number.NEGATIVE_INFINITY;
    let minT = minAirTempC ?? Number.POSITIVE_INFINITY;
    let maxT = Number.NEGATIVE_INFINITY;
    let minP = minPressurePa ?? Number.POSITIVE_INFINITY;
    let maxP = Number.NEGATIVE_INFINITY;

    for (const p of pts) {
      if (p.elevationM < minE) minE = p.elevationM;
      if (p.elevationM > maxE) maxE = p.elevationM;
      if (p.tempC !== undefined) {
        if (p.tempC < minT) minT = p.tempC;
        if (p.tempC > maxT) maxT = p.tempC;
      }
      if (p.pressurePa !== undefined) {
        if (p.pressurePa < minP) minP = p.pressurePa;
        if (p.pressurePa > maxP) maxP = p.pressurePa;
      }
    }

    const totalDist = Math.max(1, route.totalDistanceM);
    const spanE = Math.max(5, maxE - minE);
    const padE = spanE * 0.1;
    const eLo = minE - padE;
    const eHi = maxE + padE;
    const innerW = W - PAD_L - PAD_R;
    const innerH = H - PAD_T - PAD_B - SLOPE_BAND_H;

    const toX = (distM: number) => PAD_L + (distM / totalDist) * innerW;
    const toElevY = (elevM: number) => PAD_T + innerH - ((elevM - eLo) / (eHi - eLo)) * innerH;

    const elevCoords = pts.map((p) => ({ x: toX(p.distanceM), y: toElevY(p.elevationM), pt: p }));
    const elevLine = elevCoords
      .map((c, idx) => `${idx === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
      .join(" ");
    const baseY = PAD_T + innerH;
    const elevArea = `${elevLine} L${(PAD_L + innerW).toFixed(1)},${baseY.toFixed(1)} L${PAD_L.toFixed(1)},${baseY.toFixed(1)} Z`;

    const steepSegments: Array<{ x1: number; y1: number; x2: number; y2: number; color: string }> =
      [];
    const slopeBands: Array<{ x: number; w: number; color: string }> = [];
    const cautionLimit = maxSlopeDeg * 0.72;

    for (let i = 1; i < elevCoords.length; i += 1) {
      const a = elevCoords[i - 1];
      const b = elevCoords[i];
      if (!a || !b) continue;
      const segSlope = b.pt.slopeDeg;
      const color = slopeBandColor(segSlope, maxSlopeDeg);
      slopeBands.push({
        x: a.x,
        w: Math.max(1, b.x - a.x + 0.5),
        color,
      });
      if (segSlope >= cautionLimit) {
        steepSegments.push({
          x1: a.x,
          y1: a.y,
          x2: b.x,
          y2: b.y,
          color: segSlope > maxSlopeDeg ? "#de233d" : "#eab308",
        });
      }
    }

    let tempPath: string | null = null;
    let tempLimitY: number | null = null;
    if (hasTemp && Number.isFinite(minT) && Number.isFinite(maxT)) {
      const tSpan = Math.max(4, maxT - minT);
      const tLo = minT - tSpan * 0.14;
      const tHi = maxT + tSpan * 0.14;
      const toTempY = (t: number) => PAD_T + innerH - ((t - tLo) / (tHi - tLo)) * innerH;
      tempPath = elevCoords
        .filter((c) => c.pt.tempC !== undefined)
        .map(
          (c, idx) =>
            `${idx === 0 ? "M" : "L"}${c.x.toFixed(1)},${toTempY(c.pt.tempC ?? 0).toFixed(1)}`,
        )
        .join(" ");
      if (minAirTempC !== undefined) {
        tempLimitY = toTempY(minAirTempC);
      }
    }

    let pressPath: string | null = null;
    let pressLimitY: number | null = null;
    if (hasPress && Number.isFinite(minP) && Number.isFinite(maxP)) {
      const pSpan = Math.max(6, maxP - minP);
      const pLo = minP - pSpan * 0.14;
      const pHi = maxP + pSpan * 0.14;
      const toPressY = (p: number) => PAD_T + innerH - ((p - pLo) / (pHi - pLo)) * innerH;
      pressPath = elevCoords
        .filter((c) => c.pt.pressurePa !== undefined)
        .map(
          (c, idx) =>
            `${idx === 0 ? "M" : "L"}${c.x.toFixed(1)},${toPressY(c.pt.pressurePa ?? 0).toFixed(1)}`,
        )
        .join(" ");
      if (minPressurePa !== undefined) {
        pressLimitY = toPressY(minPressurePa);
      }
    }

    return {
      minE,
      maxE,
      totalDist,
      innerW,
      innerH,
      baseY,
      elevLine,
      elevArea,
      steepSegments,
      slopeBands,
      tempPath,
      tempLimitY,
      pressPath,
      pressLimitY,
      toX,
      toElevY,
    };
  }, [route, maxSlopeDeg, minAirTempC, minPressurePa, hasTemp, hasPress]);

  if (!chart) return null;

  const showTemp = (overlayMode === "all" || overlayMode === "temp") && chart.tempPath !== null;
  const showPress = (overlayMode === "all" || overlayMode === "press") && chart.pressPath !== null;

  const handleMouseMove = (e: MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const svgX = ((e.clientX - rect.left) / rect.width) * W;
    const frac = Math.max(0, Math.min(1, (svgX - PAD_L) / chart.innerW));
    const pt = findNearestByDistance(route.points, frac * chart.totalDist);
    setHoverPoint(pt);
    onHoverPoint(pt);
  };

  const handleMouseLeave = () => {
    setHoverPoint(null);
    onHoverPoint(null);
  };

  const hoverX = hoverPoint ? chart.toX(hoverPoint.distanceM) : null;
  const hoverY = hoverPoint ? chart.toElevY(hoverPoint.elevationM) : null;
  const bandTopY = chart.baseY + 2;

  return (
    <div className="chart-box">
      <div className="chart-head-row">
        <div className="chart-telemetry-strip">
          {hoverPoint ? (
            <>
              <span className="chart-metric">{formatRouteDistance(hoverPoint.distanceM)}</span>
              <span className="chart-metric">{hoverPoint.elevationM.toFixed(0)}m</span>
              <span
                className="chart-metric"
                style={{ color: slopeBandColor(hoverPoint.slopeDeg, maxSlopeDeg) }}
              >
                {hoverPoint.slopeDeg.toFixed(1)}°
              </span>
              {hoverPoint.tempC !== undefined && (
                <span className="chart-metric is-temp">{hoverPoint.tempC.toFixed(0)}°C</span>
              )}
              {hoverPoint.pressurePa !== undefined && (
                <span className="chart-metric is-press">{hoverPoint.pressurePa.toFixed(0)}Pa</span>
              )}
            </>
          ) : (
            <>
              <span className="chart-metric">
                +{route.elevationGainM.toFixed(0)}m / -{route.elevationLossM.toFixed(0)}m
              </span>
              {route.minTempC !== undefined && (
                <span className="chart-metric is-temp">MIN {route.minTempC.toFixed(0)}°C</span>
              )}
              {route.minPressurePa !== undefined && (
                <span className="chart-metric is-press">
                  MIN {route.minPressurePa.toFixed(0)}Pa
                </span>
              )}
            </>
          )}
        </div>

        {(hasTemp || hasPress) && (
          <div className="chart-mode-pills">
            {(["all", "slope", "temp", "press"] as ProfileOverlayMode[]).map((mode) => {
              if (mode === "temp" && !hasTemp) return null;
              if (mode === "press" && !hasPress) return null;
              const label =
                mode === "all" ? "ALL" : mode === "slope" ? "SLP" : mode === "temp" ? "T°" : "Pa";
              return (
                <button
                  key={mode}
                  type="button"
                  className={`chart-mode-btn ${overlayMode === mode ? "is-active" : ""}`}
                  onClick={() => setOverlayMode(mode)}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="elevation-svg"
        role="img"
        aria-label="Route elevation, slope and weather telemetry profile"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        <title>Route elevation, slope and weather telemetry profile</title>
        <defs>
          <linearGradient id="elevFillGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#fff8f3" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#fff8f3" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        <line x1={PAD_L} y1={PAD_T} x2={W - PAD_R} y2={PAD_T} stroke="rgba(255,248,243,0.08)" />
        <line
          x1={PAD_L}
          y1={PAD_T + chart.innerH / 2}
          x2={W - PAD_R}
          y2={PAD_T + chart.innerH / 2}
          stroke="rgba(255,248,243,0.05)"
          strokeDasharray="2 3"
        />
        <line
          x1={PAD_L}
          y1={chart.baseY}
          x2={W - PAD_R}
          y2={chart.baseY}
          stroke="rgba(255,248,243,0.16)"
        />

        <path d={chart.elevArea} fill="url(#elevFillGrad)" />
        <path d={chart.elevLine} fill="none" stroke="#fff8f3" strokeWidth="1.6" />

        {chart.steepSegments.map((seg, i) => (
          <line
            key={`${seg.x1}-${i}`}
            x1={seg.x1}
            y1={seg.y1}
            x2={seg.x2}
            y2={seg.y2}
            stroke={seg.color}
            strokeWidth="2.4"
          />
        ))}

        {showTemp && chart.tempPath && (
          <>
            {chart.tempLimitY !== null &&
              chart.tempLimitY >= PAD_T &&
              chart.tempLimitY <= chart.baseY && (
                <line
                  x1={PAD_L}
                  y1={chart.tempLimitY}
                  x2={W - PAD_R}
                  y2={chart.tempLimitY}
                  stroke="#38bdf8"
                  strokeOpacity="0.55"
                  strokeDasharray="3 3"
                  strokeWidth="1"
                />
              )}
            <path
              d={chart.tempPath}
              fill="none"
              stroke="#38bdf8"
              strokeWidth="1.4"
              strokeOpacity="0.9"
            />
          </>
        )}

        {showPress && chart.pressPath && (
          <>
            {chart.pressLimitY !== null &&
              chart.pressLimitY >= PAD_T &&
              chart.pressLimitY <= chart.baseY && (
                <line
                  x1={PAD_L}
                  y1={chart.pressLimitY}
                  x2={W - PAD_R}
                  y2={chart.pressLimitY}
                  stroke="#3fb68b"
                  strokeOpacity="0.55"
                  strokeDasharray="3 3"
                  strokeWidth="1"
                />
              )}
            <path
              d={chart.pressPath}
              fill="none"
              stroke="#3fb68b"
              strokeWidth="1.35"
              strokeOpacity="0.88"
            />
          </>
        )}

        {/* Slope hazard ribbon along baseline */}
        {chart.slopeBands.map((band, idx) => (
          <rect
            key={`${band.x}-${idx}`}
            x={band.x}
            y={bandTopY}
            width={band.w}
            height={SLOPE_BAND_H - 1}
            fill={band.color}
            opacity="0.85"
          />
        ))}

        {/* Start A & End B markers */}
        <rect x={PAD_L - 2} y={bandTopY} width="4" height={SLOPE_BAND_H - 1} fill="#de233d" />
        <rect x={W - PAD_R - 2} y={bandTopY} width="4" height={SLOPE_BAND_H - 1} fill="#3fb68b" />

        {hoverX !== null && hoverY !== null && (
          <>
            <line
              x1={hoverX}
              y1={PAD_T}
              x2={hoverX}
              y2={chart.baseY + SLOPE_BAND_H}
              stroke="#fff8f3"
              strokeOpacity="0.45"
              strokeDasharray="2 2"
            />
            <rect
              x={hoverX - 3}
              y={hoverY - 3}
              width="6"
              height="6"
              fill="#fff8f3"
              stroke="#de233d"
              strokeWidth="1.5"
            />
          </>
        )}

        <text x={2} y={PAD_T + 8} fill="#9a9a9a" fontSize="9" fontFamily="monospace">
          {chart.maxE.toFixed(0)}m
        </text>
        <text x={2} y={chart.baseY} fill="#9a9a9a" fontSize="9" fontFamily="monospace">
          {chart.minE.toFixed(0)}m
        </text>
        <text x={PAD_L} y={H - 2} fill="#de233d" fontSize="9" fontFamily="monospace">
          A
        </text>
        <text
          x={W - PAD_R}
          y={H - 2}
          fill="#3fb68b"
          fontSize="9"
          fontFamily="monospace"
          textAnchor="end"
        >
          {formatRouteDistance(route.totalDistanceM)} B
        </text>
      </svg>
    </div>
  );
}
