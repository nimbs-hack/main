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

The build writes the frontend to `dist/` and the Go binary to `bin/mars-api`. Run the binary from the repository root. It serves both on port 3000. `PORT` changes the port; `-addr`, `-cache-dir` and `-static-dir` override the listen address and directories. A deployed binary needs `dist/` alongside it and a writable cache directory. It needs neither Bun nor Go installed.

`bun run start` builds and runs the API through Go for local use.

## Checks

```sh
bun run typecheck
bun run lint
bun run test
```

Typecheck compiles the Go packages. Lint runs `go vet` and checks `gofmt`. Tests cover the frontend and run Go's race detector on the API. The frontend has no configured typecheck or JavaScript linter.

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
