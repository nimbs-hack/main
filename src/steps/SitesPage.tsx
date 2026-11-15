import { type ComponentType, type ReactNode, useMemo, useState } from 'react'
import type { Viewer } from 'cesium'
import type { Astronaut, Catalog, MissionPlan, Site, Task } from '../api'
import UntypedGlobe from '../components/MarsGlobe.jsx'
import StatusBar from '../components/StatusBar.jsx'
import { portraitUrl } from '../components/Portrait'
import { SITES } from '../data/sites.js'
import type { Marker } from '../data/markers'
import { loadPhotos, photoKey, type Draft, type Selection } from '../state'
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

// What the map gives its side panel so the panel can drive the map.
interface MapHooks {
  placing: string | null
  onPlacing: (mode: string | null) => void
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
    id: string
    crew: (Astronaut & { photo?: string })[]
    markers: Marker[]
    onMarkers: (markers: Marker[]) => void
    sites: Site[]
    taskCounts: number[]
    selected: number
    onSelect: (index: number) => void
    onAddSite: (point: [number, number]) => void
    onAddEva: (eva: Eva) => void
    flag: 'caution' | null
  }
  missionPanel: (hooks: MapHooks) => ReactNode
}>

// Tasks are stored in half hours, from 0.5 to 127.5.
const taskHours = (seconds: number): number => Math.min(127.5, Math.max(0.5, Math.ceil(seconds / 1800) / 2))

// The task note is 31 ASCII characters at most, so it carries the verdict,
// the one-way distance and the steepest slope.
function evaNote({ verdict, distance, maxSlope }: Eva): string {
  const slope = maxSlope === null ? '' : `, ${Math.round(maxSlope)} deg max`
  return `${verdict.toUpperCase()} ${(distance / 1000).toFixed(1)} km${slope}`.slice(0, 31)
}

// The sites stage: the map with the plan panel on its left. The mission's
// sites and tasks are its Sites plan tab, next to the EVA route settings. The
// EVA route runs through the sites in list order. An assessed EVA becomes a
// task at its target site, so its hours count against the phase.
export function SitesPage({
  missionId,
  catalog,
  draft,
  plan,
  taskCounts,
  selection,
  onSelect,
  onSettle,
  onMarkers,
  onAddSite,
  onAddEva,
  onUpdateSite,
  onMoveSite,
  onRemoveSite,
  onAddTask,
  onUpdateTask,
  onRemoveTask,
}: {
  missionId: string
  catalog: Catalog
  draft: Draft
  plan: MissionPlan | null
  taskCounts: number[]
  selection: Selection
  onSelect: (selection: Selection) => void
  onSettle: () => void
  onMarkers: (markers: Marker[]) => void
  onAddSite: (lat: number, lon: number) => void
  onAddEva: (lat: number, lon: number, hours: number, note: string) => void
  onUpdateSite: (index: number, patch: Partial<Site>, field: string) => void
  onMoveSite: (index: number, to: number) => void
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
  const [photos] = useState(loadPhotos)

  const site = SITES.find((entry) => entry.id === siteId) ?? null
  const credits = [
    ...(scienceCredit ? scienceCredit.split(' · ') : []),
    `CTX ${imagerySource}: NASA / JPL / USGS / MSSS / The Murray Lab / Esri`,
    'Terrain: NASA Mars Trek',
  ]

  const mission = useMemo(
    () => ({
      id: missionId,
      crew: draft.crew.map((person) => ({ ...person, photo: portraitUrl(person.name, photos[photoKey(person.name)]) })),
      markers: draft.markers ?? [],
      onMarkers,
      sites: draft.sites,
      taskCounts,
      selected: selection?.list === 'site' ? selection.index : -1,
      onSelect: (index: number) => onSelect({ list: 'site', index }),
      onAddSite: ([lat, lon]: [number, number]) => onAddSite(lat, lon),
      onAddEva: (eva: Eva) => onAddEva(eva.target[0], eva.target[1], taskHours(eva.seconds), evaNote(eva)),
      // Tasks nobody is assigned to, or more EVA task hours than a phase gives.
      flag: plan && (plan.unassignedTaskHours > 0 || plan.evaOverruns.length > 0) ? ('caution' as const) : null,
    }),
    // The handlers close over the current draft, so they change with it.
    [missionId, draft, plan, taskCounts, selection, onMarkers, photos],
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
        missionPanel={({ placing, onPlacing }: MapHooks) => (
          <div className="sites" onBlur={onSettle}>
            <SitesStep
              catalog={catalog}
              draft={draft}
              plan={plan}
              selection={selection}
              onSelect={onSelect}
              placing={placing === 'site'}
              onPlacing={(on) => onPlacing(on ? 'site' : null)}
              onUpdateSite={onUpdateSite}
              onMoveSite={onMoveSite}
              onRemoveSite={onRemoveSite}
              onAddTask={onAddTask}
              onUpdateTask={onUpdateTask}
              onRemoveTask={onRemoveTask}
            />
          </div>
        )}
      />
      <StatusBar viewer={viewer} status={status} credits={credits} />
    </>
  )
}
