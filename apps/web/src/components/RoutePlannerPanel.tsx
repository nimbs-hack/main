import type {
  ComputedRoute,
  LonFormat,
  MarsCoord,
  RoutePlanResponse,
  RoutePoint,
  RouteStrategy,
  TraversePresetId,
  UiMode,
} from "@nimbs/shared";
import {
  type EvaWeatherEvaluation,
  type EvaWeatherLimits,
  type RouteBlockedReason,
  TRAVERSE_PRESETS,
} from "../services/api";
import { ElevationProfile } from "./ElevationProfile";
import { MaxSlopeControl } from "./MaxSlopeControl";
import { TraversePresetControl } from "./TraversePresetControl";
import { evaStatusClass } from "./WeatherPanel";
import {
  buildSparklineGeometry,
  formatRouteDistance,
  formatShortCoord,
  getRouteStrategyVisual,
} from "./routeVisuals";

interface RoutePlannerPanelProps {
  uiMode: UiMode;
  presetId: TraversePresetId;
  onSelectPreset: (id: TraversePresetId) => void;
  siteCompactLabel: string;
  maxSlopeDeg: number;
  onChangeMaxSlopeDeg: (deg: number) => void;
  weatherRoutingEnabled: boolean;
  onToggleWeatherRouting: () => void;
  weatherLimits: EvaWeatherLimits;
  simClockLabel: string;
  waypointA: MarsCoord | null;
  waypointB: MarsCoord | null;
  onSwapWaypoints: () => void;
  onClearWaypoints: () => void;
  lonFormat: LonFormat;
  routePlan: RoutePlanResponse | null;
  selectedRoute: ComputedRoute | null;
  onSelectRoute: (id: string) => void;
  routingBusy: boolean;
  siteError: string | null;
  onHoverProfilePoint: (pt: RoutePoint | null) => void;
  weatherEval: EvaWeatherEvaluation | null;
  onOpenWeatherPanel: () => void;
}

function StrategyGlyph({ strategy, color }: { strategy: RouteStrategy; color: string }) {
  if (strategy === "shortest") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M9.5 1.5L3.5 9h4l-1 5.5L12.5 7h-4l1-5.5z" fill={color} />
      </svg>
    );
  }
  if (strategy === "gentlest") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M1.5 12.5L14.5 12.5M2.5 10.5L13.5 6.5"
          stroke={color}
          strokeWidth="1.6"
          strokeLinecap="square"
          fill="none"
        />
      </svg>
    );
  }
  if (strategy === "alternate") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M2 12c2.5-6 4-8 6-8s3.5 2 6 8" stroke={color} strokeWidth="1.6" fill="none" />
        <circle cx="2" cy="12" r="1.5" fill={color} />
        <circle cx="14" cy="12" r="1.5" fill={color} />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 1.5L13.5 4v4.2c0 3.2-2.2 5.4-5.5 6.3-3.3-.9-5.5-3.1-5.5-6.3V4L8 1.5z"
        stroke={color}
        strokeWidth="1.4"
        fill="none"
      />
      <circle cx="8" cy="7.5" r="1.8" fill={color} />
    </svg>
  );
}

function blockedReasonTag(reason?: RouteBlockedReason): string {
  if (reason === "slope") return "SLOPE";
  if (reason === "temperature") return "TEMP";
  if (reason === "pressure") return "PRESS";
  if (reason === "combined") return "SLOPE + WXR";
  return "BOUNDS";
}

function slopeToneColor(slopeDeg: number, maxSlopeDeg: number): string {
  const ratio = maxSlopeDeg > 0 ? slopeDeg / maxSlopeDeg : 0;
  if (ratio > 1) return "var(--color-accent)";
  if (ratio >= 0.72) return "var(--color-warn)";
  return "var(--color-ok)";
}

