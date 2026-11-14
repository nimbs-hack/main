# Function reference

Module and function reference for every TypeScript source file across `@nimbs/shared`, `@nimbs/api`, `@nimbs/web`, and `scripts`. For system architecture, coordinate rules, and HTTP payloads, see [Algorithms and architecture](algorithms-and-architecture.md).

## Package overview

| Package or folder | Source files | Documented callables | Primary role |
| --- | --- | --- | --- |
| `@nimbs/shared` | 4 | 8 | Canonical Mars geodesy, basemap layer metadata, shared TypeScript contracts |
| `@nimbs/api` | 8 | 115 | Hono HTTP server, 8-connected DEM `TerrainGraph`, 2D weather field, weather generator and evaluator, tile proxy, PNG encoder |
| `@nimbs/web` | 18 | 71 | React and Leaflet console UI, tool rail registry, point persistence, MIL-STD-2525C symbol renderer, weather and route panels |
| `scripts` | 4 | 34 | Process launcher, remote COG DEM cropper, NASA/PDS weather prober, legacy FGDC symbol extractor |

Note on callable counts: totals count every exported function, class constructor, class method or getter, React component, custom hook, top-level route handler, and internal helper documented below, while the 12 HTTP handlers mounted inside `createApp` and `createWeatherRouter` are documented within their factory entries.

---

## @nimbs/shared

### packages/shared/src/index.ts

Re-exports all coordinate utilities, basemap layer constants, and shared types from [packages/shared/src/index.ts](../packages/shared/src/index.ts).

This barrel module exports everything from `./coords`, `./layers`, and `./types` and defines no functions.

### packages/shared/src/coords.ts

Defines the canonical Mars coordinate sphere and geodesic transforms in [packages/shared/src/coords.ts](../packages/shared/src/coords.ts).

Module constants: `MARS_RADIUS_M = 3_396_190`, `DEG_TO_RAD = Math.PI / 180`, and `RAD_TO_DEG = 180 / Math.PI`.

#### `normalizeLon180(lonDeg: number): number`

Exported function that normalizes any east-positive longitude, including `0..360`, into `[-180, 180)`.

1. Computes `wrapped = ((((lonDeg + 180) % 360) + 360) % 360) - 180` so negative and greater-than-360 angles wrap cleanly.
2. Maps exact `180` to `-180` to keep the interval half-open.
3. Called by `equirectangularToCoord`, `coordToEquirectangular`, `surfaceDistanceMeters`, `TerrainGraph`, `MapView`, and `scripts/data/fetch-site.ts`.

#### `lon180To360(lonDeg: number): number`

Exported function that converts canonical `[-180, 180)` east-positive longitude to `[0, 360)` for UI display.

1. Evaluates `((lonDeg % 360) + 360) % 360`.
2. Called by `formatLon` in `App.tsx`, `formatShortCoord` in `routeVisuals.ts`, and `formatCoord` in `PointsPanel.tsx`.

#### `clampLat(latDeg: number): number`

Exported function that clamps planetocentric latitude to `[-90, 90]`.

1. Evaluates `Math.max(-90, Math.min(90, latDeg))`.
2. Called by `equirectangularToCoord` and `coordToEquirectangular`.

#### `equirectangularToCoord(xMeters: number, yMeters: number): MarsCoord`

Exported function that converts equirectangular projected meters with `clon = 0` and `lat_ts = 0` on the `3,396,190` m sphere to planetocentric degrees.

1. Computes `lon = normalizeLon180((xMeters / MARS_RADIUS_M) * RAD_TO_DEG)`.
2. Computes `lat = clampLat((yMeters / MARS_RADIUS_M) * RAD_TO_DEG)`.
3. Returns `{ lat, lon }`. Called by `scripts/data/fetch-site.ts`.

#### `coordToEquirectangular(coord: MarsCoord): { xMeters: number; yMeters: number }`

Exported function that converts planetocentric degrees to equirectangular projected meters with `clon = 0` and `lat_ts = 0`.

1. Computes `xMeters = normalizeLon180(coord.lon) * DEG_TO_RAD * MARS_RADIUS_M`.
2. Computes `yMeters = clampLat(coord.lat) * DEG_TO_RAD * MARS_RADIUS_M`.
3. Called by `scripts/data/fetch-site.ts`.

#### `surfaceDistanceMeters(a: MarsCoord, b: MarsCoord): number`

Exported function that returns great-circle surface distance in meters between `a` and `b` on the Mars sphere.

1. Converts `a.lat`, `b.lat`, `dLat = b.lat - a.lat`, and `dLon = normalizeLon180(b.lon - a.lon)` to radians.
2. Evaluates Haversine `h = sin(dLat / 2)^2 + cos(lat1) * cos(lat2) * sin(dLon / 2)^2`.
3. Clamps `Math.sqrt(h)` to `1` against floating-point overshoot and returns `2 * MARS_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))`.
4. Called by `TerrainGraph` constructor, `MapView.tsx` scale bar measurement, and `scripts/data/fetch-site.ts`.

#### `metersToLatDeg(meters: number): number`

Exported function that converts a north-south span in meters to planetocentric latitude degrees via `(meters / MARS_RADIUS_M) * RAD_TO_DEG`. Tested by `coords.test.ts`.

#### `metersToLonDeg(meters: number, atLatDeg: number): number`

Exported function that converts an east-west span in meters to east-positive longitude degrees at latitude `atLatDeg`.

1. Clamps `cosLat = Math.max(1e-6, Math.cos(atLatDeg * DEG_TO_RAD))` to prevent division by zero near the poles.
2. Returns `(meters / (MARS_RADIUS_M * cosLat)) * RAD_TO_DEG`. Tested by `coords.test.ts`.

### packages/shared/src/layers.ts

Declares verified global Mars basemap layer metadata proxied through `/api/tiles` in [packages/shared/src/layers.ts](../packages/shared/src/layers.ts).

Defines `DEFAULT_MARS_BASE_LAYER` (`id: "usgs-mdim"`, `maxNativeZoom: 9`) and `MARS_BASE_LAYERS` (`usgs-mdim`, `usgs-themis`, `usgs-mola-themis`, `mola-trek`). Contains no functions.

### packages/shared/src/types.ts

Defines shared TypeScript interfaces, union types, and `DEFAULT_EVA_WEATHER_LIMITS` in [packages/shared/src/types.ts](../packages/shared/src/types.ts).

Exports `DEFAULT_EVA_WEATHER_LIMITS` (`minAirTempC: -75`, `maxWindSpeedMps: 15`, `minPressurePa: 650`, `maxPressureSwingPa: 35`, `maxEvaHours: 4`) and 30 type contracts covering terrain grids, routes, weather snapshots, 48-hour traverse slots, and map layers. Contains no functions.

---

## @nimbs/api

### apps/api/src/index.ts

Builds the Hono API application, mounts tile and weather routers, and runs `Bun.serve` when executed as main in [apps/api/src/index.ts](../apps/api/src/index.ts).

#### `getTerrainGraph(): Promise<TerrainGraph | null>`

Internal async helper that lazily loads and caches `data/site-terrain.json` into module-level `cachedGraph`.

1. Returns `cachedGraph` immediately when already populated.
2. Checks `existsSync(TERRAIN_JSON_PATH)` and returns `null` when missing.
3. Reads UTF-8 JSON, parses `SiteDataset`, constructs `new TerrainGraph(dataset)`, stores `cachedGraph`, and returns it.

#### `parseScenario(raw: unknown): WeatherScenario | null`

Internal helper that validates query or JSON scenario values against `VALID_SCENARIOS` (`auto`, `nominal`, `dust-storm`, `cold-snap`). Returns `"auto"` when `raw` is `undefined` or `""`, the string if valid, or `null`.

#### `parseOptionalSol(raw: unknown): number | undefined | null`

Internal helper that validates optional Mars sol numbers. Returns `undefined` when omitted or empty, the integer when `Number.isInteger(num)` and `0 <= num <= 100_000`, or `null` when invalid.

#### `parseClampedQueryNumber(raw: string | undefined, fallback: number, min: number, max: number): number`

Internal helper that parses numeric query params and clamps finite numbers to `[min, max]`, returning `fallback` when missing or non-finite.

#### `validateRouteWeatherConstraints(raw: unknown): { constraints?: RouteWeatherConstraints; error?: string }`

Internal validator for `body.weatherConstraints` on `POST /api/graph/routes`.

1. Returns `{}` when `raw` is `undefined`; rejects non-object or array payloads.
2. Requires `enabled` to be a boolean.
3. Validates `scenario` via `parseScenario` and `sol` via `parseOptionalSol`.
4. Rejects non-finite or out-of-range `lmstHour` outside `[0, 48]`, `minAirTempC` outside `[-180, 60]`, `minPressurePa` outside `[0, 2500]`, and `thermalWeight` outside `[0, 1]`.
5. Returns normalized `{ constraints }` on success or `{ error }` on the first failure.

#### `resolveSiteWeatherField(c: Context, resolveGraph: () => Promise<TerrainGraph | null>, activeWeatherService: WeatherService): Promise<{ graph: TerrainGraph; field: SiteWeatherField } | Response>`

Internal async helper shared by `/api/site/pressure.png`, `/api/site/temperature.png`, and `/api/site/environment-summary`.

1. Resolves the active `TerrainGraph`, returning HTTP `503` if the terrain dataset is missing.
2. Parses `scenario` and `sol` query params, returning HTTP `400` on invalid values.
3. Clamps `lmstHour` to `[0, 48]` with default `12`, fetches the `MarsWeatherSnapshot` via `activeWeatherService.getWeather`, and computes the spatial field with `computeSiteWeatherField(graph, snapshot, lmstHour)`.

#### `createApp(injectedGraph?: TerrainGraph, weatherService?: WeatherService): Hono`

Exported factory that constructs the Hono application, allowing tests to inject a synthetic `TerrainGraph` and mock `WeatherService`. Registers 10 route handlers directly and mounts `tilesRouter` at `/api/tiles` and `createWeatherRouter` at `/api/weather`:

| Route | Behavior |
| --- | --- |
| `GET /api/health` | Resolves graph and returns `{ ok: true, siteLoaded, siteId }` with status `200`. |
| `GET /api/layers` | Returns `{ layers: MARS_BASE_LAYERS }` with status `200`. |
| `GET /api/site` | Returns `{ meta: graph.meta }` or HTTP `503` when no terrain file exists. |
| `GET /api/site/hillshade.png` | Reads `data/site-hillshade.png` and returns `image/png` with `Cache-Control: public, max-age=3600`, or HTTP `404`. |
| `GET /api/site/passability.png` | Clamps `maxSlopeDeg` query param to `[0.5, 89]` with default `15`, encodes `graph.renderSlopeMaskPng`, and returns `image/png` with `Cache-Control: public, max-age=300`. |
| `GET /api/site/pressure.png` | Calls `resolveSiteWeatherField`, clamps `minPressurePa` to `[0, 2500]` with default `650`, renders PNG via `renderPressureMaskPng`, and attaches `X-Layer-Min`, `X-Layer-Max`, `X-Layer-Mean`, `X-Layer-Lmst`, and `X-Layer-Unit: Pa` headers with `max-age=120`. |
| `GET /api/site/temperature.png` | Calls `resolveSiteWeatherField`, clamps `minAirTempC` to `[-180, 60]` with default `-75`, renders PNG via `renderTemperatureMaskPng`, and attaches `X-Layer-Min`, `X-Layer-Max`, `X-Layer-Mean`, `X-Layer-Lmst`, and `X-Layer-Unit: C` headers with `max-age=120`. |
| `GET /api/site/environment-summary` | Calls `resolveSiteWeatherField` and returns `toSiteEnvironmentSummary(resolved.field)` JSON. |
| `GET /api/terrain/elevation` | Validates finite `lat` and `lon` query params and returns `{ lat, lon, insideSite, elevationM }` from `graph.isInsideBounds` and `graph.elevationAt`. |
| `POST /api/graph/routes` | Validates `waypointA`, `waypointB`, `maxSlopeDeg`, and `weatherConstraints`. When weather constraints are enabled, builds a `TerrainWeatherFilter` from `computeSiteWeatherField` with defaults `lmstHour: 12`, `minAirTempC: -75`, `minPressurePa: 650`, and `thermalWeight: 0.35`, then returns `graph.planRoutes(...)`. |

