# Martian soil types, speed coefficients, and data sources

This note records every planetary dataset, mission paper, and engineering study used to classify the 4 terrain types and set walking and rover speed coefficients.

## Four implemented soil types

Every cell on the 20 x 20 km terrain grid stores one soil code (`0` to `3`) alongside elevation in meters. During A* pathfinding and EVA duration modeling, flat horizontal speed scales by each type's speed factor in `[0.10, 1.50]`.

| Code | ID | Label | Human factor | Rover factor | Basis |
| --- | --- | --- | --- | --- | --- |
| `0` | `bedrock` | Bedrock | `1.00` | `1.00` | Indurated fractured rock and crater/delta scarps with high nighttime IR brightness (`>= 12 deg` slope stripping loose fines, or peak thermal inertia). Negligible sinkage; steep walls remain bounded by the slope limit. |
| `1` | `coarse-regolith` | Coarse regolith | `0.85` | `0.88` | Sorted 1 to 2 mm olivine grains and rocky aprons (`Se'itah` and `Ma'az` floor units). Moderate grain compliance yields a 12% to 15% speed loss vs flat bedrock. |
| `2` | `fine-regolith` | Fine regolith | `0.70` | `0.72` | Ferric-oxide dust mantles and lightly crusted fine silt on crater plains (low to moderate nighttime IR). Boot and wheel sinkage lowers horizontal speed by ~28% to 30%. |
| `3` | `loose-sand` | Loose sand | `0.45` | `0.42` | Unconsolidated windblown ripples and aeolian dunes in low thermal inertia troughs (`<= 7.5 deg` slope, low nighttime IR or negative topographic position). Severe sinkage and slip cut speed by 55% to 58%. |

Effective traverse time for segment length `d` (m), elevation gain `dh+`, and loss `dh-` is:

`dt = d / (flatSpeedMPerH * segSoilFactor) + dh+ / climbSpeedMPerH + dh- / descentSpeedMPerH`

Edge speed factor `segSoilFactor` averages the endpoints `(factor(u) + factor(v)) / 2`. Both `POST /api/graph/routes` and `POST /api/weather/evaluate` accept custom multipliers for all 4 soil types in advance (`ADV`) mode.

## Primary data and literature sources

### 1. Mars Odyssey THEMIS Nighttime IR controlled mosaics

- Dataset: USGS Astrogeology Controlled THEMIS Nighttime Infrared Mosaics (`mo_themis_controlled_mosaics`, Mars 2015 Sphere / Ocentric Equirectangular, 100 m/px).
- License: `CC0-1.0`.
- Jezero Crater item (`mc13_syrtis_major_nir`): `https://astrogeo-ard.s3.us-west-2.amazonaws.com/mars/mo/themis/controlled_mosaics/mc13_syrtis_major_nir/mc13_syrtis_major_nir.tif`
- Gale Crater item (`mc23_aeolis_nir`): `https://astrogeo-ard.s3.us-west-2.amazonaws.com/mars/mo/themis/controlled_mosaics/mc23_aeolis_nir/mc23_aeolis_nir.tif`
- Quantitative thermal inertia reference portal: `https://astrogeology.usgs.gov/search/map/themis_thermal_inertia_mosaic_quantitative_30n000e_100mpp`
- Physical role: Fine dust and loose sand lose heat rapidly after sunset and appear dark (low DN) in nighttime IR; bedrock and rocky colluvium stay warm and appear bright. `scripts/data/fetch-site.ts` reads the live Cloud Optimized GeoTIFF over HTTP range requests, bilinearly resamples it onto the 1001 x 1001 CTX grid (`100%` valid coverage in the current Jezero patch, DN `8` to `251`), and pairs it with 20 m slope and 7 x 7 focal Topographic Position Index (`TPI`) in `classifyMarsSoilMatrix`.
- Jezero 20 x 20 km patch classification counts from the live fetch: `25.8%` bedrock, `32.0%` coarse regolith, `26.0%` fine regolith, `16.2%` loose sand.

### 2. USGS Jezero Crater 1:75,000 geologic map (SIM 3464)

