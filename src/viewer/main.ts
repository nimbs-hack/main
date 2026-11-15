// The mission viewer: opens a mission file, shows its sites on a 3D map and
// what the mission needs, and takes small edits. It is the editor with the
// planning stages left out, for a device that cannot carry the editor's map
// library. The planner still does every calculation and writes the file.

import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-600.css'
import '@fontsource/inter/latin-700.css'
import '../tokens.css'
import './viewer.css'
import { type Mission, type Planned, PlannerError, type Task, decodeFile, fetchCatalog, fileBytes, plainWords, requestPlan } from '../api'
import { registerMapCache } from '../cache/map-cache.js'
import { download, fileStem, readMissionFile } from '../files'
import { formatLatLon } from '../format.js'
import { kcal, kwh, meters, num, range, words } from '../numbers'
import { siteLegs, totalLegs } from '../steps/legs'
import { type Child, h } from './dom'
import { type MapStatus, createMap } from './map'

interface Doc {
  fileName: string
  // The planner's last answer.
  planned: Planned
  // The mission as edited. It is planned.mission unless the planner has not
  // answered for the latest edit, or refused it.
  draft: Mission
  // Earlier drafts, for undo.
  past: Mission[]
  // The mission as opened or last saved, as JSON.
  clean: string
}

const STORE = 'nimbs.viewer.file'
const SECONDS_PER_DAY = 86400
const TABS = [
  ['overview', 'Overview'],
  ['sites', 'Sites'],
  ['crew', 'Crew'],
  ['phases', 'Phases'],
  ['briefing', 'Briefing'],
] as const

let doc: Doc | null = null
// The file that was open before this one, kept while it had unsaved edits.
let previous: Doc | null = null
let tab: (typeof TABS)[number][0] = 'overview'
let selected = -1
// Why the planner refused the latest edit, and why it did not answer.
let problem: string | null = null
let offline: string | null = null
// Why a file did not open, and how to try it again.
let fileProblem: { text: string; retry: () => void } | null = null
let opening: string | null = null
let controller: AbortController | null = null

const edited = () => doc !== null && JSON.stringify(doc.draft) !== doc.clean
const count = (n: number, thing: string) => `${n} ${thing}${n === 1 ? '' : 's'}`
// An empty field is not zero.
const number = (text: string) => (text.trim() === '' ? NaN : Number(text))

// Page skeleton. These nodes stay. render() fills them.

const fileInput = h('input', {
  type: 'file',
  accept: '.mhr,.json,application/json',
  hidden: true,
  onchange: () => {
    openFile(fileInput.files?.[0])
    fileInput.value = ''
  },
})
const title = h('div', { class: 'bar__title' })
const undoButton = h('button', { type: 'button', class: 'button', 'data-tip': 'Ctrl+Z', onclick: undo }, 'Undo')
const saveButton = h('button', { type: 'button', class: 'button', 'data-tip': 'Ctrl+S', onclick: save }, 'Save file')
const alerts = h('div', { class: 'alerts' })
const tabs = h('nav', { class: 'tabs', 'aria-label': 'Sections' })
const body = h('div', { class: 'panel__body' })
const panel = h('aside', { class: 'panel' }, tabs, body)
const mapRoot = h('main', { class: 'map' })
const tileState = h('span', { role: 'status' })
const scaleBar = h('span', { class: 'scale' })
const scaleLabel = h('span')
const scale = h('span', { class: 'status__scale', title: 'At the middle of the map' }, scaleBar, scaleLabel)
const cursor = h('span', { class: 'status__cursor' })

document.getElementById('viewer')!.append(
  h(
    'header',
    { class: 'bar' },
    title,
    h('button', { type: 'button', class: 'button', 'data-tip': 'Ctrl+O', onclick: () => fileInput.click() }, 'Open'),
    undoButton,
    saveButton,
    fileInput,
  ),
  alerts,
  panel,
  mapRoot,
  h(
    'footer',
    { class: 'status' },
    tileState,
    h(
      'details',
      { class: 'credits' },
      h('summary', null, 'Data attribution'),
      h(
        'div',
        null,
        h('p', null, 'Imagery: CTX global mosaic, NASA / JPL / MSSS / The Murray Lab. Tiles: Esri.'),
        h('p', null, 'Close imagery at the rover sites: HiRISE, NASA / JPL / University of Arizona. Tiles: NASA Mars Trek.'),
        h('p', null, 'Terrain: NASA / JPL-Caltech Mars Trek.'),
      ),
    ),
    scale,
    cursor,
  ),
)

