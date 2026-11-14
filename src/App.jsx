import { useReducer, useState } from 'react'
import { SITES } from './data/sites'
import TopBar from './components/TopBar'
import MarsGlobe from './components/MarsGlobe'
import MapStatus from './components/MapStatus'
import { INITIAL_MAP_STATUS, mapStatusReducer } from './components/map-status'

export default function App() {
  const [siteId, setSiteId] = useState(null)
  const [status, dispatchStatus] = useReducer(mapStatusReducer, INITIAL_MAP_STATUS)
  const [imagerySource, setImagerySource] = useState('V01')
  const [retryKey, setRetryKey] = useState(0)

  const site = SITES.find((s) => s.id === siteId) ?? null

  return (
    <div className="console">
      <TopBar />
      <MarsGlobe site={site} onSite={setSiteId} onStatus={dispatchStatus} onImagerySource={setImagerySource} retryKey={retryKey} />
      <footer className="statusbar">
        <MapStatus status={status} imagerySource={imagerySource} onRetry={() => setRetryKey((key) => key + 1)} />
        <span className="statusbar__credit">Viking / CTX · NASA / JPL / USGS / MSSS / The Murray Lab / Esri · Terrain NASA Mars Trek</span>
      </footer>
    </div>
  )
}
