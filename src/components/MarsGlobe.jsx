import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { SAMPLED_RASTERS, SCIENCE_LAYERS, SCIENCE_RASTERS } from '../data/science-layers'
import { addScienceOverlay } from '../data/science-overlay'
import { tail } from '../data/geo'
import { buildProfile, summarize } from '../data/route-profile'
import { sampleRaster } from '../data/raster-sample'
import { sampleSurface } from '../data/terrain-sample'
import SciencePanel from './SciencePanel'
import RouteProfile from './RouteProfile'
import PointReadout from './PointReadout'
import SuitView from './SuitView'
import usePlanner from '../planner/usePlanner'
import PlannerPanel from '../planner/PlannerPanel'
import PlannerMap from '../planner/PlannerMap'
import { ROUTE_LABELS } from '../planner/api'

const MARS = MARS_SPHERE
const ROVERS = SITES.filter((s) => s.traverse)
const OBSERVATIONS = SCIENCE_LAYERS.filter((layer) => layer.kind === 'observation')
const RADIATION = OBSERVATIONS.find((record) => record.category === 'radiation')
// Finer layers draw above coarser ones.
const RANK = ['tes-albedo', 'mola-roughness', 'mola-color', 'themis-day', 'themis-night']
const DEFAULT_OVERLAYS = Object.fromEntries(SCIENCE_RASTERS.map((layer) => [layer.id, {
  on: layer.id === 'mola-color' || layer.id === 'themis-night',
  opacity: layer.id === 'mola-color' ? 0.45 : 0.6,
}]))
const EVA_LENGTH = 2000 // meters, a single-EVA walking segment

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

// Frames a route segment from above. Sampled elevations, when given, put the
// camera target on the real ground instead of whatever terrain has loaded.
function flyToPath(viewer, path, samples) {
  const points = samples
    ? samples.filter((s) => s.elevation !== null).map((s) => Cartographic.toCartesian(
      Cartographic.fromDegrees(s.point[1], s.point[0], exaggerate(viewer.scene, s.elevation + DATUM_OFFSET)), MARS))
    : surfacePoints(viewer, path.filter((_, i) => i % 5 === 0).concat([path.at(-1)]))
  if (points.length === 0) return
  const sphere = BoundingSphere.fromPoints(points)
  viewer.camera.flyToBoundingSphere(sphere, {
    offset: new HeadingPitchRange(0, CesiumMath.toRadians(-60), Math.max(sphere.radius * 7, 6500)),
  })
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

// One science overlay on the globe. Renders nothing itself.
function ScienceOverlay({ viewer, source, opacity, attempt, onStatus }) {
  const overlay = useRef(null)
  useEffect(() => {
    const created = addScienceOverlay(viewer, source, (status) => onStatus(source.id, status), RANK.indexOf(source.id))
    overlay.current = created
    return () => {
      overlay.current = null
      created.destroy()
      onStatus(source.id, 'idle')
    }
  }, [viewer, source, attempt, onStatus])
  useEffect(() => {
    overlay.current?.setOpacity(opacity)
  }, [opacity, attempt])
  return null
}

function addMarker(viewer) {
  const text = cssColor('--color-text')
  return viewer.entities.add({
    show: false,
    position: Cartesian3.ZERO,
    point: {
      pixelSize: 14,
      color: cssColor('--color-accent'),
      outlineColor: text,
      outlineWidth: 2,
      heightReference: HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  })
}

function placeMarker(viewer, marker, point) {
  if (!viewer || !marker) return
  marker.show = Boolean(point)
  if (point) {
    const location = Cartographic.fromDegrees(point[1], point[0], DATUM_OFFSET)
    location.height = viewer.scene.globe.getHeight(location) ?? exaggerate(viewer.scene, DATUM_OFFSET)
    marker.position = Cartographic.toCartesian(location, MARS)
  }
  viewer.scene.requestRender()
}

// Camera behind the walker, looking along the heading.
function followWalker(viewer, point, heading) {
  const location = Cartographic.fromDegrees(point[1], point[0], DATUM_OFFSET)
  location.height = viewer.scene.globe.getHeight(location) ?? exaggerate(viewer.scene, DATUM_OFFSET)
  const target = Cartographic.toCartesian(location, MARS)
  viewer.camera.flyToBoundingSphere(new BoundingSphere(target, 1), {
    offset: new HeadingPitchRange(CesiumMath.toRadians(heading ?? 0), CesiumMath.toRadians(-22), 900),
    duration: 0.6,
  })
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
      const elevation = unexaggerate(viewer.scene, c.height) - DATUM_OFFSET
      setCursor({ lat, lon, elevation })
    }, ScreenSpaceEventType.MOUSE_MOVE)
    return () => handler.destroy()
  }, [viewer])

  return (
    <div className="readout readout--tl">
      <span className="readout__label">Cursor</span>
      <span className="readout__value">
        {cursor ? formatLatLon(cursor.lat, cursor.lon) : '—'}
        {cursor?.elevation != null && <span className="readout__sub">{formatElevation(cursor.elevation)}</span>}
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
      <span className="readout__label">Altitude</span>
      <span className="readout__value">{height === null ? '—' : formatAltitude(height)}</span>
    </div>
  )
}

