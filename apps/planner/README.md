# Mission planner

An editor for missions. The planner itself is Go, in `apps/api/internal/planner`; this app asks it over HTTP after every edit and holds no planning logic of its own. The 3D Mars globe from the map app is in the middle. You build the mission in five steps on the left, and the bar under the globe shows what the mission needs as you go.

## Run it

You need Go 1.24 or newer on your PATH, as the map app does.

```sh
bun install            # once, in the repo root
cd apps/planner
bun install
bun run dev
```

Then open the address Vite prints. The dev server builds and starts the Go API by itself, through `scripts/api-server.js`, and forwards `/api` to it: map tiles and the planner both.

`bun run build` writes the frontend to `dist/`, and `bun run typecheck` checks the types. The built frontend needs the API server behind it; `vite preview` starts one.

If the planner cannot be reached, the editor says so and offers a retry. If it stops answering while you work, the editor keeps your edits, marks the numbers as stale, and plans again when it is back.

## Making a mission

Press **New mission**. The cursor lands in the name field of step 1, and **Next** at the bottom of the panel walks through the rest. You can also jump to any step from the row of five at the top.

| Step | What you do |
| --- | --- |
| 1 Mission | Name it, pick the type, set the margin on supplies. The type fills in the phases. |
| 2 Crew | Add people, by hand or from the roster. Open a row to edit a profile and see that person's needs per day. |
| 3 Phases | Set each phase's length, recycling, EVA hours and power. A changed value shows a link back to the preset. |
| 4 Sites | Press Add site, click the ground. Open the site to name it and give it tasks: kind, length, who, which phase, EVA or inside. Drag a marker to move a site. |
| 5 Review | Cautions, totals, loads on the vehicle, tables by phase and by crew, the file size. Save the mission file here. |

A step with a problem in it is marked **Fix** in the row of steps. Review shows how many cautions are waiting.

## The globe

The globe is the map app's: the same terrain, imagery, camera controls and loading status, imported from `src/` in the repo root. Nothing in those files was changed.

- Terrain is NASA Mars Trek's elevation tileset. The cursor readout gives elevation above the MOLA areoid.
- Imagery is the Viking colour mosaic far out and CTX at about 5 m per pixel close in. Both come through the caching proxy in `apps/api`.
- Drag to pan, scroll to zoom, right-drag to tilt. The buttons on the right face north, switch between tilted and straight down, and zoom.
- Elevation scale switches between 1× and 3×. The 3× view exaggerates slopes and is for looking, not for judging them.

The status bar reports loading, missing terrain or imagery, and when the older CTX mosaic has been swapped in. Retry rebuilds the globe and keeps the mission.

Coordinates are planetocentric latitude and east-positive longitude on the sphere the terrain tiles use. Sites are stored with longitude from -180 to 180; the screen shows 0 to 360 east, the usual convention for Mars.

Sites are points with a label: number, name, task count. The selected one is larger, red, and its label starts with a check mark. Clicking a marker in any step opens that site in step 4. The readout says "Terrain safety not assessed" for every site, because nothing here checks slope or hazards.

The viewer setup in `src/components/GlobeCanvas.tsx` repeats about sixty lines of `createViewer` from the map app's `MarsGlobe.jsx`, which does not export it. Once that branch is on main the two should share one.

## Tasks and EVA hours

Supplies follow each phase's EVA hours per person, not the task list. Tasks are checked against those hours: if someone's EVA tasks in a phase add up to more than the phase gives them, Review shows a caution, because the extra hours would have no food, water or oxygen behind them. Tasks with nobody assigned raise a caution too.

## Files

- **Save mission file** downloads a `.mhr` packet, the format in `apps/api/internal/planner/README.md`. Sites and tasks are in it.
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

## NASA standards this follows

Two documents. What each asks for and how the app answers is below. Nobody at NASA has reviewed this, and no test with real users has been run.

### NASA-STD-3001 Volume 2, section 10, crew interfaces