When `import.meta.main` is true, starts `Bun.serve` on `Number(process.env.API_PORT ?? 3001)` serving `app.fetch`.

### apps/api/src/terrain/engine.ts

Implements the 8-connected elevation graph, zero-allocation binary min-heap, multi-strategy A* router, weather-constrained routing, minimax/maximin bottleneck diagnostics, and slope mask PNG renderer in [apps/api/src/terrain/engine.ts](../apps/api/src/terrain/engine.ts).

#### Internal class `MinHeap`

Binary min-heap backed by parallel number arrays `nodes` and `scores`. Exposes mutable fields `poppedNode` and `poppedScore` so A* loops pop entries without heap object allocation.

- `get size(): number` returns `this.nodes.length`.
- `clear(): void` sets `nodes.length = 0` and `scores.length = 0`, reusing array capacity across searches.
- `push(node: number, score: number): void` appends `(node, score)` and calls `bubbleUp(idx)`.
- `popInto(): boolean` extracts index `0` into `poppedNode` and `poppedScore`, pops the tail entry, moves it to index `0` if non-empty, runs `sinkDown(0)`, and returns `true`, or `false` when empty.
- `private bubbleUp(idx: number): void` swaps with parent `(i - 1) >> 1` while `scores[parent] > scores[i]`.
- `private sinkDown(idx: number): void` compares `left = 2 * i + 1` and `right = left + 1`, swapping down into the smaller child until heap order holds.
- `private swap(a: number, b: number): void` exchanges matching indices in both `nodes` and `scores`.

#### Exported class `TerrainGraph`

Builds an in-memory graph over `SiteDataset` elevations ordered row-major north-to-south and west-to-east.

##### `constructor(dataset: SiteDataset)`

1. Loads `elevations` into a `Float32Array` of length `rows * cols`.
2. Measures grid spacing `dyM` and `dxM` along bbox midlines using `surfaceDistanceMeters` divided by `max(1, rows - 1)` and `max(1, cols - 1)`, plus `diagM = Math.hypot(dyM, dxM)`.
3. Precomputes `dirOffsets` (`dr * cols + dc`) and `dirDists` (`hypot(dr * dyM, dc * dxM)`) for the 8 neighbor directions `DIRS`.
4. Marks `validMask[i] = 1` where `elevations[i]` is finite and `> nodataValue + 10`.
5. Preallocates `gScoreBuf`, `parentBuf`, `closedBuf`, `penaltyBuf`, and `bestSlopeBuf` typed arrays, then invokes `precomputeLocalMaxSlopes()`.

##### `private precomputeLocalMaxSlopes(): void`

Scans every valid cell across its valid 8-connected neighbors and stores the maximum unsigned slope `atan(abs(elev[v] - elev[u]) / max(1e-6, dirDists[d])) * 180 / Math.PI` in `localMaxSlope[u]`.

##### `getValidMask(): Uint8Array`

Returns the precomputed `validMask` byte array (`1` = valid elevation, `0` = nodata).

##### `isCellValid(idx: number): boolean`

Public accessor returning `this.validMask[idx] === 1`.

##### `private isValidCell(idx: number): boolean`

Internal helper returning `this.validMask[idx] === 1`.

##### `isInsideBounds(coord: MarsCoord): boolean`

Normalizes `coord.lon` with `normalizeLon180` and checks `south <= lat <= north` and `west <= lon <= east`.

##### `coordForCell(row: number, col: number): MarsCoord`

Maps grid `(row, col)` linearly to `{ lat, lon }` with north-to-south row ordering and normalized longitude.

##### `private coordToFractionalGrid(coord: MarsCoord): { r: number; c: number } | null`

Returns `null` if outside bounds; otherwise computes clamped fractional grid coordinates in `[0, rows - 1]` and `[0, cols - 1]`.

##### `elevationAt(coord: MarsCoord): number | null`

Public elevation query returning meters relative to the Mars areoid.

1. Calls `coordToFractionalGrid(coord)`, returning `null` if out of bounds.
2. Checks all four surrounding corners `(r0, c0)`, `(r0, c1)`, `(r1, c0)`, `(r1, c1)`. If all four are valid, computes bilinear interpolation and rounds to `0.01` m.
3. If any corner is nodata, falls back to the nearest rounded pixel if valid, or returns `null`.

##### `private snapToNode(coord: MarsCoord): number | null`

Rounds fractional grid position to `(r, c)`. If that cell is nodata, scans outward in square rings of radius `1..5` pixels and returns the first valid index, or `null` if none exists.

##### `private stepDist(dr: number, dc: number): number`

Returns `Math.hypot(dr * this.dyM, dc * this.dxM)` in meters.

##### `private edgeSlopeDeg(idxA: number, idxB: number, distM: number): number`

Returns unsigned segment slope in degrees: `(Math.atan(Math.abs(elevB - elevA) / Math.max(1e-6, distM)) * 180) / Math.PI`.

##### `computePassableEdgeRatio(maxSlopeDeg: number): number`

Computes the fraction of undirected valid edges with slope at or below `maxSlopeDeg`.

1. Precomputes `maxDhX`, `maxDhY`, and `maxDhD = dist * tan(maxSlopeDeg) + 1e-9`.
2. Scans each valid cell's 4 forward directions `[0, 1]`, `[1, 0]`, `[1, 1]`, and `[1, -1]` so every undirected edge is counted once.
3. Returns `Math.round((passable / total) * 1000) / 1000`, or `0` when `total === 0`.

##### `private buildWeatherContext(weatherFilter: TerrainWeatherFilter): ResolvedWeatherContext`

Validates that `cellTempK` and `cellPressurePa` match `this.totalCells` and prepares normalization spans for A* scoring.

1. Throws if array lengths differ from `this.totalCells`.
2. Converts `minAirTempC` to Kelvin, clamps `thermalWeight` to `[0, 1]`, and scans valid cells to record `maxTempK` and `maxPressurePa`.
3. Sets `tempSpanK = Math.max(5, maxTempK - minAirTempK)`, `pressureSpanPa = Math.max(10, maxPressurePa - minPressurePa)`, and `pressCautionSpanPa = Math.max(10, minPressurePa * 0.04)`.

##### `private isCellWeatherPassable(idx: number, ctx: ResolvedWeatherContext): boolean`

Returns `false` if `ctx.checkTemp` is true and `cellTempK[idx] < ctx.minAirTempK`, or if `ctx.checkPressure` is true and `cellPressurePa[idx] < ctx.minPressurePa`.

##### `private computeThermalRisk(idx: number, ctx: ResolvedWeatherContext): number`

Computes a soft thermal-and-pressure penalty score used by `"gentlest"` and `"weather-safe"` routing.

1. Normalizes temperature deficit `clamp((maxTempK - tK) / tempSpanK, 0, 1)` and pressure deficit `clamp((maxPressurePa - pPa) / pressureSpanPa, 0, 1)`.
2. Computes proximity caution factors `nearTemp` over a `5` K margin above `minAirTempK` and `nearPress` over `pressCautionSpanPa` above `minPressurePa`.
3. Returns `0.55 * tempDeficit + 0.45 * pressDeficit + 0.6 * Math.max(nearTemp, nearPress)`.

##### `private runAStar(startIdx: number, goalIdx: number, maxSlopeDeg: number, mode: RouteStrategy, weatherCtx?: ResolvedWeatherContext): number[] | null`

Runs single-source A* search over the grid graph using preallocated typed buffers.

1. Immediately returns `null` when `weatherCtx` is active and either `startIdx` or `goalIdx` fails `isCellWeatherPassable`.
2. Resets `gScoreBuf` to `+Infinity`, `parentBuf` to `-1`, `closedBuf` to `0`, and clears `MinHeap`.
3. Precomputes `maxDh[d] = dirDists[d] * Math.tan(maxSlopeDeg) + 1e-9` to reject steep edges without calling `Math.atan` on every step.
4. Seeds the heap with admissible Euclidean grid-plane distance `Math.hypot((r - goalR) * dyM, (c - goalC) * dxM)`.
5. Applies strategy weights per step: `"shortest"` uses `dist`; `"gentlest"` uses `dist * (1 + 4.5 * ratio^2 + thermalWeight * 1.0 * thermalRisk)`; `"weather-safe"` uses `dist * (1 + thermalWeight * 80 * thermalRisk + 0.5 * ratio^2)` with `WEATHER_SAFE_THERMAL_GAIN = 80`; `"alternate"` multiplies `dist` by `3.5` when `penaltyBuf[v]` is set.
6. Walks `parentBuf` backward from `goalIdx` on success, reverses, and returns node indices, or returns `null`.

##### `private findMaxFeasibleNodeValue(startIdx: number, goalIdx: number, maxSlopeDeg: number, values: Float32Array): number | null`

Runs maximin Dijkstra over slope-passable edges using `bestSlopeBuf` and `MinHeap` keyed by `-cand`. Returns the highest minimum cell value (`cellTempK` or `cellPressurePa`) achievable along any slope-valid path between `startIdx` and `goalIdx`, or `null` if disconnected.

##### `private findMinRequiredSlope(startIdx: number, goalIdx: number): number | null`

Runs minimax Dijkstra over all valid cells to find the tightest `maxSlopeDeg` threshold that connects `startIdx` and `goalIdx`. Relaxes `candSlope = Math.max(uSlope, edgeSlope)` and returns `Math.ceil(heap.poppedScore * 10) / 10` when `goalIdx` pops, or `null` when no valid cell path exists.

##### `private buildRouteSummary(id: string, label: string, strategy: RouteStrategy, nodePath: number[], weatherCtx?: ResolvedWeatherContext): ComputedRoute`

Converts cell indices into a `ComputedRoute` payload. Accumulates distance, elevation gain/loss, peak slope, and distance-weighted mean slope; rounds `lat`/`lon` to 6 decimals, elevation to `0.01` m, distance to `0.1` m, and slope to `0.01` deg. When `weatherCtx` is defined, attaches per-point `tempC` and `pressurePa` plus route-level min/max telemetry.

##### `private overlapRatio(pathA: number[], pathB: number[]): number`

Returns `sharedNodes / Math.max(1, Math.min(pathA.length, pathB.length))` using a `Set` over `pathB`.

##### `private formatLmstClock(lmstHour: number): string`

Wraps `lmstHour` modulo `24` and formats as `HH:MM`.

##### `private diagnoseUnreachable(...): RoutePlanResponse`

Determines why A* returned `null` and finds relaxable bottleneck bounds.

1. When no weather filter is present or when a slope-only `"shortest"` search fails, runs `findMinRequiredSlope` to return `blockedReason: "slope"` with `minRequiredSlopeDeg`, or `"nodata"` if disconnected.
2. When slope-only succeeds but weather blocks the path, runs temperature-only and pressure-only A* searches to classify `blockedReason` as `"temperature"`, `"pressure"`, or `"combined"`.
3. Calls `findMaxFeasibleNodeValue` on `cellTempK` and `cellPressurePa`, floors values to `0.01`, sets `maxFeasibleMinTempC` and `maxFeasibleMinPressurePa`, and formats a diagnostic message.

##### `planRoutes(waypointA: MarsCoord, waypointB: MarsCoord, maxSlopeDeg: number, weatherFilter?: TerrainWeatherFilter): RoutePlanResponse`

Public entry point called by `POST /api/graph/routes`.

1. Clamps `maxSlopeDeg` to `[0.5, 89]` and computes `passableEdgeRatio`.
2. Returns `status: "out_of_bounds"` if either waypoint is outside `meta.bbox` or fails `snapToNode`.
3. Builds `weatherCtx` if `weatherFilter` is provided and runs `"shortest"` A*, calling `diagnoseUnreachable` if blocked.
4. Runs `"gentlest"`, keeping it if `overlapRatio < 0.9`.
5. If `weatherCtx && weatherCtx.thermalWeight > 0`, runs `"weather-safe"`, keeping it if `overlapRatio < 0.88` against all discovered routes.
6. Paints `penaltyBuf` around intermediate cells of all discovered routes with square radius `Math.max(2, Math.min(8, Math.round(cols / 100)))` and runs `"alternate"`, keeping it if `overlapRatio < 0.85` against all discovered routes.
7. Returns `{ status: "ok", ..., snappedA, snappedB, routes }`.

