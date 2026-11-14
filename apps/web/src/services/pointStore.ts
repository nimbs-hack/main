import type { MarsCoord } from "@nimbs/shared";
import { FGDC_SYMBOL_BY_ID } from "../assets/fgdcSymbols";

export type CorePointIconKey =
  | "science"
  | "sample"
  | "habitat"
  | "supply"
  | "hazard"
  | "beacon"
  | "marker";

export type PointIconKey = CorePointIconKey | `fgdc-${string}`;

const CORE_ICON_SET = new Set<string>([
  "science",
  "sample",
  "habitat",
  "supply",
  "hazard",
  "beacon",
  "marker",
]);

export function isValidPointIconKey(value: string): value is PointIconKey {
  return CORE_ICON_SET.has(value) || Boolean(FGDC_SYMBOL_BY_ID[value]);
}

export interface MapPointClass {
  id: string;
  name: string;
  shortCode: string;
  color: string;
  icon: PointIconKey;
  builtIn?: boolean;
}

export interface MapPoint {
  id: string;
  name: string;
  classId: string;
  icon?: PointIconKey;
  description: string;
  coord: MarsCoord;
  elevationM?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface PersistedPointState {
  classes: MapPointClass[];
  points: MapPoint[];
  hiddenClassIds: string[];
}

export const POINT_CLASS_SWATCHES: readonly string[] = [
  "#38bdf8",
  "#3fb68b",
  "#eab308",
  "#a855f7",
  "#f59e0b",
  "#60a5fa",
  "#94a3b8",
];

export const DEFAULT_POINT_CLASSES: readonly MapPointClass[] = [
  {
    id: "science",
    name: "Science Target",
    shortCode: "SCI",
    color: "#38bdf8",
    icon: "science",
    builtIn: true,
  },
  {
    id: "sample",
    name: "Sample Cache",
    shortCode: "SMP",
    color: "#a855f7",
    icon: "sample",
    builtIn: true,
  },
  {
    id: "habitat",
    name: "Habitat / Base",
    shortCode: "HAB",
    color: "#3fb68b",
    icon: "habitat",
    builtIn: true,
  },
  {
    id: "supply",
    name: "Depot / Power",
    shortCode: "PWR",
    color: "#eab308",
    icon: "supply",
    builtIn: true,
  },
  {
    id: "hazard",
    name: "Terrain Hazard",
    shortCode: "HZD",
    color: "#f59e0b",
    icon: "hazard",
    builtIn: true,
  },
];

const STORAGE_KEY = "nimbs.mars-map-points.v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function defaultState(): PersistedPointState {
  return {
    classes: DEFAULT_POINT_CLASSES.map((c) => ({ ...c })),
    points: [],
    hiddenClassIds: [],
  };
}

/** Safely parse stored classes, points, and hidden class ids. */
export function parsePointState(raw: string | null): PersistedPointState {
  if (!raw) return defaultState();

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return defaultState();

    const parsedClasses: MapPointClass[] = [];
    const seenIds = new Set<string>();

    // Always keep built-in classes present first
    for (const base of DEFAULT_POINT_CLASSES) {
      parsedClasses.push({ ...base });
      seenIds.add(base.id);
    }

    if (Array.isArray(parsed.classes)) {
      for (const item of parsed.classes) {
        if (!isRecord(item)) continue;
        const id = typeof item.id === "string" ? item.id.trim() : "";
        const name = typeof item.name === "string" ? item.name.trim() : "";
        if (!id || !name || seenIds.has(id)) continue;

        const shortCode =
          typeof item.shortCode === "string" && item.shortCode.trim().length > 0
            ? item.shortCode.trim().toUpperCase().slice(0, 3)
            : name.toUpperCase().slice(0, 3);
        const color =
          typeof item.color === "string" && item.color.startsWith("#") ? item.color : "#38bdf8";
        const icon: PointIconKey =
          typeof item.icon === "string" && isValidPointIconKey(item.icon) ? item.icon : "marker";

        parsedClasses.push({
          id,
          name,
          shortCode,
          color,
          icon,
          builtIn: false,
        });
        seenIds.add(id);
      }
    }

    const fallbackClassId = parsedClasses[0]?.id ?? "science";
    const parsedPoints: MapPoint[] = [];
    if (Array.isArray(parsed.points)) {
      for (const item of parsed.points) {
        if (!isRecord(item) || !isRecord(item.coord)) continue;
        const id = typeof item.id === "string" ? item.id.trim() : "";
        const name = typeof item.name === "string" ? item.name.trim() : "";
        const lat = item.coord.lat;
        const lon = item.coord.lon;
        if (!id || !name || typeof lat !== "number" || typeof lon !== "number") continue;

        const classId =
          typeof item.classId === "string" && seenIds.has(item.classId)
            ? item.classId
            : fallbackClassId;
        const pointIcon =
          typeof item.icon === "string" && isValidPointIconKey(item.icon) ? item.icon : undefined;
        const description = typeof item.description === "string" ? item.description : "";
        const elevationM = typeof item.elevationM === "number" ? item.elevationM : null;
        const now = new Date().toISOString();

        parsedPoints.push({
          id,
          name,
          classId,
          ...(pointIcon ? { icon: pointIcon } : {}),
          description,
          coord: { lat, lon },
          elevationM,
          createdAt: typeof item.createdAt === "string" ? item.createdAt : now,
          updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : now,
        });
      }
    }

    const hiddenClassIds: string[] = [];
    if (Array.isArray(parsed.hiddenClassIds)) {
      for (const id of parsed.hiddenClassIds) {
        if (typeof id === "string" && seenIds.has(id) && !hiddenClassIds.includes(id)) {
          hiddenClassIds.push(id);
        }
      }
    }

    return {
      classes: parsedClasses,
      points: parsedPoints,
      hiddenClassIds,
    };
  } catch {
    return defaultState();
  }
}

