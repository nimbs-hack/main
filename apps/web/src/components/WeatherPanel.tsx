import type {
  EvaWeatherEvaluation,
  EvaWeatherLimits,
  MarsWeatherSnapshot,
  WeatherCheckId,
  WeatherScenario,
} from "../services/api";
import { TimeSimulationControl, evaStatusClass } from "./TimeSimulationControl";
import { TraverseWindowsPanel } from "./TraverseWindowsPanel";

export { evaStatusClass };

interface WeatherPanelProps {
  weather: MarsWeatherSnapshot | null;
  evaluation: EvaWeatherEvaluation | null;
  limits: EvaWeatherLimits;
  scenario: WeatherScenario;
  simLmstHour: number;
  isPlayingTime: boolean;
  loading: boolean;
  error: string | null;
  hasSelectedRoute: boolean;
  onChangeLimits: (next: EvaWeatherLimits) => void;
  onResetLimits: () => void;
  onChangeScenario: (scenario: WeatherScenario) => void;
  onChangeSimHour: (nextHour: number) => void;
  onJumpSimHour: (nextHour: number) => void;
  onTogglePlayTime: () => void;
  onRefresh: () => void;
}

interface WeatherSliderSpec {
  id: WeatherCheckId;
  key: keyof EvaWeatherLimits;
  label: string;
  shortTag: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  decimals: number;
  minCaption: string;
  maxCaption: string;
}

const SLIDER_SPECS: readonly WeatherSliderSpec[] = [
  {
    id: "air_temp",
    key: "minAirTempC",
    label: "MIN AIR TEMP",
    shortTag: "TEMP",
    unit: "°C",
    min: -130,
    max: 10,
    step: 1,
    decimals: 0,
    minCaption: "-130 °C",
    maxCaption: "+10 °C",
  },
  {
    id: "wind_speed",
    key: "maxWindSpeedMps",
    label: "MAX WIND",
    shortTag: "WIND",
    unit: "m/s",
    min: 2,
    max: 35,
    step: 0.5,
    decimals: 1,
    minCaption: "2 m/s",
    maxCaption: "35 m/s",
  },
  {
    id: "pressure",
    key: "minPressurePa",
    label: "MIN PRESS",
    shortTag: "PA",
    unit: "Pa",
    min: 400,
    max: 950,
    step: 5,
    decimals: 0,
    minCaption: "400 Pa",
    maxCaption: "950 Pa",
  },
  {
    id: "pressure_swing",
    key: "maxPressureSwingPa",
    label: "MAX SWING",
    shortTag: "SWG",
    unit: "Pa",
    min: 5,
    max: 100,
    step: 1,
    decimals: 0,
    minCaption: "5 Pa",
    maxCaption: "100 Pa",
  },
  {
    id: "eva_duration",
    key: "maxEvaHours",
    label: "MAX EVA",
    shortTag: "DUR",
    unit: "h",
    min: 0.5,
    max: 12,
    step: 0.5,
    decimals: 1,
    minCaption: "0.5 h",
    maxCaption: "12 h",
  },
];

const SCENARIO_OPTIONS: readonly { id: WeatherScenario; label: string }[] = [
  { id: "auto", label: "AUTO" },
  { id: "nominal", label: "NOMINAL" },
  { id: "dust-storm", label: "DUST" },
  { id: "cold-snap", label: "COLD" },
];

function kelvinToC(kelvin: number): number {
  return kelvin - 273.15;
}

function clampSpec(spec: WeatherSliderSpec, raw: number): number {
  if (!Number.isFinite(raw)) return spec.min;
  return Math.max(spec.min, Math.min(spec.max, raw));
}

