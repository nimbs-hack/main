import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
// Map loading state and its wording are the map app's, so both apps report
// missing terrain or fallback imagery the same way.
import MapStatus from '../../../src/components/MapStatus.jsx'
import { INITIAL_MAP_STATUS, mapStatusReducer } from '../../../src/components/map-status.ts'
import { type Astronaut, type Catalog, type Planned, PlannerError, fetchCatalog, fileBytes, requestPlan } from './api'
import { GlobeCanvas } from './components/GlobeCanvas'
import { Button, Readout } from './components/controls'
import { CrewStep, MissionStep, PhasesStep, ReviewStep, SitesStep } from './components/steps'
import { download, fileStem, readMissionFile } from './files'
import { duration, kcal, kwh, num } from './format'
import {
  type Draft,
  STEPS,
  type Selection,
  type StepId,
  createEdits,
  loadRoster,
  stepOfProblem,
  store,
  storedDraft,
  useHistory,
} from './state'

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

// What the last edit did to a number, as "+1,669 kg" or "-12 kg". Empty when
// the edit left it alone. The sign carries the direction, not a colour.
function change(now: number, before: number | undefined, unit: string): string | undefined {
  if (before === undefined) return undefined
  const difference = Math.round(now) - Math.round(before)
  if (difference === 0) return undefined
  return `${difference > 0 ? '+' : '−'}${num(Math.abs(difference))} ${unit} last edit`
}

// The plan, always in view under the globe, with the effect of the last edit
// under each number. While the draft cannot be planned it shows the last
// numbers that could, marked as stale.
function PlanBar({ shown, before, stale }: { shown: Planned; before: Planned | null; stale: boolean }) {
  const { plan, fileBytes: size } = shown
  const { provision } = plan
  const was = before?.plan.provision
  const typicalLink = shown.links.find((link) => link.id === 'x-band-hga')
  return (
    <section className={`planbar${stale ? ' is-stale' : ''}`} aria-label="Plan">
      <h2 className="readout__label">
        To supply, {plan.marginPercent}% margin included
        {stale && <b className="planbar__stale">Stale: from the last valid mission</b>}
      </h2>
      <div className="planbar__grid">
        <Readout
          label="Food"
          value={`${num(provision.foodKg)} kg`}
          sub={change(provision.foodKg, was?.foodKg, 'kg') ?? `${num(kcal(provision.foodEnergyMJ) / 1e6, 1)} Gcal`}
        />
        <Readout
          label="Water"
          value={`${num(provision.waterSupplyKg)} kg`}
          sub={change(provision.waterSupplyKg, was?.waterSupplyKg, 'kg')}
        />
        <Readout
          label="Oxygen"
          value={`${num(provision.oxygenSupplyKg)} kg`}
          sub={change(provision.oxygenSupplyKg, was?.oxygenSupplyKg, 'kg')}
        />
        <Readout
          label="Electricity"
          value={`${num(kwh(provision.electricityMJ))} kWh`}
          sub={change(kwh(provision.electricityMJ), was && kwh(was.electricityMJ), 'kWh')}
        />
        <Readout
          label="Duration"
          value={`${num(plan.days)} d`}
          sub={change(plan.days, before?.plan.days, 'd') ?? `${plan.crew.length} crew`}
        />
        <Readout
          label="Mission file"
          value={`${num(size)} B`}
          sub={
            change(size, before?.fileBytes, 'B') ??
            (typicalLink ? `${duration(typicalLink.seconds)} at 1 kbit/s` : undefined)
          }
        />
      </div>
    </section>
  )
}

interface Start {
  catalog: Catalog
  // The mission to open with, already checked and planned.
  planned: Planned
}

