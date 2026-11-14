import { useState } from 'react'
import { SITES } from '../data/sites'

// Landing site list that stays tucked behind the left edge of the map until
// the arrow tab is pressed.
export default function SitesPanel({ site, onSite }) {
  const [open, setOpen] = useState(false)

  return (
    <div className={`sites${open ? ' is-open' : ''}`}>
      <div className="sites__panel" id="sites-panel" inert={!open}>
        <h2 className="sites__title">Landing sites</h2>
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
              →
            </span>
          </button>
        ))}
      </div>
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
