# Mars console

An interactive map of Mars built with React and Leaflet, using imagery from NASA's Mars Trek portal.

## Run it

```bash
bun install
bun run dev
```

Then open http://localhost:5173. `bun run build` writes a static site to `dist/`.

## What is on the map

- The Viking Orbiter global color mosaic. Drag to pan, scroll to zoom.
- Nine NASA landing sites. Click a marker to fly there, or open the list with the arrow tab on the left edge.
- The routes Curiosity and Perseverance have driven, with each rover's latest position.

## Map tiles

Zoom levels 0 to 3 are stored in `public/tiles` (170 files, 9 MB), because the NASA tile server takes about a second per tile. Deeper zoom levels load from trek.nasa.gov and the browser caches them.

`bun run tiles` downloads any tiles that are missing.

## Data

- Imagery: [NASA/JPL Mars Trek](https://trek.nasa.gov/mars/), mosaic by USGS Astrogeology.
- Rover routes: the traverse feeds behind the rover location maps on mars.nasa.gov, thinned to one point every 12 m or so and saved in `src/data/traverses`. They were fetched on 2026-11-14 and do not update on their own.

## Separate route planner

The `alghorims` planner lives in `apps/web`, with its Bun/Hono API in `apps/api`.
The console above remains the default app.

```bash
bun run fetch-site       # Download a Jezero DEM crop into gitignored data/
bun run dev:planner      # Planner at http://localhost:5174, API at port 3002
bun run build:planner    # Planner static files in apps/web/dist/
```

Set `API_PORT` to override the planner API port. Its Vite proxy uses the same value.
The planner needs the API running and `data/site-terrain.json` for terrain routing.
The static build alone does not serve the API.

The planner compares slope-limited routes and simulated weather conditions.
Weather constraints use a departure-time snapshot, not weather along the walk over time.
Missing DEM nodes remain blocked. A 20 m grid cannot resolve individual rocks or
establish astronaut safety, and weather estimates are not operational forecasts.

```bash
bun run typecheck
bun run lint
bun run test
```

See [Algorithms and architecture](docs/algorithms-and-architecture.md) for the model and endpoints.
