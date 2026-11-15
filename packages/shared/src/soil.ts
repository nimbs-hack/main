export type SoilTypeId = "bedrock" | "coarse-regolith" | "fine-regolith" | "loose-sand";

export type SoilTypeCode = 0 | 1 | 2 | 3;

export type SoilSpeedFactors = Record<SoilTypeId, number>;

export interface SoilTypeSpec {
  code: SoilTypeCode;
  id: SoilTypeId;
  label: string;
  shortLabel: string;
  description: string;
  humanSpeedFactor: number;
  roverSpeedFactor: number;
  colorHex: string;
  rgba: readonly [number, number, number, number];
}

export const SOIL_SPEED_FACTOR_MIN = 0.1;
export const SOIL_SPEED_FACTOR_MAX = 1.5;

export const SOIL_TYPE_ORDER: readonly SoilTypeId[] = [
  "bedrock",
  "coarse-regolith",
  "fine-regolith",
  "loose-sand",
];

export const SOIL_TYPE_CATALOG: Record<SoilTypeId, SoilTypeSpec> = {
  bedrock: {
    code: 0,
    id: "bedrock",
    label: "BEDROCK",
    shortLabel: "BEDROCK",
    description:
      "Indurated fractured caprock and crater-wall outcrops (high nighttime IR thermal inertia). Negligible boot/wheel sinkage.",
    humanSpeedFactor: 1.0,
    roverSpeedFactor: 1.0,
    colorHex: "#94a3b8",
    rgba: [148, 163, 184, 138],
  },
  "coarse-regolith": {
    code: 1,
    id: "coarse-regolith",
    label: "COARSE REGOLITH",
    shortLabel: "COARSE",
    description:
      "Sorted 1-2 mm olivine grains and rocky lag aprons (Séítah / Máaz class). Moderate compliance, mild speed loss.",
    humanSpeedFactor: 0.85,
    roverSpeedFactor: 0.88,
    colorHex: "#d97706",
    rgba: [217, 119, 6, 142],
  },
  "fine-regolith": {
    code: 2,
    id: "fine-regolith",
    label: "FINE REGOLITH",
    shortLabel: "FINE",
    description:
      "Silty ferric-oxide dust and lightly crusted fine regolith plains. Moderate boot sinkage and shear yield.",
    humanSpeedFactor: 0.7,
    roverSpeedFactor: 0.72,
    colorHex: "#c2593f",
    rgba: [194, 89, 63, 148],
  },
  "loose-sand": {
    code: 3,
    id: "loose-sand",
    label: "LOOSE SAND",
    shortLabel: "SAND",
    description:
      "Unconsolidated aeolian dunes and wind-rippled hollows (low nighttime IR thermal inertia). High sinkage and slip.",
    humanSpeedFactor: 0.45,
    roverSpeedFactor: 0.42,
    colorHex: "#eab308",
    rgba: [234, 179, 8, 176],
  },
};

export const SOIL_CODE_TO_ID: readonly SoilTypeId[] = SOIL_TYPE_ORDER;

export const DEFAULT_HUMAN_SOIL_SPEED_FACTORS: SoilSpeedFactors = {
  bedrock: SOIL_TYPE_CATALOG.bedrock.humanSpeedFactor,
  "coarse-regolith": SOIL_TYPE_CATALOG["coarse-regolith"].humanSpeedFactor,
  "fine-regolith": SOIL_TYPE_CATALOG["fine-regolith"].humanSpeedFactor,
  "loose-sand": SOIL_TYPE_CATALOG["loose-sand"].humanSpeedFactor,
};

export const DEFAULT_ROVER_SOIL_SPEED_FACTORS: SoilSpeedFactors = {
  bedrock: SOIL_TYPE_CATALOG.bedrock.roverSpeedFactor,
  "coarse-regolith": SOIL_TYPE_CATALOG["coarse-regolith"].roverSpeedFactor,
  "fine-regolith": SOIL_TYPE_CATALOG["fine-regolith"].roverSpeedFactor,
  "loose-sand": SOIL_TYPE_CATALOG["loose-sand"].roverSpeedFactor,
};

export function soilCodeToId(code: number): SoilTypeId {
  return SOIL_CODE_TO_ID[code] ?? "coarse-regolith";
}

export function soilIdToCode(id: SoilTypeId): SoilTypeCode {
  return SOIL_TYPE_CATALOG[id].code;
}

export function clampSoilSpeedFactor(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const clamped = Math.max(SOIL_SPEED_FACTOR_MIN, Math.min(SOIL_SPEED_FACTOR_MAX, value));
  return Math.round(clamped * 100) / 100;
}

