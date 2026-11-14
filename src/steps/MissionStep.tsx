import type { Catalog } from '../api'
import { words } from '../format'
import type { Draft } from '../state'
import { Select, Slider, TextField } from '../components/controls'

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
