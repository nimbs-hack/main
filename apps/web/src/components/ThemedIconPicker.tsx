import { useEffect, useMemo, useState } from "react";
import {
  MIL2525C_BY_ID,
  MIL2525C_SYMBOLS,
  MIL2525C_THEMES,
  type Mil2525cSymbol,
  type Mil2525cThemeId,
} from "../assets/milStd2525c";
import type { CorePointIconKey, PointIconKey } from "../services/pointStore";
import { CORE_TO_MIL2525C_ID, PointClassIcon, resolvePointSymbolMeta } from "./PointClassIcon";

function resolveSymbolId(icon: PointIconKey | undefined): Mil2525cSymbol["id"] | undefined {
  if (!icon) return undefined;
  if (MIL2525C_BY_ID[icon]) return icon as Mil2525cSymbol["id"];
  return CORE_TO_MIL2525C_ID[icon as CorePointIconKey];
}

function formatSelectedLabel(
  value: PointIconKey | undefined,
  resolvedMeta: Mil2525cSymbol | undefined,
  inheritLabel?: string,
): string {
  if (!value) {
    return inheritLabel ? `Default (${inheritLabel})` : "Default symbol";
  }
  return resolvedMeta ? resolvedMeta.name : value;
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
 * Groups MIL-STD-2525C tactical symbols into five operational themes so one category renders at a time.
 */
export function ThemedIconPicker({
  value,
  color,
  inheritIcon = "marker",
  inheritLabel,
  collapsible = false,
  onChange,
}: ThemedIconPickerProps) {
  const effectiveIcon = value ?? inheritIcon;
  const resolvedMeta = useMemo(() => resolvePointSymbolMeta(effectiveIcon), [effectiveIcon]);

  const initialTheme: Mil2525cThemeId = useMemo(
    () => resolvedMeta?.theme ?? "tactical",
    [resolvedMeta],
  );

  const [expanded, setExpanded] = useState(!collapsible);
  const [activeTheme, setActiveTheme] = useState<Mil2525cThemeId>(initialTheme);

  useEffect(() => {
    if (value) {
      const targetMeta = resolvePointSymbolMeta(value);
      if (targetMeta) {
        setActiveTheme(targetMeta.theme);
      }
    }
  }, [value]);

  const visibleSymbols = useMemo(
    () => MIL2525C_SYMBOLS.filter((symbol) => symbol.theme === activeTheme),
    [activeTheme],
  );
  const activeThemeMeta = MIL2525C_THEMES.find((theme) => theme.id === activeTheme);
  const selectedId = resolveSymbolId(value ?? (collapsible ? undefined : inheritIcon));
  const summaryLabel = formatSelectedLabel(value, resolvedMeta, inheritLabel);

  return (
    <div className="poi-icon-picker-wrap">
      <div className="poi-icon-summary-bar">
        <div
          className="poi-icon-preview"
          title={resolvedMeta ? `${resolvedMeta.name} | SIDC ${resolvedMeta.sidc}` : undefined}
        >
          <PointClassIcon icon={effectiveIcon} color={color} size={15} />
          <span className="poi-icon-summary-text">{summaryLabel}</span>
          {resolvedMeta && (
            <span className="poi-icon-tile-code" style={{ flexShrink: 0 }}>
              {resolvedMeta.sidc}
            </span>
          )}
        </div>
        {collapsible && (
          <div style={{ display: "flex", gap: "4px", flexShrink: 0 }}>
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
        )}
      </div>

      {expanded && (
        <div className="poi-icon-drawer">
          <div className="poi-theme-tabs" role="tablist" aria-label="MIL-STD-2525C symbol themes">
            {MIL2525C_THEMES.map((theme) => {
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
            <span>{visibleSymbols.length} SYMBOLS</span>
          </div>

          <div className="poi-icon-grid">
            {visibleSymbols.map((symbol) => {
              const isSelected = selectedId === symbol.id;
              return (
                <button
                  key={symbol.id}
                  type="button"
                  className={`poi-icon-tile ${isSelected ? "is-selected" : ""}`}
                  style={{ borderColor: isSelected ? color : undefined }}
                  title={`${symbol.name} | SIDC ${symbol.sidc}`}
                  onClick={() => onChange(symbol.id)}
                >
                  <PointClassIcon icon={symbol.id} color={color} size={16} />
                  <span className="poi-icon-tile-label">{symbol.name}</span>
                  <span className="poi-icon-tile-code">{symbol.sidc}</span>
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
