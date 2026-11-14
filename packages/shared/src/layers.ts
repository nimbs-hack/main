import { MARS_TREK_MOLA_TILE_TEMPLATE, USGS_WMS_BASE_URL } from "./tiles";
import type { MapLayerMeta } from "./types";

/** Default Mars basemap layer used as initial fallback. */
export const DEFAULT_MARS_BASE_LAYER: MapLayerMeta = {
  id: "usgs-mdim",
  label: "USGS MDIM 2.1 COLOR",
  attribution: "USGS Astrogeology Science Center",
  maxNativeZoom: 9,
  tileUrlTemplate: `${USGS_WMS_BASE_URL}&LAYERS=MDIM21_color`,
};

/** Verified Mars basemap layers loaded directly by the browser and cached client-side. */
export const MARS_BASE_LAYERS: readonly MapLayerMeta[] = [
  DEFAULT_MARS_BASE_LAYER,
  {
    id: "usgs-themis",
    label: "USGS THEMIS IR DAY",
    attribution: "USGS Astrogeology / ASU",
    maxNativeZoom: 10,
    tileUrlTemplate: `${USGS_WMS_BASE_URL}&LAYERS=THEMIS`,
  },
  {
    id: "usgs-mola-themis",
    label: "USGS MOLA + THEMIS",
    attribution: "USGS Astrogeology / NASA",
    maxNativeZoom: 8,
    tileUrlTemplate: `${USGS_WMS_BASE_URL}&LAYERS=MOLA_THEMIS_blend`,
  },
  {
    id: "mola-trek",
    label: "MARS TREK MOLA SHADE",
    attribution: "NASA JPL Mars Trek",
    maxNativeZoom: 7,
    tileUrlTemplate: MARS_TREK_MOLA_TILE_TEMPLATE,
  },
] as const;