##### `renderSlopeMaskPng(maxSlopeDeg: number): Uint8Array`

Renders an RGBA PNG mask for `GET /api/site/passability.png`. Sets valid cells with `localMaxSlope > maxSlopeDeg` to amber-orange `rgba(245, 158, 11, 175)`, cells with `localMaxSlope > maxSlopeDeg * 0.75` to caution yellow `rgba(234, 179, 8, 55)`, and remaining cells transparent, encoding with `encodeRgbaPng(cols, rows, rgba, 1)`.

### apps/api/src/terrain/weatherField.ts

Projects hourly weather snapshots across every valid DEM cell with terrain normals, solar incidence, scale height, and cold-air basin cooling, and encodes pressure/temperature mask PNGs in [apps/api/src/terrain/weatherField.ts](../apps/api/src/terrain/weatherField.ts).

#### Internal class `LruCache<K, V>`

Bounded `Map`-based LRU cache used for `fieldLruCache` (`8` entries) and `pngLruCache` (`16` entries).

- `constructor(private readonly maxEntries: number)` sets capacity.
- `get(key: K): V | undefined` moves hit keys to the end of `Map` iteration order and returns the value.
- `set(key: K, value: V): void` refreshes an existing key or evicts `map.keys().next().value` when `map.size >= maxEntries`.

#### `roundTo(val: number, decimals: number): number`

Internal helper rounding `val` to `decimals` digits via `10 ** decimals`.

#### `clampLmstHour(lmstHour: number): number`

Internal helper returning `12` for non-finite inputs and clamping finite inputs to `[0, 48]`.

#### `formatLmstLabel(lmstHour: number): string`

Internal helper formatting wrapped `[0, 24)` hour as `HH:MM`.

#### `pickHourPoint(hourly: readonly WeatherHourlyPoint[], targetHour: number): WeatherHourlyPoint | null`

Internal helper retrieving `hourly[targetHour]` when its `lmstHour` matches, falling back to `.find(...)` and modulo indexing.

#### `resolveTimelinePoint(snapshot: MarsWeatherSnapshot, hourIdx: number): WeatherHourlyPoint | null`

Internal helper reading `snapshot.hourly` for `hourIdx < 24` and `snapshot.nextSol.hourly` for `hourIdx >= 24`, wrapping to `snapshot.hourly` when absent.

#### `interpolateWeatherAtHour(snapshot: MarsWeatherSnapshot, lmstHour: number): InterpolatedWeatherSample`

Exported function that samples and interpolates a `MarsWeatherSnapshot` across `[0, 48]` LMST hours.

1. Clamps `lmstHour`, takes `h0 = Math.floor(clampedHour)`, `h1 = h0 >= 48 ? 48 : h0 + 1`, and fractional weight `frac = clampedHour - h0`.
2. Linearly blends `tempK`, `pressurePa`, and `solarIrradianceWm2` between `resolveTimelinePoint(snapshot, h0)` and `h1`.
3. Marks `isDaylight` true when blended `solarIrradianceWm2 > 0` and either endpoint hour is daylight.
4. Wraps `lsDeg` across `360°` when `snapshot.nextSol` is present, switches `sol`, `dustOpacityTau`, and `referenceElevationM` to `nextSol` at `clampedHour >= 24`, and returns `InterpolatedWeatherSample`.

#### `computeSpatialTerrainCache(graph: TerrainGraph): SpatialTerrainCache`

Internal helper memoized in `spatialCacheByGraph` (`WeakMap` keyed by `TerrainGraph`).

1. Computes barometric exponential height factor `Math.exp(-elevU / MARS_SCALE_HEIGHT_M)` for each valid cell.
2. Computes east-north-up surface unit normals `(normalX, normalY, normalZ)` via central differences when both neighbors are valid or one-sided differences along edges and nodata boundaries.
3. Runs an `O(N)` two-pass separable sliding-window mean over square radius `clamp(2, 10, round(200 / max(10, cellSizeMeters)))` to compute topographic concavity `basinDepthM[u] = max(0, localMean - elev[u])`.

#### `computeSiteWeatherField(graph: TerrainGraph, snapshot: MarsWeatherSnapshot, lmstHour: number): SiteWeatherField`

Exported function computing per-cell air temperature in Kelvin and pressure in Pascals over `graph` at `lmstHour`.

1. Checks `fieldLruCache` keyed by `graphId`, `siteId`, `sol`, `scenario`, rounded `lsDeg`, `dustOpacityTau`, `referenceElevationM`, `tempK`, `pressurePa`, `solarIrradianceWm2`, `isDaylight`, and `lmstHour`.
2. On cache miss, computes `pScale = sample.pressurePa * Math.exp(sample.referenceElevationM / 10_800)` and `baseTempAtZero = sample.tempK - (-0.0025) * sample.referenceElevationM`.
3. Computes the local ENU sun vector `(sunX, sunY, sunZ)` from `MARS_OBLIQUITY_RAD`, `lsDeg`, site center latitude, and hour angle.
4. For each valid cell, computes `pressurePa[u] = pScale * expHeightFactor[u]` and lapse-adjusted temperature `baseTempAtZero + (-0.0025) * elev[u]`.
5. When `isDaylight && solarIrradianceWm2 > 0 && sunZ > 0.02`, adds slope solar heating `solarAmp * clamp((max(0, normal · sun) - cosFlat) / max(0.2, cosFlat), -1.0, 1.2)` where `solarAmp = 5.0 * Math.exp(-0.55 * tau) * Math.min(1.15, irrad / 350)`.
6. Computes nocturnal clear-sky cold-air basin pooling cooling `min(nightMaxCooling, basinDepthM[u] * nightPoolSlope)` with `nightMaxCooling = 2.5 * nightStrength * Math.exp(-0.3 * tau)` and `nightPoolSlope = 0.02 * nightStrength * clearSkyFactor`.
7. Aggregates min, max, and mean summary values in Celsius and Pascals, registers the field key in `fieldKeyByField`, caches the result, and returns `SiteWeatherField`.
8. Called by `resolveSiteWeatherField` and `POST /api/graph/routes` in `apps/api/src/index.ts`.

#### `toSiteEnvironmentSummary(field: SiteWeatherField): SiteEnvironmentSummary`

Exported function projecting scalar summary metadata and min/max/mean Celsius and Pascal bounds from `SiteWeatherField` for `GET /api/site/environment-summary`.

#### `packRgba(r: number, g: number, b: number, a: number): number`

Internal helper packing RGBA bytes into a 32-bit unsigned integer for little-endian buffer writes.

#### `lerpChannel(a: number, b: number, t: number): number`

Internal helper linearly interpolating an 8-bit color channel and rounding to an integer.

#### `writeLutGradient(lut32: Uint32Array, lutBytes: Uint8Array, startBin: number, endBin: number, c0: readonly [number, number, number, number], c1: readonly [number, number, number, number]): void`

Internal helper populating a contiguous slice of the 256-entry `Uint32Array` and `Uint8Array` color lookup tables between `c0` and `c1`.

#### `encodeMaskFromBins(graph: TerrainGraph, values: Float32Array, lut32: Uint32Array, lutBytes: Uint8Array, binOf: (val: number) => number): Uint8Array`

Internal helper mapping every valid cell in `values` through `binOf` into the prebuilt LUT via a `Uint32Array` fast path on little-endian hosts and encoding with `encodeRgbaPng(cols, rows, rgba, 1)`.

#### `renderPressureMaskPng(graph: TerrainGraph, field: SiteWeatherField, minPressurePa: number): Uint8Array`

Exported function generating the pressure overlay PNG for `GET /api/site/pressure.png`. Checks `pngLruCache`; maps values `< minPressurePa` into bins `0..85` (`#d946ef` to `#a21caf`), caution band `[minPressurePa, minPressurePa * 1.04)` into bins `86..127` (`#eab308`), and safe values into bins `128..255` (`#38bdf8` to `#0d9488`).

#### `renderTemperatureMaskPng(graph: TerrainGraph, field: SiteWeatherField, minAirTempC: number): Uint8Array`

Exported function generating the temperature overlay PNG for `GET /api/site/temperature.png`. Checks `pngLruCache`; maps values `< minAirTempC` into bins `0..85` (`#0284c7` to `#2563eb`), near-limit band `[minAirTempC, minAirTempC + 5 C)` into bins `86..127` (`#38bdf8`), and warm safe values into bins `128..255` (`#f59e0b` to `#fb923c`).


### apps/api/src/weather/generator.ts

Synthesizes physically calibrated Jezero and Gale Crater climatology, hourly diurnal profiles, 48-hour next-sol forecasts, traverse departure windows, and EVA checks in [apps/api/src/weather/generator.ts](../apps/api/src/weather/generator.ts).

Module constants: `MARS_SCALE_HEIGHT_M = 10_800`, `MARS_SOL_SECONDS = 88_775.244`, `MARS_SOL_EARTH_HOURS = MARS_SOL_SECONDS / 3600`, `MARS_OBLIQUITY_RAD = (25.19 * Math.PI) / 180`, `MARS_ECCENTRICITY = 0.0934`, `MARS_PERIHELION_LS_DEG = 251`, `MARS_SOLAR_CONSTANT_WM2 = 589`, `MARS_LAPSE_RATE_K_PER_M = -0.0025`, `COMPASS_SECTORS` with 16 headings from `"N"` to `"NNW"`, `DEFAULT_EVA_LIMITS = DEFAULT_EVA_WEATHER_LIMITS`, `JEZERO_PRESET`, and `GALE_PRESET`.

#### `roundTo(val: number, decimals: number): number`

Internal helper rounding `val` to `decimals` fractional digits via `10 ** decimals`.

#### `kelvinToCelsius(kelvin: number): number`

Exported function returning `kelvin - 273.15`.

#### `celsiusToKelvin(celsius: number): number`

Exported function returning `celsius + 273.15`.

#### `scalePressureByElevation(pressurePa: number, targetElevationM: number, referenceElevationM: number): number`

Exported function scaling surface pressure exponentially across elevation via `pressurePa * Math.exp(-(targetElevationM - referenceElevationM) / MARS_SCALE_HEIGHT_M)`.

#### `lapseTempByElevation(tempK: number, targetElevationM: number, referenceElevationM: number): number`

Exported function adjusting boundary-layer air temperature via `tempK + MARS_LAPSE_RATE_K_PER_M * (targetElevationM - referenceElevationM)`.

#### `degreesToCompassSector(deg: number): CompassSector`

Exported function wrapping `deg` into `[0, 360)` and mapping `Math.round(normalized / 22.5) % 16` into `COMPASS_SECTORS`.

#### `seasonFromLs(lsDeg: number): MarsSeason`

Exported function mapping wrapped solar longitude `lsDeg` into `"northern spring"` below `90`, `"northern summer"` below `180`, `"northern autumn"` below `270`, and `"northern winter"` otherwise.

#### `estimateLsFromDate(date: Date = new Date()): number`

Exported function computing Mars areocentric solar longitude `Ls` in `[0, 360)` from UTC time using Allison and McEwen 2000 equations: computes `jdUt`, days since J2000 `deltaT = jdUt - 2451545.0`, mean anomaly `meanAnomalyDeg`, fictitious mean sun `fmsDeg`, planetary perturbation `pbsDeg`, 3-harmonic equation of center `nuMinusM`, and wraps `fmsDeg + nuMinusM`.

#### `estimatePerseveranceSol(date: Date = new Date()): number`

Exported function returning floored elapsed sols of `MARS_SOL_SECONDS` since Perseverance landing `2021-02-18T20:55:00Z`.

#### `estimateCuriositySol(date: Date = new Date()): number`

