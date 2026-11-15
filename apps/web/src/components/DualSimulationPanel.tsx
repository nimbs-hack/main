import type { ComputedRoute, MissionUnitId, TraversePresetId } from "@nimbs/shared";
import type { PointerEvent } from "react";
import {
  type EvaWeatherLimits,
  type MarsWeatherSnapshot,
  SOIL_TYPE_CATALOG,
  TRAVERSE_PRESETS,
} from "../services/api";
import {
  type DualSimTimelineBundle,
  type DualSimTrackPoint,
  type DualSimUnitSeries,
  type LiveUnitSimFrame,
  UNIT_ACCENT_COLORS,
  formatElapsedClock,
} from "../services/dualSim";
import { formatLmstClock, resolveSolDisplay } from "./TimeSimulationControl";
import { formatRouteDistance } from "./routeVisuals";

export interface DualSimUnitMeta {
  unitId: MissionUnitId;
  presetId: TraversePresetId;
  route: ComputedRoute | null;
  limits: EvaWeatherLimits;
  maxSlopeDeg: number;
  waypointCount: number;
}

interface DualSimulationPanelProps {
  unit1: DualSimUnitMeta;
  unit2: DualSimUnitMeta;
  bundle: DualSimTimelineBundle;
  frame: {
    unit1: LiveUnitSimFrame;
    unit2: LiveUnitSimFrame;
    bothArrived: boolean;
  };
  elapsedHours: number;
  departureLmstHour: number;
  playing: boolean;
  speedMultiplier: number;
  weather: MarsWeatherSnapshot | null;
  onChangeElapsed: (nextHours: number) => void;
  onTogglePlay: () => void;
  onReset: () => void;
  onChangeSpeed: (mult: number) => void;
  onChangeDepartureLmst: (nextHour: number) => void;
  onSyncDepartureFromWxr: () => void;
  onEditUnitRoute: (unitId: MissionUnitId) => void;
}

interface MetricChartSpec {
  id: string;
  label: string;
  unit: string;
  decimals: number;
  minFloor?: number;
  getValue: (pt: DualSimTrackPoint) => number | null;
}

const METRIC_CHARTS: readonly MetricChartSpec[] = [
  {
    id: "elev",
    label: "ELEVATION",
    unit: "m",
    decimals: 0,
    getValue: (pt) => pt.elevationM,
  },
  {
    id: "slope",
    label: "SLOPE",
    unit: "°",
    decimals: 1,
    minFloor: 0,
    getValue: (pt) => (pt.arrived ? 0 : pt.slopeDeg),
  },
  {
    id: "speed",
    label: "SPEED",
    unit: "km/h",
    decimals: 2,
    minFloor: 0,
    getValue: (pt) => (pt.arrived ? 0 : pt.speedKmPerH),
  },
  {
    id: "temp",
    label: "AIR TEMP",
    unit: "°C",
    decimals: 1,
    getValue: (pt) => pt.tempC,
  },
];

const CHART_W = 340;
const CHART_H = 54;
const PAD_L = 4;
const PAD_R = 4;
const PAD_T = 6;
const PAD_B = 6;

function buildSeriesPath(
  series: DualSimUnitSeries | null,
  totalHours: number,
  yMin: number,
  yMax: number,
  getValue: (pt: DualSimTrackPoint) => number | null,
): { activePath: string; holdPath: string; curX: number | null; curY: number | null } {
  if (!series || series.samples.length === 0 || totalHours <= 0) {
    return { activePath: "", holdPath: "", curX: null, curY: null };
  }

  const spanX = CHART_W - PAD_L - PAD_R;
  const spanY = CHART_H - PAD_T - PAD_B;
  const valRange = Math.max(1e-4, yMax - yMin);
  const toX = (t: number) => PAD_L + (Math.max(0, Math.min(totalHours, t)) / totalHours) * spanX;
  const toY = (v: number) => PAD_T + (1 - (v - yMin) / valRange) * spanY;

  const activeCoords: string[] = [];
  const holdCoords: string[] = [];

  for (const pt of series.samples) {
    const val = getValue(pt);
    if (val === null || !Number.isFinite(val)) continue;
    const x = toX(pt.elapsedHours).toFixed(1);
    const y = toY(val).toFixed(1);
    const cmd = activeCoords.length === 0 ? `M${x} ${y}` : `L${x} ${y}`;
    if (!pt.arrived) {
      activeCoords.push(cmd);
    } else {
      if (holdCoords.length === 0) {
        const lastActive = activeCoords[activeCoords.length - 1];
        if (lastActive) {
          holdCoords.push(lastActive.replace(/^M|^L/, "M"));
        }
      }
      const holdCmd = holdCoords.length === 0 ? `M${x} ${y}` : `L${x} ${y}`;
      holdCoords.push(holdCmd);
    }
  }

  return {
    activePath: activeCoords.join(" "),
    holdPath: holdCoords.join(" "),
    curX: null,
    curY: null,
  };
}