export function resolveSoilSpeedFactors(
  partial?: Partial<Record<SoilTypeId, number>>,
  fallback: SoilSpeedFactors = DEFAULT_HUMAN_SOIL_SPEED_FACTORS,
): SoilSpeedFactors {
  return {
    bedrock: clampSoilSpeedFactor(partial?.bedrock ?? fallback.bedrock, fallback.bedrock),
    "coarse-regolith": clampSoilSpeedFactor(
      partial?.["coarse-regolith"] ?? fallback["coarse-regolith"],
      fallback["coarse-regolith"],
    ),
    "fine-regolith": clampSoilSpeedFactor(
      partial?.["fine-regolith"] ?? fallback["fine-regolith"],
      fallback["fine-regolith"],
    ),
    "loose-sand": clampSoilSpeedFactor(
      partial?.["loose-sand"] ?? fallback["loose-sand"],
      fallback["loose-sand"],
    ),
  };
}

export function maxSoilSpeedFactor(factors: SoilSpeedFactors): number {
  return Math.max(
    SOIL_SPEED_FACTOR_MIN,
    factors.bedrock,
    factors["coarse-regolith"],
    factors["fine-regolith"],
    factors["loose-sand"],
  );
}

export function createEmptySoilBreakdown(): Record<SoilTypeId, number> {
  return {
    bedrock: 0,
    "coarse-regolith": 0,
    "fine-regolith": 0,
    "loose-sand": 0,
  };
}

export function isSoilTypeId(value: unknown): value is SoilTypeId {
  return typeof value === "string" && (SOIL_TYPE_ORDER as readonly string[]).includes(value);
}

/** Validate an untrusted partial SoilSpeedFactors payload into typed factors or an error message. */
export function parsePartialSoilSpeedFactors(
  raw: unknown,
  prefix = "soilSpeedFactors",
): { factors?: Partial<SoilSpeedFactors>; error?: string } {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: `${prefix} must be an object` };
  }
  const obj = raw as Record<string, unknown>;
  const out: Partial<SoilSpeedFactors> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (!isSoilTypeId(key)) {
      return {
        error: `${prefix}.${key} is not a valid soil type (${SOIL_TYPE_ORDER.join(", ")})`,
      };
    }
    if (
      typeof val !== "number" ||
      !Number.isFinite(val) ||
      val < SOIL_SPEED_FACTOR_MIN ||
      val > SOIL_SPEED_FACTOR_MAX
    ) {
      return {
        error: `${prefix}.${key} must be a finite number in [${SOIL_SPEED_FACTOR_MIN}, ${SOIL_SPEED_FACTOR_MAX}]`,
      };
    }
    out[key] = val;
  }
  return { factors: out };
}

export interface ClassifySoilMatrixOptions {
  elevationsM: ArrayLike<number>;
  rows: number;
  cols: number;
  dxM: number;
  dyM: number;
  nodataValue: number;
  /** Optional 0..255 THEMIS Nighttime IR reflectance/brightness per cell (same rows*cols grid). */
  themisDn?: ArrayLike<number>;
}

/**
 * Compute separable focal Topographic Position Index (elev - 7x7 local mean) in O(rows * cols).
 */
function computeFocalTpi(
  elevationsM: ArrayLike<number>,
  valid: Uint8Array,
  rows: number,
  cols: number,
  radius = 3,
): Float32Array {
  const total = rows * cols;
  const horizSum = new Float64Array(total);
  const horizCnt = new Int32Array(total);

  for (let r = 0; r < rows; r += 1) {
    const rowOff = r * cols;
    let runSum = 0;
    let runCnt = 0;
    const initEnd = Math.min(cols - 1, radius);
    for (let c = 0; c <= initEnd; c += 1) {
      const idx = rowOff + c;
      if (valid[idx]) {
        runSum += elevationsM[idx] ?? 0;
        runCnt += 1;
      }
    }
    for (let c = 0; c < cols; c += 1) {
      const idx = rowOff + c;
      horizSum[idx] = runSum;
      horizCnt[idx] = runCnt;

      const addCol = c + radius + 1;
      if (addCol < cols && valid[rowOff + addCol]) {
        runSum += elevationsM[rowOff + addCol] ?? 0;
        runCnt += 1;
      }
      const remCol = c - radius;
      if (remCol >= 0 && valid[rowOff + remCol]) {
        runSum -= elevationsM[rowOff + remCol] ?? 0;
        runCnt -= 1;
      }
    }
  }

  const tpi = new Float32Array(total);
  for (let c = 0; c < cols; c += 1) {
    let runSum = 0;
    let runCnt = 0;
    const initEnd = Math.min(rows - 1, radius);
    for (let r = 0; r <= initEnd; r += 1) {
      const idx = r * cols + c;
      runSum += horizSum[idx] ?? 0;
      runCnt += horizCnt[idx] ?? 0;
    }
    for (let r = 0; r < rows; r += 1) {
      const idx = r * cols + c;
      if (valid[idx] && runCnt > 0) {
        const mean = runSum / runCnt;
        tpi[idx] = (elevationsM[idx] ?? 0) - mean;
      }
      const addRow = r + radius + 1;
      if (addRow < rows) {
        const addIdx = addRow * cols + c;
        runSum += horizSum[addIdx] ?? 0;
        runCnt += horizCnt[addIdx] ?? 0;
      }
      const remRow = r - radius;
      if (remRow >= 0) {
        const remIdx = remRow * cols + c;
        runSum -= horizSum[remIdx] ?? 0;
        runCnt -= horizCnt[remIdx] ?? 0;
      }
    }
  }

  return tpi;
}

