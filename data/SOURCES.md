# Data sources

## CTX global mosaic V01

- Mission and instrument: Mars Reconnaissance Orbiter, Context Camera. Mosaic by Caltech's Murray Lab.
- Source: https://murray-lab.caltech.edu/CTX/
- Hosted catalog: https://www.arcgis.com/home/item.html?id=30c4acfe36284b1784bf07d5d73f9e4d
- Tile service: https://astro.arcgis.com/arcgis/rest/services/OnMars/CTX1/MapServer
- Resolution: 5 m/pixel source imagery, grayscale. Coverage is 99.5% between 88°S and 88°N. The app caps requests at level 12, about 5.1 m/pixel north-south, using 512 px tiles.
- Coordinates: planetocentric latitude, east longitude normalized to -180..180, Mars sphere radius 3,396,190 m. Tile origin is -180°, 90°, with two columns and one row at level 0; row numbers increase southward.
- Terms: Murray Lab grants free use of V01 for all purposes with credit to NASA/JPL/MSSS/The Murray Lab. Esri-hosted services have separate Esri terms linked in the catalog entry. The service disables bulk tile export.
- Metadata caveat: the catalog identifies V01, but the service description still calls the mosaic beta01/uncontrolled. Preserve that distinction when tracing scientific measurements. This app uses it for visual context.
- Fetch/cache implementation: `apps/api/internal/tiles/ctx.go` and `apps/api/internal/tiles/cache.go`. Requests go through `/api/imagery/ctx-v01/{z}/{y}/{x}.png`, with a 20-second upstream timeout and duplicate-request coalescing. Despite the service's PNG metadata and the route suffix, upstream tiles can be PNG or JPEG. Go checks image dimensions and decodes every pixel before accepting a download or reading an existing disk entry. Header checks alone missed truncated PNGs. Native tiles preserve the original bytes and correct MIME type, with no recompression. Tiles persist under `data/cache/ctx-v01/`, capped at 2,048 tiles of at most 1 MiB each. A 32 MiB memory cache serves recent requests. Disk writes run separately from response delivery. Browser caching retains tiles across visits; the `cache=4` query bypasses responses from before the level-10 repair below. Delete this directory and restart the API to refresh the server cache.
- Verification on 2026-11-14: V01 tiles `12/1792/1719` and `11/896/859` returned HTTP 200 with truncated PNG data. Both the browser decoder and Sharp rejected them. The older CTX service supplied a valid level-12 tile at the first location.

The V01 service also returns decodable but misplaced images at level 10. At 16.733°N, 308.797°E, tile `10/416/732` disagreed with its level-9 parent and level-11/12 descendants. Direct upstream bytes matched the local cache, ruling out local cache contamination. The proxy builds each V01 level-10 tile by averaging 2-by-2 pixel blocks and compositing its four validated level-11 children, then caches it as `10-rebuilt-1-{y}-{x}.png`. Old native level-10 files are never used. Previously rebuilt tiles remain usable, though the Go averaging filter can produce slightly different pixels from Sharp when rebuilding them. A cold request needs up to four upstream downloads; these children are reused when zooming further. A failed child fails the parent, allowing the existing whole-layer fallback. This repair does not mix mosaics or change native-resolution imagery. The older beta01 pyramid remains unchanged.

The Go proxy also rebuilds a truncated intermediate tile from its four children in the same mosaic when all four decode successfully. It tries only the next finer level and never requests beyond level 12. Broken children and failures at native resolution still return an error; the proxy does not substitute blank images or mix sources. On 2026-11-14, beta01 tile `11/812/2926` returned a truncated PNG, while its four level-12 children were complete. Repaired tiles and their children use the normal disk cache.

### CTX beta01 fallback

- Source/service: https://astro.arcgis.com/arcgis/rest/services/OnMars/CTX/MapServer. This older Murray Lab CTX mosaic uses the same 512 px geographic grid, Mars radius and approximately 5 m/pixel level 12. It is not V01; its registration and brightness differ.
- Mission/instrument and credit: MRO/CTX, NASA/JPL/MSSS/The Murray Lab, hosted by Esri. Retain attribution and consult the service's linked terms for reuse.
- Fetch/cache implementation: the same proxy with `source=beta01`, separate from the default `source=v01`. Backup tiles use `data/cache/ctx-v01/beta01/`, capped at 512 entries, with a separate 32 MiB memory cache.
- On a V01 tile failure, the client replaces the entire imagery layer with beta01. Switching individual tiles created visible joins between mosaics. The selection persists for the browser tab's session and appears in the footer. Failed backup tiles use Cesium's coarser imagery fallback and report a loading error.
- Verification: the screenshot location at 11.250°N, 255.552°E rendered level-12 beta01 imagery. Backup tile `11/812/2926` also returned a truncated image, so this service is not a complete repair for the upstream data. A warm-up run over three landing sites validated 990 of 1,018 imagery and terrain requests; 28 imagery requests failed validation.

The Vite dev and preview servers start a private Go API process and proxy requests to it. For a standalone build, run `bun run build` then `bun run start` from the repository root. A static-only host must route `/api/imagery/ctx-v01/*` and `/api/terrain/mars-v14/*` to the API; copying `dist/` alone does not provide the tile proxy.

Viking stays below CTX and at the poles. CTX starts at terrain level 6. Missing imagery can fall back to Viking; CTX does not add elevation detail.

## Mars Trek terrain

- Dataset: Mars Trek `mars_v14`, version 2.0, a blend of MOLA, HRSC and local high-resolution elevation data.
- Missions/instruments: Mars Global Surveyor/MOLA, Mars Express/HRSC, and local stereo products including Mars Reconnaissance Orbiter/HiRISE.
- Metadata: https://marshub.s3.amazonaws.com/mars_v14/layer.json
- Resolution: variable by location and level. The metadata advertises availability through level 17. Tile level is not a uniform ground sampling distance.
- Coordinates: planetocentric latitude, east longitude normalized to -180..180, sphere radius 3,396,190 m. Tile rows are TMS, increasing northward. The terrain heights use Trek's shifted vertical reference; the app subtracts 8,201 m for elevation readouts.
- Terms/credit: NASA / JPL-Caltech Mars Trek. The S3 metadata does not include a separate license statement; retain attribution and consult the source providers for underlying products.
- Fetch/cache implementation: `apps/api/internal/tiles/terrain.go`. Original mesh bytes are cached under `data/cache/mars-v14-v2/`, capped at 8,192 tiles of at most 2 MiB each, plus a 16 MiB memory cache. Metadata is pinned to version 2.0 and served with local relative tile paths. Clear the directory and restart the API to refresh it.
- Data limitation: the source blends elevation models with visible offsets. Caching preserves those source bytes and does not repair vertical registration. The existing client seam-smoothing heuristic is unchanged and should not be used as a corrected scientific elevation product.

## Camera and loading

During camera movement, the globe temporarily uses a larger screen-space error tolerance to avoid loading fine tiles at every intermediate position. It returns to the original full-detail tolerance 150 ms after movement ends. Site framing uses loaded terrain, or an approximate datum height, so flights start without waiting for remote elevation sampling. That approximation changes only camera framing, not elevation readouts or terrain.

The camera's minimum clearance depends on viewport height and field of view, allowing up to two screen pixels per CTX source pixel in a top-down view. This prevents extreme magnification of 5 m imagery at roughly 100 m altitude. Wheel, pinch, button, double-click and tilt controls share the limit. Ground-level detail requires a finer imagery source.
