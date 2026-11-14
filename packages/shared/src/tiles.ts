export const USGS_WMS_BASE_URL =
  "https://planetarymaps.usgs.gov/cgi-bin/mapserv?map=/maps/mars/mars_simp_cyl.map";

export const MARS_TREK_MOLA_TILE_TEMPLATE =
  "https://trek.nasa.gov/tiles/Mars/EQ/Mars_MGS_MOLA_ClrShade_merge_global_463m/1.0.0//default/default028mm/{z}/{y}/{x}.jpg";

export const USGS_WMS_LAYERS: Readonly<Record<string, string>> = {
  "usgs-mdim": "MDIM21_color",
  "usgs-themis": "THEMIS",
  "usgs-mola-themis": "MOLA_THEMIS_blend",
  "usgs-hillshade": "HRSC_MOLA_Blend_Hillshade",
};

/**
 * Build the direct upstream tile URL for Leaflet EPSG:4326 tile coordinates.
 * Both USGS WMS and NASA JPL Mars Trek serve CORS-enabled public tiles.
 */
export function buildDirectMarsTileUrl(
  layerId: string,
  z: number,
  x: number,
  y: number,
): string | null {
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) return null;
  if (z < 0 || z > 17 || x < 0 || y < 0) return null;

  if (layerId === "mola-trek") {
    if (z > 7) return null;
    return `https://trek.nasa.gov/tiles/Mars/EQ/Mars_MGS_MOLA_ClrShade_merge_global_463m/1.0.0//default/default028mm/${z}/${y}/${x}.jpg`;
  }

  const wmsLayer = USGS_WMS_LAYERS[layerId];
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