const map = createMap(mapRoot, {
  select(site) {
    selected = site
    tab = 'sites'
    renderPanel()
    document.getElementById(`site-${site}`)?.scrollIntoView({ block: 'nearest' })
  },
  status(state: MapStatus) {
    const missing = state.terrainMissing
      ? 'Terrain missing in places. The ground there is drawn level.'
      : state.imageryMissing
        ? 'Map imagery missing in places.'
        : ''
    tileState.replaceChildren(
      ...[
        missing || (state.loading ? 'Loading the map' : ''),
        missing && h('button', { type: 'button', class: 'link', onclick: () => map.retry() }, 'Retry'),
        state.flat && 'The map is flat: 3D is off or not available on this device.',
      ].filter((part): part is string | HTMLButtonElement => Boolean(part)),
    )
  },
  cursor(text) {
    cursor.textContent = text
  },
  scale(pixelsPerMeter) {
    // The longest round length that fits in 110 pixels.
    const longest = 110 / pixelsPerMeter
    const decade = 10 ** Math.floor(Math.log10(longest))
    const length = [5, 2, 1].find((n) => n * decade <= longest)! * decade
    scaleBar.style.width = `${length * pixelsPerMeter}px`
    scaleLabel.textContent = length >= 1000 ? `${num(length / 1000)} km` : `${num(length)} m`
  },
})

// Opening, planning and saving.

function keep() {
  if (!doc) return
  try {
    localStorage.setItem(STORE, JSON.stringify({ fileName: doc.fileName, file: doc.planned.file, clean: doc.clean }))
  } catch {
    // A blocked or full browser store must not stop the viewer.
  }
}

function show(next: Doc) {
  controller?.abort()
  previous = edited() ? doc : null
  doc = next
  problem = offline = fileProblem = null
  selected = -1
  keep()
  map.show(next.draft.sites, next.draft.markers ?? [])
  render()
}

// Reads a mission and asks the planner about it. `clean` is the saved state
// of a mission restored from this browser, which may hold unsaved edits.
async function open(fileName: string, read: () => Promise<Mission>, clean?: string) {
  opening = fileName
  fileProblem = null
  render()
  try {
    const planned = await requestPlan(await read())
    opening = null
    show({ fileName, planned, draft: planned.mission, past: [], clean: clean ?? JSON.stringify(planned.mission) })
  } catch (error) {
    opening = null
    // The planner says what is wrong with a mission. Anything else is the
    // browser failing to read the file.
    const reason = error instanceof PlannerError ? plainWords(error.message) : 'the file could not be read'
    fileProblem = { text: `Could not open ${fileName}: ${reason}.`, retry: () => void open(fileName, read, clean) }
    render()
  }
}

function openFile(file: File | undefined) {
  if (file) void open(file.name, () => readMissionFile(file, []))
}

// Asks the planner about the draft. A newer edit cancels an older request,
// so answers cannot arrive out of order.
async function replan() {
  if (!doc) return
  controller?.abort()
  const mine = (controller = new AbortController())
  const asked = doc
  try {
    asked.planned = await requestPlan(asked.draft, undefined, mine.signal)
    asked.draft = asked.planned.mission
    problem = offline = null
    keep()
  } catch (error) {
    if (mine.signal.aborted) return
    if (error instanceof PlannerError && error.kind === 'invalid') {
      problem = error.message
      offline = null
    } else {
      offline = error instanceof Error ? error.message : 'unknown failure'
    }
  }
  if (asked === doc) render()
}

function edit(change: (mission: Mission) => Mission) {
  if (!doc) return
  doc.past.push(doc.draft)
  doc.draft = change(doc.draft)
  void replan()
}

const editTask = (index: number, patch: Partial<Task>) =>
  edit((mission) => ({ ...mission, tasks: mission.tasks.map((task, i) => (i === index ? { ...task, ...patch } : task)) }))

