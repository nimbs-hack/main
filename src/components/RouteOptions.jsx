import { formatDuration } from '../data/plan'
import { slopeLevel } from '../data/route-profile'
import { formatDistance, formatSlope } from './RouteProfile'
import './route-options.css'

/**
 * Suggested routes between start and target, pinned to the top left of the
 * map. Hovering a row brightens its dashed line on the map. Picking one
 * turns its turn points into the plan's waypoints. Times are one way.
 */
export default function RouteOptions({ status, thermalPending, options, chosen, hover, limit, note, needs, onHover, onChoose, onRaise, onRetry }) {
  if (status === 'loading') return <p className="routes routes--note" role="status">Finding routes…</p>
  if (status === 'error') {
    return (
      <p className="routes routes--note" role="status">
        No terrain for routes. <button type="button" onClick={onRetry}>Retry</button>
      </p>
    )
  }
  if (status === 'blocked') {
    const raise = needs === null ? null : Math.ceil(needs)
    return (
      <p className="routes routes--note" role="status">
        No route under {limit}°.{raise !== null && <> Needs {raise}°. <button type="button" onClick={() => onRaise(raise)}>Use {raise}°</button></>}
      </p>
    )
  }
  if (!options.length) return null
  // When every strategy found the same path, one row and the reason.
  const shown = note ? options.slice(0, 1) : options
  return (
    <ul className="routes" aria-label="Suggested routes" onPointerLeave={() => onHover(null)}>
      {shown.map((option) => (
        <li key={option.id}>
          <button
            type="button"
            aria-pressed={option.id === chosen}
            title={`${option.note}. Times are one way.`}
            onPointerEnter={() => onHover(option.id)}
            onFocus={() => onHover(option.id)}
            onBlur={() => onHover(null)}
            onClick={() => onChoose(option)}
            style={{ '--route': `var(--color-route-${option.id})` }}
          >
            <span className="routes__swatch" aria-hidden="true" />
            <span className="routes__name">{note ? 'All four' : option.name}</span>
            {option.sameAs ? (
              <span className="routes__same">Same as {option.sameAs}</span>
            ) : (
              <>
                <span>{formatDistance(option.distance)}</span>
                <span>{formatDuration(option.time)}</span>
                <span className={`is-${slopeLevel(option.maxSlope, limit)}`}>{formatSlope(option.maxSlope)}</span>
              </>
            )}
          </button>
        </li>
      ))}
      {thermalPending && <li className="routes__why" role="status">Loading night IR for Thermal and Detour…</li>}
      {note && <li className="routes__why">{note}</li>}
    </ul>
  )
}