function DualTimelineMetricChart({
  spec,
  bundle,
  elapsedHours,
  liveVal1,
  liveVal2,
  onScrub,
}: {
  spec: MetricChartSpec;
  bundle: DualSimTimelineBundle;
  elapsedHours: number;
  liveVal1: number | null;
  liveVal2: number | null;
  onScrub: (nextHours: number) => void;
}) {
  const totalHours = bundle.totalDurationHours;
  let rawMin = spec.minFloor ?? Number.POSITIVE_INFINITY;
  let rawMax = Number.NEGATIVE_INFINITY;

  for (const unitSeries of [bundle.unit1, bundle.unit2]) {
    if (!unitSeries) continue;
    for (const pt of unitSeries.samples) {
      const val = spec.getValue(pt);
      if (val === null || !Number.isFinite(val)) continue;
      if (val < rawMin) rawMin = val;
      if (val > rawMax) rawMax = val;
    }
  }

  if (!Number.isFinite(rawMin) || !Number.isFinite(rawMax)) {
    return null;
  }

  if (Math.abs(rawMax - rawMin) < 1e-3) {
    rawMax = rawMin + 1;
  }
  const padVal = (rawMax - rawMin) * 0.08;
  const yMin = spec.minFloor !== undefined ? Math.min(spec.minFloor, rawMin) : rawMin - padVal;
  const yMax = rawMax + padVal;

  const p1 = buildSeriesPath(bundle.unit1, totalHours, yMin, yMax, spec.getValue);
  const p2 = buildSeriesPath(bundle.unit2, totalHours, yMin, yMax, spec.getValue);

  const spanX = CHART_W - PAD_L - PAD_R;
  const spanY = CHART_H - PAD_T - PAD_B;
  const valRange = Math.max(1e-4, yMax - yMin);
  const cursorX =
    totalHours > 0
      ? PAD_L + (Math.max(0, Math.min(totalHours, elapsedHours)) / totalHours) * spanX
      : PAD_L;
  const dotY = (val: number | null) =>
    val !== null && Number.isFinite(val)
      ? PAD_T + (1 - Math.max(0, Math.min(1, (val - yMin) / valRange))) * spanY
      : null;

  const y1 = dotY(liveVal1);
  const y2 = dotY(liveVal2);

  const handlePointer = (e: PointerEvent<SVGSVGElement>) => {
    if (totalHours <= 0) return;
    if (e.buttons !== 1 && e.type === "pointermove") return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const relX = (e.clientX - rect.left) * (CHART_W / rect.width);
    const ratio = Math.max(0, Math.min(1, (relX - PAD_L) / spanX));
    onScrub(ratio * totalHours);
  };

  return (
    <div className="sim-chart-block">
      <div className="sim-chart-head">
        <span className="value-label">{spec.label}</span>
        <span className="sim-chart-vals">
          {liveVal1 !== null && (
            <span style={{ color: UNIT_ACCENT_COLORS[1] }}>
              1: {liveVal1.toFixed(spec.decimals)}
              {spec.unit}
            </span>
          )}
          {liveVal2 !== null && (
            <span style={{ color: UNIT_ACCENT_COLORS[2] }}>
              2: {liveVal2.toFixed(spec.decimals)}
              {spec.unit}
            </span>
          )}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        className="sim-chart-svg"
        onPointerDown={handlePointer}
        onPointerMove={handlePointer}
        role="img"
        aria-label={`${spec.label} timeline comparison for Unit 1 and Unit 2`}
      >
        <line
          x1={PAD_L}
          y1={CHART_H / 2}
          x2={CHART_W - PAD_R}
          y2={CHART_H / 2}
          stroke="var(--color-line)"
          strokeWidth="1"
          strokeDasharray="2 3"
        />

        {p1.holdPath && (
          <path
            d={p1.holdPath}
            fill="none"
            stroke={UNIT_ACCENT_COLORS[1]}
            strokeOpacity="0.35"
            strokeWidth="1.2"
            strokeDasharray="3 3"
          />
        )}
        {p2.holdPath && (
          <path
            d={p2.holdPath}
            fill="none"
            stroke={UNIT_ACCENT_COLORS[2]}
            strokeOpacity="0.35"
            strokeWidth="1.2"
            strokeDasharray="3 3"
          />
        )}

        {p1.activePath && (
          <path d={p1.activePath} fill="none" stroke={UNIT_ACCENT_COLORS[1]} strokeWidth="1.8" />
        )}
        {p2.activePath && (
          <path d={p2.activePath} fill="none" stroke={UNIT_ACCENT_COLORS[2]} strokeWidth="1.8" />
        )}

        <line
          x1={cursorX}
          y1={0}
          x2={cursorX}
          y2={CHART_H}
          stroke="var(--color-text)"
          strokeOpacity="0.7"
          strokeWidth="1"
        />

        {y1 !== null && (
          <circle
            cx={cursorX}
            cy={y1}
            r="3"
            fill={UNIT_ACCENT_COLORS[1]}
            stroke="#050709"
            strokeWidth="1"
          />
        )}
        {y2 !== null && (
          <circle
            cx={cursorX}
            cy={y2}
            r="3"
            fill={UNIT_ACCENT_COLORS[2]}
            stroke="#050709"
            strokeWidth="1"
          />
        )}
      </svg>

      <div className="sim-chart-bounds">
        <span>
          {rawMin.toFixed(spec.decimals)}..{rawMax.toFixed(spec.decimals)} {spec.unit}
        </span>
      </div>
    </div>
  );
}