Exported function returning floored elapsed sols of `MARS_SOL_SECONDS` since Curiosity landing `2012-08-06T05:17:57Z`.

#### `resolveSiteWeatherProfile(siteHint?: string | null, activeSiteMeta?: SiteMetadata | null): SiteWeatherProfile`

Exported function matching `"gale"`, `"mount-sharp"`, `"msl"`, or exact `"curiosity"` to `GALE_PRESET` and all other inputs to `JEZERO_PRESET`. When `activeSiteMeta` matches the chosen crater, overrides `name`, `center`, `minElevationM`, and `maxElevationM` while retaining the preset `referenceElevationM`.

#### `deterministicNoise(seedA: number, seedB: number): number`

Internal helper returning the fractional part of `Math.sin(seedA * 12.9898 + seedB * 78.233) * 43758.5453` in `[0, 1)`.

#### `parseLmstHours(clockStr: string | undefined): number | null`

Internal helper splitting `HH:MM` or `HH:MM:SS` strings and clamping numeric hours to `[0, 24]`.

#### `formatLmstClock(hours: number): string`

Internal helper wrapping hours into `[0, 24)` and formatting `HH:MM:SS`.

#### `formatLmstHHMM(hours: number, allow24 = false): string`

Internal helper formatting `HH:MM` and emitting `"24:00"` when `allow24` is true and `hours` is within `1e-4` of `24`.

#### `incrementTerrestrialDate(dateStr: string): string`

Internal helper adding `86_400_000` ms to `dateStr` and returning the `YYYY-MM-DD` UTC prefix.

#### `computeSolarDeclinationRad(lsDeg: number): number`

Internal helper returning `Math.asin(Math.sin(MARS_OBLIQUITY_RAD) * Math.sin(lsRad))`.

#### `computeSolarNoonLmst(lsDeg: number): number`

Internal helper approximating Mars equation-of-time solar noon shift via `12.0 - 0.35 * Math.sin(lsRad - periRad) + 0.15 * Math.sin(2 * lsRad)`.

#### `computeMarsSolarFactor(lsDeg: number): number`

Internal helper returning orbital insolation scaling `rRatio * rRatio` from `MARS_ECCENTRICITY` and `MARS_PERIHELION_LS_DEG`.

#### `computeSolarGeometryAtLmst(latDeg: number, lsDeg: number, lmstHour: number): SolarGeometry`

Exported function computing Martian sun elevation sine, clockwise azimuth from north, and East-North-Up unit vector `(sunDirX, sunDirY, sunDirZ)` at latitude `latDeg`, solar longitude `lsDeg`, and local mean solar hour `lmstHour`.

#### `computeDaylightWindow(latDeg: number, lsDeg: number, terrestrialDate: string, overrideSunrise?: string, overrideSunset?: string): { sunriseHour: number; sunsetHour: number; sunriseLmst: string; sunsetLmst: string; sunriseUtc: string; sunsetUtc: string; durationHours: number }`

Internal helper clamping `-Math.tan(latRad) * Math.tan(decl)` to `[-0.98, 0.98]` for sunrise/sunset hour angle, clamping default sunrise to `[4.0, 8.5]` and sunset to `[15.5, 20.0]` when telemetry overrides are absent, and converting LMST bounds to UTC ISO strings scaled by `MARS_SOL_EARTH_HOURS / 24`.

#### `jezeroSeasonalPressurePa(lsDeg: number): number`

Internal helper modeling the seasonal Martian CO2 condensation pressure baseline at Jezero reference elevation `-2500` m via `788 + 42 * cos(ls - 295 deg) + 18 * cos(2 * (ls - 210 deg))`.

#### `climatologyAirTempRangeK(latDeg: number, lsDeg: number, tau: number, scenario: WeatherScenario, sol: number): { minK: number; maxK: number }`

Internal helper deriving diurnal air temperature bounds clamped to `minK` in `[150, 230]` and `maxK` in `[minK + 18, 295]`. High optical dust depth `tau` warms night minima up to `+14` K and cools daytime highs up to `-24` K; `"cold-snap"` shifts bounds by `-11` K and `-21` K, and `"dust-storm"` shifts bounds by `+4` K and `-14` K.

#### `defaultDustTau(lsDeg: number, scenario: WeatherScenario, sol: number): number`

Internal helper returning optical dust depth: `2.65..3.4` for `"dust-storm"`, `0.28..0.36` for `"cold-snap"`, and `Math.max(0.2, 0.52 - 0.18 * cos(ls - 255 deg) + jitter)` otherwise.

#### `buildHourlyDiurnalSeries(params): WeatherHourlyPoint[]`

Internal helper synthesizing 24 hourly `WeatherHourlyPoint` records over `params` fields `latDeg`, `lsDeg`, `sunriseHour`, `sunsetHour`, `tempMinK`, `tempMaxK`, `pressureMinPa`, `pressureAvgPa`, `pressureMaxPa`, `windMinMps`, `windAvgMps`, `windMaxMps`, `tau`, `hourlyTempOverride`, and `hourlyPressureOverride`:

1. Computes thermal minimum near `Math.max(1.5, sunriseHour - 0.75)` and peak near `Math.min(sunsetHour - 1.2, 14.5)`, shaping warming with `Math.sin(phase * PI / 2) ** 1.2` and cooling with `Math.exp(-2.6 * decayProgress)`.
2. Shapes diurnal and semidiurnal thermal tides peaking near `08:30`, `09:00`, and `21:00`, blending `0.85 * mapped + 0.15 * pressureAvgPa`.
3. Shapes convective afternoon winds near `14:00` plus a `0.25` nocturnal katabatic bump near `02:00`, blending `0.75 * windSpeedMps + 0.25 * windAvgMps`.
4. Evaluates Beer-Lambert solar irradiance and UV index `11.5 * solarFactor * cosZenith * Math.exp(-0.85 * tau)` during daylight, honoring any `hourlyTempOverride` and `hourlyPressureOverride` entries.

#### `generateMartianWeather(options: GenerateWeatherOptions = {}): MarsWeatherSnapshot`

Exported function producing a complete `MarsWeatherSnapshot` for Jezero or Gale Crater, optionally grounded in `options.observedOverrides`.

1. Resolves `site` via `resolveSiteWeatherProfile`, treats `"auto"` as `"nominal"` for baseline climatology, estimates `sol`, `lsDeg`, and `tau`, and computes the daylight window.
2. Scales `jezeroSeasonalPressurePa` from `-2500` m to `site.referenceElevationM`, applies scenario pressure offsets `-6` Pa for `"cold-snap"` or `+4` Pa for `"dust-storm"`, and derives diurnal swing from `avg * (0.022 + 0.0155 * Math.min(4, tau))`.
3. Overlays real observed min/avg/max temperature, pressure, wind, compass heading, sunrise/sunset, and hourly maps when present, recording `realChannels` and `simulatedChannels`.
4. Sets `sourceType` to `"real"` only when all three of `"airTemp"`, `"pressure"`, and `"windSpeed"` are observed, `"hybrid"` when some real channels exist, and `"simulated"` otherwise, then attaches the 24-hour `nextSol` forecast from `synthesizeNextSolForecast`.

#### `synthesizeNextSolForecast(base: Omit<MarsWeatherSnapshot, "nextSol">): MarsWeatherSolForecast`

Internal helper extending `base` to `sol + 1` and `lsDeg + 0.51`. Bounds dust `tau` step to `0.3` during `"dust-storm"` or `0.12` otherwise, shifts air temperature min and max deltas inside `[-2.2, 2.2]` K and `[-2.8, 2.8]` K, and smoothly blends hours `0..3` against hours `22..23` of `base.hourly` with weights `1.0`, `0.6`, `0.3`, and `0.1` to eliminate midnight jumps.

#### `ensureNextSolForecast(snapshot: MarsWeatherSnapshot): MarsWeatherSnapshot`

Exported function returning `snapshot` unchanged if `snapshot.nextSol.hourly` already has 24 entries, or calling `synthesizeNextSolForecast(snapshot)` to populate cached snapshots lacking 48-hour data.

#### `normalizeHourly24(hourly: readonly WeatherHourlyPoint[], fallback?: readonly WeatherHourlyPoint[]): WeatherHourlyPoint[]`

Internal helper normalizing hourly records into 24 ordered slots `0..23` with a `210` K, `4` m/s, `750` Pa fallback entry when missing.

#### `sampleWeatherAtOffset(snapshot: MarsWeatherSnapshot, offsetHours: number): SampledWeatherPoint`

Exported function linearly interpolating temperature, pressure, wind speed, irradiance, and UV across `offsetHours` clamped to `[0, 48]`. Treats exact `48.0` as hour `24:00` of sol 1 using hour `23` of `sol1` and checks sunrise/sunset LMST bounds via `parseLmstHours` to set `isDaylight`.

#### `resolvePositiveSpeed(value: number | undefined, fallback: number): number`

Internal helper returning finite positive speed values or the fallback constant.

#### `resolveLimits(partial?: Partial<EvaWeatherLimits>): EvaWeatherLimits`

Internal helper merging partial suit thresholds and traverse speeds (`flatSpeedMPerH`, `climbSpeedMPerH`, `descentSpeedMPerH`) with `DEFAULT_EVA_LIMITS`.

#### `computeSegmentHours(distM: number, gainM: number, lossM: number, limits: EvaWeatherLimits): number`

Internal helper calculating segment travel time in hours as `distM / limits.flatSpeedMPerH + gainM / limits.climbSpeedMPerH + lossM / limits.descentSpeedMPerH`.

#### `computePointsDurationHours(points: readonly TraversePointSample[], limits: EvaWeatherLimits): number`

Internal helper integrating segment travel time over consecutive route samples using `computeSegmentHours`.

#### `resolveRouteDurationHours(route: EvaRouteContext | undefined, limits: EvaWeatherLimits): number | null`

Internal helper computing rounded traverse duration in hours from `route.totalDistanceM`, `elevationGainM`, and `elevationLossM` using `computeSegmentHours`, or falling back to `computePointsDurationHours(route.points, limits)`.

#### `buildWalkTimeProfile(route: EvaRouteContext | undefined, floorElevationM: number, evaluationElevationM: number, fallbackDurationHours: number, limits: EvaWeatherLimits): { durationHours: number; timeGrid: WalkTimeSample[]; extremaPoints: WalkTimeSample[] }`

Internal helper building an evenly spaced `timeGrid` of `8..64` samples for daylight integration and `extremaPoints` for worst-case elevation exposure. Uses cumulative route progress when route points exist or a symmetric floor-to-rim-to-floor triangle otherwise.

#### `statusPriority(status: EvaStatus): number`

Internal helper ranking `"GO"` as `0`, `"DEGRADED"` as `1`, and `"NO-GO"` as `2`.

#### `computeTraverseWindows(snapshot: MarsWeatherSnapshot, options: ComputeTraverseWindowsOptions = {}): TraverseWindowsResult`

Exported function scanning departure offsets across `[0, 48)` hours to produce `departureSlots` and up to 4 ranked `recommendedWindows`.

1. Picks scan step `stepHours` clamped to `[0.25, 4]`, defaulting to `0.5` when walk duration is at most `12` h and `1.0` otherwise.
2. Evaluates each departure offset across `profile.timeGrid` for `daylightFraction` and across `profile.extremaPoints` for elevation-scaled temperature and pressure, peak wind, and UV.
3. Classifies `"NO-GO"` on walk exceeding `maxEvaHours`, `minTempC < minAirTempC`, `minPressurePa < minPressurePa`, `maxWindMps > maxWindSpeedMps`, `activeSwingPa > maxPressureSwingPa`, `daylightFraction < 0.5`, or forecast horizon `timelineCoverage < 0.5`, `"DEGRADED"` inside caution margins, and `"GO"` otherwise.
4. Scores each slot out of `100` using weighted margins `0.3 * tempScore + 0.25 * daylightFraction + 0.2 * windScore + 0.15 * pressScore + 0.1 * dustScore`, applies `* 0.85` swing and `* 0.75` duration penalties, and clamps `"GO"` to `[70, 100]`, `"DEGRADED"` to `[35, 79]`, and `"NO-GO"` to `[0, 48]`.
5. Internal helper `groupContiguousRuns` merges adjacent same-sol, same-status slots; if neither `"GO"` nor `"DEGRADED"` exists, surfaces peak-scoring emergency intervals within `Math.max(4, peak * 0.12)` per sol, sorts by status, score, span, and start time, and slices the top 4.

