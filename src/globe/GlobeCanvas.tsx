import { type Dispatch, useEffect, useRef, useState } from 'react'
import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  DirectionalLight,
  DistanceDisplayCondition,
  type Entity,
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
import type { Site } from '../api'
import NavControls from '../components/NavControls.jsx'
import { pickGround, setupControls } from '../components/camera.js'
import { LOCAL_MAX_ZOOM, MAX_NATIVE_ZOOM, localTilePath, remoteTileUrl } from '../data/basemap.js'
import { addCtxLayer } from '../data/ctx-layer.ts'
import { DATUM_OFFSET, MARS_SPHERE, createTerrain } from '../data/terrain.js'
import { FAST_VIEWER_OPTIONS, tuneViewer } from '../data/performance.js'
import { formatAltitude, formatElevation, formatLatLon } from '../format.js'

export type MapStatusEvent =
  | { type: 'reset' }
  | { type: 'progress'; queued: number }
  | { type: 'terrain-ready' }
  | { type: 'failure'; source: 'Viking imagery' | 'CTX imagery' | 'Terrain' | '3D viewer' }

// Opening view when the mission has no sites yet: Tharsis and Valles
// Marineris, where the relief is easiest to see.
const HOME = { lon: -85, lat: 0, height: 9_000_000 }
const FLY_PITCH = CesiumMath.toRadians(-35)
// Closest the camera frames a single site, in metres.
const SITE_RANGE = 40_000
const RELIEF_STEPS = [1, 3]
const LIGHT_ELEVATION = CesiumMath.toRadians(35)
const LABEL_FONT = '500 11px "JetBrains Mono Variable", ui-monospace, monospace'
// From farther than this the labels of neighbouring sites pile up, so only
// the points and the selected site's label stay.
const LABELS_WITHIN = 2_000_000

function cssColor(name: string): Color {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return Color.fromCssColorString(value)
}

function unexaggerate(viewer: Viewer, height: number): number {
  const base = viewer.scene.verticalExaggerationRelativeHeight
  return (height - base) / viewer.scene.verticalExaggeration + base
}

// Ground position for a latitude and longitude, using terrain that is
// already loaded. Sites are planetocentric, east-positive, like the tiles.
function surfacePoint(viewer: Viewer, lat: number, lon: number): Cartesian3 {
  const point = Cartographic.fromDegrees(lon, lat, DATUM_OFFSET)
  point.height = viewer.scene.globe.getHeight(point) ?? DATUM_OFFSET
  return Cartographic.toCartesian(point, MARS_SPHERE)
}

function toLatLon(position: Cartesian3): { lat: number; lon: number } {
  const c = MARS_SPHERE.cartesianToCartographic(position)
  return { lat: CesiumMath.toDegrees(c.latitude), lon: CesiumMath.toDegrees(c.longitude) }
}

// Light from the top left of the screen, low over the horizon: the
// convention for shaded relief.
const scratch = { up: new Cartesian3(), forward: new Cartesian3(), right: new Cartesian3(), tmp: new Cartesian3() }
function aimLight(viewer: Viewer): void {
  const { scene } = viewer
  const { up, forward, right, tmp } = scratch
  MARS_SPHERE.geodeticSurfaceNormal(scene.camera.positionWC, up)
  const flatten = (v: Cartesian3) =>
    Cartesian3.subtract(v, Cartesian3.multiplyByScalar(up, Cartesian3.dot(v, up), tmp), forward)
  flatten(scene.camera.directionWC)
  if (Cartesian3.magnitude(forward) < 0.2) flatten(scene.camera.upWC)
  Cartesian3.normalize(forward, forward)
  Cartesian3.cross(forward, up, right)
  const toLight = Cartesian3.subtract(forward, right, tmp)
  Cartesian3.normalize(toLight, toLight)
  Cartesian3.multiplyByScalar(toLight, Math.cos(LIGHT_ELEVATION), toLight)
  Cartesian3.add(toLight, Cartesian3.multiplyByScalar(up, Math.sin(LIGHT_ELEVATION), right), toLight)
  const light = scene.light as DirectionalLight
  Cartesian3.negate(toLight, light.direction)
  Cartesian3.normalize(light.direction, light.direction)
}

