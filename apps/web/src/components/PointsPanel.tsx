import { type LonFormat, type MarsCoord, lon180To360 } from "@nimbs/shared";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import {
  type MapPoint,
  type MapPointClass,
  POINT_CLASS_SWATCHES,
  type PointIconKey,
} from "../services/pointStore";
import { PointClassIcon, resolvePointSymbolMeta } from "./PointClassIcon";
import { ThemedIconPicker } from "./ThemedIconPicker";

interface PointsPanelProps {
  classes: MapPointClass[];
  points: MapPoint[];
  hiddenClassIds: string[];
  lonFormat: LonFormat;
  pendingCoord: MarsCoord | null;
  pendingElevM: number | null;
  editingPoint: MapPoint | null;
  selectedPointId: string | null;
  pickMode: boolean;
  onTogglePickMode: () => void;
  onCancelDraft: () => void;
  onSavePoint: (payload: {
    id?: string;
    name: string;
    classId: string;
    icon?: PointIconKey;
    description: string;
    coord: MarsCoord;
    elevationM?: number | null;
  }) => void;
  onStartEditPoint: (point: MapPoint) => void;
  onDeletePoint: (pointId: string) => void;
  onFocusPoint: (point: MapPoint) => void;
  onUseAsWaypointA: (coord: MarsCoord) => void;
  onUseAsWaypointB: (coord: MarsCoord) => void;
  onToggleClass: (classId: string) => void;
  onSetAllClassesVisible: (visible: boolean) => void;
  onCreateClass: (payload: {
    name: string;
    shortCode: string;
    color: string;
    icon: PointIconKey;
  }) => void;
  onDeleteCustomClass: (classId: string) => void;
}

function formatCoord(coord: MarsCoord, fmt: LonFormat): string {
  const lonVal = fmt === "360" ? lon180To360(coord.lon) : coord.lon;
  return `${coord.lat.toFixed(4)}° ${lonVal.toFixed(4)}°`;
}

