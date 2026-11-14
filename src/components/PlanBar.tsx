import type { Planned } from '../api'
import { duration, kcal, kwh, num } from '../numbers'
import { Readout } from './controls'

// What the last edit did to a number, as "+1,669 kg" or "-12 kg". Empty when
// the edit left it alone. The sign carries the direction, not a colour.
function change(now: number, before: number | undefined, unit: string): string | undefined {
  if (before === undefined) return undefined
  const difference = Math.round(now) - Math.round(before)
  if (difference === 0) return undefined
  return `${difference > 0 ? '+' : '−'}${num(Math.abs(difference))} ${unit} last edit`
}

// The plan, always in view under the globe, with the effect of the last edit
// under each number. While the draft cannot be planned it shows the last
// numbers that could, marked as stale.
export function PlanBar({ shown, before, stale }: { shown: Planned; before: Planned | null; stale: boolean }) {
  const { plan, fileBytes: size } = shown
  const { provision } = plan
  const was = before?.plan.provision
  const typicalLink = shown.links.find((link) => link.id === 'x-band-hga')
  return (
    <section className={`planbar${stale ? ' is-stale' : ''}`} aria-label="Plan">
      <h2 className="readout__label">
        To supply, {plan.marginPercent}% margin included
        {stale && <b className="planbar__stale">Stale: from the last valid mission</b>}
      </h2>
      <div className="planbar__grid">
        <Readout
          label="Food"
          value={`${num(provision.foodKg)} kg`}
          sub={change(provision.foodKg, was?.foodKg, 'kg') ?? `${num(kcal(provision.foodEnergyMJ) / 1e6, 1)} Gcal`}
        />
        <Readout
          label="Water"
          value={`${num(provision.waterSupplyKg)} kg`}
          sub={change(provision.waterSupplyKg, was?.waterSupplyKg, 'kg')}
        />
        <Readout
          label="Oxygen"
          value={`${num(provision.oxygenSupplyKg)} kg`}
          sub={change(provision.oxygenSupplyKg, was?.oxygenSupplyKg, 'kg')}
        />
        <Readout
          label="Electricity"
          value={`${num(kwh(provision.electricityMJ))} kWh`}
          sub={change(kwh(provision.electricityMJ), was && kwh(was.electricityMJ), 'kWh')}
        />
        <Readout
          label="Duration"
          value={`${num(plan.days)} d`}
          sub={change(plan.days, before?.plan.days, 'd') ?? `${plan.crew.length} crew`}
        />
        <Readout
          label="Mission file"
          value={`${num(size)} B`}
          sub={
            change(size, before?.fileBytes, 'B') ??
            (typicalLink ? `${duration(typicalLink.seconds)} at 1 kbit/s` : undefined)
          }
        />
      </div>
    </section>
  )
}
