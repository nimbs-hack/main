import { useEffect, useRef, useState } from 'react'
import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  DirectionalLight,
  GeographicTilingScheme,
  HeadingPitchRange,
  HeightReference,
  ImageryLayer,
  ImageryProvider,
  LabelStyle,
  Math as CesiumMath,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  UrlTemplateImageryProvider,
  VerticalOrigin,
  Viewer,
} from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import { LOCAL_MAX_ZOOM, MAX_NATIVE_ZOOM, localTilePath, remoteTileUrl } from '../data/basemap'
import { SITES } from '../data/sites'
import { DATUM_OFFSET, MARS_SPHERE, createTerrain } from '../data/terrain'
import { formatAltitude, formatElevation, formatLatLon } from '../format'
import SitesPanel from './SitesPanel'
import NavControls from './NavControls'
import { pickGround, setupControls } from './camera'
import { warmSiteImagery } from '../cache/map-cache'
import { addCtxLayer } from '../data/ctx-layer.ts'
import { addRouteOverlay } from './route-overlay.ts'

const MARS = MARS_SPHERE
const ROVERS = SITES.filter((s) => s.traverse)

// Opening view looks at Tharsis and Valles Marineris, where the relief is
// easiest to see.
const HOME = { lon: -85, lat: 0, height: 9_000_000 }
const SITE_RANGE = 120_000
const FLY_PITCH = CesiumMath.toRadians(-35)
const RELIEF_STEPS = [1, 3]

// Light comes from the top left of the screen, low over the horizon, the
// convention for shaded relief maps. Low light makes slopes cast contrast.
const LIGHT_ELEVATION = CesiumMath.toRadians(35)
const LABEL_FONT = '500 11px "JetBrains Mono Variable", ui-monospace, monospace'

function cssColor(name) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return Color.fromCssColorString(value)
}

// Rendered height for a terrain height, after the elevation scale.
function exaggerate(scene, height) {
  const base = scene.verticalExaggerationRelativeHeight
  return (height - base) * scene.verticalExaggeration + base
}

function unexaggerate(scene, height) {
  const base = scene.verticalExaggerationRelativeHeight
  return (height - base) / scene.verticalExaggeration + base
}

// Camera framing uses already loaded terrain. It must not wait on network
// elevation samples before the flight can even begin.
function surfacePoints(viewer, latLons) {
  const points = latLons.map(([lat, lon]) => Cartographic.fromDegrees(lon, lat, DATUM_OFFSET))
  return points.map((p) => {
    p.height = viewer.scene.globe.getHeight(p) ?? exaggerate(viewer.scene, DATUM_OFFSET)
    return Cartographic.toCartesian(p, MARS)
  })
}

// Points the light so it falls from the top left of the screen at
// LIGHT_ELEVATION above the local horizon, whichever way the camera faces.
const lightScratch = { up: new Cartesian3(), forward: new Cartesian3(), right: new Cartesian3(), tmp: new Cartesian3() }
function aimLight(scene) {
  const { camera } = scene
  const { up, forward, right, tmp } = lightScratch
  MARS.geodeticSurfaceNormal(camera.positionWC, up)

  // The direction toward the top of the screen, flattened onto the ground.
  const flatten = (v) => Cartesian3.subtract(v, Cartesian3.multiplyByScalar(up, Cartesian3.dot(v, up), tmp), forward)
  flatten(camera.directionWC)
  if (Cartesian3.magnitude(forward) < 0.2) flatten(camera.upWC)
  Cartesian3.normalize(forward, forward)
  Cartesian3.cross(forward, up, right)

  const toLight = Cartesian3.subtract(forward, right, tmp)
  Cartesian3.normalize(toLight, toLight)
  Cartesian3.multiplyByScalar(toLight, Math.cos(LIGHT_ELEVATION), toLight)
  Cartesian3.add(toLight, Cartesian3.multiplyByScalar(up, Math.sin(LIGHT_ELEVATION), right), toLight)
  Cartesian3.negate(toLight, scene.light.direction)
  Cartesian3.normalize(scene.light.direction, scene.light.direction)
}

function flyHome(viewer) {
  viewer.camera.flyTo({ destination: Cartesian3.fromDegrees(HOME.lon, HOME.lat, HOME.height, MARS) })
}

