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
import { FAST_VIEWER_OPTIONS, tuneViewer } from '../data/performance'
import NavControls from './NavControls'
import { pickGround, setupControls } from './camera'
import { warmSiteImagery } from '../cache/map-cache'
import { addCtxLayer } from '../data/ctx-layer.ts'
import { addRouteOverlay } from './route-overlay.ts'
import { SAMPLED_RASTERS, SCIENCE_LAYERS, SCIENCE_RASTERS } from '../data/science-layers'
import { addScienceOverlay } from '../data/science-overlay'
import { distance, resample } from '../data/geo'
import { buildProfile, slopeLevel, summarize } from '../data/route-profile'
import { DEFAULT_LIMITS, EMPTY_PLAN, assess, withReasons, insertWaypoint, moveVertex, planPath, removeWaypoint } from '../data/plan'
import { addPlanOverlay } from './plan-overlay'
import { areaStats, buildGrid, routeOptions, sameReason } from '../data/route-options'
import RouteOptions from './RouteOptions'
import { formatDistance } from './RouteProfile'
import { STATIONS, fetchWeather, formatPressure, formatTemp, nearestStation, pressureAt } from '../data/weather'
import { fetchUnit } from '../data/geology'
import { coverage, detailAt, detailLabel, detailMeters, levelAt, levelForSpacing, outline, slopeBaseline } from '../data/terrain-detail'
import { checkSpaceWeather, fetchSpaceWeather } from '../data/space-weather'
import { TERRAIN_API_PATH } from '../data/terrain-source'
import { addToolOverlay } from './tool-overlay'
import { addMarker as addMapMarker, loadMarkers, removeMarker, saveMarkers, symbolImage, updateMarker } from '../data/markers'
import LayerSwitcher from './LayerSwitcher'
import MapTools, { ToolButtons } from './MapTools'
import { sampleRaster } from '../data/raster-sample'
import { sampleElevations, sampleSurface } from '../data/terrain-sample'
import { loadRouteField } from '../data/route-field'
import SciencePanel from './SciencePanel'
import RouteProfile from './RouteProfile'
import PointReadout from './PointReadout'
import SuitView from './SuitView'
import PlanPanel from './PlanPanel'

const MARS = MARS_SPHERE
const ROVERS = SITES.filter((s) => s.traverse)
const OBSERVATIONS = SCIENCE_LAYERS.filter((layer) => layer.kind === 'observation')
// The profile keeps the footing lane that changes along a walk.
const PROFILE_RASTERS = SAMPLED_RASTERS.filter((layer) => layer.id === 'mola-roughness')
const RADIATION = OBSERVATIONS.find((record) => record.category === 'radiation')
// Finer layers draw above coarser ones.
const RANK = ['tes-albedo', 'mola-roughness', 'mola-color', 'geology', 'themis-day', 'themis-night']
// Every overlay starts off. Two that were on by default made up half of the
// tile requests of a zoom, and held back the imagery and terrain under them.
// The layer switcher turns them on.
const DEFAULT_OVERLAYS = Object.fromEntries(SCIENCE_RASTERS.map((layer) => [layer.id, {
  on: false,
  opacity: layer.id === 'mola-color' ? 0.45 : 0.6,
}]))
// A new start this far from the old target starts a new plan.
const NEW_PLAN_DISTANCE = 20_000
const PLAN_KEY = 'nimbs.eva-plan'

function loadPlan() {
  try {
    const saved = JSON.parse(localStorage.getItem(PLAN_KEY) ?? 'null')
    if (saved?.plan && Array.isArray(saved.plan.waypoints) && saved.limits) {
      return { plan: saved.plan, limits: { ...DEFAULT_LIMITS, ...saved.limits } }
    }
  } catch {
    // Private mode or bad JSON: start empty.
  }
  return { plan: EMPTY_PLAN, limits: DEFAULT_LIMITS }
}

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

function cssValue(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function cssColor(name) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return Color.fromCssColorString(value)
}

