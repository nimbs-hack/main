import { useEffect } from 'react'
import { guidance, slopeLevel, SLOPE_LIMIT } from '../data/route-profile'
import { formatElevation } from '../format'
import { formatMeasurement } from './SciencePanel'
import { formatDistance, formatSlope } from './RouteProfile'
import './suit-view.css'

const STEP = 50 // meters per step button press

/**
 * In-suit view: only what the astronaut needs while walking, in large type
 * with large controls for gloved hands. There is no live position feed, so
 * the position along the route is simulated with the step controls.
 */
export default function SuitView({ samples, routeName, position, onPosition, dose, limit = SLOPE_LIMIT, marks, onExit }) {
  const total = samples.at(-1).d
  const g = guidance(samples, position, 250, 100, marks)
  const level = slopeLevel(g.slopeAhead, limit)
  const isTarget = marks && g.next?.d === samples.at(-1).d
  const clamp = (d) => Math.min(total, Math.max(0, d))

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onExit()
      else if (event.key === 'ArrowUp') onPosition(clamp(position + STEP))
      else if (event.key === 'ArrowDown') onPosition(clamp(position - STEP))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  return (
    <section className="suit" aria-label={`Suit view, ${routeName}`}>
      <div className="suit__block suit__block--nav">
        <span className="suit__label">{!g.next ? 'Route end' : isTarget ? 'Target' : `Next wp ${g.next.index}`}</span>
        <span className="suit__value">{g.next ? formatDistance(g.toNext) : 'Arrived'}</span>
        {g.heading !== null && <span className="suit__sub">HDG {String(Math.round(g.heading)).padStart(3, '0')}°</span>}
      </div>

      <div className={`suit__block suit__block--slope is-${level}`}>
        <span className="suit__label">Slope next 100 m</span>
        <span className="suit__value">{formatSlope(g.slopeAhead)}</span>
        <span className="suit__sub">{level === 'hazard' ? `Over ${limit}° limit` : level === 'caution' ? 'Caution' : `Limit ${limit}°`}</span>
      </div>

      <div className="suit__block suit__block--env">
        <span className="suit__label">Elev</span>
        <span className="suit__value suit__value--small">{g.here.elevation === null ? '—' : formatElevation(g.here.elevation)}</span>
        {dose && (
          <>
            <span className="suit__label">Dose, {dose.site} {dose.when}</span>
            <span className="suit__value suit__value--small">{formatMeasurement(dose.measurement)}</span>
          </>
        )}
        <span className="suit__label">Remaining</span>
        <span className="suit__value suit__value--small">{formatDistance(g.remaining)}</span>
      </div>

      <div className="suit__controls">
        <button type="button" onClick={() => onPosition(clamp(position - STEP))} aria-label={`Back ${STEP} meters`}>−{STEP} m</button>
        <div className="suit__track">
          <span className="suit__label">Simulated position {formatDistance(position)} of {formatDistance(total)}</span>
          <input type="range" min="0" max={Math.round(total)} step="10" value={Math.round(position)} aria-label="Simulated position along route" onChange={(event) => onPosition(Number(event.target.value))} />
        </div>
        <button type="button" onClick={() => onPosition(clamp(position + STEP))} aria-label={`Forward ${STEP} meters`}>+{STEP} m</button>
        <button type="button" className="suit__exit" onClick={onExit}>Exit</button>
      </div>
    </section>
  )
}
