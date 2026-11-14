import { useState } from 'react'
import { SITES } from './data/sites'
import TopBar from './components/TopBar'
import MarsMap from './components/MarsMap'

const STATUS_TEXT = {
  loading: { system: 'Acquiring', link: 'Link ok', state: 'Loading tiles' },
  ready: { system: 'Nominal', link: 'Link ok', state: 'Ready' },
  error: { system: 'Degraded', link: 'Link degraded', state: 'Some tiles failed to load' },
}

export default function App() {
  const [siteId, setSiteId] = useState(null)
  const [status, setStatus] = useState('loading')

  const site = SITES.find((s) => s.id === siteId) ?? null
  const text = STATUS_TEXT[status]

  // Picking the selected site again returns to the global view.
  const toggleSite = (id) => setSiteId((current) => (current === id ? null : id))

  return (
    <div className="console">
      <TopBar system={text.system} status={status} />
      <MarsMap site={site} onSite={toggleSite} onStatus={setStatus} />
      <footer className="statusbar">
        <span className={`dot dot--${status}`} aria-hidden="true" />
        <span role="status">
          {text.link} <span className="sep">|</span> {text.state}
        </span>
        <span className="statusbar__credit">Imagery NASA / JPL-Caltech / USGS</span>
      </footer>
    </div>
  )
}
