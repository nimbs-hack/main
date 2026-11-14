import { useCallback, useRef, useState } from 'react'
import type { Astronaut, Catalog, Mission, Phase, Site, Task } from './api'

// What the editor holds. Same shape as a Mission, but a field may be out of
// range or empty while someone is typing in it.
export type Draft = Mission

// The stages of making a mission, in the order they are done. Each is a page.
export const STEPS = [
  { id: 'home', label: 'Home' },
  { id: 'mission', label: 'Mission' },
  { id: 'crew', label: 'Crew' },
  { id: 'phases', label: 'Phases' },
  { id: 'sites', label: 'Sites' },
  { id: 'review', label: 'Review' },
] as const
export type StepId = (typeof STEPS)[number]['id']

// The stage in the address, so a reload or the back button lands on it.
export const stepFromHash = (): StepId => STEPS.find((entry) => `#${entry.id}` === location.hash)?.id ?? 'home'

export type Selection = { list: 'crew' | 'phase' | 'site'; index: number } | null

// Which step a validation message belongs to, from how createMission words it.
export function stepOfProblem(message: string): StepId {
  if (/^(site|task)/.test(message) || message.includes('in the sites twice')) return 'sites'
  if (message.startsWith('phase') || message.includes('needs a list of phases')) return 'phases'
  if (/^(crew|roster|"|no ")/.test(message)) return 'crew'
  return 'mission'
}

const DRAFT_KEY = 'nimbs:planner:draft'
const ROSTER_KEY = 'nimbs:planner:roster'
const LIBRARY_KEY = 'nimbs:planner:library'

function stored(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? undefined : JSON.parse(raw)
  } catch {
    return undefined
  }
}

export function store(key: 'draft' | 'roster' | 'library', value: unknown): void {
  // A number field being retyped is NaN, which JSON turns into null. A roster
  // saved like that would lose the person on the next start, so wait.
  if (key === 'roster' && /:null[,}]/.test(JSON.stringify(value))) return
  try {
    localStorage.setItem({ draft: DRAFT_KEY, roster: ROSTER_KEY, library: LIBRARY_KEY }[key], JSON.stringify(value))
  } catch {
    // Storage can be blocked or full. The editor still works for this session.
  }
}

const isProfile = (value: unknown): value is Astronaut =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Astronaut).name === 'string' &&
  typeof (value as Astronaut).sex === 'string' &&
  typeof (value as Astronaut).massKg === 'number'

// The roster starts with the planner's fictional sample crew.
export function loadRoster(catalog: Catalog): Astronaut[] {
  const saved = stored(ROSTER_KEY)
  return Array.isArray(saved) ? saved.filter(isProfile) : catalog.sampleRoster
}

// A mission kept on the home page: saved from here, or received as a file.
export interface LibraryEntry {
  id: string
  mission: Mission
  // ISO time it was saved or received.
  at: string
  source: 'saved' | 'received'
  // Name of the file it came from, for a received one.
  file?: string
}

// The most missions the home page keeps. The oldest go first.
const LIBRARY_LIMIT = 50

const isEntry = (value: unknown): value is LibraryEntry => {
  const entry = value as LibraryEntry | null
  return (
    typeof entry === 'object' &&
    entry !== null &&
    typeof entry.id === 'string' &&
    typeof entry.at === 'string' &&
    (entry.source === 'saved' || entry.source === 'received') &&
    typeof entry.mission === 'object' &&
    entry.mission !== null &&
    typeof entry.mission.name === 'string' &&
    Array.isArray(entry.mission.crew) &&
    Array.isArray(entry.mission.phases) &&
    Array.isArray(entry.mission.sites)
  )
}

export function loadLibrary(): LibraryEntry[] {
  const saved = stored(LIBRARY_KEY)
  return Array.isArray(saved) ? saved.filter(isEntry) : []
}

// The library with one more mission, newest first. A mission saved again
// under the same name, or received again from the same file, replaces the
// earlier copy.
export function withEntry(
  library: LibraryEntry[],
  mission: Mission,
  source: LibraryEntry['source'],
  file?: string,
): LibraryEntry[] {
  const twin = (entry: LibraryEntry) =>
    entry.source === source && entry.mission.name === mission.name && entry.file === file
  const entry: LibraryEntry = {
    id: `${Date.now()}-${Math.round(Math.random() * 1e6)}`,
    mission,
    at: new Date().toISOString(),
    source,
    file,
  }
  return [entry, ...library.filter((old) => !twin(old))].slice(0, LIBRARY_LIMIT)
}

// The draft from the last session, unchecked. The planner decides at start
// whether it still holds up.
export const storedDraft = (): unknown => stored(DRAFT_KEY)

function freeName(taken: string[], prefix: string): string {
  for (let n = taken.length + 1; ; n++) {
    const name = `${prefix}-${n}`
    if (!taken.includes(name)) return name
  }
}