export default function MarsGlobe({ site, onSite, onStatus, onImagerySource, onScienceSource }) {
  const planner = usePlanner()
  const plannerPick = useRef(planner.pick)
  plannerPick.current = planner.pick
  const [overlayError, setOverlayError] = useState('')
  const container = useRef(null)
  const [viewer, setViewer] = useState(null)
  const labels = useRef(null)
  const [relief, setRelief] = useState(RELIEF_STEPS[0])
  const [imagerySource, setImagerySource] = useState('v01')
  const [overlays, setOverlays] = useState(DEFAULT_OVERLAYS)
  const [statuses, setStatuses] = useState({})
  const [attempts, setAttempts] = useState({})
  const [probe, setProbe] = useState(null)
  const [segment, setSegment] = useState('eva')
  const [profile, setProfile] = useState({ status: 'idle', samples: null })
  const [profileAttempt, setProfileAttempt] = useState(0)
  const [profileOpen, setProfileOpen] = useState(true)
  const [hoverIndex, setHoverIndex] = useState(null)
  const [suit, setSuit] = useState(null)
  const marker = useRef(null)
  const [terrainProvider, setTerrainProvider] = useState(null)
  const roverRoute = site?.traverse ? site : null
  const planned = planner.selected
  const route = planned ? { id: planned.id, name: ROUTE_LABELS[planned.strategy] } : roverRoute
  const onLayerStatus = useCallback((id, status) => setStatuses((current) => (current[id] === status ? current : { ...current, [id]: status })), [])
  const onProbeRef = useRef(null)
  onProbeRef.current = (point) => setProbe({ point, status: 'loading' })

  // Event handlers registered once read the latest props through refs.
  const onSiteRef = useRef(onSite)
  const onStatusRef = useRef(onStatus)
  const onImagerySourceRef = useRef(onImagerySource)
  onSiteRef.current = onSite
  onStatusRef.current = onStatus
  onImagerySourceRef.current = onImagerySource

  useEffect(() => {
    let failed = false
    const markFailed = () => {
      failed = true
      onStatusRef.current('error')
    }
    const { viewer, imagery, terrain, stopCtx, stopRefinement, stopControls } = createViewer(container.current, {
      onSource: (source) => {
        setImagerySource(source === 'V01' ? 'v01' : 'beta01')
        onImagerySourceRef.current(source)
      },
      onError: markFailed,
    })
    labels.current = addSites(viewer)
    marker.current = addMarker(viewer)
    // Sampling must wait for the real terrain. Until then the viewer holds a
    // flat placeholder that would report every point at the datum.
    if (terrain.ready) setTerrainProvider(terrain.provider)
    const removeTerrainReady = terrain.readyEvent.addEventListener((provider) => setTerrainProvider(provider))
    const stopRoutes = addRouteOverlay(viewer, ROVERS.map((s) => s.traverse.path),
      cssColor('--color-text').toCssColorString(), cssColor('--color-bg').toCssColorString())
    const removeImageryError = imagery.errorEvent.addEventListener(markFailed)
    const removeTerrainError = terrain.errorEvent.addEventListener(markFailed)
    const removeProgress = viewer.scene.globe.tileLoadProgressEvent.addEventListener((queued) => {
      if (queued > 0) {
        onStatusRef.current('loading')
      } else {
        onStatusRef.current(failed ? 'error' : 'ready')
      }
    })

    let hovered = null
    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas)
    const siteAt = (position) => viewer.scene.pick(position)?.id?.siteId ?? null
    handler.setInputAction(({ position }) => {
      const ground = pickGround(viewer, position)
      if (ground) {
        const coordinate = MARS.cartesianToCartographic(ground)
        if (plannerPick.current([CesiumMath.toDegrees(coordinate.latitude), CesiumMath.toDegrees(coordinate.longitude)])) return
      }
      const id = siteAt(position)
      if (id) return onSiteRef.current(id)
      const hit = pickGround(viewer, position)
      if (!hit) return
      const c = MARS.cartesianToCartographic(hit)
      onProbeRef.current([CesiumMath.toDegrees(c.latitude), CesiumMath.toDegrees(c.longitude)])
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
      removeImageryError()
      stopCtx()
      removeTerrainError()
      removeTerrainReady()
      setTerrainProvider(null)
      removeProgress()
      stopRefinement()
      stopControls()
      stopRoutes()
      handler.destroy()
      viewer.destroy()
      setViewer(null)
    }
  }, [])

  useEffect(() => {
    if (!viewer) return
    for (const [id, label] of labels.current) {
      label.pinned = id === site?.id
      label.show = label.pinned
    }
    if (site) flyToSite(viewer, site)
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

  const activeRasters = useMemo(() => SCIENCE_RASTERS.filter((layer) => overlays[layer.id]?.on), [overlays])

  useEffect(() => {
    onScienceSource?.([...new Set(activeRasters.map((layer) => layer.credit))].join(' · '))
  }, [activeRasters, onScienceSource])

  // Route profile for the selected rover traverse. Samples every layer, not
  // only the visible ones, so the strip always shows the full stack.
  const routePath = useMemo(() => {
    if (planned) return planned.points.map((point) => [point.lat, point.lon])
    if (!roverRoute) return null
    const path = roverRoute.traverse.path.concat([roverRoute.traverse.position])
    return segment === 'eva' ? tail(path, EVA_LENGTH) : path
  }, [planned, roverRoute, segment])

  useEffect(() => {
    if (viewer && routePath) flyToPath(viewer, routePath)
  }, [viewer, routePath])

  // Reframe once, when the samples for this segment arrive.
  const framed = useRef(null)
  useEffect(() => {
    if (!viewer || profile.status !== 'ready' || framed.current === profile.samples) return
    framed.current = profile.samples
    flyToPath(viewer, routePath, profile.samples)
  }, [viewer, routePath, profile])

  useEffect(() => {
    setHoverIndex(null)
    if (planner.samples) {
      setProfile({ status: 'ready', samples: planner.samples })
      return
    }
    if (!terrainProvider || !routePath) {
      setProfile({ status: routePath ? 'loading' : 'idle', samples: null })
      return
    }
    let cancelled = false
    setProfile({ status: 'loading', samples: null })
    buildProfile(routePath, {
      provider: terrainProvider,
      rasters: SAMPLED_RASTERS,
      count: segment === 'eva' ? 160 : 240,
      level: segment === 'eva' ? 15 : 12,
    }).then((samples) => {
      if (cancelled) return
      const known = samples.some((s) => s.elevation !== null)
      setProfile({ status: known ? 'ready' : 'error', samples })
    }, () => {
      if (!cancelled) setProfile({ status: 'error', samples: null })
    })
    return () => { cancelled = true }
  }, [terrainProvider, routePath, segment, profileAttempt, planner.samples])

  useEffect(() => {
    setProfileOpen(true)
  }, [route?.id])

  const summary = useMemo(() => (profile.samples ? summarize(profile.samples, planned ? planner.slope : undefined) : null), [profile.samples, planned, planner.slope])

  // Point readout: terrain plus every layer at one spot.
  const probePoint = probe?.point
  useEffect(() => {
    if (!terrainProvider || !probePoint) return
    let cancelled = false
    Promise.all([
      sampleSurface(terrainProvider, [probePoint], 16),
      ...SAMPLED_RASTERS.map((source) => sampleRaster(source, [probePoint])),
    ]).then(([[surface], ...values]) => {
      if (cancelled) return
      setProbe({
        point: probePoint,
        status: surface.elevation === null ? 'error' : 'ready',
        elevation: surface.elevation,
        slope: surface.slope,
        layers: Object.fromEntries(SAMPLED_RASTERS.map((source, i) => [source.id, values[i][0]])),
      })
    }, () => {
      if (!cancelled) setProbe({ point: probePoint, status: 'error' })
    })
    return () => { cancelled = true }
  }, [terrainProvider, probePoint])

  // One marker: the suit position, else the profile hover, else the probe.
  const suitSample = suit && profile.samples ? profile.samples.reduce((best, s) => (Math.abs(s.d - suit.position) < Math.abs(best.d - suit.position) ? s : best)) : null
  const markerPoint = suitSample?.point ?? (hoverIndex !== null ? profile.samples?.[hoverIndex]?.point : null) ?? probePoint ?? null
  useEffect(() => {
    placeMarker(viewer, marker.current, markerPoint)
  }, [viewer, markerPoint])

  // Leaving the route ends the suit view.
  useEffect(() => {
    if (!route || profile.status !== 'ready') setSuit(null)
  }, [route, profile.status])

  const suitPosition = suit?.position
  useEffect(() => {
    if (!viewer || suitPosition === undefined || !profile.samples) return
    const samples = profile.samples
    const here = samples.reduce((best, s) => (Math.abs(s.d - suitPosition) < Math.abs(best.d - suitPosition) ? s : best))
    const ahead = samples.find((s) => s.d > suitPosition + 80) ?? samples.at(-1)
    const dLon = (ahead.point[1] - here.point[1]) * Math.cos(here.point[0] * Math.PI / 180)
    const heading = (Math.atan2(dLon, ahead.point[0] - here.point[0]) * 180) / Math.PI
    followWalker(viewer, here.point, heading)
  }, [viewer, suitPosition, profile.samples])

  const exitSuit = () => {
    setSuit(null)
    if (viewer && routePath) flyToPath(viewer, routePath, profile.samples)
  }

  const dose = RADIATION && {
    site: SITES.find((entry) => entry.id === RADIATION.siteIds[0])?.name ?? '',
    when: RADIATION.epoch.match(/\d{4}/g)?.join('–') ?? '',
    measurement: RADIATION.measurements[0],
  }

  const focusPlanningArea = useCallback(() => {
    if (!viewer || !planner.site.meta) return
    const [w, s, e, n] = planner.site.meta.bbox
    flyToPath(viewer, [[s, w], [n, w], [n, e], [s, e], [s, w]])
  }, [viewer, planner.site.meta])
  const focusedPlanner = useRef(false)
  useEffect(() => {
    if (!viewer || !planner.site.meta || focusedPlanner.current) return
    focusedPlanner.current = true
    focusPlanningArea()
  }, [viewer, planner.site.meta, focusPlanningArea])

  const nextRelief = RELIEF_STEPS[(RELIEF_STEPS.indexOf(relief) + 1) % RELIEF_STEPS.length]

  return (
    <main className="stage">
      <div ref={container} className="stage__map" />

      <div className={`hud${suit ? ' hud--suit' : ''}${route && profileOpen ? ' hud--profile' : ''}`}>
        <span className="hud__corner hud__corner--tl" aria-hidden="true" />
        <span className="hud__corner hud__corner--tr" aria-hidden="true" />
        <span className="hud__corner hud__corner--bl" aria-hidden="true" />
        <span className="hud__corner hud__corner--br" aria-hidden="true" />

        <CursorReadout viewer={viewer} />
        <div className="readout readout--tr">
          <span className="readout__label">Target</span>
          <span className="readout__value">{planner.open && planner.site.meta ? planner.site.meta.name : site ? site.name : 'Global'}</span>
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
            onClick={() => (site ? onSite(site.id) : viewer && flyHome(viewer))}
          >
            Global
          </button>
          {route && !profileOpen && (
            <button type="button" className="zoom__reset" onClick={() => setProfileOpen(true)}>
              Route profile
            </button>
          )}
        </div>

        <SitesPanel site={site} onSite={onSite} />
        <PlannerPanel planner={planner} onFocus={focusPlanningArea} onFocusPoint={point => { if (viewer) flyToPath(viewer, [[point.lat - 0.002, point.lon - 0.002], [point.lat + 0.002, point.lon + 0.002]]) }} />
        <PlannerMap viewer={viewer} planner={planner} onOverlayError={setOverlayError} />
        {overlayError && <p className="planner-map-error" role="alert">{overlayError}</p>}
        <SciencePanel
          layers={SCIENCE_LAYERS}
          overlays={overlays}
          statuses={statuses}
          onToggle={(id) => setOverlays((current) => ({ ...current, [id]: { ...current[id], on: !current[id].on } }))}
          onOpacity={(id, opacity) => setOverlays((current) => ({ ...current, [id]: { ...current[id], opacity } }))}
          onAll={(on) => setOverlays((current) => Object.fromEntries(Object.entries(current).map(([id, state]) => [id, { ...state, on }])))}
          onRetry={(id) => setAttempts((current) => ({ ...current, [id]: (current[id] ?? 0) + 1 }))}
          siteId={site?.id}
          onSite={(id) => { if (id !== site?.id) onSite(id) }}
        />

        {probe && !suit && (
          <PointReadout probe={probe} rasters={SAMPLED_RASTERS} observations={OBSERVATIONS} onClose={() => setProbe(null)} />
        )}

        {route && profileOpen && !suit && (
          <RouteProfile
            samples={profile.samples}
            summary={summary}
            rasters={planned ? [] : SAMPLED_RASTERS}
            status={profile.status}
            segment={segment}
            onSegment={setSegment}
            routeName={planned ? `${route.name} · planned` : `${route.name} traverse`}
            planned={Boolean(planned)}
            slopeLimit={planned ? planner.slope : undefined}
            hoverIndex={hoverIndex}
            onHover={setHoverIndex}
            onPick={(index) => setProbe({ point: profile.samples[index].point, status: 'loading' })}
            onSuit={() => setSuit({ position: 0 })}
            onClose={() => setProfileOpen(false)}
            onRetry={() => setProfileAttempt((attempt) => attempt + 1)}
          />
        )}

        {suit && profile.samples && (
          <SuitView
            samples={profile.samples}
            routeName={planned ? `${route.name} · planned` : `${route.name} traverse`}
            slopeLimit={planned ? planner.slope : undefined}
            position={suit.position}
            onPosition={(position) => setSuit({ position })}
            dose={dose}
            onExit={exitSuit}
          />
        )}

        {viewer && activeRasters.map((source) => (
          <ScienceOverlay
            key={source.id}
            viewer={viewer}
            source={source}
            opacity={overlays[source.id].opacity}
            attempt={attempts[source.id] ?? 0}
            onStatus={onLayerStatus}
          />
        ))}
      </div>
    </main>
  )
}
