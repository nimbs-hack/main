import { useState } from 'react'
import { SITES } from './data/sites'
import TopBar from './components/TopBar'
import MarsGlobe from './components/MarsGlobe'
import StatusBar from './components/StatusBar'

export default function App() {
  const [siteId, setSiteId] = useState(null)
  const [status, setStatus] = useState('loading')
  const [imagerySource, setImagerySource] = useState('V01')
  const [scienceCredit, setScienceCredit] = useState('')
  const [viewer, setViewer] = useState(null)

  const site = SITES.find((s) => s.id === siteId) ?? null
  const credits = [
    ...(scienceCredit ? scienceCredit.split(' · ') : []),
    `CTX ${imagerySource}: NASA / JPL / USGS / MSSS / The Murray Lab / Esri`,
    'Terrain: NASA Mars Trek',
  ]

  // Picking the selected site again returns to the global view.
  const toggleSite = (id) => setSiteId((current) => (current === id ? null : id))

  return (
    <div className="console">
      <TopBar />
      <MarsGlobe site={site} onSite={toggleSite} onStatus={setStatus} onImagerySource={setImagerySource} onScienceSource={setScienceCredit} onViewer={setViewer} />
      <StatusBar viewer={viewer} status={status} credits={credits} />
    </div>
  )
}
