import type {
  EvaWeatherEvaluation,
  TraverseDepartureSlot,
  TraverseWindowRecommendation,
} from "../services/api";
import { evaStatusClass } from "./TimeSimulationControl";

interface TraverseWindowsPanelProps {
  evaluation: EvaWeatherEvaluation | null;
  activeLmstHour: number;
  baseSol?: number | null;
  onSelectDepartureHour: (offsetHours: number) => void;
}

function normalizeScore(score: number, maxScore: number): number {
  if (!Number.isFinite(score)) return 0;
  if (maxScore > 0 && maxScore <= 1) {
    return Math.round(score * 100);
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

function findClosestSlot(
  slots: TraverseDepartureSlot[],
  activeLmstHour: number,
): TraverseDepartureSlot | null {
  let closest: TraverseDepartureSlot | null = null;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const slot of slots) {
    const diff = Math.abs(slot.offsetHours - activeLmstHour);
    if (diff < bestDiff) {
      bestDiff = diff;
      closest = slot;
    }
  }
  return closest;
}

export function TraverseWindowsPanel({
  evaluation,
  activeLmstHour,
  baseSol,
  onSelectDepartureHour,
}: TraverseWindowsPanelProps) {
  if (!evaluation) return null;

  const slots = evaluation.departureSlots ?? [];
  const windows = evaluation.recommendedWindows;
  if (slots.length === 0 && windows === undefined) {
    return null;
  }

  const maxSlotScore = slots.reduce((acc, s) => Math.max(acc, s.score), 0);
  const maxWinScore = (windows ?? []).reduce((acc, w) => Math.max(acc, w.score), maxSlotScore);
  const closestSlot = findClosestSlot(slots, activeLmstHour);
  const sol0Number = slots[0]?.sol ?? baseSol ?? null;
  const sol1Slot = slots.find((s) => s.solOffset === 1);
  const sol1Number = sol1Slot?.sol ?? (sol0Number !== null ? sol0Number + 1 : null);
  const cursorPct = Math.max(0, Math.min(100, (activeLmstHour / 48) * 100));

  return (
    <div className="wx-windows-section">
      {slots.length > 0 && (
        <div className="wx-slots-card">
          <div className="field-label-row" style={{ marginBottom: 6 }}>
            <span className="value-label">48H TRAVERSE TIMELINE</span>
            <span className="wx-meta-mono">
              {sol0Number !== null && sol1Number !== null
                ? `SOL ${sol0Number} .. SOL ${sol1Number}`
                : "SOL +0 .. SOL +1"}
            </span>
          </div>

          <div
            className="wx-slots-track"
            style={{ gridTemplateColumns: `repeat(${slots.length}, minmax(0, 1fr))` }}
          >
            <div className="wx-slots-cursor" style={{ left: `${cursorPct}%` }} aria-hidden="true" />
            {slots.map((slot) => {
              const scorePct = normalizeScore(slot.score, maxSlotScore);
              const barHeightPct = Math.max(20, Math.min(100, scorePct));
              const isSelected = closestSlot?.offsetHours === slot.offsetHours;
              const isSolBoundary = sol1Slot?.offsetHours === slot.offsetHours;
              const title = [
                `SOL ${slot.sol} ${slot.startLmstLabel}..${slot.endLmstLabel} LMST`,
                slot.status,
                `${slot.minEncounteredTempC.toFixed(0)}..${slot.maxEncounteredTempC.toFixed(0)} °C`,
                `${slot.minEncounteredPressurePa.toFixed(0)} Pa`,
                `${slot.maxEncounteredWindMps.toFixed(1)} m/s`,
                slot.reason,
              ].join(" · ");

              return (
                <button
                  key={slot.offsetHours}
                  type="button"
                  className={`wx-slot-btn ${evaStatusClass(slot.status)} ${isSelected ? "is-selected" : ""} ${isSolBoundary ? "is-sol-split" : ""}`}
                  onClick={() => onSelectDepartureHour(slot.offsetHours)}
                  title={title}
                  aria-label={`Jump to SOL ${slot.sol} ${slot.startLmstLabel} LMST, ${slot.status}`}
                  aria-pressed={isSelected}
                >
                  <span
                    className={`wx-slot-bar ${evaStatusClass(slot.status)}`}
                    style={{ height: `${barHeightPct}%` }}
                  />
                </button>
              );
            })}
          </div>

          <div className="wx-slots-axis">
            <span>{sol0Number !== null ? `SOL ${sol0Number}` : "SOL +0"}</span>
            <span>12:00</span>
            <span>{sol1Number !== null ? `SOL ${sol1Number}` : "SOL +1"}</span>
            <span>12:00</span>
            <span>24:00</span>
          </div>

          {closestSlot && (
            <div className="wx-slot-detail">
              <span className={`wx-status-tag ${evaStatusClass(closestSlot.status)}`}>
                {closestSlot.status}
              </span>
              <span>
                {closestSlot.startLmstLabel}..{closestSlot.endLmstLabel} LMST ·{" "}
                {closestSlot.minEncounteredTempC.toFixed(0)}..
                {closestSlot.maxEncounteredTempC.toFixed(0)} °C ·{" "}
                {closestSlot.minEncounteredPressurePa.toFixed(0)} Pa ·{" "}
                {closestSlot.maxEncounteredWindMps.toFixed(1)} m/s
              </span>
            </div>
          )}
        </div>
      )}

      {windows !== undefined && (
        <div className="wx-window-list">
          <div className="field-label-row" style={{ marginBottom: 0 }}>
            <span className="value-label">RECOMMENDED WINDOWS</span>
            <span className="wx-meta-mono">{windows.length} FOUND</span>
          </div>

          {windows.length === 0 ? (
            <div className="alert-box">
              No traverse window meets current suit limits across the 48h window.
            </div>
          ) : (
            windows.slice(0, 4).map((win: TraverseWindowRecommendation) => {
              const scoreVal = normalizeScore(win.score, maxWinScore);
              const isSelected = Math.abs(activeLmstHour - win.bestDepartureOffsetHours) < 0.25;
              const rankTag = win.rank === 1 ? "BEST #1" : `#${win.rank}`;

              return (
                <div
                  key={win.id}
                  className={`wx-window-card ${evaStatusClass(win.status)} ${isSelected ? "is-active-window" : ""}`}
                >
                  <div className="wx-window-head">
                    <div className="wx-verdict-badge-wrap">
                      <span className="wx-rank-tag">{rankTag}</span>
                      <span className={`wx-status-pill ${evaStatusClass(win.status)}`}>
                        {win.status}
                      </span>
                      <span className="wx-meta-mono">SCORE {scoreVal}</span>
                    </div>
                    <button
                      type="button"
                      className={`compact-btn wx-use-window-btn ${isSelected ? "is-active" : ""}`}
                      onClick={() => onSelectDepartureHour(win.bestDepartureOffsetHours)}
                    >
                      {isSelected ? "ACTIVE" : "USE WINDOW"}
                    </button>
                  </div>

                  <div className="wx-window-schedule">
                    <span>
                      SOL {win.sol} · {win.windowStartLmst}..{win.windowEndLmst} LMST
                    </span>
                    <span>
                      DEPART {win.bestDepartureLmst} · {win.estimatedDurationHours.toFixed(1)} h
                    </span>
                  </div>

                  <div className="wx-window-metrics">
                    <span>
                      {win.minTempC.toFixed(0)}..{win.maxTempC.toFixed(0)} °C
                    </span>
                    <span>{win.minPressurePa.toFixed(0)} Pa MIN</span>
                    <span>{win.maxWindMps.toFixed(1)} m/s MAX</span>
                  </div>

                  <p className="wx-window-summary">{win.summary}</p>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
