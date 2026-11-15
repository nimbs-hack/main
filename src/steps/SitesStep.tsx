import { formatLatLon } from '../format.js'
import type { Catalog, MissionPlan, Phase, Site, Task } from '../api'
import { num, words } from '../numbers'
import type { Draft, Selection } from '../state'
import { Button, NumberField, Segmented, Select, TextField } from '../components/controls'
import { FactRow, isOpen, Row } from './parts'

const WHERE = ['eva', 'inside'] as const
// The mission file counts the people on a task after the first in four bits.
const MOST_ON_A_TASK = 16

export function SitesStep({
  catalog,
  draft,
  plan,
  selection,
  onSelect,
  placing,
  onPlacing,
  onRouteTo,
  onUpdateSite,
  onRemoveSite,
  onAddTask,
  onUpdateTask,
  onRemoveTask,
}: {
  catalog: Catalog
  draft: Draft
  plan: MissionPlan | null
  selection: Selection
  onSelect: (selection: Selection) => void
  placing: boolean
  onPlacing: (placing: boolean) => void
  // Makes the site the target of the EVA route.
  onRouteTo: (site: Site) => void
  onUpdateSite: (index: number, patch: Partial<Site>, field: string) => void
  onRemoveSite: (index: number) => void
  onAddTask: (site: number) => void
  onUpdateTask: (index: number, patch: Partial<Task>, field: string) => void
  onRemoveTask: (index: number) => void
}) {
  const crewNames = draft.crew.map((person) => person.name || 'Unnamed')
  const phaseNames = draft.phases.map((phase, i) => `${i + 1} ${words(phase.kind)}`)

  return (
    <>
      <Button aria-pressed={placing} onClick={() => onPlacing(!placing)}>
        {placing ? 'Done. Each click on the map adds a site' : 'Add sites'}
      </Button>
      {draft.sites.length === 0 && !placing && (
        <p className="note">No sites yet. Press Add sites and click the map once for each.</p>
      )}

      <ol className="items">
        {draft.sites.map((site, i) => {
          const tasks = draft.tasks.map((task, index) => ({ task, index })).filter(({ task }) => task.site === i)
          const hours = tasks.reduce((sum, { task }) => sum + task.hours, 0)
          const validPosition = !Number.isNaN(site.lat) && !Number.isNaN(site.lon)
          return (
            <Row
              key={i}
              index={i + 1}
              name={site.name || 'Unnamed'}
              meta={
                tasks.length === 0
                  ? 'no task'
                  : `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}, ${num(hours, 1)} h`
              }
              open={isOpen(selection, 'site', i)}
              onToggle={() => onSelect(isOpen(selection, 'site', i) ? null : { list: 'site', index: i })}
            >
              <TextField
                label="Name"
                value={site.name}
                maxLength={31}
                onChange={(name) => onUpdateSite(i, { name }, 'name')}
              />
              <div className="fields fields--2">
                <NumberField
                  label="Latitude, north +"
                  value={site.lat}
                  min={-90}
                  max={90}
                  step={0.0001}
                  unit="°"
                  onChange={(lat) => onUpdateSite(i, { lat }, 'lat')}
                />
                <NumberField
                  label="Longitude, east +"
                  value={site.lon}
                  min={-180}
                  max={180}
                  step={0.0001}
                  unit="°"
                  onChange={(lon) => onUpdateSite(i, { lon }, 'lon')}
                />
              </div>
              {validPosition && <p className="note">{formatLatLon(site.lat, site.lon)}, planetocentric.</p>}

              <ul className="tasks">
                {tasks.map(({ task, index }, n) => {
                  const set = <K extends keyof Task>(key: K, value: Task[K]) =>
                    onUpdateTask(index, { [key]: value } as Partial<Task>, key)
                  return (
                    <li key={index} className="task">
                      <span className="label">Task {n + 1}</span>
                      <div className="fields fields--2">
                        <Select
                          label="Kind"
                          value={task.kind}
                          options={catalog.taskKinds}
                          format={words}
                          onChange={(v) => set('kind', v)}
                        />
                        <NumberField
                          label="Length"
                          value={task.hours}
                          min={0.5}
                          max={127.5}
                          step={0.5}
                          unit="h"
                          onChange={(v) => set('hours', v)}
                        />
                      </div>
                      <div className="fields fields--2">
                        <Select
                          label="Phase"
                          value={phaseNames[task.phase]!}
                          options={phaseNames}
                          onChange={(name) => set('phase', phaseNames.indexOf(name))}
                        />
                        <Segmented
                          label="Where"
                          value={task.eva ? 'eva' : 'inside'}
                          options={WHERE}
                          format={(option) => (option === 'eva' ? 'EVA' : 'Inside')}
                          onChange={(v) => set('eva', v === 'eva')}
                        />
                      </div>
                      {/* Everyone pressed is on the task, and each works its whole length. */}
                      <div className="field" role="group" aria-label="Who">
                        <span className="label" title="Each person works the task's whole length">
                          {task.crew.length === 0 ? 'Who: nobody yet' : 'Who'}
                        </span>
                        <div className="field__buttons">
                          {crewNames.map((name, member) => {
                            const on = task.crew.includes(member)
                            const full = !on && task.crew.length >= MOST_ON_A_TASK
                            return (
                              <Button
                                key={member}
                                aria-pressed={on}
                                disabled={full}
                                title={full ? `A task takes up to ${MOST_ON_A_TASK} people` : undefined}
                                onClick={() =>
                                  set(
                                    'crew',
                                    on
                                      ? task.crew.filter((other) => other !== member)
                                      : [...task.crew, member].sort((a, b) => a - b),
                                  )
                                }
                              >
                                {name}
                              </Button>
                            )
                          })}
                        </div>
                      </div>
                      <TextField label="Note" value={task.note} maxLength={31} onChange={(v) => set('note', v)} />
                      <Button className="button--remove" onClick={() => onRemoveTask(index)}>
                        Remove task {n + 1}
                      </Button>
                    </li>
                  )
                })}
              </ul>

              <div className="actions">
                <Button onClick={() => onAddTask(i)}>Add task</Button>
                <Button
                  disabled={!validPosition}
                  title="Makes this site the EVA target. The Route tab assesses the walk"
                  onClick={() => onRouteTo(site)}
                >
                  Route here
                </Button>
                <Button className="button--remove" onClick={() => onRemoveSite(i)}>
                  Remove site{tasks.length > 0 ? ` and ${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}` : ''}
                </Button>
              </div>
            </Row>
          )
        })}
      </ol>

      {plan && draft.tasks.length > 0 && (
        <section>
          <h2 className="planner__title">EVA task hours against EVA hours available</h2>
          <dl className="facts">
            {plan.crew.map((member, i) => (
              <FactRow key={i} label={member.name}>
                {num(member.taskHours.eva, 1)} of {num(member.total.evaHours, 1)} h
              </FactRow>
            ))}
          </dl>
        </section>
      )}
    </>
  )
}
