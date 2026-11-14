import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { distance } from '../data/geo'
import { slopeLevel } from '../data/route-profile'
import { SITES } from '../data/sites'
import { formatElevation, formatLatLon } from '../format'
import { formatMeasurement } from './SciencePanel'
import { formatDistance, formatSlope, rampColor } from './RouteProfile'
import './point-menu.css'

// Readings count as local when their site is this close to the point.
const NEAR = 25_000
// Gap between the pointer and the menu.
const GAP = 4

/**
 * Right-click menu for one spot on the map, after Google Maps: coordinates,
 * elevation and slope, plan actions, and the layer values and nearby rover
 * readings behind a fold. Opens at `probe.screen`, flipped to stay inside
 * the map. Esc or a click outside closes it.
 */
export default function PointReadout({ probe, rasters, observations, limit, actions = [], onClose }) {
  const menu = useRef(null)
  const [place, setPlace] = useState(null)
  const [more, setMore] = useState(false)
  const [copied, setCopied] = useState(false)
  const [lat, lon] = probe.point
  const where = formatLatLon(lat, lon)

  // Flip left or up when the menu would cross the map edge.
  useLayoutEffect(() => {
    const el = menu.current
    const box = el?.offsetParent?.getBoundingClientRect()
    if (!el || !box) return
    const { x, y } = probe.screen
    const left = x + GAP + el.offsetWidth > box.width ? Math.max(GAP, x - GAP - el.offsetWidth) : x + GAP
    const top = y + GAP + el.offsetHeight > box.height ? Math.max(GAP, y - GAP - el.offsetHeight) : y + GAP
    setPlace({ left, top })
  }, [probe.screen, probe.status, more])

  useEffect(() => {
    const close = (event) => {
      if (event.type === 'keydown' ? event.key === 'Escape' : !menu.current?.contains(event.target)) onClose()
    }
    // Wait a frame so the click that opened the menu doesn't close it.
    const timer = setTimeout(() => {
      document.addEventListener('pointerdown', close)
      document.addEventListener('keydown', close)
    })
    return () => {
      clearTimeout(timer)
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', close)
    }
  }, [onClose])

  useEffect(() => {
    menu.current?.querySelector('button')?.focus()
  }, [])

  const copy = () => {
    navigator.clipboard?.writeText(where.replace(/\s+/g, ' ')).then(() => setCopied(true), () => {})
  }

  const nearby = SITES
    .map((site) => ({ site, d: distance([site.lat, site.lon], probe.point) }))
    .filter(({ d }) => d < NEAR)
    .sort((a, b) => a.d - b.d)[0]
  const readings = nearby ? observations.filter((record) => record.siteIds.includes(nearby.site.id)) : []

  return (
    <div
      ref={menu}
      className="pointmenu"
      role="menu"
      aria-label={`Point ${where}`}
      style={place ?? { left: probe.screen.x + GAP, top: probe.screen.y + GAP, visibility: 'hidden' }}
    >
      <button type="button" role="menuitem" className="pointmenu__where" onClick={copy} title="Copy coordinates">
        {copied ? 'Copied' : where}
      </button>
      <p className="pointmenu__terrain" role="status">
        {probe.status === 'loading' && 'Sampling…'}
        {probe.status === 'error' && 'No terrain here yet'}
        {probe.status === 'ready' && (
          <>
            <span>{probe.elevation === null ? '—' : formatElevation(probe.elevation)}</span>
            <span className={`is-${slopeLevel(probe.slope, limit)}`}>{formatSlope(probe.slope)}</span>
          </>
        )}
      </p>

      {[actions.filter((a) => !a.group), actions.filter((a) => a.group === 'tools')].map((group, i) => group.length > 0 && (
        <div key={i} className="pointmenu__group">
          {group.map((action) => (
            <button key={action.label} type="button" role="menuitem" onClick={action.run}>{action.label}</button>
          ))}
        </div>
      ))}

      {probe.status === 'ready' && (
        <div className="pointmenu__group">
          <button type="button" role="menuitem" aria-expanded={more} onClick={() => setMore(!more)}>
            {more ? 'Hide layers' : 'Layers here'}
          </button>
          {more && (
            <>
              <dl className="pointmenu__layers">
                {rasters.map((layer) => {
                  const value = probe.layers[layer.id]
                  return (
                    <div key={layer.id} title={`${layer.name}. ${layer.legend.low} to ${layer.legend.high}. Position on the legend, not calibrated.`}>
                      <dt>{layer.short}</dt>
                      <dd>
                        {value === null || value === undefined ? '—' : (
                          <>
                            <span className="pointmenu__swatch" style={{ background: rampColor(layer.legend.colors, value) }} />
                            {Math.round(value * 100)}
                          </>
                        )}
                      </dd>
                    </div>
                  )
                })}
              </dl>
              {readings.length > 0 && (
                <dl className="pointmenu__layers">
                  {readings.flatMap((record) => record.measurements.map((m, i) => (
                    <div key={`${record.id}-${i}`} title={`${nearby.site.name}, ${formatDistance(nearby.d)} away. ${record.epoch.split(';')[0]}`}>
                      <dt>{record.short}</dt>
                      <dd>{formatMeasurement(m)}</dd>
                    </div>
                  )))}
                </dl>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
