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
      <Slider
        label="Margin on supplies"
        value={draft.marginPercent}
        onChange={onMargin}
        min={catalog.minMarginPercent}
        max={catalog.maxMarginPercent}
        unit="%"
      />
    </>
  )
}
