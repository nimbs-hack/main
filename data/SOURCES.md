# Mars data sources

All datasets used by this app are listed here. Raw files and caches stay in `data/` (gitignored).

## USGS Astrogeology WMS (global basemaps)

- **Name:** USGS Astrogeology Mars WMS Server (`MDIM21_color`, `THEMIS`, `MOLA_THEMIS_blend`, `MOLA_color`, `HRSC_MOLA_Blend_Hillshade`)
- **Mission / Instrument:** Viking MDIM 2.1, Mars Odyssey THEMIS IR (100 m), MGS MOLA, Mars Express HRSC
- **URL:** `https://planetarymaps.usgs.gov/cgi-bin/mapserv?map=/maps/mars/mars_simp_cyl.map`
- **Portal link:** `https://astrogeology-usgs.hub.arcgis.com/pages/interactive-maps-mars`
- **Resolution:** Global layers from ~100 m/px (THEMIS) to ~231 m/px (MDIM 2.1) and ~463 m/px (MOLA)
- **Projection:** Simple Cylindrical (`CRS=EPSG:4326`, planetocentric, east-positive -180 to 180)
- **Terms:** Public domain (USGS Astrogeology Science Center)
- **Fetch / Proxy:** Proxied and cached on disk by `apps/api` (`GET /api/tiles/:layer/:z/:x/:y`)

## NASA Mars Trek MOLA Colorized Shaded Relief WMTS

- **Name:** `Mars_MGS_MOLA_ClrShade_merge_global_463m` (basemap used by the USGS interactive Mars map)
- **Mission / Instrument:** Mars Global Surveyor (MGS) MOLA
- **URL:** `https://trek.nasa.gov/tiles/Mars/EQ/Mars_MGS_MOLA_ClrShade_merge_global_463m/1.0.0//default/default028mm/{z}/{y}/{x}.jpg`
- **Resolution:** ~463 m/px global (levels 0 to 7)
- **Projection:** Equirectangular, Mars 2015 Sphere (`R = 3396190 m`), `-180..180`, `-90..90`
- **Terms:** NASA / JPL public data
- **Fetch / Proxy:** Proxied and cached on disk by `apps/api` (`GET /api/tiles/mola-trek/:z/:x/:y`)

## USGS Astrogeology STAC: MRO HiRISE DTM (3x3 km pilot site)

- **Name:** `mro_hirise_socet_dtms` (Jezero Crater `DTEEC_048842_1985_048908_1985_U01` / Gale Crater `DTEEC_063319_1745_052242_1745_A01`)
- **Mission / Instrument:** Mars Reconnaissance Orbiter (MRO) HiRISE
- **Catalog URL:** `https://stac.astrogeology.usgs.gov/api/collections/mro_hirise_socet_dtms`
- **Asset URL (selected site):** Recorded by `scripts/data/fetch-site.ts` after extracting the 3x3 km window
- **Resolution:** ~1.0 m/px native COG, downsampled to a 3x3 km planning grid (20 m spacing, 151x151 nodes)
- **Projection:** Mars (2015) Sphere / Ocentric / Equirectangular (`R = 3396190 m`, `clon = 0`)
- **License:** CC0-1.0
- **Fetch script:** `scripts/data/fetch-site.ts` (reads COG byte ranges via HTTP Range requests)