function undo() {
  const before = doc?.past.pop()
  if (!doc || !before) return
  doc.draft = before
  void replan()
}

function save() {
  if (!doc || doc.draft !== doc.planned.mission) return
  download(`${fileStem(doc.planned.mission)}.mhr`, fileBytes(doc.planned), 'application/octet-stream')
  doc.clean = JSON.stringify(doc.draft)
  keep()
  render()
}

// Small pieces of the panel.

const amount = (value: string, unit: string): Child => [value, h('span', { class: 'unit' }, ` ${unit}`)]
const row = (label: string, value: Child, caveat?: string) =>
  h('div', { class: 'row' }, h('span', { class: 'row__label' }, label), h('span', { class: 'row__value', title: caveat }, value))
const section = (heading: string, ...children: Child[]) => h('section', null, h('h2', null, heading), children)

// Commits what was typed on Enter or on leaving the field. `key` finds the
// field again after the panel is rebuilt, and `data-committed` tells typing
// that is still in progress from a value already sent to the planner.
function typed<T extends HTMLInputElement | HTMLTextAreaElement>(input: T, key: string, value: string, commit: (text: string) => void): T {
  input.dataset.key = key
  input.dataset.committed = value
  const done = () => {
    if (input.value === input.dataset.committed) return
    input.dataset.committed = input.value
    commit(input.value)
  }
  input.addEventListener('change', done)
  input.addEventListener('blur', done)
  return input
}

// A value that can be typed over, in a box with its unit.
function field(key: string, value: string | number, commit: (text: string) => void, attributes: Record<string, string | number>, unit?: string) {
  return h('span', { class: 'field' }, typed(h('input', { value, ...attributes }), key, String(value), commit), unit && h('span', { class: 'unit' }, unit))
}
const fieldRow = (label: string, control: Node) => h('label', { class: 'row' }, h('span', { class: 'row__label' }, label), control)
// The planner knows the limits and says them when a value is outside.
const typedNumber = (step: number) => ({ type: 'number', inputmode: 'decimal', step })
const typedText = { type: 'text', maxlength: 31, class: 'field__text' }

function overview({ planned, draft }: Doc): Child {
  const { plan, cautions, mission } = planned
  const { total, provision } = plan
  const seconds = plan.days * SECONDS_PER_DAY
  const recycled = (used: number, supplied: number) => (used > 0 ? `${Math.round((1 - supplied / used) * 100)}% recycled` : '')
  const readout = (label: string, value: number, unit: string, sub: string) =>
    h(
      'div',
      { class: 'readout' },
      h('span', { class: 'readout__label' }, label),
      h('span', { class: 'readout__value' }, amount(num(value), unit)),
      h('span', { class: 'readout__sub' }, sub),
    )
  return [
    cautions.length > 0 && h('ul', { class: 'cautions', 'aria-label': 'Cautions' }, cautions.map((text) => h('li', null, text))),
    h(
      'section',
      null,
      fieldRow('Name', field('name', draft.name, (name) => edit((m) => ({ ...m, name })), typedText)),
      row('Type', words(mission.type)),
      fieldRow('Margin', field('margin', draft.marginPercent, (text) => edit((m) => ({ ...m, marginPercent: number(text) })), typedNumber(1), '%')),
      row('Length', amount(num(plan.days), 'days')),
      row('Crew', num(mission.crew.length)),
    ),
    section(
      `To supply, ${plan.marginPercent}% margin included`,
      h(
        'div',
        { class: 'readouts' },
        readout('Food, packaged', provision.foodKg, 'kg', `${num(kcal(provision.foodEnergyMJ) / 1e6, 2)} Gcal`),
        readout('Water', provision.waterSupplyKg, 'kg', recycled(total.waterUsedKg, total.waterSupplyKg)),
        readout('Oxygen', provision.oxygenSupplyKg, 'kg', recycled(total.oxygenUsedKg, total.oxygenSupplyKg)),
        readout('Electricity', kwh(provision.electricityMJ), 'kWh', `${num((total.electricityMJ * 1000) / seconds, 2)} kW average`),
      ),
    ),
    section(
      'Loads on the vehicle',
      row('Carbon dioxide to remove', amount(num(total.co2Kg), 'kg')),
      row('Body heat to reject, average', amount(num((total.heatMJ * 1e6) / seconds), 'W')),
      row('EVA, all crew', amount(num(total.evaHours), 'h')),
    ),
    section('Mission file', row('Size', amount(num(planned.fileBytes), 'bytes'))),
  ]
}

