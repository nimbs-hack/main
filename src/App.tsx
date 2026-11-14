import { type ReactNode, Suspense, lazy, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import MapStatus from './globe/MapStatus.jsx'
import { INITIAL_MAP_STATUS, mapStatusReducer } from './globe/map-status.ts'
import { type Astronaut, type Catalog, type Planned, PlannerError, fetchCatalog, fileBytes, requestPlan } from './api'
import { StageIcon } from './components/icons'
import { CrewStep } from './steps/CrewStep'
import { HomeStep } from './steps/HomeStep'
import { MissionStep } from './steps/MissionStep'
import { PhasesStep } from './steps/PhasesStep'
import { ReviewStep } from './steps/ReviewStep'
import { download, fileStem, readMissionFile } from './files'
import {
  type Draft,
  STEPS,
  type Selection,
  type StepId,
  type LibraryEntry,
  createEdits,
  loadLibrary,
  loadRoster,
  movedIndex,
  stepFromHash,
  stepOfProblem,
  store,
  storedDraft,
  useHistory,
  withEntry,
} from './state'

// The map library is tens of megabytes. Only the two pages with a map need
// it, so they load on their own and the first page does not wait for them.
const loadSites = () => import('./steps/SitesPage')
const loadGlobe = () => import('./globe/GlobeCanvas')
const SitesPage = lazy(() => loadSites().then((module) => ({ default: module.SitesPage })))
const GlobeCanvas = lazy(() => loadGlobe().then((module) => ({ default: module.GlobeCanvas })))

const mapLoading = (
  <main className="stage stage--loading">
    <p className="loading" role="status">
      <span className="spinner spinner--large" aria-hidden="true" />
      Loading the map
    </p>
  </main>
)

// A page that stays mounted once opened. A Cesium viewer takes seconds to
// build and then loads its tiles again, so a map page is hidden, not thrown
// away, when another stage is shown. While hidden it keeps its last content
// and does not render again, so edits elsewhere cost it nothing.
function KeepAlive({ active, children }: { active: boolean; children: ReactNode }) {
  const last = useRef(children)
  if (active) last.current = children
  return (
    <div className="keep" hidden={!active}>
      {last.current}
    </div>
  )
}

// Compares values, not key order: the planner's JSON and the editor's
// objects list the same fields in different orders.
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
  )
}

// Map positions arrive with fifteen decimals. The file keeps six.
const degrees = (value: number): number => Math.round(value * 1e6) / 1e6

// The planner names fields the way the file format does. On screen they get
// the words the form uses.
const FIELD_WORDS: Array<[RegExp, string]> = [
  [/\bmassKg\b/, 'mass in kg'],
  [/\bheightCm\b/, 'height in cm'],
  [/\bevaShare\b/, 'share of EVA hours, as a fraction'],
  [/\bmarginPercent\b/, 'margin in percent'],
  [/\bevaHoursPerWeek\b/, 'EVA hours per person-week'],
  [/\bwaterRecovery\b/, 'water recycled, as a fraction'],
  [/\boxygenRecovery\b/, 'oxygen recycled, as a fraction'],
  [/\bhygieneWaterKg\b/, 'hygiene water in kg'],
  [/\bbasePowerW\b/, 'vehicle base power in W'],
  [/\bcrewPowerW\b/, 'power per person in W'],
  [/\blat\b/, 'latitude'],
  [/\blon\b/, 'longitude'],
]
const plainWords = (message: string): string =>
  FIELD_WORDS.reduce((text, [field, words]) => text.replace(field, words), message)

const count = (n: number, thing: string) => `${n} ${thing}${n === 1 ? '' : 's'}`

// Keeps people where they were in the roster. Someone new to it goes last.
const byRosterOrder = (roster: Astronaut[]) => {
  const place = (person: Astronaut) => {
    const at = roster.findIndex((entry) => entry.name === person.name)
    return at < 0 ? roster.length : at
  }
  return (a: Astronaut, b: Astronaut) => place(a) - place(b)
}

interface Start {
  catalog: Catalog
  // The mission to open with, already checked and planned.
  planned: Planned
}

