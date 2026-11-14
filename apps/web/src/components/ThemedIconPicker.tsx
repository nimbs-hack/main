import { useEffect, useMemo, useState } from "react";
import {
  FGDC_SYMBOLS,
  FGDC_SYMBOL_BY_ID,
  FGDC_THEMES,
  type FgdcThemeId,
} from "../assets/fgdcSymbols";
import type { CorePointIconKey, PointIconKey } from "../services/pointStore";
import { PointClassIcon } from "./PointClassIcon";

interface IconOption {
  key: PointIconKey;
  label: string;
  code?: string;
  title?: string;
  theme: FgdcThemeId;
}

const CORE_ICON_OPTIONS: readonly IconOption[] = [
  { key: "science", label: "Prism", theme: "eva" },
  { key: "sample", label: "Cache", theme: "eva" },
  { key: "habitat", label: "Base", theme: "eva" },
  { key: "supply", label: "Power", theme: "eva" },
  { key: "hazard", label: "Alert", theme: "eva" },
  { key: "beacon", label: "Beacon", theme: "eva" },
  { key: "marker", label: "Pin", theme: "eva" },
];

const ALL_ICON_OPTIONS: readonly IconOption[] = [
  ...CORE_ICON_OPTIONS,
  ...FGDC_SYMBOLS.map((symbol) => ({
    key: symbol.id as PointIconKey,
    label: symbol.label,
    code: symbol.fgdcCode,
    title: symbol.sourceName,
    theme: symbol.theme,
  })),
];

function formatSelectedLabel(value: PointIconKey | undefined, inheritLabel?: string): string {
  if (!value) {
    return inheritLabel ? `Default (${inheritLabel})` : "Default icon";
  }
  const fgdc = FGDC_SYMBOL_BY_ID[value];
  if (fgdc) return `FGDC ${fgdc.fgdcCode} · ${fgdc.label}`;
  const core = CORE_ICON_OPTIONS.find((opt) => opt.key === value);
  return core ? core.label : value;
}

interface ThemedIconPickerProps {
  value?: PointIconKey;
  color: string;
  inheritIcon?: PointIconKey;
  inheritLabel?: string;
  collapsible?: boolean;
  onChange: (next: PointIconKey | undefined) => void;
}

/**
 * Classifies geologic FGDC and EVA symbols by theme so only one theme is shown at a time.
 */
export function ThemedIconPicker({
  value,
  color,
  inheritIcon = "marker",
  inheritLabel,
  collapsible = false,
  onChange,
}: ThemedIconPickerProps) {
  const initialTheme: FgdcThemeId = useMemo(() => {
    if (value && FGDC_SYMBOL_BY_ID[value]) {
      return FGDC_SYMBOL_BY_ID[value].theme;
    }
    return value ? "eva" : "tectonics";
  }, [value]);

  const [expanded, setExpanded] = useState(!collapsible);
  const [activeTheme, setActiveTheme] = useState<FgdcThemeId>(initialTheme);

  useEffect(() => {
    if (value && FGDC_SYMBOL_BY_ID[value]) {
      setActiveTheme(FGDC_SYMBOL_BY_ID[value].theme);
    }
  }, [value]);

  const visibleIcons = useMemo(
    () => ALL_ICON_OPTIONS.filter((opt) => opt.theme === activeTheme),
    [activeTheme],
  );
  const activeThemeMeta = FGDC_THEMES.find((theme) => theme.id === activeTheme);
  const effectiveIcon = value ?? inheritIcon;

  return (
    <div className="poi-icon-picker-wrap">
      {collapsible && (
        <div className="poi-icon-summary-bar">
          <div className="poi-icon-preview">
            <PointClassIcon icon={effectiveIcon} color={color} size={15} />
            <span className="poi-icon-summary-text">
              {formatSelectedLabel(value, inheritLabel)}
            </span>
          </div>
          <div style={{ display: "flex", gap: "4px" }}>
            {value && (
              <button type="button" className="compact-btn" onClick={() => onChange(undefined)}>
                RESET
              </button>
            )}
            <button
              type="button"
              className={`compact-btn ${expanded ? "is-active" : ""}`}
              onClick={() => setExpanded((prev) => !prev)}
            >
              {expanded ? "HIDE" : "SYMBOLS"}
            </button>
          </div>
        </div>
      )}

      {expanded && (
        <div className="poi-icon-drawer">
          <div className="poi-theme-tabs" role="tablist" aria-label="Symbol themes">
            {FGDC_THEMES.map((theme) => {
              const selected = theme.id === activeTheme;
              return (
                <button
                  key={theme.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className={`poi-theme-tab ${selected ? "is-active" : ""}`}
                  title={theme.label}
                  onClick={() => setActiveTheme(theme.id)}
                >
                  {theme.shortLabel}
                </button>
              );
            })}
          </div>

          <div className="poi-theme-caption">
            <span>{activeThemeMeta?.label ?? ""}</span>
            <span>{visibleIcons.length} ICONS</span>
          </div>

          <div className="poi-icon-grid">
            {visibleIcons.map((opt) => {
              const isSelected = (value ?? (collapsible ? undefined : inheritIcon)) === opt.key;
              return (
                <button
                  key={opt.key}
                  type="button"
                  className={`poi-icon-tile ${isSelected ? "is-selected" : ""}`}
                  style={{ borderColor: isSelected ? color : undefined }}
                  title={opt.title ?? opt.label}
                  onClick={() => onChange(opt.key)}
                >
                  <PointClassIcon icon={opt.key} color={color} size={16} />
                  <span className="poi-icon-tile-label">{opt.label}</span>
                  {opt.code && <span className="poi-icon-tile-code">{opt.code}</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export type { CorePointIconKey };
