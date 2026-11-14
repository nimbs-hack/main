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

## USGS Astrogeology STAC: MRO CTX Controlled DTM (20x20 km local planning site)

- **Name:** `mro_ctx_controlled_usgs_dtms` (Jezero Crater `K23_062385_1988_XN_18N282W__K23_062451_1988_XN_18N282W` / Gale Crater `T01_000881_1752_XI_04S223W__P02_001752_1753_XI_04S222W`)
- **Mission / Instrument:** Mars Reconnaissance Orbiter (MRO) Context Camera (CTX)
- **Catalog URL:** `https://stac.astrogeology.usgs.gov/api/collections/mro_ctx_controlled_usgs_dtms`
- **Asset URL (active Jezero DTM):** `https://astrogeo-ard.s3-us-west-2.amazonaws.com/mars/mro/ctx/controlled/usgs/K23_062385_1988_XN_18N282W__K23_062451_1988_XN_18N282W/K23_062385_1988_XN_18N282W__K23_062451_1988_XN_18N282W_dtm.tif`
- **Asset URL (active Jezero hillshade):** `https://astrogeo-ard.s3-us-west-2.amazonaws.com/mars/mro/ctx/controlled/usgs/K23_062385_1988_XN_18N282W__K23_062451_1988_XN_18N282W/K23_062385_1988_XN_18N282W__K23_062451_1988_XN_18N282W_hillshade.tif`
- **Resolution:** ~20.39 m/px native COG (~34 x 44 km swath), cropped and resampled to a 20x20 km planning grid (20 m spacing, 1001x1001 = 1,002,001 nodes)
- **Projection:** Mars (2015) Sphere / Ocentric / Equirectangular (`R = 3396190 m`, `clon = 0`)
- **License:** CC0-1.0 / Public domain
- **Fetch script:** `scripts/data/fetch-site.ts` (reads COG byte ranges via HTTP Range requests)