const replaceAt = <T>(items: T[], index: number, item: T): T[] =>
  items.map((current, i) => (i === index ? item : current))

const insertAfter = <T>(items: T[], index: number, item: T): T[] => [
  ...items.slice(0, index + 1),
  item,
  ...items.slice(index + 1),
]

// Where position `index` ends up after the item at `from` moves to `to`.
export const movedIndex = (index: number, from: number, to: number): number => {
  if (index === from) return to
  if (from < index && index <= to) return index - 1
  if (to <= index && index < from) return index + 1
  return index
}

// Tasks point at crew, phases and sites by position, so every edit that
// shifts a list has to move those pointers with it.
const retarget = (draft: Draft, change: (task: Task) => Task | null): Task[] =>
  draft.tasks.flatMap((task) => {
    const next = change(task)
    return next ? [next] : []
  })

// Edits. Each returns a new draft and leaves the old one alone. Presets and
// templates come from the planner's catalog.
export function createEdits(catalog: Catalog) {
  const presetPhase = (kind: string, days: number): Phase => {
    const { id: _, summary: __, ...params } = catalog.phaseKinds.find((entry) => entry.id === kind)!
    return { kind, days, ...params }
  }
  const template = (type: string) => catalog.missionTypes.find((entry) => entry.id === type)!.phases
  const newPerson = (crew: Astronaut[]): Astronaut => ({
    name: freeName(
      crew.map((person) => person.name),
      'CREW',
    ),
    sex: 'female',
    age: 35,
    massKg: 65,
    heightCm: 168,
    role: 'mission-specialist',
    activity: 'active',
    evaShare: 1,
  })

  return {
    newPerson,

    blank: (): Draft => ({
      name: '',
      type: 'mars-long-stay',
      marginPercent: catalog.defaultMarginPercent,
      crew: [newPerson([])],
      phases: template('mars-long-stay').map((p) => presetPhase(p.kind, p.days)),
      sites: [],
      tasks: [],
    }),

    // Picking a type loads its phases. `custom` has none, so it keeps yours.
    setType: (draft: Draft, type: string): Draft => {
      const phases = template(type)
      if (phases.length === 0) return { ...draft, type }
      const last = phases.length - 1
      return {
        ...draft,
        type,
        phases: phases.map((p) => presetPhase(p.kind, p.days)),
        tasks: retarget(draft, (task) => ({ ...task, phase: Math.min(task.phase, last) })),
      }
    },

    addCrew: (draft: Draft, person?: Astronaut): Draft => ({
      ...draft,
      crew: [...draft.crew, person ?? newPerson(draft.crew)],
    }),
    updateCrew: (draft: Draft, index: number, patch: Partial<Astronaut>): Draft => ({
      ...draft,
      crew: replaceAt(draft.crew, index, { ...draft.crew[index]!, ...patch }),
    }),
    // Their tasks stay, with nobody assigned.
    removeCrew: (draft: Draft, index: number): Draft => ({
      ...draft,
      crew: draft.crew.filter((_, i) => i !== index),
      tasks: retarget(draft, (task) => {
        if (task.crew === null || task.crew < index) return task
        return { ...task, crew: task.crew === index ? null : task.crew - 1 }
      }),
    }),

    addPhase: (draft: Draft, kind: string, after: number): Draft => ({
      ...draft,
      phases: insertAfter(draft.phases, after, presetPhase(kind, 30)),
      tasks: retarget(draft, (task) => (task.phase > after ? { ...task, phase: task.phase + 1 } : task)),
    }),
    duplicatePhase: (draft: Draft, index: number): Draft => ({
      ...draft,
      phases: insertAfter(draft.phases, index, { ...draft.phases[index]! }),
      tasks: retarget(draft, (task) => (task.phase > index ? { ...task, phase: task.phase + 1 } : task)),
    }),
    updatePhase: (draft: Draft, index: number, patch: Partial<Phase>): Draft => ({
      ...draft,
      phases: replaceAt(draft.phases, index, { ...draft.phases[index]!, ...patch }),
    }),
    // A new kind brings its own preset; the length stays.
    setPhaseKind: (draft: Draft, index: number, kind: string): Draft => ({
      ...draft,
      phases: replaceAt(draft.phases, index, presetPhase(kind, draft.phases[index]!.days)),
    }),
    // The phases between the two positions shift by one to make room.
    movePhase: (draft: Draft, from: number, to: number): Draft => {
      if (from === to || to < 0 || to >= draft.phases.length) return draft
      const phases = [...draft.phases]
      phases.splice(to, 0, ...phases.splice(from, 1))
      return {
        ...draft,
        phases,
        tasks: retarget(draft, (task) => ({ ...task, phase: movedIndex(task.phase, from, to) })),
      }
    },
    // Its tasks move to the phase that takes its place.
    removePhase: (draft: Draft, index: number): Draft => {
      const last = draft.phases.length - 2
      return {
        ...draft,
        phases: draft.phases.filter((_, i) => i !== index),
        tasks: retarget(draft, (task) => ({
          ...task,
          phase: Math.min(task.phase > index ? task.phase - 1 : task.phase, last),
        })),
      }
    },

    addSite: (draft: Draft, lat: number, lon: number): Draft => ({
      ...draft,
      sites: [
        ...draft.sites,
        {
          name: freeName(
            draft.sites.map((site) => site.name),
            'SITE',
          ),
          lat,
          lon,
        },
      ],
    }),
    updateSite: (draft: Draft, index: number, patch: Partial<Site>): Draft => ({
      ...draft,
      sites: replaceAt(draft.sites, index, { ...draft.sites[index]!, ...patch }),
    }),
    // A site takes its tasks with it.
    removeSite: (draft: Draft, index: number): Draft => ({
      ...draft,
      sites: draft.sites.filter((_, i) => i !== index),
      tasks: retarget(draft, (task) => {
        if (task.site === index) return null
        return task.site > index ? { ...task, site: task.site - 1 } : task
      }),
    }),

    // An EVA planned on the map: a site at its target, unless one is already
    // there, and one EVA task as long as the walk out, the work and the walk back.
    addEva: (draft: Draft, lat: number, lon: number, hours: number, note: string): Draft => {
      const existing = draft.sites.findIndex((site) => site.lat === lat && site.lon === lon)
      const sites =
        existing >= 0
          ? draft.sites
          : [
              ...draft.sites,
              {
                name: freeName(
                  draft.sites.map((site) => site.name),
                  'EVA',
                ),
                lat,
                lon,
              },
            ]
      const outside = draft.phases.findIndex((phase) => phase.evaHoursPerWeek > 0)
      const task: Task = {
        site: existing >= 0 ? existing : draft.sites.length,
        phase: Math.max(outside, 0),
        crew: null,
        kind: catalog.taskKinds[0]!,
        eva: true,
        hours,
        note,
      }
      return { ...draft, sites, tasks: [...draft.tasks, task] }
    },

    // New tasks start in the first phase that has EVA hours to spend.
    addTask: (draft: Draft, site: number): Draft => {
      const outside = draft.phases.findIndex((phase) => phase.evaHoursPerWeek > 0)
      const task: Task = {
        site,
        phase: Math.max(outside, 0),
        crew: null,
        kind: catalog.taskKinds[0]!,
        eva: true,
        hours: 2,
        note: '',
      }
      return { ...draft, tasks: [...draft.tasks, task] }
    },
    updateTask: (draft: Draft, index: number, patch: Partial<Task>): Draft => ({
      ...draft,
      tasks: replaceAt(draft.tasks, index, { ...draft.tasks[index]!, ...patch }),
    }),
    removeTask: (draft: Draft, index: number): Draft => ({
      ...draft,
      tasks: draft.tasks.filter((_, i) => i !== index),
    }),
  }
}

