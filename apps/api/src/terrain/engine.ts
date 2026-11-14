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

  get size(): number {
    return this.nodes.length;
  }

  push(node: number, score: number): void {
    const idx = this.nodes.length;
    this.nodes.push(node);
    this.scores.push(score);
    this.bubbleUp(idx);
  }

  pop(): { node: number; score: number } | undefined {
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
      return undefined;
    }
    if (this.nodes.length > 0) {
      this.nodes[0] = lastNode;
      this.scores[0] = lastScore;
      this.sinkDown(0);
    }
    return { node, score };
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
  private readonly west: number;
  private readonly south: number;
  private readonly east: number;
  private readonly north: number;

  constructor(dataset: SiteDataset) {
    this.meta = dataset.meta;
    this.rows = dataset.meta.rows;
    this.cols = dataset.meta.cols;
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
  }

  private isValidCell(idx: number): boolean {
    const val = this.elevations[idx];
    return val !== undefined && Number.isFinite(val) && val > this.meta.nodataValue + 10;
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
    let total = 0;
    let passable = 0;
    for (let r = 0; r < this.rows; r += 1) {
      for (let c = 0; c < this.cols; c += 1) {
        const u = r * this.cols + c;
        if (!this.isValidCell(u)) continue;
        // Check forward neighbors (right, down, down-right, down-left) once per undirected edge
        const forward: ReadonlyArray<readonly [number, number]> = [
          [0, 1],
          [1, 0],
          [1, 1],
          [1, -1],
        ];
        for (const [dr, dc] of forward) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nr >= this.rows || nc < 0 || nc >= this.cols) continue;
          const v = nr * this.cols + nc;
          if (!this.isValidCell(v)) continue;
          total += 1;
          if (this.edgeSlopeDeg(u, v, this.stepDist(dr, dc)) <= maxSlopeDeg) {
            passable += 1;
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
    weightFn: (stepDistM: number, slopeDeg: number, toNode: number) => number,
  ): number[] | null {
    const total = this.rows * this.cols;
    const gScore = new Float64Array(total).fill(Number.POSITIVE_INFINITY);
    const parent = new Int32Array(total).fill(-1);
    const closed = new Uint8Array(total);

    const goalR = Math.floor(goalIdx / this.cols);
    const goalC = goalIdx % this.cols;

    const heuristic = (idx: number): number => {
      const r = Math.floor(idx / this.cols);
      const c = idx % this.cols;
      return Math.hypot((r - goalR) * this.dyM, (c - goalC) * this.dxM);
    };

    const heap = new MinHeap();
    gScore[startIdx] = 0;
    heap.push(startIdx, heuristic(startIdx));

    while (heap.size > 0) {
      const top = heap.pop();
      if (!top) break;
      const u = top.node;
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

      const r = Math.floor(u / this.cols);
      const c = u % this.cols;
      const uCost = gScore[u] ?? Number.POSITIVE_INFINITY;

      for (const [dr, dc] of DIRS) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= this.rows || nc < 0 || nc >= this.cols) continue;
        const v = nr * this.cols + nc;
        if (closed[v] || !this.isValidCell(v)) continue;

        const dist = this.stepDist(dr, dc);
        const slope = this.edgeSlopeDeg(u, v, dist);
        if (slope > maxSlopeDeg) continue;

        const nextG = uCost + weightFn(dist, slope, v);
        if (nextG < (gScore[v] ?? Number.POSITIVE_INFINITY)) {
          gScore[v] = nextG;
          parent[v] = u;
          heap.push(v, nextG + heuristic(v));
        }
      }
    }
    return null;
  }

  /** Minimax Dijkstra to find the minimum maxSlopeDeg threshold connecting start and goal. */
  private findMinRequiredSlope(startIdx: number, goalIdx: number): number | null {
    const total = this.rows * this.cols;
    const bestMaxSlope = new Float32Array(total).fill(Number.POSITIVE_INFINITY);
    const visited = new Uint8Array(total);
    const heap = new MinHeap();

    bestMaxSlope[startIdx] = 0;
    heap.push(startIdx, 0);

    while (heap.size > 0) {
      const top = heap.pop();
      if (!top) break;
      const u = top.node;
      if (u === goalIdx) {
        return Math.ceil(top.score * 10) / 10;
      }
      if (visited[u]) continue;
      visited[u] = 1;

      const r = Math.floor(u / this.cols);
      const c = u % this.cols;
      const uSlope = bestMaxSlope[u] ?? Number.POSITIVE_INFINITY;

      for (const [dr, dc] of DIRS) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= this.rows || nc < 0 || nc >= this.cols) continue;
        const v = nr * this.cols + nc;
        if (visited[v] || !this.isValidCell(v)) continue;

        const dist = this.stepDist(dr, dc);
        const edgeSlope = this.edgeSlopeDeg(u, v, dist);
        const candSlope = Math.max(uSlope, edgeSlope);
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

    if (!this.isInsideBounds(waypointA) || !this.isInsideBounds(waypointB)) {
      return {
        status: "out_of_bounds",
        message: "Place both Waypoint A and Waypoint B inside the 3x3 km terrain bounds.",
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

    const shortestPath = this.runAStar(startIdx, goalIdx, clampedSlope, (dist) => dist);
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

    const gentlestPath = this.runAStar(startIdx, goalIdx, clampedSlope, (dist, slope) => {
      const ratio = slope / Math.max(1, clampedSlope);
      return dist * (1 + 4.5 * ratio * ratio);
    });
    if (gentlestPath && this.overlapRatio(gentlestPath, shortestPath) < 0.9) {
      routes.push(
        this.buildRouteSummary("route-gentlest", "LOWEST SLOPE", "gentlest", gentlestPath),
      );
      discoveredPaths.push(gentlestPath);
    }

    // Penalize cells near existing routes (radius 2 cells) to discover a distinct corridor
    const penaltyMask = new Uint8Array(this.rows * this.cols);
    for (const path of discoveredPaths) {
      for (const idx of path) {
        if (idx === startIdx || idx === goalIdx) continue;
        const pr = Math.floor(idx / this.cols);
        const pc = idx % this.cols;
        for (let dr = -2; dr <= 2; dr += 1) {
          for (let dc = -2; dc <= 2; dc += 1) {
            const nr = pr + dr;
            const nc = pc + dc;
            if (nr >= 0 && nr < this.rows && nc >= 0 && nc < this.cols) {
              penaltyMask[nr * this.cols + nc] = 1;
            }
          }
        }
      }
    }

    const alternatePath = this.runAStar(startIdx, goalIdx, clampedSlope, (dist, _slope, toNode) =>
      penaltyMask[toNode] ? dist * 3.5 : dist,
    );
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
    const rgba = new Uint8Array(this.rows * this.cols * 4);
    const cautionThresh = maxSlopeDeg * 0.75;

    for (let r = 0; r < this.rows; r += 1) {
      for (let c = 0; c < this.cols; c += 1) {
        const u = r * this.cols + c;
        if (!this.isValidCell(u)) continue;

        let localMaxSlope = 0;
        for (const [dr, dc] of DIRS) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nr >= this.rows || nc < 0 || nc >= this.cols) continue;
          const v = nr * this.cols + nc;
          if (!this.isValidCell(v)) continue;
          const s = this.edgeSlopeDeg(u, v, this.stepDist(dr, dc));
          if (s > localMaxSlope) localMaxSlope = s;
        }

        const p = u * 4;
        if (localMaxSlope > maxSlopeDeg) {
          // Impassable hazard (amber-orange, distinct from Mars red accent)
          rgba[p] = 245;
          rgba[p + 1] = 158;
          rgba[p + 2] = 11;
          rgba[p + 3] = 175;
        } else if (localMaxSlope > cautionThresh) {
          rgba[p] = 234;
          rgba[p + 1] = 179;
          rgba[p + 2] = 8;
          rgba[p + 3] = 55;
        }
      }
    }

    return encodeRgbaPng(this.cols, this.rows, rgba);
  }
}
