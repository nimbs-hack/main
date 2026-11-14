import { type ReactNode, useState } from 'react'
// Positions are shown the way the map app shows them.
import { formatLatLon } from '../../../../src/format.js'
import type { Astronaut, Catalog, MissionPlan, Phase, PhaseParams, Planned, Site, Task } from '../api'
import { duration, kcal, kwh, num, range, words } from '../format'
import type { Draft, Selection } from '../state'
import {
  Button,
  ConfirmButton,
  NumberField,
  Readout,
  Segmented,
  Select,
  Slider,
  TextField,
} from './controls'

// One line of a list, drawn as the map app draws its site buttons. Opens its
// editor underneath when it is the selection; a check mark supplements the
// selected colour.
function Row({
  index,
  name,
  meta,
  open,
  onToggle,
  children,
}: {
  index?: number
  name: string
  meta: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <li className={`item${open ? ' is-open' : ''}`}>
      <button type="button" className="nav-button" aria-pressed={open} aria-expanded={open} onClick={onToggle}>
        {index !== undefined && <span className="nav-button__meta">{String(index).padStart(2, '0')}</span>}
        <span className="nav-button__label">{name}</span>
        <span className="nav-button__meta">{meta}</span>
        <span className="nav-button__arrow" aria-hidden="true">
          {open ? '✓' : '→'}
        </span>
      </button>
      {open && <div className="item__body">{children}</div>}
    </li>
  )
}

const isOpen = (selection: Selection, list: NonNullable<Selection>['list'], index: number) =>
  selection?.list === list && selection.index === index

export function MissionStep({
  catalog,
  draft,
  onName,
  onType,
  onMargin,
}: {
  catalog: Catalog
  draft: Draft
  onName: (name: string) => void
  onType: (type: string) => void
  onMargin: (percent: number) => void
}) {
  const template = catalog.missionTypes.find((entry) => entry.id === draft.type)!
  return (
    <>
      <TextField
        label="Mission name"
        value={draft.name}
        maxLength={31}
        placeholder="For example ARES-3"
        onChange={onName}
      />
      <Select label="Mission type" value={draft.type} options={catalog.missionTypes.map((entry) => entry.id)} onChange={onType} format={words} />
      <p className="note">
        {template.summary}
        {template.phases.length > 0 &&
          ` Starts with: ${template.phases.map((p) => `${p.kind} ${p.days} d`).join(', ')}.`}
      </p>
      <Slider
        label="Margin on supplies"
        value={draft.marginPercent}
        onChange={onMargin}
        max={255}
        sliderMax={50}
        unit="%"
      />
    </>
  )
}

