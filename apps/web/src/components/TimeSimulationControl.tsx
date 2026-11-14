import type { EvaStatus, EvaWeatherEvaluation, MarsWeatherSnapshot } from "../services/api";

const MARS_SCALE_HEIGHT_M = 10_800;
const MARS_LAPSE_RATE_K_PER_M = -0.0025;
const QUICK_JUMP_HOURS = [7, 12, 15, 22] as const;

export function evaStatusClass(status: EvaStatus): string {
  if (status === "GO") return "is-go";
  if (status === "DEGRADED") return "is-degraded";
  return "is-nogo";
}

export function clampSimLmstHour(rawHour: number): number {
  if (!Number.isFinite(rawHour)) return 12;
  const clamped = Math.max(0, Math.min(47.5, rawHour));
  return Math.round(clamped * 2) / 2;
}

export function formatLmstClock(offsetHours: number): string {
  const wrapped = ((offsetHours % 24) + 24) % 24;
  let hh = Math.floor(wrapped);
  let mm = Math.round((wrapped - hh) * 60);
  if (mm >= 60) {
    hh = (hh + 1) % 24;
    mm = 0;
  }
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function resolveSolDisplay(
  baseSol: number | null | undefined,
  offsetHours: number,
): { solOffset: 0 | 1; solNumber: number | null; label: string } {
  const solOffset: 0 | 1 = offsetHours >= 24 ? 1 : 0;
  if (baseSol !== null && baseSol !== undefined && Number.isFinite(baseSol)) {
    const solNumber = baseSol + solOffset;
    return {
      solOffset,
      solNumber,
      label: `SOL ${solNumber}`,
    };
  }
  return {
    solOffset,
    solNumber: null,
    label: solOffset === 1 ? "SOL +1" : "SOL +0",
  };
}

export function resolveHourIsDaylight(
  offsetHours: number,
  weather: MarsWeatherSnapshot | null,
  evaluation: EvaWeatherEvaluation | null,
): boolean {
  const selected = evaluation?.selectedHourWeather;
  if (selected && Math.abs(selected.offsetHours - offsetHours) < 0.25) {
    return selected.isDaylight;
  }

  const solOffset = offsetHours >= 24 ? 1 : 0;
  const hourIdx = Math.floor(((offsetHours % 24) + 24) % 24);
  const hourly = solOffset === 1 ? (weather?.nextSol?.hourly ?? weather?.hourly) : weather?.hourly;
  const point = hourly?.find((pt) => pt.lmstHour === hourIdx) ?? hourly?.[hourIdx];
  if (point) {
    return point.isDaylight;
  }

  const hourInSol = ((offsetHours % 24) + 24) % 24;
  return hourInSol >= 6 && hourInSol < 18;
}

export function estimateLocalWeatherAtElevation(
  elevationM: number,
  offsetHours: number,
  weather: MarsWeatherSnapshot | null,
): { pressurePa: number; tempC: number } | null {
  if (!weather || !Number.isFinite(elevationM) || weather.hourly.length === 0) {
    return null;
  }

  const sol0 = weather.hourly;
  const sol1 = weather.nextSol?.hourly ?? weather.hourly;
  const getPoint = (idx48: number) => {
    const wrapped = ((idx48 % 48) + 48) % 48;
    if (wrapped < 24) {
      return sol0[wrapped] ?? sol0[0];
    }
    return sol1[wrapped - 24] ?? sol1[0] ?? sol0[0];
  };

  const clamped = Math.max(0, Math.min(47.999, offsetHours));
  const h0 = Math.floor(clamped);
  const h1 = h0 + 1;
  const frac = clamped - h0;
  const p0 = getPoint(h0);
  const p1 = getPoint(h1);
  if (!p0 || !p1) return null;

  const refTempK = p0.tempK + (p1.tempK - p0.tempK) * frac;
  const refPressurePa = p0.pressurePa + (p1.pressurePa - p0.pressurePa) * frac;
  const deltaElevM = elevationM - weather.pressure.referenceElevationM;
  const pressurePa = refPressurePa * Math.exp(-deltaElevM / MARS_SCALE_HEIGHT_M);
  const tempK = refTempK + MARS_LAPSE_RATE_K_PER_M * deltaElevM;

  return {
    pressurePa,
    tempC: tempK - 273.15,
  };
}

interface TimeSimulationControlProps {
  lmstHour: number;
  isPlaying: boolean;
  baseSol?: number | null;
  weather: MarsWeatherSnapshot | null;
  evaluation: EvaWeatherEvaluation | null;
  compact?: boolean;
  onChangeHour: (nextHour: number) => void;
  onJumpHour: (nextHour: number) => void;
  onTogglePlay: () => void;
}

export function TimeSimulationControl({
  lmstHour,
  isPlaying,
  baseSol,
  weather,
  evaluation,
  compact = false,
  onChangeHour,
  onJumpHour,
  onTogglePlay,
}: TimeSimulationControlProps) {
  const clamped = clampSimLmstHour(lmstHour);
  const sol = resolveSolDisplay(baseSol ?? weather?.sol, clamped);
  const clock = formatLmstClock(clamped);
  const isDaylight = resolveHourIsDaylight(clamped, weather, evaluation);
  const pct = (clamped / 47.5) * 100;
  const hourInSol = ((clamped % 24) + 24) % 24;

  return (
    <div className={`sim-time-card ${compact ? "is-compact" : ""}`}>
      <div className="sim-time-head">
        <div className="sim-time-readout">
          <span className="value-label">{compact ? "TIME (LMST)" : "SIM TIME"}</span>
          <div className="sim-clock-row">
            <span className="mono-value">
              {sol.label} · {clock} LMST
            </span>
            {sol.solOffset === 1 && <span className="sim-sol-offset">+1D</span>}
          </div>
        </div>

        <div className="sim-time-actions">
          <span className={`sim-daylight-tag ${isDaylight ? "is-day" : "is-night"}`}>
            {isDaylight ? "DAYLIGHT" : "NIGHT"}
          </span>
          <button
            type="button"
            className={`compact-btn sim-play-btn ${isPlaying ? "is-active" : ""}`}
            onClick={onTogglePlay}
          >
            {isPlaying ? "PAUSE" : "PLAY"}
          </button>
        </div>
      </div>

      <input
        aria-label="Simulation time in LMST hours across 48 hours"
        className="mars-slider"
        type="range"
        min={0}
        max={47.5}
        step={0.5}
        value={clamped}
        onChange={(e) => {
          const val = Number.parseFloat(e.target.value);
          if (Number.isFinite(val)) {
            onChangeHour(clampSimLmstHour(val));
          }
        }}
        style={{
          background: `linear-gradient(90deg, var(--color-accent) ${pct}%, var(--color-line-strong) ${pct}%)`,
        }}
      />

      <div className="sim-axis-row">
        <span>00:00</span>
        <span>12:00</span>
        <span>SOL +1</span>
        <span>12:00</span>
        <span>23:30</span>
      </div>

      {!compact && (
        <div className="sim-quick-row">
          {QUICK_JUMP_HOURS.map((hour) => {
            const target = sol.solOffset * 24 + hour;
            const isActive = Math.abs(hourInSol - hour) < 0.25;
            const label = `${String(hour).padStart(2, "0")}:00`;
            return (
              <button
                key={hour}
                type="button"
                className={`compact-btn sim-quick-btn ${isActive ? "is-active" : ""}`}
                onClick={() => onJumpHour(target)}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