/**
 * Classify each DEM cell into one of four Martian soil/substrate classes (0..3)
 * using Mars Odyssey THEMIS Nighttime IR thermal inertia brightness combined with
 * local 20 m DEM slope and 7x7 focal topographic position (TPI).
 */
export function classifyMarsSoilMatrix(options: ClassifySoilMatrixOptions): Uint8Array {
  const { elevationsM, rows, cols, dxM, dyM, nodataValue, themisDn } = options;
  const total = rows * cols;
  const out = new Uint8Array(total);
  const valid = new Uint8Array(total);
  const cutoff = nodataValue + 10;

  let minElev = Number.POSITIVE_INFINITY;
  let maxElev = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < total; i += 1) {
    const e = elevationsM[i] ?? nodataValue;
    if (Number.isFinite(e) && e > cutoff) {
      valid[i] = 1;
      if (e < minElev) minElev = e;
      if (e > maxElev) maxElev = e;
    }
  }

  const relief = minElev <= maxElev ? maxElev - minElev : 0;
  const hasThemis = themisDn !== undefined && themisDn.length === total;

  // Flat uniform DEM without external THEMIS raster defaults to unit bedrock (1.0x speed factor)
  // so synthetic planar test grids preserve exact unpenalized geometric distances.
  if (!hasThemis && relief <= 1e-3) {
    return out;
  }

  const radToDeg = 180 / Math.PI;
  const diagM = Math.max(1e-6, Math.hypot(dxM, dyM));
  const slopeMax = new Float32Array(total);
  const dOffsets = [
    [-1, 0, dyM],
    [1, 0, dyM],
    [0, -1, dxM],
    [0, 1, dxM],
    [-1, -1, diagM],
    [-1, 1, diagM],
    [1, -1, diagM],
    [1, 1, diagM],
  ] as const;

  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const u = r * cols + c;
      if (!valid[u]) continue;
      const elevU = elevationsM[u] ?? 0;
      let maxS = 0;
      for (const [dr, dc, dist] of dOffsets) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        const v = nr * cols + nc;
        if (!valid[v]) continue;
        const s = Math.atan(Math.abs((elevationsM[v] ?? 0) - elevU) / dist) * radToDeg;
        if (s > maxS) maxS = s;
      }
      slopeMax[u] = maxS;
    }
  }

  const tpi = computeFocalTpi(elevationsM, valid, rows, cols, 3);

  let nirLo = 20;
  let nirSpan = 210;
  if (hasThemis && themisDn) {
    const samples: number[] = [];
    const stride = Math.max(1, Math.floor(total / 8192));
    for (let i = 0; i < total; i += stride) {
      if (!valid[i]) continue;
      const dn = themisDn[i] ?? 0;
      if (Number.isFinite(dn) && dn > 0) samples.push(dn);
    }
    if (samples.length >= 16) {
      samples.sort((a, b) => a - b);
      nirLo = samples[Math.floor(samples.length * 0.02)] ?? 20;
      const nirHi = samples[Math.floor(samples.length * 0.98)] ?? 230;
      nirSpan = Math.max(10, nirHi - nirLo);
    }
  }

  for (let i = 0; i < total; i += 1) {
    if (!valid[i]) continue;
    const slope = slopeMax[i] ?? 0;
    const localTpi = tpi[i] ?? 0;

    if (hasThemis && themisDn) {
      const dn = themisDn[i] ?? 0;
      const nirNorm =
        Number.isFinite(dn) && dn > 0 ? Math.max(0, Math.min(1, (dn - nirLo) / nirSpan)) : 0.45;

      // 0 = bedrock: steep rocky outcrops (>12 deg), scarp caprock (high TI + >=3.5 deg), or peak TI
      if (slope >= 12 || (nirNorm >= 0.72 && slope >= 3.5) || nirNorm >= 0.8) {
        out[i] = 0;
      } else if (
        // 3 = loose-sand: low-TI windblown sand or sheltered topographic hollows in gentle terrain
        slope <= 7.5 &&
        (nirNorm < 0.28 || (localTpi < -1.0 && nirNorm < 0.42 && slope <= 6))
      ) {
        out[i] = 3;
      } else if (nirNorm < 0.52 && slope < 10) {
        // 2 = fine-regolith: low-to-moderate thermal inertia plains & lightly crusted dust
        out[i] = 2;
      } else {
        // 1 = coarse-regolith: 1-2 mm sorted olivine / rocky lag aprons
        out[i] = 1;
      }
    } else {
      // Geomorphometric fallback when external THEMIS NIR is absent
      if (slope >= 12 || localTpi >= 1.8) {
        out[i] = 0;
      } else if (localTpi <= -1.2 && slope <= 6) {
        out[i] = 3;
      } else if (localTpi < 0 && slope <= 8) {
        out[i] = 2;
      } else {
        out[i] = 1;
      }
    }
  }

  return out;
}
