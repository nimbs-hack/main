import type { MapLayerMeta } from "./types";

/** Default Mars basemap layer used as initial fallback. */
export const DEFAULT_MARS_BASE_LAYER: MapLayerMeta = {
  id: "usgs-mdim",
  label: "USGS MDIM 2.1 COLOR",
  attribution: "USGS Astrogeology Science Center",
  maxNativeZoom: 9,
  tileUrlTemplate: "/api/tiles/usgs-mdim/{z}/{x}/{y}",
};

/** Verified Mars basemap layers proxied and cached by apps/api. */
export const MARS_BASE_LAYERS: readonly MapLayerMeta[] = [
  DEFAULT_MARS_BASE_LAYER,
  {
    id: "usgs-themis",
    label: "USGS THEMIS IR DAY",
    attribution: "USGS Astrogeology / ASU",
    maxNativeZoom: 10,
    tileUrlTemplate: "/api/tiles/usgs-themis/{z}/{x}/{y}",
  },
  {
    id: "usgs-mola-themis",
    label: "USGS MOLA + THEMIS",
    attribution: "USGS Astrogeology / NASA",
    maxNativeZoom: 8,
    tileUrlTemplate: "/api/tiles/usgs-mola-themis/{z}/{x}/{y}",
  },
  {
    id: "mola-trek",
    label: "MARS TREK MOLA SHADE",
    attribution: "NASA JPL Mars Trek",
    maxNativeZoom: 7,
    tileUrlTemplate: "/api/tiles/mola-trek/{z}/{x}/{y}",
  },
] as const;
