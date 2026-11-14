import { useState } from 'react'
import type { Astronaut, Catalog, MissionPlan } from '../api'
import { kcal, num, range, words } from '../numbers'
import { Button, ConfirmButton, NumberField, Segmented, Select, Slider, TextField } from '../components/controls'
import { Portrait } from '../components/Portrait'
import { StageIcon } from '../components/icons'
import { FactRow } from './parts'

// One list of people. Those going on the mission are outlined in the accent
// colour. The rest wait on the roster, which the browser keeps. A person in
// both is shown once, as the mission has them.
export function CrewStep({
  catalog,
  crew,
  plan,
  roster,
  onNew,
  onSelect,
  onDeselect,
  onUpdate,
  onUpdateRoster,
  onDelete,
}: {
  catalog: Catalog
  crew: Astronaut[]
  plan: MissionPlan | null
  roster: Astronaut[]
  // Adds a new person to the list and the crew, and returns their call sign.
  onNew: () => string
  onSelect: (person: Astronaut) => void
  onDeselect: (index: number) => void
  onUpdate: (index: number, patch: Partial<Astronaut>, field: string) => void
  onUpdateRoster: (name: string, patch: Partial<Astronaut>) => void
  // Takes the person off the crew and the roster.
  onDelete: (name: string) => void
}) {
  // The call sign whose information is open.
  const [open, setOpen] = useState<string | null>(null)

  const people = [
    ...roster.map((person) => crew.find((member) => member.name === person.name) ?? person),
    ...crew.filter((member) => !roster.some((person) => person.name === member.name)),
  ]

  return (
    <section className="card">
      <h2 className="card__title">
        <StageIcon id="crew" />
        Crew
        <button
          type="button"
          className="button card__add"
          aria-label="Add a crew member"
          title="Add a crew member"
          onClick={() => setOpen(onNew())}
        >
          +
        </button>
      </h2>

      <ul className="people">
        {people.map((person) => {
          const at = crew.findIndex((member) => member.name === person.name)
          const selected = at >= 0
          const isOpen = open === person.name
          const daily = selected ? plan?.crew[at]?.daily : undefined
          const last = selected && crew.length === 1
          const set = <K extends keyof Astronaut>(key: K, value: Astronaut[K]) => {
            const patch = { [key]: value } as Partial<Astronaut>
            if (selected) onUpdate(at, patch, key)
            else onUpdateRoster(person.name, patch)
            if (key === 'name') setOpen(value as string)
          }
          return (
            <li key={person.name} className={`person${selected ? ' is-selected' : ''}`}>
              <div className="person__line">
                <Portrait name={person.name} />
                <span className="person__name">{person.name || 'Unnamed'}</span>
                <button
                  type="button"
                  className="button person__more"
                  aria-expanded={isOpen}
                  aria-label={`${isOpen ? 'Hide' : 'Show'} information for ${person.name}`}
                  title="Information"
                  onClick={() => setOpen(isOpen ? null : person.name)}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d={isOpen ? 'm3 10 5-5 5 5' : 'm3 6 5 5 5-5'} />
                  </svg>
                </button>
                {/* The outline says who is going. The last one cannot be taken off. */}
                <Button
                  disabled={last}
                  title={last ? 'A mission needs one crew member' : undefined}
                  onClick={() => (selected ? onDeselect(at) : onSelect(person))}
                >
                  {selected ? 'Deselect' : 'Select'}
                </Button>
              </div>

              {isOpen && (
                <div className="item__body">
                  <div className="crew-profile">
                    <Portrait name={person.name} size="large" />
                    <div className="fields">
                      <TextField
                        label="Call sign"
                        value={person.name}
                        maxLength={31}
                        onChange={(v) => set('name', v)}
                      />
                      <Segmented
                        label="Sex"
                        value={person.sex}
                        options={catalog.sexes}
                        onChange={(v) => set('sex', v)}
                      />
                      <Select
                        label="Role"
                        value={person.role}
                        options={catalog.roles}
                        format={words}
                        onChange={(v) => set('role', v)}
                      />
                    </div>
                  </div>
                  <NumberField
                    label="Age"
                    value={person.age}
                    min={18}
                    max={99}
                    unit="y"
                    onChange={(v) => set('age', v)}
                  />
                  <NumberField
                    label="Mass"
                    value={person.massKg}
                    min={30}
                    max={250}
                    step={0.1}
                    unit="kg"
                    onChange={(v) => set('massKg', v)}
                  />
                  <NumberField
                    label="Height"
                    value={person.heightCm}
                    min={120}
                    max={250}
                    unit="cm"
                    onChange={(v) => set('heightCm', v)}
                  />
                  <Select
                    label="Activity"
                    value={person.activity}
                    options={catalog.activities}
                    format={words}
                    onChange={(v) => set('activity', v)}
                  />
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
                        <FactRow label="Food energy">{num(kcal(daily.foodEnergyMJ))} kcal</FactRow>
                        <FactRow label="Protein">{range(daily.proteinG)} g</FactRow>
                        <FactRow label="Carbohydrate">{range(daily.carbohydrateG)} g</FactRow>
                        <FactRow label="Fat">{range(daily.fatG)} g</FactRow>
                        <FactRow label="Fluid">{num(daily.fluidL, 1)} L</FactRow>
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
                    <ConfirmButton
                      label="Delete from the list"
                      confirmLabel="Confirm delete"
                      className="button--remove"
                      disabled={last}
                      onConfirm={() => {
                        setOpen(null)
                        onDelete(person.name)
                      }}
                    />
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
