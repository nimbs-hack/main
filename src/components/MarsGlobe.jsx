import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  DirectionalLight,
  EasingFunction,
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
import { cumulative, distance } from '../data/geo'
import { buildProfile, slopeLevel, summarize } from '../data/route-profile'
import { DEFAULT_LIMITS, EMPTY_PLAN, assess, insertWaypoint, moveVertex, planPath, removeWaypoint } from '../data/plan'
import { addPlanOverlay } from './plan-overlay'
import { STRATEGIES, areaStats, buildGrid, gridSlopes, routeOptions, sameReason } from '../data/route-options'
import RouteOptions from './RouteOptions'
import { formatDistance } from './RouteProfile'
import LayerSwitcher from './LayerSwitcher'
import MapTools, { ToolButtons } from './MapTools'
import { sampleRaster } from '../data/raster-sample'
import { levelFor, sampleSurface } from '../data/terrain-sample'
import SciencePanel from './SciencePanel'
import RouteProfile from './RouteProfile'
import PointReadout from './PointReadout'
import SuitView, { PLAY_TICK_MS } from './SuitView'
import PlanPanel from './PlanPanel'

const MARS = MARS_SPHERE
const ROVERS = SITES.filter((s) => s.traverse)
const OBSERVATIONS = SCIENCE_LAYERS.filter((layer) => layer.kind === 'observation')
// The profile keeps the footing lane that changes along a walk.
const PROFILE_RASTERS = SAMPLED_RASTERS.filter((layer) => layer.id === 'mola-roughness')
const RADIATION = OBSERVATIONS.find((record) => record.category === 'radiation')
// Finer layers draw above coarser ones.
const RANK = ['tes-albedo', 'mola-roughness', 'mola-color', 'themis-day', 'themis-night']
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
// How a mission's points are joined. The four searches are the route
// strategies of the algorithms branch. A straight line is no search at all.
const ROUTE_METHODS = [
  ...STRATEGIES,
  { id: 'direct', name: 'Straight lines', note: 'No search. Legs may cross ground over the slope limit' },
]
const DEFAULT_METHOD = 'fast'
const HOVER_MS = 50
const REROUTE_MS = 200

function loadPlan() {
  try {
    const saved = JSON.parse(localStorage.getItem(PLAN_KEY) ?? 'null')
    if (saved?.plan && Array.isArray(saved.plan.waypoints) && saved.limits) {
      return {
        plan: saved.plan,
        limits: { ...DEFAULT_LIMITS, ...saved.limits },
        strategy: ROUTE_METHODS.some((method) => method.id === saved.strategy) ? saved.strategy : DEFAULT_METHOD,
      }
    }
  } catch {
    // Private mode or bad JSON: start empty.
  }
  return { plan: EMPTY_PLAN, limits: DEFAULT_LIMITS, strategy: DEFAULT_METHOD }
}

// Terrain and night IR on a grid between two points, for the route search.
// Both are read at a level that fits the size of a grid cell, so a leg of
// any length costs about the same number of tiles.
async function sampleRouteField(provider, from, to) {
  const grid = buildGrid(from, to)
  const night = SAMPLED_RASTERS.find((layer) => layer.id === 'themis-night')
  const [surface, thermal] = await Promise.all([
    sampleSurface(provider, grid.points, levelFor(grid.cell)),
    night ? sampleRaster(night, grid.points, undefined, grid.cell) : grid.points.map(() => null),
  ])
  const elevation = surface.map((s) => s.elevation)
  if (!elevation.some((e) => e !== null)) return null
  const coarse = gridSlopes(grid, elevation)
  return { grid, field: { elevation, slope: surface.map((s, i) => s.slope ?? coarse[i]), thermal } }
}

// Opening view looks at Tharsis and Valles Marineris, where the relief is
// easiest to see.
const HOME = { lon: -85, lat: 0, height: 9_000_000 }
const SITE_RANGE = 120_000
const FLY_PITCH = CesiumMath.toRadians(-35)
const RELIEF_STEPS = [1, 3]
// The suit view looks down at the walker from behind at this angle, from at
// least this far.
const WALK_PITCH = CesiumMath.toRadians(-35)
const WALK_RANGE = 900
const WALK_HEADROOM = 1.15

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
  // Coarser tiles while the camera moves, and the rest of what keeps
  // drawing cheap. See src/data/performance.js.
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

