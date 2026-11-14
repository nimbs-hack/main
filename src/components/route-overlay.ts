import { Cartesian2, Cartesian3, Cartographic, EllipsoidalOccluder } from 'cesium'
import type { Viewer } from 'cesium'
import { DATUM_OFFSET } from '../data/terrain.js'

// GroundPolylineGeometry uses Earth's approximate terrain heights. Project
// the Mars routes over the rendered map instead, without a depth test.
export function addRouteOverlay(viewer: Viewer, paths: number[][][], color: string, outline: string) {
  const { scene } = viewer
  const canvas = document.createElement('canvas')
  canvas.className = 'route-overlay'
  canvas.setAttribute('aria-hidden', 'true')
  const context = canvas.getContext('2d')
  if (!context) return () => {}
  viewer.container.appendChild(canvas)

  // Coordinates are planetocentric, east longitude [-180, 180], heights in
  // meters in Trek's shifted reference, matching scene.globe.getHeight().
  const routes = paths.map((path) => path.map(([lat, lon]) => ({
    location: Cartographic.fromDegrees(lon, lat, DATUM_OFFSET),
    position: new Cartesian3(),
  })))
  const occluder = new EllipsoidalOccluder(scene.ellipsoid, viewer.camera.positionWC)
  const screen = new Cartesian2()
  let heightsDirty = true
  let exaggeration = scene.verticalExaggeration
  const removeProgress = scene.globe.tileLoadProgressEvent.addEventListener(() => { heightsDirty = true })

  const draw = () => {
    const width = scene.canvas.clientWidth
    const height = scene.canvas.clientHeight
    const scale = window.devicePixelRatio || 1
    if (canvas.width !== Math.round(width * scale) || canvas.height !== Math.round(height * scale)) {
      canvas.width = Math.round(width * scale)
      canvas.height = Math.round(height * scale)
    }
    context.setTransform(scale, 0, 0, scale, 0, 0)
    context.clearRect(0, 0, width, height)
    occluder.cameraPosition = viewer.camera.positionWC
    heightsDirty ||= exaggeration !== scene.verticalExaggeration
    exaggeration = scene.verticalExaggeration
    context.beginPath()
    for (const route of routes) {
      let connected = false
      for (const point of route) {
        if (heightsDirty) {
          // getHeight already includes the scene's elevation exaggeration.
          point.location.height = scene.globe.getHeight(point.location) ?? DATUM_OFFSET
          scene.ellipsoid.cartographicToCartesian(point.location, point.position)
        }
        if (!occluder.isPointVisible(point.position) ||
          !scene.cartesianToCanvasCoordinates(point.position, screen)) {
          connected = false
          continue
        }
        if (connected) context.lineTo(screen.x, screen.y)
        else context.moveTo(screen.x, screen.y)
        connected = true
      }
    }
    heightsDirty = false
    context.lineJoin = 'round'
    context.lineCap = 'round'
    context.strokeStyle = outline
    context.lineWidth = 4
    context.stroke()
    context.strokeStyle = color
    context.lineWidth = 2
    context.stroke()
  }

  const removeRender = scene.postRender.addEventListener(draw)
  scene.requestRender()
  return () => {
    removeProgress()
    removeRender()
    canvas.remove()
  }
}