#### `worstStatus(statuses: readonly EvaStatus[]): EvaStatus`

Internal helper returning `"NO-GO"` if present, then `"DEGRADED"`, else `"GO"`.

#### `findSafeTraverseWindow(hourly: readonly WeatherHourlyPoint[], referenceElevationM: number, targetElevationM: number, minAirTempK: number, maxWindSpeedMps: number): { window: EvaSafeWindow; thermalDaylightHours: number }`

Internal helper scanning a single 24-hour sol at `targetElevationM` to count daylight hours meeting `minAirTempK` and extract the longest contiguous daylight run satisfying both thermal and wind limits.

#### `evaluateEvaWeather(snapshot: MarsWeatherSnapshot, options: EvaluateEvaOptions = {}): EvaWeatherEvaluation`

Exported function computing the EVA verdict, 5 suit checks, selected-hour telemetry, and 48-hour traverse windows.

1. Resolves floor and rim elevations, scales pressure and temperature bounds to `evaluationElevationM`, computes `selectedHourWeather` at `lmstHour` defaulting to `12`, and runs `computeTraverseWindows`.
2. Evaluates checks `"air_temp"`, `"wind_speed"`, `"pressure"`, `"pressure_swing"`, and `"eva_duration"` against `limits` with near-limit caution bands at `+5` C temp, `1.04x` pressure, `0.8x` wind, `0.85x` pressure swing, and `+1.0` h window margin.
3. Combines worst check status into overall verdict `status`, formats human-readable `summary`, and attaches provenance metadata.

### apps/api/src/weather/service.ts

Coordinates NASA Mars 2020 MEDA and MSL REMS RSS feeds, local `data/site-weather.json` telemetry, 15-minute memory/disk caches, and synthetic fallback in [apps/api/src/weather/service.ts](../apps/api/src/weather/service.ts).

Module constants: `MEDA_RSS_URL`, `REMS_RSS_URL`, `INSIGHT_RSS_URL`, `DEFAULT_CACHE_DIR`, `DEFAULT_SITE_WEATHER_PATH`, and `defaultWeatherService`.

#### `parseFiniteField(val: unknown): number | undefined`

Internal helper returning finite numbers and numeric strings while rejecting empty strings, `"--"`, and `"NA"`.

#### `parseMedaRssLatest(payload: unknown): PersistedSiteWeatherRecord | null`

Exported function parsing Mars 2020 MEDA RSS JSON: sorts `payload.sols` descending by `sol`, skips entries missing temperature and pressure, converts Celsius to Kelvin, records `realChannels`, and returns a `"jezero"` record.

#### `parseRemsRssLatest(payload: unknown): PersistedSiteWeatherRecord | null`

Exported function parsing MSL REMS RSS JSON across `payload.soles ?? payload.sols`, skipping entries without temperature or pressure, converting Celsius to Kelvin, and returning a `"gale"` record.

#### `toObservedInput(record: PersistedSiteWeatherRecord): ObservedWeatherInput`

Internal helper projecting a `PersistedSiteWeatherRecord` into `ObservedWeatherInput` for `generateMartianWeather`.

#### Class `WeatherService`

##### `constructor(options: WeatherServiceOptions = {})`

Initializes `cacheDir`, `siteWeatherPath`, `cacheTtlMs` defaulting to `15 * 60 * 1000`, `liveTimeoutMs` defaulting to `4000`, `fetcher` defaulting to global `fetch`, and `enableLiveFetch` defaulting to `true`.

##### `readDiskCache(siteId: string): Promise<CacheEntry | null>`

Private method loading `<cacheDir>/<siteId>.json` and validating required snapshot blocks and non-empty `hourly` array.

##### `writeDiskCache(siteId: string, entry: CacheEntry): Promise<void>`

Private method creating `cacheDir` and writing `<cacheDir>/<siteId>.json`, swallowing disk errors so cache I/O never interrupts weather responses.

##### `readPersistedSiteWeather(siteId: "jezero" | "gale"): Promise<PersistedSiteWeatherRecord | null>`

Private method reading `siteWeatherPath` (`data/site-weather.json`) and returning `file.sites[siteId]`.

##### `fetchLiveRecord(siteId: "jezero" | "gale"): Promise<PersistedSiteWeatherRecord | null>`

Private method fetching `REMS_RSS_URL` for Gale or `MEDA_RSS_URL` for Jezero with `AbortSignal.timeout(liveTimeoutMs)` and delegating JSON parsing to `parseRemsRssLatest` or `parseMedaRssLatest`.

##### `getWeather(params: GetWeatherParams = {}): Promise<MarsWeatherSnapshot>`

Public method returning a `MarsWeatherSnapshot` for `params.site` and `params.scenario`:

1. Bypasses real telemetry and caching when `scenario !== "auto"`, returning purely simulated output from `generateMartianWeather`.
2. For `"auto"` without a pinned `sol` or `refresh`, checks `memCache` and disk cache within `cacheTtlMs`, realigning site metadata and upgrading cached snapshots lacking `nextSol` via `ensureNextSolForecast`.
3. On miss or refresh, loads persisted telemetry and live RSS telemetry, picks whichever record matches a requested `sol` or has the newer `sol`, runs `generateMartianWeather` with `observedOverrides` when available, and caches the result to memory and disk.

### apps/api/src/routes/tiles.ts

Proxies and disk-caches NASA Mars Trek and USGS Planetary WMS EPSG:4326 basemap tiles in [apps/api/src/routes/tiles.ts](../apps/api/src/routes/tiles.ts).

Module constants: `TILE_CACHE_DIR` pointing to `data/cache/tiles`, and `USGS_WMS_LAYERS` mapping `"usgs-mdim"`, `"usgs-themis"`, `"usgs-mola-themis"`, and `"usgs-hillshade"` to USGS WMS layer names.

#### `buildUpstreamUrl(layer: string, z: number, x: number, y: number): string | null`

Internal helper rejecting `z > 7` for `"mola-trek"` or constructing `trek.nasa.gov` WMTS `.jpg` URLs, and converting EPSG:4326 `(z, x, y)` tile bounds via `tileDeg = 180 / 2 ** z` into 256x256 USGS WMS 1.1.1 `GetMap` PNG URLs.

#### Route `GET /:layer/:z/:x/:y` on `tilesRouter`

Hono handler validating `0 <= z <= 14`, `0 <= x < 2^(z + 1)`, and `0 <= y < 2^z` with HTTP `400`, returning `404` for unsupported layer or zoom, serving cached files from `data/cache/tiles/<layer>/<z>_<x>_<y>.<ext>` with `X-Tile-Cache: HIT` and `Cache-Control: public, max-age=86400`, or fetching upstream with a `12_000` ms timeout, verifying `image/*` MIME headers, persisting to disk, and returning HTTP `502` or `504` on upstream failures.

### apps/api/src/routes/weather.ts

Validates inputs and implements the weather REST endpoints in [apps/api/src/routes/weather.ts](../apps/api/src/routes/weather.ts).

#### `readFallbackSiteMeta(): Promise<SiteMetadata | null>`

Internal helper memoizing `data/site-terrain.json` `.meta` in `cachedFallbackMeta` when callers omit a custom `getSiteMeta` resolver.

#### `parseScenario(raw: string | undefined): WeatherScenario | null`

Internal helper defaulting empty inputs to `"auto"` and validating membership in `VALID_SCENARIOS`.

#### `parseOptionalSol(raw: unknown): number | undefined | null`

Internal helper accepting blank inputs as `undefined` and integer sols in `[0, 100_000]`.

#### `parseQueryLmstHour(raw: string | undefined): number | undefined | null`

Internal helper accepting blank inputs as `undefined` and finite hours in `[0, 48]`.

#### `validateRoute(rawRoute: unknown): { route?: EvaRouteContext; error?: string }`

Internal helper checking `totalDistanceM`, `elevationGainM`, `elevationLossM`, `minElevationM`, `maxElevationM`, and every sample in `points` for non-decreasing `distanceM`, finite `elevationM`, `slopeDeg` in `[0, 90]`, `lat` in `[-90, 90]`, and `lon` in `[-360, 360]`.

#### `validateLimits(rawLimits: Partial<EvaWeatherLimits> | undefined): { limits: Partial<EvaWeatherLimits>; error?: string }`

Internal helper enforcing `minAirTempC` in `[-180, 60]`, `maxWindSpeedMps` in `[0, 100]`, `minPressurePa` in `[0, 2500]`, `maxPressureSwingPa` in `[0, 500]`, `maxEvaHours` in `(0, 24]`, `flatSpeedMPerH` in `[100, 50_000]`, `climbSpeedMPerH` in `[25, 10_000]`, and `descentSpeedMPerH` in `[25, 15_000]`.

#### `createWeatherRouter(options: WeatherRouterOptions = {}): Hono`

Exported factory returning a Hono router and instantiating default `weatherRouter`:

1. `GET /`: validates `scenario`, `sol`, `lmstHour`, `site`, and `refresh` query parameters, loads site metadata, fetches weather via `service.getWeather`, evaluates default suit limits with `evaluateEvaWeather`, and returns `WeatherApiResponse`.
2. `POST /evaluate`: validates JSON body fields, `limits`, `elevationM`, `lmstHour`, and optional `route`, backfills `nextSol` via `ensureNextSolForecast` if `body.weather` is supplied or fetches fresh weather otherwise, runs `evaluateEvaWeather`, and returns `WeatherApiResponse`.

### apps/api/src/utils/png.ts

Encodes raw RGBA pixel buffers into standard compressed PNG bytes using `node:zlib` in [apps/api/src/utils/png.ts](../apps/api/src/utils/png.ts).

Module constant: `CRC_TABLE` holding the precomputed 256-entry IEEE 802.3 CRC-32 table with polynomial `0xedb88320`.

#### `crc32(bytes: Uint8Array): number`

Internal helper computing unsigned 32-bit CRC-32 over chunk type and payload bytes.

#### `makeChunk(type: string, data: Uint8Array): Uint8Array`

Internal helper framing a PNG chunk as big-endian length, 4-character ASCII chunk type, `data`, and big-endian `crc32`.

#### `encodeRgbaPng(width: number, height: number, rgba: Uint8Array, compressionLevel = 6): Uint8Array`

Exported function prepending scanline filter byte `0` to every row, building a 13-byte `IHDR` chunk configured for 8-bit RGBA, compressing pixel scanlines with `deflateSync`, and concatenating the 8-byte PNG signature with `IHDR`, `IDAT`, and `IEND` chunks. Called by `TerrainGraph.renderSlopeMaskPng` and `weatherField.ts` `encodeMaskFromBins`.


---

## @nimbs/web

### apps/web/src/main.tsx

Mounts the React application into the `#root` DOM node in [apps/web/src/main.tsx](../apps/web/src/main.tsx).

Imports CSS stylesheets including Leaflet styles, design tokens, and app styles, finds `#root`, throws `Missing #root mount element` if absent, and renders `<App />` inside `StrictMode`. Defines no named functions.

### apps/web/src/App.tsx

Owns mission state, API debounces, simulation playback timer, point persistence, and the 5-tool console layout in [apps/web/src/App.tsx](../apps/web/src/App.tsx).

Module constant: `DEFAULT_THERMAL_WEIGHT = 0.35`.

#### `formatLon(lonDeg: number, fmt: LonFormat): string`

Internal helper formatting east-positive longitude to 5 decimal places with a degree symbol in `[-180, 180)` or `lon180To360` `[0, 360)`.

#### `isAbortError(err: unknown): boolean`

Internal helper returning `true` when `err` is a `DOMException` with `name === "AbortError"`.

#### `sampleRoutePoints(points: RoutePoint[], maxSamples = 80): TraversePointSample[]`

