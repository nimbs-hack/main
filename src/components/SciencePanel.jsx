import { useId, useState } from 'react'
import { SITES } from '../data/sites'
import './science-panel.css'

const numberFormat = new Intl.NumberFormat('en', { maximumSignificantDigits: 3 })

// Convert only the displayed value. Stored measurements keep their SI units.
export function formatMeasurement({ value, unit }) {
  if (!Number.isFinite(value)) return 'Not reported'
  if (unit === 'K') return `${numberFormat.format(value)} K · ${numberFormat.format(value - 273.15)} °C`
  if (unit === 'Sv/day' || unit === 'Gy/day') return `${numberFormat.format(value * 1000)} m${unit}`
  if (unit === 'mol/mol') return `${numberFormat.format(value * 1e9)} ppbv`
  if (unit === 'm/s' && Math.abs(value) < 0.001) return `${numberFormat.format(value * 1e6)} µm/s`
  if (unit === 'Pa' && Math.abs(value) >= 100) return `${numberFormat.format(value / 100)} hPa`
  if (unit === 'm' && Math.abs(value) >= 1000) return `${numberFormat.format(value / 1000)} km`
  return `${numberFormat.format(value)} ${unit}`.trim()
}

function Ramp({ legend }) {
  // Categorical maps have no ramp. Their colors name units, not amounts.
  if (legend.categorical) {
    return <div className="layers__legend"><div className="layers__scale"><span>{legend.low}</span><span>{legend.high}</span></div></div>
  }
  const colors = legend.colors.length ? legend.colors : ['#000000', '#ffffff']
  return (
    <div className="layers__legend">
      <div className="layers__ramp" style={{ background: `linear-gradient(to right, ${colors.join(', ')})` }} aria-hidden="true" />
      <div className="layers__scale"><span>{legend.low}</span><span>{legend.high}</span></div>
    </div>
  )
}

