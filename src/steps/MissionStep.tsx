import type { Catalog } from '../api'
import { StageIcon } from '../components/icons'
import { num, words } from '../numbers'
import type { Draft, StepId } from '../state'
import { Button, Select, Slider, TextField } from '../components/controls'

const count = (n: number, thing: string) => `${num(n)} ${thing}${n === 1 ? '' : 's'}`

// Where a mission starts: its name, type and margin, or a file to open. The
// second card says what the mission holds so far and leads to each stage.
export function MissionStep({
  catalog,
  draft,
  status,
  days,
  onGoTo,
  onName,
  onType,
  onMargin,
  onOpen,
  onNew,
}: {
  catalog: Catalog
  draft: Draft
  // What review would say: a problem, a number of cautions, or nothing to fix.
  status: string
  days: number
  onGoTo: (step: StepId) => void
  onName: (name: string) => void
  onType: (type: string) => void
  onMargin: (percent: number) => void
  onOpen: () => void
  onNew: () => void
}) {
  const contents: Array<[StepId, string, string]> = [
    ['crew', 'Crew', count(draft.crew.length, 'person').replace('persons', 'people')],
    ['phases', 'Phases', `${count(draft.phases.length, 'phase')}, ${num(days)} d`],
    ['sites', 'Sites', `${count(draft.sites.length, 'site')}, ${count(draft.tasks.length, 'task')}`],
    ['review', 'Review', status],
  ]
  return (
    <>
      <section className="card">
        <h2 className="card__title">
          <StageIcon id="mission" />
          Mission
        </h2>
        <TextField label="Name" value={draft.name} maxLength={31} placeholder="For example ARES-3" onChange={onName} />
        <Select label="Type" value={draft.type} options={catalog.missionTypes.map((entry) => entry.id)} onChange={onType} format={words} />
        <Slider
          label="Margin on supplies"
          value={draft.marginPercent}
          onChange={onMargin}
          min={catalog.minMarginPercent}
          max={catalog.maxMarginPercent}
          unit="%"
        />
        <div className="actions">
          <Button onClick={onOpen}>Open mission file</Button>
          <Button onClick={onNew}>Start a new mission</Button>
        </div>
      </section>

      <section className="card">
        <h2 className="card__title">In this mission</h2>
        <ul className="contents">
          {contents.map(([id, label, value]) => (
            <li key={id}>
              <button type="button" onClick={() => onGoTo(id)}>
                <StageIcon id={id} />
                <span>{label}</span>
                <output>{value}</output>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </>
  )
}
