import {
  type ComputedRoute,
  DEFAULT_HUMAN_SOIL_SPEED_FACTORS,
  type MarsCoord,
  type RouteBlockedReason,
  type RoutePlanResponse,
  type RoutePoint,
  type RouteStrategy,
  SOIL_SPEED_FACTOR_MAX,
  SOIL_SPEED_FACTOR_MIN,
  SOIL_TYPE_CATALOG,
  type SiteDataset,
  type SiteMetadata,
  type SoilSpeedFactors,
  type SoilTypeId,
  classifyMarsSoilMatrix,
  createEmptySoilBreakdown,
  maxSoilSpeedFactor,
  normalizeLon180,
  resolveSoilSpeedFactors,
  soilCodeToId,
  surfaceDistanceMeters,
} from "@nimbs/shared";
import { encodeRgbaPng } from "../utils/png";
import { celsiusToKelvin, kelvinToCelsius } from "../weather/generator";

export interface TerrainWeatherFilter {
  lmstHour: number;
  lmstLabel?: string;
  minAirTempC: number;
  minPressurePa: number;
  thermalWeight?: number;
  cellTempK: Float32Array;
  cellPressurePa: Float32Array;
}

interface ResolvedWeatherContext {
  minAirTempK: number;
  minPressurePa: number;
  thermalWeight: number;
  cellTempK: Float32Array;
  cellPressurePa: Float32Array;
  maxTempK: number;
  maxPressurePa: number;
  tempSpanK: number;
  pressureSpanPa: number;
  pressCautionSpanPa: number;
  checkTemp: boolean;
  checkPressure: boolean;
}

