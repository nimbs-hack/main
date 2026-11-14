/*
Package weather ports the reviewed TypeScript generator, weather field and EVA
calculation to Go. Production code uses only the standard library, with no
network access, subprocesses, wall-clock reads or shared mutable caches.

# Integration

Pass the planner's north-first row-major elevations, valid mask and bounding box
as Grid. Coordinates are planetocentric, east-positive degrees in [-180,180].
The sphere radius is 3,396,190 m. ReferenceElevationM is explicit: the reviewed
Jezero preset uses -2500 m and Gale uses -4500 m. Do not substitute the grid's
mean elevation. Pass CellSizeMeters from site metadata to preserve the source
cold-air pooling radius; zero derives it from grid spacing.

Generate produces Snapshot, including current weather, hourly samples for both
sols, source labels and a disclaimer. Options.LMSTHour selects current weather.
SampleAt samples the same forecast for charts. ComputeFieldContext generates
spatial temperature and pressure arrays with a valid mask and summary. Invalid
cells are zero and must remain masked when rendering. Fields return errors for
malformed grids and all-invalid grids. A one-million-cell square grid allocates
about 29 MB including outputs and scratch. The hard limit is four million cells.
Cancellation is checked before generation, after generation and between rows.
Inputs must not be mutated while a calculation is running.

Evaluate and EvaluateContext return daily checks, a thermal/wind safe window,
all departure slots, and up to four ranked departure recommendations. Route
vertices use cumulative distanceM and elevationM. Other HTTP route fields can be
ignored. For partial HTTP limits, start with DefaultLimits and apply each
provided field. Convert minAirTempC to MinAirTempK by adding 273.15. An absent
route evaluates a floor-to-rim-to-floor profile lasting the configured EVA limit. All durations are
Earth hours; offsets, selected hours and departure steps are LMST hours. The
48-LMST-hour timeline spans about 49.32 Earth hours from the base sol's midnight.
The EVA duration defaults to four Earth hours and is configurable up to 12.
A walk exceeding that limit or ending beyond the forecast is NO-GO. A daily status can differ from a departure slot status because
it evaluates daily extrema, while a slot evaluates the weather during that walk.

# Model limits and differences from the reviewed TypeScript

All output is explicitly simulated. Persisted observations and live telemetry
are not read in this integration. Sol 0 is landing day, and generation never
substitutes today's date. Seasonal pressure, thermal tides, diurnal temperature,
wind, dust, solar geometry and next-sol smoothing follow the source formulas.
Pressure uses a fixed 10,800 m scale height and temperature a -2.5 K/km lapse
rate. Slope heating and local basin cooling are empirical corrections. This is
not a validated Martian weather forecast or a flight safety model. Radiation,
suit thermal balance, shelter, local shadowing and route delays are not modeled.
The walking rule is distance/2500 + ascent/350 + descent/800 in Earth hours.

The Go API uses kelvin for thresholds and encountered temperatures. Field
summaries additionally expose Celsius for display. Daily daylight duration is
reported in Earth hours. UI reason text and some metadata are simplified.
Samples retain numeric precision, and safety comparisons do not round values
for display. Spatial arrays and working sums use float64 instead of float32;
fixture tolerances are 0.002 K and 0.0002 Pa. Pooling uses summed-area tables
instead of the source's separable sliding window. No terrain or PNG cache is
retained by this package.

A daylight fraction within 1e-12 of one counts as full daylight. The reviewed
source classifies 0.9999999999999996 as DEGRADED with "100% daylight". The fixture
test permits only that known status difference. NO-GO slots are returned but
never promoted to recommendations; the source offers emergency intervals when
all slots are blocked. Cross-midnight dust uses the worse of both sols, rather
than only departure-sol dust. If route points and aggregate distance disagree,
vertices determine both reported and evaluated walking duration. Invalid
forecasts and times return errors rather than silently filling or clamping.
At exactly hour 48 the source's next-sol midnight wrap is retained; no walk can
extend past that endpoint. MaxEvaHours above 12 is rejected.

# Verification

TestReviewedTSParity reads saved outputs from the reviewed TypeScript for sol
1859, Ls 137, all three scenarios, 24 hourly samples per sol, seven spatial
fields per scenario and all 96 route departure slots. It compares climate
values exactly to 1e-9, route extrema to 1e-8, and spatial fields within the
float32 tolerances above. Focused tests cover Earth/LMST conversion, fractional
threshold failures, hourly wind knots, narrow route peaks, thermal crossings,
daylight integration, next-sol pressure swings, horizon blocking and nodata.
Regenerate fixtures from the worktree root with:

	bun apps/api/internal/weather/testdata/generate.ts /path/to/algorithms-integration

The fixture script is a development-only dependency. Go tests consume the JSON
and never execute TypeScript.
*/
package weather
