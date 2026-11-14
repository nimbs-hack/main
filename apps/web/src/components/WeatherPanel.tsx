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
    label: "MAX WIND SPEED",
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
    label: "MIN PRESSURE",
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
    label: "MAX BARO SWING",
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
    label: "MAX EVA DURATION",
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
  { id: "dust-storm", label: "DUST STORM" },
  { id: "cold-snap", label: "COLD SNAP" },
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

  const minC = weather ? kelvinToC(weather.airTemp.minK) : null;
  const maxC = weather ? kelvinToC(weather.airTemp.maxK) : null;
  const avgC = weather ? kelvinToC(weather.airTemp.avgK) : null;
  const selectedHourWeather = evaluation?.selectedHourWeather;
  const activeHourInSol = Math.floor(((simLmstHour % 24) + 24) % 24);
  const activeSolOffset = simLmstHour >= 24 ? 24 : 0;

  return (
    <>
      <div className="panel-header">
        <h1 className="panel-title">Weather &amp; EVA</h1>
        <p className="panel-desc">
          Compare Mars atmospheric telemetry or simulated conditions against EVA suit sliders.
        </p>
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

      {evaluation && weather && (
        <div className={`wx-verdict-card ${evaStatusClass(evaluation.status)}`}>
          <div className="wx-verdict-top">
            <div className="wx-verdict-badge-wrap">
              <span className={`wx-status-pill ${evaStatusClass(evaluation.status)}`}>
                EVA {evaluation.status}
              </span>
              <span className="mono-value">SOL {weather.sol}</span>
            </div>
            <span className="wx-meta-mono">
              Ls {weather.lsDeg.toFixed(0)}° · {weather.terrestrialDate}
            </span>
          </div>

          <p className="wx-verdict-summary">{evaluation.summary}</p>

          <div className="wx-verdict-meta">
            <span>
              EVAL ELEV {evaluation.evaluationElevationM.toFixed(0)} m
              {hasSelectedRoute ? " · ROUTE MAX" : " · SITE"}
            </span>
            <span>
              SAFE WINDOW{" "}
              {evaluation.safeWindow.startLmst && evaluation.safeWindow.endLmst
                ? `${evaluation.safeWindow.startLmst}..${evaluation.safeWindow.endLmst} · ${evaluation.safeWindow.durationHours.toFixed(1)} h`
                : "NONE"}
            </span>
            {evaluation.estimatedRouteHours !== null && (
              <span>WALK EST {evaluation.estimatedRouteHours.toFixed(2)} h</span>
            )}
          </div>
        </div>
      )}

      {selectedHourWeather && evaluation && (
        <div className="wx-hour-card">
          <div className="field-label-row" style={{ marginBottom: 6 }}>
            <span className="value-label">SELECTED HOUR TELEMETRY</span>
            <span className="wx-meta-mono">
              SOL {selectedHourWeather.sol} · {selectedHourWeather.lmstLabel} LMST ·{" "}
              {selectedHourWeather.isDaylight ? "DAYLIGHT" : "NIGHT"}
            </span>
          </div>
          <div className="readout-grid">
            <div className="readout-card">
              <span className="value-label">FLOOR {evaluation.floorElevationM.toFixed(0)} m</span>
              <span className="mono-value">{selectedHourWeather.floorTempC.toFixed(1)} °C</span>
              <span className="readout-sub">
                {selectedHourWeather.floorPressurePa.toFixed(0)} Pa
              </span>
            </div>
            <div className="readout-card">
              <span className="value-label">
                RIM {evaluation.evaluationElevationM.toFixed(0)} m
              </span>
              <span className="mono-value">{selectedHourWeather.rimTempC.toFixed(1)} °C</span>
              <span className="readout-sub">{selectedHourWeather.rimPressurePa.toFixed(0)} Pa</span>
            </div>
            <div className="readout-card">
              <span className="value-label">HOUR WIND</span>
              <span className="mono-value">{selectedHourWeather.windSpeedMps.toFixed(1)} m/s</span>
            </div>
            <div className="readout-card">
              <span className="value-label">HOUR UV</span>
              <span className="mono-value">UV {selectedHourWeather.uvIndex.toFixed(1)}</span>
            </div>
          </div>
        </div>
      )}

      {weather && (
        <div className={weather.isSimulated ? "alert-box" : "readout-card"}>
          <div className="field-label-row" style={{ marginBottom: 4 }}>
            <span className="value-label">
              {weather.sourceType === "simulated"
                ? "SIMULATED WEATHER DATA"
                : weather.sourceType === "hybrid"
                  ? "HYBRID TELEMETRY"
                  : "REAL NASA TELEMETRY"}
            </span>
            <span className="wx-meta-mono">{weather.site.name.toUpperCase()}</span>
          </div>
          <span
            className="readout-sub"
            style={{ display: "block", color: "var(--color-text-muted)" }}
          >
            {weather.sourceLabel}
          </span>
          {weather.realChannels.length > 0 && (
            <span className="readout-sub" style={{ display: "block", marginTop: 4 }}>
              REAL: {weather.realChannels.join(", ")}
            </span>
          )}
          {weather.simulatedChannels.length > 0 && (
            <span className="readout-sub" style={{ display: "block", marginTop: 2 }}>
              SIMULATED: {weather.simulatedChannels.join(", ")}
            </span>
          )}
          {weather.disclaimer && (
            <span className="readout-sub" style={{ display: "block", marginTop: 4 }}>
              {weather.disclaimer}
            </span>
          )}
        </div>
      )}

      {weather && evaluation && (
        <div className="readout-grid">
          <div className="readout-card">
            <span className="value-label">AIR TEMP</span>
            <span className="mono-value">
              {minC?.toFixed(0)}..{maxC?.toFixed(0)} °C
            </span>
            <span className="readout-sub">
              AVG {avgC?.toFixed(1)} °C · {weather.airTemp.avgK.toFixed(0)} K
            </span>
          </div>
          <div className="readout-card">
            <span className="value-label">WIND GUST</span>
            <span className="mono-value">
              {weather.wind.maxMps.toFixed(1)} m/s {weather.wind.compassPoint}
            </span>
            <span className="readout-sub">AVG {weather.wind.avgMps.toFixed(1)} m/s</span>
          </div>
          <div className="readout-card">
            <span className="value-label">RIM PRESSURE</span>
            <span className="mono-value">{evaluation.rimPressureMinPa.toFixed(0)} Pa MIN</span>
            <span className="readout-sub">
              SWING {weather.pressure.swingPa.toFixed(0)} Pa · REF{" "}
              {weather.pressure.avgPa.toFixed(0)} Pa
            </span>
          </div>
          <div className="readout-card">
            <span className="value-label">DUST &amp; UV</span>
            <span className="mono-value">TAU {weather.dustOpacityTau.toFixed(2)}</span>
            <span className="readout-sub">
              UV {weather.uvIndexMax.toFixed(1)} · {weather.solarIrradiancePeakWm2.toFixed(0)} W/m²
            </span>
          </div>
        </div>
      )}

      {weather && (
        <div className="wx-hourly-card">
          <div className="field-label-row" style={{ marginBottom: 6 }}>
            <span className="value-label">SOL 24H WINDOW</span>
            <span className="wx-meta-mono">
              {weather.daylight.sunriseLmst}..{weather.daylight.sunsetLmst} LMST
            </span>
          </div>
          <div className="wx-hourly-bars" role="img" aria-label="24-hour Martian sol EVA window">
            {weather.hourly.map((hour) => {
              const tempC = kelvinToC(hour.tempK);
              const passTemp = tempC >= limits.minAirTempC;
              const passWind = hour.windSpeedMps <= limits.maxWindSpeedMps;
              const barOk = hour.isDaylight && passTemp && passWind;
              const barWarn = hour.isDaylight && (!passTemp || !passWind);
              const heightPct = Math.max(14, Math.min(100, ((tempC + 130) / 150) * 100));
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
            <span>00</span>
            <span>06</span>
            <span>12</span>
            <span>18</span>
            <span>23 LMST</span>
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
        <span className="value-label">EVA SUIT &amp; WEATHER LIMITS</span>
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
                  <span className="wx-check-reason">{check.reason}</span>
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
