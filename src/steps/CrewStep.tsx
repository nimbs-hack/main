import { useState } from 'react'
import type { Astronaut, Catalog, MissionPlan } from '../api'
import { kcal, num, range, words } from '../format'
import type { Selection } from '../state'
import { Button, ConfirmButton, NumberField, Segmented, Select, Slider, TextField } from '../components/controls'
import { FactRow, isOpen, Row } from './parts'

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
