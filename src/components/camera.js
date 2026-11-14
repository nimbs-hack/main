// Camera controls modeled on Google Earth:
//   drag                      pan
//   right drag, ctrl/shift drag, middle drag, two-finger drag   tilt and turn
//   scroll, pinch             zoom toward the cursor
//   double click              fly halfway to that spot
// plus helpers for the on-screen compass, tilt and zoom buttons.
import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  CameraEventType,
  HeadingPitchRange,
  KeyboardEventModifier,
  Math as CesiumMath,
  ScreenSpaceEventType,
} from 'cesium'
import { CTX_METERS_PER_PIXEL } from '../data/ctx'

// Highest terrain in Trek's heights (Olympus Mons, about 29.4 km above the
// sphere), with headroom. Cesium only checks for terrain collisions below
// this height. Its default for a Mars-sized body is 8.5 km, which let the
// camera sink into anything taller.
const COLLISION_CEILING = 45_000
// Below this height Cesium pivots on the terrain instead of the bare sphere.
const TERRAIN_PICK_CEILING = 200_000
// Limit magnification to two screen pixels per source pixel. At 100 m above
// the surface, CTX would fill the viewport with only a few dozen pixels.
export function imageryZoomLimit(viewportHeight, verticalFov) {
  return Math.max(40, CTX_METERS_PER_PIXEL * viewportHeight / (4 * Math.tan(verticalFov / 2)))
}
// Steepest tilt, measured from straight down. 90° would be the horizon.
const MAX_TILT = CesiumMath.toRadians(80)
const TOP_DOWN = CesiumMath.toRadians(-90)
const TILTED = CesiumMath.toRadians(-40)
const FLAT_ENOUGH = CesiumMath.toRadians(-80)

const MOVE_SECONDS = 0.5

export function setupControls(viewer) {
  const { scene } = viewer
  const controls = scene.screenSpaceCameraController
  controls.minimumCollisionTerrainHeight = COLLISION_CEILING
  controls.minimumPickingTerrainHeight = TERRAIN_PICK_CEILING
  const updateZoomLimit = () => {
    controls.minimumZoomDistance = imageryZoomLimit(scene.canvas.clientHeight, viewer.camera.frustum.fovy)
  }
  updateZoomLimit()
  const resizeObserver = new ResizeObserver(updateZoomLimit)
  resizeObserver.observe(scene.canvas)
  controls.maximumZoomDistance = scene.ellipsoid.maximumRadius * 4
  controls.maximumTiltAngle = MAX_TILT
  // Free look turns the camera in place and loses the ground. Google's
  // tools don't have it, and it's how people end up staring at the sky.
  controls.enableLook = false
  controls.zoomEventTypes = [CameraEventType.WHEEL, CameraEventType.PINCH]
  controls.tiltEventTypes = [
    CameraEventType.RIGHT_DRAG,
    CameraEventType.MIDDLE_DRAG,
    CameraEventType.PINCH,
    { eventType: CameraEventType.LEFT_DRAG, modifier: KeyboardEventModifier.CTRL },
    { eventType: CameraEventType.LEFT_DRAG, modifier: KeyboardEventModifier.SHIFT },
  ]

  // Replace the viewer's double click (track an entity) with fly-in.
  const handler = viewer.screenSpaceEventHandler
  handler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK)
  handler.setInputAction(({ position }) => {
    const target = pickGround(viewer, position)
    if (target) moveToward(viewer, target, 0.5)
  }, ScreenSpaceEventType.LEFT_DOUBLE_CLICK)
  return () => resizeObserver.disconnect()
}

/** The ground under a screen position, or undefined over empty space. */
export function pickGround(viewer, position) {
  const { scene, camera } = viewer
  const ray = camera.getPickRay(position)
  const hit = ray && scene.globe.pick(ray, scene)
  if (hit) return hit
  if (scene.pickPositionSupported) {
    const depth = scene.pickPosition(position)
    if (depth) return depth
  }
  return camera.pickEllipsoid(position, scene.ellipsoid)
}

function screenCenter(viewer) {
  const canvas = viewer.scene.canvas
  return new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2)
}

/** Moves the camera `share` of the way to a point, keeping its heading and tilt. */
function moveToward(viewer, target, share) {
  const { camera, scene } = viewer
  const destination = Cartesian3.lerp(camera.positionWC, target, share, new Cartesian3())
  const point = scene.ellipsoid.cartesianToCartographic(destination)
  const ground = scene.globe.getHeight(point) ?? scene.ellipsoid.cartesianToCartographic(target).height
  point.height = Math.max(point.height, ground + scene.screenSpaceCameraController.minimumZoomDistance)
  scene.ellipsoid.cartographicToCartesian(point, destination)
  camera.flyTo({
    destination,
    orientation: { heading: camera.heading, pitch: camera.pitch, roll: 0 },
    duration: MOVE_SECONDS,
  })
}

/** Zoom buttons: factor below 1 moves in, above 1 moves out. */
export function zoomBy(viewer, factor) {
  const { camera, scene } = viewer
  const target = pickGround(viewer, screenCenter(viewer))
  if (!target) {
    const height = camera.positionCartographic.height
    if (factor < 1) camera.zoomIn(height * (1 - factor))
    else camera.zoomOut(height * (factor - 1))
    scene.requestRender()
    return
  }
  const max = scene.screenSpaceCameraController.maximumZoomDistance
  const distance = Cartesian3.distance(camera.positionWC, target)
  const share = 1 - Math.min(factor, max / distance)
  moveToward(viewer, target, share)
}

export function isTilted(viewer) {
  return viewer.camera.pitch > FLAT_ENOUGH
}

/**
 * Turns and tilts around the spot in the middle of the screen, the way
 * Google's compass and 2D/3D buttons do. Undefined keeps the current value.
 */
export function orbitCenter(viewer, { heading, pitch }) {
  const { camera } = viewer
  heading ??= camera.heading
  pitch ??= camera.pitch
  const target = pickGround(viewer, screenCenter(viewer))
  if (!target) {
    camera.flyTo({ destination: camera.positionWC, orientation: { heading, pitch, roll: 0 }, duration: MOVE_SECONDS })
    return
  }
  const clearance = viewer.scene.screenSpaceCameraController.minimumZoomDistance
  const range = Math.max(Cartesian3.distance(camera.positionWC, target), clearance / Math.max(0.1, -Math.sin(pitch)))
  camera.flyToBoundingSphere(new BoundingSphere(target, 0), {
    offset: new HeadingPitchRange(heading, pitch, range),
    duration: MOVE_SECONDS,
  })
}

export const resetNorth = (viewer) => orbitCenter(viewer, { heading: 0 })

export const toggleTilt = (viewer) => orbitCenter(viewer, { pitch: isTilted(viewer) ? TOP_DOWN : TILTED })