// Rendered height for a terrain height, after the elevation scale.
function exaggerate(scene, height) {
  const base = scene.verticalExaggerationRelativeHeight
  return (height - base) * scene.verticalExaggeration + base
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

// Terrain at this tile level or deeper counts as fine and gets an outline.
// Level 15 is about 5 m between samples.
const FINE_LEVEL = 15

// Each weather station sits at its rover's last reported position.
const STATION_POSITIONS = Object.fromEntries(STATIONS.map(({ id, siteId }) => [id, SITES.find((s) => s.id === siteId).traverse.position]))
// The rovers report once a sol. Refetch hourly so a long session stays current.
const WEATHER_REFRESH = 3_600_000

// Map markers as billboards, one per marker, with the label under the symbol.
function syncMarkers(viewer, entities, markers) {
  for (const entity of entities.values()) viewer.entities.remove(entity)
  entities.clear()
  const text = cssValue('--color-text')
  const bg = cssValue('--color-bg')
  for (const m of markers) {
    const entity = viewer.entities.add({
      position: Cartesian3.fromDegrees(m.point[1], m.point[0], 0, MARS),
      billboard: {
        image: symbolImage(m.symbol, text, bg),
        heightReference: HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: m.label,
        font: LABEL_FONT,
        fillColor: Color.fromCssColorString(text),
        style: LabelStyle.FILL,
        showBackground: true,
        backgroundColor: Color.fromCssColorString(bg).withAlpha(0.82),
        backgroundPadding: new Cartesian2(6, 3),
        verticalOrigin: VerticalOrigin.TOP,
        pixelOffset: new Cartesian2(0, 20),
        heightReference: HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })
    entity.markerId = m.id
    entities.set(m.id, entity)
  }
  viewer.scene.requestRender()
}

// Canvas position of a ground point, or null when it's out of view.
function screenOf(viewer, [lat, lon]) {
  const location = Cartographic.fromDegrees(lon, lat, DATUM_OFFSET)
  location.height = viewer.scene.globe.getHeight(location) ?? DATUM_OFFSET
  const at = viewer.scene.cartesianToCanvasCoordinates(Cartographic.toCartesian(location, MARS))
  return at ? { x: at.x, y: at.y } : null
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

// Close enough to see boulder-scale imagery around a planned start.
function flyToPoint(viewer, point, range = 6000) {
  const [target] = surfacePoints(viewer, [point])
  viewer.camera.flyToBoundingSphere(new BoundingSphere(target, 1), {
    offset: new HeadingPitchRange(0, CesiumMath.toRadians(-60), range),
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
    ...FAST_VIEWER_OPTIONS,
  })

  const stopCtx = addCtxLayer(viewer, ctxOptions)

  const { scene } = viewer
  scene.backgroundColor = cssColor('--color-bg')
  scene.globe.showGroundAtmosphere = false
  scene.globe.baseColor = cssColor('--color-surface')
  scene.globe.enableLighting = true
  // Let terrain hide markers and labels on slopes and the far side of Mars.
  scene.globe.depthTestAgainstTerrain = true
  // Coarser tiles while the camera makes a big zoom, a larger tile cache,
  // and the rest of what keeps drawing cheap. See src/data/performance.js.
  const stopRefinement = tuneViewer(viewer)
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

// deploy-v1's profile hover dot: a 10 px text-colored square in a 2 px
// accent border. Square, since nothing on the map has rounded corners.
function squareMarkerImage() {
  const canvas = document.createElement('canvas')
  canvas.width = 14
  canvas.height = 14
  const context = canvas.getContext('2d')
  context.fillStyle = cssValue('--color-accent')
  context.fillRect(0, 0, 14, 14)
  context.fillStyle = cssValue('--color-text')
  context.fillRect(2, 2, 10, 10)
  return canvas
}

function addMarker(viewer) {
  return viewer.entities.add({
    show: false,
    position: Cartesian3.ZERO,
    billboard: {
      image: squareMarkerImage(),
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

export default function MarsGlobe({ site, onSite, onStatus, onImagerySource, onScienceSource, onViewer }) {
  const container = useRef(null)
  const [viewer, setViewer] = useState(null)
  const labels = useRef(null)
  const [relief, setRelief] = useState(RELIEF_STEPS[0])
  const [imagerySource, setImagerySource] = useState('v01')
  const [overlays, setOverlays] = useState(DEFAULT_OVERLAYS)
  const [statuses, setStatuses] = useState({})
  const [attempts, setAttempts] = useState({})
  const [probe, setProbe] = useState(null)
  // Terrain and night IR on a grid around start and target, for route suggestions.
  const [routeField, setRouteField] = useState({ status: 'idle' })
  const [routeAttempt, setRouteAttempt] = useState(0)
  const [routeHover, setRouteHover] = useState(null)
  // Tooltip for the suggested route line under the pointer.
  const [lineTip, setLineTip] = useState(null)
  // The suggestion last applied, and the waypoints it set.
  const [chosenRoute, setChosenRoute] = useState(null)
  const [layersOpen, setLayersOpen] = useState(false)
  // Station reports by id: a report, 'error', or missing while loading.
  const [weather, setWeather] = useState({})
  const [stationElevation, setStationElevation] = useState({})
  const [markers, setMarkers] = useState(loadMarkers)
  const [spaceWeather, setSpaceWeather] = useState({ status: 'loading', data: null })
  // Minute clock for time-relative checks such as CME arrivals.
  const [clock, setClock] = useState(() => Date.now())
  const markerEntities = useRef(new Map())
  const [profile, setProfile] = useState({ status: 'idle', samples: null })
  const [profileAttempt, setProfileAttempt] = useState(0)
  const [profileOpen, setProfileOpen] = useState(true)
  const [hoverIndex, setHoverIndex] = useState(null)
  const [suit, setSuit] = useState(null)
  const [saved] = useState(loadPlan)
  const [plan, setPlan] = useState(saved.plan)
  const [limits, setLimits] = useState(saved.limits)
  // What the next map click does: 'start', 'target', 'waypoint' or null to probe.
  const [placing, setPlacingState] = useState(null)
  // Map tool in use: 'ruler', 'range', 'sight' or null. It takes map clicks
  // the way placement does, so turning one on turns the other off.
  const [tool, setToolState] = useState(null)
  const [toolSeed, setToolSeed] = useState(null)
  const toolClickRef = useRef(null)
  const setPlacing = useCallback((mode) => {
    setPlacingState(mode)
    if (typeof mode === 'string') setToolState(null)
  }, [])
  const setTool = useCallback((id) => {
    setToolState(id)
    if (id) setPlacingState(null)
  }, [])
  // Where to fly after the site flight. A saved plan opens on its start.
  const [focus, setFocus] = useState(() => (saved.plan.start ? { point: saved.plan.start } : null))
  const marker = useRef(null)
  const planOverlay = useRef(null)
  const [terrainProvider, setTerrainProvider] = useState(null)
  const onLayerStatus = useCallback((id, status) => setStatuses((current) => (current[id] === status ? current : { ...current, [id]: status })), [])

  // Event handlers registered once read the latest props through refs.
  const onSiteRef = useRef(onSite)
  const onStatusRef = useRef(onStatus)
  const onImagerySourceRef = useRef(onImagerySource)
  const onMapClickRef = useRef(null)
  const onContextRef = useRef(null)
  const onLineRef = useRef(null)
  const onMoveVertexRef = useRef(null)
  const placingRef = useRef(placing)
  const toolRef = useRef(tool)
  onSiteRef.current = onSite
  onStatusRef.current = onStatus
  onImagerySourceRef.current = onImagerySource
  placingRef.current = placing
  toolRef.current = tool

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
      cssColor('--color-text-dim').toCssColorString(), cssColor('--color-bg').toCssColorString())
    planOverlay.current = addPlanOverlay(viewer, {
      text: cssColor('--color-text').toCssColorString(),
      bg: cssColor('--color-bg').toCssColorString(),
      surface: cssColor('--color-surface').toCssColorString(),
      dim: cssColor('--color-text-dim').toCssColorString(),
      hazard: cssColor('--color-hazard').toCssColorString(),
      accent: cssColor('--color-accent').toCssColorString(),
      ok: cssColor('--color-ok').toCssColorString(),
    })
    const removeImageryError = imagery.errorEvent.addEventListener(markFailed)
    const removeTerrainError = terrain.errorEvent.addEventListener(markFailed)
    const removeProgress = viewer.scene.globe.tileLoadProgressEvent.addEventListener((queued) => {
      if (queued > 0) {
        onStatusRef.current('loading')
      } else {
        onStatusRef.current(failed ? 'error' : 'ready')
      }
    })

    const toLatLon = (position) => {
      const hit = pickGround(viewer, position)
      if (!hit) return null
      const c = MARS.cartesianToCartographic(hit)
      return [CesiumMath.toDegrees(c.latitude), CesiumMath.toDegrees(c.longitude)]
    }

    // Dragging a plan handle. A press on a handle swallows the click that
    // follows, so letting go never also places or probes a point.
    const controls = viewer.scene.screenSpaceCameraController
    let drag = null
    let swallowClick = false
    let cursor = ''
    const setCursor = (next) => {
      if (next === cursor) return
      cursor = next
      viewer.container.style.cursor = next
    }

    let hovered = null
    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas)
    const siteAt = (position) => viewer.scene.pick(position)?.id?.siteId ?? null
    handler.setInputAction(({ position }) => {
      const index = planOverlay.current.handleAt(position)
      swallowClick = index !== null
      if (index === null) return
      drag = { index, point: null }
      controls.enableInputs = false
      setCursor('grabbing')
    }, ScreenSpaceEventType.LEFT_DOWN)
    handler.setInputAction(() => {
      if (!drag) return
      if (drag.point) onMoveVertexRef.current(drag.index, drag.point)
      planOverlay.current.drag(null)
      drag = null
      controls.enableInputs = true
      setCursor('')
    }, ScreenSpaceEventType.LEFT_UP)
    handler.setInputAction(({ position }) => {
      if (swallowClick) {
        swallowClick = false
        return
      }
      const free = !placingRef.current && !toolRef.current
      // Clicking a suggested route's line picks it, as on deploy-v1.
      const line = free ? planOverlay.current.alternativeAt(position) : null
      if (line) return onLineRef.current({ id: line, pick: true })
      const id = free ? siteAt(position) : null
      onMapClickRef.current({ siteId: id, point: id ? null : toLatLon(position) })
    }, ScreenSpaceEventType.LEFT_CLICK)
    // Right click opens the point menu. Right drag still tilts the camera:
    // Cesium only reports a click when the pointer didn't move.
    handler.setInputAction(({ position }) => {
      const markerId = viewer.scene.pick(position)?.id?.markerId ?? null
      const point = toLatLon(position)
      if (point || markerId) onContextRef.current({ point, markerId, screen: { x: position.x, y: position.y } })
    }, ScreenSpaceEventType.RIGHT_CLICK)
    const noMenu = (event) => event.preventDefault()
    viewer.scene.canvas.addEventListener('contextmenu', noMenu)
    // Moving the map leaves the menu pointing at the wrong spot, so close it.
    const removeMoveClose = viewer.camera.moveStart.addEventListener(() => onContextRef.current(null))
    handler.setInputAction(({ endPosition }) => {
      if (drag) {
        const point = toLatLon(endPosition)
        if (point) {
          drag.point = point
          planOverlay.current.drag(drag.index, point)
        }
        return
      }
      const overHandle = planOverlay.current.handleAt(endPosition) !== null
      const free = !placingRef.current && !toolRef.current
      const line = !overHandle && free ? planOverlay.current.alternativeAt(endPosition) : null
      onLineRef.current(line ? { id: line, x: endPosition.x, y: endPosition.y } : null)
      const id = overHandle || line ? null : siteAt(endPosition)
      setCursor(overHandle ? 'grab' : id || line ? 'pointer' : placingRef.current || toolRef.current ? 'crosshair' : '')
      if (id === hovered) return
      hovered = id
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
      viewer.scene.canvas.removeEventListener('contextmenu', noMenu)
      removeMoveClose()
      planOverlay.current.destroy()
      planOverlay.current = null
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

  // Runs after the site flight above, so it replaces it.
  useEffect(() => {
    if (viewer && focus) flyToPoint(viewer, focus.point)
  }, [viewer, focus])

  useEffect(() => {
    if (viewer && site) return warmSiteImagery(viewer, site, imagerySource)
  }, [viewer, site, imagerySource])

  useEffect(() => {
    if (!viewer) return
    viewer.scene.verticalExaggeration = relief
    viewer.scene.requestRender()
  }, [viewer, relief])

  // The status bar reads the camera and cursor from the same viewer.
  useEffect(() => {
    onViewer?.(viewer)
  }, [viewer, onViewer])

  const activeRasters = useMemo(() => SCIENCE_RASTERS.filter((layer) => overlays[layer.id]?.on), [overlays])

  useEffect(() => {
    onScienceSource?.([...new Set(activeRasters.map((layer) => layer.credit))].join(' · '))
  }, [activeRasters, onScienceSource])

  // The plan survives a reload. Storage can be missing, so failures are ignored.
  useEffect(() => {
    try {
      localStorage.setItem(PLAN_KEY, JSON.stringify({ plan, limits }))
    } catch {
      // Nothing to do without storage.
    }
  }, [plan, limits])

  // Route from start through waypoints to target, once both ends exist.
  const routePath = useMemo(() => {
    const path = planPath(plan)
    return plan.start && plan.target ? path : null
  }, [plan])

  // Sample the layers shown in the profile. Other layers are read on demand
  // by the point menu. Long routes sample coarser terrain tiles.
  useEffect(() => {
    setHoverIndex(null)
    if (!terrainProvider || !routePath) {
      setProfile({ status: routePath ? 'loading' : 'idle', samples: null })
      return
    }
    let cancelled = false
    setProfile({ status: 'loading', samples: null })
    // Sample at the finest terrain anywhere on the route. Where the route
    // leaves it, sampling falls back to coarser levels and the legs say so.
    const finest = Math.max(9, ...resample(routePath, 24).map(({ point }) => levelAt(terrainProvider, point) ?? 9))
    const level = Math.min(17, finest)
    buildProfile(routePath, {
      provider: terrainProvider,
      rasters: PROFILE_RASTERS,
      count: 200,
      level,
      baseline: slopeBaseline(detailMeters(level)),
      detail: (point) => detailAt(terrainProvider, point),
    }).then((samples) => {
      if (cancelled) return
      const known = samples.some((s) => s.elevation !== null)
      setProfile({ status: known ? 'ready' : 'error', samples })
    }, () => {
      if (!cancelled) setProfile({ status: 'error', samples: null })
    })
    return () => { cancelled = true }
  }, [terrainProvider, routePath, profileAttempt])

  useEffect(() => {
    if (routePath) setProfileOpen(true)
  }, [routePath])

  const summary = useMemo(() => (profile.samples ? summarize(profile.samples) : null), [profile.samples])
  const doseRate = RADIATION?.measurements[0]?.unit === 'Sv/day' ? RADIATION.measurements[0].value : null
  const routeAssessment = useMemo(
    () => (profile.status === 'ready' && routePath ? assess(profile.samples, routePath, limits, doseRate) : null),
    [profile, routePath, limits, doseRate],
  )
  // The EVA window: from the planned start, or now, for the route's time,
  // or the whole budget before a route exists.
  const evaStart = plan.when ? Date.parse(plan.when) : clock
  const evaEnd = evaStart + (routeAssessment?.total ?? limits.eva) * 1000
  const spaceCheck = useMemo(
    () => (spaceWeather.status === 'loading' ? null : checkSpaceWeather(spaceWeather.data, evaStart, evaEnd, clock)),
    [spaceWeather, evaStart, evaEnd, clock],
  )
  const assessment = useMemo(
    () => (routeAssessment && spaceCheck ? withReasons(routeAssessment, spaceCheck.reasons) : routeAssessment),
    [routeAssessment, spaceCheck],
  )
  // Finest and coarsest terrain under the route, for the Terrain tab.
  const terrainDetail = useMemo(() => {
    const details = (profile.samples ?? []).map((sample) => sample.detail).filter((d) => d != null)
    if (!details.length) return null
    const coarse = routeAssessment?.legs.reduce((sum, leg) => sum + leg.coarse, 0) ?? 0
    return { finest: Math.min(...details), coarsest: Math.max(...details), coarse }
  }, [profile.samples, routeAssessment])

  // Sample the grid once per start and target. Limits only rerun the search.
  const routeStart = plan.start
  const routeTarget = plan.target
  useEffect(() => {
    if (!terrainProvider || !routeStart || !routeTarget) {
      setRouteField({ status: 'idle' })
      return
    }
    const controller = new AbortController()
    setRouteField({ status: 'loading' })
    // On fine terrain the grid gets finer too, up to 160 cells between start
    // and target, so routes can thread between scarps the terrain shows.
    const length = distance(routeStart, routeTarget)
    const finest = Math.max(9, ...[routeStart, routeTarget, resample([routeStart, routeTarget], 3)[1].point].map((point) => levelAt(terrainProvider, point) ?? 9))
    const along = Math.min(160, Math.max(40, Math.round(length / Math.max(4 * detailMeters(finest), length / 160))))
    const grid = buildGrid(routeStart, routeTarget, along)
    const level = levelForSpacing(grid.cell, finest)
    // Slope probes cost five samples a node. On a dense grid the search
    // already reads slope between nodes, so skip them.
    const probeSlopes = grid.points.length <= 6000
    const night = SAMPLED_RASTERS.find((layer) => layer.id === 'themis-night')
    loadRouteField(grid, {
      elevations: () => sampleElevations(terrainProvider, grid.points, level),
      surface: () => (probeSlopes ? sampleSurface(terrainProvider, grid.points, level) : Promise.resolve([])),
      thermal: () => night ? sampleRaster(night, grid.points) : Promise.resolve(grid.points.map(() => null)),
    }, (result) => {
      const known = result.field.elevation.some((elevation) => elevation !== null)
      setRouteField(known ? { status: 'ready', ...result } : { status: 'error' })
    }, controller.signal).catch(() => {
      if (!controller.signal.aborted) setRouteField({ status: 'error' })
    })
    return () => controller.abort()
  }, [terrainProvider, routeStart, routeTarget, routeAttempt])

  const routePlan = useMemo(
    () => (routeField.status === 'ready' ? routeOptions(routeField.grid, routeField.field, limits, routeField.thermalPending) : null),
    [routeField, limits],
  )
  const options = routePlan?.options ?? []
  // Why every strategy found the same path, shown when they all agree.
  const allSame = options.length > 1 && options.slice(1).every((option) => option.sameAs)
  const sameNote = allSame && !routeField.thermalPending && !routeField.slopesPending ? sameReason(areaStats(routeField.field)) ?? 'All four strategies agree here.' : null
  const chosenId = chosenRoute && chosenRoute.waypoints === plan.waypoints ? chosenRoute.id : null
  onLineRef.current = (hit) => {
    if (hit?.pick) {
      const option = options.find((o) => o.id === hit.id)
      if (option) chooseRoute(option)
      setLineTip(null)
      return
    }
    setLineTip((current) => (current?.id === hit?.id && current?.x === hit?.x ? current : hit))
    setRouteHover((current) => (hit ? hit.id : current === lineTip?.id ? null : current))
  }
  const chooseRoute = (option) => {
    setPlan((current) => ({ ...current, waypoints: option.waypoints }))
    setChosenRoute({ id: option.id, waypoints: option.waypoints })
  }

  useEffect(() => {
    planOverlay.current?.setAlternatives(suit ? [] : options
      .filter((option) => option.id !== chosenId && !option.sameAs)
      .map((option) => ({ id: option.id, points: option.line, color: cssValue(`--color-route-${option.id}`), focus: option.id === routeHover })))
  }, [viewer, options, chosenId, routeHover, suit])

  // Handles and the route line on the map.
  useEffect(() => {
    const vertices = planPath(plan).map((point, i, all) => {
      const kind = i === 0 && plan.start ? 'start' : i === all.length - 1 && plan.target ? 'target' : 'waypoint'
      return { point, kind, label: kind === 'start' ? 'A' : kind === 'target' ? 'B' : String(i) }
    })
    const route = profile.status === 'ready'
      ? profile.samples.map((s) => ({ point: s.point, level: slopeLevel(s.slope, limits.slope) }))
      : null
    planOverlay.current?.set(vertices, route)
  }, [viewer, plan, profile, limits.slope])

  const startAt = (point, startName = null) => {
    setPlan((current) => {
      const far = current.target && distance(current.target, point) > NEW_PLAN_DISTANCE
      // A new start elsewhere drops the route but keeps the planned time.
      return far ? { ...EMPTY_PLAN, when: current.when, start: point, startName } : { ...current, start: point, startName }
    })
    setPlacing((current) => (current === 'start' ? null : current))
  }

  const actions = {
    start: (point) => {
      startAt(point)
      if (!plan.target || distance(plan.target, point) > NEW_PLAN_DISTANCE) setPlacing('target')
    },
    target: (point) => {
      setPlan((current) => ({ ...current, target: point }))
      setPlacing(null)
    },
    waypoint: (point) => setPlan((current) => insertWaypoint(current, point)),
  }

  onMapClickRef.current = ({ siteId, point }) => {
    if (tool && point) return toolClickRef.current?.(point)
    if (placing && point) return actions[placing](point)
    if (siteId) return onSite(siteId)
    setProbe(null)
  }
  onContextRef.current = (opened) => {
    if (!opened) return setProbe(null)
    const placed = opened.markerId ? markers.find((m) => m.id === opened.markerId) : null
    setProbe({ ...opened, point: placed?.point ?? opened.point, markerId: placed?.id ?? null, status: 'loading' })
  }
  const closeProbe = useCallback(() => setProbe(null), [])
  onMoveVertexRef.current = (index, point) => setPlan((current) => moveVertex(current, index, point))

  // A site sets the start: the rover's last position, or the landing point.
  const chooseSite = (id) => {
    const chosen = SITES.find((s) => s.id === id)
    const point = chosen.traverse ? chosen.traverse.position : [chosen.lat, chosen.lon]
    const far = !plan.target || distance(plan.target, point) > NEW_PLAN_DISTANCE
    startAt(point, chosen.traverse ? `${chosen.name} · sol ${chosen.traverse.lastSol}` : chosen.name)
    if (id !== site?.id) onSite(id)
    setFocus({ point })
    setPlacing(far ? 'target' : null)
  }

  useEffect(() => {
    if (!placing) return
    const onKeyDown = (event) => { if (event.key === 'Escape') setPlacing(null) }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [placing])

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
      setProbe((current) => current?.point !== probePoint ? current : {
        ...current,
        detail: detailAt(terrainProvider, probePoint),
        status: surface.elevation === null ? 'error' : 'ready',
        elevation: surface.elevation,
        slope: surface.slope,
        layers: Object.fromEntries(SAMPLED_RASTERS.map((source, i) => [source.id, values[i][0]])),
      })
    }, () => {
      if (!cancelled) setProbe((current) => (current?.point === probePoint ? { ...current, status: 'error' } : current))
    })
    return () => { cancelled = true }
  }, [terrainProvider, probePoint])

  // The geologic unit under the probe, fetched next to the terrain samples.
  useEffect(() => {
    if (!probePoint) return
    const controller = new AbortController()
    fetchUnit(probePoint, controller.signal).then(
      (unit) => setProbe((current) => (current?.point === probePoint ? { ...current, geology: unit ?? 'none' } : current)),
      (error) => {
        if (error.name !== 'AbortError') setProbe((current) => (current?.point === probePoint ? { ...current, geology: 'error' } : current))
      },
    )
    return () => controller.abort()
  }, [probePoint])

  // Rover weather, from the Go server's cached copy of the NASA feeds.
  useEffect(() => {
    const controller = new AbortController()
    const load = () => {
      for (const { id } of STATIONS) {
        fetchWeather(id, controller.signal).then(
          (report) => setWeather((current) => ({ ...current, [id]: report })),
          (error) => {
            if (error.name !== 'AbortError') setWeather((current) => ({ ...current, [id]: current[id] && current[id] !== 'error' ? current[id] : 'error' }))
          },
        )
      }
    }
    load()
    const timer = setInterval(load, WEATHER_REFRESH)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [])

  // CME forecasts for Mars. The server caches an hour, so refetching hourly
  // costs nothing upstream.
  useEffect(() => {
    const controller = new AbortController()
    const load = () => fetchSpaceWeather(controller.signal).then(
      (data) => setSpaceWeather({ status: 'ready', data }),
      (error) => {
        if (error.name !== 'AbortError') setSpaceWeather((current) => (current.data ? { ...current, data: { ...current.data, stale: true } } : { status: 'error', data: null }))
      },
    )
    load()
    const timer = setInterval(load, WEATHER_REFRESH)
    const tick = setInterval(() => setClock(Date.now()), 60_000)
    return () => {
      controller.abort()
      clearInterval(timer)
      clearInterval(tick)
    }
  }, [])

  // Where Trek has fine terrain, outlined on the map with its detail, so a
  // planner can keep the route where slope numbers mean something.
  useEffect(() => {
    if (!viewer || !terrainProvider) return
    const overlay = addToolOverlay(viewer, cssValue('--color-bg'))
    const controller = new AbortController()
    fetch(`${TERRAIN_API_PATH}/layer.json`, { signal: controller.signal }).then((r) => r.json()).then((layer) => {
      const boxes = coverage(layer.available ?? [], FINE_LEVEL)
      const dim = cssValue('--color-text-muted')
      overlay.set({
        lines: boxes.map((box) => ({ points: outline(box), color: dim, dash: [2, 5], width: 1.25 })),
        dots: boxes.map((box) => {
          const center = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]
          const detail = detailAt(terrainProvider, center) ?? detailMeters(FINE_LEVEL)
          return { point: [box[2], box[1]], color: dim, bare: true, label: `${detailLabel(detail)} terrain`, maxHeight: 400_000 }
        }),
      })
    }, () => {})
    return () => {
      controller.abort()
      overlay.destroy()
    }
  }, [viewer, terrainProvider])

  // Station ground elevation, so pressure can be scaled to other heights.
  useEffect(() => {
    if (!terrainProvider) return
    let cancelled = false
    const ids = STATIONS.map((s) => s.id)
    sampleSurface(terrainProvider, ids.map((id) => STATION_POSITIONS[id]), 14).then((samples) => {
      if (!cancelled) setStationElevation(Object.fromEntries(ids.map((id, i) => [id, samples[i].elevation])))
    }, () => {})
    return () => { cancelled = true }
  }, [terrainProvider])

  // Weather near a point: the closest station, its latest reading, and the
  // pressure scaled to `elevation` when both heights are known.
  const weatherNear = (point, elevation) => {
    const near = point && nearestStation(point, STATION_POSITIONS)
    const report = near && weather[near.id]
    if (!near || !report || report === 'error' || !report.latest) return near ? { distance: near.distance, report: report ?? null } : null
    const base = stationElevation[near.id]
    const pa = report.latest.pressurePa
    const estimate = pa != null && base != null && elevation != null ? pressureAt(pa, base, elevation) : null
    return { distance: near.distance, report, estimate }
  }
  const planWeather = weatherNear(plan.start ?? (site ? [site.lat, site.lon] : null), profile.samples?.[0]?.elevation ?? null)
  const highWeather = planWeather?.report?.latest && summary?.high != null ? weatherNear(plan.start, summary.high) : null
  const probeWeather = probe?.status === 'ready' ? weatherNear(probe.point, probe.elevation) : null

  useEffect(() => saveMarkers(markers), [markers])
  useEffect(() => {
    if (viewer) syncMarkers(viewer, markerEntities.current, markers)
  }, [viewer, markers])
  const probeMarker = probe?.markerId ? markers.find((m) => m.id === probe.markerId) ?? null : null

  const probeActions = probePoint ? [
    { label: 'Start here', run: () => actions.start(probePoint) },
    plan.start && { label: 'Target here', run: () => actions.target(probePoint) },
    plan.start && plan.target && { label: 'Add waypoint', run: () => actions.waypoint(probePoint) },
    { group: 'tools', label: 'Measure from here', run: () => { setTool('ruler'); setToolSeed({ tool: 'ruler', point: probePoint }) } },
    { group: 'tools', label: 'Range rings here', run: () => { setTool('range'); setToolSeed({ tool: 'range', point: probePoint }) } },
    { group: 'tools', label: 'Line of sight from here', run: () => { setTool('sight'); setToolSeed({ tool: 'sight', point: probePoint }) } },
  ].filter(Boolean).map((action) => ({ ...action, run: () => { action.run(); setProbe(null) } })) : []

  // One marker: the suit position, else the profile hover, else the probe.
  const suitSample = suit && profile.samples ? profile.samples.reduce((best, s) => (Math.abs(s.d - suit.position) < Math.abs(best.d - suit.position) ? s : best)) : null
  const markerPoint = suitSample?.point ?? (hoverIndex !== null ? profile.samples?.[hoverIndex]?.point : null) ?? probePoint ?? null
  useEffect(() => {
    placeMarker(viewer, marker.current, markerPoint)
  }, [viewer, markerPoint])

  // Changing the route ends the suit view.
  useEffect(() => {
    if (!routePath || profile.status !== 'ready') setSuit(null)
  }, [routePath, profile.status])

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

  const walk = () => {
    setPlacing(null)
    setProbe(null)
    setSuit({ position: 0 })
  }

  const exitSuit = () => {
    setSuit(null)
    if (viewer && routePath) flyToPath(viewer, routePath, profile.samples)
  }

  const dose = RADIATION && {
    site: SITES.find((entry) => entry.id === RADIATION.siteIds[0])?.name ?? '',
    when: RADIATION.epoch.match(/\d{4}/g)?.join('–') ?? '',
    measurement: RADIATION.measurements[0],
  }

  const marks = assessment?.legs.map((leg) => leg.to)
  const nextRelief = RELIEF_STEPS[(RELIEF_STEPS.indexOf(relief) + 1) % RELIEF_STEPS.length]

  return (
    <div className="workspace">
      <PlanPanel
        plan={plan}
        limits={limits}
        assessment={assessment}
        status={profile.status}
        placing={placing}
        dose={dose}
        weather={planWeather && { ...planWeather, atHigh: highWeather?.estimate ?? null }}
        space={{ status: spaceWeather.status, data: spaceWeather.data, check: spaceCheck, start: evaStart, end: evaEnd, now: clock }}
        when={plan.when ?? null}
        onWhen={(when) => setPlan((current) => ({ ...current, when }))}
        terrainDetail={terrainDetail}
        onPlacing={setPlacing}
        onSite={chooseSite}
        onRemoveWaypoint={(index) => setPlan((current) => removeWaypoint(current, index))}
        onLimits={setLimits}
        onRetry={() => setProfileAttempt((attempt) => attempt + 1)}
        onWalk={walk}
        onClear={() => { setPlan(EMPTY_PLAN); setPlacing(null) }}
      />
      <main className={`stage${placing ? ' is-placing' : ''}`}>
        <div ref={container} className="stage__map" />

        <div className={`hud${suit ? ' hud--suit' : ''}${routePath && profileOpen ? ' hud--profile' : ''}`}>
          <span className="hud__corner hud__corner--tl" aria-hidden="true" />
          <span className="hud__corner hud__corner--tr" aria-hidden="true" />
          <span className="hud__corner hud__corner--bl" aria-hidden="true" />
          <span className="hud__corner hud__corner--br" aria-hidden="true" />

          {site && (
            <div className="readout readout--tr">
              <span className="readout__label">Site</span>
              <span className="readout__value">{site.name}</span>
              {planWeather?.report?.latest && (
                <span className="readout__sub" title={`${planWeather.report.rover} ${planWeather.report.instrument}, ${planWeather.report.latest.date}. ${formatDistance(planWeather.distance)} from here.`}>
                  {planWeather.report.instrument} sol {planWeather.report.latest.sol} · {formatTemp(planWeather.report.latest.airMinK)} to {formatTemp(planWeather.report.latest.airMaxK)} · {formatPressure(planWeather.report.latest.pressurePa)}
                </span>
              )}
            </div>
          )}
          <NavControls viewer={viewer}>
            <button
              type="button"
              className="nav__text nav__section"
              onClick={() => setRelief(nextRelief)}
              aria-label={`Elevation scale ${relief}×. Switch to ${nextRelief}×`}
              title={`Elevation scale ${relief}×. Switch to ${nextRelief}×`}
            >
              {relief}×
            </button>
            {routePath && (
              <button type="button" aria-label="Fit route" title="Fit route" onClick={() => viewer && flyToPath(viewer, routePath, profile.samples)}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4M8 16l3-7 5 6" />
                </svg>
              </button>
            )}
            <button
              type="button"
              aria-label="Global view"
              title="Global view"
              onClick={() => (site ? onSite(site.id) : viewer && flyHome(viewer))}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="8" />
                <ellipse cx="12" cy="12" rx="3.5" ry="8" />
                <path d="M4 12h16" />
              </svg>
            </button>
            {routePath && !profileOpen && (
              <button type="button" aria-label="Route profile" title="Route profile" onClick={() => setProfileOpen(true)}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 4v16h16M7 15l4-7 4 5 5-7" />
                </svg>
              </button>
            )}
            <ToolButtons tool={tool} onTool={setTool} />
          </NavControls>

          <MapTools
            viewer={viewer}
            terrainProvider={terrainProvider}
            tool={suit ? null : tool}
            onTool={setTool}
            seed={toolSeed}
            limits={limits}
            planStart={plan.start}
            clickRef={toolClickRef}
            onUseRoute={(points) => {
              setPlan({ start: points[0], startName: null, target: points.at(-1), waypoints: points.slice(1, -1) })
              setTool(null)
            }}
          />

          {routePath && !suit && (
            <RouteOptions
              status={routePlan?.status === 'blocked' ? 'blocked' : routeField.status}
              needs={routePlan?.status === 'blocked' ? routePlan.needs : null}
              thermalPending={routeField.thermalPending}
              onRaise={(slope) => setLimits((current) => ({ ...current, slope }))}
              options={options}
              chosen={chosenId}
              hover={routeHover}
              limit={limits.slope}
              onHover={setRouteHover}
              onChoose={chooseRoute}
              note={sameNote}
              onRetry={() => setRouteAttempt((attempt) => attempt + 1)}
            />
          )}

          {lineTip && (() => {
            const option = options.find((o) => o.id === lineTip.id)
            return option && (
              <div className="route-tip" style={{ left: lineTip.x, top: lineTip.y }} role="tooltip">
                {option.name} · {formatDistance(option.distance)} · {option.maxSlope === null ? '—' : `${option.maxSlope.toFixed(1)}°`}
              </div>
            )
          })()}

          <LayerSwitcher
            layers={SCIENCE_RASTERS}
            overlays={overlays}
            onToggle={(id) => setOverlays((current) => ({ ...current, [id]: { ...current[id], on: !current[id].on } }))}
            onMore={() => setLayersOpen((open) => !open)}
            moreOpen={layersOpen}
          />

          <SciencePanel
            open={layersOpen}
            onOpen={setLayersOpen}
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
            <PointReadout
              probe={probe}
              rasters={SAMPLED_RASTERS}
              observations={OBSERVATIONS}
              limit={limits.slope}
              actions={probeActions}
              weather={probeWeather}
              marker={probeMarker}
              onAddMarker={(symbol) => { setMarkers((current) => addMapMarker(current, symbol, probe.point)); setProbe(null) }}
              onUpdateMarker={(change) => setMarkers((current) => updateMarker(current, probe.markerId, change))}
              onRemoveMarker={() => { setMarkers((current) => removeMarker(current, probe.markerId)); setProbe(null) }}
              onClose={closeProbe}
            />
          )}

          {routePath && profileOpen && !suit && (
            <RouteProfile
              samples={profile.samples}
              summary={summary}
              rasters={PROFILE_RASTERS}
              status={profile.status}
              limit={limits.slope}
              marks={marks}
              routeName="EVA plan"
              hoverIndex={hoverIndex}
              onHover={setHoverIndex}
              onPick={(index) => {
                const point = profile.samples[index].point
                const screen = viewer && screenOf(viewer, point)
                if (screen) setProbe({ point, screen, status: 'loading' })
              }}
              onSuit={walk}
              onClose={() => setProfileOpen(false)}
              onRetry={() => setProfileAttempt((attempt) => attempt + 1)}
            />
          )}

          {suit && profile.samples && (
            <SuitView
              samples={profile.samples}
              routeName="EVA plan"
              position={suit.position}
              onPosition={(position) => setSuit({ position })}
              dose={dose}
              limit={limits.slope}
              marks={marks}
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
    </div>
  )
}