// Fetches the planner's catalog, then opens the draft from the last session
// if the planner still accepts it, or the example mission if not.
async function start(): Promise<Start> {
  const catalog = await fetchCatalog()
  const saved = storedDraft()
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
    <div className="console console--planner">
      <header className="topbar">
        <strong className="topbar__title">Mission planner</strong>
      </header>
      <main className="startup">
        {state === null ? (
          <p role="status">Starting the planner</p>
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
  const [step, setStep] = useState<StepId>('mission')
  const [selection, setSelection] = useState<Selection>(null)
  const [placing, setPlacing] = useState(false)
  const [roster, setRoster] = useState(() => loadRoster(catalog))
  const [fileProblem, setFileProblem] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [mapStatus, dispatchMapStatus] = useReducer(mapStatusReducer, INITIAL_MAP_STATUS)
  const [imagerySource, setImagerySource] = useState<'V01' | 'beta01'>('V01')
  const [retryKey, setRetryKey] = useState(0)

  const [answer, setAnswer] = useState<Answer>({ draft: opening.mission, planned: opening })
  // Why the planner did not answer, when it did not.
  const [offline, setOffline] = useState<string | null>(null)
  const [planAttempt, setPlanAttempt] = useState(0)
  // Every plan the planner has returned, by the draft it was for. Lets the
  // plan bar compare with the draft before the last edit.
  const plans = useRef(new WeakMap<Draft, Planned>([[opening.mission, opening]]))

  // Ask the planner about every new draft. An older request still in flight
  // is cancelled, so answers cannot arrive out of order.
  useEffect(() => {
    if (answer.draft === draft && !offline) return
    const controller = new AbortController()
    requestPlan(draft, undefined, controller.signal).then(
      (planned) => {
        plans.current.set(draft, planned)
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
  const before = history.previous ? (plans.current.get(history.previous) ?? null) : null

  useEffect(() => {
    if (valid) store('draft', valid.mission)
  }, [valid])

  const goTo = (next: StepId) => {
    setStep(next)
    setPlacing(false)
  }
  const stepIndex = STEPS.findIndex((entry) => entry.id === step)
  const currentStep = STEPS[stepIndex]!
  const next = STEPS[stepIndex + 1]
  const previous = STEPS[stepIndex - 1]
  const problemStep = problem ? stepOfProblem(problem) : null
  const cautionCount = valid?.cautions.length ?? 0

  const updateRoster = (entries: Astronaut[]) => {
    setRoster(entries)
    store('roster', entries)
  }

  const open = async (file: File | undefined) => {
    if (!file) return
    try {
      const mission = await readMissionFile(file, roster)
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

  const save = () => valid && download(`${fileStem(valid.mission)}.mhr`, fileBytes(valid), 'application/octet-stream')
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
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.step input')?.focus())
  }

  // Latest handlers for the key listener, which is attached once.
  const keys = useRef({ save, undo: history.undo, redo: history.redo })
  keys.current = { save, undo: history.undo, redo: history.redo }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return setPlacing(false)
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
    plans.current.set(valid.mission, valid)
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

  const placeSite = useCallback(
    (lat: number, lon: number) => {
      commit((d) => edits.addSite(d, degrees(lat), degrees(lon)))
      setSelection({ list: 'site', index: draft.sites.length })
      setPlacing(false)
    },
    [commit, edits, draft.sites.length],
  )

  const taskCounts = useMemo(
    () => draft.sites.map((_, i) => draft.tasks.filter((task) => task.site === i).length),
    [draft.sites, draft.tasks],
  )

  return (
    <div
      className="console console--planner"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        void open(e.dataTransfer.files[0])
      }}
    >
      <header className="topbar">
        <strong className="topbar__title">Mission planner</strong>
        <span className="topbar__item">
          Mission <b>{draft.name || 'Unnamed'}</b>
        </span>
        <div className="topbar__meta">
          <button type="button" className="topbar__action" disabled={!history.canUndo} onClick={history.undo} title="Ctrl+Z">
            Undo
          </button>
          <button type="button" className="topbar__action" disabled={!history.canRedo} onClick={history.redo} title="Ctrl+Shift+Z">
            Redo
          </button>
          <button type="button" className="topbar__action" onClick={() => fileInput.current?.click()} title="Ctrl+O">
            Open file
          </button>
          <button type="button" className="topbar__action" onClick={startNew}>
            New mission
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

      <aside className="planner" aria-label="Mission editor" onBlur={settle}>
        <nav aria-label="Steps">
          <ol className="stepper">
            {STEPS.map((entry, i) => {
              const flag =
                entry.id === problemStep
                  ? 'Fix'
                  : entry.id === 'review' && cautionCount > 0
                    ? count(cautionCount, 'caution')
                    : ''
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    aria-current={entry.id === step ? 'step' : undefined}
                    onClick={() => goTo(entry.id)}
                  >
                    <span>
                      {i + 1} {entry.label}
                    </span>
                    {flag && <span className="stepper__flag">{flag}</span>}
                  </button>
                </li>
              )
            })}
          </ol>
        </nav>

        <div className={`step${step === 'review' && !valid ? ' is-stale' : ''}`}>
          <div>
            <h1 className="sites__heading">{currentStep.title}</h1>
            <p className="sites__intro">{currentStep.help}</p>
          </div>

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

          {step === 'mission' && (
            <MissionStep
              catalog={catalog}
              draft={draft}
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
            />
          )}
          {step === 'crew' && (
            <CrewStep
              catalog={catalog}
              crew={draft.crew}
              plan={valid?.plan ?? null}
              selection={selection}
              onSelect={setSelection}
              roster={roster}
              onAdd={(person) =>
                structural((d) => edits.addCrew(d, person), { list: 'crew', index: draft.crew.length })
              }
              onUpdate={(i, patch, field) => commit((d) => edits.updateCrew(d, i, patch), `crew ${i} ${field}`)}
              onDuplicate={(i) =>
                structural((d) => edits.duplicateCrew(d, i), { list: 'crew', index: draft.crew.length })
              }
              onRemove={(i) => {
                const orphaned = draft.tasks.filter((task) => task.crew === i).length
                structural(
                  (d) => edits.removeCrew(d, i),
                  null,
                  `${draft.crew[i]!.name} removed.${orphaned > 0 ? ` ${count(orphaned, 'task')} of theirs now ${orphaned === 1 ? 'has' : 'have'} nobody assigned.` : ''}`,
                )
              }}
              onSaveToRoster={(person) =>
                updateRoster([...roster.filter((entry) => entry.name !== person.name), person])
              }
              onDropFromRoster={(name) => updateRoster(roster.filter((entry) => entry.name !== name))}
            />
          )}
          {step === 'phases' && (
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
              onMove={(i, by) => structural((d) => edits.movePhase(d, i, by), { list: 'phase', index: i + by })}
              onDuplicate={(i) => structural((d) => edits.duplicatePhase(d, i), { list: 'phase', index: i + 1 })}
              onRemove={(i) => {
                const moved = draft.tasks.filter((task) => task.phase === i).length
                structural(
                  (d) => edits.removePhase(d, i),
                  null,
                  `Phase ${i + 1} removed.${moved > 0 ? ` Its ${count(moved, 'task')} moved to the phase now in that place.` : ''}`,
                )
              }}
            />
          )}
          {step === 'sites' && (
            <SitesStep
              catalog={catalog}
              draft={draft}
              plan={valid?.plan ?? null}
              selection={selection}
              onSelect={setSelection}
              placing={placing}
              onPlacing={setPlacing}
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
          )}
          {step === 'review' && <ReviewStep catalog={catalog} planned={shown} onExportJson={exportJson} />}
        </div>

        <footer className="step__nav">
          {previous && <Button onClick={() => goTo(previous.id)}>Back</Button>}
          {next ? (
            <button type="button" className="nav-button nav-button--next" onClick={() => goTo(next.id)}>
              <span className="nav-button__label">Next: {next.label}</span>
              <span className="nav-button__arrow" aria-hidden="true">
                →
              </span>
            </button>
          ) : (
            // The one primary action, so it gets the accent.
            <button
              type="button"
              className="nav-button nav-button--primary"
              disabled={!valid}
              onClick={save}
              title="Ctrl+S"
            >
              <span className="nav-button__label">Save mission file</span>
              <span className="nav-button__arrow" aria-hidden="true">
                ↓
              </span>
            </button>
          )}
        </footer>
      </aside>

      <GlobeCanvas
        sites={draft.sites}
        taskCounts={taskCounts}
        selected={selection?.list === 'site' ? selection.index : -1}
        editable={step === 'sites'}
        placing={placing}
        onPlace={placeSite}
        onSelect={(index) => {
          goTo('sites')
          setSelection({ list: 'site', index })
        }}
        onMove={(index, lat, lon) =>
          commit((d) => edits.updateSite(d, index, { lat: degrees(lat), lon: degrees(lon) }))
        }
        onStatus={dispatchMapStatus}
        onImagerySource={setImagerySource}
        retryKey={retryKey}
      />
      <PlanBar shown={shown} before={valid ? before : null} stale={problem !== null || offline !== null} />

      <footer className="statusbar">
        <MapStatus status={mapStatus} imagerySource={imagerySource} onRetry={() => setRetryKey((key) => key + 1)} />
        <span className="statusbar__credit">
          Viking / CTX · NASA / JPL / USGS / MSSS / The Murray Lab / Esri · Terrain NASA Mars Trek
        </span>
      </footer>
    </div>
  )
}
