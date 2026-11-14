# Mission planner

Plans what a crew needs for a mission: food energy and nutrients, water, oxygen and electricity. You describe the crew, the phases of the mission and the places the crew works at, and the planner works out the supplies and packs the mission into one small file.

It has three parts:

- The planner, in Go, in `apps/api/internal/planner`. It has a command line and an HTTP API. Its [README](apps/api/internal/planner/README.md) covers the model, the mission file format, the sources of every rate and the limits.
- The editor, in React and TypeScript, in `src`. A mission is made in five stages, each its own page with a tab in the top bar: Mission, Crew, Phases, Sites and Review. Sites is the 3D Mars map with EVA route planning, map tools and science layers.
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

Typecheck runs `tsc` on the editor and compiles the Go packages. Lint runs `go vet` and checks `gofmt`. Tests cover the globe helpers and the API launcher, and run Go's race detector on the planner and the tile proxy. The editor's components have no automated tests.

## Making a mission

The Mission page is where a mission starts: name it, or press **Start a new mission** or **Open mission file**. **Next** at the bottom of a page goes to the next stage, and the tabs in the top bar go to any of them. The address keeps the stage, so reload and the back button work.

| Stage | What you do |
| --- | --- |
| Mission | Name it, pick the type, set the margin on supplies. The type fills in the phases. The second card says what the mission holds and links to each stage. |
| Crew | Add people, by hand or from the roster. Open a row to edit a profile and see that person's needs per day. A portrait shows when `src/assets/crew` has a file named after the call sign. |
| Phases | Set each phase's length, recycling, EVA hours and power. Drag a phase by its grip to reorder. A changed value turns blue and offers the preset back. |
| Sites | Plan an EVA on the map: start, target, waypoints, limits, a go or no-go verdict. **Add EVA to mission** makes a site at the target with one EVA task as long as the walk and the work. Sites and tasks are listed on the right. |
| Review | Cautions, totals, loads on the vehicle, tables by phase and by crew, with the mission's sites on Mars beside them. Save the mission file here. |

A stage with a problem in it is marked **Fix** on its tab. The Review tab shows how many cautions are waiting.

### How the stages fit together

One mission is shared by every page, with one undo history. The plan under the Mission, Crew and Phases pages shows what each edit did to the supplies. An EVA assessed on the Sites map becomes a task, and its hours are checked against the EVA hours of its phase, so a route that is too long shows up as a caution in Review. The task note carries the route's verdict, distance and steepest slope.

## The globe

- Terrain is NASA Mars Trek's elevation tileset. The cursor readout gives elevation above the MOLA areoid.
- Imagery is the Viking colour mosaic far out and CTX at about 5 m per pixel close in. The low zoom levels of Viking are in `public/tiles`; `bun run tiles` downloads any that are missing. CTX and terrain come through the caching proxy in `apps/api`. `data/SOURCES.md` describes each dataset.
- Drag to pan, scroll to zoom, right-drag to tilt. The buttons on the right face north, switch between tilted and straight down, and zoom.
- Elevation scale switches between 1× and 3×. The 3× view exaggerates slopes and is for looking, not for judging them.

The status bar reports loading, missing terrain or imagery, and when the older CTX mosaic has been swapped in. Retry rebuilds the globe and keeps the mission.

Coordinates are planetocentric latitude and east-positive longitude on the sphere the terrain tiles use. Sites are stored with longitude from -180 to 180; the screen shows 0 to 360 east, the usual convention for Mars.

Mission sites are points with a label: number, name, task count. The selected one is larger, red, and its label starts with a check mark. On the Review globe the readout says "Terrain safety not assessed" for every site. Slope is checked only along an EVA route planned on the Sites page.

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
| V2 10020 Stale or missing data | When the mission cannot be planned, or the planner does not answer, the plan bar says "Stale" and strikes its numbers through. |
| V2 10032 Grouping by sequence | The five stages are the order a mission is made in. |
| V2 10037 Critical information together | The plan bar is under the Mission, Crew and Phases pages, and Review shows the same totals. |
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
| Keep the user informed of "controls issued" and "effects of controls issued" (4.2) | Under each number in the plan bar, the change the last edit made. |
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
  components/   The Sites map and its panels, form controls, the plan bar, portraits
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