export function CrewStep({
  catalog,
  crew,
  plan,
  selection,
  onSelect,
  roster,
  onAdd,
  onUpdate,
  onDuplicate,
  onRemove,
  onSaveToRoster,
  onDropFromRoster,
}: {
  catalog: Catalog
  crew: Astronaut[]
  plan: MissionPlan | null
  selection: Selection
  onSelect: (selection: Selection) => void
  roster: Astronaut[]
  onAdd: (person?: Astronaut) => void
  onUpdate: (index: number, patch: Partial<Astronaut>, field: string) => void
  onDuplicate: (index: number) => void
  onRemove: (index: number) => void
  onSaveToRoster: (person: Astronaut) => void
  onDropFromRoster: (name: string) => void
}) {
  const [rosterOpen, setRosterOpen] = useState(false)

  return (
    <>
      <div className="actions">
        <Button onClick={() => onAdd()}>Add crew member</Button>
        <Button aria-expanded={rosterOpen} onClick={() => setRosterOpen(!rosterOpen)}>
          {rosterOpen ? 'Hide roster' : 'Pick from roster'}
        </Button>
      </div>

      {rosterOpen && (
        <ul className="roster">
          {roster.map((person) => {
            const inCrew = crew.some((member) => member.name === person.name)
            return (
              <li key={person.name}>
                <span className="roster__who">
                  <b>{person.name}</b>
                  <span>
                    {words(person.role)}, {person.sex}, {person.age} y
                  </span>
                </span>
                <Button variant="quiet" disabled={inCrew} onClick={() => onAdd(person)}>
                  {inCrew ? 'In crew' : 'Add'}
                </Button>
                <ConfirmButton
                  label="Delete"
                  confirmLabel="Confirm"
                  aria-label={`Delete ${person.name} from the roster`}
                  onConfirm={() => onDropFromRoster(person.name)}
                />
              </li>
            )
          })}
          <li className="note">
            {roster.length === 0
              ? 'Empty. Open a crew member and save them here.'
              : 'The profiles the roster starts with are fictional samples.'}
          </li>
        </ul>
      )}

      <ul className="items">
        {crew.map((person, i) => {
          const member = plan?.crew[i]
          const daily = member?.daily
          const set = <K extends keyof Astronaut>(key: K, value: Astronaut[K]) =>
            onUpdate(i, { [key]: value } as Partial<Astronaut>, key)
          return (
            <Row
              key={i}
              name={person.name || 'Unnamed'}
              meta={daily ? `${num(kcal(daily.foodEnergyMJ))} kcal/d` : ''}
              open={isOpen(selection, 'crew', i)}
              onToggle={() => onSelect(isOpen(selection, 'crew', i) ? null : { list: 'crew', index: i })}
            >
              <div className="fields fields--2">
                <TextField label="Call sign" value={person.name} maxLength={31} onChange={(v) => set('name', v)} />
                <Segmented label="Sex" value={person.sex} options={catalog.sexes} onChange={(v) => set('sex', v)} />
              </div>
              <div className="fields fields--3">
                <NumberField label="Age" value={person.age} min={18} max={99} unit="y" onChange={(v) => set('age', v)} />
                <NumberField label="Mass" value={person.massKg} min={30} max={250} step={0.1} unit="kg" onChange={(v) => set('massKg', v)} />
                <NumberField label="Height" value={person.heightCm} min={120} max={250} unit="cm" onChange={(v) => set('heightCm', v)} />
              </div>
              <div className="fields fields--2">
                <Select label="Role" value={person.role} options={catalog.roles} format={words} onChange={(v) => set('role', v)} />
                <Select label="Activity" value={person.activity} options={catalog.activities} format={words} onChange={(v) => set('activity', v)} />
              </div>
              <Slider
                label="Share of EVA hours"
                value={Math.round(person.evaShare * 100)}
                onChange={(v) => set('evaShare', v / 100)}
                max={255}
                sliderMax={200}
                step={5}
                unit="%"
              />

              {daily && (
                <details className="details">
                  <summary>Needs per day inside</summary>
                  <dl className="facts">
                    <dt>Food energy</dt>
                    <dd>{num(kcal(daily.foodEnergyMJ))} kcal</dd>
                    <dt>Protein</dt>
                    <dd>{range(daily.proteinG)} g</dd>
                    <dt>Carbohydrate</dt>
                    <dd>{range(daily.carbohydrateG)} g</dd>
                    <dt>Fat</dt>
                    <dd>{range(daily.fatG)} g</dd>
                    <dt>Fluid</dt>
                    <dd>{num(daily.fluidL, 1)} L</dd>
                    {daily.nutrients.map((nutrient) => (
                      <FactRow key={nutrient.id} label={nutrient.label}>
                        {nutrient.max === undefined
                          ? num(nutrient.amount, nutrient.amount % 1 === 0 ? 0 : 1)
                          : `${num(nutrient.amount)}-${num(nutrient.max)}`}{' '}
                        {nutrient.unit}
                      </FactRow>
                    ))}
                  </dl>
                </details>
              )}

              <div className="actions">
                <Button onClick={() => onDuplicate(i)}>Duplicate</Button>
                <Button onClick={() => onSaveToRoster(person)}>Save to roster</Button>
                <Button className="button--remove" disabled={crew.length === 1} onClick={() => onRemove(i)}>
                  Remove
                </Button>
              </div>
            </Row>
          )
        })}
      </ul>
    </>
  )
}

function FactRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  )
}

// How each phase parameter is shown and edited. `scale` converts the stored
// value to the one on screen (watts to kilowatts, shares to percent).
const PARAMS: Array<{
  key: keyof PhaseParams
  label: string
  unit: string
  scale: number
  max: number
  sliderMax: number
  step: number
}> = [
  { key: 'evaHoursPerWeek', label: 'EVA per person-week', unit: 'h', scale: 1, max: 127.5, sliderMax: 56, step: 0.5 },
  { key: 'waterRecovery', label: 'Water recycled', unit: '%', scale: 100, max: 100, sliderMax: 100, step: 1 },
  { key: 'oxygenRecovery', label: 'Oxygen recycled', unit: '%', scale: 100, max: 100, sliderMax: 100, step: 1 },
  { key: 'hygieneWaterKg', label: 'Hygiene water per person-day', unit: 'kg', scale: 1, max: 655.35, sliderMax: 10, step: 0.01 },
  { key: 'basePowerW', label: 'Vehicle base power', unit: 'kW', scale: 0.001, max: 655.35, sliderMax: 30, step: 0.01 },
  { key: 'crewPowerW', label: 'Power per person', unit: 'kW', scale: 0.001, max: 655.35, sliderMax: 5, step: 0.01 },
]

// Avoids 18.53 showing as 18.530000000000001 after the unit conversion.
const tidy = (value: number): number => Math.round(value * 1e6) / 1e6

export function PhasesStep({
  catalog,
  phases,
  selection,
  onSelect,
  onAdd,
  onUpdate,
  onKind,
  onMove,
  onDuplicate,
  onRemove,
}: {
  catalog: Catalog
  phases: Phase[]
  selection: Selection
  onSelect: (selection: Selection) => void
  onAdd: (kind: string) => void
  onUpdate: (index: number, patch: Partial<Phase>, field: string) => void
  onKind: (index: number, kind: string) => void
  onMove: (index: number, by: -1 | 1) => void
  onDuplicate: (index: number) => void
  onRemove: (index: number) => void
}) {
  return (
    <>
      <div className="field">
        <label className="label" htmlFor="add-phase">
          Add a phase after the open one
        </label>
        <select
          id="add-phase"
          className="input"
          value=""
          onChange={(e) => onAdd(e.target.value)}
        >
          <option value="" disabled>
            Choose a kind
          </option>
          {catalog.phaseKinds.map((kind) => (
            <option key={kind.id} value={kind.id}>
              {kind.id}
            </option>
          ))}
        </select>
      </div>

      <ol className="items">
        {phases.map((phase, i) => {
          const preset = catalog.phaseKinds.find((entry) => entry.id === phase.kind)!
          return (
            <Row
              key={i}
              index={i + 1}
              name={phase.kind}
              meta={Number.isNaN(phase.days) ? '' : `${num(phase.days)} d`}
              open={isOpen(selection, 'phase', i)}
              onToggle={() => onSelect(isOpen(selection, 'phase', i) ? null : { list: 'phase', index: i })}
            >
              <p className="note">{preset.summary}</p>
              <div className="fields fields--2">
                <Select label="Kind" value={phase.kind} options={catalog.phaseKinds.map((entry) => entry.id)} onChange={(kind) => onKind(i, kind)} />
                <NumberField label="Length" value={phase.days} min={1} max={65535} unit="d" onChange={(days) => onUpdate(i, { days }, 'days')} />
              </div>
              {PARAMS.map((param) => {
                const changed = phase[param.key] !== preset[param.key]
                const presetShown = tidy(preset[param.key] * param.scale)
                return (
                  <Slider
                    key={param.key}
                    label={param.label}
                    value={tidy(phase[param.key] * param.scale)}
                    onChange={(v) => onUpdate(i, { [param.key]: v / param.scale }, param.key)}
                    max={param.max}
                    sliderMax={param.sliderMax}
                    step={param.step}
                    unit={param.unit}
                    note={
                      changed && (
                        <button
                          type="button"
                          className="preset"
                          onClick={() => onUpdate(i, { [param.key]: preset[param.key] }, '')}
                        >
                          Changed. Back to preset {presetShown}
                          {param.unit === '%' ? '%' : ` ${param.unit}`}
                        </button>
                      )
                    }
                  />
                )
              })}
              <div className="actions">
                <Button disabled={i === 0} onClick={() => onMove(i, -1)}>
                  Earlier
                </Button>
                <Button disabled={i === phases.length - 1} onClick={() => onMove(i, 1)}>
                  Later
                </Button>
                <Button onClick={() => onDuplicate(i)}>Duplicate</Button>
                <Button className="button--remove" disabled={phases.length === 1} onClick={() => onRemove(i)}>
                  Remove
                </Button>
              </div>
            </Row>
          )
        })}
      </ol>
    </>
  )
}

