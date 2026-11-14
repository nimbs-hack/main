# Mars console

An interactive Mars globe built with React and Cesium, with a Go API for CTX imagery and terrain tiles.

## Run it

Install Bun and Go 1.24 or newer, then run:

```sh
bun install
bun run dev
```

Open http://localhost:5173. Vite builds and starts the Go API on a private local port, proxies `/api` requests to it, and stops it when Vite closes. `bun run preview` uses the same API after a build.

```sh
bun run build
./bin/mars-api
```

The build writes the frontend to `dist/` and the Go binary to `bin/mars-api`. Run the binary from the repository root. It serves both on port 3000. `PORT` changes the port; `-addr`, `-cache-dir`, `-data-dir` and `-static-dir` override the listen address and directories. A deployed binary needs `dist/` alongside it and a writable cache directory. It needs neither Bun nor Go installed.

`bun run start` builds and runs the API through Go for local use.

## Checks

```sh
bun run typecheck
bun run lint
bun run test
```

Typecheck compiles the Go packages and checks the planner TypeScript contract in strict mode. Lint runs `go vet` and checks `gofmt`. Tests cover the frontend and run Go's race detector on the API. The legacy JavaScript frontend has no JavaScript linter.

## Map data and caching

- Viking Orbiter global color imagery, with low zoom levels in `public/tiles`.
- CTX V01 imagery with an explicit beta01 fallback selected by the viewer.
- Mars v14 quantized-mesh terrain, with availability and TMS row order preserved.
- Nine NASA landing sites and saved Curiosity and Perseverance traverses.

The Go API serves imagery at `/api/imagery/ctx-v01` and terrain at `/api/terrain/mars-v14`. It validates coordinates and upstream responses, coalesces duplicate downloads, and caches tiles in memory and under `data/cache`. Existing `ctx-v01` and `mars-v14-v2` disk caches remain usable. Shutdown drains pending disk writes.

CTX V01 level 10 is rebuilt from four level-11 children because the upstream level has misplaced tiles. Other truncated intermediate tiles are rebuilt from four valid children in the same mosaic, with one repair attempt and no requests beyond level 12. Go averages each 2-by-2 pixel block when reducing the children. Previously cached rebuilt tiles remain valid; newly rebuilt tiles may differ slightly from the old Sharp resize filter.

`bun run tiles` downloads missing low-zoom Viking tiles. `bun run precache` starts a temporary Go API and warms landing-site imagery and terrain with six concurrent requests. Add site IDs to limit it, or `--backup` for CTX beta01:

```sh
bun run precache curiosity perseverance
bun run precache --backup pathfinder
```

## Sources

Imagery comes from [NASA/JPL Mars Trek](https://trek.nasa.gov/mars/) and the CTX services listed in `data/SOURCES.md`. Rover traverses are saved in `src/data/traverses`. See `data/SOURCES.md` for dataset details.

## Route planning on the globe

The planner uses the existing Cesium 2D/3D controls, CTX imagery, Mars Trek terrain,
science layers, elevation profile, and suit view. Routing and weather calculations
run in Go. There is no separate Leaflet UI, Hono server, or Bun runtime in production.

```sh
bun run fetch-site        # Download the Jezero planning DEM using COG byte ranges
bun run dev
```

Open the planner, focus the outlined DEM area, and set A and B by map click or
coordinates. Changing the slope or weather constraints recalculates alternatives.
Select a route to inspect its DEM profile or follow it in suit view. The science
layers and rover traverses remain available when the planner is closed.

The planner has four tools:

- Route: A/B map or coordinate entry, ordered stops, round trip, walk time
  against the EVA limit, alternative corridors, slope limits, and
  elevation, slope, temperature, and pressure profiles. Right-click the map to
  set a waypoint or save a point.
- Weather: two-sol playback, hourly charts, temperature, wind, pressure, pressure
  swing, and duration limits, plus departure evaluations and ranked windows.
  EVA duration is configurable from 0.5 to 12 Earth hours.
- Points: saved coordinates, notes, editable classes and colors, class visibility,
  map focus, and A/B shortcuts. Points persist in this browser's local storage.
- Layers: independently toggle DEM hillshade, slope hazards, and modeled
  temperature/pressure fields, with opacity and boundary controls.

Weather profile values describe departure conditions. Departure-window checks
sample conditions over the walk; these are separate from the spatial filter.

The Go API loads `data/site-terrain.json` lazily. Missing data produces a visible
setup error. The `-data-dir` flag selects another dataset directory. The full DEM
stays on the server; the browser receives route points, metadata, and PNG overlays.

Planning uses the original CTX DEM, not the smoothed Mars Trek display mesh.
Coordinates are planetocentric with east-positive longitude in [-180, 180).
Native calculations use meters, kelvin, and pascals; the API retains Celsius
threshold inputs for compatibility and converts them at its boundary.

Weather in this planner is explicitly simulated, including the two-sol timeline.
Existing rover observations remain separately labeled in the science panel. Slope,
temperature, and pressure limits are planning assumptions, not suit certifications.
Routes can pass through up to eight ordered stops between A and B. With round
trip on (the default), the return retraces the outbound path, so walk time and
the EVA duration check cover the whole excursion. Consumables are not modeled. Radiation, space weather, individual rocks, and suit mobility are not
routing constraints. Route filtering uses departure-time weather; the separate
EVA evaluator samples changing weather during the walk. Daylight and Mars dates
remain approximate as in the reviewed prototype.

`apps/api/internal/planner/testdata` contains differential fixtures from the
reviewed TypeScript algorithm. The Go port also tests the million-cell Jezero DEM
when `data/site-terrain.json` is present. Equal-cost alternate corridors can differ.

The only new ingestion dependency is `geotiff`, used offline by `fetch-site`.
TypeScript is a development dependency for checking the shared planner contract.