function flyToSite(viewer, site) {
  if (site.traverse) {
    // Every 25th point is plenty to bound the route.
    const path = site.traverse.path.filter((_, i) => i % 25 === 0).concat([site.traverse.position])
    const sphere = BoundingSphere.fromPoints(surfacePoints(viewer, path))
    viewer.camera.flyToBoundingSphere(sphere, {
      offset: new HeadingPitchRange(0, FLY_PITCH, Math.max(sphere.radius * 3, 20_000)),
    })
  } else {
    const [point] = surfacePoints(viewer, [[site.lat, site.lon]])
    viewer.camera.flyToBoundingSphere(new BoundingSphere(point, 1), {
      offset: new HeadingPitchRange(0, FLY_PITCH, SITE_RANGE),
    })
  }
}

function createViewer(container, ctxOptions) {
  const terrain = createTerrain()
  const imagery = new UrlTemplateImageryProvider({
    url: remoteTileUrl('{z}', '{y}', '{x}'),
    tilingScheme: new GeographicTilingScheme({ ellipsoid: MARS }),
    maximumLevel: MAX_NATIVE_ZOOM,
    credit: 'Viking MDIM 2.1 color mosaic: NASA / JPL-Caltech / USGS',
  })
  // Low zoom levels ship with the app in public/tiles. Cesium URL-encodes
  // template values, so the local paths are swapped in here instead.
  const requestRemote = imagery.requestImage.bind(imagery)
  imagery.requestImage = (x, y, level, request) =>
    level <= LOCAL_MAX_ZOOM
      ? ImageryProvider.loadImage(imagery, import.meta.env.BASE_URL + localTilePath(level, y, x))
      : requestRemote(x, y, level, request)

  const viewer = new Viewer(container, {
    ellipsoid: MARS,
    baseLayer: new ImageryLayer(imagery),
    terrain,
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    skyBox: false,
    skyAtmosphere: false,
    // Sources are credited in the status bar.
    creditContainer: document.createElement('div'),
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity,
  })

  const stopCtx = addCtxLayer(viewer, ctxOptions)

  const { scene } = viewer
  scene.backgroundColor = cssColor('--color-bg')
  scene.fog.enabled = false
  scene.globe.showGroundAtmosphere = false
  scene.globe.baseColor = cssColor('--color-surface')
  scene.globe.enableLighting = true
  // Let terrain hide markers and labels on slopes and the far side of Mars.
  scene.globe.depthTestAgainstTerrain = true
  // Keep decoded terrain and imagery when zooming away and back.
  scene.globe.tileCacheSize = 512
  // Avoid fetching every intermediate close-up during a flight or scroll.
  // Once motion stops, return to the original full-detail error threshold.
  let refinementTimer
  const removeMoveStart = viewer.camera.moveStart.addEventListener(() => {
    clearTimeout(refinementTimer)
    scene.globe.maximumScreenSpaceError = 8
    scene.requestRender()
  })
  const removeMoveEnd = viewer.camera.moveEnd.addEventListener(() => {
    refinementTimer = setTimeout(() => {
      if (viewer.isDestroyed()) return
      scene.globe.maximumScreenSpaceError = 2
      scene.requestRender()
    }, 150)
  })
  const stopRefinement = () => {
    clearTimeout(refinementTimer)
    removeMoveStart()
    removeMoveEnd()
  }
  scene.globe.dynamicAtmosphereLighting = false
  scene.light = new DirectionalLight({ direction: new Cartesian3(0, 0, -1), intensity: 2 })
  scene.preUpdate.addEventListener(() => aimLight(scene))
  // Scale elevation around the areoid, not around Trek's shifted zero.
  scene.verticalExaggerationRelativeHeight = DATUM_OFFSET
  viewer.camera.percentageChanged = 0.01
  const stopControls = setupControls(viewer)
  viewer.camera.setView({ destination: Cartesian3.fromDegrees(HOME.lon, HOME.lat, HOME.height, MARS) })

  return { viewer, imagery, terrain, stopCtx, stopRefinement, stopControls }
}