const HISTORY_LIMIT = 200
const MERGE_WINDOW_MS = 1000

// Undo and redo over whole drafts. Edits that share a key and arrive close
// together, like one drag of a slider, collapse into a single undo step.
export function useHistory<T>(initial: () => T) {
  const [state, setState] = useState(() => ({
    past: [] as T[],
    present: initial(),
    future: [] as T[],
  }))
  const last = useRef({ key: '', time: 0 })

  const commit = useCallback((recipe: (current: T) => T, key = '') => {
    const now = Date.now()
    const merge = key !== '' && key === last.current.key && now - last.current.time < MERGE_WINDOW_MS
    last.current = { key, time: now }
    setState((s) => {
      const present = recipe(s.present)
      if (present === s.present) return s
      if (merge) return { ...s, present }
      return { past: [...s.past, s.present].slice(-HISTORY_LIMIT), present, future: [] }
    })
  }, [])

  // Replaces the present without adding an undo step.
  const amend = useCallback((present: T) => setState((s) => ({ ...s, present })), [])

  const undo = useCallback(() => {
    last.current = { key: '', time: 0 }
    setState((s) =>
      s.past.length === 0
        ? s
        : {
            past: s.past.slice(0, -1),
            present: s.past[s.past.length - 1]!,
            future: [s.present, ...s.future],
          },
    )
  }, [])

  const redo = useCallback(() => {
    last.current = { key: '', time: 0 }
    setState((s) =>
      s.future.length === 0 ? s : { past: [...s.past, s.present], present: s.future[0]!, future: s.future.slice(1) },
    )
  }, [])

  return {
    present: state.present,
    // What undo would go back to, if anything.
    previous: state.past[state.past.length - 1],
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    commit,
    amend,
    undo,
    redo,
  }
}
