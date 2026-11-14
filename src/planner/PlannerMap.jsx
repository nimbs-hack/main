import { useEffect, useState } from 'react'
import { ScreenSpaceEventHandler, ScreenSpaceEventType, Math as CesiumMath, Cartesian2, Cartesian3, Color, HeightReference, Rectangle, SingleTileImageryProvider } from 'cesium'
import { MARS_SPHERE } from '../data/terrain'
import { addRouteOverlay } from '../components/route-overlay'
import { MAX_VIA } from './usePlanner'

const mapLayers = new WeakMap()
const layerOrder = ['hillshade', 'slope', 'temperature', 'pressure']

function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

export default function PlannerMap({ viewer, planner: p, onOverlayError }) {
  const meta = p.site.meta
  useEffect(() => {
    if (!viewer || !meta || !p.open || !p.showBounds) return
    const [w, s, e, n] = meta.bbox
    return addRouteOverlay(viewer, [[[s, w], [n, w], [n, e], [s, e], [s, w]]], token('--color-text-dim'), token('--color-bg'))
  }, [viewer, meta, p.open, p.showBounds])

  useEffect(() => {
    if (!viewer || !p.open) return
    const marked = [...Object.entries(p.waypoints), ...p.via.map((point, i) => [`s${i + 1}`, point])]
    const entities = marked.filter(([, point]) => point).map(([name, point]) => viewer.entities.add({
      position: Cartesian3.fromDegrees(point.lon, point.lat, 0, MARS_SPHERE),
      point: { pixelSize: 10, color: Color.fromCssColorString(token('--color-text')), outlineColor: Color.fromCssColorString(token('--color-bg')), outlineWidth: 2, heightReference: HeightReference.CLAMP_TO_GROUND },
      label: { text: name.toUpperCase(), font: '600 14px monospace', fillColor: Color.fromCssColorString(token('--color-text')), showBackground: true, backgroundColor: Color.fromCssColorString(token('--color-surface')), pixelOffset: new Cartesian2(0, -22), heightReference: HeightReference.CLAMP_TO_GROUND },
    }))
    viewer.scene.requestRender()
    return () => {
      if (viewer.isDestroyed()) return
      for (const entity of entities) viewer.entities.remove(entity)
      viewer.scene.requestRender()
    }
  }, [viewer, p.waypoints, p.via, p.open])

  useEffect(() => {
    if (!viewer || !p.open) return
    const ordered = [...p.routes].sort((a, b) => Number(a.id === p.selected?.id) - Number(b.id === p.selected?.id))
    const stops = ordered.map((route) => addRouteOverlay(viewer,
      [route.points.map((point) => [point.lat, point.lon])],
      token(route.id === p.selected?.id ? '--color-accent' : '--color-text-muted'), token('--color-bg')))
    return () => { for (const stop of stops) stop() }
  }, [viewer, p.routes, p.selected, p.open])

  return <>{Object.entries(p.layers).filter(([, enabled]) => enabled).map(([name]) => <MapLayer key={name} viewer={viewer} planner={p} name={name} onOverlayError={onOverlayError} />)}<SavedPoints viewer={viewer} planner={p} /><MapMenu viewer={viewer} planner={p} /></>
}

function SavedPoints({ viewer, planner: p }) {
  useEffect(() => {
    if (!viewer || !p.open) return
    const entities = p.pointsStore.visiblePoints.map(point => {
      const category = p.pointsStore.classes.find(item => item.id === point.classId)
      return viewer.entities.add({
        position: Cartesian3.fromDegrees(point.lon, point.lat, 0, MARS_SPHERE),
        point: { pixelSize: 9, color: Color.fromCssColorString(category?.color || token('--color-accent')), outlineColor: Color.fromCssColorString(token('--color-bg')), outlineWidth: 2, heightReference: HeightReference.CLAMP_TO_GROUND },
        label: { text: point.name, font: '12px monospace', fillColor: Color.fromCssColorString(token('--color-text')), showBackground: true, backgroundColor: Color.fromCssColorString(token('--color-surface')), pixelOffset: new Cartesian2(0, -20), heightReference: HeightReference.CLAMP_TO_GROUND },
      })
    })
    viewer.scene.requestRender()
    return () => { if (!viewer.isDestroyed()) { entities.forEach(entity => viewer.entities.remove(entity)); viewer.scene.requestRender() } }
  }, [viewer, p.open, p.pointsStore.visiblePoints, p.pointsStore.classes])
  return null
}

