import { distance } from '../data/geo'
import { slopeLevel } from '../data/route-profile'
import { SITES } from '../data/sites'
import { formatElevation, formatLatLon } from '../format'
import { formatMeasurement } from './SciencePanel'
import { formatDistance, formatSlope, rampColor } from './RouteProfile'

// Readings count as local when their site is this close to the probe.
const NEAR = 25_000

/**
 * Everything known about one spot on the map, as readouts. Opened by
 * clicking the ground or a point on the route profile.
 */
export default function PointReadout({ probe, rasters, observations, onClose }) {
  const [lat, lon] = probe.point
  const nearby = SITES
    .map((site) => ({ site, d: distance([site.lat, site.lon], probe.point) }))
    .filter(({ d }) => d < NEAR)
    .sort((a, b) => a.d - b.d)[0]
  const readings = nearby ? observations.filter((record) => record.siteIds.includes(nearby.site.id)) : []

  return (
    <section className="probe" aria-label="Point readout">
      <header className="probe__head">
        <span className="probe__where">{formatLatLon(lat, lon)}</span>
        <button type="button" className="probe__close" onClick={onClose} aria-label="Close point readout">×</button>
      </header>
      {probe.status === 'loading' && <p className="probe__note" role="status">Sampling…</p>}
      {probe.status === 'error' && <p className="probe__note" role="status">No terrain here yet. Zoom in and try again.</p>}
      {probe.status === 'ready' && (
        <>
          <dl className="probe__main">
            <div><dt>Elev</dt><dd>{probe.elevation === null ? '—' : formatElevation(probe.elevation)}</dd></div>
            <div><dt>Slope</dt><dd className={`is-${slopeLevel(probe.slope)}`}>{formatSlope(probe.slope)}</dd></div>
          </dl>
          <dl className="probe__layers">
            {rasters.map((layer) => {
              const value = probe.layers[layer.id]
              return (
                <div key={layer.id} title={`${layer.name}. ${layer.legend.low} to ${layer.legend.high}.`}>
                  <dt>{layer.short}</dt>
                  <dd>
                    {value === null || value === undefined ? <span className="probe__none">No data</span> : (
                      <>
                        <span className="probe__meter" style={{ '--at': `${value * 100}%`, '--swatch': rampColor(layer.legend.colors, value) }} />
                        <span className="probe__value">{Math.round(value * 100)}</span>
                      </>
                    )}
                  </dd>
                </div>
              )
            })}
          </dl>
          {readings.length > 0 && (
            <div className="probe__readings">
              <p className="probe__label">{nearby.site.name} readings · {formatDistance(nearby.d)} away</p>
              <dl>
                {readings.flatMap((record) => record.measurements.map((m, i) => (
                  <div key={`${record.id}-${i}`}>
                    <dt>{record.short}</dt>
                    <dd>{formatMeasurement(m)} <small>{record.epoch.split(';')[0]}</small></dd>
                  </div>
                )))}
              </dl>
            </div>
          )}
          <p className="probe__note">Layer values are positions on each legend, 0 to 100. Not calibrated.</p>
        </>
      )}
    </section>
  )
}
