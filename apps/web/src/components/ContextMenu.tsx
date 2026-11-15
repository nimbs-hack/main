import type { MarsCoord, MissionUnitId } from "@nimbs/shared";
import { UNIT_ACCENT_COLORS } from "../services/dualSim";

interface ContextMenuProps {
  x: number;
  y: number;
  coord: MarsCoord;
  activeUnitId: MissionUnitId;
  waypointCount: number;
  suggestedInsertIndex: number | null;
  canAddPoint?: boolean;
  onAppendWaypoint: (coord: MarsCoord) => void;
  onInsertIntermediate: (coord: MarsCoord) => void;
  onRemoveLastWaypoint: () => void;
  onAddPoint: (coord: MarsCoord) => void;
  onClear: () => void;
  onClose: () => void;
}

export function ContextMenu({
  x,
  y,
  coord,
  activeUnitId,
  waypointCount,
  suggestedInsertIndex,
  canAddPoint = true,
  onAppendWaypoint,
  onInsertIntermediate,
  onRemoveLastWaypoint,
  onAddPoint,
  onClear,
  onClose,
}: ContextMenuProps) {
  const clampedLeft = Math.min(x, window.innerWidth - 240);
  const clampedTop = Math.min(y, window.innerHeight - 235);
  const unitColor = UNIT_ACCENT_COLORS[activeUnitId];
  const nextNumber = waypointCount + 1;

  return (
    <div
      className="context-menu"
      style={{ left: clampedLeft, top: clampedTop }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="context-menu-coords">
        <span className="context-menu-unit-dot" style={{ backgroundColor: unitColor }} />
        <span>
          U{activeUnitId} · {coord.lat.toFixed(5)}°, {coord.lon.toFixed(5)}°
        </span>
      </div>
      <button
        type="button"
        className="context-menu-item"
        onClick={() => {
          onAppendWaypoint(coord);
          onClose();
        }}
      >
        <span>Add Waypoint {nextNumber}</span>
        <span className="context-menu-tag" style={{ color: unitColor }}>
          {nextNumber}
        </span>
      </button>
      {waypointCount >= 2 && suggestedInsertIndex !== null && (
        <button
          type="button"
          className="context-menu-item"
          onClick={() => {
            onInsertIntermediate(coord);
            onClose();
          }}
        >
          <span>
            Insert Stop ({suggestedInsertIndex}→{suggestedInsertIndex + 1})
          </span>
          <span className="context-menu-tag" style={{ color: unitColor }}>
            MID
          </span>
        </button>
      )}
      {canAddPoint && (
        <button
          type="button"
          className="context-menu-item"
          onClick={() => {
            onAddPoint(coord);
            onClose();
          }}
        >
          <span>Add Classified Point</span>
          <span className="context-menu-tag" style={{ color: "#38bdf8" }}>
            POI
          </span>
        </button>
      )}
      {waypointCount >= 2 && (
        <button
          type="button"
          className="context-menu-item"
          onClick={() => {
            onRemoveLastWaypoint();
            onClose();
          }}
        >
          <span>Remove Last (#{waypointCount})</span>
          <span className="context-menu-tag" style={{ color: "var(--color-text-dim)" }}>
            -{waypointCount}
          </span>
        </button>
      )}
      {waypointCount >= 1 && (
        <button
          type="button"
          className="context-menu-item"
          onClick={() => {
            onClear();
            onClose();
          }}
        >
          <span>Clear Waypoints ({waypointCount})</span>
          <span className="context-menu-tag" style={{ color: "var(--color-text-dim)" }}>
            CLR
          </span>
        </button>
      )}
    </div>
  );
}