const DIRS: ReadonlyArray<readonly [dr: number, dc: number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

/**
 * Gain applied to the soft thermal risk for the "weather-safe" strategy.
 * Unlike the hard minPressurePa/minAirTempC filters, this term trades extra
 * traverse distance for thermal margin: it is deliberately large enough to
 * outweigh a longer detour around a cold, low-pressure ridge when
 * thermalWeight is near 1, yet stays mild (and does not force a detour) at the
 * low thermalWeight values used for hard-filter-only planning.
 */
const WEATHER_SAFE_THERMAL_GAIN = 80;

class MinHeap {
  private nodes: number[] = [];
  private scores: number[] = [];
  poppedNode = -1;
  poppedScore = 0;

  get size(): number {
    return this.nodes.length;
  }

  clear(): void {
    this.nodes.length = 0;
    this.scores.length = 0;
  }

  push(node: number, score: number): void {
    const idx = this.nodes.length;
    this.nodes.push(node);
    this.scores.push(score);
    this.bubbleUp(idx);
  }

  popInto(): boolean {
    const node = this.nodes[0];
    const score = this.scores[0];
    const lastNode = this.nodes.pop();
    const lastScore = this.scores.pop();
    if (
      node === undefined ||
      score === undefined ||
      lastNode === undefined ||
      lastScore === undefined
    ) {
      return false;
    }
    this.poppedNode = node;
    this.poppedScore = score;
    if (this.nodes.length > 0) {
      this.nodes[0] = lastNode;
      this.scores[0] = lastScore;
      this.sinkDown(0);
    }
    return true;
  }

  private bubbleUp(idx: number): void {
    let i = idx;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if ((this.scores[parent] ?? 0) <= (this.scores[i] ?? 0)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  private sinkDown(idx: number): void {
    let i = idx;
    const len = this.nodes.length;
    while (true) {
      const left = 2 * i + 1;
      const right = left + 1;
      let smallest = i;
      if (left < len && (this.scores[left] ?? 0) < (this.scores[smallest] ?? 0)) {
        smallest = left;
      }
      if (right < len && (this.scores[right] ?? 0) < (this.scores[smallest] ?? 0)) {
        smallest = right;
      }
      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
  }

  private swap(a: number, b: number): void {
    const tmpN = this.nodes[a];
    const tmpS = this.scores[a];
    const nb = this.nodes[b];
    const sb = this.scores[b];
    if (tmpN === undefined || tmpS === undefined || nb === undefined || sb === undefined) return;
    this.nodes[a] = nb;
    this.scores[a] = sb;
    this.nodes[b] = tmpN;
    this.scores[b] = tmpS;
  }
}

/**
 * In-memory weighted graph built over a local Martian DEM grid.
 * Each cell is a vertex with 8-connected neighbor edges weighted by Mars surface distance and slope.
 */
export class TerrainGraph {
  readonly meta: SiteMetadata;
  readonly elevations: Float32Array;
  readonly soilMatrix: Uint8Array;
  readonly rows: number;
  readonly cols: number;
  readonly dxM: number;
  readonly dyM: number;
  readonly diagM: number;
  private readonly west: number;
  private readonly south: number;
  private readonly east: number;
  private readonly north: number;
  readonly totalCells: number;
  private readonly validMask: Uint8Array;
  private readonly localMaxSlope: Float32Array;
  private readonly dirOffsets: Int32Array;
  private readonly dirDists: Float64Array;
  private readonly heap = new MinHeap();
  private readonly gScoreBuf: Float64Array;
  private readonly parentBuf: Int32Array;
  private readonly closedBuf: Uint8Array;
  private readonly penaltyBuf: Uint8Array;
  private readonly bestSlopeBuf: Float32Array;

  constructor(dataset: SiteDataset) {
    this.meta = dataset.meta;
    this.rows = dataset.meta.rows;
    this.cols = dataset.meta.cols;
    this.totalCells = this.rows * this.cols;
    this.elevations = Float32Array.from(dataset.elevationsM);

    const [west, south, east, north] = dataset.meta.bbox;
    this.west = west;
    this.south = south;
    this.east = east;
    this.north = north;

    const midLat = (north + south) / 2;
    const midLon = (west + east) / 2;
    this.dyM =
      surfaceDistanceMeters({ lat: north, lon: midLon }, { lat: south, lon: midLon }) /
      Math.max(1, this.rows - 1);
    this.dxM =
      surfaceDistanceMeters({ lat: midLat, lon: west }, { lat: midLat, lon: east }) /
      Math.max(1, this.cols - 1);
    this.diagM = Math.hypot(this.dyM, this.dxM);

    this.dirOffsets = Int32Array.from(DIRS.map(([dr, dc]) => dr * this.cols + dc));
    this.dirDists = Float64Array.from(
      DIRS.map(([dr, dc]) => Math.hypot(dr * this.dyM, dc * this.dxM)),
    );

    this.validMask = new Uint8Array(this.totalCells);
    const minValid = this.meta.nodataValue + 10;
    for (let i = 0; i < this.totalCells; i += 1) {
      const val = this.elevations[i];
      if (val !== undefined && Number.isFinite(val) && val > minValid) {
        this.validMask[i] = 1;
      }
    }

    this.localMaxSlope = new Float32Array(this.totalCells);
    this.precomputeLocalMaxSlopes();

    if (dataset.soilTypes && dataset.soilTypes.length === this.totalCells) {
      const matrix = new Uint8Array(this.totalCells);
      for (let i = 0; i < this.totalCells; i += 1) {
        const raw = dataset.soilTypes[i] ?? 0;
        matrix[i] = raw >= 0 && raw <= 3 ? raw : 1;
      }
      this.soilMatrix = matrix;
    } else {
      this.soilMatrix = classifyMarsSoilMatrix({
        elevationsM: this.elevations,
        rows: this.rows,
        cols: this.cols,
        dxM: this.dxM,
        dyM: this.dyM,
        nodataValue: this.meta.nodataValue,
      });
    }

    this.gScoreBuf = new Float64Array(this.totalCells);
    this.parentBuf = new Int32Array(this.totalCells);
    this.closedBuf = new Uint8Array(this.totalCells);
    this.penaltyBuf = new Uint8Array(this.totalCells);
    this.bestSlopeBuf = new Float32Array(this.totalCells);
  }

  private precomputeLocalMaxSlopes(): void {
    const radToDeg = 180 / Math.PI;
    for (let r = 0; r < this.rows; r += 1) {
      for (let c = 0; c < this.cols; c += 1) {
        const u = r * this.cols + c;
        if (!this.validMask[u]) continue;
        const elevU = this.elevations[u] ?? 0;
        let maxS = 0;
        for (let d = 0; d < DIRS.length; d += 1) {
          const dir = DIRS[d];
          if (!dir) continue;
          const nr = r + dir[0];
          const nc = c + dir[1];
          if (nr < 0 || nr >= this.rows || nc < 0 || nc >= this.cols) continue;
          const v = u + (this.dirOffsets[d] ?? 0);
          if (!this.validMask[v]) continue;
          const dist = Math.max(1e-6, this.dirDists[d] ?? 1);
          const dh = Math.abs((this.elevations[v] ?? 0) - elevU);
          const slope = Math.atan(dh / dist) * radToDeg;
          if (slope > maxS) maxS = slope;
        }
        this.localMaxSlope[u] = maxS;
      }
    }
  }

  getValidMask(): Uint8Array {
    return this.validMask;
  }

  isCellValid(idx: number): boolean {
    return this.validMask[idx] === 1;
  }

  /** Classified Martian substrate type at nearest valid cell, or null outside bounds. */
  soilAt(coord: MarsCoord): SoilTypeId | null {
    const pos = this.coordToFractionalGrid(coord);
    if (!pos) return null;
    const nr = Math.round(pos.r);
    const nc = Math.round(pos.c);
    const ni = nr * this.cols + nc;
    if (!this.isValidCell(ni)) return null;
    return soilCodeToId(this.soilMatrix[ni] ?? 0);
  }

  private edgeSoilSpeedFactor(u: number, v: number, soilFactors: SoilSpeedFactors): number {
    const fU = soilFactors[soilCodeToId(this.soilMatrix[u] ?? 0)];
    const fV = soilFactors[soilCodeToId(this.soilMatrix[v] ?? 0)];
    const avg = (fU + fV) * 0.5;
    return Math.max(SOIL_SPEED_FACTOR_MIN, Math.min(SOIL_SPEED_FACTOR_MAX, avg));
  }

  private isValidCell(idx: number): boolean {
    return this.validMask[idx] === 1;
  }

  isInsideBounds(coord: MarsCoord): boolean {
    const lon = normalizeLon180(coord.lon);
    return (
      coord.lat >= this.south && coord.lat <= this.north && lon >= this.west && lon <= this.east
    );
  }

  coordForCell(row: number, col: number): MarsCoord {
    const latFrac = row / Math.max(1, this.rows - 1);
    const lonFrac = col / Math.max(1, this.cols - 1);
    return {
      lat: this.north - latFrac * (this.north - this.south),
      lon: normalizeLon180(this.west + lonFrac * (this.east - this.west)),
    };
  }

  private coordToFractionalGrid(coord: MarsCoord): { r: number; c: number } | null {
    if (!this.isInsideBounds(coord)) return null;
    const lon = normalizeLon180(coord.lon);
    const r =
      ((this.north - coord.lat) / Math.max(1e-9, this.north - this.south)) * (this.rows - 1);
    const c = ((lon - this.west) / Math.max(1e-9, this.east - this.west)) * (this.cols - 1);
    return {
      r: Math.max(0, Math.min(this.rows - 1, r)),
      c: Math.max(0, Math.min(this.cols - 1, c)),
    };
  }

  /** Bilinearly interpolated elevation in meters relative to Mars areoid, or null outside bounds. */
  elevationAt(coord: MarsCoord): number | null {
    const pos = this.coordToFractionalGrid(coord);
    if (!pos) return null;

    const r0 = Math.floor(pos.r);
    const c0 = Math.floor(pos.c);
    const r1 = Math.min(this.rows - 1, r0 + 1);
    const c1 = Math.min(this.cols - 1, c0 + 1);
    const fr = pos.r - r0;
    const fc = pos.c - c0;

    const i00 = r0 * this.cols + c0;
    const i01 = r0 * this.cols + c1;
    const i10 = r1 * this.cols + c0;
    const i11 = r1 * this.cols + c1;

    if (
      !this.isValidCell(i00) ||
      !this.isValidCell(i01) ||
      !this.isValidCell(i10) ||
      !this.isValidCell(i11)
    ) {
      const nr = Math.round(pos.r);
      const nc = Math.round(pos.c);
      const ni = nr * this.cols + nc;
      return this.isValidCell(ni) ? (this.elevations[ni] ?? null) : null;
    }

    const v0 = (this.elevations[i00] ?? 0) * (1 - fc) + (this.elevations[i01] ?? 0) * fc;
    const v1 = (this.elevations[i10] ?? 0) * (1 - fc) + (this.elevations[i11] ?? 0) * fc;
    return Math.round((v0 * (1 - fr) + v1 * fr) * 100) / 100;
  }

  private snapToNode(coord: MarsCoord): number | null {
    const pos = this.coordToFractionalGrid(coord);
    if (!pos) return null;
    const r = Math.round(pos.r);
    const c = Math.round(pos.c);
    const idx = r * this.cols + c;
    if (this.isValidCell(idx)) return idx;

    // Fallback search in small radius if exact pixel is nodata
    for (let rad = 1; rad <= 5; rad += 1) {
      for (let dr = -rad; dr <= rad; dr += 1) {
        for (let dc = -rad; dc <= rad; dc += 1) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr >= 0 && nr < this.rows && nc >= 0 && nc < this.cols) {
            const ni = nr * this.cols + nc;
            if (this.isValidCell(ni)) return ni;
          }
        }
      }
    }
    return null;
  }

  private stepDist(dr: number, dc: number): number {
    return Math.hypot(dr * this.dyM, dc * this.dxM);
  }

  private edgeSlopeDeg(idxA: number, idxB: number, distM: number): number {
    const dh = Math.abs((this.elevations[idxB] ?? 0) - (this.elevations[idxA] ?? 0));
    return (Math.atan(dh / Math.max(1e-6, distM)) * 180) / Math.PI;
  }

  /** Fraction of valid graph edges passable under maxSlopeDeg. */
  computePassableEdgeRatio(maxSlopeDeg: number): number {
    const tanMax = Math.tan((maxSlopeDeg * Math.PI) / 180);
    const maxDhX = this.dxM * tanMax + 1e-9;
    const maxDhY = this.dyM * tanMax + 1e-9;
    const maxDhD = this.diagM * tanMax + 1e-9;
    const rows = this.rows;
    const cols = this.cols;
    const elev = this.elevations;
    const valid = this.validMask;

    let total = 0;
    let passable = 0;
    for (let r = 0; r < rows; r += 1) {
      const rowBase = r * cols;
      const hasDown = r + 1 < rows;
      for (let c = 0; c < cols; c += 1) {
        const u = rowBase + c;
        if (!valid[u]) continue;
        const elevU = elev[u] ?? 0;

        if (c + 1 < cols) {
          const right = u + 1;
          if (valid[right]) {
            total += 1;
            if (Math.abs((elev[right] ?? 0) - elevU) <= maxDhX) passable += 1;
          }
        }
        if (hasDown) {
          const down = u + cols;
          if (valid[down]) {
            total += 1;
            if (Math.abs((elev[down] ?? 0) - elevU) <= maxDhY) passable += 1;
          }
          if (c + 1 < cols) {
            const downRight = down + 1;
            if (valid[downRight]) {
              total += 1;
              if (Math.abs((elev[downRight] ?? 0) - elevU) <= maxDhD) passable += 1;
            }
          }
          if (c > 0) {
            const downLeft = down - 1;
            if (valid[downLeft]) {
              total += 1;
              if (Math.abs((elev[downLeft] ?? 0) - elevU) <= maxDhD) passable += 1;
            }
          }
        }
      }
    }
    return total > 0 ? Math.round((passable / total) * 1000) / 1000 : 0;
  }

  private buildWeatherContext(weatherFilter: TerrainWeatherFilter): ResolvedWeatherContext {
    const { cellTempK, cellPressurePa } = weatherFilter;
    if (cellTempK.length !== this.totalCells || cellPressurePa.length !== this.totalCells) {
      throw new Error(
        `Weather field dimensions mismatch: expected ${this.totalCells} cells, got temp=${cellTempK.length}, pressure=${cellPressurePa.length}`,
      );
    }

    const minAirTempK = celsiusToKelvin(weatherFilter.minAirTempC);
    const minPressurePa = weatherFilter.minPressurePa;
    const thermalWeight = Math.max(0, Math.min(1, weatherFilter.thermalWeight ?? 0));

    let maxTempK = minAirTempK;
    let maxPressurePa = minPressurePa;
    for (let i = 0; i < this.totalCells; i += 1) {
      if (!this.validMask[i]) continue;
      const t = cellTempK[i] ?? Number.NEGATIVE_INFINITY;
      const p = cellPressurePa[i] ?? Number.NEGATIVE_INFINITY;
      if (t > maxTempK) maxTempK = t;
      if (p > maxPressurePa) maxPressurePa = p;
    }

    return {
      minAirTempK,
      minPressurePa,
      thermalWeight,
      cellTempK,
      cellPressurePa,
      maxTempK,
      maxPressurePa,
      tempSpanK: Math.max(5, maxTempK - minAirTempK),
      pressureSpanPa: Math.max(10, maxPressurePa - minPressurePa),
      pressCautionSpanPa: Math.max(10, minPressurePa * 0.04),
      checkTemp: true,
      checkPressure: true,
    };
  }

  private isCellWeatherPassable(idx: number, ctx: ResolvedWeatherContext): boolean {
    if (ctx.checkTemp && (ctx.cellTempK[idx] ?? Number.NEGATIVE_INFINITY) < ctx.minAirTempK) {
      return false;
    }
    if (
      ctx.checkPressure &&
      (ctx.cellPressurePa[idx] ?? Number.NEGATIVE_INFINITY) < ctx.minPressurePa
    ) {
      return false;
    }
    return true;
  }

  private computeThermalRisk(idx: number, ctx: ResolvedWeatherContext): number {
    const tK = ctx.cellTempK[idx] ?? ctx.minAirTempK;
    const pPa = ctx.cellPressurePa[idx] ?? ctx.minPressurePa;
    const tempDeficit = Math.max(0, Math.min(1, (ctx.maxTempK - tK) / ctx.tempSpanK));
    const pressDeficit = Math.max(0, Math.min(1, (ctx.maxPressurePa - pPa) / ctx.pressureSpanPa));
    const tempMargin = Math.max(0, tK - ctx.minAirTempK);
    const nearTemp = tempMargin < 5 ? 1 - tempMargin / 5 : 0;
    const pressMargin = Math.max(0, pPa - ctx.minPressurePa);
    const nearPress =
      pressMargin < ctx.pressCautionSpanPa ? 1 - pressMargin / ctx.pressCautionSpanPa : 0;
    return 0.55 * tempDeficit + 0.45 * pressDeficit + 0.6 * Math.max(nearTemp, nearPress);
  }

  private runAStar(
    startIdx: number,
    goalIdx: number,
    maxSlopeDeg: number,
    mode: RouteStrategy,
    weatherCtx?: ResolvedWeatherContext,
    soilFactors: SoilSpeedFactors = DEFAULT_HUMAN_SOIL_SPEED_FACTORS,
  ): number[] | null {
    if (
      weatherCtx &&
      (!this.isCellWeatherPassable(startIdx, weatherCtx) ||
        !this.isCellWeatherPassable(goalIdx, weatherCtx))
    ) {
      return null;
    }

    const cols = this.cols;
    const rows = this.rows;
    const dxM = this.dxM;
    const dyM = this.dyM;
    const diagM = this.diagM;
    const elev = this.elevations;
    const valid = this.validMask;
    const penalty = this.penaltyBuf;
    const soil = this.soilMatrix;
    const soilLut = new Float64Array([
      Math.max(SOIL_SPEED_FACTOR_MIN, Math.min(SOIL_SPEED_FACTOR_MAX, soilFactors.bedrock)),
      Math.max(
        SOIL_SPEED_FACTOR_MIN,
        Math.min(SOIL_SPEED_FACTOR_MAX, soilFactors["coarse-regolith"]),
      ),
      Math.max(
        SOIL_SPEED_FACTOR_MIN,
        Math.min(SOIL_SPEED_FACTOR_MAX, soilFactors["fine-regolith"]),
      ),
      Math.max(SOIL_SPEED_FACTOR_MIN, Math.min(SOIL_SPEED_FACTOR_MAX, soilFactors["loose-sand"])),
    ]);

    const gScore = this.gScoreBuf;
    const parent = this.parentBuf;
    const closed = this.closedBuf;
    const heap = this.heap;

    gScore.fill(Number.POSITIVE_INFINITY);
    parent.fill(-1);
    closed.fill(0);
    heap.clear();

    const goalR = (goalIdx / cols) | 0;
    const goalC = goalIdx - goalR * cols;
    const tanMax = Math.tan((maxSlopeDeg * Math.PI) / 180);
    const maxDh = new Float64Array(8);
    for (let d = 0; d < 8; d += 1) {
      maxDh[d] = (this.dirDists[d] ?? 0) * tanMax + 1e-9;
    }

    const slopeDenom = Math.max(1, maxSlopeDeg);
    const radToDeg = 180 / Math.PI;
    const invMaxSoilFactor = 1 / maxSoilSpeedFactor(soilFactors);
    // Keep shortest mode strictly admissible; allow a bounded heuristic factor on secondary
    // multi-objective modes so 1001x1001 grids do not flood the whole map when edge weights > 1.
    const heuristicWeight = mode === "shortest" ? 1 : 1.35;
    const heuristicScale = invMaxSoilFactor * heuristicWeight;
    const octile = (rr: number, cc: number): number => {
      const dr = rr > goalR ? rr - goalR : goalR - rr;
      const dc = cc > goalC ? cc - goalC : goalC - cc;
      const dMin = dr < dc ? dr : dc;
      const base = dMin * diagM + (dr > dc ? (dr - dc) * dyM : (dc - dr) * dxM);
      return base * heuristicScale;
    };
    const startR = (startIdx / cols) | 0;
    const startC = startIdx - startR * cols;

    gScore[startIdx] = 0;
    heap.push(startIdx, octile(startR, startC));

    while (heap.popInto()) {
      const u = heap.poppedNode;
      if (u === goalIdx) {
        const path: number[] = [];
        let cur = goalIdx;
        while (cur !== -1) {
          path.push(cur);
          cur = parent[cur] ?? -1;
        }
        path.reverse();
        return path;
      }
      if (closed[u]) continue;
      closed[u] = 1;

      const r = (u / cols) | 0;
      const c = u - r * cols;
      const uCost = gScore[u] ?? Number.POSITIVE_INFINITY;
      const elevU = elev[u] ?? 0;
      const soilFactorU = soilLut[soil[u] ?? 0] ?? 1;

      for (let d = 0; d < 8; d += 1) {
        const dir = DIRS[d];
        if (!dir) continue;
        const nr = r + dir[0];
        const nc = c + dir[1];
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        const v = u + (this.dirOffsets[d] ?? 0);
        if (closed[v] || !valid[v]) continue;
        if (weatherCtx && !this.isCellWeatherPassable(v, weatherCtx)) continue;

        const dh = Math.abs((elev[v] ?? 0) - elevU);
        if (dh > (maxDh[d] ?? 0)) continue;

        const dist = this.dirDists[d] ?? 0;
        const soilTimeScale = 2 / (soilFactorU + (soilLut[soil[v] ?? 0] ?? 1));
        let stepCost = dist * soilTimeScale;
        if (mode === "gentlest") {
          const slope = Math.atan(dh / Math.max(1e-6, dist)) * radToDeg;
          const ratio = slope / slopeDenom;
          const thermalTerm =
            weatherCtx && weatherCtx.thermalWeight > 0
              ? weatherCtx.thermalWeight * 1.0 * this.computeThermalRisk(v, weatherCtx)
              : 0;
          stepCost = dist * soilTimeScale * (1 + 4.5 * ratio * ratio + thermalTerm);
        } else if (mode === "weather-safe") {
          const slope = Math.atan(dh / Math.max(1e-6, dist)) * radToDeg;
          const ratio = slope / slopeDenom;
          const thermalTerm =
            weatherCtx && weatherCtx.thermalWeight > 0
              ? weatherCtx.thermalWeight *
                WEATHER_SAFE_THERMAL_GAIN *
                this.computeThermalRisk(v, weatherCtx)
              : 0;
          stepCost = dist * soilTimeScale * (1 + thermalTerm + 0.5 * ratio * ratio);
        } else if (mode === "alternate" && penalty[v]) {
          stepCost = dist * soilTimeScale * 3.5;
        }

        const nextG = uCost + stepCost;
        if (nextG < (gScore[v] ?? Number.POSITIVE_INFINITY)) {
          gScore[v] = nextG;
          parent[v] = u;
          heap.push(v, nextG + octile(nr, nc));
        }
      }
    }
    return null;
  }

  /** Maximin Dijkstra over slope-passable edges to find the highest bottleneck cell value along any route. */
  private findMaxFeasibleNodeValue(
    startIdx: number,
    goalIdx: number,
    maxSlopeDeg: number,
    values: Float32Array,
  ): number | null {
    const rows = this.rows;
    const cols = this.cols;
    const elev = this.elevations;
    const valid = this.validMask;
    const bestMin = this.bestSlopeBuf;
    const visited = this.closedBuf;
    const heap = this.heap;

    const tanMax = Math.tan((maxSlopeDeg * Math.PI) / 180);
    const maxDh = new Float64Array(8);
    for (let d = 0; d < 8; d += 1) {
      maxDh[d] = (this.dirDists[d] ?? 0) * tanMax + 1e-9;
    }

    bestMin.fill(Number.NEGATIVE_INFINITY);
    visited.fill(0);
    heap.clear();

    const startVal = values[startIdx];
    if (
      startVal === undefined ||
      !Number.isFinite(startVal) ||
      !valid[startIdx] ||
      !valid[goalIdx]
    ) {
      return null;
    }
    bestMin[startIdx] = startVal;
    heap.push(startIdx, -startVal);

    while (heap.popInto()) {
      const u = heap.poppedNode;
      if (u === goalIdx) {
        const val = bestMin[goalIdx];
        return val !== undefined && Number.isFinite(val) ? val : null;
      }
      if (visited[u]) continue;
      visited[u] = 1;

      const r = (u / cols) | 0;
      const c = u - r * cols;
      const uMin = bestMin[u] ?? Number.NEGATIVE_INFINITY;
      const elevU = elev[u] ?? 0;

      for (let d = 0; d < 8; d += 1) {
        const dir = DIRS[d];
        if (!dir) continue;
        const nr = r + dir[0];
        const nc = c + dir[1];
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        const v = u + (this.dirOffsets[d] ?? 0);
        if (visited[v] || !valid[v]) continue;

        const dh = Math.abs((elev[v] ?? 0) - elevU);
        if (dh > (maxDh[d] ?? 0)) continue;

        const vVal = values[v];
        if (vVal === undefined || !Number.isFinite(vVal)) continue;
        const cand = uMin < vVal ? uMin : vVal;
        if (cand > (bestMin[v] ?? Number.NEGATIVE_INFINITY)) {
          bestMin[v] = cand;
          heap.push(v, -cand);
        }
      }
    }
    return null;
  }

  /** Minimax Dijkstra to find the minimum maxSlopeDeg threshold connecting start and goal. */
  private findMinRequiredSlope(startIdx: number, goalIdx: number): number | null {
    const rows = this.rows;
    const cols = this.cols;
    const elev = this.elevations;
    const valid = this.validMask;
    const bestMaxSlope = this.bestSlopeBuf;
    const visited = this.closedBuf;
    const heap = this.heap;
    const radToDeg = 180 / Math.PI;

    bestMaxSlope.fill(Number.POSITIVE_INFINITY);
    visited.fill(0);
    heap.clear();

    bestMaxSlope[startIdx] = 0;
    heap.push(startIdx, 0);

    while (heap.popInto()) {
      const u = heap.poppedNode;
      if (u === goalIdx) {
        return Math.ceil(heap.poppedScore * 10) / 10;
      }
      if (visited[u]) continue;
      visited[u] = 1;

      const r = (u / cols) | 0;
      const c = u - r * cols;
      const uSlope = bestMaxSlope[u] ?? Number.POSITIVE_INFINITY;
      const elevU = elev[u] ?? 0;

      for (let d = 0; d < 8; d += 1) {
        const dir = DIRS[d];
        if (!dir) continue;
        const nr = r + dir[0];
        const nc = c + dir[1];
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        const v = u + (this.dirOffsets[d] ?? 0);
        if (visited[v] || !valid[v]) continue;

        const dist = Math.max(1e-6, this.dirDists[d] ?? 1);
        const dh = Math.abs((elev[v] ?? 0) - elevU);
        const edgeSlope = Math.atan(dh / dist) * radToDeg;
        const candSlope = uSlope > edgeSlope ? uSlope : edgeSlope;
        if (candSlope < (bestMaxSlope[v] ?? Number.POSITIVE_INFINITY)) {
          bestMaxSlope[v] = candSlope;
          heap.push(v, candSlope);
        }
      }
    }
    return null;
  }

  private buildRouteSummary(
    id: string,
    label: string,
    strategy: RouteStrategy,
    nodePath: number[],
    weatherCtx?: ResolvedWeatherContext,
    soilFactors: SoilSpeedFactors = DEFAULT_HUMAN_SOIL_SPEED_FACTORS,
  ): ComputedRoute {
    const points: RoutePoint[] = [];
    const soilBreakdown = createEmptySoilBreakdown();
    let cumulativeDist = 0;
    let gain = 0;
    let loss = 0;
    let maxSlope = 0;
    let weightedSlopeSum = 0;
    let minTempC = Number.POSITIVE_INFINITY;
    let maxTempC = Number.NEGATIVE_INFINITY;
    let minPressurePa = Number.POSITIVE_INFINITY;
    let maxPressurePa = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < nodePath.length; i += 1) {
      const idx = nodePath[i];
      if (idx === undefined) continue;
      const r = Math.floor(idx / this.cols);
      const c = idx % this.cols;
      const coord = this.coordForCell(r, c);
      const elev = this.elevations[idx] ?? 0;
      const nodeSoil = soilCodeToId(this.soilMatrix[idx] ?? 0);
      let segSoilFactor = soilFactors[nodeSoil];

      let segSlope = 0;
      const prevIdx = i > 0 ? nodePath[i - 1] : undefined;
      if (prevIdx !== undefined) {
        const pr = Math.floor(prevIdx / this.cols);
        const pc = prevIdx % this.cols;
        const segDist = this.stepDist(r - pr, c - pc);
        const prevElev = this.elevations[prevIdx] ?? elev;
        const dh = elev - prevElev;
        if (dh > 0) gain += dh;
        else loss += -dh;

        segSlope = this.edgeSlopeDeg(prevIdx, idx, segDist);
        if (segSlope > maxSlope) maxSlope = segSlope;
        weightedSlopeSum += segSlope * segDist;
        cumulativeDist += segDist;
        segSoilFactor = this.edgeSoilSpeedFactor(prevIdx, idx, soilFactors);
        soilBreakdown[nodeSoil] += segDist;
      }

      const point: RoutePoint = {
        lat: Math.round(coord.lat * 1e6) / 1e6,
        lon: Math.round(coord.lon * 1e6) / 1e6,
        elevationM: Math.round(elev * 100) / 100,
        distanceM: Math.round(cumulativeDist * 10) / 10,
        slopeDeg: Math.round(segSlope * 100) / 100,
        soilType: nodeSoil,
        soilSpeedFactor: Math.round(segSoilFactor * 1000) / 1000,
      };

      if (weatherCtx) {
        const tC = kelvinToCelsius(weatherCtx.cellTempK[idx] ?? 0);
        const pPa = weatherCtx.cellPressurePa[idx] ?? 0;
        const roundedT = Math.round(tC * 100) / 100;
        const roundedP = Math.round(pPa * 100) / 100;
        point.tempC = roundedT;
        point.pressurePa = roundedP;
        if (roundedT < minTempC) minTempC = roundedT;
        if (roundedT > maxTempC) maxTempC = roundedT;
        if (roundedP < minPressurePa) minPressurePa = roundedP;
        if (roundedP > maxPressurePa) maxPressurePa = roundedP;
      }

      points.push(point);
    }

    const summary: ComputedRoute = {
      id,
      label,
      strategy,
      totalDistanceM: Math.round(cumulativeDist * 10) / 10,
      elevationGainM: Math.round(gain * 10) / 10,
      elevationLossM: Math.round(loss * 10) / 10,
      maxSlopeDeg: Math.round(maxSlope * 100) / 100,
      meanSlopeDeg:
        cumulativeDist > 0 ? Math.round((weightedSlopeSum / cumulativeDist) * 100) / 100 : 0,
      soilBreakdown: {
        bedrock: Math.round(soilBreakdown.bedrock * 10) / 10,
        "coarse-regolith": Math.round(soilBreakdown["coarse-regolith"] * 10) / 10,
        "fine-regolith": Math.round(soilBreakdown["fine-regolith"] * 10) / 10,
        "loose-sand": Math.round(soilBreakdown["loose-sand"] * 10) / 10,
      },
      points,
    };

    if (weatherCtx && points.length > 0) {
      summary.minTempC = minTempC;
      summary.maxTempC = maxTempC;
      summary.minPressurePa = minPressurePa;
      summary.maxPressurePa = maxPressurePa;
    }

    return summary;
  }

  private overlapRatio(pathA: number[], pathB: number[]): number {
    const setB = new Set(pathB);
    let shared = 0;
    for (const node of pathA) {
      if (setB.has(node)) shared += 1;
    }
    return shared / Math.max(1, Math.min(pathA.length, pathB.length));
  }

  private formatLmstClock(lmstHour: number): string {
    const wrapped = ((lmstHour % 24) + 24) % 24;
    const totalMinutes = Math.round(wrapped * 60);
    const hh = Math.floor(totalMinutes / 60) % 24;
    const mm = totalMinutes % 60;
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }

  private diagnoseUnreachable(
    startIdx: number,
    goalIdx: number,
    clampedSlope: number,
    passableEdgeRatio: number,
    snappedA: MarsCoord & { elevationM: number },
    snappedB: MarsCoord & { elevationM: number },
    weatherFilter?: TerrainWeatherFilter,
    weatherCtx?: ResolvedWeatherContext,
  ): RoutePlanResponse {
    const weatherMeta = weatherFilter
      ? {
          weatherApplied: true,
          appliedLmstHour: Math.round(weatherFilter.lmstHour * 100) / 100,
          minTempFilterC: Math.round(weatherFilter.minAirTempC * 100) / 100,
          minPressureFilterPa: Math.round(weatherFilter.minPressurePa * 100) / 100,
        }
      : {};

    if (!weatherFilter || !weatherCtx) {
      const minRequired = this.findMinRequiredSlope(startIdx, goalIdx);
      const blockedReason: RouteBlockedReason = minRequired !== null ? "slope" : "nodata";
      return {
        status: "unreachable",
        blockedReason,
        message:
          minRequired !== null
            ? `No graph route under ${clampedSlope.toFixed(1)} deg. Minimum required slope: ${minRequired.toFixed(1)} deg.`
            : "No connected graph path between Waypoint A and Waypoint B.",
        maxSlopeDeg: clampedSlope,
        minRequiredSlopeDeg: minRequired ?? undefined,
        passableEdgeRatio,
        snappedA,
        snappedB,
        routes: [],
      };
    }

    const slopeOnlyPath = this.runAStar(startIdx, goalIdx, clampedSlope, "shortest");
    if (!slopeOnlyPath) {
      const minRequired = this.findMinRequiredSlope(startIdx, goalIdx);
      const blockedReason: RouteBlockedReason = minRequired !== null ? "slope" : "nodata";
      return {
        status: "unreachable",
        blockedReason,
        message:
          minRequired !== null
            ? `No graph route under ${clampedSlope.toFixed(1)} deg. Minimum required slope: ${minRequired.toFixed(1)} deg.`
            : "No connected graph path between Waypoint A and Waypoint B.",
        maxSlopeDeg: clampedSlope,
        minRequiredSlopeDeg: minRequired ?? undefined,
        ...weatherMeta,
        passableEdgeRatio,
        snappedA,
        snappedB,
        routes: [],
      };
    }

    const tempOnlyPath = this.runAStar(startIdx, goalIdx, clampedSlope, "shortest", {
      ...weatherCtx,
      checkTemp: true,
      checkPressure: false,
    });
    const pressureOnlyPath = this.runAStar(startIdx, goalIdx, clampedSlope, "shortest", {
      ...weatherCtx,
      checkTemp: false,
      checkPressure: true,
    });

    let blockedReason: RouteBlockedReason = "combined";
    if (!tempOnlyPath && pressureOnlyPath) {
      blockedReason = "temperature";
    } else if (tempOnlyPath && !pressureOnlyPath) {
      blockedReason = "pressure";
    }

    const rawMaxTempK = this.findMaxFeasibleNodeValue(
      startIdx,
      goalIdx,
      clampedSlope,
      weatherCtx.cellTempK,
    );
    const rawMaxPressPa = this.findMaxFeasibleNodeValue(
      startIdx,
      goalIdx,
      clampedSlope,
      weatherCtx.cellPressurePa,
    );

    const maxFeasibleMinTempC =
      rawMaxTempK !== null ? Math.floor(kelvinToCelsius(rawMaxTempK) * 100) / 100 : undefined;
    const maxFeasibleMinPressurePa =
      rawMaxPressPa !== null ? Math.floor(rawMaxPressPa * 100) / 100 : undefined;

    const lmstLabel = weatherFilter.lmstLabel ?? this.formatLmstClock(weatherFilter.lmstHour);
    let message = `No route passes weather constraints at ${lmstLabel}.`;
    if (blockedReason === "temperature" && maxFeasibleMinTempC !== undefined) {
      message = `No route stays above ${weatherFilter.minAirTempC.toFixed(1)} C at ${lmstLabel}. Warmest corridor drops to ${maxFeasibleMinTempC.toFixed(1)} C.`;
    } else if (blockedReason === "pressure" && maxFeasibleMinPressurePa !== undefined) {
      message = `No route stays above ${weatherFilter.minPressurePa.toFixed(0)} Pa at ${lmstLabel}. Highest-pressure corridor drops to ${maxFeasibleMinPressurePa.toFixed(1)} Pa.`;
    } else if (maxFeasibleMinTempC !== undefined && maxFeasibleMinPressurePa !== undefined) {
      message = `No route meets ${weatherFilter.minAirTempC.toFixed(1)} C and ${weatherFilter.minPressurePa.toFixed(0)} Pa at ${lmstLabel}. Corridor limits: ${maxFeasibleMinTempC.toFixed(1)} C, ${maxFeasibleMinPressurePa.toFixed(1)} Pa.`;
    }

    return {
      status: "unreachable",
      blockedReason,
      message,
      maxSlopeDeg: clampedSlope,
      maxFeasibleMinTempC,
      maxFeasibleMinPressurePa,
      ...weatherMeta,
      passableEdgeRatio,
      snappedA,
      snappedB,
      routes: [],
    };
  }

  /** Build candidate routes from waypointA to waypointB constrained by maxSlopeDeg, soil factors, and optional weather. */
  planRoutes(
    waypointA: MarsCoord,
    waypointB: MarsCoord,
    maxSlopeDeg: number,
    weatherFilter?: TerrainWeatherFilter,
    soilSpeedFactors?: Partial<SoilSpeedFactors>,
  ): RoutePlanResponse {
    return this.planWaypointsRoutes(
      [waypointA, waypointB],
      maxSlopeDeg,
      weatherFilter,
      soilSpeedFactors,
    );
  }

  /** Stitch A* legs across sequential waypoints [1, 2, ..., N] for one strategy. */
  private solveMultiLegPath(
    waypointIndices: number[],
    maxSlopeDeg: number,
    mode: RouteStrategy,
    weatherCtx?: ResolvedWeatherContext,
    soilFactors: SoilSpeedFactors = DEFAULT_HUMAN_SOIL_SPEED_FACTORS,
  ): { path: number[] | null; failedLegIndex: number } {
    const combined: number[] = [];
    for (let leg = 0; leg < waypointIndices.length - 1; leg += 1) {
      const startIdx = waypointIndices[leg];
      const goalIdx = waypointIndices[leg + 1];
      if (startIdx === undefined || goalIdx === undefined) {
        return { path: null, failedLegIndex: leg };
      }
      const legPath = this.runAStar(startIdx, goalIdx, maxSlopeDeg, mode, weatherCtx, soilFactors);
      if (!legPath) {
        return { path: null, failedLegIndex: leg };
      }
      if (leg === 0) {
        combined.push(...legPath);
      } else {
        for (let i = 1; i < legPath.length; i += 1) {
          const node = legPath[i];
          if (node !== undefined) combined.push(node);
        }
      }
    }
    return { path: combined, failedLegIndex: -1 };
  }

  /** Build candidate routes sequentially through ordered waypoints `[1, 2, ..., N]`. */
  planWaypointsRoutes(
    waypoints: MarsCoord[],
    maxSlopeDeg: number,
    weatherFilter?: TerrainWeatherFilter,
    soilSpeedFactors?: Partial<SoilSpeedFactors>,
  ): RoutePlanResponse {
    const soilFactors = resolveSoilSpeedFactors(soilSpeedFactors);
    const clampedSlope = Math.max(0.5, Math.min(89, maxSlopeDeg));
    const passableEdgeRatio = this.computePassableEdgeRatio(clampedSlope);
    const widthKm = Math.round(this.meta.widthMeters / 100) / 10;
    const heightKm = Math.round(this.meta.heightMeters / 100) / 10;
    const weatherMeta = weatherFilter
      ? {
          weatherApplied: true,
          appliedLmstHour: Math.round(weatherFilter.lmstHour * 100) / 100,
          minTempFilterC: Math.round(weatherFilter.minAirTempC * 100) / 100,
          minPressureFilterPa: Math.round(weatherFilter.minPressurePa * 100) / 100,
        }
      : {};

    if (waypoints.length < 2) {
      return {
        status: "out_of_bounds",
        message: "Place at least two waypoints inside terrain bounds.",
        maxSlopeDeg: clampedSlope,
        ...weatherMeta,
        passableEdgeRatio,
        routes: [],
      };
    }

    for (let i = 0; i < waypoints.length; i += 1) {
      const wp = waypoints[i];
      if (!wp || !this.isInsideBounds(wp)) {
        return {
          status: "out_of_bounds",
          message: `Place Waypoint ${i + 1} inside the ${widthKm}x${heightKm} km terrain bounds.`,
          maxSlopeDeg: clampedSlope,
          ...weatherMeta,
          passableEdgeRatio,
          routes: [],
        };
      }
    }

    const waypointIndices: number[] = [];
    const snappedWaypoints: Array<MarsCoord & { elevationM: number }> = [];
    for (const wp of waypoints) {
      const idx = this.snapToNode(wp);
      if (idx === null) {
        return {
          status: "out_of_bounds",
          message: "Waypoints fell on missing elevation pixels.",
          maxSlopeDeg: clampedSlope,
          ...weatherMeta,
          passableEdgeRatio,
          routes: [],
        };
      }
      waypointIndices.push(idx);
      snappedWaypoints.push({
        ...this.coordForCell(Math.floor(idx / this.cols), idx % this.cols),
        elevationM: Math.round((this.elevations[idx] ?? 0) * 100) / 100,
      });
    }

    const snappedA = snappedWaypoints[0];
    const snappedB = snappedWaypoints[snappedWaypoints.length - 1];
    const weatherCtx = weatherFilter ? this.buildWeatherContext(weatherFilter) : undefined;

    const shortestRes = this.solveMultiLegPath(
      waypointIndices,
      clampedSlope,
      "shortest",
      weatherCtx,
      soilFactors,
    );
    if (!shortestRes.path) {
      const failIdx = Math.max(0, Math.min(waypointIndices.length - 2, shortestRes.failedLegIndex));
      const failStart = waypointIndices[failIdx] ?? 0;
      const failGoal = waypointIndices[failIdx + 1] ?? 0;
      const diag = this.diagnoseUnreachable(
        failStart,
        failGoal,
        clampedSlope,
        passableEdgeRatio,
        snappedWaypoints[failIdx] ?? { lat: 0, lon: 0, elevationM: 0 },
        snappedWaypoints[failIdx + 1] ?? { lat: 0, lon: 0, elevationM: 0 },
        weatherFilter,
        weatherCtx,
      );
      return {
        ...diag,
        blockedLegIndex: failIdx,
        snappedA,
        snappedB,
        snappedWaypoints,
      };
    }

    const shortestPath = shortestRes.path;
    const routes: ComputedRoute[] = [
      this.buildRouteSummary(
        "route-shortest",
        "SHORTEST SAFE",
        "shortest",
        shortestPath,
        weatherCtx,
        soilFactors,
      ),
    ];
    const discoveredPaths: number[][] = [shortestPath];

    const appendCandidateIfDistinct = (
      id: string,
      label: string,
      strategy: RouteStrategy,
      maxOverlap: number,
    ) => {
      const solved = this.solveMultiLegPath(
        waypointIndices,
        clampedSlope,
        strategy,
        weatherCtx,
        soilFactors,
      );
      if (solved.path) {
        const candidatePath = solved.path;
        if (
          discoveredPaths.every(
            (existing) => this.overlapRatio(candidatePath, existing) < maxOverlap,
          )
        ) {
          routes.push(
            this.buildRouteSummary(id, label, strategy, candidatePath, weatherCtx, soilFactors),
          );
          discoveredPaths.push(candidatePath);
        }
      }
    };

    appendCandidateIfDistinct("route-gentlest", "LOWEST SLOPE", "gentlest", 0.9);

    if (weatherCtx && weatherCtx.thermalWeight > 0) {
      appendCandidateIfDistinct("route-weather-safe", "THERMAL SAFE", "weather-safe", 0.88);
    }

    // Penalize cells near existing routes while preserving all intermediate waypoints
    const penaltyMask = this.penaltyBuf;
    penaltyMask.fill(0);
    const waypointNodeSet = new Set(waypointIndices);
    const penaltyRad = Math.max(2, Math.min(8, Math.round(this.cols / 100)));
    for (const path of discoveredPaths) {
      for (const idx of path) {
        if (waypointNodeSet.has(idx)) continue;
        const pr = Math.floor(idx / this.cols);
        const pc = idx % this.cols;
        for (let dr = -penaltyRad; dr <= penaltyRad; dr += 1) {
          const nr = pr + dr;
          if (nr < 0 || nr >= this.rows) continue;
          const rowBase = nr * this.cols;
          for (let dc = -penaltyRad; dc <= penaltyRad; dc += 1) {
            const nc = pc + dc;
            if (nc >= 0 && nc < this.cols) {
              penaltyMask[rowBase + nc] = 1;
            }
          }
        }
      }
    }

    appendCandidateIfDistinct("route-alternate", "ALT CORRIDOR", "alternate", 0.85);

    return {
      status: "ok",
      maxSlopeDeg: clampedSlope,
      ...weatherMeta,
      passableEdgeRatio,
      snappedA,
      snappedB,
      snappedWaypoints,
      routes,
    };
  }

  /** Render an RGBA PNG mask highlighting steep impassable terrain for the given maxSlopeDeg. */
  renderSlopeMaskPng(maxSlopeDeg: number): Uint8Array {
    const rgba = new Uint8Array(this.totalCells * 4);
    const cautionThresh = maxSlopeDeg * 0.75;

    for (let u = 0; u < this.totalCells; u += 1) {
      if (!this.validMask[u]) continue;
      const maxS = this.localMaxSlope[u] ?? 0;
      const p = u * 4;
      if (maxS > maxSlopeDeg) {
        // Impassable hazard (amber-orange, distinct from Mars red accent)
        rgba[p] = 245;
        rgba[p + 1] = 158;
        rgba[p + 2] = 11;
        rgba[p + 3] = 175;
      } else if (maxS > cautionThresh) {
        rgba[p] = 234;
        rgba[p + 1] = 179;
        rgba[p + 2] = 8;
        rgba[p + 3] = 55;
      }
    }

    return encodeRgbaPng(this.cols, this.rows, rgba, 1);
  }

  /** Render an RGBA PNG map coloring the 4 Martian substrate / soil classes across the site. */
  renderSoilMaskPng(): Uint8Array {
    const rgba = new Uint8Array(this.totalCells * 4);
    for (let u = 0; u < this.totalCells; u += 1) {
      if (!this.validMask[u]) continue;
      const spec = SOIL_TYPE_CATALOG[soilCodeToId(this.soilMatrix[u] ?? 0)];
      const p = u * 4;
      rgba[p] = spec.rgba[0];
      rgba[p + 1] = spec.rgba[1];
      rgba[p + 2] = spec.rgba[2];
      rgba[p + 3] = spec.rgba[3];
    }
    return encodeRgbaPng(this.cols, this.rows, rgba, 1);
  }
}