function UnitTimelineLane({
  series,
  totalHours,
  elapsedHours,
  endLabel,
}: {
  series: DualSimUnitSeries | null;
  totalHours: number;
  elapsedHours: number;
  endLabel: string;
}) {
  if (!series || totalHours <= 0) {
    return (
      <div className="sim-lane-row is-empty">
        <span className="sim-lane-tag">--</span>
        <div className="sim-lane-track" />
        <span className="sim-lane-eta">NO ROUTE</span>
      </div>
    );
  }

  const unitId = series.unitId;
  const activeSpanPct = Math.max(
    4,
    Math.min(100, (series.timeline.totalDurationHours / totalHours) * 100),
  );
  const cursorPct = Math.max(0, Math.min(100, (elapsedHours / totalHours) * 100));
  const arrived = elapsedHours >= series.timeline.totalDurationHours - 1e-6;
  const activeSamples = series.samples.filter((s) => !s.arrived);
  const segCount = Math.max(1, activeSamples.length);

  return (
    <div className="sim-lane-row">
      <span className={`sim-lane-tag is-u${unitId}`}>U{unitId}</span>
      <div className="sim-lane-track">
        <div className="sim-lane-active" style={{ width: `${activeSpanPct.toFixed(2)}%` }}>
          {activeSamples.map((s, idx) => (
            <span
              key={`${idx}-${s.elapsedHours.toFixed(3)}`}
              className="sim-lane-soil-seg"
              style={{
                width: `${(100 / segCount).toFixed(2)}%`,
                backgroundColor: SOIL_TYPE_CATALOG[s.soilType].colorHex,
              }}
            />
          ))}
        </div>
        <div
          className="sim-lane-cap"
          style={{ left: `${activeSpanPct.toFixed(2)}%`, background: UNIT_ACCENT_COLORS[unitId] }}
        />
        <div className="sim-lane-playhead" style={{ left: `${cursorPct.toFixed(2)}%` }} />
      </div>
      <span className={`sim-lane-eta ${arrived ? "is-done" : ""}`}>
        {arrived ? endLabel : `${series.timeline.totalDurationHours.toFixed(2)}h`}
      </span>
    </div>
  );
}

