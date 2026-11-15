# Mission planner

Plans what a crew needs for a mission: food energy and nutrients, water, oxygen and electricity. You describe the crew, the phases of the mission and the places the crew works at, and the planner works out the supplies and packs the mission into one small file.

It has four parts:

- The planner, in Go, in `apps/api/internal/planner`. It has a command line and an HTTP API. Its [README](apps/api/internal/planner/README.md) covers the model, the mission file format, the sources of every rate and the limits.
- The editor, in React and TypeScript, in `src`. It opens on Home, which lists the mission files kept in this browser. A mission is then made in four stages, each its own page with a tab in the top bar: Crew, Phases, Sites and Review. Sites is the 3D Mars map with EVA route planning, map tools and science layers.
- The viewer, in plain TypeScript, in `src/viewer`. It is a second, small page at `/viewer.html` that opens a mission file, shows its sites on a 3D map, the route through them and what the mission needs. Its Edit button opens the mission here. [Mission viewer](#mission-viewer) below covers it.
- The API server, in Go, in `apps/api`. It serves the planner and proxies and caches the globe's imagery and terrain tiles.

Everything the planner reports is a planning estimate built from published NASA rates.

## Run it

Install [Bun](https://bun.sh) and Go 1.24 or newer, then run:

```sh
bun install
bun run dev
```

Open the address Vite prints. Vite builds and starts the Go API on a private local port, forwards `/api` to it, and stops it when Vite closes. `bun run preview` uses the same API after a build.

If the planner cannot be reached, the editor says so and offers a retry. If it stops answering while you work, the editor keeps your edits, marks the numbers as stale, and plans again when it is back.

To run the planner without the editor:

```sh
bun run planner demo
```

The demo packs the built-in example mission into a file, reads the file back, and prints the plan. `bun run planner types` lists the mission types. The planner README has the other commands.

### Standalone build

```sh
bun run build
./bin/mars-api
```

The build writes the frontend to `dist/` and the Go binary to `bin/mars-api`. Run the binary from the repository root. It serves both on port 3000. `PORT` changes the port; `-addr`, `-cache-dir` and `-static-dir` override the listen address and directories. A deployed binary needs `dist/` alongside it and a writable cache directory. It needs neither Bun nor Go installed.

## Checks

```sh
bun run typecheck
bun run lint
bun run test
```

Typecheck runs `tsc` on the editor and the viewer and compiles the Go packages. Lint runs `go vet` and checks `gofmt`. Tests cover the globe helpers, the viewer's terrain decoder and camera, and the API launcher, and run Go's race detector on the planner and the tile proxy. The editor's components and the viewer's page have no automated tests.

## Making a mission

The app opens on Home. **Open mission file** reads a `.mhr` or JSON file, and **New mission** asks for a name, a type and a margin on supplies, then makes the file. The tabs in the top bar go to any stage. Going to a stage with no file open makes one called Unnamed mission. The address keeps the stage, so reload and the back button work.

The open mission is in the top bar on the right. Its name is typed in place, and the arrow beside it opens the type and the margin on supplies. The two arrows after it are undo and redo, also Ctrl+Z and Ctrl+Shift+Z.

| Stage | What you do |
| --- | --- |
| Home | Every mission file, newest first, each with its sites joined by straight lines over CTX imagery. A row opens to what the mission holds, with a line for each stage, **Edit** and **Delete**. The file being edited is outlined. A first run starts with the example mission. The list lives in this browser and holds 50 missions.. **Open mission viewer** opens the lighter viewer page, `/viewer.html`. |
| Crew | People as tiles: a portrait, the call sign, then two buttons. **Select** puts someone on the crew, and those on it are outlined in red. The arrow opens a person's information under their row to read or edit. Search narrows the tiles by call sign or role. **+** beside the title adds a new person. A portrait shows when `src/assets/crew` has a file named after the call sign. **Add photo** in a person's information puts your own picture on their tile, cut to a square. Added photos stay in this browser and are not in the mission file. The roster starts with six NASA astronauts: Christina Koch, Robert Hines, Jessica Meir, Victor Glover, Kjell Lindgren and Frank Rubio. A new mission has nobody picked, and everything else empty but the phases of its type. |
| Phases | Set each phase's length, recycling, EVA hours and power. Drag a phase by its grip to reorder. A changed value turns blue and offers the preset back. |
| Sites | The left panel opens with two tabs. **Sites** holds the mission's places: **Add sites** and click the map once for each, then open a site to give it a name, a short description (what is there and why the crew goes) and coordinates, or to remove it. **Plan** sets the order the EVA visits them and the work at each visit: pick a site under **Next stop** and press **Add stop**, as many times as needed. A site can come back, as in A, B, A, C, A, but not twice in a row. Open a stop to add its tasks: kind, length, phase, EVA or inside, a note, and under **Who** each person who works it; everyone pressed works its whole length. **Earlier**, **Later** or dragging a stop reorders the plan, and its tasks go with it. The EVA route runs through the stops in order, and follows the plan when it changes. **Start here** and **Target here** also save the map's endpoints and user stops to Sites and Plan, reusing existing sites. Undo and redo restore both lists and the map. With no plan yet, it visits the sites in list order. The Route tab then gives a go or no-go verdict for the walk. On the Time tab the EVA start fills itself in with the best window of the next seven sols: the Sun up until an hour past the end, the warmest air at the nearest rover station, and no CME forecast to arrive during it. A calendar of the next six weeks marks each UTC date by its sol's best window: a dot for a clear one, an outline triangle for one with cautions, a filled triangle when there is no safe one. Click a date to start at its best window, then move the time in the 24-hour UTC field if needed. **Best** goes back to the worked-out start. **Start chosen** says how the start was set and, for any start, what is wrong with it. An EVA that runs into the dark makes the route verdict no-go. An EVA longer than the daylight starts at sunrise and is marked no-go. Review shows the start and when the crew is back. The limits on the Route, Time and other tabs take any value the model can use; one outside that stays in its box unapplied, with the range under it. **Add EVA to mission** gives the last stop one EVA task as long as the travel and the work. |
| Review | The only page with results: cautions, totals, loads on the vehicle, tables by phase, by site with distances, and by crew, with the mission's sites on the planet beside them. Save the mission file here. Its globe draws the EVA route as assessed on the Sites page, or the plan's stops in order, dashed, before one is. |

A stage with a problem in it is marked **Fix** on its tab. The Review tab shows how many cautions are waiting.

### How the stages fit together

One mission is shared by every page, with one undo history, which starts over when another file is opened. Every edit the planner accepts is saved into the open file. Results are worked out after every edit and shown on Review. An EVA assessed on the Sites map becomes a task, and its hours are checked against the EVA hours of its phase, so a route that is too long shows up as a caution in Review. The task note carries the route's verdict, distance and steepest slope. Review lists the sites with the same point-to-point distances the Sites page shows.

## The globe

- Terrain is NASA Mars Trek's elevation tileset. The cursor readout gives elevation above the MOLA areoid.
- Imagery is the Viking colour mosaic far out and CTX at about 5 m per pixel close in. The low zoom levels of Viking are in `public/tiles`; `bun run tiles` downloads any that are missing. CTX and terrain come through the caching proxy in `apps/api`. `data/SOURCES.md` describes each dataset.
- Drag to pan, scroll to zoom, right-drag to tilt. The buttons on the right face north, switch between tilted and straight down, and zoom.
- The colour overlays (elevation, night infrared and the rest) start off. Turn them on from the layer switcher at the bottom left of the Sites map.
- The API server reads ahead: for each close-up tile it serves, it fetches the four tiles beside it and the four under it into the disk cache, so a pan or a zoom finds them there. `apps/api/internal/tiles/readahead.go` has the limits.
- Both map pages open on the whole planet. Once opened they stay loaded, so switching tabs does not rebuild the globe. The map library loads only for these two pages. `src/data/performance.js` holds the settings that keep drawing cheap.
- Elevation scale switches between 1× and 3×. The 3× view exaggerates slopes and is for looking, not for judging them.

The status bar reports loading, missing terrain or imagery, and when the older CTX mosaic has been swapped in. Retry rebuilds the globe and keeps the mission.

Coordinates are planetocentric latitude and east-positive longitude on the sphere the terrain tiles use. Sites are stored with longitude from -180 to 180; the screen shows 0 to 360 east, the usual convention for Mars.

Mission sites are points with a label: number, name, task count. The selected one is larger, red, and its label starts with a check mark. On the Review globe the readout says "Terrain safety not assessed" for every site. Slope is checked only along an EVA route planned on the Sites page.

## Mission viewer

`/viewer.html` reads a mission file on a device that cannot carry the editor. It loads neither React nor Cesium: about 37 kB of script and style gzipped, plus the font and portraits, against about 1.3 MB for the editor. In development, add `/viewer.html` to the address Vite prints. The page needs the API server, which plans the mission and serves the tiles.

Before a file opens, the page shows Mars as a globe that turns once every two minutes, drawn from the Viking color mosaic tiles in `public/tiles`. **Open a mission file** and **Try an example** sit under it. No terrain loads until a mission opens. With reduced motion on, the globe stands still.

Once a file opens, the page is the map. A mission with no sites or symbols has no ground to show, so the globe stays, with a line saying so and a button to the mission details. **Mission** slides out the sidebar. **Close**, Escape, or a tap outside the sidebar on a phone closes it. The viewer changes nothing. **Edit** opens the mission in the planner, on the stage that matches the open tab: Crew on Crew, Phases on Phases, Sites and Simulation on Sites, the rest on Review. The planner adds the mission to its list, or reopens it if it is there already.

**Open file**, Ctrl+O or dropping a file on the page reads a `.mhr` or JSON file. The planner checks it. If the file is damaged, the page gives the reason and keeps the mission on screen. The browser keeps the last file opened and opens it again on the next visit.

| Tab | What it shows |
| --- | --- |
| Simulation | Each crew member's suit sensors and position. **You are** picks who you are, and is not saved |
| Mission | Cautions, supplies with the margin, vehicle loads on demand |
| Sites | The plan, stop by stop, with the distance along the route from the stop before and the tasks at that stop. Then each site with its coordinates and description, then the mission's symbols |
| Crew | Each person's radiation dose against the career limit, mission totals and daily needs |
| Phases | Supplies by phase |
| Briefing | The briefing text |

Edit passes the mission through the browser's storage under `nimbs:planner:incoming` (`src/handoff.ts`). The planner reads it on start and clears it once the mission is open. If the browser won't store it, the viewer says so and points to the planner's Open mission file.

### Simulation

Crew positions and suit readings are both simulated. Nothing here is telemetry, and none of it goes into the mission file. The tab labels them as simulated, and the map key keeps that label visible with the sidebar closed. **Data sources** explains where the readings come from.

The crew walks as one group along the route, from the plan's first stop to its last and back, at 1.2 m/s. Until the route is found they walk straight from stop to stop. They walk two abreast, 6 m apart, with 8 m between rows. With only one site, each person circles it instead. The map uses the planner's portrait labels, diamond crew pins and leader lines. The same label layout keeps each person visible when they gather. Uploaded photos are shared between the planner and viewer on the same browser origin, with bundled portraits or initials as the fallback. **You are** picks which crew member is you, the first by default.

Each crew member is a row showing heart rate and oxygen time left. Open the row, or click the person on the map, for their suit readings:

| Group | Readings | Caution, then over the limit |
| --- | --- | --- |
| Life signs | Heart rate, breathing, blood oxygen, core temperature | Blood oxygen under 94%, under 90% |
| Oxygen | Breathed, suit leak, left in tank, time left at the current use and leak, suit pressure | Leak over 80% of the plan's 92 g/h suit loss allowance (BVAD), over all of it. Time left under 1 h, under 30 min |
| Energy | Metabolic rate, energy used since the EVA started | Over 80% of the 617 W suited limit (NASA-STD-3001), over all of it |

`src/viewer/sensors.ts` makes up the readings from the planner's suit model in `src/data/suit.ts`. Metabolic rate swings around the Apollo EVA average, oxygen use follows it by the BVAD ratio, and the tank holds enough for 8 h at the planned use and loss. The simulation starts 2 h 30 min into the EVA. The fourth suit leaks close to the allowance on purpose, to show a caution: its row names the reading, and the Simulation tab gets a yellow dot. A real feed would replace `readSuitSensors`, the only function the page calls.

Everything updates once a second without redrawing terrain. Pause freezes positions and readings. A hidden page stops the clock. Hiding positions leaves the readings running.

### The viewer's map

- The ground is the same terrain and CTX imagery as the editor's globe, drawn by about 600 lines of WebGL 1 code. Close in at the four rover sites it shows the HiRISE mosaics. The cursor readout gives coordinates and elevation above the MOLA areoid.
- Sites are numbered squares. A dashed line routes through the mission's plan, stop by stop: A to B, then B back to A, then A to C, for a plan A, B, A, C. A mission without a plan visits its sites in list order.
- The viewer finds the route itself (`src/viewer/route.ts`), because a mission file holds the plan's stops, not the path the planner's route search picked between them. Each leg is the planner's search (`src/data/route-options.ts`) on the terrain the map loaded, the shortest path under the default Nominal limits (20°). It reads no night infrared, so it offers no Thermal or Detour route. The planner can find others.
- Until the region's terrain is in, the line runs straight and the key says "Finding the route". A leg with no path under the limit stays straight and turns red and wider. The key lists it, and the plan in the Sites tab says which limit would work. A leg with no terrain at an end stays straight too, and the plan calls the route unknown.
- The Sites tab gives each leg's distance along the route.
- Drag to move, scroll to zoom, right-drag or Shift+drag to turn and tilt. On a touch screen, pinch to zoom and twist to turn. The arrow keys move the map, Shift with them turns and tilts it, and + and - zoom. With the sidebar open, buttons on the right zoom, show the whole mission, face north and tilt.
- Heights are always three times taller than true, and the map key says "Heights ×3". There is no switch back to true scale. Slopes look steeper than they are, so judge them from the planner, not the picture. The flat map has no relief and drops the note.
- Clicking a site's name in the panel brings it to the middle of the map. Clicking a pin opens the site in the panel.
- The ground is a flat map around the middle of the mission, not a globe. That is exact enough for one site and the routes around it. Far from the middle, east-west distances stretch.
- The map loads only the mission's region: the box around its sites and symbols, plus 40% of its longer side, or at least 500 m, on each side. The route search looks up to 35% of a leg's length to either side, so its whole corridor is loaded. The camera can't leave it, and can't pull back past twice the distance that shows the whole mission. Past the region's edge the map is empty.
- The status bar reports loading and missing terrain or imagery, with **Retry**. Ground with no terrain is drawn level. Imagery arrives tile by tile, and the coarser ground stays under it until it does.

### On a weak device

- Terrain is drawn only when the camera moves or a tile arrives. Crew markers move on their own, once a second.
- A view is at most 25 tiles, each a mesh of 1,089 points and one picture, with no lighting.
- When frames take longer than about 45 ms, the ground is drawn at half resolution while the camera moves and sharp again when it stops. In Chromium's software renderer that brings a frame from about 100 ms to about 40 ms at 960 by 810 pixels.
- Without WebGL the same tiles are drawn flat, seen from above, and the status bar says the map is flat. Adding `?flat` to the address asks for that on a device whose 3D is broken.

Nobody outside the team has used the viewer yet. A first walkthrough should have someone open and close the sidebar, find themselves and a teammate, locate a person, open a suit reading and say what the caution means, and press Edit and find the same mission in the planner. For recovery, have them open a damaged file, retry, and open a mission with no sites. Check that people read the dashed route as a suggestion and not the plan, and that **Data sources** makes it clear the positions and readings are simulated. Browser tests don't replace this.

## Route search

The search comes from the `alghorims` branch (`apps/api/src/terrain/engine.ts` there, ported in `src/data/route-options.ts`): A* over a terrain grid with eight neighbours, a hard slope limit, and four strategies.

| Method | What it minimises |
| --- | --- |
| Fast | Distance |
| Flat | Distance, with steep steps costing up to 5.5 times more |
| Thermal | Ground that reads cold in night infrared. Offered only where night infrared varies |
| Detour | A corridor away from the routes already found |

Each leg between two mission points gets its own grid of 61 by 29 nodes laid along the great circle between them. Terrain and night IR are read at a tile level that fits the size of a grid cell, so a leg of any length asks for about the same number of tiles. A step is impassable when it is steeper than the limit, or when the ground measured at the node it leads to is. When no path exists under the limit, the leg is drawn straight, the verdict is no-go, and it names the lowest limit that would work.

Travel time is that branch's model too: distance at the flat speed, plus height gained at the climb rate, plus height lost at the descent rate. The limit presets include its two, Human in an EVA suit (7°, 2.5 km/h, 350 m/h up, 800 m/h down, 4 h) and Rover (15°, 5 km/h, 700 m/h up, 1,200 m/h down, 8 h). Their work time and walk-back range are assumed here.

Not ported: that branch's weather. Its temperature, pressure and wind limits need a weather field for the site, which comes from a 2,000-line generator and rover archives this app does not have. Thermal uses night infrared as the stand-in.

## Tasks and EVA hours

Supplies follow each phase's EVA hours per person, not the task list. Tasks are checked against those hours: if someone's EVA tasks in a phase add up to more than the phase gives them, Review shows a caution, because the extra hours would have no food, water or oxygen behind them. Tasks with nobody assigned raise a caution too.

## Files

- **Save mission file** downloads a `.mhr` packet, the format in the planner README. Sites and tasks are in it.
- **Export as JSON instead** downloads the same mission as readable JSON.
- **Open file** reads either one. Dropping a file on the window does the same. The planner checks it; a damaged file is refused with the reason and the mission on screen is left alone.

## Keys

| Keys | Action |
| --- | --- |
| Ctrl+Z | Undo |
| Ctrl+Shift+Z, Ctrl+Y | Redo |
| Ctrl+S | Save mission file |
| Ctrl+O | Open file |
| Escape | Stop placing a site |

Cmd works in place of Ctrl. One drag of a slider is one undo step.

## Where things are kept

The mission being edited and the roster are saved in the browser's localStorage. The planner service sees each draft to check and plan it, and keeps nothing. The roster starts with eight fictional sample profiles, and the mission the app opens with the first time is a fictional sample too. Both come from the planner's catalog.

Tiles the proxy downloads are cached under `data/cache`, which is not committed.

## NASA standards this follows

Two documents. What each asks for and how the app answers is below. Nobody at NASA has reviewed this, and no test with real users has been run.

### NASA-STD-3001 Volume 2, section 10, crew interfaces

Requirement text is from [the standard's page on nasa.gov](https://www.nasa.gov/reference/10-0-crew-interfaces-vol-2/).

| Requirement | In the app |
| --- | --- |
| V2 10005 Consistency | One row pattern for crew, phases and sites. One place for the primary action. Same control for the same kind of value everywhere. |
| V2 10006 Standard nomenclature | The words crew member, phase, site, task and EVA mean one thing each, in the app, the file and the planner. The lists of roles, kinds and types come from the planner, so the two cannot drift. |
| V2 10020 Stale or missing data | When the mission cannot be planned, or the planner does not answer, a message under the top bar says so on every page, and Review says "Stale" and strikes its numbers through. |
| V2 10032 Grouping by sequence | The five stages are the order a mission is made in. |
| V2 10037 Critical information together | Review holds every result on one page, beside the sites on the planet. |
| V2 10045 Colour never the only cue | The current stage's tab is also bold and raised. Open rows show a check mark. Cautions start with the word. The selected site is larger and checked. Changes show a plus or minus. |
| V2 10046 Units on every number | Every value shows its unit, or its column heading does. |
| V2 10060, 10063 Labels, next to the item | Every control has a label directly above it. |
| V2 10069 Hazardous controls coded | Remove buttons have a dashed edge and say what they remove. |
| V2 10080 Confirmation before irreversible commands | Deleting a roster entry, the one action undo cannot bring back, needs a second press. |
| V2 10113 No mental computation | Totals, margins, recycling shares and time on the link are worked out and shown. |
| V2 10115 Out-of-tolerance notices | EVA tasks beyond a phase's hours, and tasks with nobody assigned, raise cautions. |
| V2 10129, 10131 Backup and recovery | The draft is saved after every valid edit and comes back after a reload or crash. Undo holds 200 steps. |

Not met: V2 10066 asks for labels of at least 12 point, which is 16 CSS pixels. The visual language in `docs/visual-language.md` sets value labels at 11 px, and the app follows it.

Not covered: the tables in that section are images on the page and were not read, so response times (V2 10022), display parameters (V2 10048) and control spacing (V2 10070) are unchecked. Appendix F, the display standard behind V2 10150, was not read either.

Contrast against Section 508 (WCAG AA, 4.5:1), which NASA sites have to meet: labels use the muted text colour, 6.3:1 or better on every surface. Text on the red button is 4.5:1. The dim colour, 3.4:1 to 3.8:1, is used only for the corner brackets and arrow glyphs, not for anything you have to read.

### NASA TM-1998-208470, Field Guide for Designing Human Interaction With Intelligent Systems

[The guide](https://ntrs.nasa.gov/citations/19980210012) is about method: goals, a task description, scenarios, prototypes and evaluation. [docs/design.md](docs/design.md) holds those products for this app. It also says what a system that works things out for a person owes that person:

| The guide asks | In the app |
| --- | --- |
| Keep the user informed of "controls issued" and "effects of controls issued" (4.2) | A message with an Undo after every edit that changes more than the field edited. |
| Tell the user what the system did on its own (4.2, 4.5) | A "Done" message whenever the planner changes something you did not touch: phases replaced by a new type, tasks left without a person, tasks moved or removed with a phase or site. It carries an Undo. |
| "Making raw data continually available" (4.5) | Review has "How these numbers are worked out", with the rates. Each crew member shows their needs per day. |
| The user can "override individual conclusions" and "take over" (5.2.2) | Every preset value can be changed. Nothing the planner fills in is locked. |
| Help the user respond to an interruption, with priorities (4.5) | Three levels: cannot plan, caution, done. A problem in another step comes with a link to that step. |
| Prevention, reversal and recovery from human error (5.2.2) | Ranges on every field, undo, autosave, checksum on files. |

## Layout

```
src/            Editor, in React and TypeScript
  App.tsx       Start-up, the editor's state, the layout
  api.ts        The planner's JSON shapes and its three calls
  state.ts      Edits to a draft, undo history, what is saved in the browser
  steps/        One file per stage: mission, crew, phases, sites, review
  components/   The Sites map and its panels, form controls, portraits
  data/         Map data: terrain, imagery, routes, science layers, landing sites
  cache/        Service worker registration for map tiles
  globe/        The Review globe: mission site markers, loading status
  assets/crew/  Crew portraits, one file per call sign
apps/api/       Go: planner, hr-planner command line, API server, tile proxy
scripts/        Go API launcher for Vite, basemap tile download, gofmt check
public/tiles/   Low zoom levels of the Viking basemap
docs/           Visual language, design notes for the editor
data/           Dataset notes in SOURCES.md. The tile cache lands here and is not committed
```

`src/styles.css` holds the console's base styles and loads the tokens from `src/tokens.css`. `src/components/plan-panel.css` holds the slicer look of the plan panel. `src/planner.css` adds what the mission pages need in that look: the stage tabs, form rows, messages and the plan bar.

## Dependencies

`react`, `react-dom`, `cesium` and two font packages at run time. `vite`, `@vitejs/plugin-react`, `vite-plugin-static-copy` (for Cesium's workers and assets), `typescript` and type packages for development. The Go code uses the standard library only.
