import { useState } from 'react'
import { SITES } from '../data/sites'
import { formatLatLon } from '../format'

// Open on entry so the first task is visible. Collapsing leaves the map controls available.
export default function SitesPanel({ site, onSite, onLocate, imagerySource, relief }) {
  const [open, setOpen] = useState(true)

  return (
    <div className={`sites${open ? ' is-open' : ''}`}>
      <section className="sites__panel" id="sites-panel" aria-label="Site inspection" inert={!open}>
        <div>
          <h1 className="sites__heading">Inspect a landing site</h1>
          <p className="sites__intro">Choose a site to inspect terrain and recorded rover tracks.</p>
        </div>
        {site && (
          <section className="site-detail" aria-label="Selected site details">
            <h2>{site.name}</h2>
            <dl>
              <div><dt>Landing location</dt><dd>{formatLatLon(site.lat, site.lon)}</dd></div>
              {site.traverse ? <>
                <div><dt>Last recorded position · sol {site.traverse.lastSol}</dt><dd>{formatLatLon(...site.traverse.position)}</dd></div>
                <div><dt>Recorded distance</dt><dd>{site.traverse.distanceKm.toFixed(2)} km</dd></div>
              </> : <div><dt>Rover track</dt><dd>Not included for this site</dd></div>}
            </dl>
            <button type="button" className="site-detail__locate" onClick={onLocate}>Recenter on {site.name}</button>
          </section>
        )}
        <h2 className="sites__title">Landing sites · year landed</h2>
        {SITES.map((s) => (
          <button
            key={s.id}
            type="button"
            className="nav-button"
            aria-pressed={s.id === site?.id}
            onClick={() => onSite(s.id)}
          >
            <span className="nav-button__label">{s.name}</span>
            <span className="nav-button__meta">{s.landed}</span>
            <span className="nav-button__arrow" aria-hidden="true">
              {s.id === site?.id ? '✓' : '→'}
            </span>
          </button>
        ))}
        <section className="map-context" aria-label="Map data and limits">
          <h2 className="sites__title">Map data</h2>
          <ul className="map-legend">
            <li><span className="map-legend__line" aria-hidden="true" />Recorded rover track</li>
            <li><span className="map-legend__point" aria-hidden="true" />Landing / recorded rover position</li>
          </ul>
          <p>Tracks are stored snapshots, not live positions or planned expedition routes.</p>
          <dl>
            <div><dt>Orbital imagery</dt><dd>Viking · 232 m/pixel<br />CTX {imagerySource} · about 5 m/pixel when zoomed in</dd></div>
            <div><dt>Terrain display</dt><dd>Mars Trek · {relief}× vertical scale</dd></div>
            <div><dt>Coordinates</dt><dd>Planetocentric latitude · east longitude 0–360°</dd></div>
          </dl>
          <p>Terrain seams are smoothed. Lighting is illustrative. This view does not assess slope safety or route feasibility.</p>
        </section>
      </section>
      <button
        type="button"
        className="sites__toggle"
        aria-expanded={open}
        aria-controls="sites-panel"
        aria-label={open ? 'Hide landing sites' : 'Show landing sites'}
        onClick={() => setOpen(!open)}
      >
        <span className="sites__toggle-arrow" aria-hidden="true">
          →
        </span>
        <span className="sites__toggle-text" aria-hidden="true">
          Sites
        </span>
      </button>
    </div>
  )
}