function UnitLiveCard({
  meta,
  live,
  timelineHours,
}: {
  meta: DualSimUnitMeta;
  live: LiveUnitSimFrame;
  timelineHours: number | null;
}) {
  const sample = live.sample;
  const wxr = live.weather;
  const color = UNIT_ACCENT_COLORS[meta.unitId];
  const presetLabel = TRAVERSE_PRESETS[meta.presetId].label;
  const rangeLabel = meta.waypointCount >= 2 ? `1→${meta.waypointCount}` : "ROUTE";
  const arrivedLabel = meta.waypointCount >= 2 ? `AT #${meta.waypointCount}` : "ARRIVED";

  return (
    <div className="sim-unit-card" style={{ borderTopColor: color }}>
      <div className="sim-unit-head">
        <span className="sim-unit-id" style={{ color }}>
          U{meta.unitId} · {rangeLabel}
        </span>
        <span className="sim-unit-mode">{presetLabel}</span>
      </div>

      {!sample || !meta.route ? (
        <div className="sim-unit-empty">Add waypoints 1, 2...</div>
      ) : (
        <>
          <div className="sim-unit-status-row">
            <span className={`sim-unit-state ${sample.arrived ? "is-arrived" : ""}`}>
              {sample.arrived ? arrivedLabel : `${(sample.progressRatio * 100).toFixed(0)}%`}
            </span>
            <span className="sim-unit-dist">
              {formatRouteDistance(sample.distanceM)} /{" "}
              {formatRouteDistance(meta.route.totalDistanceM)}
            </span>
          </div>

          <div className="sim-unit-grid">
            <div>
              <span className="sim-k">ELEV</span>
              <span className="sim-v">{sample.elevationM.toFixed(0)} m</span>
            </div>
            <div>
              <span className="sim-k">SLOPE</span>
              <span className="sim-v">{sample.slopeDeg.toFixed(1)}°</span>
            </div>
            <div>
              <span className="sim-k">SPEED</span>
              <span className="sim-v">{(sample.speedMPerH / 1000).toFixed(2)} km/h</span>
            </div>
            <div>
              <span className="sim-k">ETA</span>
              <span className="sim-v">
                {timelineHours !== null ? `${timelineHours.toFixed(2)} h` : "--"}
              </span>
            </div>
          </div>

          <div className="sim-unit-footer">
            <span className="sim-soil-badge">
              <span
                className="wx-soil-swatch"
                style={{ backgroundColor: SOIL_TYPE_CATALOG[sample.soilType].colorHex }}
              />
              {SOIL_TYPE_CATALOG[sample.soilType].shortLabel} {sample.soilSpeedFactor.toFixed(2)}x
            </span>
            {wxr && (
              <span className="sim-wxr-mini">
                {wxr.tempC.toFixed(0)}°C · {wxr.pressurePa.toFixed(0)} Pa
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function DualSimulationPanel({
  unit1,
  unit2,
  bundle,
  frame,
  elapsedHours,
  departureLmstHour,
  playing,
  speedMultiplier,
  weather,
  onChangeElapsed,
  onTogglePlay,
  onReset,
  onChangeSpeed,
  onChangeDepartureLmst,
  onSyncDepartureFromWxr,
  onEditUnitRoute,
}: DualSimulationPanelProps) {
  const totalHours = bundle.totalDurationHours;
  const hasAnyRoute = totalHours > 0;
  const currentLmst = departureLmstHour + elapsedHours;
  const sol = resolveSolDisplay(weather?.sol, currentLmst);
  const progressPct =
    totalHours > 0 ? Math.max(0, Math.min(100, (elapsedHours / totalHours) * 100)) : 0;
  const sliderStep = totalHours > 0 ? Math.max(0.01, Number((totalHours / 200).toFixed(3))) : 0.01;

  const liveSpeed1 = frame.unit1.sample
    ? frame.unit1.sample.arrived
      ? 0
      : frame.unit1.sample.speedMPerH / 1000
    : null;
  const liveSpeed2 = frame.unit2.sample
    ? frame.unit2.sample.arrived
      ? 0
      : frame.unit2.sample.speedMPerH / 1000
    : null;

  const liveSlope1 = frame.unit1.sample
    ? frame.unit1.sample.arrived
      ? 0
      : frame.unit1.sample.slopeDeg
    : null;
  const liveSlope2 = frame.unit2.sample
    ? frame.unit2.sample.arrived
      ? 0
      : frame.unit2.sample.slopeDeg
    : null;

  const liveMetricValues: Record<string, [number | null, number | null]> = {
    elev: [frame.unit1.sample?.elevationM ?? null, frame.unit2.sample?.elevationM ?? null],
    slope: [liveSlope1, liveSlope2],
    speed: [liveSpeed1, liveSpeed2],
    temp: [frame.unit1.weather?.tempC ?? null, frame.unit2.weather?.tempC ?? null],
  };

  return (
    <>
      <div className="panel-header">
        <h1 className="panel-title">Dual Simulation</h1>
        <p className="panel-desc">
          Simultaneous start from #1 until both reach their final waypoint.
        </p>
        <div className="panel-rule" />
      </div>

      {/* Quick readiness and edit links for Unit 1 & Unit 2 */}
      <div className="sim-setup-row">
        {[unit1, unit2].map((u) => {
          const tl = u.unitId === 1 ? bundle.unit1?.timeline : bundle.unit2?.timeline;
          const rangeTag = u.waypointCount >= 2 ? `1→${u.waypointCount}` : `${u.waypointCount} PTS`;
          return (
            <button
              key={u.unitId}
              type="button"
              className={`sim-setup-btn ${u.route ? "is-ready" : ""}`}
              onClick={() => onEditUnitRoute(u.unitId)}
            >
              <span
                className="sim-setup-dot"
                style={{ backgroundColor: UNIT_ACCENT_COLORS[u.unitId] }}
              />
              <span className="sim-setup-label">
                U{u.unitId}: {rangeTag}
              </span>
              <span className="sim-setup-meta">
                {u.route && tl
                  ? `${formatRouteDistance(u.route.totalDistanceM)} · ${tl.totalDurationHours.toFixed(2)}h`
                  : "SET ROUTE →"}
              </span>
            </button>
          );
        })}
      </div>

      {!hasAnyRoute ? (
        <div className="alert-box">
          Switch between character 1 and 2 on the left rail and place waypoints 1, 2, 3... on the
          map to simulate both paths.
        </div>
      ) : (
        <>
          {/* Master Playback & Time Slider Card */}
          <div className="sim-time-card">
            <div className="sim-time-head">
              <div className="sim-time-readout">
                <span className="value-label">MISSION ELAPSED</span>
                <div className="sim-clock-row">
                  <span className="mono-value">
                    {formatElapsedClock(elapsedHours)} / {formatElapsedClock(totalHours)}
                  </span>
                  <span className="sim-sol-offset">
                    {elapsedHours.toFixed(2)}/{totalHours.toFixed(2)}h
                  </span>
                </div>
              </div>

              <div className="sim-time-actions">
                <span className={`sim-daylight-tag ${frame.bothArrived ? "is-done" : "is-day"}`}>
                  {frame.bothArrived
                    ? "BOTH DONE"
                    : `${sol.label} · ${formatLmstClock(currentLmst)}`}
                </span>
              </div>
            </div>

            <input
              aria-label="Dual traverse elapsed time slider in hours"
              className="mars-slider"
              type="range"
              min={0}
              max={totalHours}
              step={sliderStep}
              value={Math.min(totalHours, elapsedHours)}
              onChange={(e) => {
                const v = Number.parseFloat(e.target.value);
                if (Number.isFinite(v)) onChangeElapsed(Math.max(0, Math.min(totalHours, v)));
              }}
              style={{
                background: `linear-gradient(90deg, var(--color-accent) ${progressPct}%, var(--color-line-strong) ${progressPct}%)`,
              }}
            />

            <div className="sim-axis-row">
              <span>00:00 (START)</span>
              <span>{formatElapsedClock(totalHours * 0.5)}</span>
              <span>{formatElapsedClock(totalHours)} (DONE)</span>
            </div>

            <div className="sim-controls-bar">
              <div className="sim-btn-group">
                <button
                  type="button"
                  className={`compact-btn sim-play-btn ${playing ? "is-active" : ""}`}
                  onClick={onTogglePlay}
                >
                  {playing ? "PAUSE" : frame.bothArrived ? "REPLAY" : "PLAY"}
                </button>
                <button type="button" className="compact-btn" onClick={onReset}>
                  00:00
                </button>
              </div>

              <div className="sim-btn-group" aria-label="Simulation speed">
                {[1, 4, 10].map((mult) => (
                  <button
                    key={mult}
                    type="button"
                    className={`compact-btn ${speedMultiplier === mult ? "is-active" : ""}`}
                    onClick={() => onChangeSpeed(mult)}
                  >
                    {mult}x
                  </button>
                ))}
              </div>
            </div>

            <div className="sim-dep-row">
              <span className="value-label">DEPART LMST</span>
              <div className="sim-dep-actions">
                <button
                  type="button"
                  className="compact-btn"
                  onClick={() => onChangeDepartureLmst(departureLmstHour - 1)}
                >
                  -1h
                </button>
                <span className="sim-dep-val">{formatLmstClock(departureLmstHour)}</span>
                <button
                  type="button"
                  className="compact-btn"
                  onClick={() => onChangeDepartureLmst(departureLmstHour + 1)}
                >
                  +1h
                </button>
                <button
                  type="button"
                  className="compact-btn"
                  onClick={onSyncDepartureFromWxr}
                  title="Sync departure time with global WXR clock"
                >
                  SYNC WXR
                </button>
              </div>
            </div>
          </div>

          {/* Synchronized Arrival & Soil Ribbon Timeline */}
          <div className="sim-lanes-card">
            <div className="sim-chart-head">
              <span className="value-label">SUBSTRATE & ARRIVAL TIMELINE</span>
              <span className="sim-lane-end">END {totalHours.toFixed(2)}h</span>
            </div>
            <UnitTimelineLane
              series={bundle.unit1}
              totalHours={totalHours}
              elapsedHours={elapsedHours}
              endLabel={unit1.waypointCount >= 2 ? `AT #${unit1.waypointCount}` : "DONE"}
            />
            <UnitTimelineLane
              series={bundle.unit2}
              totalHours={totalHours}
              elapsedHours={elapsedHours}
              endLabel={unit2.waypointCount >= 2 ? `AT #${unit2.waypointCount}` : "DONE"}
            />
          </div>

          {/* Side-by-side Live Unit Cards at Current Time */}
          <div className="sim-live-grid">
            <UnitLiveCard
              meta={unit1}
              live={frame.unit1}
              timelineHours={bundle.unit1?.timeline.totalDurationHours ?? null}
            />
            <UnitLiveCard
              meta={unit2}
              live={frame.unit2}
              timelineHours={bundle.unit2?.timeline.totalDurationHours ?? null}
            />
          </div>

          {/* Stacked Simultaneous Multi-Parameter Timeline Charts */}
          <div className="sim-charts-card">
            <div className="sim-charts-legend">
              <span className="value-label">SYNCHRONIZED TIMELINES</span>
              <span className="sim-legend-tags">
                <span style={{ color: UNIT_ACCENT_COLORS[1] }}>■ U1</span>
                <span style={{ color: UNIT_ACCENT_COLORS[2] }}>■ U2</span>
              </span>
            </div>

            {METRIC_CHARTS.map((spec) => {
              const pair = liveMetricValues[spec.id] ?? [null, null];
              return (
                <DualTimelineMetricChart
                  key={spec.id}
                  spec={spec}
                  bundle={bundle}
                  elapsedHours={elapsedHours}
                  liveVal1={pair[0]}
                  liveVal2={pair[1]}
                  onScrub={onChangeElapsed}
                />
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
