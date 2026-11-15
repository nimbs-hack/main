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

## USGS Astrogeology: Mars Odyssey THEMIS Nighttime IR Controlled Mosaics (`mo_themis_controlled_mosaics`)

- **Name:** `mo_themis_controlled_mosaics` (Jezero Crater `mc13_syrtis_major_nir` / Gale Crater `mc23_aeolis_nir`)
- **Mission / Instrument:** 2001 Mars Odyssey Thermal Emission Imaging System (THEMIS)
- **Asset URL (Jezero NIR COG):** `https://astrogeo-ard.s3-us-west-2.amazonaws.com/mars/mo/themis/controlled_mosaics/mc13_syrtis_major_nir/mc13_syrtis_major_nir.tif`
- **Asset URL (Gale NIR COG):** `https://astrogeo-ard.s3-us-west-2.amazonaws.com/mars/mo/themis/controlled_mosaics/mc23_aeolis_nir/mc23_aeolis_nir.tif`
- **Quantitative reference portal:** `https://astrogeology.usgs.gov/search/map/themis_thermal_inertia_mosaic_quantitative_30n000e_100mpp`
- **Resolution:** 100 m/px native COG (1-byte unsigned NIR DN, `NoData = 0`), bilinearly resampled onto the 20 m CTX planning grid (`1001x1001`)
- **Projection:** Mars (2015) Sphere / Ocentric / Equirectangular (`R = 3396190 m`, `clon = 0`)
- **License:** CC0-1.0 / Public domain
- **Fetch script & methodology:** `scripts/data/fetch-site.ts` and `classifyMarsSoilMatrix` in `packages/shared/src/soil.ts`, documented with literature sources (USGS SIM 3464, Vaughan et al. 2023, NASA EVA traverse and rover slip studies) in [docs/martian-soil-sources.md](../docs/martian-soil-sources.md)

## Planetary geologic map symbols (`geologic-symbols-qgis` / FGDC)

- **Name:** QGIS Geologic Symbols Library (`src/xml/fgdc/*.xml`, `src/gsymblib-svg/symbols/fgdc/*.svg`)
- **Standard:** FGDC-STD-013-2006 (Federal Geographic Data Committee Digital Cartographic Standard for Geologic Map Symbolization) and Daven Quinn planetary geology symbology
- **URL:** `https://github.com/afrigeri/geologic-symbols-qgis`
- **Scope used:** 31 planetary geology symbols (contacts, faults, ridges, volcanic constructs, impact craters, scarps, surficial features, and sample localities) normalized to `24x24` `currentColor` vectors and grouped into 5 themes
- **License:** CC0-1.0 Universal (`src/LICENSE.txt`; `collections/` was excluded because it is GPL-3.0)
- **Extract script:** `scripts/assets/extract-fgdc-symbols.ts` -> `apps/web/src/assets/fgdcSymbols.ts`

## Mars surface meteorology and physics generator

- **Primary live JSON feeds:**
  - NASA Mars 2020 MEDA RSS (`https://mars.nasa.gov/rss/api/?feed=weather&category=mars2020&feedtype=json`) for Jezero Crater air temperature, pressure, solar longitude, and sunrise/sunset LMST.
  - NASA MSL REMS RSS (`https://mars.nasa.gov/rss/api/?feed=weather&category=msl&feedtype=json`) for Gale Crater / Mount Sharp meteorology.
- **PDS archival meteorology (Range-sampled):**
  - PDS4 Mars 2020 MEDA (`https://atmos.nmsu.edu/PDS/data/PDS4/Mars2020/mars2020_meda/data_derived_env/`, `data_calibrated_env/`).
  - PDS3 MSL REMS (`https://atmos.nmsu.edu/PDS/data/mslrem_1001/DATA/`).
- **Probed InSight endpoints (retired mission fallback):**
  - NASA Open API (`https://api.nasa.gov/insight_weather/?api_key=DEMO_KEY&feedtype=json&ver=1.0`) and JPL InSight RSS (`https://mars.nasa.gov/rss/api/?feed=weather&category=insight&feedtype=json`). Since InSight ceased operations in Dec 2022 (`sol_keys: []`) and `DEMO_KEY` rate-limits at 10 req/hour, probes log status cleanly and trigger MEDA/REMS or generator fallback.
- **Physics-calibrated generator (`apps/api/src/weather/generator.ts`):** Uses Martian scale height (`10,800 m`), thermal lapse rate (`-0.0025 K/m`), solar longitude eccentricity, and Mars sol length (`88,775.244 s`) to synthesize hourly 24-LMST curves, missing wind/UV/dust channels in `hybrid` mode, and explicit `nominal`, `dust-storm`, and `cold-snap` scenarios flagged with `isSimulated: true`.
- **Fetch / Cache:** `scripts/data/fetch-weather.ts` writes `data/site-weather.json`; `apps/api/src/weather/service.ts` caches responses under `data/cache/weather/`.
