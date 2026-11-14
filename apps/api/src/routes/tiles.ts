import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Hono } from "hono";

const TILE_CACHE_DIR = resolve(import.meta.dir, "../../../../data/cache/tiles");

const USGS_WMS_LAYERS: Record<string, string> = {
  "usgs-mdim": "MDIM21_color",
  "usgs-themis": "THEMIS",
  "usgs-mola-themis": "MOLA_THEMIS_blend",
  "usgs-hillshade": "HRSC_MOLA_Blend_Hillshade",
};

function buildUpstreamUrl(layer: string, z: number, x: number, y: number): string | null {
  if (layer === "mola-trek") {
    if (z > 7) return null;
    return `https://trek.nasa.gov/tiles/Mars/EQ/Mars_MGS_MOLA_ClrShade_merge_global_463m/1.0.0//default/default028mm/${z}/${y}/${x}.jpg`;
  }

  const wmsLayer = USGS_WMS_LAYERS[layer];
  if (!wmsLayer) return null;

  const tileDeg = 180 / 2 ** z;
  const west = -180 + x * tileDeg;
  const east = west + tileDeg;
  const north = 90 - y * tileDeg;
  const south = north - tileDeg;

  const params = new URLSearchParams({
    map: "/maps/mars/mars_simp_cyl.map",
    SERVICE: "WMS",
    VERSION: "1.1.1",
    REQUEST: "GetMap",
    LAYERS: wmsLayer,
    STYLES: "",
    SRS: "EPSG:4326",
    BBOX: `${west},${south},${east},${north}`,
    WIDTH: "256",
    HEIGHT: "256",
    FORMAT: "image/png",
  });
  return `https://planetarymaps.usgs.gov/cgi-bin/mapserv?${params.toString()}`;
}

export const tilesRouter = new Hono();

tilesRouter.get("/:layer/:z/:x/:y", async (c) => {
  const layer = c.req.param("layer");
  const z = Number.parseInt(c.req.param("z"), 10);
  const x = Number.parseInt(c.req.param("x"), 10);
  const y = Number.parseInt(c.req.param("y"), 10);

  if (
    !Number.isInteger(z) ||
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    z < 0 ||
    z > 14 ||
    x < 0 ||
    x >= 2 ** (z + 1) ||
    y < 0 ||
    y >= 2 ** z
  ) {
    return c.json({ error: "Invalid EPSG:4326 tile coordinates" }, 400);
  }

  const upstreamUrl = buildUpstreamUrl(layer, z, x, y);
  if (!upstreamUrl) {
    return c.json({ error: `Unsupported tile layer or zoom: ${layer} z=${z}` }, 404);
  }

  const ext = layer === "mola-trek" ? "jpg" : "png";
  const contentType = layer === "mola-trek" ? "image/jpeg" : "image/png";
  const layerDir = resolve(TILE_CACHE_DIR, layer);
  const cachePath = resolve(layerDir, `${z}_${x}_${y}.${ext}`);

  if (existsSync(cachePath)) {
    const bytes = await readFile(cachePath);
    return new Response(bytes, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400",
        "X-Tile-Cache": "HIT",
      },
    });
  }

  try {
    const res = await fetch(upstreamUrl, {
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      return c.json({ error: `Upstream tile error (${res.status})` }, 502);
    }
    const upstreamType = res.headers.get("content-type") ?? "";
    if (!upstreamType.startsWith("image/")) {
      return c.json({ error: `Unexpected upstream content type: ${upstreamType}` }, 502);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    await mkdir(layerDir, { recursive: true });
    await writeFile(cachePath, bytes);
    return new Response(bytes, {
      headers: {
        "Content-Type": upstreamType || contentType,
        "Cache-Control": "public, max-age=86400",
        "X-Tile-Cache": "MISS",
      },
    });
  } catch {
    return c.json({ error: "Upstream tile request failed" }, 504);
  }
});