// Viewer setup: Mars sphere, Trek terrain, Viking basemap with CTX on top.
function createViewer(container: HTMLElement, ctx: Parameters<typeof addCtxLayer>[1]) {
  const terrain = createTerrain()
  const imagery = new UrlTemplateImageryProvider({
    url: remoteTileUrl('{z}', '{y}', '{x}'),
    tilingScheme: new GeographicTilingScheme({ ellipsoid: MARS_SPHERE }),
    maximumLevel: MAX_NATIVE_ZOOM,
  })
  // Low zoom levels ship in public/tiles. Cesium URL-encodes template values,
  // so the local paths are swapped in here instead.
  const requestRemote = imagery.requestImage.bind(imagery)
  imagery.requestImage = ((x, y, level, request) =>
    level <= LOCAL_MAX_ZOOM
      ? ImageryProvider.loadImage(imagery, import.meta.env.BASE_URL + localTilePath(level, y, x))
      : requestRemote(x, y, level, request)) as typeof imagery.requestImage

  const viewer = new Viewer(container, {
    ellipsoid: MARS_SPHERE,
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
  const stopCtx = addCtxLayer(viewer, ctx)

  const { scene } = viewer
  scene.backgroundColor = cssColor('--color-bg')
  scene.globe.showGroundAtmosphere = false
  scene.globe.baseColor = cssColor('--color-surface')
  scene.globe.enableLighting = true
  // Let terrain hide markers on slopes and on the far side of Mars.
  scene.globe.depthTestAgainstTerrain = true
  // Coarser tiles while the camera moves, and the rest of what keeps
  // drawing cheap.
  const stopTuning = tuneViewer(viewer)
  scene.globe.dynamicAtmosphereLighting = false
  scene.light = new DirectionalLight({ direction: new Cartesian3(0, 0, -1), intensity: 2 })
  const removeLight = scene.preUpdate.addEventListener(() => aimLight(viewer))
  // Scale elevation around the areoid, not around Trek's shifted zero.
  scene.verticalExaggerationRelativeHeight = DATUM_OFFSET
  viewer.camera.percentageChanged = 0.01
  const stopControls = setupControls(viewer)
  viewer.camera.setView({ destination: Cartesian3.fromDegrees(HOME.lon, HOME.lat, HOME.height, MARS_SPHERE) })

  return { viewer, imagery, terrain, stop: () => (stopCtx(), stopTuning(), removeLight(), stopControls()) }
}

function frameSites(viewer: Viewer, sites: Site[]): void {
  if (sites.length === 0) {
    viewer.camera.flyTo({ destination: Cartesian3.fromDegrees(HOME.lon, HOME.lat, HOME.height, MARS_SPHERE) })
    return
  }
  const sphere = BoundingSphere.fromPoints(sites.map((site) => surfacePoint(viewer, site.lat, site.lon)))
  viewer.camera.flyToBoundingSphere(sphere, {
    offset: new HeadingPitchRange(0, FLY_PITCH, Math.max(sphere.radius * 3, SITE_RANGE)),
  })
}

// The whole planet, turned to face the mission's sites.
function showPlanet(viewer: Viewer, sites: Site[], fly: boolean): void {
  const first = sites[0]
  const destination = Cartesian3.fromDegrees(first?.lon ?? HOME.lon, first?.lat ?? HOME.lat, HOME.height, MARS_SPHERE)
  if (fly) viewer.camera.flyTo({ destination })
  else viewer.camera.setView({ destination })
}

interface Cursor {
  lat: number
  lon: number
  // Metres above the MOLA areoid, or null where terrain has not loaded.
  elevation: number | null
}

// Own component so pointer movement re-renders only this readout.
function CursorReadout({ viewer }: { viewer: Viewer | null }) {
  const [cursor, setCursor] = useState<Cursor | null>(null)

  useEffect(() => {
    if (!viewer) return
    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas)
    handler.setInputAction(({ endPosition }: { endPosition: Cartesian2 }) => {
      const hit = pickGround(viewer, endPosition)
      if (!hit) return setCursor(null)
      const c = MARS_SPHERE.cartesianToCartographic(hit)
      // pickGround can fall back to the bare sphere. Never label that as elevation.
      const terrainHeight = viewer.scene.globe.getHeight(c)
      setCursor({
        ...toLatLon(hit),
        elevation: terrainHeight === undefined ? null : unexaggerate(viewer, terrainHeight) - DATUM_OFFSET,
      })
    }, ScreenSpaceEventType.MOUSE_MOVE)
    return () => handler.destroy()
  }, [viewer])

  return (
    <div className="readout readout--tl">
      <span className="readout__label">Cursor</span>
      <span className="readout__value">
        {cursor ? formatLatLon(cursor.lat, cursor.lon) : '—'}
        {cursor && (
          <span className="readout__sub">
            {cursor.elevation === null
              ? 'Elevation unavailable'
              : `${formatElevation(cursor.elevation)} · MOLA areoid`}
          </span>
        )}
      </span>
    </div>
  )
}

function AltitudeReadout({ viewer }: { viewer: Viewer | null }) {
  const [height, setHeight] = useState<number | null>(null)

  useEffect(() => {
    if (!viewer) return
    const update = () => {
      const camera = viewer.camera.positionCartographic
      // scene.globeHeight is the value Cesium uses for terrain collisions. It is
      // not in the type definitions.
      const ground =
        (viewer.scene as unknown as { globeHeight?: number }).globeHeight ?? viewer.scene.globe.getHeight(camera)
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

type SiteEntity = Entity & { siteIndex?: number }

export function GlobeCanvas({
  sites,
  taskCounts,
  selected,
  editable,
  placing,
  onPlace,
  onSelect,
  onMove,
  onStatus,
  onImagerySource,
  retryKey,
}: {
  sites: Site[]
  // Tasks at each site, by position.
  taskCounts: number[]
  selected: number
  // Site markers can be dragged.
  editable: boolean
  // The next click on the ground places a site.
  placing: boolean
  onPlace: (lat: number, lon: number) => void
  onSelect: (index: number) => void
  onMove: (index: number, lat: number, lon: number) => void
  onStatus: Dispatch<MapStatusEvent>
  onImagerySource: (source: 'V01' | 'beta01') => void
  // Changing this rebuilds the viewer, for a retry after a failure.
  retryKey: number
}) {
  const container = useRef<HTMLDivElement>(null)
  const [viewer, setViewer] = useState<Viewer | null>(null)
  const [relief, setRelief] = useState(RELIEF_STEPS[0]!)
  // False until the first tiles are on screen. Until then the globe is black.
  const [planetShown, setPlanetShown] = useState(false)

  // Handlers registered once read the latest props through this ref.
  const live = useRef({ sites, editable, placing, onPlace, onSelect, onMove, onStatus, onImagerySource })
  live.current = { sites, editable, placing, onPlace, onSelect, onMove, onStatus, onImagerySource }

  useEffect(() => {
    live.current.onStatus({ type: 'reset' })
    setPlanetShown(false)
    const failed = (source: Extract<MapStatusEvent, { type: 'failure' }>['source']) =>
      live.current.onStatus({ type: 'failure', source })
    let resources: ReturnType<typeof createViewer>
    try {
      resources = createViewer(container.current!, {
        onSource: (source) => live.current.onImagerySource(source),
        onError: () => failed('CTX imagery'),
      })
    } catch {
      failed('3D viewer')
      return
    }
    const { viewer, imagery, terrain, stop } = resources
    const { scene } = viewer

    const removers = [
      imagery.errorEvent.addEventListener(() => failed('Viking imagery')),
      terrain.errorEvent.addEventListener(() => failed('Terrain')),
      scene.globe.tileLoadProgressEvent.addEventListener((queued: number) => {
        live.current.onStatus({ type: 'progress', queued })
        if (queued === 0) setPlanetShown(true)
      }),
    ]
    const terrainReady = () => live.current.onStatus({ type: 'terrain-ready' })
    removers.push(terrain.readyEvent.addEventListener(terrainReady))
    if (terrain.ready) terrainReady()

    const handler = new ScreenSpaceEventHandler(scene.canvas)
    const siteAt = (position: Cartesian2): number | undefined =>
      (scene.pick(position)?.id as SiteEntity | undefined)?.siteIndex
    let dragging: { index: number; entity: SiteEntity; moved: boolean } | null = null

    handler.setInputAction(({ position }: { position: Cartesian2 }) => {
      const index = siteAt(position)
      if (index !== undefined) return live.current.onSelect(index)
      if (!live.current.placing) return
      const ground = pickGround(viewer, position)
      if (!ground) return
      const { lat, lon } = toLatLon(ground)
      live.current.onPlace(lat, lon)
    }, ScreenSpaceEventType.LEFT_CLICK)

    // Dragging a marker moves the site. The camera is held still meanwhile.
    handler.setInputAction(({ position }: { position: Cartesian2 }) => {
      const index = siteAt(position)
      if (index === undefined || !live.current.editable) return
      const entity = viewer.entities.values.find((e) => (e as SiteEntity).siteIndex === index)
      if (!entity) return
      dragging = { index, entity, moved: false }
      scene.screenSpaceCameraController.enableInputs = false
    }, ScreenSpaceEventType.LEFT_DOWN)

    handler.setInputAction(({ endPosition }: { endPosition: Cartesian2 }) => {
      if (dragging) {
        const ground = pickGround(viewer, endPosition)
        if (!ground) return
        const { lat, lon } = toLatLon(ground)
        dragging.entity.position = Cartesian3.fromDegrees(lon, lat, 0, MARS_SPHERE) as never
        dragging.moved = true
        scene.requestRender()
        return
      }
      const over = siteAt(endPosition) !== undefined
      ;(viewer.container as HTMLElement).style.cursor = over ? (live.current.editable ? 'grab' : 'pointer') : ''
    }, ScreenSpaceEventType.MOUSE_MOVE)

    handler.setInputAction(({ position }: { position: Cartesian2 }) => {
      if (!dragging) return
      const { index, moved } = dragging
      dragging = null
      scene.screenSpaceCameraController.enableInputs = true
      if (!moved) return
      const ground = pickGround(viewer, position)
      if (ground) {
        const { lat, lon } = toLatLon(ground)
        live.current.onMove(index, lat, lon)
      }
    }, ScreenSpaceEventType.LEFT_UP)

    // Lets the browser console and the scenario scripts reach the scene.
    if (import.meta.env.DEV) (window as unknown as { viewer: Viewer }).viewer = viewer

    setViewer(viewer)
    // Start on the planet, with the mission's sites facing the camera.
    showPlanet(
      viewer,
      live.current.sites.filter((site) => !Number.isNaN(site.lat + site.lon)),
      false,
    )

    return () => {
      for (const remove of removers) remove()
      stop()
      handler.destroy()
      viewer.destroy()
      setViewer(null)
    }
  }, [retryKey])

  // Markers: a square point and a label with the site's number, name and task
  // count. The selected one is larger and its label starts with a check mark,
  // so it stands out by size and symbol as well as by colour.
  useEffect(() => {
    if (!viewer) return
    const text = cssColor('--color-text')
    const panel = cssColor('--color-surface')
    const accent = cssColor('--color-accent')
    const added = sites.flatMap((site, index) => {
      if (Number.isNaN(site.lat + site.lon)) return []
      const isSelected = index === selected
      const tasks = taskCounts[index] ?? 0
      const entity: SiteEntity = viewer.entities.add({
        position: Cartesian3.fromDegrees(site.lon, site.lat, 0, MARS_SPHERE),
        point: {
          pixelSize: isSelected ? 16 : 11,
          color: isSelected ? accent : text,
          outlineColor: isSelected ? text : panel,
          outlineWidth: 2,
          heightReference: HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: 0,
        },
        label: {
          text: `${isSelected ? '✓ ' : ''}${index + 1} ${site.name} · ${tasks} ${tasks === 1 ? 'task' : 'tasks'}`,
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
          distanceDisplayCondition: isSelected ? undefined : new DistanceDisplayCondition(0, LABELS_WITHIN),
        },
      })
      entity.siteIndex = index
      return [entity]
    })
    viewer.scene.requestRender()
    return () => {
      if (viewer.isDestroyed()) return
      for (const entity of added) viewer.entities.remove(entity)
    }
  }, [viewer, sites, taskCounts, selected])

  // Bring a site picked in the list into view. Keyed on which site is
  // selected, so editing its coordinates does not move the camera. A site
  // that was already selected when the globe opened does not count: the
  // globe opens on the whole planet.
  const target = sites[selected]
  const opened = useRef<{ viewer: Viewer; selected: number } | null>(null)
  useEffect(() => {
    if (!viewer) return
    if (opened.current?.viewer !== viewer) {
      opened.current = { viewer, selected }
      return
    }
    if (opened.current.selected === selected) return
    opened.current.selected = selected
    if (!target || Number.isNaN(target.lat + target.lon)) return
    const point = surfacePoint(viewer, target.lat, target.lon)
    const onScreen = viewer.scene.cartesianToCanvasCoordinates(point)
    const { clientWidth, clientHeight } = viewer.scene.canvas
    const visible =
      onScreen && onScreen.x > 80 && onScreen.y > 80 && onScreen.x < clientWidth - 80 && onScreen.y < clientHeight - 80
    const near = Cartesian3.distance(viewer.camera.positionWC, point) < SITE_RANGE * 12
    if (visible && near) return
    viewer.camera.flyToBoundingSphere(new BoundingSphere(point, 1), {
      offset: new HeadingPitchRange(0, FLY_PITCH, SITE_RANGE),
    })
  }, [viewer, selected])

  useEffect(() => {
    if (!viewer) return
    viewer.scene.verticalExaggeration = relief
    viewer.scene.requestRender()
  }, [viewer, relief])

  const nextRelief = RELIEF_STEPS[(RELIEF_STEPS.indexOf(relief) + 1) % RELIEF_STEPS.length]!
  const drawable = sites.filter((site) => !Number.isNaN(site.lat + site.lon))
  const site = sites[selected]

  return (
    <main className={`stage${placing ? ' is-placing' : ''}`}>
      <div ref={container} className="stage__map" />

      <div className="hud">
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
        <CursorReadout viewer={viewer} />
        <div className="readout readout--tr">
          <span className="readout__label">Selected site</span>
          <span className="readout__value">{site ? site.name || 'Unnamed' : 'None selected'}</span>
          {site && <span className="readout__sub">Terrain safety not assessed</span>}
        </div>
        <AltitudeReadout viewer={viewer} />
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
          <button
            type="button"
            disabled={drawable.length === 0}
            aria-label="All sites"
            title="All sites"
            onClick={() => viewer && frameSites(viewer, drawable)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4M9 10h.01M15 9h.01M12 15h.01" />
            </svg>
          </button>
          <button type="button" aria-label="Whole planet" title="Whole planet" onClick={() => viewer && showPlanet(viewer, drawable, true)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="8" />
              <ellipse cx="12" cy="12" rx="3.5" ry="8" />
              <path d="M4 12h16" />
            </svg>
          </button>
        </NavControls>

      </div>
    </main>
  )
}