// A draft saved before the margin had limits would be refused whole. Move its
// margin to the nearest limit so the rest of it opens.
function withinMargin(saved: unknown, catalog: Catalog): unknown {
  const margin = (saved as { marginPercent?: unknown } | null)?.marginPercent
  if (typeof margin !== 'number') return saved
  return {
    ...(saved as object),
    marginPercent: Math.min(Math.max(margin, catalog.minMarginPercent), catalog.maxMarginPercent),
  }
}

// Fetches the planner's catalog, then opens the draft from the last session
// if the planner still accepts it, or the example mission if not.
async function start(): Promise<Start> {
  const catalog = await fetchCatalog()
  const saved = withinMargin(storedDraft(), catalog)
  if (saved !== undefined) {
    try {
      return { catalog, planned: await requestPlan(saved) }
    } catch (error) {
      if (!(error instanceof PlannerError) || error.kind !== 'invalid') throw error
      // A draft from an older version, or one saved mid-edit. Use the example.
    }
  }
  return { catalog, planned: await requestPlan(catalog.example) }
}

export default function App() {
  const [state, setState] = useState<Start | string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let current = true
    setState(null)
    start().then(
      (started) => current && setState(started),
      (error: unknown) => current && setState(error instanceof Error ? error.message : 'unknown failure'),
    )
    return () => {
      current = false
    }
  }, [attempt])

  if (state !== null && typeof state !== 'string') return <Editor catalog={state.catalog} opening={state.planned} />
  return (
    <div className="console console--mission">
      <header className="topbar"></header>
      <main className="startup">
        {state === null ? (
          <p className="loading" role="status">
            <span className="spinner spinner--large" aria-hidden="true" />
            Starting the planner
          </p>
        ) : (
          <div className="problem" role="alert">
            <b>Planner not available</b>
            The editor could not reach the planner service: {state}. Start it with the dev server, then retry.
            <button type="button" onClick={() => setAttempt(attempt + 1)}>
              Retry
            </button>
          </div>
        )}
      </main>
    </div>
  )
}

// The planner's answer for one exact draft object.
type Answer = { draft: Draft; planned: Planned } | { draft: Draft; problem: string }

