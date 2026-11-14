import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import { CircleMarker, MapContainer, Marker, Polyline, TileLayer, Tooltip } from 'react-leaflet'
import { MAX_NATIVE_ZOOM, tileSource } from '../data/basemap'
import { SITES } from '../data/sites'
import { formatLatLon, formatScale } from '../format'
import SitesPanel from './SitesPanel'

const WORLD = [
  [-90, -180],
  [90, 180],
]
const SITE_ZOOM = 6
const MAX_ZOOM = 11

function siteIcon(site, selected) {
  const state = site.ended ? 'ended' : 'active'
  return L.divIcon({
    className: `site-marker site-marker--${state}${selected ? ' is-selected' : ''}`,
    // The <b> is visually hidden and names the marker for screen readers.
    html: `<span></span><b>${site.name} landing site</b>`,
    iconSize: [22, 22],
  })
}

// Built once: a new icon object makes Leaflet replace the marker element.
const ICONS = new Map(
  SITES.map((s) => [s.id, { idle: siteIcon(s, false), selected: siteIcon(s, true) }]),
)
const ROVERS = SITES.filter((s) => s.traverse)

// Own component so pointer movement does not re-render the map layers.
function CursorReadout({ map }) {
  const [cursor, setCursor] = useState(null)

  useEffect(() => {
    if (!map) return
    const onMove = (e) => setCursor(e.latlng)
    const onOut = () => setCursor(null)
    map.on('mousemove', onMove).on('mouseout', onOut)
    return () => {
      map.off('mousemove', onMove).off('mouseout', onOut)
    }
  }, [map])

  const onMap = cursor && Math.abs(cursor.lat) <= 90 && Math.abs(cursor.lng) <= 180
  return (
    <div className="readout readout--tl">
      <span className="readout__label">Cursor</span>
      <span className="readout__value">{onMap ? formatLatLon(cursor.lat, cursor.lng) : '—'}</span>
    </div>
  )
}

export default function MarsMap({ site, onSite, onStatus }) {
  const [map, setMap] = useState(null)
  const [zoom, setZoom] = useState(null)

  useEffect(() => {
    if (!map) return
    const onZoom = () => setZoom(map.getZoom())
    onZoom()
    map.on('zoomend', onZoom)
    return () => {
      map.off('zoomend', onZoom)
    }
  }, [map])

  useEffect(() => {
    if (!map) return
    if (!site) map.flyToBounds(WORLD)
    else if (site.traverse) map.flyToBounds(site.traverse.path, { padding: [90, 90] })
    else map.flyTo([site.lat, site.lon], SITE_ZOOM)
  }, [map, site])

  // Leaflet fires `load` once every tile has settled, including failed ones,
  // so remember failures until the next batch starts.
  const failed = useRef(false)
  const tileEvents = useMemo(
    () => ({
      loading: () => {
        failed.current = false
        onStatus('loading')
      },
      tileerror: () => {
        failed.current = true
      },
      load: () => onStatus(failed.current ? 'error' : 'ready'),
    }),
    [onStatus],
  )

  return (
    <main className="stage">
      <MapContainer
        ref={setMap}
        className="stage__map"
        crs={L.CRS.EPSG4326}
        bounds={WORLD}
        maxBounds={WORLD}
        maxBoundsViscosity={1}
        minZoom={0}
        zoomSnap={0.25}
        maxZoom={MAX_ZOOM}
        zoomControl={false}
        attributionControl={false}
      >
        {/* Skipping tile loads mid-flight keeps the slow tile server free for
            the tiles at the destination. */}
        <TileLayer
          url="{src}"
          src={tileSource}
          updateWhenZooming={false}
          maxNativeZoom={MAX_NATIVE_ZOOM}
          maxZoom={MAX_ZOOM}
          bounds={WORLD}
          noWrap
          eventHandlers={tileEvents}
        />

        {ROVERS.map((s) => (
          <Polyline
            key={s.id}
            positions={s.traverse.path}
            pathOptions={{ color: '#ffffff', weight: 2, opacity: 0.9 }}
            interactive={false}
          />
        ))}
        {ROVERS.map((s) => (
          <CircleMarker
            key={s.id}
            center={s.traverse.position}
            radius={5}
            pathOptions={{ color: '#ffffff', weight: 1.5, fillColor: '#d7203a', fillOpacity: 1 }}
          >
            <Tooltip className="site-tip" direction="top" offset={[0, -6]}>
              {s.name} · sol {s.traverse.lastSol}
            </Tooltip>
          </CircleMarker>
        ))}

        {SITES.map((s) => {
          const selected = s.id === site?.id
          return (
            <Marker
              key={s.id}
              position={[s.lat, s.lon]}
              icon={ICONS.get(s.id)[selected ? 'selected' : 'idle']}
              zIndexOffset={selected ? 1000 : 0}
              eventHandlers={{ click: () => onSite(s.id) }}
            >
              <Tooltip
                key={selected ? 'pinned' : 'hover'}
                className="site-tip"
                direction="top"
                offset={[0, -10]}
                permanent={selected}
              >
                {s.name}
              </Tooltip>
            </Marker>
          )
        })}
      </MapContainer>

      <div className="hud">
        <span className="hud__corner hud__corner--tl" aria-hidden="true" />
        <span className="hud__corner hud__corner--tr" aria-hidden="true" />
        <span className="hud__corner hud__corner--bl" aria-hidden="true" />
        <span className="hud__corner hud__corner--br" aria-hidden="true" />

        <CursorReadout map={map} />
        <div className="readout readout--tr">
          <span className="readout__label">Target</span>
          <span className="readout__value">{site ? site.name : 'Global'}</span>
        </div>
        <div className="readout readout--br">
          <span className="readout__label">Scale</span>
          <span className="readout__value">{zoom === null ? '—' : formatScale(zoom)}</span>
        </div>

        <div className="zoom" role="group" aria-label="Map zoom">
          <button type="button" onClick={() => map?.zoomOut()} aria-label="Zoom out">
            −
          </button>
          <button type="button" onClick={() => map?.zoomIn()} aria-label="Zoom in">
            +
          </button>
          <button
            type="button"
            className="zoom__reset"
            onClick={() => (site ? onSite(site.id) : map?.flyToBounds(WORLD))}
          >
            Global
          </button>
        </div>

        <SitesPanel site={site} onSite={onSite} />
      </div>
    </main>
  )
}
