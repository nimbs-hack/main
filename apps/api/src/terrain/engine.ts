import {
  type ComputedRoute,
  type MarsCoord,
  type RoutePlanResponse,
  type RoutePoint,
  type RouteStrategy,
  type SiteDataset,
  type SiteMetadata,
  normalizeLon180,
  surfaceDistanceMeters,
} from "@nimbs/shared";
import { encodeRgbaPng } from "../utils/png";

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
  readonly rows: number;
  readonly cols: number;
  readonly dxM: number;
  readonly dyM: number;
  readonly diagM: number;
  private readonly west: number;
  private readonly south: number;
  private readonly east: number;
  private readonly north: number;
  private readonly totalCells: number;
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

  private runAStar(
    startIdx: number,
    goalIdx: number,
    maxSlopeDeg: number,
    mode: RouteStrategy,
  ): number[] | null {
    const cols = this.cols;
    const rows = this.rows;
    const dxM = this.dxM;
    const dyM = this.dyM;
    const elev = this.elevations;
    const valid = this.validMask;
    const penalty = this.penaltyBuf;

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
    const startR = (startIdx / cols) | 0;
    const startC = startIdx - startR * cols;

    gScore[startIdx] = 0;
    heap.push(startIdx, Math.hypot((startR - goalR) * dyM, (startC - goalC) * dxM));

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

      for (let d = 0; d < 8; d += 1) {
        const dir = DIRS[d];
        if (!dir) continue;
        const nr = r + dir[0];
        const nc = c + dir[1];
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        const v = u + (this.dirOffsets[d] ?? 0);
        if (closed[v] || !valid[v]) continue;

        const dh = Math.abs((elev[v] ?? 0) - elevU);
        if (dh > (maxDh[d] ?? 0)) continue;

        const dist = this.dirDists[d] ?? 0;
        let stepCost = dist;
        if (mode === "gentlest") {
          const slope = Math.atan(dh / Math.max(1e-6, dist)) * radToDeg;
          const ratio = slope / slopeDenom;
          stepCost = dist * (1 + 4.5 * ratio * ratio);
        } else if (mode === "alternate" && penalty[v]) {
          stepCost = dist * 3.5;
        }

        const nextG = uCost + stepCost;
        if (nextG < (gScore[v] ?? Number.POSITIVE_INFINITY)) {
          gScore[v] = nextG;
          parent[v] = u;
          heap.push(v, nextG + Math.hypot((nr - goalR) * dyM, (nc - goalC) * dxM));
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
  ): ComputedRoute {
    const points: RoutePoint[] = [];
    let cumulativeDist = 0;
    let gain = 0;
    let loss = 0;
    let maxSlope = 0;
    let weightedSlopeSum = 0;

    for (let i = 0; i < nodePath.length; i += 1) {
      const idx = nodePath[i];
      if (idx === undefined) continue;
      const r = Math.floor(idx / this.cols);
      const c = idx % this.cols;
      const coord = this.coordForCell(r, c);
      const elev = this.elevations[idx] ?? 0;

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
      }

      points.push({
        lat: Math.round(coord.lat * 1e6) / 1e6,
        lon: Math.round(coord.lon * 1e6) / 1e6,
        elevationM: Math.round(elev * 100) / 100,
        distanceM: Math.round(cumulativeDist * 10) / 10,
        slopeDeg: Math.round(segSlope * 100) / 100,
      });
    }

    return {
      id,
      label,
      strategy,
      totalDistanceM: Math.round(cumulativeDist * 10) / 10,
      elevationGainM: Math.round(gain * 10) / 10,
      elevationLossM: Math.round(loss * 10) / 10,
      maxSlopeDeg: Math.round(maxSlope * 100) / 100,
      meanSlopeDeg:
        cumulativeDist > 0 ? Math.round((weightedSlopeSum / cumulativeDist) * 100) / 100 : 0,
      points,
    };
  }

  private overlapRatio(pathA: number[], pathB: number[]): number {
    const setB = new Set(pathB);
    let shared = 0;
    for (const node of pathA) {
      if (setB.has(node)) shared += 1;
    }
    return shared / Math.max(1, Math.min(pathA.length, pathB.length));
  }

  /** Build candidate routes from waypointA to waypointB constrained by maxSlopeDeg. */
  planRoutes(waypointA: MarsCoord, waypointB: MarsCoord, maxSlopeDeg: number): RoutePlanResponse {
    const clampedSlope = Math.max(0.5, Math.min(89, maxSlopeDeg));
    const passableEdgeRatio = this.computePassableEdgeRatio(clampedSlope);
    const widthKm = Math.round(this.meta.widthMeters / 100) / 10;
    const heightKm = Math.round(this.meta.heightMeters / 100) / 10;

    if (!this.isInsideBounds(waypointA) || !this.isInsideBounds(waypointB)) {
      return {
        status: "out_of_bounds",
        message: `Place both Waypoint A and Waypoint B inside the ${widthKm}x${heightKm} km terrain bounds.`,
        maxSlopeDeg: clampedSlope,
        passableEdgeRatio,
        routes: [],
      };
    }

    const startIdx = this.snapToNode(waypointA);
    const goalIdx = this.snapToNode(waypointB);
    if (startIdx === null || goalIdx === null) {
      return {
        status: "out_of_bounds",
        message: "Waypoints fell on missing elevation pixels.",
        maxSlopeDeg: clampedSlope,
        passableEdgeRatio,
        routes: [],
      };
    }

    const snappedA = {
      ...this.coordForCell(Math.floor(startIdx / this.cols), startIdx % this.cols),
      elevationM: Math.round((this.elevations[startIdx] ?? 0) * 100) / 100,
    };
    const snappedB = {
      ...this.coordForCell(Math.floor(goalIdx / this.cols), goalIdx % this.cols),
      elevationM: Math.round((this.elevations[goalIdx] ?? 0) * 100) / 100,
    };

    const shortestPath = this.runAStar(startIdx, goalIdx, clampedSlope, "shortest");
    if (!shortestPath) {
      const minRequired = this.findMinRequiredSlope(startIdx, goalIdx);
      return {
        status: "unreachable",
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

    const routes: ComputedRoute[] = [
      this.buildRouteSummary("route-shortest", "SHORTEST SAFE", "shortest", shortestPath),
    ];
    const discoveredPaths: number[][] = [shortestPath];

    const gentlestPath = this.runAStar(startIdx, goalIdx, clampedSlope, "gentlest");
    if (gentlestPath && this.overlapRatio(gentlestPath, shortestPath) < 0.9) {
      routes.push(
        this.buildRouteSummary("route-gentlest", "LOWEST SLOPE", "gentlest", gentlestPath),
      );
      discoveredPaths.push(gentlestPath);
    }

    // Penalize cells near existing routes to discover a distinct alternate corridor
    const penaltyMask = this.penaltyBuf;
    penaltyMask.fill(0);
    const penaltyRad = Math.max(2, Math.min(8, Math.round(this.cols / 100)));
    for (const path of discoveredPaths) {
      for (const idx of path) {
        if (idx === startIdx || idx === goalIdx) continue;
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

    const alternatePath = this.runAStar(startIdx, goalIdx, clampedSlope, "alternate");
    if (
      alternatePath &&
      discoveredPaths.every((existing) => this.overlapRatio(alternatePath, existing) < 0.85)
    ) {
      routes.push(
        this.buildRouteSummary("route-alternate", "ALT CORRIDOR", "alternate", alternatePath),
      );
    }

    return {
      status: "ok",
      maxSlopeDeg: clampedSlope,
      passableEdgeRatio,
      snappedA,
      snappedB,
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
}