function taskCard(mission: Mission, task: Task, index: number) {
  return h(
    'div',
    { class: 'task' },
    h('h3', null, `${words(task.kind)}, ${task.eva ? 'EVA' : 'inside'}, phase ${task.phase + 1}`),
    fieldRow(
      'Hours',
      field(`task-${index}-hours`, task.hours, (text) => editTask(index, { hours: number(text) }), { ...typedNumber(0.5), title: 'For each person on the task' }, 'h'),
    ),
    h(
      'div',
      { class: 'row' },
      h('span', { class: 'row__label' }, 'Crew'),
      h(
        'span',
        { class: 'checks' },
        mission.crew.map((person, member) =>
          h(
            'label',
            { class: 'check' },
            h('input', {
              type: 'checkbox',
              'data-key': `task-${index}-crew-${member}`,
              checked: task.crew.includes(member),
              onchange: () =>
                editTask(index, {
                  crew: task.crew.includes(member) ? task.crew.filter((other) => other !== member) : [...task.crew, member].sort((a, b) => a - b),
                }),
            }),
            person.name,
          ),
        ),
      ),
    ),
    fieldRow('Note', field(`task-${index}-note`, task.note, (note) => editTask(index, { note }), typedText)),
  )
}

function sitesTab({ draft }: Doc): Child {
  if (draft.sites.length === 0) return h('p', { class: 'note' }, 'This mission has no sites.')
  const legs = siteLegs(draft.sites)
  return [
    draft.sites.map((site, i) => {
      const leg = legs[i]
      return h(
        'section',
        { class: 'site', id: `site-${i}` },
        h(
          'div',
          { class: 'site__head' },
          h(
            'button',
            {
              type: 'button',
              class: 'site__name',
              'aria-pressed': i === selected ? 'true' : 'false',
              onclick: () => {
                selected = i
                map.select(i)
                renderPanel()
              },
            },
            `${i + 1} ${site.name}`,
          ),
          typeof leg === 'number' && h('span', { class: 'site__leg' }, `${meters(leg)} from ${draft.sites[i - 1]!.name}`),
        ),
        h('p', { class: 'site__place' }, formatLatLon(site.lat, site.lon)),
        draft.tasks.map((task, index) => task.site === i && taskCard(draft, task, index)),
      )
    }),
    h(
      'section',
      null,
      row('Through all sites', meters(totalLegs(legs)), 'Straight lines between sites over the Mars sphere. Not a walked route.'),
      row('Tasks', num(draft.tasks.length)),
      row('Task hours', amount(num(draft.tasks.reduce((sum, task) => sum + task.hours, 0), 1), 'h')),
    ),
    (draft.markers?.length ?? 0) > 0 &&
      section(
        'Symbols',
        h(
          'ul',
          { class: 'symbols' },
          draft.markers!.map((marker) =>
            h(
              'li',
              null,
              h('button', { type: 'button', class: 'link', onclick: () => map.lookAt(marker.point[0], marker.point[1]) }, marker.label || 'Unnamed symbol'),
              h('span', { class: 'site__place' }, formatLatLon(marker.point[0], marker.point[1])),
            ),
          ),
        ),
      ),
  ]
}