export function RoutePlannerPanel({
  uiMode,
  presetId,
  onSelectPreset,
  siteCompactLabel,
  maxSlopeDeg,
  onChangeMaxSlopeDeg,
  weatherRoutingEnabled,
  onToggleWeatherRouting,
  weatherLimits,
  simClockLabel,
  waypointA,
  waypointB,
  onSwapWaypoints,
  onClearWaypoints,
  lonFormat,
  routePlan,
  selectedRoute,
  onSelectRoute,
  routingBusy,
  siteError,
  onHoverProfilePoint,
  weatherEval,
  onOpenWeatherPanel,
}: RoutePlannerPanelProps) {
  const maxRouteDist = Math.max(1, ...(routePlan?.routes.map((r) => r.totalDistanceM) ?? [1]));

  const passablePct = routePlan
    ? Math.max(0, Math.min(100, routePlan.passableEdgeRatio * 100))
    : null;

  return (
    <>
      <div className="panel-header">
        <h1 className="panel-title">Route</h1>
        <p className="panel-desc">Right-click map for A and B in {siteCompactLabel} km grid.</p>
        <div className="panel-rule" />
      </div>

      {/* Compact A -> B corridor strip */}
      <div className="rte-corridor">
        <div className={`rte-wp-slot ${waypointA ? "is-set" : ""}`}>
          <div className="rte-wp-badge is-a">A</div>
          <div className="rte-wp-info">
            <span className="rte-wp-elev">
              {routePlan?.snappedA
                ? `${routePlan.snappedA.elevationM.toFixed(0)} m`
                : waypointA
                  ? "SET"
                  : "---"}
            </span>
            <span className="rte-wp-coord">
              {waypointA ? formatShortCoord(waypointA, lonFormat) : "R-CLICK"}
            </span>
          </div>
        </div>

        <div className="rte-corridor-mid">
          <div className={`rte-track-line ${routingBusy ? "is-busy" : ""}`} />
          <div className="rte-mid-controls">
            {waypointA && waypointB && (
              <button
                type="button"
                className="rte-icon-btn"
                title="Swap A and B"
                onClick={onSwapWaypoints}
              >
                ⇄
              </button>
            )}
            {(waypointA || waypointB) && (
              <button
                type="button"
                className="rte-icon-btn"
                title="Clear waypoints"
                onClick={onClearWaypoints}
              >
                ×
              </button>
            )}
          </div>
          {selectedRoute && (
            <span className="rte-mid-dist">
              {formatRouteDistance(selectedRoute.totalDistanceM)}
            </span>
          )}
        </div>

        <div className={`rte-wp-slot is-right ${waypointB ? "is-set" : ""}`}>
          <div className="rte-wp-info">
            <span className="rte-wp-elev">
              {routePlan?.snappedB
                ? `${routePlan.snappedB.elevationM.toFixed(0)} m`
                : waypointB
                  ? "SET"
                  : "---"}
            </span>
            <span className="rte-wp-coord">
              {waypointB ? formatShortCoord(waypointB, lonFormat) : "R-CLICK"}
            </span>
          </div>
          <div className="rte-wp-badge is-b">B</div>
        </div>
      </div>

      {/* Slope + Weather constraint strip */}
      {uiMode === "basic" ? (
        <TraversePresetControl presetId={presetId} onSelectPreset={onSelectPreset} compact />
      ) : (
        <MaxSlopeControl valueDeg={maxSlopeDeg} onChange={onChangeMaxSlopeDeg} />
      )}

      <div className="rte-filter-bar">
        <button
          type="button"
          className={`rte-filter-toggle ${weatherRoutingEnabled ? "is-on" : ""}`}
          onClick={onToggleWeatherRouting}
        >
          <span className={`rte-dot ${weatherRoutingEnabled ? "is-ok" : ""}`} />
          <span>WXR {weatherRoutingEnabled ? "ON" : "OFF"}</span>
        </button>

        <button
          type="button"
          className="rte-limit-pills"
          onClick={onOpenWeatherPanel}
          title={
            uiMode === "basic"
              ? "View weather and traverse windows"
              : "Edit suit weather thresholds and traverse speeds"
          }
        >
          {weatherRoutingEnabled ? (
            <>
              <span>T ≥ {weatherLimits.minAirTempC.toFixed(0)}°</span>
              <span>P ≥ {weatherLimits.minPressurePa.toFixed(0)}</span>
              <span>{simClockLabel}</span>
            </>
          ) : (
            <span>SLOPE ONLY · {simClockLabel}</span>
          )}
        </button>

        {passablePct !== null && (
          <div
            className="rte-pass-meter"
            title={`Passable graph edges: ${passablePct.toFixed(1)}%`}
          >
            <div className="rte-pass-track">
              <div
                className="rte-pass-fill"
                style={{
                  width: `${passablePct.toFixed(1)}%`,
                  background:
                    passablePct < 20
                      ? "var(--color-accent)"
                      : passablePct < 55
                        ? "var(--color-warn)"
                        : "var(--color-ok)",
                }}
              />
            </div>
            <span className="rte-pass-val">{passablePct.toFixed(0)}%</span>
          </div>
        )}
      </div>

      {siteError && <div className="alert-box">{siteError}</div>}

      {/* Visual Blocked / Unreachable Card */}
      {routePlan && routePlan.status !== "ok" && (
        <div className="rte-blocked-card">
          <div className="rte-blocked-head">
            <span className="rte-blocked-tag">
              BLOCKED · {blockedReasonTag(routePlan.blockedReason)}
            </span>
            <div className="rte-blocked-actions">
              {uiMode === "advance" &&
                routePlan.minRequiredSlopeDeg !== undefined &&
                routePlan.minRequiredSlopeDeg > maxSlopeDeg &&
                (() => {
                  const targetDeg = Math.ceil(routePlan.minRequiredSlopeDeg * 2) / 2;
                  return (
                    <button
                      type="button"
                      className="compact-btn"
                      onClick={() => onChangeMaxSlopeDeg(targetDeg)}
                    >
                      SET {targetDeg.toFixed(1)}°
                    </button>
                  );
                })()}
              {uiMode === "basic" &&
                presetId === "human" &&
                routePlan.minRequiredSlopeDeg !== undefined &&
                routePlan.minRequiredSlopeDeg > maxSlopeDeg &&
                routePlan.minRequiredSlopeDeg <= TRAVERSE_PRESETS.rover.maxSlopeDeg && (
                  <button
                    type="button"
                    className="compact-btn"
                    onClick={() => onSelectPreset("rover")}
                  >
                    ROVER {TRAVERSE_PRESETS.rover.maxSlopeDeg}°
                  </button>
                )}
              <button type="button" className="compact-btn" onClick={onOpenWeatherPanel}>
                WXR →
              </button>
            </div>
          </div>

          <div className="rte-gap-bars">
            {routePlan.minRequiredSlopeDeg !== undefined && (
              <div className="rte-gap-row">
                <span className="rte-gap-lbl">SLOPE</span>
                <div className="rte-gap-track">
                  <div
                    className="rte-gap-cur"
                    style={{ width: `${Math.min(100, (maxSlopeDeg / 45) * 100)}%` }}
                  />
                  <div
                    className="rte-gap-req"
                    style={{ left: `${Math.min(98, (routePlan.minRequiredSlopeDeg / 45) * 100)}%` }}
                  />
                </div>
                <span className="rte-gap-num">
                  {maxSlopeDeg.toFixed(0)}° → {routePlan.minRequiredSlopeDeg.toFixed(1)}°
                </span>
              </div>
            )}

            {routePlan.maxFeasibleMinTempC !== undefined && (
              <div className="rte-gap-row">
                <span className="rte-gap-lbl">TEMP</span>
                <div className="rte-gap-track is-temp">
                  <span className="rte-gap-inline">
                    MIN {routePlan.maxFeasibleMinTempC.toFixed(1)}°C
                  </span>
                </div>
                <span className="rte-gap-num">LIM {weatherLimits.minAirTempC.toFixed(0)}°C</span>
              </div>
            )}

            {routePlan.maxFeasibleMinPressurePa !== undefined && (
              <div className="rte-gap-row">
                <span className="rte-gap-lbl">PRESS</span>
                <div className="rte-gap-track is-press">
                  <span className="rte-gap-inline">
                    MAX {routePlan.maxFeasibleMinPressurePa.toFixed(0)} Pa
                  </span>
                </div>
                <span className="rte-gap-num">LIM {weatherLimits.minPressurePa.toFixed(0)} Pa</span>
              </div>
            )}

            {routePlan.status === "out_of_bounds" && (
              <span className="rte-gap-inline">Waypoint outside {siteCompactLabel} km site</span>
            )}
          </div>
        </div>
      )}

      {/* Graphical Candidate Route Cards */}
      {routePlan && routePlan.routes.length > 0 && (
        <div className="rte-route-list">
          {routePlan.routes.map((rt) => {
            const isSelected = rt.id === selectedRoute?.id;
            const visual = getRouteStrategyVisual(rt.strategy);
            const swatchColor = isSelected ? visual.selectedColor : visual.color;
            const distPct = Math.max(12, Math.min(100, (rt.totalDistanceM / maxRouteDist) * 100));
            const slopePct = Math.max(
              6,
              Math.min(100, (rt.maxSlopeDeg / Math.max(1, maxSlopeDeg)) * 100),
            );
            const spark = buildSparklineGeometry(rt, 86, 30);

            return (
              <button
                key={rt.id}
                type="button"
                className={`rte-card ${isSelected ? "is-selected" : ""}`}
                onClick={() => onSelectRoute(rt.id)}
              >
                <span className="rte-card-stripe" style={{ background: swatchColor }} />

                <div className="rte-card-main">
                  <div className="rte-card-top">
                    <span className="rte-card-title-wrap">
                      <StrategyGlyph strategy={rt.strategy} color={swatchColor} />
                      <span className="rte-card-name">{visual.shortLabel}</span>
                    </span>
                    <span className="rte-card-primary">
                      {formatRouteDistance(rt.totalDistanceM)} · {rt.maxSlopeDeg.toFixed(1)}°
                    </span>
                  </div>

                  <div className="rte-card-bars">
                    <div className="rte-bar-pair" title="Relative route length">
                      <span className="rte-bar-k">D</span>
                      <div className="rte-mini-track">
                        <div
                          className="rte-mini-fill"
                          style={{ width: `${distPct.toFixed(0)}%`, background: swatchColor }}
                        />
                      </div>
                    </div>
                    <div className="rte-bar-pair" title="Peak slope vs limit">
                      <span className="rte-bar-k">S</span>
                      <div className="rte-mini-track">
                        <div
                          className="rte-mini-fill"
                          style={{
                            width: `${slopePct.toFixed(0)}%`,
                            background: slopeToneColor(rt.maxSlopeDeg, maxSlopeDeg),
                          }}
                        />
                      </div>
                    </div>
                    <span className="rte-elev-delta">
                      +{rt.elevationGainM.toFixed(0)}/-{rt.elevationLossM.toFixed(0)}m
                    </span>
                    {rt.minTempC !== undefined && (
                      <span className="rte-wx-chip is-temp">{rt.minTempC.toFixed(0)}°</span>
                    )}
                    {rt.minPressurePa !== undefined && (
                      <span className="rte-wx-chip is-press">{rt.minPressurePa.toFixed(0)}Pa</span>
                    )}
                  </div>
                </div>

                {spark && (
                  <svg
                    viewBox="0 0 86 30"
                    className="rte-sparkline"
                    width="86"
                    height="30"
                    aria-hidden="true"
                  >
                    <path d={spark.areaPath} fill={swatchColor} fillOpacity="0.14" />
                    <path d={spark.linePath} fill="none" stroke={swatchColor} strokeWidth="1.5" />
                    <rect
                      x={spark.peakSlopeX - 1.5}
                      y={spark.peakSlopeY - 1.5}
                      width="3"
                      height="3"
                      fill={slopeToneColor(rt.maxSlopeDeg, maxSlopeDeg)}
                    />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Multi-layer interactive elevation + slope + weather graphic */}
      {selectedRoute && (
        <ElevationProfile
          route={selectedRoute}
          maxSlopeDeg={maxSlopeDeg}
          minAirTempC={weatherRoutingEnabled ? weatherLimits.minAirTempC : undefined}
          minPressurePa={weatherRoutingEnabled ? weatherLimits.minPressurePa : undefined}
          onHoverPoint={onHoverProfilePoint}
        />
      )}

      {/* Compact 1-line EVA status strip */}
      {weatherEval && (
        <button
          type="button"
          className={`rte-eva-strip ${evaStatusClass(weatherEval.status)}`}
          onClick={onOpenWeatherPanel}
        >
          <span className={`wx-status-tag ${evaStatusClass(weatherEval.status)}`}>
            EVA {weatherEval.status}
          </span>
          <span className="rte-eva-meta">
            {weatherEval.estimatedRouteHours !== null
              ? `~${weatherEval.estimatedRouteHours.toFixed(1)}h · `
              : ""}
            {simClockLabel} LMST
            {weatherEval.selectedHourWeather
              ? ` · ${weatherEval.selectedHourWeather.rimTempC.toFixed(0)}°C · ${weatherEval.selectedHourWeather.windSpeedMps.toFixed(1)} m/s`
              : ` · MIN ${(weatherEval.rimTempMinK - 273.15).toFixed(0)}°C`}
          </span>
          <span className="rte-eva-link">WXR →</span>
        </button>
      )}
    </>
  );
}
