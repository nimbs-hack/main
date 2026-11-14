import { type ComponentType, type ReactNode, useMemo, useState } from 'react'
import type { Viewer } from 'cesium'
import type { Catalog, MissionPlan, Site, Task } from '../api'
import UntypedGlobe from '../components/MarsGlobe.jsx'
import StatusBar from '../components/StatusBar.jsx'
import { SITES } from '../data/sites.js'
import type { Draft, Selection } from '../state'
import { SitesStep } from './SitesStep'

// What the map hands over when an assessed EVA is added to the mission.
interface Eva {
  // Planetocentric latitude and east longitude, -180 to 180.
  target: [lat: number, lon: number]
  // Walk out, work at the target and walk back.
  seconds: number
  // One way, in metres.
  distance: number
  maxSlope: number | null
  verdict: 'go' | 'caution' | 'no-go'
}

// What the map gives its side panel so the panel can drive map clicks.
interface MapHooks {
  placing: string | null
  onPlacing: (mode: string | null) => void
  canTarget: boolean
  onTarget: (point: [number, number]) => void
}

// MarsGlobe is plain JavaScript. These are the props this page relies on.
const MarsGlobe = UntypedGlobe as unknown as ComponentType<{
  site: (typeof SITES)[number] | null
  onSite: (id: string) => void
  onStatus: (status: string) => void
  onImagerySource: (source: string) => void
  onScienceSource: (credit: string) => void
  onViewer: (viewer: Viewer | null) => void
  mission: {
    sites: Site[]
    taskCounts: number[]
    selected: number
    onSelect: (index: number) => void
    onAddSite: (point: [number, number]) => void
    onAddEva: (eva: Eva) => void
  }
  aside: (hooks: MapHooks) => ReactNode
}>

// Tasks are stored in half hours, from 0.5 to 127.5.
const taskHours = (seconds: number): number => Math.min(127.5, Math.max(0.5, Math.ceil(seconds / 1800) / 2))

// The task note is 31 ASCII characters at most, so it carries the verdict,
// the one-way distance and the steepest slope.
function evaNote({ verdict, distance, maxSlope }: Eva): string {
  const slope = maxSlope === null ? '' : `, ${Math.round(maxSlope)} deg max`
  return `${verdict.toUpperCase()} ${(distance / 1000).toFixed(1)} km${slope}`.slice(0, 31)
}

// The sites stage: the EVA route planner and science layers on the left and
// the map, and the mission's sites and tasks on the right. An assessed EVA
// becomes a site with a task, so its hours count against the phase.
export function SitesPage({
  catalog,
  draft,
  plan,
  taskCounts,
  selection,
  onSelect,
  onSettle,
  onAddSite,
  onAddEva,
  onUpdateSite,
  onRemoveSite,
  onAddTask,
  onUpdateTask,
  onRemoveTask,
}: {
  catalog: Catalog
  draft: Draft
  plan: MissionPlan | null
  taskCounts: number[]
  selection: Selection
  onSelect: (selection: Selection) => void
  onSettle: () => void
  onAddSite: (lat: number, lon: number) => void
  onAddEva: (lat: number, lon: number, hours: number, note: string) => void
  onUpdateSite: (index: number, patch: Partial<Site>, field: string) => void
  onRemoveSite: (index: number) => void
  onAddTask: (site: number) => void
  onUpdateTask: (index: number, patch: Partial<Task>, field: string) => void
  onRemoveTask: (index: number) => void
}) {
  // The landing site in view, from the map's own list of NASA missions.
  const [siteId, setSiteId] = useState<string | null>(null)
  const [status, setStatus] = useState('loading')
  const [imagerySource, setImagerySource] = useState('V01')
  const [scienceCredit, setScienceCredit] = useState('')
  const [viewer, setViewer] = useState<Viewer | null>(null)

  const site = SITES.find((entry) => entry.id === siteId) ?? null
  const credits = [
    ...(scienceCredit ? scienceCredit.split(' · ') : []),
    `CTX ${imagerySource}: NASA / JPL / USGS / MSSS / The Murray Lab / Esri`,
    'Terrain: NASA Mars Trek',
  ]

  const mission = useMemo(
    () => ({
      sites: draft.sites,
      taskCounts,
      selected: selection?.list === 'site' ? selection.index : -1,
      onSelect: (index: number) => onSelect({ list: 'site', index }),
      onAddSite: ([lat, lon]: [number, number]) => onAddSite(lat, lon),
      onAddEva: (eva: Eva) => onAddEva(eva.target[0], eva.target[1], taskHours(eva.seconds), evaNote(eva)),
    }),
    // The handlers close over the current draft, so they change with it.
    [draft, taskCounts, selection],
  )

  return (
    <>
      <MarsGlobe
        site={site}
        // Picking the selected site again returns to the global view.
        onSite={(id: string) => setSiteId((current) => (current === id ? null : id))}
        onStatus={setStatus}
        onImagerySource={setImagerySource}
        onScienceSource={setScienceCredit}
        onViewer={setViewer}
        mission={mission}
        aside={({ placing, onPlacing, canTarget, onTarget }: MapHooks) => (
          <aside className="sites" aria-label="Mission sites and tasks" onBlur={onSettle}>
            <h2 className="card__title">Mission sites</h2>
            <SitesStep
              catalog={catalog}
              draft={draft}
              plan={plan}
              selection={selection}
              onSelect={onSelect}
              placing={placing === 'site'}
              onPlacing={(on) => onPlacing(on ? 'site' : null)}
              onTarget={
                canTarget
                  ? (index) => {
                      const target = draft.sites[index]!
                      onTarget([target.lat, target.lon])
                    }
                  : null
              }
              onUpdateSite={onUpdateSite}
              onRemoveSite={onRemoveSite}
              onAddTask={onAddTask}
              onUpdateTask={onUpdateTask}
              onRemoveTask={onRemoveTask}
            />
          </aside>
        )}
      />
      <StatusBar viewer={viewer} status={status} credits={credits} />
    </>
  )
}