function crewTab({ planned }: Doc): Child {
  const { plan, mission } = planned
  const kg = (value: number) => amount(num(value, 1), 'kg')
  return plan.crew.map((member, i) => {
    const { daily, total, taskHours } = member
    const over = member.doseSv > plan.doseLimitSv
    const dose =
      'Measured rates by phase: cruise, station, Moon or Mars surface. Habitat time uses the unshielded surface rate, ' +
      'so it is an upper bound. A solar particle event adds to it.' +
      (plan.doseUnknownDays > 0 ? ` Leaves out ${num(plan.doseUnknownDays)} days of custom phases.` : '')
    return h(
      'details',
      { class: 'person' },
      h(
        'summary',
        null,
        h('span', { class: 'person__name' }, member.name),
        h('span', { class: 'person__role' }, words(mission.crew[i]?.role ?? '')),
        h('span', { class: over ? 'is-hazard' : null }, amount(num(member.doseSv * 1000), 'mSv')),
        h('span', { class: 'person__more' }, 'Details'),
      ),
      h('h3', null, `Whole mission, ${num(plan.days)} days, before margin`),
      row('Food, packaged', kg(total.foodKg)),
      row('Water to supply after recycling', kg(total.waterSupplyKg)),
      row('Oxygen to supply after recycling', kg(total.oxygenSupplyKg)),
      row('Carbon dioxide to remove', kg(total.co2Kg)),
      row('EVA', amount(num(total.evaHours, 1), 'h')),
      row('Tasks assigned, outside', amount(num(taskHours.eva, 1), 'h')),
      row('Tasks assigned, inside', amount(num(taskHours.inside, 1), 'h')),
      row(
        'Radiation, quiet sun',
        h('span', { class: over ? 'is-hazard' : null }, amount(`${num(member.doseSv * 1000)} of ${num(plan.doseLimitSv * 1000)}`, 'mSv career')),
        dose,
      ),
      h('h3', null, 'Per day inside'),
      row('Food energy', amount(num(kcal(daily.foodEnergyMJ)), 'kcal')),
      row('Protein', amount(range(daily.proteinG), 'g')),
      row('Carbohydrate', amount(range(daily.carbohydrateG), 'g')),
      row('Fat', amount(range(daily.fatG), 'g')),
      row('Fluid', amount(num(daily.fluidL, 2), 'L')),
    )
  })
}

function phasesTab({ planned, draft }: Doc): Child {
  const cell = (text: string) => h('td', null, text)
  return section(
    'To supply by phase, before margin',
    h(
      'table',
      { class: 'table' },
      h('thead', null, h('tr', null, ['Phase', 'Days', 'Food kg', 'Water kg', 'Oxygen kg'].map((name) => h('th', { scope: 'col' }, name)))),
      h(
        'tbody',
        null,
        draft.phases.map((phase, i) => {
          const total = planned.plan.phases[i]?.total
          return h(
            'tr',
            null,
            h('th', { scope: 'row' }, `${i + 1} ${words(phase.kind)}`),
            h(
              'td',
              null,
              field(`phase-${i}-days`, phase.days, (text) => edit((m) => ({ ...m, phases: m.phases.map((other, n) => (n === i ? { ...other, days: number(text) } : other)) })), {
                ...typedNumber(1),
                'aria-label': `Days in phase ${i + 1}`,
              }),
            ),
            cell(total ? num(total.foodKg) : ''),
            cell(total ? num(total.waterSupplyKg) : ''),
            cell(total ? num(total.oxygenSupplyKg) : ''),
          )
        }),
      ),
    ),
  )
}

function briefingTab({ draft }: Doc): Child {
  const briefing = draft.briefing ?? ''
  const area = h('textarea', { class: 'briefing', 'aria-label': 'Briefing', placeholder: 'This file has no briefing.' }, briefing)
  return typed(area, 'briefing', briefing, (text) => edit((m) => ({ ...m, briefing: text })))
}

const PAGES = { overview, sites: sitesTab, crew: crewTab, phases: phasesTab, briefing: briefingTab }

// Rendering. The panel is rebuilt whole. A field being typed in keeps its
// focus and its text across the rebuild.

