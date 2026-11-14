import { useRef } from 'react'
import { SLOPE_CAUTION, SLOPE_LIMIT, slopeLevel } from '../data/route-profile'
import { formatElevation } from '../format'
import './route-profile.css'

const WIDTH = 1000
const ELEV_HEIGHT = 56
const SLOPE_HEIGHT = 28
const SLOPE_SCALE = 30 // degrees at the top of the slope lane

export function formatDistance(meters) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`
}

export function formatSlope(degrees) {
  return degrees === null || degrees === undefined ? '—' : `${Math.round(degrees)}°`
}

function hexToRgb(hex) {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// Color for a relative value, using the same ramp the legend shows.
export function rampColor(stops, value) {
  const colors = (stops.length ? stops : ['#000000', '#ffffff']).map(hexToRgb)
  const t = Math.min(1, Math.max(0, value)) * (colors.length - 1)
  const i = Math.min(colors.length - 2, Math.floor(t))
  const f = t - i
  const rgb = colors[i].map((v, k) => Math.round(v + (colors[i + 1][k] - v) * f))
  return `rgb(${rgb.join(' ')})`
}

function ElevationLane({ samples, low, high }) {
  const span = Math.max(1, high - low)
  const total = samples.at(-1).d || 1
  const points = samples
    .filter((s) => s.elevation !== null)
    .map((s) => `${(s.d / total) * WIDTH},${ELEV_HEIGHT - 2 - ((s.elevation - low) / span) * (ELEV_HEIGHT - 4)}`)
  if (points.length < 2) return null
  return (
    <svg viewBox={`0 0 ${WIDTH} ${ELEV_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
      <polygon className="profile__area" points={`0,${ELEV_HEIGHT} ${points.join(' ')} ${WIDTH},${ELEV_HEIGHT}`} />
      <polyline className="profile__line" points={points.join(' ')} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function bars(samples, draw) {
  const total = samples.at(-1).d || 1
  return samples.map((s, i) => {
    const x0 = i === 0 ? 0 : ((s.d + samples[i - 1].d) / 2 / total) * WIDTH
    const x1 = i === samples.length - 1 ? WIDTH : ((s.d + samples[i + 1].d) / 2 / total) * WIDTH
    return draw(s, x0, Math.max(0.5, x1 - x0), i)
  })
}

function SlopeLane({ samples, slopeLimit }) {
  const scale = Math.max(SLOPE_SCALE, slopeLimit)
  const limitY = SLOPE_HEIGHT - (slopeLimit / scale) * SLOPE_HEIGHT
  return (
    <svg viewBox={`0 0 ${WIDTH} ${SLOPE_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
      {bars(samples, (s, x, w, i) => {
        if (s.slope === null) return null
        const h = (Math.min(scale, s.slope) / scale) * SLOPE_HEIGHT
        return <rect key={i} x={x} width={w} y={SLOPE_HEIGHT - h} height={h} className={`profile__slope is-${slopeLevel(s.slope, slopeLimit)}`} />
      })}
      <line className="profile__limit" x1="0" x2={WIDTH} y1={limitY} y2={limitY} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function WeatherLane({ samples, field, min, max }) {
  const total = samples.at(-1).d || 1
  const points = samples.filter(s => Number.isFinite(s[field])).map(s => `${s.d / total * WIDTH},${26 - Math.min(1, Math.max(0, (s[field] - min) / (max - min))) * 24}`)
  return <svg viewBox={`0 0 ${WIDTH} 28`} preserveAspectRatio="none" aria-hidden="true"><polyline className="profile__line" points={points.join(' ')} vectorEffect="non-scaling-stroke" /></svg>
}

function RasterLane({ samples, layer }) {
  return (
    <svg viewBox={`0 0 ${WIDTH} 1`} preserveAspectRatio="none" aria-hidden="true">
      {bars(samples, (s, x, w, i) => {
        const value = s.layers[layer.id]
        return value === null || value === undefined ? null : <rect key={i} x={x} width={w} y="0" height="1" fill={rampColor(layer.legend.colors, value)} />
      })}
    </svg>
  )
}

/**
 * Route profile strip along the bottom of the map. Every layer appears as a
 * lane over the same distance axis, so one vertical line reads all of them
 * at one spot. Hover moves a marker on the map, click opens the point readout.
 */
export default function RouteProfile({
  samples, summary, rasters, status, segment, onSegment, routeName,
  hoverIndex, onHover, onPick, onSuit, onClose, onRetry,
  planned = false, slopeLimit = SLOPE_LIMIT,
}) {
  const chart = useRef(null)
  const ready = status === 'ready' && samples?.length > 1
  const hovered = ready && hoverIndex !== null ? samples[hoverIndex] : null
  const total = ready ? samples.at(-1).d : 1

  const indexFromEvent = (event) => {
    const box = chart.current.getBoundingClientRect()
    const d = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) * total
    let best = 0
    for (let i = 1; i < samples.length; i++) if (Math.abs(samples[i].d - d) < Math.abs(samples[best].d - d)) best = i
    return best
  }

  const onKeyDown = (event) => {
    const step = event.shiftKey ? 10 : 1
    const current = hoverIndex ?? 0
    if (event.key === 'ArrowRight') onHover(Math.min(samples.length - 1, current + step))
    else if (event.key === 'ArrowLeft') onHover(Math.max(0, current - step))
    else if (event.key === 'Enter') onPick(current)
    else return
    event.preventDefault()
  }

  return (
    <section className="profile" aria-label={`Route profile, ${routeName}`}>
      <header className="profile__head">
        {planned ? <span>{routeName}</span> : <div className="profile__segment" role="group" aria-label="Route length">
          <button type="button" aria-pressed={segment === 'eva'} onClick={() => onSegment('eva')}>Last 2 km</button>
          <button type="button" aria-pressed={segment === 'full'} onClick={() => onSegment('full')}>Full traverse</button>
        </div>}
        {ready && (
          <dl className="profile__stats">
            <div><dt>Dist</dt><dd>{formatDistance(summary.distance)}</dd></div>
            <div><dt>Climb</dt><dd>+{Math.round(summary.climb)} m</dd></div>
            <div><dt>Descent</dt><dd>−{Math.round(summary.descent)} m</dd></div>
            <div><dt>Max slope</dt><dd className={`is-${slopeLevel(summary.maxSlope, slopeLimit)}`}>{formatSlope(summary.maxSlope)}</dd></div>
            <div><dt>Over {slopeLimit}°</dt><dd className={summary.overLimit > 0 ? 'is-hazard' : ''}>{formatDistance(summary.overLimit)}</dd></div>
          </dl>
        )}
        <div className="profile__actions">
          <button type="button" className="profile__suit" onClick={onSuit} disabled={!ready}>Suit view</button>
          <button type="button" className="profile__close" onClick={onClose} aria-label="Close route profile">×</button>
        </div>
      </header>

      {status === 'loading' && <p className="profile__note" role="status">Sampling terrain and layers along {routeName}…</p>}
      {status === 'error' && (
        <p className="profile__note" role="status">Terrain samples failed. <button type="button" onClick={onRetry}>Retry</button></p>
      )}

      {ready && (
        <div className="profile__body">
          <div className="profile__labels" aria-hidden="true">
            <div className="profile__label profile__label--elev">
              <span>Elev</span>
              <b>{hovered?.elevation != null ? formatElevation(hovered.elevation) : formatElevation(summary.high ?? 0)}</b>
              {!hovered && <small>{formatElevation(summary.low ?? 0)}</small>}
            </div>
            <div className="profile__label profile__label--slope">
              <span>Slope</span>
              <b className={hovered ? `is-${slopeLevel(hovered.slope, slopeLimit)}` : ''}>{hovered ? formatSlope(hovered.slope) : `${slopeLimit}° line`}</b>
            </div>
            {planned && ['tempC', 'pressurePa'].map(field => <div key={field} className="profile__label profile__label--slope"><span>{field === 'tempC' ? 'Temp' : 'Pressure'}</span><b>{hovered?.[field] == null ? (field === 'tempC' ? '−120–0 °C' : '400–1,000 Pa') : `${hovered[field].toFixed(field === 'tempC' ? 1 : 0)} ${field === 'tempC' ? '°C' : 'Pa'}`}</b></div>)}
            {rasters.map((layer) => (
              <div key={layer.id} className="profile__label profile__label--raster">
                <span>{layer.short}</span>
                <b>{hovered ? (hovered.layers[layer.id] == null ? '—' : Math.round(hovered.layers[layer.id] * 100)) : ''}</b>
              </div>
            ))}
          </div>
          <div
            ref={chart}
            className="profile__chart"
            role="slider"
            tabIndex={0}
            aria-label="Position along route"
            aria-valuemin={0}
            aria-valuemax={Math.round(total)}
            aria-valuenow={Math.round(hovered?.d ?? 0)}
            aria-valuetext={hovered ? `${formatDistance(hovered.d)}, elevation ${hovered.elevation == null ? 'unknown' : formatElevation(hovered.elevation)}, slope ${formatSlope(hovered.slope)}` : 'Start of route'}
            onPointerMove={(event) => onHover(indexFromEvent(event))}
            onPointerLeave={(event) => { if (event.pointerType === 'mouse') onHover(null) }}
            onClick={(event) => onPick(indexFromEvent(event))}
            onKeyDown={onKeyDown}
          >
            <div className="profile__lane profile__lane--elev"><ElevationLane samples={samples} low={summary.low ?? 0} high={summary.high ?? 1} /></div>
            <div className="profile__lane profile__lane--slope"><SlopeLane samples={samples} slopeLimit={slopeLimit} /></div>
            {planned && <><div className="profile__lane profile__lane--slope"><WeatherLane samples={samples} field="tempC" min={-120} max={0} /></div><div className="profile__lane profile__lane--slope"><WeatherLane samples={samples} field="pressurePa" min={400} max={1000} /></div></>}
            {rasters.map((layer) => (
              <div key={layer.id} className="profile__lane profile__lane--raster"><RasterLane samples={samples} layer={layer} /></div>
            ))}
            {hovered && (
              <div className="profile__cursor" style={{ left: `${(hovered.d / total) * 100}%` }}>
                <span>{formatDistance(hovered.d)}</span>
              </div>
            )}
          </div>
          <p className="profile__foot">
            {planned ? `Elevation and incoming segment slope from the planning DEM. Limit ${slopeLimit}°. Weather is simulated at departure. One-way route; display terrain may differ.` : <>
              Slope from Mars Trek terrain over 120 m. Yellow {SLOPE_CAUTION}–{slopeLimit}°, orange over {slopeLimit}°, a planning limit borrowed from lunar studies.
              Layer lanes show position on each legend, 0 low to 100 high. Not calibrated values.
            </>}
          </p>
        </div>
      )}
    </section>
  )
}