export function PointsPanel({
  classes,
  points,
  hiddenClassIds,
  lonFormat,
  pendingCoord,
  pendingElevM,
  editingPoint,
  selectedPointId,
  pickMode,
  onTogglePickMode,
  onCancelDraft,
  onSavePoint,
  onStartEditPoint,
  onDeletePoint,
  onFocusPoint,
  onUseAsWaypointA,
  onUseAsWaypointB,
  onToggleClass,
  onSetAllClassesVisible,
  onCreateClass,
  onDeleteCustomClass,
}: PointsPanelProps) {
  const [draftName, setDraftName] = useState("");
  const [draftClassId, setDraftClassId] = useState(classes[0]?.id ?? "science");
  const [draftIcon, setDraftIcon] = useState<PointIconKey | undefined>(undefined);
  const [draftDesc, setDraftDesc] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const [showNewClassForm, setShowNewClassForm] = useState(false);
  const [newClassName, setNewClassName] = useState("");
  const [newClassCode, setNewClassCode] = useState("");
  const [newClassColor, setNewClassColor] = useState(POINT_CLASS_SWATCHES[0] ?? "#38bdf8");
  const [newClassIcon, setNewClassIcon] = useState<PointIconKey>("marker");

  const [searchQuery, setSearchQuery] = useState("");

  // Sync draft form whenever editingPoint or pendingCoord opens
  useEffect(() => {
    if (editingPoint) {
      setDraftName(editingPoint.name);
      setDraftClassId(editingPoint.classId);
      setDraftIcon(editingPoint.icon);
      setDraftDesc(editingPoint.description);
      setFormError(null);
      return;
    }
    if (pendingCoord) {
      setDraftName("");
      setDraftIcon(undefined);
      setDraftDesc("");
      setFormError(null);
    }
  }, [editingPoint, pendingCoord]);

  useEffect(() => {
    if (!classes.some((c) => c.id === draftClassId)) {
      setDraftClassId(classes[0]?.id ?? "science");
    }
  }, [classes, draftClassId]);

  const classMap = useMemo(() => new Map(classes.map((c) => [c.id, c])), [classes]);

  const classCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const pt of points) {
      counts.set(pt.classId, (counts.get(pt.classId) ?? 0) + 1);
    }
    return counts;
  }, [points]);

  const filteredPoints = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return points;
    return points.filter((p) => {
      const clsName = classMap.get(p.classId)?.name.toLowerCase() ?? "";
      return (
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        clsName.includes(q)
      );
    });
  }, [points, searchQuery, classMap]);

  const activeCoord = editingPoint?.coord ?? pendingCoord;
  const activeElevM = editingPoint ? editingPoint.elevationM : pendingElevM;
  const isDraftOpen = activeCoord !== null;

  const handlePointSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!activeCoord) return;
    if (!draftName.trim()) {
      setFormError("Enter a point label.");
      return;
    }
    onSavePoint({
      id: editingPoint?.id,
      name: draftName,
      classId: draftClassId,
      icon: draftIcon,
      description: draftDesc,
      coord: activeCoord,
      elevationM: activeElevM,
    });
    setDraftName("");
    setDraftIcon(undefined);
    setDraftDesc("");
    setFormError(null);
  };

  const handleClassSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!newClassName.trim()) return;
    onCreateClass({
      name: newClassName,
      shortCode: newClassCode,
      color: newClassColor,
      icon: newClassIcon,
    });
    setNewClassName("");
    setNewClassCode("");
    setShowNewClassForm(false);
  };

  return (
    <>
      <div className="panel-header">
        <h1 className="panel-title">Points</h1>
        <p className="panel-desc">
          Right-click the map to drop MIL-STD-2525C tactical markers with notes, or toggle point
          classes.
        </p>
        <div className="panel-rule" />
      </div>

      {isDraftOpen ? (
        <form className="poi-form-card" onSubmit={handlePointSubmit}>
          <div className="field-label-row" style={{ marginBottom: 0 }}>
            <span className="value-label">{editingPoint ? "EDIT POINT" : "NEW POINT"}</span>
            <button type="button" className="compact-btn" onClick={onCancelDraft}>
              CANCEL
            </button>
          </div>

          <div className="poi-coord-bar">
            <span>{formatCoord(activeCoord, lonFormat)}</span>
            <span>
              {activeElevM !== null && activeElevM !== undefined
                ? `${activeElevM.toFixed(1)} m`
                : "NO DEM"}
            </span>
          </div>

          <div className="poi-field">
            <span className="value-label">CLASS</span>
            <div className="poi-class-picker">
              {classes.map((cls) => {
                const selected = cls.id === draftClassId;
                const clsSymbol = resolvePointSymbolMeta(cls.icon);
                return (
                  <button
                    key={cls.id}
                    type="button"
                    className={`poi-class-chip ${selected ? "is-selected" : ""}`}
                    style={{
                      borderColor: selected ? cls.color : undefined,
                      color: selected ? "var(--color-text)" : undefined,
                    }}
                    title={clsSymbol ? `${cls.name} | SIDC ${clsSymbol.sidc}` : cls.name}
                    onClick={() => setDraftClassId(cls.id)}
                  >
                    <PointClassIcon icon={cls.icon} color={cls.color} size={13} />
                    <span>{cls.shortCode}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="poi-field">
            <span className="value-label">2525C SYMBOL</span>
            <ThemedIconPicker
              value={draftIcon}
              color={classMap.get(draftClassId)?.color ?? "#38bdf8"}
              inheritIcon={classMap.get(draftClassId)?.icon ?? "marker"}
              inheritLabel={classMap.get(draftClassId)?.shortCode ?? "POI"}
              collapsible
              onChange={setDraftIcon}
            />
          </div>

          <label className="poi-field">
            <span className="value-label">NAME</span>
            <input
              type="text"
              className="text-input"
              maxLength={64}
              placeholder="Boxwork Outcrop"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
            />
          </label>

          <label className="poi-field">
            <span className="value-label">DESCRIPTION</span>
            <textarea
              className="text-input textarea-input"
              rows={2}
              maxLength={280}
              placeholder="Mineral target, supply cache inventory, or terrain note"
              value={draftDesc}
              onChange={(e) => setDraftDesc(e.target.value)}
            />
          </label>

          {formError && <div className="alert-box">{formError}</div>}

          <button type="submit" className="chamfer-btn is-primary">
            <span className="chamfer-btn-body">
              <span className="chamfer-btn-label">
                {editingPoint ? "UPDATE POINT" : "SAVE POINT"}
              </span>
            </span>
            <span className="chamfer-btn-arrow">→</span>
          </button>
        </form>
      ) : (
        <button
          type="button"
          className={`chamfer-btn ${pickMode ? "is-primary" : ""}`}
          onClick={onTogglePickMode}
        >
          <span className="chamfer-btn-body">
            <span className="chamfer-btn-label">
              {pickMode ? "CLICK MAP TO DROP POINT" : "ADD POINT FROM MAP"}
            </span>
          </span>
          <span className="chamfer-btn-arrow">{pickMode ? "×" : "+"}</span>
        </button>
      )}

      <div className="divider" />

      <div className="poi-section">
        <div className="field-label-row">
          <span className="value-label">CLASSES</span>
          <div style={{ display: "flex", gap: "6px" }}>
            <button
              type="button"
              className="compact-btn"
              onClick={() => onSetAllClassesVisible(true)}
            >
              ALL ON
            </button>
            <button
              type="button"
              className="compact-btn"
              onClick={() => onSetAllClassesVisible(false)}
            >
              ALL OFF
            </button>
            <button
              type="button"
              className={`compact-btn ${showNewClassForm ? "is-active" : ""}`}
              onClick={() => setShowNewClassForm((v) => !v)}
            >
              + CLASS
            </button>
          </div>
        </div>

        {showNewClassForm && (
          <form className="poi-form-card" onSubmit={handleClassSubmit}>
            <div className="poi-new-class-row">
              <input
                type="text"
                className="text-input"
                maxLength={28}
                placeholder="Class name, e.g. Rover Relays"
                value={newClassName}
                onChange={(e) => setNewClassName(e.target.value)}
              />
              <input
                type="text"
                className="text-input"
                style={{ width: "68px", textTransform: "uppercase" }}
                maxLength={3}
                placeholder="TAG"
                value={newClassCode}
                onChange={(e) => setNewClassCode(e.target.value)}
              />
            </div>

            <div className="poi-swatch-row">
              {POINT_CLASS_SWATCHES.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  aria-label={`Color ${swatch}`}
                  className={`poi-swatch-btn ${newClassColor === swatch ? "is-selected" : ""}`}
                  style={{ background: swatch }}
                  onClick={() => setNewClassColor(swatch)}
                />
              ))}
            </div>

            <ThemedIconPicker
              value={newClassIcon}
              color={newClassColor}
              inheritLabel={newClassCode.trim().toUpperCase() || "NEW"}
              collapsible={false}
              onChange={(next) => setNewClassIcon(next ?? "marker")}
            />

            <button type="submit" className="compact-btn is-active" style={{ width: "100%" }}>
              CREATE CLASS
            </button>
          </form>
        )}

        <div className="poi-class-list">
          {classes.map((cls) => {
            const visible = !hiddenClassIds.includes(cls.id);
            const count = classCounts.get(cls.id) ?? 0;
            return (
              <div key={cls.id} className="poi-class-row">
                <button
                  type="button"
                  className="poi-class-toggle"
                  onClick={() => onToggleClass(cls.id)}
                >
                  <span className="poi-class-meta">
                    <span className="poi-swatch-dot" style={{ background: cls.color }} />
                    <PointClassIcon icon={cls.icon} color={cls.color} size={14} />
                    <span className="poi-class-title">{cls.name}</span>
                    <span className="poi-count-tag">{count}</span>
                  </span>
                  <span className={`toggle-state ${visible ? "is-on" : ""}`}>
                    {visible ? "SHOW" : "HIDE"}
                  </span>
                </button>
                {!cls.builtIn && count === 0 && (
                  <button
                    type="button"
                    className="poi-del-btn"
                    title="Delete unused custom class"
                    onClick={() => onDeleteCustomClass(cls.id)}
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="divider" />

      <div className="poi-section">
        <div className="field-label-row">
          <span className="value-label">SAVED POINTS ({points.length})</span>
          <span className="mono-value">
            {points.filter((p) => !hiddenClassIds.includes(p.classId)).length} SHOWN
          </span>
        </div>

        {points.length > 0 && (
          <input
            type="search"
            className="text-input"
            placeholder="Filter by name, class, or description..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        )}

        {points.length === 0 ? (
          <div className="readout-card">
            <span className="readout-sub">
              No points yet. Right-click anywhere on the map and select Add Classified Point.
            </span>
          </div>
        ) : filteredPoints.length === 0 ? (
          <div className="readout-card">
            <span className="readout-sub">No points match &quot;{searchQuery}&quot;.</span>
          </div>
        ) : (
          <div className="poi-card-list">
            {filteredPoints.map((pt) => {
              const cls = classMap.get(pt.classId);
              const color = cls?.color ?? "#38bdf8";
              const effectiveIcon = pt.icon ?? cls?.icon ?? "marker";
              const symbolMeta = resolvePointSymbolMeta(effectiveIcon);
              const isHidden = hiddenClassIds.includes(pt.classId);
              const isSelected = pt.id === selectedPointId;

              return (
                <article
                  key={pt.id}
                  className={`poi-card ${isSelected ? "is-selected" : ""} ${isHidden ? "is-dimmed" : ""}`}
                >
                  <div className="poi-card-head">
                    <span
                      className="poi-badge"
                      style={{ borderColor: color, color }}
                      title={
                        symbolMeta
                          ? `${cls?.name ?? pt.classId} | ${symbolMeta.name} (${symbolMeta.sidc})`
                          : (cls?.name ?? pt.classId)
                      }
                    >
                      <PointClassIcon icon={effectiveIcon} color={color} size={12} />
                      <span>{cls?.shortCode ?? "POI"}</span>
                    </span>
                    <strong className="poi-card-title">{pt.name}</strong>
                    {isHidden && <span className="poi-hidden-tag">HIDDEN</span>}
                  </div>

                  {pt.description && <p className="poi-card-desc">{pt.description}</p>}

                  <div className="poi-card-meta">
                    <span>{formatCoord(pt.coord, lonFormat)}</span>
                    {pt.elevationM !== null && pt.elevationM !== undefined && (
                      <span>{pt.elevationM.toFixed(1)} m</span>
                    )}
                  </div>

                  <div className="poi-card-actions">
                    <button type="button" className="compact-btn" onClick={() => onFocusPoint(pt)}>
                      FOCUS
                    </button>
                    <button
                      type="button"
                      className="compact-btn"
                      onClick={() => onUseAsWaypointA(pt.coord)}
                    >
                      SET A
                    </button>
                    <button
                      type="button"
                      className="compact-btn"
                      onClick={() => onUseAsWaypointB(pt.coord)}
                    >
                      SET B
                    </button>
                    <button
                      type="button"
                      className="compact-btn"
                      onClick={() => onStartEditPoint(pt)}
                    >
                      EDIT
                    </button>
                    <button
                      type="button"
                      className="compact-btn"
                      onClick={() => onDeletePoint(pt.id)}
                    >
                      DEL
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