export function WeatherPanel({
  weather,
  evaluation,
  limits,
  scenario,
  simLmstHour,
  isPlayingTime,
  loading,
  error,
  hasSelectedRoute,
  onChangeLimits,
  onResetLimits,
  onChangeScenario,
  onChangeSimHour,
  onJumpSimHour,
  onTogglePlayTime,
  onRefresh,
}: WeatherPanelProps) {
  const checksById = new Map(evaluation?.checks.map((c) => [c.id, c]) ?? []);

  const updateLimit = (spec: WeatherSliderSpec, nextValue: number) => {
    const clamped = clampSpec(spec, nextValue);
    onChangeLimits({
      ...limits,
      [spec.key]: clamped,
    });
  };

  const selectedHourWeather = evaluation?.selectedHourWeather;
  const activeHourInSol = Math.floor(((simLmstHour % 24) + 24) % 24);
  const activeSolOffset = simLmstHour >= 24 ? 24 : 0;

  // Build normalized 24H temperature & wind SVG curve paths
  const hourlyChart = (() => {
    if (!weather || weather.hourly.length < 2) return null;
    const W = 384;
    const H = 92;
    const padX = 6;
    const padY = 8;
    const innerW = W - padX * 2;
    const innerH = H - padY * 2;
    const temps = weather.hourly.map((h) => kelvinToC(h.tempK));
    const winds = weather.hourly.map((h) => h.windSpeedMps);

    const minT = Math.min(-100, limits.minAirTempC - 8, ...temps);
    const maxT = Math.max(5, limits.minAirTempC + 10, ...temps);
    const spanT = Math.max(10, maxT - minT);

    const maxW = Math.max(15, limits.maxWindSpeedMps * 1.15, ...winds);
    const toX = (idx: number) => padX + (idx / (weather.hourly.length - 1)) * innerW;
    const toTY = (t: number) => padY + innerH - ((t - minT) / spanT) * innerH;
    const toWY = (w: number) => padY + innerH - (w / maxW) * innerH;

    const tempPath = weather.hourly
      .map(
        (h, i) =>
          `${i === 0 ? "M" : "L"}${toX(i).toFixed(1)},${toTY(kelvinToC(h.tempK)).toFixed(1)}`,
      )
      .join(" ");
    const windPath = weather.hourly
      .map(
        (h, i) => `${i === 0 ? "M" : "L"}${toX(i).toFixed(1)},${toWY(h.windSpeedMps).toFixed(1)}`,
      )
      .join(" ");

    const tempLimitY = toTY(limits.minAirTempC);
    const windLimitY = toWY(limits.maxWindSpeedMps);
    const daylightLeft = padX + (6 / 23) * innerW;
    const daylightWidth = ((18 - 6) / 23) * innerW;
    const cursorX = toX(Math.min(23, Math.max(0, activeHourInSol)));

    return {
      W,
      H,
      padX,
      padY,
      innerH,
      tempPath,
      windPath,
      tempLimitY,
      windLimitY,
      daylightLeft,
      daylightWidth,
      cursorX,
      minT: Math.min(...temps),
      maxT: Math.max(...temps),
      maxW: Math.max(...winds),
    };
  })();

  const sourceTag = weather
    ? weather.sourceType === "simulated"
      ? "SIM"
      : weather.sourceType === "hybrid"
        ? "HYBRID"
        : "NASA"
    : "";

  const provenanceTip = weather
    ? [
        weather.sourceLabel,
        weather.realChannels.length > 0 ? `REAL: ${weather.realChannels.join(", ")}` : null,
        weather.simulatedChannels.length > 0
          ? `SIM: ${weather.simulatedChannels.join(", ")}`
          : null,
        weather.disclaimer ?? null,
      ]
        .filter(Boolean)
        .join(" | ")
    : "";

  return (
    <>
      <div className="panel-header">
        <h1 className="panel-title">Weather &amp; EVA</h1>
        <p className="panel-desc">Suit limits vs Mars telemetry.</p>
        <div className="panel-rule" />
      </div>

      <div className="wx-toolbar">
        <div className="wx-scenario-tabs" role="tablist" aria-label="Weather scenario">
          {SCENARIO_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              role="tab"
              aria-selected={scenario === opt.id}
              className={`wx-scenario-tab ${scenario === opt.id ? "is-active" : ""}`}
              onClick={() => onChangeScenario(opt.id)}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="compact-btn"
          disabled={loading}
          onClick={onRefresh}
          title="Refresh NASA weather feed or regenerate sol"
        >
          {loading ? "..." : "SYNC"}
        </button>
      </div>

      <TimeSimulationControl
        lmstHour={simLmstHour}
        isPlaying={isPlayingTime}
        baseSol={weather?.sol}
        weather={weather}
        evaluation={evaluation}
        onChangeHour={onChangeSimHour}
        onJumpHour={onJumpSimHour}
        onTogglePlay={onTogglePlayTime}
      />

      {error && <div className="alert-box">{error}</div>}

      {/* Compact graphical verdict + 5-check strip + hour telemetry */}
      {evaluation && weather && (
        <div
          className={`wx-verdict-card ${evaStatusClass(evaluation.status)}`}
          title={`${evaluation.summary}${provenanceTip ? ` — ${provenanceTip}` : ""}`}
        >
          <div className="wx-verdict-top">
            <div className="wx-verdict-badge-wrap">
              <span className={`wx-status-pill ${evaStatusClass(evaluation.status)}`}>
                EVA {evaluation.status}
              </span>
              <span className="mono-value">SOL {weather.sol}</span>
            </div>

            <div className="wx-verdict-right">
              {sourceTag && (
                <span
                  className={`wx-source-chip ${weather.isSimulated ? "is-sim" : ""}`}
                  title={provenanceTip}
                >
                  {sourceTag}
                  {weather.realChannels.length > 0 && weather.simulatedChannels.length > 0
                    ? " · MEDA+SIM"
                    : ""}
                </span>
              )}
              <span className="wx-meta-mono">Ls {weather.lsDeg.toFixed(0)}°</span>
            </div>
          </div>

          <div className="wx-checks-strip">
            {SLIDER_SPECS.map((spec) => {
              const chk = checksById.get(spec.id);
              const cls = chk ? evaStatusClass(chk.status) : "is-go";
              return (
                <div key={spec.id} className={`wx-check-pip ${cls}`} title={chk?.reason}>
                  <span className="wx-check-dot" />
                  <span>{spec.shortTag}</span>
                </div>
              );
            })}
          </div>

          <div className="wx-verdict-meta">
            <span>
              {evaluation.safeWindow.startLmst && evaluation.safeWindow.endLmst
                ? `SAFE ${evaluation.safeWindow.startLmst}..${evaluation.safeWindow.endLmst} (${evaluation.safeWindow.durationHours.toFixed(0)}h)`
                : "NO SAFE WINDOW"}
            </span>
            <span>
              ELEV {evaluation.evaluationElevationM.toFixed(0)}m{hasSelectedRoute ? " RTE" : ""}
            </span>
            {evaluation.estimatedRouteHours !== null && (
              <span>WALK {evaluation.estimatedRouteHours.toFixed(1)}h</span>
            )}
          </div>
        </div>
      )}

      {selectedHourWeather && evaluation && weather && (
        <div className="wx-telemetry-strip">
          <div className="wx-tel-cell">
            <span className="wx-tel-k">FLOOR {evaluation.floorElevationM.toFixed(0)}m</span>
            <span className="wx-tel-v">{selectedHourWeather.floorTempC.toFixed(0)}°C</span>
            <span className="wx-tel-s">{selectedHourWeather.floorPressurePa.toFixed(0)}Pa</span>
          </div>
          <div className="wx-tel-cell">
            <span className="wx-tel-k">RIM {evaluation.evaluationElevationM.toFixed(0)}m</span>
            <span className="wx-tel-v">{selectedHourWeather.rimTempC.toFixed(0)}°C</span>
            <span className="wx-tel-s">{selectedHourWeather.rimPressurePa.toFixed(0)}Pa</span>
          </div>
          <div className="wx-tel-cell">
            <span className="wx-tel-k">WIND</span>
            <span className="wx-tel-v">{selectedHourWeather.windSpeedMps.toFixed(1)}m/s</span>
            <span className="wx-tel-s">{weather.wind.compassPoint}</span>
          </div>
          <div className="wx-tel-cell">
            <span className="wx-tel-k">UV / τ</span>
            <span className="wx-tel-v">UV {selectedHourWeather.uvIndex.toFixed(1)}</span>
            <span className="wx-tel-s">τ {weather.dustOpacityTau.toFixed(2)}</span>
          </div>
        </div>
      )}

      {/* 24H Diurnal SVG Graph + Interactive Hour Selector */}
      {weather && hourlyChart && (
        <div className="wx-hourly-card">
          <div className="field-label-row" style={{ marginBottom: 4 }}>
            <span className="value-label">24H DIURNAL</span>
            <span className="wx-meta-mono">
              <span style={{ color: "#38bdf8" }}>
                {hourlyChart.minT.toFixed(0)}..{hourlyChart.maxT.toFixed(0)}°C
              </span>
              {" · "}
              <span style={{ color: "#eab308" }}>MAX {hourlyChart.maxW.toFixed(1)}m/s</span>
            </span>
          </div>

          <svg
            viewBox={`0 0 ${hourlyChart.W} ${hourlyChart.H}`}
            className="wx-hourly-svg"
            role="img"
            aria-label="24-hour temperature and wind curves"
          >
            <title>24-hour Mars diurnal temperature and wind chart</title>
            <rect
              x={hourlyChart.daylightLeft}
              y={hourlyChart.padY}
              width={hourlyChart.daylightWidth}
              height={hourlyChart.innerH}
              fill="rgba(255, 248, 243, 0.04)"
            />
            <line
              x1={hourlyChart.padX}
              y1={hourlyChart.tempLimitY}
              x2={hourlyChart.W - hourlyChart.padX}
              y2={hourlyChart.tempLimitY}
              stroke="#38bdf8"
              strokeOpacity="0.5"
              strokeDasharray="3 3"
              strokeWidth="1"
            />
            <line
              x1={hourlyChart.padX}
              y1={hourlyChart.windLimitY}
              x2={hourlyChart.W - hourlyChart.padX}
              y2={hourlyChart.windLimitY}
              stroke="#eab308"
              strokeOpacity="0.45"
              strokeDasharray="2 3"
              strokeWidth="1"
            />
            <path d={hourlyChart.windPath} fill="none" stroke="#eab308" strokeWidth="1.4" />
            <path d={hourlyChart.tempPath} fill="none" stroke="#38bdf8" strokeWidth="1.7" />
            <line
              x1={hourlyChart.cursorX}
              y1={hourlyChart.padY}
              x2={hourlyChart.cursorX}
              y2={hourlyChart.H - hourlyChart.padY}
              stroke="#de233d"
              strokeWidth="1.5"
            />
          </svg>

          <div className="wx-hourly-bars" role="img" aria-label="24-hour Martian sol EVA window">
            {weather.hourly.map((hour) => {
              const tempC = kelvinToC(hour.tempK);
              const passTemp = tempC >= limits.minAirTempC;
              const passWind = hour.windSpeedMps <= limits.maxWindSpeedMps;
              const barOk = hour.isDaylight && passTemp && passWind;
              const barWarn = hour.isDaylight && (!passTemp || !passWind);
              const heightPct = Math.max(18, Math.min(100, ((tempC + 130) / 150) * 100));
              const stateCls = barOk ? "is-go" : barWarn ? "is-degraded" : "is-night";
              const isSelectedHour = hour.lmstHour === activeHourInSol;

              return (
                <button
                  key={hour.lmstHour}
                  type="button"
                  className={`wx-hour-col ${isSelectedHour ? "is-selected" : ""}`}
                  onClick={() => onJumpSimHour(activeSolOffset + hour.lmstHour)}
                  aria-label={`Set time to ${hour.lmstLabel} LMST`}
                  title={`${hour.lmstLabel} LMST · ${tempC.toFixed(1)}°C · ${hour.windSpeedMps.toFixed(1)} m/s · ${hour.pressurePa.toFixed(0)} Pa`}
                >
                  <span className={`wx-hour-bar ${stateCls}`} style={{ height: `${heightPct}%` }} />
                </button>
              );
            })}
          </div>
          <div className="wx-hourly-axis">
            <span>00:00</span>
            <span>06:00</span>
            <span>12:00</span>
            <span>18:00</span>
            <span>23:00</span>
          </div>
        </div>
      )}

      <TraverseWindowsPanel
        evaluation={evaluation}
        activeLmstHour={simLmstHour}
        baseSol={weather?.sol}
        onSelectDepartureHour={onJumpSimHour}
      />

      <div className="divider" />

      <div className="wx-sliders-header">
        <span className="value-label">SUIT THRESHOLDS</span>
        <button type="button" className="compact-btn" onClick={onResetLimits}>
          RESET
        </button>
      </div>

      <div className="wx-sliders-list">
        {SLIDER_SPECS.map((spec) => {
          const val = limits[spec.key];
          const check = checksById.get(spec.id);
          const pct = Math.max(0, Math.min(100, ((val - spec.min) / (spec.max - spec.min)) * 100));
          return (
            <div key={spec.id} className="mars-slider-wrap wx-slider-item">
              <div className="field-label-row">
                <label className="value-label" htmlFor={`wx-${spec.id}`}>
                  {spec.label}
                </label>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span className="mono-value">
                    {val.toFixed(spec.decimals)} {spec.unit}
                  </span>
                  {check && (
                    <span className={`wx-status-tag ${evaStatusClass(check.status)}`}>
                      {check.status}
                    </span>
                  )}
                </div>
              </div>

              <div className="slope-input-row">
                <input
                  id={`wx-${spec.id}`}
                  type="range"
                  className="mars-slider"
                  min={spec.min}
                  max={spec.max}
                  step={spec.step}
                  value={val}
                  onChange={(e) => updateLimit(spec, Number(e.target.value))}
                  style={{
                    background: `linear-gradient(90deg, var(--color-accent) ${pct}%, var(--color-line-strong) ${pct}%)`,
                  }}
                />
                <input
                  type="number"
                  className="number-input"
                  aria-label={spec.label}
                  min={spec.min}
                  max={spec.max}
                  step={spec.step}
                  value={val}
                  onChange={(e) => {
                    const num = Number(e.target.value);
                    if (Number.isFinite(num)) updateLimit(spec, num);
                  }}
                />
              </div>

              <div className="wx-slider-foot">
                <span>{spec.minCaption}</span>
                {check ? (
                  <span className="wx-check-reason" title={check.reason}>
                    {check.reason}
                  </span>
                ) : (
                  <span>{spec.maxCaption}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