const NOBODY = 'Nobody yet'
const WHERE = ['eva', 'inside'] as const

export function SitesStep({
  catalog,
  draft,
  plan,
  selection,
  onSelect,
  placing,
  onPlacing,
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
  onUpdateSite: (index: number, patch: Partial<Site>, field: string) => void
  onRemoveSite: (index: number) => void
  onAddTask: (site: number) => void
  onUpdateTask: (index: number, patch: Partial<Task>, field: string) => void
  onRemoveTask: (index: number) => void
}) {
  const crewNames = draft.crew.map((person) => person.name || 'Unnamed')
  const phaseNames = draft.phases.map((phase, i) => `${i + 1} ${phase.kind}`)

  return (
    <>
      <Button aria-pressed={placing} onClick={() => onPlacing(!placing)}>
        {placing ? 'Cancel: click the map to place it' : 'Add site'}
      </Button>
      {draft.sites.length === 0 && !placing && (
        <p className="note">No sites yet. Press Add site, then click the map where the work is.</p>
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
              meta={tasks.length === 0 ? 'no tasks' : `${tasks.length} tasks, ${num(hours, 1)} h`}
              open={isOpen(selection, 'site', i)}
              onToggle={() => onSelect(isOpen(selection, 'site', i) ? null : { list: 'site', index: i })}
            >
              <TextField label="Site name" value={site.name} maxLength={31} onChange={(name) => onUpdateSite(i, { name }, 'name')} />
              <div className="fields fields--2">
                <NumberField label="Latitude, north +" value={site.lat} min={-90} max={90} step={0.0001} unit="°" onChange={(lat) => onUpdateSite(i, { lat }, 'lat')} />
                <NumberField label="Longitude, east +" value={site.lon} min={-180} max={180} step={0.0001} unit="°" onChange={(lon) => onUpdateSite(i, { lon }, 'lon')} />
              </div>
              <p className="note">
                {validPosition && `${formatLatLon(site.lat, site.lon)}, planetocentric. `}Drag the marker on the map to move the
                site.
              </p>

              <ul className="tasks">
                {tasks.map(({ task, index }, n) => {
                  const set = <K extends keyof Task>(key: K, value: Task[K]) =>
                    onUpdateTask(index, { [key]: value } as Partial<Task>, key)
                  return (
                    <li key={index} className="task">
                      <span className="label">Task {n + 1}</span>
                      <div className="fields fields--2">
                        <Select label="Kind" value={task.kind} options={catalog.taskKinds} onChange={(v) => set('kind', v)} />
                        <NumberField label="Length" value={task.hours} min={0.5} max={127.5} step={0.5} unit="h" onChange={(v) => set('hours', v)} />
                      </div>
                      <div className="fields fields--2">
                        <Select
                          label="Who"
                          value={task.crew === null ? NOBODY : crewNames[task.crew]!}
                          options={[NOBODY, ...crewNames]}
                          onChange={(name) => set('crew', name === NOBODY ? null : crewNames.indexOf(name))}
                        />
                        <Select
                          label="Phase"
                          value={phaseNames[task.phase]!}
                          options={phaseNames}
                          onChange={(name) => set('phase', phaseNames.indexOf(name))}
                        />
                      </div>
                      <div className="fields fields--2">
                        <Segmented
                          label="Where"
                          value={task.eva ? 'eva' : 'inside'}
                          options={WHERE}
                          format={(option) => (option === 'eva' ? 'EVA' : 'Inside')}
                          onChange={(v) => set('eva', v === 'eva')}
                        />
                        <TextField label="Note" value={task.note} maxLength={31} onChange={(v) => set('note', v)} />
                      </div>
                      <Button className="button--remove" onClick={() => onRemoveTask(index)}>
                        Remove task {n + 1}
                      </Button>
                    </li>
                  )
                })}
              </ul>

              <div className="actions">
                <Button onClick={() => onAddTask(i)}>Add task</Button>
                <Button className="button--remove" onClick={() => onRemoveSite(i)}>
                  Remove site{tasks.length > 0 ? ` and ${tasks.length} tasks` : ''}
                </Button>
              </div>
            </Row>
          )
        })}
      </ol>

      {plan && draft.tasks.length > 0 && (
        <section>
          <h2 className="sites__title">EVA task hours against EVA hours available</h2>
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

const SECONDS_PER_DAY = 86400

// Share of what was used that recycling gave back.
const recycled = (used: number, supplied: number): string =>
  used > 0 ? `${Math.round((1 - supplied / used) * 100)}% recycled` : ''

export function ReviewStep({
  catalog,
  planned,
  onExportJson,
}: {
  catalog: Catalog
  planned: Planned
  onExportJson: () => void
}) {
  const { mission, plan, cautions: warnings } = planned
  const { rates } = catalog
  const { total, provision } = plan
  const seconds = plan.days * SECONDS_PER_DAY
  const noBaseLoad = mission.phases.some((phase) => phase.basePowerW === 0)

  return (
    <>
      {warnings.length > 0 ? (
        <ul className="cautions" aria-label="Cautions">
          {warnings.map((warning) => (
            <li key={warning}>
              <b>Caution</b>
              {warning}
            </li>
          ))}
        </ul>
      ) : (
        <p className="note">Nothing to fix. Every task fits the EVA hours of its phase.</p>
      )}

      <section>
        <h2 className="sites__title">To supply, {plan.marginPercent}% margin included</h2>
        <div className="review__grid">
          <Readout label="Food, packaged" value={`${num(provision.foodKg)} kg`} sub={`${num(kcal(provision.foodEnergyMJ) / 1e6, 2)} Gcal`} />
          <Readout label="Water" value={`${num(provision.waterSupplyKg)} kg`} sub={recycled(total.waterUsedKg, total.waterSupplyKg)} />
          <Readout label="Oxygen" value={`${num(provision.oxygenSupplyKg)} kg`} sub={recycled(total.oxygenUsedKg, total.oxygenSupplyKg)} />
          <Readout
            label="Electricity"
            value={`${num(kwh(provision.electricityMJ))} kWh`}
            sub={`${num((total.electricityMJ * 1000) / seconds, 2)} kW average`}
          />
        </div>
        {noBaseLoad && (
          <p className="note">
            Electricity covers life support and crew equipment only where a phase has no vehicle base
            power set.
          </p>
        )}
      </section>

      <section>
        <h2 className="sites__title">Loads on the vehicle</h2>
        <dl className="facts">
          <dt>Carbon dioxide to remove</dt>
          <dd>{num(total.co2Kg)} kg</dd>
          <dt>Body heat to reject, average</dt>
          <dd>{num((total.heatMJ * 1e6) / seconds)} W</dd>
          <dt>EVA, all crew</dt>
          <dd>{num(total.evaHours)} h</dd>
        </dl>
      </section>

      <section>
        <h2 className="sites__title">To supply by phase, before margin</h2>
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Phase</th>
              <th scope="col">Food kg</th>
              <th scope="col">Water kg</th>
              <th scope="col">Oxygen kg</th>
            </tr>
          </thead>
          <tbody>
            {plan.phases.map((phase, i) => (
              <tr key={i}>
                <th scope="row">
                  {i + 1} {phase.kind}
                </th>
                <td>{num(phase.total.foodKg)}</td>
                <td>{num(phase.total.waterSupplyKg)}</td>
                <td>{num(phase.total.oxygenSupplyKg)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="sites__title">By crew member, whole mission</h2>
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Crew</th>
              <th scope="col">kcal/d</th>
              <th scope="col">Food kg</th>
              <th scope="col">Tasks h</th>
            </tr>
          </thead>
          <tbody>
            {plan.crew.map((member, i) => (
              <tr key={i}>
                <th scope="row">{member.name}</th>
                <td>{num(kcal(member.daily.foodEnergyMJ))}</td>
                <td>{num(member.total.foodKg)}</td>
                <td>{num(member.taskHours.eva + member.taskHours.inside, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="sites__title">Mission file</h2>
        <dl className="facts">
          <dt>Size</dt>
          <dd>{num(planned.fileBytes)} bytes</dd>
          {planned.links.map((link) => (
            <FactRow key={link.id} label={`At ${num(link.bitsPerSecond)} bit/s`}>
              {duration(link.seconds)}
            </FactRow>
          ))}
        </dl>
        <p className="note">
          Times are for Curiosity's links: safe-mode antenna, typical uplink from Earth, relay through
          an orbiter.
        </p>
        <Button onClick={onExportJson}>Export as JSON instead</Button>
      </section>

      <details className="details">
        <summary>How these numbers are worked out</summary>
        <dl className="facts">
          <dt>Food energy per person-day</dt>
          <dd>DRI equation</dd>
          <dt>Added per EVA hour</dt>
          <dd>{rates.evaFoodKcalPerHour} kcal</dd>
          <dt>Food, packaged, per 1,000 kcal</dt>
          <dd>{num(rates.foodKgPer1000Kcal ?? NaN, 2)} kg</dd>
          <dt>Oxygen breathed per 1,000 kcal</dt>
          <dd>{num(rates.oxygenKgPer1000Kcal ?? NaN, 3)} kg</dd>
          <dt>Carbon dioxide per 1,000 kcal</dt>
          <dd>{num(rates.co2KgPer1000Kcal ?? NaN, 3)} kg</dd>
          <dt>Drinking and food water per person-day</dt>
          <dd>{rates.potableWaterKgPerDay} kg or more</dd>
          <dt>Drinking water per EVA hour</dt>
          <dd>{rates.evaDrinkKgPerHour} kg</dd>
          <dt>Suit cooling water lost per EVA hour</dt>
          <dd>{rates.evaCoolingWaterKgPerHour} kg</dd>
          <dt>Suit oxygen lost per EVA hour</dt>
          <dd>{rates.evaOxygenLossKgPerHour} kg</dd>
        </dl>
        <p className="note">
          Rates are from NASA's life support baseline document, NASA-STD-3001 and the 2020 exploration
          nutrition requirements. Recycling, EVA hours and power are the phase settings in step 3, and
          you can change every one of them. The planner's README lists each source and what is assumed.
        </p>
      </details>
    </>
  )
}