Internal helper downsampling `points` uniformly to at most `maxSamples` `TraversePointSample` records, deduplicating repeated indices and preserving route endpoints for `POST /api/weather/evaluate`.

#### `App()`

Exported React root component coordinating all panels, overlays, and server calls:

1. Hydrates `pointClasses`, `points`, and `hiddenClassIds` synchronously from `loadPointState()` and writes updates back through `savePointState()`.
2. Loads `SiteMetadata` via `fetchSiteMeta()`, basemap layers via `fetchBaseLayers()`, and initial weather via `fetchWeatherSnapshot()`.
3. Advances `simLmstHour` by `+0.5` hours every `600` ms while `isPlayingTime` is true, wrapping from `48` back to `0`.
4. Debounces cursor elevation lookups against `fetchElevation` by `45` ms when inside `site.bbox`, route planning against `planGraphRoutes` with `DEFAULT_THERMAL_WEIGHT = 0.35` and `AbortController` by `120` ms, weather constraint evaluation against `evaluateWeatherConstraints` by `80` ms, and site weather summary requests against `fetchEnvironmentSummary` by `160` ms when temperature or pressure overlays are active.
5. Registers 5 `ToolDefinition` panels in `ToolRegistry` with ids `"route"`, `"points"`, `"weather"`, `"layers"`, and `"settings"`, sets `leftHudOffset = panelOpen ? 480 : 64`, manages `uiMode` (`"basic"` vs `"advance"`) and `presetId` (`"human"` vs `"rover"`) via the rail `BSC`/`ADV` switch, locks map point/class editing when `uiMode === "basic"`, and renders the rail, drawer, `MapView`, telemetry HUD, floating `TimeSimulationControl`, and `ContextMenu`.

### apps/web/src/registry/toolRegistry.ts

Provides the ordered registry backing the left vertical tool rail in [apps/web/src/registry/toolRegistry.ts](../apps/web/src/registry/toolRegistry.ts).

#### Class `ToolRegistry`

##### `register(tool: ToolDefinition): void`

Inserts or replaces a `ToolDefinition` keyed by `tool.id` in the internal `Map`.

##### `list(): ToolDefinition[]`

Returns all registered tools sorted ascending by numeric `order`.

##### `get(id: ToolId): ToolDefinition | undefined`

Returns the matching `ToolDefinition` or `undefined`. Called by `App.tsx`.

### apps/web/src/services/api.ts

Typed HTTP client wrappers and shared type re-exports communicating with `@nimbs/api` in [apps/web/src/services/api.ts](../apps/web/src/services/api.ts).

Every function throws an `Error` containing the HTTP status code when `res.ok` is false.

#### `fetchSiteMeta(): Promise<SiteMetadata>`

Exported async function fetching `GET /api/site` and returning `data.meta`.

#### `fetchBaseLayers(): Promise<MapLayerMeta[]>`

Exported async function fetching `GET /api/layers` and returning `data.layers`.

#### `fetchElevation(lat: number, lon: number): Promise<ElevationResponse>`

Exported async function fetching `GET /api/terrain/elevation` with `lat` and `lon` query params.

#### `planGraphRoutes(payload: RoutePlanRequest, signal?: AbortSignal): Promise<RoutePlanResponse>`

Exported async function posting `payload` to `POST /api/graph/routes` with cancellation support via `AbortSignal`.

#### `fetchWeatherSnapshot(params?, signal?: AbortSignal): Promise<WeatherApiResponse>`

Exported async function requesting `GET /api/weather` with optional `site`, `scenario`, `sol`, `lmstHour`, and `refresh` query parameters.

#### `evaluateWeatherConstraints(payload, signal?: AbortSignal): Promise<WeatherApiResponse>`

Exported async function posting `limits`, `site`, `scenario`, `sol`, `lmstHour`, `elevationM`, `route`, and optional cached `weather` snapshot to `POST /api/weather/evaluate`.

#### `fetchEnvironmentSummary(params?, signal?: AbortSignal): Promise<SiteEnvironmentSummary>`

Exported async function requesting `GET /api/site/environment-summary` with optional `scenario`, `sol`, and `lmstHour` parameters.

### apps/web/src/services/pointStore.ts

Manages tactical point and category serialization, `localStorage` persistence, visibility filters, and validation in [apps/web/src/services/pointStore.ts](../apps/web/src/services/pointStore.ts).

Module constants: `CORE_ICON_SET` with 7 built-in icon keys, `DEFAULT_POINT_CLASSES`, `POINT_CLASS_SWATCHES`, and `STORAGE_KEY = "nimbs.mars-map-points.v1"`.

#### `isValidPointIconKey(value: string): value is PointIconKey`

Exported type guard returning true for keys in `CORE_ICON_SET` or `MIL2525C_BY_ID`.

#### `normalizeStoredIconKey(value: unknown): PointIconKey | undefined`

Internal helper validating stored icon keys directly and migrating retired `"fgdc-*"` keys through `resolveLegacyFgdcIcon`.

#### `isRecord(value: unknown): value is Record<string, unknown>`

Internal type guard verifying non-null plain object values.

#### `defaultState(): PersistedPointState`

Internal helper returning cloned `DEFAULT_POINT_CLASSES`, empty `points`, and empty `hiddenClassIds`.

#### `parsePointState(raw: string | null): PersistedPointState`

Exported function parsing serialized state JSON, preserving built-in classes first, validating custom class colors, short codes, and migrated icons, validating point coordinates, and deduplicating `hiddenClassIds`. Falls back to `defaultState()` on invalid JSON.

#### `loadPointState(): PersistedPointState`

Exported function reading `STORAGE_KEY` from `window.localStorage` and passing it to `parsePointState`.

#### `savePointState(state: PersistedPointState): void`

Exported function serializing `state` into `window.localStorage` while ignoring storage quota or private browsing errors.

#### `toggleClassVisibility(hiddenClassIds: readonly string[], classId: string): string[]`

Exported function adding or removing `classId` from `hiddenClassIds`.

#### `setAllClassesVisible(classes: readonly MapPointClass[], visible: boolean): string[]`

Exported function returning `[]` when `visible` is true or all class IDs when false.

#### `filterVisiblePoints(points: readonly MapPoint[], hiddenClassIds: readonly string[], searchQuery = ""): MapPoint[]`

Exported function filtering `points` by visible classes and case-insensitive substring match against `name` or `description`.

#### `createMapPoint(input, existing: readonly MapPoint[]): MapPoint`

Exported function trimming `input.name`, rejecting empty names, generating a unique slugged ID `pt-<slug>-<base36>` with numeric fallback if colliding, and cloning `coord`.

#### `createCustomPointClass(input, existing: readonly MapPointClass[]): MapPointClass`

Exported function trimming `input.name`, rejecting empty names, deduplicating slugged IDs with numeric suffixes starting at `2`, uppercasing a 3-character alphanumeric `shortCode` defaulting to `"POI"`, and setting `builtIn: false`.

### apps/web/src/assets/milStd2525c.ts

Defines 5 operational symbol themes and 30 static MIL-STD-2525C monochrome tactical SVG definitions in [apps/web/src/assets/milStd2525c.ts](../apps/web/src/assets/milStd2525c.ts).

Module exports `MIL2525C_THEMES`, `MIL2525C_SYMBOLS`, and `MIL2525C_BY_ID`. Legacy geologic catalog [apps/web/src/assets/fgdcSymbols.ts](../apps/web/src/assets/fgdcSymbols.ts) stays retained as a data-only archive with no functions.

#### `resolveLegacyFgdcIcon(iconKey: string): Mil2525cSymbol["id"] | undefined`

Exported function mapping retired `"fgdc-*"` keys through `LEGACY_FGDC_TO_MIL2525C` to MIL-STD-2525C identifiers, returning `"mil2525c-sample"` for unrecognized `"fgdc-"` keys and `undefined` otherwise.

### apps/web/src/components/MapView.tsx

Renders the Leaflet EPSG:4326 Mars map, base tile layers, debounced terrain/weather PNG overlays, route polylines, hover marker, and interactive tactical points in [apps/web/src/components/MapView.tsx](../apps/web/src/components/MapView.tsx).

Module constants: `NICE_SCALE_METERS` spanning `50` m to `500_000` m, and `RASTER_PANE_NAME = "terrainRasterPane"`.

#### `buildPointIconHtml(point: MapPoint, cls: MapPointClass | undefined, selected: boolean): string`

Internal helper creating a DOM wrapper element containing the bordered pin, an SVG produced by `createPointIconSvgElement`, and safe `textContent` point name, returning `wrap.outerHTML` for `L.divIcon`.

#### `buildPointPopupElement(point: MapPoint, cls: MapPointClass | undefined, actions): HTMLElement`

Internal helper constructing an HTML element popup with class dot, `shortCode`, `textContent` labels, elevation readout, optional description, and action buttons for `SET A`, `SET B`, `EDIT`, and `DEL`.

#### `useDebouncedSiteOverlay(options)`

Internal custom React hook managing a `L.ImageOverlay` inside `terrainRasterPane`. Creates or removes the overlay immediately when visibility toggles and debounces subsequent URL or opacity changes by `options.debounceMs`.

#### `MapView(props: MapViewProps)`

Exported React component controlling the Leaflet map lifecycle:

1. Initializes `L.map` with `L.CRS.EPSG4326`, initial center `[18.46, 77.523]`, zoom `13`, `terrainRasterPane` at `zIndex: 250`, and layers for routes, waypoints, and points.
2. Computes true Martian geodesic scale bar width across a `120` px horizontal chord using `surfaceDistanceMeters`, selecting the largest step in `NICE_SCALE_METERS` fitting within `110` px.
3. Updates active EPSG:4326 `L.TileLayer`, fits `site.bbox` with left drawer padding `leftInsetPx + 40`, toggles site hillshade and bounding box, and debounces temperature `160` ms at `zIndex: 2`, pressure `160` ms at `zIndex: 3`, with `0.56` opacity when both are active or `0.74` alone, and slope hazard `150` ms at `zIndex: 4` with `0.78` opacity.
4. Draws non-selected routes translucent beneath the selected route casing and core stroke, renders `A` and `B` waypoints, and synchronizes point markers and popups.

### apps/web/src/components/RoutePlannerPanel.tsx

Displays route planning controls, waypoint cards, alternative route cards with sparklines, weather routing toggles, and the detailed elevation profile in [apps/web/src/components/RoutePlannerPanel.tsx](../apps/web/src/components/RoutePlannerPanel.tsx).

#### `StrategyGlyph({ strategy, color }: { strategy: RouteStrategy; color: string })`

Internal helper component returning the 14x14 SVG icon matching `"shortest"`, `"gentlest"`, `"alternate"`, or `"weather-safe"`.

#### `blockedReasonTag(reason?: RouteBlockedReason): string`

Internal helper converting blocked route reasons into short tags `"SLOPE"`, `"TEMP"`, `"PRESS"`, `"SLOPE + WXR"`, or `"BOUNDS"`.

#### `slopeToneColor(slopeDeg: number, maxSlopeDeg: number): string`

Internal helper returning CSS color tokens `"var(--color-accent)"` above `1.0x`, `"var(--color-warn)"` at or above `0.72x`, and `"var(--color-ok)"` below.

#### `RoutePlannerPanel(props: RoutePlannerPanelProps)`

Exported React component rendering `TraversePresetControl` (in `"basic"` mode) or `MaxSlopeControl` (in `"advance"` mode), weather-aware routing status and toggle button, waypoint `A`/`B` readouts with swap and clear actions, reachable or blocked route cards with `buildSparklineGeometry` previews, estimated traverse duration in the EVA strip, and `ElevationProfile` for the selected route.

### apps/web/src/components/routeVisuals.ts

Provides strategy visual presets, compact distance and coordinate formatters, and route card sparkline geometry in [apps/web/src/components/routeVisuals.ts](../apps/web/src/components/routeVisuals.ts).

Module constant: `ROUTE_STRATEGY_VISUALS` mapping `"shortest"`, `"gentlest"`, `"alternate"`, and `"weather-safe"` labels and colors.

