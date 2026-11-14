# AGENTS.md

Instructions for coding agents (Claude Code, Codex) working in this repo. Read this first. Humans can read it too.

## What we're building

Team NIMBS (5 people) is building a web app for the NASA Space Apps 2026 challenge [Interplanetary Survival Guide: Martian Map](https://www.spaceappschallenge.org/2026/challenges/interplanetary-survival-guide-martian-map/?tab=details). The short version is Google Maps for Mars, aimed at one astronaut planning and walking one EVA.

Judges will look for these things, so keep them in mind when deciding what to build next:

- Hyperlocal over global. Mars Trek and the USGS maps already cover the whole planet. Our map is for a single site and a single route, at a zoom where boulders and slopes matter.
- At least three kinds of data layered together. Optical, thermal, spectral, topographic, radiation, atmospheric and chemical all count. More is better, and the team wants as much real data as we can get.
- Safety first. Route planning has to account for slope, rocks, suit mobility, radiation and space weather.
- Science goals. The route exists to reach something worth studying, like the boxwork formations Curiosity found on Mount Sharp.
- Ground truth. Rover images from the surface show the astronaut what a spot looks like before they get there.

Product decisions (site, science objective, form factor, layer list) live in Notion, not here. See [Context](#context).

## Context

Product context, research notes, decisions and task assignments live in Notion:

- Notion workspace: `TODO: add link`

If a Notion MCP server is connected, read the relevant pages before starting a feature. If it isn't, ask the human for the page rather than guessing at product decisions. If Notion and this file disagree, Notion wins for product questions and this file wins for code conventions. Point out the conflict so someone fixes it.

## Stack

- [Bun](https://bun.sh) for frontend tooling, package management, JavaScript tests and scripts. Don't use npm, pnpm, yarn or node.
- [Vite](https://vite.dev) for the frontend dev server and build.
- Go 1.24 or newer for the API server, using the standard library.
- The frontend uses JavaScript, JSX and TypeScript modules. Keep new TypeScript strict.

Commands:

```sh
bun install
bun run dev       # Vite starts a private Go API process
bun run build     # Frontend in dist/, API binary in bin/mars-api
bun run typecheck # Compile all Go packages
bun run lint      # go vet and gofmt checks
bun run test      # JavaScript tests and Go tests with the race detector
```

Before you say a task is done, run typecheck, lint and tests. Report a failure as a failure, with the output. Don't say "should work".

## Repo layout

```
src/            React frontend, map data and CSS tokens in src/styles.css
apps/api/       Go server, tile proxy and disk cache
scripts/        Tile download and precache scripts, Go process launcher
docs/           Visual language and other team docs
data/           Local raw and processed data. Gitignored. Never commit large files.
public/         Static assets and low-zoom imagery
.agents/skills/ Agent skills shared by Claude Code and Codex
```

## Design

Read [docs/visual-language.md](docs/visual-language.md) before building UI. Tokens are in `src/styles.css`. Use them instead of hardcoded values. If one is missing, add it and mention it in the PR.

Don't add labels, headers, badges or status indicators that carry no information. If the view is obviously the overview, it doesn't need an OVERVIEW title. The visual language doc has the full list of what to leave out.

## UI and UX rules

These came out of design reviews. They apply to every panel and plan variant. When a rule and a screenshot from a teammate disagree, ask before breaking the rule.

### Layout

The map is the product. Everything else sits around it, and floating pieces never overlap each other. Each zone has one owner:

| Zone | Owner |
| --- | --- |
| Left sidebar, `--sidebar-width` | The plan panel. Settings live here, like a slicer's settings panel. |
| Map top left | Suggested routes |
| Map top right | Current site |
| Map right edge, middle | The camera rail: camera controls, then view actions, then map tools, each section under a divider. A tool's readout opens just left of the rail. |
| Map bottom left | Layer switcher |
| Map bottom strip | Route profile |
| Below the map | Status bar |

- A new panel needs a free zone. If there isn't one, make it on demand: a menu or popover that opens from an action and closes itself.
- Information about one spot on the map goes in the right-click menu at the cursor, not a pinned card. The menu flips to stay inside the map and closes on Esc, a click outside, or any camera move.
- A left click on the ground does nothing unless a placement mode or a map tool is on. Only one of them takes clicks at a time, so turning one on turns the other off. Each says what the next click does, and Esc always ends it.
- Map tools (ruler, range rings, line of sight) draw on their own layer, keep their points while you switch between them, and are also offered from the right-click menu for the clicked spot. A tool result that could become a plan gets a button that does it, like "Use as route".
- Check layout at 1440 px wide. A narrow preview pane switches to the stacked phone layout, which hides desktop problems.

### Following known tools

Copy patterns people already know instead of inventing new ones. Copy the behavior, not the look. The look comes from `docs/visual-language.md`.

- Settings work like a 3D printer slicer (Orca, CrealityPrint). See the next section.
- The status bar works like Google Earth's. Left side: tile state only while loading or failed, then a "Data attribution" button that opens the credits. Right side: scale bar, camera height, cursor coordinates and elevation. Never show "loaded" or other steady-state text.
- The layer switcher works like Google Maps'. One tile opens a row of layer tiles with real thumbnails. Full controls (opacity, legends, sources) sit behind More.
- Route alternatives work like Google Maps directions. Every option is drawn dashed in its own color. Hovering a row or a line highlights it and shows a tooltip with name, distance and max slope. Clicking either picks it and makes it the plan. Editing the route by hand clears the pick.
- Route lines use deploy-v1's styles, kept as constants in `src/components/plan-overlay.ts`. Candidates are dashed 6 5 at 2.5 px, each dash outlined in dark at 5.5 px and 60% opacity, with the gaps left open. Every line drawn over imagery needs a dark casing or halo, or it vanishes on ground of its own color. The plan, which is the selected route, is a solid red 3.5 px line on a dark 6.5 px halo, with any stretch over the slope limit in orange on top. Start and target are square A and B pins with red and green borders.
- The right-click menu works like Google Maps'. Coordinates at the top copy on click.

### Settings panels

- An icon rail picks one tab. Only that tab's settings show. Never render all settings as one long scrolling page.
- Inside a tab, group rows under small headers, the way a slicer has "Layer height" and "Line width".
- Rows are a label on the left and a value box on the right with the unit inside the box, dim and mono. Editable boxes look different from read-only ones.
- Show the main rows by default and the rest behind an Advanced switch. Tell the user how many rows are hidden.
- Search looks across every tab and shows which tab each match lives in.
- Hidden tabs can hide problems. Put a dot on the rail icon of any tab with a value near or over a limit.
- Presets stay selected while the user edits values. Mark each changed field with `--color-modified`, give it a reset button that shows the preset value, and offer one reset for all. Don't switch the preset to "Custom" and don't add "N changed" text to the dropdown.

### Color

Each color means one thing everywhere. If a color needs a legend to read, put the explanation next to it or drop the color.

| Color | Meaning |
| --- | --- |
| `--color-accent` (red) | The primary action and the current selection. Never danger. |
| `--color-caution` (yellow) | Within 5° of the slope limit, or close to another limit |
| `--color-hazard` (orange) | Over a limit. Any of it on the route makes the plan NO-GO. |
| `--color-ok` (green) | GO, from real data only |
| `--color-modified` (blue) | Changed from the selected preset |
| `--color-route-*` | One per suggested route strategy, from deploy-v1. Detour and thermal look like caution and ok, so use them only for dashed candidate lines and their swatches, never on a number or a status. |

- Hazard colors go on the number, not on an outline around its box. Outlines added noise and nobody could say what they meant.
- New meanings get new tokens. Don't borrow a color that already means something else.

### Showing data

- One chart that combines two things beats two lanes side by side. The route profile is an elevation area filled by slope level, not an elevation lane plus a slope lane.
- Charts need a minimum vertical range, so 30 m of relief doesn't fill the height and read as a hill. Put axis values inside the chart and show exact values in a hover tooltip.
- Only show data that changes along the thing being shown. The route profile dropped Day IR, Night IR and Albedo because they barely vary across a walk.
- No footnote paragraphs in panels. Put a caveat in the tooltip of the value it qualifies. The one exception is a single line where users edit assumptions, such as the suit limits.
- Pick the unit by size: meters under 1 km, kilometers above. Coordinates are decimal degrees with east longitude 0 to 360°.
- When alternatives come out the same, collapse them into one row and say why ("Ground here varies under 2°"). Never show four identical rows.
- Every failure says what to do next. Failed tiles and samples get Retry. A route blocked by the slope limit says which limit would work and has a button that applies it.

### Comparing layouts

When the team is choosing between layouts, build each as a variant in `src/components/plan-variants/` with the same props, switchable with `?ui=<id>` and the top bar buttons. Variants share state through the parent and never fork it. Delete the losing variants once the team picks one.

## Mars data

The more real NASA data we can layer, the stronger the submission. Every dataset we use gets an entry in `data/SOURCES.md` (TODO: create it) with name, mission and instrument, URL, resolution, license or terms, and the script that fetches it.

Starting points from the challenge resources page:

- [JPL Mars Trek](https://trek.nasa.gov/mars/). Basemaps and layers over web tile services. Probably our main tile source.
- [USGS-NASA Planetary Geologic Mapping](https://astrogeology-usgs.hub.arcgis.com/pages/interactive-maps-mars). Geologic maps.
- [Curiosity's proposed path up Mount Sharp](https://science.nasa.gov/resource/curiositys-proposed-path-up-mount-sharp/). Reference for what a route map looks like.
- [Perseverance raw images](https://mars.nasa.gov/mars2020/multimedia/raw-images/). Over a million surface photos for point-of-view imagery.
- [NASA Worldview](https://worldview.earthdata.nasa.gov/). Earth only. Use it for UI ideas, not data.

Other sources worth checking: PDS Geosciences Node (MOLA, HiRISE and CTX DTMs, CRISM), HiRISE, THEMIS thermal inertia, Curiosity RAD and Perseverance MEDA for radiation and weather, MAVEN for space weather. Confirm an endpoint works before building against it. Don't write code against a URL you haven't fetched.

Rules that bite on Mars data:

- Coordinates. State the system every time you handle lon/lat. Datasets mix planetocentric and planetographic latitude, and mix 0 to 360 east-positive with -180 to 180 longitude. Normalize at ingest into one convention defined in `packages/shared` and convert nowhere else.
- Units. Store SI units (meters, kelvin, sieverts or grays per day). Convert only for display.
- Big files. HiRISE DTMs and images run to gigabytes. Download them in scripts, cache them under `data/`, and serve tiles or crops. Don't fetch raw products from the browser.
- Upstream APIs are slow and rate limited. Proxy and cache through the Go server instead of calling them from the browser.
- Mark fake data as fake. If a layer uses simulated or predicted values, label it in the UI and in code.

## Working in parallel

Up to five people, each possibly running agents, share this repo.

- One branch per task, named `<name>/<short-topic>`. Use a git worktree when an agent works alongside a human or another agent. Never commit straight to `main`.
- Keep PRs small and focused on one feature or layer. Merge often so branches don't drift.
- Shared files cause conflicts: `packages/shared`, the design tokens, root config and `bun.lock`. Touch them only when the task needs it, and mention it in the PR description.
- If `bun.lock` conflicts, take `main`'s version and rerun `bun install`. Don't hand-merge it.
- Don't reformat or refactor code outside your task.
- Don't add a dependency without saying why in the PR. Prefer what's already installed.

## Skills

Skills live in `.agents/skills/`.

- `unslop` applies to everything an agent writes: code comments, commit messages, PR descriptions, UI copy, docs and the final project writeup. No exceptions.
- `file-pr` covers opening a PR.
- `babysit-pr` covers watching a PR through review and CI.

## Writing

Apply `unslop` to all of it. In short: plain words, short sentences, sentence-case headings, no em dashes, no hype. UI copy is read by an astronaut in a suit, so labels are short and specific: "SLOPE 18°" beats "Moderate terrain difficulty".