function SourceLink({ layer }) {
  if (!/^https?:\/\//i.test(layer.sourceUrl)) return layer.source
  return (
    <a href={layer.sourceUrl} target="_blank" rel="noopener noreferrer">
      {layer.source} <span aria-hidden="true">↗</span>
    </a>
  )
}

function Details({ layer }) {
  return (
    <div className="layers__details">
      <p>{layer.description}</p>
      <dl>
        <div><dt>Source</dt><dd><SourceLink layer={layer} /></dd></div>
        <div><dt>Dates</dt><dd>{layer.epoch}</dd></div>
        <div><dt>Resolution</dt><dd>{layer.resolution}</dd></div>
        <div><dt>Coverage</dt><dd>{layer.coverage}</dd></div>
        <div><dt>Limits</dt><dd>{layer.limitation}</dd></div>
      </dl>
    </div>
  )
}

function shortResolution(text) {
  return text.match(/[\d.,]+\s*k?m\/pixel/)?.[0].replace('/pixel', '') ?? ''
}

function RasterRow({ layer, state, status, onToggle, onOpacity, onRetry }) {
  const id = useId()
  const [info, setInfo] = useState(false)
  const percent = Math.round(state.opacity * 100)
  return (
    <li className={`layers__row${state.on ? ' is-on' : ''}`}>
      <div className="layers__head">
        <label className="layers__check">
          <input type="checkbox" checked={state.on} onChange={() => onToggle(layer.id)} />
          <span className="layers__name">{layer.short}</span>
          <span className="layers__meta">{layer.name} · {shortResolution(layer.resolution)}</span>
        </label>
        <button type="button" className="layers__info" aria-expanded={info} aria-controls={`${id}-info`} aria-label={`About ${layer.name}`} onClick={() => setInfo(!info)}>i</button>
      </div>
      {state.on && (
        <div className="layers__body">
          <Ramp legend={layer.legend} />
          <div className="layers__opacity">
            <label htmlFor={`${id}-opacity`}>Opacity</label>
            <input id={`${id}-opacity`} type="range" min="0" max="100" value={percent} style={{ '--fill': `${percent}%` }} onChange={(event) => onOpacity(layer.id, Number(event.target.value) / 100)} />
            <output htmlFor={`${id}-opacity`}>{percent}%</output>
          </div>
          {status === 'error' && (
            <p className="layers__error" role="status">Tiles failed. <button type="button" onClick={() => onRetry(layer.id)}>Retry</button></p>
          )}
        </div>
      )}
      {info && <div id={`${id}-info`}><Details layer={layer} /></div>}
    </li>
  )
}

function Readings({ observations, siteId, onSite }) {
  const groups = SITES
    .map((site) => ({ site, records: observations.filter((record) => record.siteIds.includes(site.id)) }))
    .filter((group) => group.records.length)
    .sort((a, b) => (b.site.id === siteId) - (a.site.id === siteId))
  return groups.map(({ site, records }) => (
    <section key={site.id} className={`layers__site${site.id === siteId ? ' is-current' : ''}`} aria-label={`${site.name} readings`}>
      <button type="button" className="layers__site-name" aria-pressed={site.id === siteId} onClick={() => onSite(site.id)}>
        {site.name} <span aria-hidden="true">→</span>
      </button>
      <dl className="layers__readings">
        {records.flatMap((record) => record.measurements.map((measurement, index) => (
          <div key={`${record.id}-${index}`} title={`${record.name}. ${record.limitation}`}>
            <dt>{measurement.label.replace(/, approximate$/, '')}</dt>
            <dd>{formatMeasurement(measurement)}</dd>
            <dd className="layers__when">{record.category} · {record.epoch.split(';')[0]} · <SourceLink layer={record} /></dd>
          </div>
        )))}
      </dl>
    </section>
  ))
}

const GROUPS = [
  { id: 'footing', title: 'Footing', note: 'Can I walk here' },
  { id: 'science', title: 'Science', note: 'What is here' },
]

/**
 * Layer dock on the right edge of the map. Every dataset shows at once,
 * grouped by the question it answers: footing, science and environment.
 * Environment holds dated site readings because no global field exists.
 * The parent owns overlay state so it can draw them.
 *
 * @param {{ layers: import('../data/science-types').ScienceLayer[],
 * overlays: Record<string, { on: boolean, opacity: number }>,
 * statuses: Record<string, import('../data/science-types').ScienceStatus>,
 * onToggle: (id: string) => void, onOpacity: (id: string, value: number) => void,
 * onAll: (on: boolean) => void, onRetry: (id: string) => void,
 * siteId?: string, onSite: (id: string) => void,
 * open?: boolean, onOpen?: (open: boolean) => void }} props
 *
 * Pass `open` and `onOpen` to control it from outside, as the layer switcher
 * does. A controlled panel renders nothing while closed.
 */
export default function SciencePanel({ layers, overlays, statuses, onToggle, onOpacity, onAll, onRetry, siteId, onSite, open: openProp, onOpen }) {
  const id = useId()
  const [openState, setOpenState] = useState(() => window.matchMedia('(min-width: 900px)').matches)
  const controlled = openProp !== undefined
  const open = controlled ? openProp : openState
  const setOpen = controlled ? onOpen : setOpenState
  const rasters = layers.filter((layer) => layer.kind === 'raster')
  const base = layers.find((layer) => layer.kind === 'base')
  const observations = layers.filter((layer) => layer.kind === 'observation')
  const onCount = rasters.filter((layer) => overlays[layer.id]?.on).length

  if (controlled && !open) return null

  return (
    <div className={`layers${open ? ' is-open' : ''}${controlled ? ' layers--left' : ''}`}>
      <button type="button" className="layers__toggle" aria-expanded={open} aria-controls={`${id}-dock`} onClick={() => setOpen(!open)}>
        <span>Layers</span>
        <span className="layers__count">{onCount}/{rasters.length} on</span>
        <span aria-hidden="true">{open ? '−' : '+'}</span>
      </button>

      <div id={`${id}-dock`} className="layers__dock" hidden={!open}>
        <div className="layers__bar">
          <button type="button" onClick={() => onAll(onCount < rasters.length)}>
            {onCount < rasters.length ? 'Show all' : 'Hide all'}
          </button>
        </div>
        {GROUPS.map((group) => (
          <section key={group.id} className="layers__group" aria-labelledby={`${id}-${group.id}`}>
            <h2 id={`${id}-${group.id}`}>{group.title}<span>{group.note}</span></h2>
            <ul className="layers__list">
              {rasters.filter((layer) => layer.group === group.id).map((layer) => (
                <RasterRow
                  key={layer.id}
                  layer={layer}
                  state={overlays[layer.id] ?? { on: false, opacity: 0.6 }}
                  status={statuses[layer.id]}
                  onToggle={onToggle}
                  onOpacity={onOpacity}
                  onRetry={onRetry}
                />
              ))}
            </ul>
            {group.id === 'science' && base && (
              <p className="layers__base" title={base.limitation}>
                <span>Base</span> {base.source} · {shortResolution(base.resolution) || base.resolution}
              </p>
            )}
          </section>
        ))}
        <section className="layers__group" aria-labelledby={`${id}-environment`}>
          <h2 id={`${id}-environment`}>Environment<span>Past rover readings</span></h2>
          <Readings observations={observations} siteId={siteId} onSite={onSite} />
        </section>
      </div>
    </div>
  )
}