- Citation: Sun, V. Z., and Stack, K. M. (2020). Geologic map of Jezero crater and the Nili Planum region, Mars. U.S. Geological Survey Scientific Investigations Map 3464.
- Publication URL: `https://pubs.usgs.gov/publication/sim3464`
- DOI: `https://doi.org/10.3133/sim3464`
- GIS data release: `https://doi.org/10.5066/P9CZYIO7`
- Direct GIS database archive: `https://pubs.usgs.gov/sim/3464/sim3464_database.zip`
- Physical role: Defines the mappable substrate units in Jezero Crater (fractured crater floor bedrock, delta scarp units, surficial regolith mantles, and aeolian bedform clusters) by combining MRO CTX, HiRISE, HRSC, and THEMIS nighttime IR.

### 3. Perseverance Mars 2020 in-situ regolith grain taxonomy

- Citation: Vaughan, A., Minitti, M. E., et al. (2023). Regolith observations in Jezero crater, Mars, by Mars 2020 Mastcam-Z, SuperCam, and WATSON. Journal of Geophysical Research: Planets, 128(3).
- DOI / URL: `https://doi.org/10.1029/2022JE007437` (`https://agupubs.onlinelibrary.wiley.com/doi/10.1029/2022JE007437`)
- Physical role: Documents the distinction across the Jezero floor (`Ma'az` and `Se'itah` formations) between resistant exposed bedrock, sorted 1 to 2 mm coarse olivine-bearing sand/regolith, fine ferric dust coatings, and loose aeolian ripples.

### 4. MRO CTX stereo terrain geometry

- Jezero Crater DTM: `https://astrogeo-ard.s3-us-west-2.amazonaws.com/mars/mro/ctx/controlled/usgs/K23_062385_1988_XN_18N282W__K23_062451_1988_XN_18N282W/K23_062385_1988_XN_18N282W__K23_062451_1988_XN_18N282W_dtm.tif`
- Gale Crater DTM: `https://astrogeo-ard.s3-us-west-2.amazonaws.com/mars/mro/ctx/controlled/usgs/T01_000881_1752_XI_04S223W__P02_001752_1753_XI_04S222W/T01_000881_1752_XI_04S223W__P02_001752_1753_XI_04S222W-DEM-geoid-adj.tif`
- Physical role: Supplies 20 m elevation, neighbor slope gradients, and local hollow/ridge curvature (`TPI`) that separate wind-sheltered sand traps in depressions from exposed rocky scarps.

### 5. NASA EVA traverse pace and Martian regolith slip studies

- Baseline walking speed: NASA Apollo J-mission surface traverse metrics and Exploration EVA concept of operations (`2.0` to `2.5 km/h` / `~0.6` to `0.75 m/s` on flat firm regolith; application default `flatSpeedMPerH = 2500` for humans, `5000` for pressurized rovers), hosted across NASA Technical Reports Server (`https://ntrs.nasa.gov/`) and Apollo Lunar Surface Journal (`https://www.nasa.gov/history/alsj/`).
- Human gait and traverse cost on simulated reduced-gravity regolith: NASA SEXTANT surface path planning tool (`https://ntrs.nasa.gov/` search `SEXTANT planetary surface traverse`) and NASA Johnson Space Center ARGOS / SLOPE reduced-gravity mobility testing documenting energy and horizontal speed penalties on loose unconsolidated regolith vs solid rock.
- Martian rover slip on loose aeolian sand: Mars Exploration Rover (`Spirit` / `Opportunity` Purgatory Dune slip incidents), Mars Science Laboratory (`Curiosity` Hidden Valley sand ripples), and Perseverance `AutoNav` slip performance in `Se'itah` bedforms reported in Perseverance press/mission updates (`https://mars.nasa.gov/mars2020/`), showing 30% to 55%+ velocity loss on loose unconsolidated dunes relative to bedrock and compacted lag.

## Model assumptions and limitations

1. Soil class boundaries and the default numerical speed multipliers (`1.00`, `0.85`, `0.70`, `0.45` for EVA suits; `1.00`, `0.88`, `0.72`, `0.42` for rovers) are engineering defaults derived by fusing real 100 m/px THEMIS nighttime IR thermal inertia proxies and 20 m CTX geometry with published terramechanics ranges. They are not direct in-situ penetrometer measurements at every 20 m pixel.
2. Users can override all 4 speed factors (`0.10x` to `1.50x`) in the UI (`ADV` mode, `WXR` tab) or via the `soilSpeedFactors` API field, so planners can calibrate against new field telemetry.