Requirement text is from [the standard's page on nasa.gov](https://www.nasa.gov/reference/10-0-crew-interfaces-vol-2/).

| Requirement | In the app |
| --- | --- |
| V2 10005 Consistency | One row pattern for crew, phases and sites. One place for the primary action. Same control for the same kind of value everywhere. |
| V2 10006 Standard nomenclature | The words crew member, phase, site, task and EVA mean one thing each, in the app, the file and the planner. The lists of roles, kinds and types come from the planner, so the two cannot drift. |
| V2 10020 Stale or missing data | When the mission cannot be planned, or the planner does not answer, the plan bar says "Stale" and strikes its numbers through. |
| V2 10032 Grouping by sequence | The five steps are the order a mission is made in. |
| V2 10037 Critical information together | The plan bar stays on screen in every step. |
| V2 10045 Colour never the only cue | The current step is also bold and underlined. Open rows show a check mark. Cautions start with the word. The selected site is larger and checked. Changes show a plus or minus. |
| V2 10046 Units on every number | Every value shows its unit, or its column heading does. |
| V2 10060, 10063 Labels, next to the item | Every control has a label directly above it. |
| V2 10069 Hazardous controls coded | Remove buttons have a dashed edge and say what they remove. |
| V2 10080 Confirmation before irreversible commands | Deleting a roster entry, the one action undo cannot bring back, needs a second press. |
| V2 10113 No mental computation | Totals, margins, recycling shares and time on the link are worked out and shown. |
| V2 10115 Out-of-tolerance notices | EVA tasks beyond a phase's hours, and tasks with nobody assigned, raise cautions. |
| V2 10129, 10131 Backup and recovery | The draft is saved after every valid edit and comes back after a reload or crash. Undo holds 200 steps. |

Not met: V2 10066 asks for labels of at least 12 point, which is 16 CSS pixels. The shared visual language sets value labels at 11 px, and this app now follows it. An earlier version of the planner used 16 px; changing that for both apps is a decision for the visual language.

Not covered: the tables in that section are images on the page and were not read, so response times (V2 10022), display parameters (V2 10048) and control spacing (V2 10070) are unchecked. Appendix F, the display standard behind V2 10150, was not read either.

Contrast against Section 508 (WCAG AA, 4.5:1), which NASA sites have to meet: labels use the muted text colour, 6.3:1 or better on every surface. Text on the red button is 4.5:1. The dim colour, 3.4:1 to 3.8:1, is used only for the corner brackets and arrow glyphs, not for anything you have to read.

### NASA TM-1998-208470, Field Guide for Designing Human Interaction With Intelligent Systems

[The guide](https://ntrs.nasa.gov/citations/19980210012) is about method: goals, a task description, scenarios, prototypes and evaluation. `DESIGN.md` holds those products for this app. It also says what a system that works things out for a person owes that person:

| The guide asks | In the app |
| --- | --- |
| Keep the user informed of "controls issued" and "effects of controls issued" (4.2) | Under each number in the plan bar, the change the last edit made. |
| Tell the user what the system did on its own (4.2, 4.5) | A "Done" message whenever the planner changes something you did not touch: phases replaced by a new type, tasks left without a person, tasks moved or removed with a phase or site. It carries an Undo. |
| "Making raw data continually available" (4.5) | Review has "How these numbers are worked out", with the rates. Each crew member shows their needs per day. |
| The user can "override individual conclusions" and "take over" (5.2.2) | Every preset value can be changed. Nothing the planner fills in is locked. |
| Help the user respond to an interruption, with priorities (4.5) | Three levels: cannot plan, caution, done. A problem in another step comes with a link to that step. |
| Prevention, reversal and recovery from human error (5.2.2) | Ranges on every field, undo, autosave, checksum on files. |

## Design

The app loads the map app's stylesheet, `src/styles.css` in the repo root, and with it the shared tokens. Top bar, readouts, corner brackets, camera buttons, nav buttons, section headings and status bar are that stylesheet's, used as they are. `src/styles.css` here adds only what an editor needs: form fields, the row of steps, messages and the plan bar.

Three things differ from the map app, each for a reason:

- The view buttons sit bottom-left, not bottom-centre. The globe is narrower here and they would cover the altitude readout.
- Save mission file is the only button with the accent that is not a selection. The open row of a list uses the accent the way a selected site does.
- `--control-height` and `--text-data` were added to the shared tokens for form fields.

`AGENTS.md` asks to check the product scenario in Notion before adding resource calculations. No Notion connection was available while this was built, so that check has not been made.

## Dependencies

`react`, `react-dom`, `cesium` and two font packages at run time. `vite`, `@vitejs/plugin-react`, `vite-plugin-static-copy` (for Cesium's workers and assets), `typescript` and type packages for development. The globe modules and the API launcher are imported from the repo by path, not installed.
