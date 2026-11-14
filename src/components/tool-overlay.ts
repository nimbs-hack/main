import { Cartesian2, Cartesian3, Cartographic, EllipsoidalOccluder } from 'cesium'
import type { Viewer } from 'cesium'
import { DATUM_OFFSET } from '../data/terrain.js'
import type { LatLon } from '../data/geo'

// What a map tool draws. Lines can be dashed. Dots carry an optional label.
export type ToolLine = { points: LatLon[], color: string, dash?: number[], width?: number }
export type ToolDot = { point: LatLon, color: string, label?: string, hollow?: boolean }
export type ToolShapes = { lines: ToolLine[], dots: ToolDot[] }

type Projected = { location: Cartographic, position: Cartesian3, screen: Cartesian2 | null }

const LABEL_FONT = '500 11px "JetBrains Mono Variable", ui-monospace, monospace'

/**
 * Canvas layer for the ruler, range rings and line of sight, drawn over the
 * plan the same way plan-overlay.ts draws it: points are placed on the
 * rendered terrain and hidden behind the planet's limb.
 */
export function addToolOverlay(viewer: Viewer, background: string) {
  const { scene } = viewer
  const canvas = document.createElement('canvas')
  canvas.className = 'route-overlay'
  canvas.setAttribute('aria-hidden', 'true')
  const context = canvas.getContext('2d')!
  viewer.container.appendChild(canvas)

  const occluder = new EllipsoidalOccluder(scene.ellipsoid, viewer.camera.positionWC)
  let lines: (ToolLine & { projected: Projected[] })[] = []
  let dots: (ToolDot & Projected)[] = []
  let heightsDirty = true
  let exaggeration = scene.verticalExaggeration
  const removeProgress = scene.globe.tileLoadProgressEvent.addEventListener(() => { heightsDirty = true })

  const project = ([lat, lon]: LatLon): Projected => ({
    location: Cartographic.fromDegrees(lon, lat, DATUM_OFFSET),
    position: new Cartesian3(),
    screen: null,
  })

  const place = (p: Projected) => {
    if (heightsDirty) {
      p.location.height = scene.globe.getHeight(p.location) ?? DATUM_OFFSET
      scene.ellipsoid.cartographicToCartesian(p.location, p.position)
    }
    p.screen = occluder.isPointVisible(p.position)
      ? scene.cartesianToCanvasCoordinates(p.position, p.screen ?? new Cartesian2()) ?? null
      : null
    return p.screen
  }

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
    context.lineJoin = 'round'
    context.lineCap = 'round'

    for (const line of lines) {
      context.beginPath()
      let connected = false
      for (const p of line.projected) {
        const s = place(p)
        if (!s) {
          connected = false
          continue
        }
        if (connected) context.lineTo(s.x, s.y)
        else context.moveTo(s.x, s.y)
        connected = true
      }
      const w = line.width ?? 2
      context.setLineDash(line.dash ?? [])
      context.strokeStyle = background
      context.lineWidth = w + 3
      context.stroke()
      context.strokeStyle = line.color
      context.lineWidth = w
      context.stroke()
      context.setLineDash([])
    }

    context.font = LABEL_FONT
    context.textBaseline = 'middle'
    context.textAlign = 'left'
    for (const dot of dots) {
      const s = place(dot)
      if (!s) continue
      context.beginPath()
      context.arc(s.x, s.y, 5, 0, Math.PI * 2)
      context.fillStyle = dot.hollow ? background : dot.color
      context.fill()
      context.lineWidth = 2
      context.strokeStyle = dot.color
      context.stroke()
      if (!dot.label) continue
      const w = context.measureText(dot.label).width + 10
      context.fillStyle = background
      context.fillRect(s.x + 9, s.y - 9, w, 18)
      context.fillStyle = dot.color
      context.fillText(dot.label, s.x + 14, s.y + 0.5)
    }
    heightsDirty = false
  }

  const removeRender = scene.postRender.addEventListener(draw)
  return {
    set(shapes: ToolShapes) {
      lines = shapes.lines.map((line) => ({ ...line, projected: line.points.map(project) }))
      dots = shapes.dots.map((dot) => ({ ...dot, ...project(dot.point) }))
      heightsDirty = true
      scene.requestRender()
    },
    destroy() {
      removeProgress()
      removeRender()
      canvas.remove()
    },
  }
}

export type ToolOverlay = ReturnType<typeof addToolOverlay>