#### `getRouteStrategyVisual(strategy: RouteStrategy): RouteStrategyVisual`

Exported function returning visual styling metadata for `strategy`.

#### `formatRouteDistance(meters: number): string`

Exported function formatting distances `>= 1000` m as kilometers with 2 decimals or rounded meters below `1000` m.

#### `formatShortCoord(coord: MarsCoord, fmt: LonFormat): string`

Exported function formatting `lat` and `lon` to 3 decimals, applying `lon180To360` when `fmt === "360"`.

#### `buildSparklineGeometry(route: ComputedRoute, width: number, height: number): SparklineGeometry | null`

Exported function downsampling `route.points` by stride around 44 points inside `2` px horizontal and `3` px vertical padding, locating the steepest `slopeDeg` sample, and returning SVG `linePath`, filled `areaPath`, and peak slope coordinates.

### apps/web/src/components/ElevationProfile.tsx

Renders an interactive SVG cross-section of route elevation, slope band, optional air temperature, and optional pressure curves in [apps/web/src/components/ElevationProfile.tsx](../apps/web/src/components/ElevationProfile.tsx).

Module constants: `W = 384`, `H = 148`, `PAD_L = 36`, `PAD_R = 10`, `PAD_T = 10`, `PAD_B = 22`, and `SLOPE_BAND_H = 6`.

#### `downsamplePoints(points: RoutePoint[], maxCount: number): RoutePoint[]`

Internal helper sampling at most `maxCount` evenly spaced points along `points` while retaining start and end nodes.

#### `findNearestByDistance(points: RoutePoint[], targetM: number): RoutePoint | null`

Internal helper running binary search over monotonically ordered `distanceM` values to locate the closest route sample to cursor distance `targetM`.

#### `slopeBandColor(slopeDeg: number, maxSlopeDeg: number): string`

Internal helper mapping `slopeDeg / maxSlopeDeg` to `#de233d` when `> 1`, `#eab308` when `>= 0.72`, and `#3fb68b` otherwise.

#### `ElevationProfile(props: ElevationProfileProps)`

Exported React component normalizing up to `96` sampled route points with 10% elevation padding and 14% temperature and pressure padding, drawing slope hazard bands, rendering layer filter toggles when thermal or barometric channels exist, and reporting `onHoverPoint` updates on pointer move.

### apps/web/src/components/MaxSlopeControl.tsx

Provides a coupled slider and numeric input controlling maximum traversable slope in [apps/web/src/components/MaxSlopeControl.tsx](../apps/web/src/components/MaxSlopeControl.tsx).

Module constants: `MIN_SLOPE = 1`, `MAX_SLOPE = 45`.

#### `MaxSlopeControl({ valueDeg, onChange }: MaxSlopeControlProps)`

Exported React component rendering the `1..45` degree gradient range slider and a `0.5`-stepped number box clamped to `[0.5, 60]` degrees via internal handlers `handleRange` and `handleNumber`.

### apps/web/src/components/PointsPanel.tsx

Manages tactical point creation, editing, class visibility toggling, custom class creation, search, and waypoint promotion in [apps/web/src/components/PointsPanel.tsx](../apps/web/src/components/PointsPanel.tsx).

#### `formatCoord(coord: MarsCoord, fmt: LonFormat): string`

Internal helper formatting coordinates to 4 decimal places using `[-180, 180)` or `lon180To360` `[0, 360)`.

#### `PointsPanel(props: PointsPanelProps)`

Exported React component maintaining local draft state synchronized with `editingPoint` and `pendingCoord`, computing point counts per class, filtering points across name, description, and class name, hiding creation/edit/delete forms and class creation when `readOnly` is true, rendering `ThemedIconPicker` in editable mode, and exposing class visibility toggles, focus, and waypoint `A`/`B` actions.

### apps/web/src/components/PointClassIcon.tsx

Parses and renders monochrome MIL-STD-2525C SVG primitives safely without `innerHTML` or `dangerouslySetInnerHTML` in [apps/web/src/components/PointClassIcon.tsx](../apps/web/src/components/PointClassIcon.tsx).

Module constants: `DEFAULT_TRP_MARKUP`, `CORE_TO_MIL2525C_ID`, `CORE_ICON_MARKUP`, `SVG_ATTR_TO_REACT`, and `ICON_SPEC_CACHE`.

#### `resolvePointSymbolMeta(icon: PointIconKey): Mil2525cSymbol | undefined`

Exported function resolving any `mil2525c-*` key, core alias through `CORE_TO_MIL2525C_ID`, or retired `"fgdc-*"` key through `resolveLegacyFgdcIcon`, falling back to `CORE_TO_MIL2525C_ID.marker`.

#### `parseAttrs(raw: string): Record<string, string>`

Internal helper extracting `name="value"` attributes from static SVG tag markup.

#### `parseStaticSvgNodes(markup: string): ParsedSvgNode[]`

Internal helper parsing flat self-closing SVG shapes and `<g>...</g>` groups recursively into `ParsedSvgNode` trees.

#### `getIconSpec(icon: PointIconKey): { viewBox: string; nodes: ParsedSvgNode[] }`

Internal helper caching parsed `24x24` `ParsedSvgNode` trees in `ICON_SPEC_CACHE` keyed by icon string.

#### `appendDomSvgNodes(ns: string, parent: Element, nodes: ParsedSvgNode[]): void`

Internal helper creating namespaced SVG DOM nodes recursively for Leaflet HTML markers.

#### `renderReactSvgNodes(nodes: ParsedSvgNode[], prefix: string): ReactNode[]`

Internal helper mapping kebab-case SVG attributes via `SVG_ATTR_TO_REACT` and building React elements recursively.

#### `createPointIconSvgElement(icon: PointIconKey, color: string, size = 14): SVGSVGElement`

Exported function constructing a detached `SVGSVGElement` for direct DOM insertion in `MapView.tsx` `buildPointIconHtml`.

#### `PointClassIcon({ icon, color = "currentColor", size = 14, className }: PointClassIconProps)`

Exported React component rendering cached static symbol nodes inside an `aria-hidden="true"` `<svg>`.

### apps/web/src/components/ThemedIconPicker.tsx

Renders a collapsible 5-tab MIL-STD-2525C symbol picker grouped by operational theme in [apps/web/src/components/ThemedIconPicker.tsx](../apps/web/src/components/ThemedIconPicker.tsx).

#### `resolveSymbolId(icon: PointIconKey | undefined): Mil2525cSymbol["id"] | undefined`

Internal helper mapping direct `mil2525c-*` or core point icon keys to canonical `Mil2525cSymbol["id"]` strings.

#### `formatSelectedLabel(value: PointIconKey | undefined, resolvedMeta: Mil2525cSymbol | undefined, inheritLabel?: string): string`

Internal helper formatting the current symbol summary badge when inheriting a class default or overriding per point.

#### `ThemedIconPicker(props: ThemedIconPickerProps)`

Exported React component syncing the active theme tab when `value` changes, filtering `MIL2525C_SYMBOLS` to the selected `Mil2525cThemeId`, and showing theme tabs plus compact symbol preview buttons.

### apps/web/src/components/TraversePresetControl.tsx

Renders the `HUMAN` and `ROVER` mission preset cards for `"basic"` mode in [apps/web/src/components/TraversePresetControl.tsx](../apps/web/src/components/TraversePresetControl.tsx).

#### `PresetGlyph({ presetId, active }: { presetId: TraversePresetId; active: boolean })`

Internal helper component returning a monochrome inline SVG silhouette for `"human"` or `"rover"`.

#### `TraversePresetControl({ presetId, onSelectPreset, compact }: TraversePresetControlProps)`

Exported React component rendering `TRAVERSE_PRESETS` selector buttons (`HUMAN` 7° / 2.5 km/h / 4h vs `ROVER` 15° / 5.0 km/h / 8h) and, when `compact` is false, a summary bar of preset environmental limits.

### apps/web/src/components/WeatherPanel.tsx

Displays mission presets (in `"basic"` mode) or suit limit and traverse speed sliders (in `"advance"` mode), scenario tabs, 24-hour temperature and wind SVG plot, 48-hour traverse integration, and EVA status verdict in [apps/web/src/components/WeatherPanel.tsx](../apps/web/src/components/WeatherPanel.tsx).

Module constants: `THRESHOLD_SLIDERS` defining 5 EVA suit limits, `SPEED_SLIDERS` defining `flatSpeedMPerH`, `climbSpeedMPerH`, and `descentSpeedMPerH`, and `SCENARIO_OPTIONS` covering `"auto"`, `"nominal"`, `"dust-storm"`, and `"cold-snap"`. Re-exports `evaStatusClass` from `TimeSimulationControl.tsx`.

#### `kelvinToC(kelvin: number): number`

Internal helper returning `kelvin - 273.15`.

#### `clampSpec(spec: LimitSliderSpec, raw: number): number`

Internal helper guarding against non-finite inputs and clamping values within `[spec.min, spec.max]`.

#### `ParameterSliderRow(props)`

Internal helper component rendering a bound range slider, numeric input box, check status tag, and caption footer for suit limits and traverse speeds.

#### `WeatherPanel(props: WeatherPanelProps)`

Exported React component indexing evaluation checks by `WeatherCheckId`, computing the `384x92` 24-hour temperature and wind SVG curves with `06:00..18:00` daylight shading and active hour cursor, rendering `TimeSimulationControl` and `TraverseWindowsPanel`, and rendering either `TraversePresetControl` (`uiMode === "basic"`) or `THRESHOLD_SLIDERS` and `SPEED_SLIDERS` (`uiMode === "advance"`).

### apps/web/src/components/TimeSimulationControl.tsx

Provides 48-hour LMST simulation scrubbing, play/pause controls, quick time jumps, and elevation weather helpers in [apps/web/src/components/TimeSimulationControl.tsx](../apps/web/src/components/TimeSimulationControl.tsx).

Module constants: `MARS_SCALE_HEIGHT_M = 10_800`, `MARS_LAPSE_RATE_K_PER_M = -0.0025`, `QUICK_JUMP_HOURS = [7, 12, 15, 22]`.

#### `evaStatusClass(status: EvaStatus): string`

Exported function returning `"is-go"`, `"is-degraded"`, or `"is-nogo"` CSS class names.

#### `clampSimLmstHour(rawHour: number): number`

Exported function defaulting non-finite hours to `12`, clamping finite inputs to `[0, 47.5]`, and snapping to `0.5`-hour steps.

#### `formatLmstClock(offsetHours: number): string`

Exported function wrapping `offsetHours` mod `24` and formatting zero-padded `HH:MM`, handling 60-minute rounding rollover.

#### `resolveSolDisplay(baseSol: number | null | undefined, offsetHours: number): { solOffset: 0 | 1; solNumber: number | null; label: string }`

Exported function resolving sol offset `0` or `1` across the 24-hour boundary and formatting `"SOL <n>"` or `"SOL +0"` / `"SOL +1"`.

#### `resolveHourIsDaylight(offsetHours: number, weather: MarsWeatherSnapshot | null, evaluation: EvaWeatherEvaluation | null): boolean`

Exported function checking matching `evaluation.selectedHourWeather` within `0.25` h, then the nearest `hourly` or `nextSol.hourly` entry, and falling back to `[6, 18)`.

#### `estimateLocalWeatherAtElevation(elevationM: number, offsetHours: number, weather: MarsWeatherSnapshot | null): { pressurePa: number; tempC: number } | null`

Exported function linearly interpolating `weather.hourly` and `weather.nextSol.hourly` across `offsetHours` clamped to `[0, 47.999]`, scaling pressure by `Math.exp(-deltaElevM / 10_800)` and air temperature by `-0.0025 * deltaElevM`. Called by `App.tsx` for cursor telemetry.

#### `TimeSimulationControl(props: TimeSimulationControlProps)`

Exported React component rendering full or compact floating simulation cards with play/pause button, `0..47.5` slider, sol/daylight indicator, and quick jumps at `07:00`, `12:00`, `15:00`, and `22:00`.

### apps/web/src/components/TraverseWindowsPanel.tsx

