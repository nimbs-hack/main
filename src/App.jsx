import { useState } from 'react'
import { SITES } from './data/sites'
import TopBar from './components/TopBar'
import MarsGlobe from './components/MarsGlobe'

const STATUS_TEXT = {
  loading: 'Loading tiles',
  ready: 'Tiles loaded',
  error: 'Some tiles failed to load',
}

export default function App() {
  const [siteId, setSiteId] = useState(null)
  const [status, setStatus] = useState('loading')
  const [imagerySource, setImagerySource] = useState('V01')
  const [scienceCredit, setScienceCredit] = useState('')

  const site = SITES.find((s) => s.id === siteId) ?? null
  const text = STATUS_TEXT[status]

  // Picking the selected site again returns to the global view.
  const toggleSite = (id) => setSiteId((current) => (current === id ? null : id))

  return (
    <div className="console">
      <TopBar />
      <MarsGlobe site={site} onSite={toggleSite} onStatus={setStatus} onImagerySource={setImagerySource} onScienceSource={setScienceCredit} />
      <footer className="statusbar">
        <span role="status">{text}</span>
        <span className="statusbar__credit" title={scienceCredit || undefined}>{scienceCredit && `${scienceCredit} · `}CTX {imagerySource} · NASA / JPL / USGS / MSSS / The Murray Lab / Esri · Terrain NASA Mars Trek</span>
      </footer>
    </div>
  )
}