function MapLayer({ viewer, planner: p, name, onOverlayError }) {
  const meta = p.site.meta
  useEffect(() => {
    if (!viewer || !meta || !p.open) return
    const controller = new AbortController()
    let imagery
    let objectURL
    const params = new URLSearchParams({ maxSlopeDeg: p.slope, scenario: p.scenario, sol: p.sol, lmstHour: p.hour, minAirTempC: p.minTemp, minPressurePa: p.minPressure })
    const endpoint = name === 'slope' ? 'passability' : name
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/site/${endpoint}.png?${params}`, { signal: controller.signal })
        if (!response.ok) throw new Error(`${name} overlay unavailable (${response.status})`)
        objectURL = URL.createObjectURL(await response.blob())
        const provider = await SingleTileImageryProvider.fromUrl(objectURL, {
          rectangle: Rectangle.fromDegrees(...meta.bbox), ellipsoid: MARS_SPHERE,
        })
        if (controller.signal.aborted || viewer.isDestroyed()) return
        imagery = viewer.imageryLayers.addImageryProvider(provider)
        imagery.alpha = p.opacity
        if (!mapLayers.has(viewer)) mapLayers.set(viewer, new Map())
        const active = mapLayers.get(viewer)
        active.set(name, imagery)
        for (const id of layerOrder) {
          const layer = active.get(id)
          if (layer) viewer.imageryLayers.raiseToTop(layer)
        }
        viewer.scene.requestRender()
        onOverlayError('')
      } catch (error) {
        if (!controller.signal.aborted) onOverlayError(error.message)
      } finally {
        if (controller.signal.aborted && objectURL) URL.revokeObjectURL(objectURL)
      }
    }, 200)
    return () => {
      clearTimeout(timer)
      controller.abort()
      if (mapLayers.get(viewer)?.get(name) === imagery) mapLayers.get(viewer).delete(name)
      if (imagery && !viewer.isDestroyed()) viewer.imageryLayers.remove(imagery, true)
      if (objectURL) URL.revokeObjectURL(objectURL)
      if (!viewer.isDestroyed()) viewer.scene.requestRender()
    }
  }, [viewer, meta, p.open, name, p.opacity, p.slope, p.scenario, p.sol, p.hour, p.minTemp, p.minPressure, onOverlayError])
  return null
}

function MapMenu({ viewer, planner: p }) {
  const [menu, setMenu] = useState(null)
  useEffect(() => {
    if (!viewer || !p.open) { setMenu(null); return }
    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas)
    handler.setInputAction(({ position }) => {
      const ray = viewer.camera.getPickRay(position)
      const hit = ray && viewer.scene.globe.pick(ray, viewer.scene)
      if (!hit) return
      const c = MARS_SPHERE.cartesianToCartographic(hit)
      setMenu({ lat: CesiumMath.toDegrees(c.latitude), lon: CesiumMath.toDegrees(c.longitude), x: position.x, y: position.y })
    }, ScreenSpaceEventType.RIGHT_CLICK)
    const cancel = event => { if (event.key === 'Escape') setMenu(null) }
    window.addEventListener('keydown', cancel)
    return () => { handler.destroy(); window.removeEventListener('keydown', cancel) }
  }, [viewer, p.open])
  if (!menu || !p.open) return null
  const act = callback => { callback({ lat: menu.lat, lon: menu.lon }); setMenu(null) }
  return <div className="planner-context-backdrop" onPointerDown={() => setMenu(null)}><div className="planner-context" style={{ left: Math.max(0, Math.min(menu.x, (viewer?.container.clientWidth ?? 500) - 220)), top: Math.max(0, Math.min(menu.y, (viewer?.container.clientHeight ?? 500) - 200)) }} onPointerDown={event => event.stopPropagation()} role="group" aria-label="Map point actions">
    <p>{menu.lat.toFixed(5)}°, {menu.lon.toFixed(5)}° E</p>
    <button type="button" onClick={() => act(point => { p.putWaypoint('a', point); p.setTab('route') })}>Start here</button>
    <button type="button" onClick={() => act(point => { p.putWaypoint('b', point); p.setTab('route') })}>Destination here</button>
    <button type="button" disabled={p.via.length >= MAX_VIA} onClick={() => act(point => { p.putWaypoint('stop', point); p.setTab('route') })}>Add stop here</button>
    <button type="button" onClick={() => act(point => { p.pointsStore.addPoint(point); p.setTab('points') })}>Save point</button>
    <button type="button" onClick={() => setMenu(null)}>Close</button>
  </div></div>
}