function addSites(viewer) {
  const text = cssColor('--color-text')
  const panel = cssColor('--color-surface')

  for (const s of ROVERS) {
    const [lat, lon] = s.traverse.position
    viewer.entities.add({
      position: Cartesian3.fromDegrees(lon, lat, 0, MARS),
      point: {
        pixelSize: 9,
        color: text,
        outlineColor: text,
        outlineWidth: 1.5,
        heightReference: HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: 0,
      },
    })
  }

  const labels = new Map()
  for (const s of SITES) {
    const entity = viewer.entities.add({
      position: Cartesian3.fromDegrees(s.lon, s.lat, 0, MARS),
      point: {
        pixelSize: 8,
        color: s.ended ? panel : text,
        outlineColor: text,
        outlineWidth: 1.5,
        heightReference: HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: 0,
      },
      label: {
        text: s.traverse ? `${s.name} · sol ${s.traverse.lastSol}` : s.name,
        show: false,
        font: LABEL_FONT,
        fillColor: text,
        style: LabelStyle.FILL,
        showBackground: true,
        backgroundColor: panel,
        backgroundPadding: new Cartesian2(8, 4),
        verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(0, -12),
        heightReference: HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: 0,
      },
    })
    entity.siteId = s.id
    labels.set(s.id, entity.label)
  }
  return labels
}

// Own component so pointer movement re-renders only this readout.
function CursorReadout({ viewer }) {
  const [cursor, setCursor] = useState(null)

  useEffect(() => {
    if (!viewer) return
    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas)
    handler.setInputAction(({ endPosition }) => {
      const hit = pickGround(viewer, endPosition)
      if (!hit) return setCursor(null)
      const c = MARS.cartesianToCartographic(hit)
      const lat = CesiumMath.toDegrees(c.latitude)
      const lon = CesiumMath.toDegrees(c.longitude)
      // pickGround can fall back to the bare sphere. Never label that as elevation.
      const terrainHeight = viewer.scene.globe.getHeight(c)
      const elevation = terrainHeight === undefined ? null : unexaggerate(viewer.scene, terrainHeight) - DATUM_OFFSET
      setCursor({ lat, lon, elevation })
    }, ScreenSpaceEventType.MOUSE_MOVE)
    return () => handler.destroy()
  }, [viewer])

  return (
    <div className="readout readout--tl">
      <span className="readout__label">Cursor</span>
      <span className="readout__value">
        {cursor ? formatLatLon(cursor.lat, cursor.lon) : '—'}
        {cursor && <span className="readout__sub">{cursor.elevation === null ? 'Elevation unavailable' : `${formatElevation(cursor.elevation)} · MOLA areoid`}</span>}
      </span>
    </div>
  )
}

function AltitudeReadout({ viewer }) {
  const [height, setHeight] = useState(null)

  useEffect(() => {
    if (!viewer) return
    // Height above the ground under the camera. scene.globeHeight is the same
    // value Cesium uses for terrain collisions. Unknown until that ground loads.
    const update = () => {
      const camera = viewer.camera.positionCartographic
      const ground = viewer.scene.globeHeight ?? viewer.scene.globe.getHeight(camera)
      setHeight(ground === undefined ? null : Math.round(camera.height - ground))
    }
    update()
    return viewer.scene.postRender.addEventListener(update)
  }, [viewer])

  return (
    <div className="readout readout--br">
      <span className="readout__label">Camera above displayed terrain</span>
      <span className="readout__value">{height === null ? '—' : formatAltitude(height)}</span>
    </div>
  )
}