// The walker in the suit view: a standing figure, light on a dark outline so
// it shows on any ground. Its feet are on the position.
function walkerMarkerImage() {
  const canvas = document.createElement('canvas')
  canvas.width = 30
  canvas.height = 40
  const context = canvas.getContext('2d')
  context.lineCap = 'round'
  context.lineJoin = 'round'
  const figure = () => {
    context.beginPath()
    context.arc(15, 8, 4.5, 0, Math.PI * 2)
    context.moveTo(15, 13)
    context.lineTo(15, 25)
    context.moveTo(6, 18)
    context.lineTo(24, 18)
    context.moveTo(15, 25)
    context.lineTo(8, 37)
    context.moveTo(15, 25)
    context.lineTo(22, 37)
  }
  figure()
  context.strokeStyle = cssValue('--color-bg')
  context.lineWidth = 8
  context.stroke()
  figure()
  context.strokeStyle = cssValue('--color-accent')
  context.lineWidth = 5
  context.stroke()
  figure()
  context.strokeStyle = cssValue('--color-text')
  context.lineWidth = 2.5
  context.stroke()
  return canvas
}

function addMarker(viewer) {
  const marker = viewer.entities.add({
    show: false,
    position: Cartesian3.ZERO,
    billboard: {
      image: squareMarkerImage(),
      heightReference: HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  })
  marker.looks = { dot: marker.billboard.image, walker: walkerMarkerImage() }
  return marker
}

function placeMarker(viewer, marker, point, walking = false) {
  if (!viewer || !marker) return
  marker.show = Boolean(point)
  marker.billboard.image = walking ? marker.looks.walker : marker.looks.dot
  marker.billboard.verticalOrigin = walking ? VerticalOrigin.BOTTOM : VerticalOrigin.CENTER
  if (point) {
    const location = Cartographic.fromDegrees(point[1], point[0], DATUM_OFFSET)
    location.height = viewer.scene.globe.getHeight(location) ?? exaggerate(viewer.scene, DATUM_OFFSET)
    marker.position = Cartographic.toCartesian(location, MARS)
  }
  viewer.scene.requestRender()
}

// Camera behind the walker, looking along the heading, with the walker in
// the middle of the view. During playback the move takes one playback step
// at an even speed, so steps join into one walk.
//
// The camera aims at the ground under the walker. `elevation` is the sampled
// height there, in meters above the areoid. Without it the aim falls back to
// loaded terrain and then to the datum, which in a crater is kilometers above
// the floor and leaves the walker below the bottom of the screen.
function followWalker(viewer, point, heading, playing, elevation) {
  const location = Cartographic.fromDegrees(point[1], point[0], DATUM_OFFSET)
  location.height = elevation === null || elevation === undefined
    ? viewer.scene.globe.getHeight(location) ?? exaggerate(viewer.scene, DATUM_OFFSET)
    : exaggerate(viewer.scene, elevation + DATUM_OFFSET)
  const target = Cartographic.toCartesian(location, MARS)
  // The camera may not come closer to the ground than the zoom limit, which
  // keeps imagery from being magnified into a blur. Asked to, it is pushed
  // back up after the move and the walker drops off the bottom of the
  // screen. So stand far enough back to be above the limit, with headroom
  // for ground that rises behind the walker.
  const floor = viewer.scene.screenSpaceCameraController.minimumZoomDistance * WALK_HEADROOM
  const range = Math.max(WALK_RANGE, floor / Math.sin(-WALK_PITCH))
  viewer.camera.flyToBoundingSphere(new BoundingSphere(target, 1), {
    offset: new HeadingPitchRange(CesiumMath.toRadians(heading ?? 0), WALK_PITCH, range),
    duration: playing ? PLAY_TICK_MS / 1000 : 0.6,
    easingFunction: playing ? EasingFunction.LINEAR_NONE : undefined,
  })
}

/*
 * `mission` ties the map to the mission being planned. It is optional:
 *   { sites, taskCounts, selected, onSelect(index), onAddSite([lat, lon]),
 *     onAddEva({ target, seconds, distance, maxSlope, verdict }),
 *     route, routeNote, onMovePoint(index, [lat, lon]) }
 * With a mission its points are the route: `route` lists them as [lat, lon]
 * in order, the first is the start and the last the target. It is null when
 * they cannot be routed, and `routeNote` then says why.
 * Sites are { name, lat, lon } in planetocentric latitude and east longitude,
 * -180 to 180. `mission.flag` puts a caution dot on the mission tab.
 * `missionPanel` renders the mission's sites and tasks as a tab of the plan
 * panel and gets { placing, onPlacing } to drive the map from it.
 * While placing is 'site' every click adds a point, until Esc or onPlacing(null).
 */
export default function MarsGlobe({ site, onSite, onStatus, onImagerySource, onScienceSource, onViewer, mission = null, missionPanel = null }) {
  const container = useRef(null)
  const [viewer, setViewer] = useState(null)
  const labels = useRef(null)
  const [relief, setRelief] = useState(RELIEF_STEPS[0])
  // False until the first tiles are on screen. Until then the map is black.
  const [planetShown, setPlanetShown] = useState(false)
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
  const [profile, setProfile] = useState({ status: 'idle', samples: null })
  const [profileAttempt, setProfileAttempt] = useState(0)
  const [profileOpen, setProfileOpen] = useState(true)
  const [hoverIndex, setHoverIndex] = useState(null)
  const [suit, setSuit] = useState(null)
  const [saved] = useState(loadPlan)
  const [plan, setPlan] = useState(saved.plan)
  const [limits, setLimits] = useState(saved.limits)
  // How mission points are joined: one of ROUTE_METHODS.
  const [strategy, setStrategy] = useState(saved.strategy)
  // Terrain grids for each leg of a mission route, for the route search.
  const [legs, setLegs] = useState({ status: 'idle', data: [] })
  const [legAttempt, setLegAttempt] = useState(0)
  const legFields = useRef(new Map())
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
  // Where to fly after the site flight. The map opens on the whole planet,
  // also with a saved plan: Fit route goes to it.
  const [focus, setFocus] = useState(null)
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
  const missionRef = useRef(mission)
  missionRef.current = mission
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
      pending: cssColor('--color-text-muted').toCssColorString(),
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
        setPlanetShown(true)
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
      const picked = free ? viewer.scene.pick(position)?.id : null
      if (picked?.missionIndex !== undefined) return missionRef.current?.onSelect(picked.missionIndex)
      const id = picked?.siteId ?? null
      onMapClickRef.current({ siteId: id, point: id ? null : toLatLon(position) })
    }, ScreenSpaceEventType.LEFT_CLICK)
    // Right click opens the point menu. Right drag still tilts the camera:
    // Cesium only reports a click when the pointer didn't move.
    handler.setInputAction(({ position }) => {
      const point = toLatLon(position)
      if (point) onContextRef.current({ point, screen: { x: position.x, y: position.y } })
    }, ScreenSpaceEventType.RIGHT_CLICK)
    const noMenu = (event) => event.preventDefault()
    viewer.scene.canvas.addEventListener('contextmenu', noMenu)
    // Moving the map leaves the menu pointing at the wrong spot, so close it.
    const removeMoveClose = viewer.camera.moveStart.addEventListener(() => onContextRef.current(null))
    // Hovering picks against the scene, which is a draw and a read back
    // from the GPU. A mouse sends hundreds of moves a second, so only the
    // latest one is looked at, every HOVER_MS.
    let hoverAt = null
    let hoverTimer
    const hover = () => {
      hoverTimer = undefined
      if (drag || viewer.isDestroyed()) return
      const endPosition = hoverAt
      const overHandle = planOverlay.current.handleAt(endPosition) !== null
      const free = !placingRef.current && !toolRef.current
      const line = !overHandle && free ? planOverlay.current.alternativeAt(endPosition) : null
      onLineRef.current(line ? { id: line, x: endPosition.x, y: endPosition.y } : null)
      const under = overHandle || line ? null : viewer.scene.pick(endPosition)?.id
      const id = under?.siteId ?? null
      const overMission = free && under?.missionIndex !== undefined
      setCursor(overHandle ? 'grab' : id || line || overMission ? 'pointer' : placingRef.current || toolRef.current ? 'crosshair' : '')
      if (id === hovered) return
      hovered = id
      viewer.scene.requestRender()
      for (const [siteId, label] of labels.current) label.show = siteId === id || label.pinned === true
    }
    handler.setInputAction(({ endPosition }) => {
      if (drag) {
        const point = toLatLon(endPosition)
        if (point) {
          drag.point = point
          planOverlay.current.drag(drag.index, point)
        }
        return
      }
      hoverAt = Cartesian2.clone(endPosition, hoverAt ?? new Cartesian2())
      hoverTimer ??= setTimeout(hover, HOVER_MS)
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
      clearTimeout(hoverTimer)
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

  // Mission sites: a point and a label with the site's number, name and task
  // count. The selected one is larger and its label starts with a check mark,
  // so it stands out by size and symbol as well as by colour.
  const missionSites = mission?.sites
  const missionCounts = mission?.taskCounts
  const missionSelected = mission?.selected ?? -1
  useEffect(() => {
    if (!viewer || !missionSites) return
    const text = cssColor('--color-text')
    const panel = cssColor('--color-surface')
    const accent = cssColor('--color-accent')
    const added = missionSites.flatMap((entry, index) => {
      if (Number.isNaN(entry.lat + entry.lon)) return []
      const selected = index === missionSelected
      const tasks = missionCounts?.[index] ?? 0
      const entity = viewer.entities.add({
        position: Cartesian3.fromDegrees(entry.lon, entry.lat, 0, MARS),
        point: {
          pixelSize: selected ? 16 : 11,
          color: selected ? accent : text,
          outlineColor: selected ? text : panel,
          outlineWidth: 2,
          heightReference: HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: 0,
        },
        label: {
          text: `${selected ? '✓ ' : ''}${index + 1} ${entry.name || 'Unnamed'} · ${tasks} ${tasks === 1 ? 'task' : 'tasks'}`,
          font: LABEL_FONT,
          fillColor: text,
          style: LabelStyle.FILL,
          showBackground: true,
          backgroundColor: panel,
          backgroundPadding: new Cartesian2(8, 4),
          verticalOrigin: VerticalOrigin.BOTTOM,
          pixelOffset: new Cartesian2(0, -14),
          heightReference: HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: 0,
        },
      })
      entity.missionIndex = index
      return [entity]
    })
    viewer.scene.requestRender()
    return () => {
      if (viewer.isDestroyed()) return
      for (const entity of added) viewer.entities.remove(entity)
    }
  }, [viewer, missionSites, missionCounts, missionSelected])

  // Bring a mission site picked in the list into view. A site already on
  // screen stays where it is, so adding one from the map does not move the map.
  useEffect(() => {
    const target = missionSites?.[missionSelected]
    if (!viewer || !target || Number.isNaN(target.lat + target.lon)) return
    const [ground] = surfacePoints(viewer, [[target.lat, target.lon]])
    const at = viewer.scene.cartesianToCanvasCoordinates(ground)
    const { clientWidth, clientHeight } = viewer.scene.canvas
    if (at && at.x > 0 && at.y > 0 && at.x < clientWidth && at.y < clientHeight) return
    flyToPoint(viewer, [target.lat, target.lon], 40_000)
  }, [viewer, missionSelected])

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
      localStorage.setItem(PLAN_KEY, JSON.stringify({ plan, limits, strategy }))
    } catch {
      // Nothing to do without storage.
    }
  }, [plan, limits, strategy])

  // With a mission, its points are the plan. Picking a suggested route adds
  // waypoints of its own, which last until the points change again.
  const missionRoute = mission ? mission.route : undefined
  useEffect(() => {
    if (missionRoute === undefined) return
    setChosenRoute(null)
    setPlan(missionRoute && missionRoute.length > 0
      ? {
          start: missionRoute[0],
          startName: null,
          target: missionRoute.length > 1 ? missionRoute.at(-1) : null,
          waypoints: missionRoute.slice(1, -1),
        }
      : EMPTY_PLAN)
  }, [missionRoute])
  // True while the plan is exactly the mission's points, so vertex i is point i.
  const followsMission = Boolean(missionRoute) && planPath(plan).length === missionRoute.length &&
    planPath(plan).every((point, i) => point === missionRoute[i])

  // A mission route is searched for leg by leg, unless it is set to straight
  // lines. Each leg gets a terrain grid between its two points. Grids are
  // kept by their end points, so a route that changes at one point samples
  // only the legs that touch it.
  const searching = Boolean(missionRoute) && missionRoute.length > 1 && strategy !== 'direct'
  useEffect(() => {
    if (!terrainProvider || !searching) {
      setLegs({ status: 'idle', data: [] })
      return
    }
    let cancelled = false
    setLegs({ status: 'loading', data: [] })
    const timer = setTimeout(() => {
      const cache = legFields.current
      const pending = missionRoute.slice(1).map((to, i) => {
        const from = missionRoute[i]
        const key = `${from}|${to}`
        if (!cache.has(key)) {
          const field = sampleRouteField(terrainProvider, from, to).catch(() => null)
          cache.set(key, field)
          // A leg that failed is sampled again next time.
          field.then((result) => { if (!result) cache.delete(key) })
          if (cache.size > 32) cache.delete(cache.keys().next().value)
        }
        return cache.get(key)
      })
      Promise.all(pending).then((data) => {
        if (!cancelled) setLegs({ status: 'ready', data })
      })
    }, REROUTE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [terrainProvider, missionRoute, searching, legAttempt])

  const legPlans = useMemo(
    () => (legs.status === 'ready' ? legs.data.map((leg) => (leg ? routeOptions(leg.grid, leg.field, limits) : null)) : null),
    [legs, limits],
  )
  // The route the search found: every mission point, with the turns of each
  // leg's path between them. `stops` are the positions of the mission points
  // in it. A leg with no path under the slope limit, or with no terrain to
  // search, stays a straight line and is listed in `blocked`.
  const searched = useMemo(() => {
    if (!legPlans || !missionRoute || legPlans.length !== missionRoute.length - 1) return null
    const path = [missionRoute[0]]
    const stops = [0]
    const blocked = []
    legPlans.forEach((legPlan, i) => {
      const option = legPlan?.status === 'ok' ? legPlan.options.find((o) => o.id === strategy) ?? legPlan.options[0] : null
      if (option) path.push(...option.waypoints)
      else blocked.push({ leg: i + 1, needs: legPlan?.status === 'blocked' ? legPlan.needs : null, failed: !legPlan })
      path.push(missionRoute[i + 1])
      stops.push(path.length - 1)
    })
    return { path, stops, blocked }
  }, [legPlans, missionRoute, strategy])

  // Route from start through waypoints to target, once both ends exist. While
  // a mission route is being searched for there is none yet, and the map
  // shows grey lines between the points.
  const routePath = useMemo(() => {
    if (searching) return searched?.path ?? null
    const path = planPath(plan)
    return plan.start && plan.target ? path : null
  }, [plan, searching, searched])
  const routing = (searching && legs.status === 'loading') || (Boolean(routePath) && profile.status === 'loading')

  const sampledOnce = useRef(false)
  // Samples every layer, not only the visible ones, so the profile strip
  // always shows the full stack. Long routes sample coarser terrain tiles.
  useEffect(() => {
    setHoverIndex(null)
    if (!terrainProvider || !routePath) {
      setProfile({ status: routePath ? 'loading' : 'idle', samples: null })
      return
    }
    let cancelled = false
    const length = cumulative(routePath).at(-1)
    setProfile({ status: 'loading', samples: null })
    // A coordinate being typed changes the route on every key. The grey legs
    // follow at once. Terrain is sampled when the route has settled.
    const timer = setTimeout(() => buildProfile(routePath, {
      provider: terrainProvider,
      rasters: SAMPLED_RASTERS,
      count: 200,
      level: length > 20_000 ? Math.min(12, levelFor(length / 200)) : 15,
    }).then((samples) => {
      if (cancelled) return
      const known = samples.some((s) => s.elevation !== null)
      setProfile({ status: known ? 'ready' : 'error', samples })
    }, () => {
      if (!cancelled) setProfile({ status: 'error', samples: null })
    }), sampledOnce.current ? REROUTE_MS : 0)
    sampledOnce.current = true
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [terrainProvider, routePath, profileAttempt])

  useEffect(() => {
    if (routePath) setProfileOpen(true)
  }, [routePath])

  const summary = useMemo(() => (profile.samples ? summarize(profile.samples) : null), [profile.samples])
  const doseRate = RADIATION?.measurements[0]?.unit === 'Sv/day' ? RADIATION.measurements[0].value : null
  const assessment = useMemo(() => {
    if (profile.status !== 'ready' || !routePath) return null
    const found = searching && searched?.path === routePath ? searched : null
    const result = assess(profile.samples, routePath, limits, doseRate, found?.stops)
    if (!found?.blocked.length) return result
    // A leg the search could not join is drawn straight. Say so first.
    const reasons = found.blocked.map((leg) => ({
      level: 'no-go',
      text: leg.failed
        ? `Leg ${leg.leg}: no terrain to search`
        : `Leg ${leg.leg}: no route under ${limits.slope}°${leg.needs === null ? '' : `, ${leg.needs}° would work`}`,
    }))
    return { ...result, verdict: 'no-go', reasons: [...reasons, ...result.reasons] }
  }, [profile, routePath, limits, doseRate, searching, searched])

  // Sample the grid once per start and target. Limits only rerun the search.
  const routeStart = plan.start
  const routeTarget = plan.target
  // With a mission the legs above do the search. This grid serves the plan
  // made by hand, from a start to a target.
  const offerOptions = !mission
  useEffect(() => {
    if (!terrainProvider || !routeStart || !routeTarget || !offerOptions) {
      setRouteField({ status: 'idle' })
      return
    }
    let cancelled = false
    setRouteField({ status: 'loading' })
    // Like the profile, the grid waits until the two ends have settled.
    const timer = setTimeout(() => sampleRouteField(terrainProvider, routeStart, routeTarget).then((sampled) => {
      if (!cancelled) setRouteField(sampled ? { status: 'ready', ...sampled } : { status: 'error' })
    }, () => {
      if (!cancelled) setRouteField({ status: 'error' })
    }), REROUTE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [terrainProvider, routeStart, routeTarget, routeAttempt, offerOptions])

  const routePlan = useMemo(
    () => (routeField.status === 'ready' ? routeOptions(routeField.grid, routeField.field, limits) : null),
    [routeField, limits],
  )
  // The alternatives to compare: those of the hand-made plan, or of a
  // mission route with a single leg. A route with stops has one path per leg
  // and no list.
  const oneLeg = searching && missionRoute.length === 2
  const optionPlan = mission ? (oneLeg ? legPlans?.[0] ?? null : null) : routePlan
  const optionField = mission ? legs.data[0]?.field : routeField.field
  const options = optionPlan?.status === 'ok' ? optionPlan.options : []
  // Why every strategy found the same path, shown when they all agree.
  const allSame = options.length > 1 && options.slice(1).every((option) => option.sameAs)
  const sameNote = allSame && optionField ? sameReason(areaStats(optionField)) ?? 'All four strategies agree here.' : null
  const chosenId = mission
    ? options.find((option) => option.id === strategy)?.id ?? options[0]?.id ?? null
    : chosenRoute && chosenRoute.waypoints === plan.waypoints ? chosenRoute.id : null
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
  // For a mission, picking a route picks the method that found it.
  const chooseRoute = (option) => {
    if (mission) return setStrategy(option.id)
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
      // Mission points keep the numbers they have in the list.
      return { point, kind, label: followsMission ? String(i + 1) : kind === 'start' ? 'A' : kind === 'target' ? 'B' : String(i) }
    })
    const route = profile.status === 'ready'
      ? profile.samples.map((s) => ({ point: s.point, level: slopeLevel(s.slope, limits.slope) }))
      : null
    planOverlay.current?.set(vertices, route)
  }, [viewer, plan, profile, limits.slope, followsMission])

  const startAt = (point, startName = null) => {
    setPlan((current) => {
      const far = current.target && distance(current.target, point) > NEW_PLAN_DISTANCE
      return far ? { ...EMPTY_PLAN, start: point, startName } : { ...current, start: point, startName }
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
    // Stays on, so several points can be added in a row.
    site: (point) => mission?.onAddSite(point),
  }

  onMapClickRef.current = ({ siteId, point }) => {
    if (tool && point) return toolClickRef.current?.(point)
    if (placing && point) return actions[placing](point)
    if (siteId) return onSite(siteId)
    setProbe(null)
  }
  onContextRef.current = (opened) => setProbe(opened ? { ...opened, status: 'loading' } : null)
  const closeProbe = useCallback(() => setProbe(null), [])
  // Dragging a mission point moves the point in the mission, and the plan follows.
  onMoveVertexRef.current = (index, point) => (followsMission
    ? mission.onMovePoint(index, point)
    : setPlan((current) => moveVertex(current, index, point)))

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

  const probeActions = probePoint ? [
    !mission && { label: 'Start here', run: () => actions.start(probePoint) },
    !mission && plan.start && { label: 'Target here', run: () => actions.target(probePoint) },
    !mission && plan.start && plan.target && { label: 'Add waypoint', run: () => actions.waypoint(probePoint) },
    mission && { label: 'Add mission point here', run: () => mission.onAddSite(probePoint) },
    { group: 'tools', label: 'Measure from here', run: () => { setTool('ruler'); setToolSeed({ tool: 'ruler', point: probePoint }) } },
    { group: 'tools', label: 'Range rings here', run: () => { setTool('range'); setToolSeed({ tool: 'range', point: probePoint }) } },
    { group: 'tools', label: 'Line of sight from here', run: () => { setTool('sight'); setToolSeed({ tool: 'sight', point: probePoint }) } },
  ].filter(Boolean).map((action) => ({ ...action, run: () => { action.run(); setProbe(null) } })) : []

  // One marker: the suit position, else the profile hover, else the probe.
  const suitSample = suit && profile.samples ? profile.samples.reduce((best, s) => (Math.abs(s.d - suit.position) < Math.abs(best.d - suit.position) ? s : best)) : null
  const markerPoint = suitSample?.point ?? (hoverIndex !== null ? profile.samples?.[hoverIndex]?.point : null) ?? probePoint ?? null
  const walking = Boolean(suitSample)
  useEffect(() => {
    placeMarker(viewer, marker.current, markerPoint, walking)
  }, [viewer, markerPoint, walking])

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
    followWalker(viewer, here.point, heading, suit?.playing, here.elevation)
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
        status={routing ? 'loading' : profile.status}
        placing={placing}
        dose={dose}
        onPlacing={setPlacing}
        onSite={chooseSite}
        onRemoveWaypoint={(index) => setPlan((current) => removeWaypoint(current, index))}
        onLimits={setLimits}
        onRetry={() => setProfileAttempt((attempt) => attempt + 1)}
        onWalk={walk}
        onClear={() => { setPlan(EMPTY_PLAN); setPlacing(null) }}
        onAddToMission={!mission ? undefined : assessment && plan.target ? () => mission.onAddEva({
          target: plan.target,
          seconds: assessment.total,
          distance: assessment.distance,
          maxSlope: assessment.maxSlope,
          verdict: assessment.verdict,
        }) : null}
        missionSites={missionPanel?.({ placing, onPlacing: setPlacing })}
        routeNote={mission?.routeNote ?? null}
        methods={mission ? ROUTE_METHODS : undefined}
        method={strategy}
        onMethod={setStrategy}
        missionFlag={mission?.flag ?? null}
        missionFocus={missionSelected}
      />
      <main className={`stage${placing ? ' is-placing' : ''}`}>
        <div ref={container} className="stage__map" />

        <div className={`hud${suit ? ' hud--suit' : ''}${routePath && profileOpen ? ' hud--profile' : ''}`}>
          <span className="hud__corner hud__corner--tl" aria-hidden="true" />
          <span className="hud__corner hud__corner--tr" aria-hidden="true" />
          <span className="hud__corner hud__corner--bl" aria-hidden="true" />
          <span className="hud__corner hud__corner--br" aria-hidden="true" />

          {!planetShown && (
            <p className="stage__loading" role="status">
              <span className="spinner spinner--large" aria-hidden="true" />
              Loading Mars
            </p>
          )}
          {routing && (
            <p className="stage__routing" role="status">
              <span className="spinner" aria-hidden="true" />
              Routing {planPath(plan).length} points
            </p>
          )}

          {site && (
            <div className="readout readout--tr">
              <span className="readout__label">Site</span>
              <span className="readout__value">{site.name}</span>
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

          {!suit && (mission ? oneLeg : routePath) && (
            <RouteOptions
              status={optionPlan?.status === 'blocked' ? 'blocked' : mission ? (legs.status === 'ready' && !optionPlan ? 'error' : legs.status) : routeField.status}
              needs={optionPlan?.status === 'blocked' ? optionPlan.needs : null}
              onRaise={(slope) => setLimits((current) => ({ ...current, slope }))}
              options={options}
              chosen={chosenId}
              hover={routeHover}
              limit={limits.slope}
              onHover={setRouteHover}
              onChoose={chooseRoute}
              note={sameNote}
              onRetry={() => (mission ? setLegAttempt((attempt) => attempt + 1) : setRouteAttempt((attempt) => attempt + 1))}
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
              onPosition={(position, playing = false) => setSuit({ position, playing })}
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