export function loadPointState(): PersistedPointState {
  if (typeof window === "undefined" || !window.localStorage) {
    return defaultState();
  }
  return parsePointState(window.localStorage.getItem(STORAGE_KEY));
}

export function savePointState(state: PersistedPointState): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage quota or private mode errors
  }
}

export function toggleClassVisibility(
  hiddenClassIds: readonly string[],
  classId: string,
): string[] {
  return hiddenClassIds.includes(classId)
    ? hiddenClassIds.filter((id) => id !== classId)
    : [...hiddenClassIds, classId];
}

export function setAllClassesVisible(
  classes: readonly MapPointClass[],
  visible: boolean,
): string[] {
  return visible ? [] : classes.map((c) => c.id);
}

export function filterVisiblePoints(
  points: readonly MapPoint[],
  hiddenClassIds: readonly string[],
  searchQuery = "",
): MapPoint[] {
  const hiddenSet = new Set(hiddenClassIds);
  const query = searchQuery.trim().toLowerCase();

  return points.filter((point) => {
    if (hiddenSet.has(point.classId)) return false;
    if (!query) return true;
    return (
      point.name.toLowerCase().includes(query) || point.description.toLowerCase().includes(query)
    );
  });
}

export function createMapPoint(
  input: {
    name: string;
    classId: string;
    icon?: PointIconKey;
    description: string;
    coord: MarsCoord;
    elevationM?: number | null;
  },
  existing: readonly MapPoint[],
): MapPoint {
  const trimmedName = input.name.trim();
  if (!trimmedName) {
    throw new Error("Point name cannot be empty.");
  }
  const now = new Date().toISOString();
  const baseSlug = trimmedName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 20);
  let suffix = 1;
  let id = `pt-${baseSlug || "site"}-${Date.now().toString(36)}`;
  const ids = new Set(existing.map((p) => p.id));
  while (ids.has(id)) {
    suffix += 1;
    id = `pt-${baseSlug || "site"}-${suffix}`;
  }

  return {
    id,
    name: trimmedName,
    classId: input.classId,
    ...(input.icon ? { icon: input.icon } : {}),
    description: input.description.trim(),
    coord: { ...input.coord },
    elevationM: input.elevationM ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

export function createCustomPointClass(
  input: {
    name: string;
    shortCode?: string;
    color: string;
    icon: PointIconKey;
  },
  existing: readonly MapPointClass[],
): MapPointClass {
  const trimmedName = input.name.trim();
  if (!trimmedName) {
    throw new Error("Class name cannot be empty.");
  }

  const baseId = trimmedName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
  const existingIds = new Set(existing.map((c) => c.id));
  let id = baseId || "custom";
  let n = 2;
  while (existingIds.has(id)) {
    id = `${baseId || "custom"}-${n}`;
    n += 1;
  }

  const rawCode = (input.shortCode ?? "").trim().replace(/[^a-zA-Z0-9]/g, "");
  const fallbackCode = trimmedName.replace(/[^a-zA-Z0-9]/g, "");
  const shortCode = (rawCode || fallbackCode || "POI").toUpperCase().slice(0, 3);

  return {
    id,
    name: trimmedName,
    shortCode,
    color: input.color,
    icon: input.icon,
    builtIn: false,
  };
}
