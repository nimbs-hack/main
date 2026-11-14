import { TRAVERSE_PRESETS, type TraversePresetId } from "../services/api";

interface TraversePresetControlProps {
  presetId: TraversePresetId;
  onSelectPreset: (id: TraversePresetId) => void;
  compact?: boolean;
}

function PresetGlyph({ presetId, active }: { presetId: TraversePresetId; active: boolean }) {
  const color = active ? "var(--color-text)" : "var(--color-text-muted)";
  if (presetId === "human") {
    return (
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="4.2" r="2.2" stroke={color} strokeWidth="1.5" fill="none" />
        <path
          d="M6.2 8.2h7.6l-.8 5.2H7l-.8-5.2ZM8.2 13.4 7 18M11.8 13.4 13 18M5.2 9.4l-1.5 3.4M14.8 9.4l1.5 3.4"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="square"
          fill="none"
        />
      </svg>
    );
  }
  return (
    <svg width="22" height="20" viewBox="0 0 22 20" aria-hidden="true">
      <rect x="4" y="7.5" width="13" height="4.5" stroke={color} strokeWidth="1.4" fill="none" />
      <path
        d="M14.5 7.5V4.5h3.5M18 4.5h2M7 7.5V5.2M5.5 5.2h3"
        stroke={color}
        strokeWidth="1.4"
        strokeLinecap="square"
        fill="none"
      />
      <circle cx="6" cy="15.2" r="2" stroke={color} strokeWidth="1.4" fill="none" />
      <circle cx="11" cy="15.2" r="2" stroke={color} strokeWidth="1.4" fill="none" />
      <circle cx="16" cy="15.2" r="2" stroke={color} strokeWidth="1.4" fill="none" />
    </svg>
  );
}

const PRESET_ORDER: readonly TraversePresetId[] = ["human", "rover"];

export function TraversePresetControl({
  presetId,
  onSelectPreset,
  compact = false,
}: TraversePresetControlProps) {
  const activePreset = TRAVERSE_PRESETS[presetId];

  return (
    <div className="preset-block">
      <div className="field-label-row">
        <span className="value-label">MISSION PRESET</span>
        <span className="mono-value">
          {activePreset.label} · {activePreset.maxSlopeDeg}°
        </span>
      </div>

      <fieldset className="preset-grid" aria-label="Mission preset">
        {PRESET_ORDER.map((id) => {
          const preset = TRAVERSE_PRESETS[id];
          const isActive = preset.id === presetId;
          const speedKmh = (preset.limits.flatSpeedMPerH / 1000).toFixed(1);
          return (
            <button
              key={preset.id}
              type="button"
              aria-pressed={isActive}
              className={`preset-card ${isActive ? "is-active" : ""}`}
              onClick={() => onSelectPreset(preset.id)}
            >
              <div className="preset-card-top">
                <PresetGlyph presetId={preset.id} active={isActive} />
                <div className="preset-card-titles">
                  <span className="preset-card-label">{preset.label}</span>
                  <span className="preset-card-sub">{preset.subtitle}</span>
                </div>
              </div>

              <div className="preset-card-specs">
                <span>{preset.maxSlopeDeg}°</span>
                <span>{speedKmh} km/h</span>
                <span>{preset.limits.maxEvaHours} h</span>
              </div>
            </button>
          );
        })}
      </fieldset>

      {!compact && (
        <div className="preset-summary-bar">
          <span>TEMP ≥ {activePreset.limits.minAirTempC}°C</span>
          <span>WIND ≤ {activePreset.limits.maxWindSpeedMps} m/s</span>
          <span>P ≥ {activePreset.limits.minPressurePa} Pa</span>
          <span>CLIMB {activePreset.limits.climbSpeedMPerH} m/h</span>
        </div>
      )}
    </div>
  );
}