Visualizes the 48-hour departure slot timeline and top ranked EVA departure recommendations in [apps/web/src/components/TraverseWindowsPanel.tsx](../apps/web/src/components/TraverseWindowsPanel.tsx).

#### `normalizeScore(score: number, maxScore: number): number`

Internal helper converting unit `[0, 1]` scores to percentages or clamping integer scores into `[0, 100]`.

#### `findClosestSlot(slots: TraverseDepartureSlot[], activeLmstHour: number): TraverseDepartureSlot | null`

Internal helper selecting the `TraverseDepartureSlot` whose `offsetHours` minimizes distance to `activeLmstHour`.

#### `TraverseWindowsPanel(props: TraverseWindowsPanelProps)`

Exported React component rendering interactive slot bars height-scaled to `score` with a 48-hour timeline cursor, selected slot telemetry readout, and up to 4 `recommendedWindows` cards with span bars and departure jump triggers.

### apps/web/src/components/ContextMenu.tsx

Renders the right-click map context menu for waypoints and point creation in [apps/web/src/components/ContextMenu.tsx](../apps/web/src/components/ContextMenu.tsx).

#### `ContextMenu(props: ContextMenuProps)`

Exported React component clamping screen placement inside `window.innerWidth - 230` and `window.innerHeight - 190`, displaying clicked coordinates to 5 decimal places, and wiring `Set A Waypoint`, `Set B Waypoint`, optional `Add Classified Point` (hidden when `canAddPoint` is false in `"basic"` mode), and optional `Clear Waypoints`.


---

## scripts

### scripts/dev.ts

Launches both `@nimbs/api` with `--hot` reload and the `@nimbs/web` Vite development server under one supervisor process in [scripts/dev.ts](../scripts/dev.ts).

#### `shutdown(): void`

Internal helper terminating `apiProc` and `webProc` cleanly and exiting with status `0`. Registered on `SIGINT`, `SIGTERM`, and after `Promise.race([apiProc.exited, webProc.exited])`.

### scripts/data/fetch-site.ts

Streams USGS MRO CTX Cloud-Optimized GeoTIFF DTMs and hillshade rasters to produce `data/site-terrain.json` and `data/site-hillshade.png` in [scripts/data/fetch-site.ts](../scripts/data/fetch-site.ts).

Module constants: `PRESETS` for `"jezero"` and `"mount-sharp"`, `DEFAULT_SITE_SIZE_KM = 20`, `DEFAULT_CELL_SIZE_M = 20`, and `DEFAULT_HILLSHADE_SIZE = 1000`.

#### `parseCliArg(prefix: string): string | undefined`

Internal helper extracting `--flag=value` CLI arguments from `process.argv`.

#### `pickOverviewImage(tiff: GeoTIFF, targetResM: number): Promise<{ img: GeoTIFFImage; index: number; resM: number }>`

Internal async helper selecting the coarsest COG overview whose ground resolution `baseRes * (baseWidth / img.getWidth())` stays at or below `targetResM`.

#### `clampWindowToBbox(cx: number, cy: number, widthProjM: number, heightProjM: number, bbox: [number, number, number, number]): [number, number, number, number]`

Internal helper clamping a projected ground window `[minX, minY, maxX, maxY]` inside the raster extent.

#### `projBoxToPixelWindow(projWin: [number, number, number, number], imgBbox: [number, number, number, number], imgW: number, imgH: number): [number, number, number, number]`

Internal helper mapping equirectangular meters into integer pixel window bounds `[pxLeft, pxTop, pxRight, pxBottom]` guaranteed at least 1x1 pixels.

#### `resampleElevGrid(src, srcW, srcH, pxWin, projWin, imgBbox, fullW, fullH, outCols, outRows, nodataValue): { grid: Float32Array; validCount: number }`

Internal helper performing nodata-aware bilinear resampling of a source raster slice into a north-up `outRows x outCols` `Float32Array`, renormalizing weights over finite samples above `nodataValue + 10` and writing `nodataValue` when no corners are valid.

#### `fillIsolatedNodata(grid: Float32Array, rows: number, cols: number, nodataValue: number): number`

Internal helper running up to 3 inverse-distance-weighted interpolation passes across a `9x9` neighborhood (`dr, dc` in `-4..4`) to patch small nodata gaps.

#### `computeDemHillshadeByte(grid: Float32Array, rows: number, cols: number, r: number, c: number, cellSizeM: number, nodataValue: number): number`

Internal helper evaluating Horn 3x3 slope/aspect gradients illuminated from `315` degrees azimuth and `38` degrees altitude, clamping grayscale relief output to `20..245` or returning `0` for nodata.

#### `buildHillshadeRgba(...args): Uint8Array`

Internal helper scanning a raster sample stride to detect float normalized reflectance (`p98 <= 2.5`) vs `0..255` byte shading, blending `0.8 * mapped + 0.2 * demShade`, falling back to `computeDemHillshadeByte`, and writing warm Mars-tinted RGBA bytes `[0.94, 0.86, 0.78]` at alpha `255`.

#### `main(): Promise<void>`

Internal entrypoint orchestrating remote ingestion:

1. Parses `--site=`, `--size-km=`, and `--grid=`, opens the preset `dtmUrl` via `geotiff` `fromUrl`, and scales east-west projection width by `1 / cos(lat)`.
2. Probes 6 candidate offsets on a `180` m/px overview, prioritizing `>= 99%` valid coverage and breaking ties by elevation relief.
3. Resamples the chosen extent near `cellSizeM * 0.95`, calls `fillIsolatedNodata`, derives `bbox`, `center`, `widthMeters`, and `heightMeters` with `equirectangularToCoord` and `surfaceDistanceMeters`, and computes min/max elevation.
4. Streams `hillshadeUrl`, encodes `1000x1000` `data/site-hillshade.png` via `encodeRgbaPng`, and writes `data/site-terrain.json`.

### scripts/data/fetch-weather.ts

Probes NASA RSS telemetry feeds and PDS4/PDS3 weather archives using HTTP Range slicing and persists `data/site-weather.json` in [scripts/data/fetch-weather.ts](../scripts/data/fetch-weather.ts).

Module constants: `INSIGHT_API_URL`, `MEDA_PDS4_DERIVED_ROOT`, `MEDA_PDS4_CALIBRATED_ROOT`, and `REMS_PDS3_ROOT`.

#### `parseArg(prefix: string): string | undefined`

Internal helper extracting `--key=value` options from `process.argv`.

#### `hasFlag(flag: string): boolean`

Internal helper checking boolean flags in `process.argv`.

#### `fetchWithTimeout(url: string, timeoutMs: number, init: RequestInit = {}): Promise<Response>`

Internal async helper wrapping `fetch` with `AbortSignal.timeout(timeoutMs)`.

#### `extractDirHrefs(html: string, pattern: RegExp): string[]`

Internal helper extracting unique directory or file `href` matches from Apache PDS index HTML and sorting lexicographically.

#### `fetchRangeSamples(url: string, timeoutMs: number, sliceCount = 12, sliceBytes = 12_288): Promise<string[]>`

Internal async helper sampling `sliceCount` evenly spaced byte ranges across large CSV or TAB telemetry products in batches of `4`, falling back to full `GET` when `content-length` is small or missing and discarding truncated boundary lines.

#### `probeMedaPds4(timeoutMs: number): Promise<{ probe: ProbeResult; record: PersistedSiteWeatherRecord | null }>`

Internal async helper walking the latest PDS4 MEDA `sol_<range>/sol_<n>` directories, reading `Ls` from the first `4096` bytes of `DER_ANCILLARY`, sampling `DER_PS` column `3` for pressure in `(100, 2000)` Pa and `CAL_ATS` columns `3..7` for air temperature in `(100, 350)` K, and returning a `"jezero"` `PersistedSiteWeatherRecord`.

#### `probeRemsPds3(timeoutMs: number): Promise<{ probe: ProbeResult; record: PersistedSiteWeatherRecord | null }>`

Internal async helper walking the latest PDS3 MSL REMS `SOL_<range>/SOL<n>` directory, extracting `START_TIME` from `.LBL`, sampling `RMD*.TAB` column `15` for temperature in `(100, 350)` K and column `37` for pressure in `(200, 2000)` Pa, and returning a `"gale"` record.

#### `probeJsonEndpoint(id: string, url: string, timeoutMs: number): Promise<{ probe: ProbeResult; json: unknown | null }>`

Internal async helper measuring response latency and capturing JSON payloads from NASA RSS and InSight endpoints.

#### `pickNewerRecord(a: PersistedSiteWeatherRecord | null | undefined, b: PersistedSiteWeatherRecord | null | undefined): PersistedSiteWeatherRecord | undefined`

Internal helper returning the record with higher `sol`, preferring `a` on ties.

#### `main(): Promise<void>`

Internal entrypoint running parallel probes, checking `--probe-only`, merging live and PDS records against any existing `data/site-weather.json` via `pickNewerRecord`, and writing updated `data/site-weather.json`.

### scripts/assets/extract-fgdc-symbols.ts

Compiles QGIS CC0 FGDC XML recipes and SVG assets into normalized 24x24 paths written to the retired archive `apps/web/src/assets/fgdcSymbols.ts` in [scripts/assets/extract-fgdc-symbols.ts](../scripts/assets/extract-fgdc-symbols.ts).

Module constants: `DEFAULT_SOURCE_ROOT = "/tmp/geologic-symbols-qgis"`, `OUTPUT_PATH`, `THEMES`, and `SYMBOL_SPECS` listing 31 legacy geologic definitions.

#### `resolveSourceRoot(): string`

Internal helper returning `--src=` path or `DEFAULT_SOURCE_ROOT`.

#### `round(value: number): string`

Internal helper formatting numbers rounded to 2 decimal places as compact strings.

#### `parseProps(block: string): Record<string, string>`

Internal helper parsing `<prop k="..." v="..."/>` entries from QGIS XML blocks.

#### `parsePair(raw: string | undefined): [number, number]`

Internal helper parsing `"x,y"` coordinate pairs defaulting non-finite values to `0`.

#### `parseRgbaAlpha(raw: string | undefined): { isWhite: boolean; alpha: number }`

Internal helper parsing RGBA tuples to distinguish white mask fills (`r,g,b >= 230`) from solid foreground marks.

#### `extractXmlDescription(xmlText: string, fallback: string): string`

Internal helper reading normalized symbol `name` attributes from XML `<symbol>` tags.

#### `parseTopLevelMarkerLayers(xmlText: string): MarkerLayer[]`

Internal helper extracting `SimpleMarker` and `EllipseMarker` offsets, dimensions, angles, fill masks, and outline widths from QGIS XML.

#### `rotatePoint(x: number, y: number, angleDeg: number): [number, number]`

Internal helper rotating 2D coordinates clockwise by `angleDeg` around the origin.

#### `compileXmlMarkersSvg(spec: SymbolSpec, xmlText: string): string`

Internal helper handling custom sample/crater presets or centering and scaling `MarkerLayer[]` primitives inside `24x24` `currentColor` SVG markup.

#### `parsePointsList(raw: string): Array<[number, number]>`

Internal helper splitting space- or comma-delimited coordinate strings into `[x, y]` pairs.

#### `pointsToNormalizedSvg(shapes): string`

Internal helper bounding all polyline, polygon, and line shapes, uniformly scaling across a 15-unit span centered at `(12, 12)`, and emitting normalized SVG tags.

#### `compileSvgFileSymbol(spec: SymbolSpec, rawSvg: string): string`

Internal helper normalizing source `<path>`, `<polyline>`, `<polygon>`, and `<line>` elements from QGIS FGDC `.svg` files into `24x24` markup.

#### `compileCartographicLineBadge(spec: SymbolSpec): string`

Internal helper returning clean 24x24 vector geometry for cartographic line presets such as `"strike-dip"`, `"fault"`, `"thrust-fault"`, `"crater-rim"`, and `"landslide"`.

#### `main(): void`

Internal entrypoint verifying source license and directories, compiling all 31 entries in `SYMBOL_SPECS`, and generating `apps/web/src/assets/fgdcSymbols.ts`.