function Editor({ catalog, opening }: { catalog: Catalog; opening: Planned }) {
  const edits = useMemo(() => createEdits(catalog), [catalog])
  const history = useHistory(() => opening.mission)
  const { present: draft } = history
  // What the planner changed on its own as part of the last action.
  const [notice, setNotice] = useState<string | null>(null)
  const commit = useCallback(
    (recipe: (draft: Draft) => Draft, key = '') => {
      setNotice(null)
      history.commit(recipe, key)
    },
    [history.commit],
  )
  const [step, setStep] = useState<StepId>(stepFromHash)
  const [selection, setSelection] = useState<Selection>(null)
  const [roster, setRoster] = useState(() => loadRoster(catalog))
  const [fileProblem, setFileProblem] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  // The review globe. The sites page reports its own map state.
  const [mapStatus, dispatchMapStatus] = useReducer(mapStatusReducer, INITIAL_MAP_STATUS)
  const [imagerySource, setImagerySource] = useState<'V01' | 'beta01'>('V01')
  const [retryKey, setRetryKey] = useState(0)

  const [answer, setAnswer] = useState<Answer>({ draft: opening.mission, planned: opening })
  // Why the planner did not answer, when it did not.
  const [offline, setOffline] = useState<string | null>(null)
  const [planAttempt, setPlanAttempt] = useState(0)

  // Fetch the map pages once the first page is up, so their tabs open fast.
  useEffect(() => {
    const timer = setTimeout(() => {
      void loadSites()
      void loadGlobe()
    }, 2000)
    return () => clearTimeout(timer)
  }, [])

  // Ask the planner about every new draft. An older request still in flight
  // is cancelled, so answers cannot arrive out of order.
  useEffect(() => {
    if (answer.draft === draft && !offline) return
    const controller = new AbortController()
    requestPlan(draft, undefined, controller.signal).then(
      (planned) => {
        setOffline(null)
        setAnswer({ draft, planned })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        if (error instanceof PlannerError && error.kind === 'invalid') {
          setOffline(null)
          setAnswer({ draft, problem: error.message })
        } else {
          setOffline(error instanceof Error ? error.message : 'unknown failure')
        }
      },
    )
    return () => controller.abort()
  }, [draft, planAttempt])

  const current = answer.draft === draft
  const valid = current && 'planned' in answer ? answer.planned : null
  const problem = current && 'problem' in answer ? answer.problem : null
  // While the draft is being typed into, keep showing the last plan that worked.
  const lastGood = useRef(opening)
  if (valid) lastGood.current = valid
  const shown = lastGood.current
  const stale = problem !== null || offline !== null

  useEffect(() => {
    if (valid) store('draft', valid.mission)
  }, [valid])

  // The stage lives in the address. Tabs and buttons change the address, and
  // the page follows it, so back and forward move between stages.
  useEffect(() => {
    const onHash = () => setStep(stepFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const goTo = (next: StepId) => {
    location.hash = next
    setStep(next)
  }
  // The map pages that have been opened. They stay mounted from then on.
  const opened = useRef(new Set<StepId>())
  opened.current.add(step)
  const stepIndex = STEPS.findIndex((entry) => entry.id === step)
  const next = STEPS[stepIndex + 1]
  const previous = STEPS[stepIndex - 1]
  const problemStep = problem ? stepOfProblem(problem) : null
  const cautionCount = valid?.cautions.length ?? 0

  const updateRoster = (entries: Astronaut[]) => {
    setRoster(entries)
    store('roster', entries)
  }

  // Missions saved from here or received as files, listed on the home page.
  const [library, setLibrary] = useState(loadLibrary)
  const updateLibrary = (entries: LibraryEntry[]) => {
    setLibrary(entries)
    store('library', entries)
  }

  const open = async (file: File | undefined) => {
    if (!file) return
    try {
      const mission = await readMissionFile(file, roster)
      updateLibrary(withEntry(library, mission, 'received', file.name))
      commit(() => mission)
      setSelection(null)
      setFileProblem(null)
      goTo('review')
      setNotice(`Opened ${file.name}. The mission you had before is one Undo away.`)
    } catch (error) {
      if (!(error instanceof PlannerError)) throw error
      setFileProblem(`Could not open ${file.name}: ${error.message}`)
    }
  }

  // Saving writes the mission file and keeps a copy on the home page.
  const save = () => {
    if (!valid) return
    download(`${fileStem(valid.mission)}.mhr`, fileBytes(valid), 'application/octet-stream')
    updateLibrary(withEntry(library, valid.mission, 'saved'))
  }

  const openEntry = (entry: LibraryEntry) => {
    commit(() => entry.mission)
    setSelection(null)
    goTo('mission')
    setNotice(`Opened ${entry.mission.name || 'the mission'}. The mission you had before is one Undo away.`)
  }
  const exportJson = () => {
    if (valid) download(`${fileStem(valid.mission)}.json`, JSON.stringify(valid.mission, null, 2), 'application/json')
  }

  const startNew = () => {
    commit(() => edits.blank())
    setSelection(null)
    goTo('mission')
    setNotice(
      'Started a new mission with one crew member and the Mars long stay phases. The mission you had before is one Undo away.',
    )
    // Put the cursor where the first thing to do is.
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.page input')?.focus())
  }

  // Latest handlers for the key listener, which is attached once.
  const keys = useRef({ save, undo: history.undo, redo: history.redo })
  keys.current = { save, undo: history.undo, redo: history.redo }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const key = e.key.toLowerCase()
      if (key === 'z' && e.shiftKey) keys.current.redo()
      else if (key === 'z') keys.current.undo()
      else if (key === 'y') keys.current.redo()
      else if (key === 's') keys.current.save()
      else if (key === 'o') fileInput.current?.click()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Leaving a field snaps what was typed to what the file can store. The
  // planner's answer already holds for the snapped mission, so keep it.
  const settle = () => {
    if (!valid || same(valid.mission, draft)) return
    setAnswer({ draft: valid.mission, planned: valid })
    history.amend(valid.mission)
  }

  // Adding, removing or moving an item changes which one is open. `done`
  // says what else the planner changed to keep the mission consistent.
  const structural = (recipe: (draft: Draft) => Draft, selected: Selection = null, done?: string) => {
    commit(recipe)
    setSelection(selected)
    if (done) setNotice(done)
  }

  // Off the crew, back to the roster as the mission had them, so edits made
  // while they were selected are kept.
  const deselect = (i: number, keep = true) => {
    const person = draft.crew[i]!
    if (keep)
      updateRoster([...roster.filter((entry) => entry.name !== person.name), person].sort(byRosterOrder(roster)))
    const orphaned = draft.tasks.filter((task) => task.crew === i).length
    structural(
      (d) => edits.removeCrew(d, i),
      selection?.list === 'crew' ? null : selection,
      `${person.name} is off the crew.${orphaned > 0 ? ` ${count(orphaned, 'task')} of theirs now ${orphaned === 1 ? 'has' : 'have'} nobody assigned.` : ''}`,
    )
  }

  const taskCounts = useMemo(
    () => draft.sites.map((_, i) => draft.tasks.filter((task) => task.site === i).length),
    [draft.sites, draft.tasks],
  )

  // A page that is one column of cards.
  const column = (children: ReactNode) => (
    <main className="page" onBlur={settle}>
      <div className="page__column">
        {children}
        <div className="page__next">
          {previous && (
            <button type="button" className="plan__button" onClick={() => goTo(previous.id)}>
              Back
            </button>
          )}
          {next && (
            <button type="button" className="plan__button page__forward" onClick={() => goTo(next.id)}>
              Next: {next.label}
            </button>
          )}
        </div>
      </div>
    </main>
  )

  return (
    <div
      className="console console--mission"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        void open(e.dataTransfer.files[0])
      }}
    >
      <header className="topbar">
        <nav className="tabs" aria-label="Stages">
          {STEPS.map((entry) => {
            const flag =
              entry.id === problemStep
                ? 'Fix'
                : entry.id === 'review' && cautionCount > 0
                  ? count(cautionCount, 'caution')
                  : ''
            return (
              <button
                key={entry.id}
                type="button"
                className="tab"
                aria-current={entry.id === step ? 'page' : undefined}
                onClick={() => goTo(entry.id)}
              >
                <StageIcon id={entry.id} />
                {entry.label}
                {flag && <span className="tab__flag">{flag}</span>}
              </button>
            )
          })}
        </nav>
        <div className="topbar__meta">
          <span className="topbar__item">
            Mission <b>{draft.name || 'Unnamed'}</b>
          </span>
          <button
            type="button"
            className="topbar__action"
            disabled={!history.canUndo}
            onClick={history.undo}
            title="Ctrl+Z"
          >
            Undo
          </button>
          <button
            type="button"
            className="topbar__action"
            disabled={!history.canRedo}
            onClick={history.redo}
            title="Ctrl+Shift+Z"
          >
            Redo
          </button>
          <button type="button" className="topbar__action" disabled={!valid} onClick={save} title="Ctrl+S">
            Save
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".mhr,.json,application/json"
          hidden
          onChange={(e) => {
            void open(e.target.files?.[0])
            e.target.value = ''
          }}
        />
      </header>

      <div className="alerts">
        {offline && (
          <p className="problem" role="alert">
            <b>Planner not answering</b>
            The numbers shown are from the last answer it gave: {offline}.
            <button type="button" onClick={() => setPlanAttempt(planAttempt + 1)}>
              Retry
            </button>
          </p>
        )}
        {fileProblem && (
          <p className="problem" role="alert">
            <b>Caution</b>
            {fileProblem}
            <button type="button" aria-label="Dismiss" onClick={() => setFileProblem(null)}>
              ×
            </button>
          </p>
        )}
        {notice && (
          <p className="notice" role="status">
            <b>Done</b>
            {notice}
            <button
              type="button"
              onClick={() => {
                history.undo()
                setNotice(null)
              }}
            >
              Undo
            </button>
          </p>
        )}
        {problem && (
          <p className="problem" role="alert">
            <b>Cannot plan yet</b>
            {plainWords(problem)}.
            {problemStep !== step && (
              <button type="button" onClick={() => goTo(problemStep!)}>
                Go to {STEPS.find((entry) => entry.id === problemStep)!.label}
              </button>
            )}
          </p>
        )}
      </div>

      {step === 'home' &&
        column(
          <HomeStep
            draft={draft}
            library={library}
            onContinue={() => goTo('mission')}
            onOpen={openEntry}
            onDelete={(entry) => updateLibrary(library.filter((other) => other.id !== entry.id))}
            onOpenFile={() => fileInput.current?.click()}
            onNew={startNew}
          />,
        )}

      {step === 'mission' &&
        column(
          <MissionStep
            catalog={catalog}
            draft={draft}
            status={problem ? 'Cannot plan yet' : cautionCount > 0 ? count(cautionCount, 'caution') : 'Nothing to fix'}
            days={shown.plan.days}
            onGoTo={goTo}
            onName={(name) => commit((d) => ({ ...d, name }), 'name')}
            onType={(type) => {
              const loaded = edits.setType(draft, type).phases
              structural(
                (d) => edits.setType(d, type),
                null,
                loaded === draft.phases
                  ? undefined
                  : `Phases replaced with the ${count(loaded.length, 'default')} for this type. Tasks kept their phase number where it still exists.`,
              )
            }}
            onMargin={(marginPercent) => commit((d) => ({ ...d, marginPercent }), 'margin')}
          />,
        )}

      {step === 'crew' &&
        column(
          <CrewStep
            catalog={catalog}
            crew={draft.crew}
            plan={valid?.plan ?? null}
            roster={roster}
            onNew={() => {
              // Counted once each, so the new call sign follows the size of the list.
              const person = edits.newPerson([
                ...roster,
                ...draft.crew.filter((member) => !roster.some((entry) => entry.name === member.name)),
              ])
              updateRoster([...roster, person])
              commit((d) => edits.addCrew(d, person))
              return person.name
            }}
            onSelect={(person) => commit((d) => edits.addCrew(d, person))}
            onDeselect={deselect}
            onUpdate={(i, patch, field) => {
              // A new call sign goes to the roster too, or the old one would stay behind as a second person.
              const old = draft.crew[i]!.name
              if (patch.name !== undefined && !roster.some((entry) => entry.name === patch.name)) {
                updateRoster(roster.map((entry) => (entry.name === old ? { ...entry, name: patch.name! } : entry)))
              }
              commit((d) => edits.updateCrew(d, i, patch), `crew ${i} ${field}`)
            }}
            onUpdateRoster={(name, patch) =>
              updateRoster(roster.map((entry) => (entry.name === name ? { ...entry, ...patch } : entry)))
            }
            onDelete={(name) => {
              const at = draft.crew.findIndex((member) => member.name === name)
              if (at >= 0) deselect(at, false)
              updateRoster(roster.filter((entry) => entry.name !== name))
            }}
          />,
        )}

      {step === 'phases' &&
        column(
          <PhasesStep
            catalog={catalog}
            phases={draft.phases}
            selection={selection}
            onSelect={setSelection}
            onAdd={(kind) => {
              const after = selection?.list === 'phase' ? selection.index : draft.phases.length - 1
              structural((d) => edits.addPhase(d, kind, after), { list: 'phase', index: after + 1 })
            }}
            onUpdate={(i, patch, field) =>
              commit((d) => edits.updatePhase(d, i, patch), field && `phase ${i} ${field}`)
            }
            onKind={(i, kind) => commit((d) => edits.setPhaseKind(d, i, kind))}
            onMove={(from, to) =>
              structural(
                (d) => edits.movePhase(d, from, to),
                // The open phase stays open wherever the move puts it.
                selection?.list === 'phase'
                  ? { list: 'phase', index: movedIndex(selection.index, from, to) }
                  : selection,
              )
            }
            onDuplicate={(i) => structural((d) => edits.duplicatePhase(d, i), { list: 'phase', index: i + 1 })}
            onRemove={(i) => {
              const moved = draft.tasks.filter((task) => task.phase === i).length
              structural(
                (d) => edits.removePhase(d, i),
                null,
                `Phase ${i + 1} removed.${moved > 0 ? ` Its ${count(moved, 'task')} moved to the phase now in that place.` : ''}`,
              )
            }}
          />,
        )}

      {opened.current.has('sites') && (
        <KeepAlive active={step === 'sites'}>
          <Suspense fallback={mapLoading}>
            <SitesPage
              catalog={catalog}
              draft={draft}
              plan={valid?.plan ?? null}
              taskCounts={taskCounts}
              selection={selection}
              onSelect={setSelection}
              onSettle={settle}
              onAddSite={(lat, lon) =>
                structural((d) => edits.addSite(d, degrees(lat), degrees(lon)), {
                  list: 'site',
                  index: draft.sites.length,
                })
              }
              onAddEva={(lat, lon, hours, note) => {
                const after = edits.addEva(draft, degrees(lat), degrees(lon), hours, note)
                const task = after.tasks[after.tasks.length - 1]!
                structural(
                  (d) => edits.addEva(d, degrees(lat), degrees(lon), hours, note),
                  { list: 'site', index: task.site },
                  `${after.sites[task.site]!.name} has a new ${hours} h EVA task in phase ${task.phase + 1}. Nobody is assigned to it yet.`,
                )
              }}
              onMoveSite={(i, lat, lon) =>
                commit((d) => edits.updateSite(d, i, { lat: degrees(lat), lon: degrees(lon) }))
              }
              onUpdateSite={(i, patch, field) => commit((d) => edits.updateSite(d, i, patch), `site ${i} ${field}`)}
              onRemoveSite={(i) => {
                const gone = draft.tasks.filter((task) => task.site === i).length
                structural(
                  (d) => edits.removeSite(d, i),
                  null,
                  `${draft.sites[i]!.name} removed${gone > 0 ? ` with its ${count(gone, 'task')}` : ''}.`,
                )
              }}
              onAddTask={(site) => commit((d) => edits.addTask(d, site))}
              onUpdateTask={(i, patch, field) => commit((d) => edits.updateTask(d, i, patch), `task ${i} ${field}`)}
              onRemoveTask={(i) => commit((d) => edits.removeTask(d, i))}
            />
          </Suspense>
        </KeepAlive>
      )}

      {opened.current.has('review') && (
        <KeepAlive active={step === 'review'}>
          <div className="workspace workspace--review">
            <aside className={`review${valid ? '' : ' is-stale'}`} aria-label="Review">
              <ReviewStep
                catalog={catalog}
                planned={shown}
                stale={stale}
                onSave={valid ? save : null}
                onExportJson={exportJson}
                selectedSite={selection?.list === 'site' ? selection.index : -1}
                onSite={(index) => setSelection({ list: 'site', index })}
              />
            </aside>
            <Suspense fallback={mapLoading}>
              <GlobeCanvas
                sites={draft.sites}
                taskCounts={taskCounts}
                selected={selection?.list === 'site' ? selection.index : -1}
                editable={false}
                placing={false}
                onPlace={() => {}}
                onSelect={(index) => setSelection({ list: 'site', index })}
                onMove={() => {}}
                onStatus={dispatchMapStatus}
                onImagerySource={setImagerySource}
                retryKey={retryKey}
              />
            </Suspense>
          </div>
          <footer className="statusbar">
            <MapStatus status={mapStatus} imagerySource={imagerySource} onRetry={() => setRetryKey((key) => key + 1)} />
            <span className="statusbar__credit">
              Viking / CTX · NASA / JPL / USGS / MSSS / The Murray Lab / Esri · Terrain NASA Mars Trek
            </span>
          </footer>
        </KeepAlive>
      )}
    </div>
  )
}
