import type { MarsCoord } from "@nimbs/shared";

interface ContextMenuProps {
  x: number;
  y: number;
  coord: MarsCoord;
  hasWaypoints: boolean;
  canAddPoint?: boolean;
  onSetA: (coord: MarsCoord) => void;
  onSetB: (coord: MarsCoord) => void;
  onAddPoint: (coord: MarsCoord) => void;
  onClear: () => void;
  onClose: () => void;
}

export function ContextMenu({
  x,
  y,
  coord,
  hasWaypoints,
  canAddPoint = true,
  onSetA,
  onSetB,
  onAddPoint,
  onClear,
  onClose,
}: ContextMenuProps) {
  const clampedLeft = Math.min(x, window.innerWidth - 230);
  const clampedTop = Math.min(y, window.innerHeight - 190);

  return (
    <div
      className="context-menu"
      style={{ left: clampedLeft, top: clampedTop }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="context-menu-coords">
        {coord.lat.toFixed(5)}°, {coord.lon.toFixed(5)}°
      </div>
      <button
        type="button"
        className="context-menu-item"
        onClick={() => {
          onSetA(coord);
          onClose();
        }}
      >
        <span>Set A Waypoint</span>
        <span className="context-menu-tag">A</span>
      </button>
      <button
        type="button"
        className="context-menu-item"
        onClick={() => {
          onSetB(coord);
          onClose();
        }}
      >
        <span>Set B Waypoint</span>
        <span className="context-menu-tag" style={{ color: "var(--color-ok)" }}>
          B
        </span>
      </button>
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
      {hasWaypoints && (
        <button
          type="button"
          className="context-menu-item"
          onClick={() => {
            onClear();
            onClose();
          }}
        >
          <span>Clear Waypoints</span>
          <span className="context-menu-tag" style={{ color: "var(--color-text-dim)" }}>
            CLR
          </span>
        </button>
      )}
    </div>
  );
}
