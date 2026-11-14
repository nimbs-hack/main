import { mapStatusText } from './map-status'

export default function MapStatus({ status, imagerySource, onRetry }) {
  const failed = status.failures.length > 0
  return (
    <div className={`map-status${failed ? ' map-status--error' : ''}`}>
      <div role="status" aria-live="polite" aria-atomic="true">
        <span>
          {!failed && (status.loadingTiles || !status.terrainReady) && <span className="spinner" aria-hidden="true" />}
          {mapStatusText(status)}
        </span>
        {imagerySource === 'beta01' && (
          <span className="map-status__fallback">CTX backup mosaic in use. V01 failed; image alignment may differ.</span>
        )}
      </div>
      {failed && <button type="button" onClick={onRetry}>Retry map</button>}
    </div>
  )
}
