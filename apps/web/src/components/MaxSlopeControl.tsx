import type { ChangeEvent } from "react";

interface MaxSlopeControlProps {
  valueDeg: number;
  onChange: (nextDeg: number) => void;
}

const MIN_SLOPE = 1;
const MAX_SLOPE = 45;

export function MaxSlopeControl({ valueDeg, onChange }: MaxSlopeControlProps) {
  const pct = Math.max(0, Math.min(100, ((valueDeg - MIN_SLOPE) / (MAX_SLOPE - MIN_SLOPE)) * 100));

  const handleRange = (e: ChangeEvent<HTMLInputElement>) => {
    const v = Number.parseFloat(e.target.value);
    if (Number.isFinite(v)) onChange(v);
  };

  const handleNumber = (e: ChangeEvent<HTMLInputElement>) => {
    const v = Number.parseFloat(e.target.value);
    if (Number.isFinite(v)) {
      onChange(Math.max(0.5, Math.min(60, v)));
    }
  };

  return (
    <div className="mars-slider-wrap">
      <div className="field-label-row">
        <span className="value-label">MAX SLOPE</span>
        <span className="mono-value">{valueDeg.toFixed(1)}°</span>
      </div>
      <div className="slope-input-row">
        <input
          aria-label="Max slope in degrees"
          className="mars-slider"
          type="range"
          min={MIN_SLOPE}
          max={MAX_SLOPE}
          step={0.5}
          value={Math.min(MAX_SLOPE, Math.max(MIN_SLOPE, valueDeg))}
          onChange={handleRange}
          style={{
            background: `linear-gradient(90deg, var(--color-accent) ${pct}%, var(--color-line-strong) ${pct}%)`,
          }}
        />
        <input
          aria-label="Max slope exact degrees"
          className="number-input"
          type="number"
          min={0.5}
          max={60}
          step={0.5}
          value={valueDeg}
          onChange={handleNumber}
        />
      </div>
    </div>
  );
}
