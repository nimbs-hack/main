import type { Catalog, Phase, Planned } from '../api'
import { duration, kcal, kwh, num } from '../format'
import { Button, Readout } from '../components/controls'
import { FactRow } from './parts'

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
        <h2 className="planner__title">To supply, {plan.marginPercent}% margin included</h2>
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
        <h2 className="planner__title">Loads on the vehicle</h2>
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
        <h2 className="planner__title">To supply by phase, before margin</h2>
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
        <h2 className="planner__title">By crew member, whole mission</h2>
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
        <h2 className="planner__title">Mission file</h2>
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