function renderPanel() {
  tabs.hidden = doc === null
  if (!doc) {
    body.replaceChildren(
      h(
        'div',
        { class: 'empty' },
        opening
          ? h('p', { role: 'status' }, `Opening ${opening}`)
          : [
              h('p', null, 'Open a mission file to see its sites, its crew and what it needs. You can also drop a .mhr file anywhere on this page.'),
              h('button', { type: 'button', class: 'button button--primary', onclick: () => fileInput.click() }, 'Open a mission file'),
              h(
                'button',
                { type: 'button', class: 'button', onclick: () => void open('Example mission', async () => (await fetchCatalog()).example) },
                'Open the example mission',
              ),
            ],
      ),
    )
    return
  }
  const cautions = doc.planned.cautions.length
  tabs.replaceChildren(
    ...TABS.map(([id, label]) =>
      h(
        'button',
        {
          type: 'button',
          'aria-current': id === tab ? 'page' : null,
          onclick: () => {
            tab = id
            renderPanel()
          },
        },
        label,
        id === 'overview' && cautions > 0 && h('span', { class: 'tabs__flag' }, count(cautions, 'caution')),
      ),
    ),
  )
  const focused = body.contains(document.activeElement) ? (document.activeElement as HTMLInputElement) : null
  const key = focused?.dataset.key
  const scroll = body.scrollTop
  body.replaceChildren(h('div', { class: 'page' }, PAGES[tab](doc)))
  body.scrollTop = scroll
  const again = key ? body.querySelector<HTMLInputElement>(`[data-key="${key}"]`) : null
  if (again && focused) {
    // Typing the planner has not seen yet carries over. A committed value
    // gives way to what the planner made of it.
    if (focused.dataset.committed !== undefined && focused.value !== focused.dataset.committed) again.value = focused.value
    again.focus()
  }
}

function render() {
  const dirty = edited()
  title.replaceChildren(
    ...(doc
      ? [h('strong', null, doc.draft.name || 'Unnamed mission'), h('span', { class: 'bar__file' }, doc.fileName), dirty ? h('span', { class: 'bar__edited' }, 'Edited, not saved') : '']
      : [h('strong', null, 'Mission viewer')]),
  )
  scale.hidden = !doc
  undoButton.disabled = !doc || doc.past.length === 0
  saveButton.disabled = !doc || doc.draft !== doc.planned.mission
  saveButton.classList.toggle('button--primary', dirty)
  panel.classList.toggle('is-stale', problem !== null || offline !== null)

  const alert = (word: string, text: string, ...actions: Array<[string, () => void]>) =>
    h(
      'p',
      { role: 'alert' },
      h('b', null, word),
      text,
      actions.map(([label, act]) => h('button', { type: 'button', class: 'link', onclick: act }, label)),
    )
  const dismiss = (act: () => void): [string, () => void] => [
    'Dismiss',
    () => {
      act()
      render()
    },
  ]
  alerts.replaceChildren(
    ...[
      offline && alert('Planner not answering', `The numbers shown are from the last answer it gave: ${offline}.`, ['Retry', () => void replan()]),
      problem && alert('Cannot plan this edit', `${plainWords(problem)}. The numbers shown are from before it.`, ['Undo the edit', undo]),
      fileProblem && alert('Caution', fileProblem.text, ['Retry', fileProblem.retry], dismiss(() => (fileProblem = null))),
      previous &&
        alert(
          'Unsaved edits',
          `${previous.fileName} had edits that were not saved to a file.`,
          ['Go back to it', () => previous && show(previous)],
          dismiss(() => (previous = null)),
        ),
    ].filter((node): node is HTMLParagraphElement => Boolean(node)),
  )
  renderPanel()
}

// The whole page takes a dropped file.
document.addEventListener('dragover', (event) => event.preventDefault())
document.addEventListener('drop', (event) => {
  event.preventDefault()
  openFile(event.dataTransfer?.files[0])
})

document.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey)) return
  // The letter typed, or on a keyboard layout without Latin letters, the key
  // in that letter's place.
  const letter = /^[a-z]$/i.test(event.key) ? event.key.toLowerCase() : event.code.replace(/^Key/, '').toLowerCase()
  // Inside a field, Ctrl+Z belongs to the text being typed.
  if (letter === 'z' && !(event.target as HTMLElement).matches('input, textarea')) undo()
  else if (letter === 's') save()
  else if (letter === 'o') fileInput.click()
  else return
  event.preventDefault()
})

registerMapCache()
render()

// The file from the last visit opens again, with the edits it had.
try {
  const stored = JSON.parse(localStorage.getItem(STORE) ?? 'null') as { fileName?: unknown; file?: unknown; clean?: unknown } | null
  if (stored && typeof stored.fileName === 'string' && typeof stored.file === 'string') {
    const bytes = Uint8Array.from(atob(stored.file), (char) => char.charCodeAt(0))
    void open(stored.fileName, () => decodeFile(bytes), typeof stored.clean === 'string' ? stored.clean : undefined)
  }
} catch {
  // Nothing usable was stored.
}
