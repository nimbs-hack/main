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

- Notion workspace: [MarsMission Planner](https://app.notion.com/p/417268a7dcb58071b16fcd1393b6bbe4)

The [product scenario](https://app.notion.com/p/417268a7dcb5812695dae148ed16b706) still leaves the first travel profile open between a rover and walking EVA. The astronaut framing above is the intended use case, not a settled implementation choice. Check that decision before adding mobility or resource calculations.

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

### Human interaction principles

Use NASA's [Field Guide for Designing Human Interaction With Intelligent Systems](https://ntrs.nasa.gov/api/citations/19980210012/downloads/19980210012.pdf), TM-1998-208470, Thronesbery and Malin, July 1998. This is a design and evaluation method for flight-controller software, not a visual style specification or a certification standard. References below use the paper's printed page numbers, four fewer than the PDF page numbers.

- Start with a user task and a measurable outcome. Identify the decision, the information needed, and what currently makes it difficult before choosing controls. Understand the task, establish useful support, then refine presentation. Sections 2.1 and 3.2-3.4, pp. 2, 6-9.
- Name the human and software responsibilities. Show what the system is doing, what the user selected, and the effect of each action. Keep evidence available so the user can question a result. Sections 4.2, 4.4-4.5 and 7.2.2.3, pp. 13-16, 31.
- Preserve user control. Provide a clear way to stop, reject, revise, or recover from automation where that automation exists. Recovery must preserve useful work. Sections 4.5 and 5.2.2, pp. 16, 19-20.
- Design ordinary and failure scenarios together as the prototype matures. Cover an external data failure, a user mistake, and a software mistake separately before combining them. A warning must help the user decide what to do next. Sections 4.5 and 5.2, pp. 16, 19-21.
- Work in small iterations that address the largest task risks first. Keep task descriptions only as detailed as the next design decision requires. Use inexpensive prototypes when the interaction is still uncertain. Sections 3.4, 4.10 and 6, pp. 8-9, 18, 22-24.
- Evaluate task performance with users and domain experts. Check completion, mistakes, hesitation, interpretation, and recovery, not appearance preferences alone. Vary evaluation scenarios and include people outside the design team. Record observations and prioritize the next changes. Sections 2.3 and 7, pp. 3-4, 25-37. Automated tests do not replace this evaluation.

Apply these principles to our map as follows. These are project rules derived from the guide and our product context, not verbatim NASA requirements:

- Keep site selection, current view, data availability, and recovery controls discoverable. Selecting a site must not secretly act as a reset; use a separate global-view action.
- Distinguish rover history from a proposed expedition. Show source, coverage or resolution limits, and the last recorded sol when known. Never imply that a snapshot is live telemetry.
- Disclose automatic imagery fallback and visual terrain changes. Shading, smoothed terrain and exaggerated relief cannot establish safe slopes. Missing hazard data means unknown, not safe.
- For future planning, show the outbound and return legs, constraints, assumptions, and reasons for recommendations or rejection together. Keep inputs editable and make outdated results clear after an input changes.
- For each UI change, identify a normal scenario and a recovery scenario, check their observable outcomes, and report what still needs a human walkthrough. Keep this proportionate to the change.

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