export default function MarsGlobe({ site, onSite, onStatus, onImagerySource, retryKey }) {
  const container = useRef(null)
  const [viewer, setViewer] = useState(null)
  const labels = useRef(null)
  const [relief, setRelief] = useState(RELIEF_STEPS[0])
  const [imagerySource, setImagerySource] = useState('v01')
  const savedCamera = useRef(null)

  // Event handlers registered once read the latest props through refs.
  const onSiteRef = useRef(onSite)
  const onStatusRef = useRef(onStatus)
  const onImagerySourceRef = useRef(onImagerySource)
  onSiteRef.current = onSite
  onStatusRef.current = onStatus
  onImagerySourceRef.current = onImagerySource

  useEffect(() => {
    onStatusRef.current({ type: 'reset' })
    const markFailed = (source) => onStatusRef.current({ type: 'failure', source })
    let resources
    try {
      resources = createViewer(container.current, {
        onSource: (source) => {
          setImagerySource(source === 'V01' ? 'v01' : 'beta01')
          onImagerySourceRef.current(source)
        },
        onError: () => markFailed('CTX imagery'),
      })
    } catch {
      markFailed('3D viewer')
      return
    }
    const { viewer, imagery, terrain, stopCtx, stopRefinement, stopControls } = resources
    labels.current = addSites(viewer)
    const stopRoutes = addRouteOverlay(viewer, ROVERS.map((s) => s.traverse.path),
      cssColor('--color-text').toCssColorString(), cssColor('--color-bg').toCssColorString())
    const removeImageryError = imagery.errorEvent.addEventListener(() => markFailed('Viking imagery'))
    const removeTerrainError = terrain.errorEvent.addEventListener(() => markFailed('Terrain'))
    let removeTerrainTileError = () => {}
    const terrainReady = (provider) => {
      onStatusRef.current({ type: 'terrain-ready' })
      removeTerrainTileError = provider.errorEvent.addEventListener(() => markFailed('Terrain'))
    }
    const removeTerrainReady = terrain.readyEvent.addEventListener(terrainReady)
    if (terrain.ready) terrainReady(terrain.provider)
    const removeProgress = viewer.scene.globe.tileLoadProgressEvent.addEventListener((queued) => {
      onStatusRef.current({ type: 'progress', queued })
    })

    let hovered = null
    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas)
    const siteAt = (position) => viewer.scene.pick(position)?.id?.siteId ?? null
    handler.setInputAction(({ position }) => {
      const id = siteAt(position)
      if (id) onSiteRef.current(id)
    }, ScreenSpaceEventType.LEFT_CLICK)
    handler.setInputAction(({ endPosition }) => {
      const id = siteAt(endPosition)
      if (id === hovered) return
      hovered = id
      viewer.container.style.cursor = id ? 'pointer' : ''
      viewer.scene.requestRender()
      for (const [siteId, label] of labels.current) label.show = siteId === id || label.pinned === true
    }, ScreenSpaceEventType.MOUSE_MOVE)

    // Lets the browser console poke at the scene while developing.
    if (import.meta.env.DEV) window.viewer = viewer

    setViewer(viewer)
    return () => {
      savedCamera.current = {
        destination: Cartesian3.clone(viewer.camera.positionWC),
        orientation: { heading: viewer.camera.heading, pitch: viewer.camera.pitch, roll: viewer.camera.roll },
      }
      removeImageryError()
      stopCtx()
      removeTerrainError()
      removeTerrainReady()
      removeTerrainTileError()
      removeProgress()
      stopRefinement()
      stopControls()
      stopRoutes()
      handler.destroy()
      viewer.destroy()
      setViewer(null)
    }
  }, [retryKey])

  useEffect(() => {
    if (!viewer) return
    for (const [id, label] of labels.current) {
      label.pinned = id === site?.id
      label.show = label.pinned
    }
    if (savedCamera.current) {
      viewer.camera.setView(savedCamera.current)
      savedCamera.current = null
    } else if (site) flyToSite(viewer, site)
    else flyHome(viewer)
  }, [viewer, site])

  useEffect(() => {
    if (viewer && site) return warmSiteImagery(viewer, site, imagerySource)
  }, [viewer, site, imagerySource])

  useEffect(() => {
    if (!viewer) return
    viewer.scene.verticalExaggeration = relief
    viewer.scene.requestRender()
  }, [viewer, relief])

  const nextRelief = RELIEF_STEPS[(RELIEF_STEPS.indexOf(relief) + 1) % RELIEF_STEPS.length]

  return (
    <main className="stage">
      <div ref={container} className="stage__map" />

      <div className="hud">
        <span className="hud__corner hud__corner--tl" aria-hidden="true" />
        <span className="hud__corner hud__corner--tr" aria-hidden="true" />
        <span className="hud__corner hud__corner--bl" aria-hidden="true" />
        <span className="hud__corner hud__corner--br" aria-hidden="true" />

        <CursorReadout viewer={viewer} />
        <div className="readout readout--tr">
          <span className="readout__label">Selected site</span>
          <span className="readout__value">{site ? site.name : 'None selected'}</span>
          {site && <span className="readout__sub">Route safety not assessed</span>}
        </div>
        <AltitudeReadout viewer={viewer} />
        <NavControls viewer={viewer} />

        <div className="zoom" role="group" aria-label="View">
          <button
            type="button"
            className="zoom__reset"
            onClick={() => setRelief(nextRelief)}
            aria-label={`Elevation scale ${relief}×. Switch to ${nextRelief}×`}
          >
            Elevation scale {relief}×
          </button>
          <button
            type="button"
            className="zoom__reset"
            onClick={() => (site ? onSite(null) : viewer && flyHome(viewer))}
          >
            Global view
          </button>
        </div>

        <SitesPanel site={site} onSite={onSite} onLocate={() => viewer && site && flyToSite(viewer, site)} imagerySource={imagerySource === 'v01' ? 'V01' : 'beta01'} relief={relief} />
      </div>
    </main>
  )
}
