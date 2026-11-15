import { Cartesian2, Cartesian3, Cartographic, EllipsoidalOccluder } from 'cesium'
import type { Viewer } from 'cesium'
import { DATUM_OFFSET } from '../data/terrain.js'
import { cumulative } from '../data/geo'
import type { LatLon } from '../data/geo'

export type PlanVertex = { point: LatLon, kind: 'start' | 'waypoint' | 'target', label: string }
export type RoutePoint = { point: LatLon, level: string }
// A suggested route drawn dashed under the plan. `focus` draws it brighter.
export type Alternative = { id: string, points: LatLon[], color: string, focus: boolean }
export type PlanColors = { text: string, bg: string, surface: string, dim: string, hazard: string, accent: string, ok: string }

// Line styles ported from deploy-v1 (apps/web/src/components/MapView.tsx).
// Selected: a dark 6.5 px halo at 72% under a solid 3.5 px accent line at
// 98%. Candidates keep deploy-v1's 6 5 dash inside a continuous dark
// outline along both edges, so they stay readable on ground of their own
// color. The gaps between dashes stay clear. Unfocused lines fade slightly.
const CANDIDATE = { dash: [6, 5], width: 2.5, alpha: 0.9, casing: 5.5, casingAlpha: 0.85 }
const SELECTED = { halo: 6.5, haloAlpha: 0.72, width: 3.5, alpha: 0.98 }
// How close the pointer must be to a candidate line to hover or pick it.
const LINE_HIT = 6

type Projected = { location: Cartographic, position: Cartesian3, screen: Cartesian2 | null }

const HIT_RADIUS = 14
// A terrain height is a ray cast against the tile mesh. While tiles stream
// in during a zoom they would be redone for every point on every frame, so
// tile changes refresh heights at most this often. New points and a new
// elevation scale are placed at once.
const HEIGHTS_MS = 400
const LABEL_FONT = '500 11px "JetBrains Mono Variable", ui-monospace, monospace'

/**
 * Draws the EVA plan over the map on a 2D canvas, like route-overlay.ts:
 * the sampled route colored by slope level, or straight dashed legs until
 * samples arrive, plus start, waypoint and target handles. Coordinates are
 * planetocentric latitude and east longitude, -180 to 180.
 */
export function addPlanOverlay(viewer: Viewer, colors: PlanColors) {
  const { scene } = viewer
  const canvas = document.createElement('canvas')
  canvas.className = 'route-overlay'
  canvas.setAttribute('aria-hidden', 'true')
  const context = canvas.getContext('2d')!
  viewer.container.appendChild(canvas)

  const occluder = new EllipsoidalOccluder(scene.ellipsoid, viewer.camera.positionWC)
  let vertices: (PlanVertex & Projected)[] = []
  let route: (RoutePoint & Projected)[] = []
  // `along` is each point's ground distance from the route's start, which
  // anchors the dashes to the terrain.
  let alternatives: (Omit<Alternative, 'points'> & { points: ({ point: LatLon } & Projected)[], along: number[] })[] = []
  let dragging: number | null = null
  // `heightsNow`: place every point this frame. `heightsStale`: tiles have
  // changed since the last pass. `heightsDirty` is set for one draw.
  let heightsDirty = false
  let heightsNow = true
  let heightsStale = false
  let lastHeights = 0
  let later: ReturnType<typeof setTimeout> | undefined
  let exaggeration = scene.verticalExaggeration
  const removeProgress = scene.globe.tileLoadProgressEvent.addEventListener(() => { heightsStale = true })

  const project = <T extends { point: LatLon }>(item: T): T & Projected => ({
    ...item,
    location: Cartographic.fromDegrees(item.point[1], item.point[0], DATUM_OFFSET),
    position: new Cartesian3(),
    screen: null,
  })

  const place = (p: Projected) => {
    if (heightsDirty) {
      // getHeight already includes the scene's elevation exaggeration.
      p.location.height = scene.globe.getHeight(p.location) ?? DATUM_OFFSET
      scene.ellipsoid.cartographicToCartesian(p.location, p.position)
    }
    const visible = occluder.isPointVisible(p.position)
    p.screen = visible ? scene.cartesianToCanvasCoordinates(p.position, p.screen ?? new Cartesian2()) ?? null : null
    return p.screen
  }

  // Candidates are drawn one at a time here, then copied over, so cutting the
  // middle out of one outline never erases a line drawn before it.
  const scratch = document.createElement('canvas')
  const scratchContext = scratch.getContext('2d')!

  // Traces visible points into the current path, breaking at hidden ones.
  const trace = (points: Projected[], target = context) => {
    const context = target
    context.beginPath()
    let connected = false
    for (const p of points) {
      const screen = p.screen
      if (!screen) {
        connected = false
        continue
      }
      if (connected) context.lineTo(screen.x, screen.y)
      else context.moveTo(screen.x, screen.y)
      connected = true
    }
  }

  const strokeSelected = () => {
    context.globalAlpha = SELECTED.haloAlpha
    context.strokeStyle = colors.bg
    context.lineWidth = SELECTED.halo
    context.stroke()
    context.globalAlpha = SELECTED.alpha
    context.strokeStyle = colors.accent
    context.lineWidth = SELECTED.width
    context.stroke()
    context.globalAlpha = 1
  }

  // The plan is the selected route. Stretches over the slope limit stay
  // orange on top of it, since a hand-drawn plan can cross the limit.
  const drawRoute = () => {
    for (const p of route) place(p)
    trace(route)
    strokeSelected()
    context.strokeStyle = colors.hazard
    context.lineWidth = SELECTED.width
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1].screen
      const b = route[i].screen
      if (route[i].level !== 'hazard' || !a || !b) continue
      context.beginPath()
      context.moveTo(a.x, a.y)
      context.lineTo(b.x, b.y)
      context.stroke()
    }
  }

  // Straight legs while terrain samples load, or while a handle is dragged.
  const drawLegs = () => {
    trace(vertices)
    context.setLineDash(CANDIDATE.dash)
    strokeSelected()
    context.setLineDash([])
  }

  // Dashes fixed to the ground, so they don't slide as the camera moves.
  // The period is the power of two in meters nearest to the 6 5 pattern's
  // 11 px at the current zoom. Zooming past a step halves or doubles it, and
  // every other dash boundary stays where it was.
  const groundDashes = (target: CanvasRenderingContext2D, points: Projected[], along: number[]) => {
    let pixels = 0
    let meters = 0
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1].screen
      const b = points[i].screen
      if (!a || !b) continue
      pixels += Math.hypot(b.x - a.x, b.y - a.y)
      meters += along[i] - along[i - 1]
    }
    target.beginPath()
    if (pixels <= 0 || meters <= 0) return
    const pattern = CANDIDATE.dash[0] + CANDIDATE.dash[1]
    const period = 2 ** Math.round(Math.log2((pattern * meters) / pixels))
    const on = (period * CANDIDATE.dash[0]) / pattern
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1].screen
      const b = points[i].screen
      const d0 = along[i - 1]
      const d1 = along[i]
      if (!a || !b || d1 <= d0) continue
      const at = (d: number) => {
        const t = (d - d0) / (d1 - d0)
        return [a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t]
      }
      for (let start = Math.floor(d0 / period) * period; start < d1; start += period) {
        const from = Math.max(d0, start)
        const to = Math.min(d1, start + on)
        if (to <= from) continue
        const [x0, y0] = at(from)
        const [x1, y1] = at(to)
        target.moveTo(x0, y0)
        target.lineTo(x1, y1)
      }
    }
  }

  const drawAlternatives = (scale: number) => {
    if (scratch.width !== canvas.width || scratch.height !== canvas.height) {
      scratch.width = canvas.width
      scratch.height = canvas.height
    }
    const sc = scratchContext
    // Unfocused first, so the focused one lands on top.
    for (const alt of [...alternatives].sort((a, b) => Number(a.focus) - Number(b.focus))) {
      for (const p of alt.points) place(p)
      const width = alt.focus ? SELECTED.width : CANDIDATE.width
      sc.setTransform(1, 0, 0, 1, 0, 0)
      sc.clearRect(0, 0, scratch.width, scratch.height)
      sc.setTransform(scale, 0, 0, scale, 0, 0)
      sc.lineJoin = 'round'
      sc.lineCap = 'round'
      trace(alt.points, sc)
      // A solid dark band, then its middle cut away: two thin rails.
      sc.globalAlpha = CANDIDATE.casingAlpha
      sc.strokeStyle = colors.bg
      sc.lineWidth = width + CANDIDATE.casing - CANDIDATE.width
      sc.stroke()
      sc.globalAlpha = 1
      sc.globalCompositeOperation = 'destination-out'
      sc.lineWidth = width
      sc.stroke()
      sc.globalCompositeOperation = 'source-over'
      // The dashes between the rails, measured on the ground.
      groundDashes(sc, alt.points, alt.along)
      sc.lineCap = 'butt'
      sc.strokeStyle = alt.color
      sc.stroke()
      context.save()
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.globalAlpha = alt.focus ? 1 : CANDIDATE.alpha
      context.drawImage(scratch, 0, 0)
      context.restore()
    }
  }

  // Start and target are deploy-v1's A and B pins: 24 px squares, surface
  // fill, accent border for A and ok border for B. Waypoints are smaller
  // squares with their number.
  const drawVertex = (v: PlanVertex & Projected, index: number) => {
    const s = v.screen
    if (!s) return
    const active = index === dragging
    const pin = v.kind !== 'waypoint'
    const size = pin ? 24 : 18
    const half = size / 2
    context.fillStyle = active ? colors.text : colors.surface
    context.fillRect(s.x - half, s.y - half, size, size)
    context.lineWidth = 2
    context.strokeStyle = v.kind === 'start' ? colors.accent : v.kind === 'target' ? colors.ok : colors.text
    context.strokeRect(s.x - half + 1, s.y - half + 1, size - 2, size - 2)
    context.font = pin ? '700 12px "JetBrains Mono Variable", ui-monospace, monospace' : LABEL_FONT
    context.textBaseline = 'middle'
    context.textAlign = 'center'
    context.fillStyle = active ? colors.bg : colors.text
    context.fillText(v.label, s.x, s.y + 0.5)
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
    heightsNow ||= exaggeration !== scene.verticalExaggeration
    exaggeration = scene.verticalExaggeration
    const now = performance.now()
    heightsDirty = heightsNow || (heightsStale && now - lastHeights >= HEIGHTS_MS)
    if (heightsDirty) {
      lastHeights = now
      heightsNow = false
      heightsStale = false
    } else if (heightsStale) {
      later ??= setTimeout(() => {
        later = undefined
        scene.requestRender()
      }, HEIGHTS_MS)
    }
    context.lineJoin = 'round'
    context.lineCap = 'round'

    for (const v of vertices) place(v)
    drawAlternatives(scale)
    if (route.length > 1 && dragging === null) drawRoute()
    else drawLegs()
    vertices.forEach(drawVertex)
    heightsDirty = false
  }

  const removeRender = scene.postRender.addEventListener(draw)
  const redraw = () => {
    heightsNow = true
    scene.requestRender()
  }

  return {
    set(nextVertices: PlanVertex[], nextRoute: RoutePoint[] | null) {
      vertices = nextVertices.map(project)
      route = (nextRoute ?? []).map(project)
      redraw()
    },
    setAlternatives(next: Alternative[]) {
      alternatives = next.map((alt) => ({ ...alt, points: alt.points.map((point) => project({ point })), along: cumulative(alt.points) }))
      redraw()
    },
    // Id of the candidate line under a canvas position, if any.
    alternativeAt(position: Cartesian2) {
      let best: string | null = null
      let bestDistance = LINE_HIT
      for (const alt of alternatives) {
        for (let i = 1; i < alt.points.length; i++) {
          const a = alt.points[i - 1].screen
          const b = alt.points[i].screen
          if (!a || !b) continue
          const dx = b.x - a.x
          const dy = b.y - a.y
          const t = Math.max(0, Math.min(1, ((position.x - a.x) * dx + (position.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
          const d = Math.hypot(position.x - (a.x + t * dx), position.y - (a.y + t * dy))
          if (d < bestDistance) {
            bestDistance = d
            best = alt.id
          }
        }
      }
      return best
    },
    // Index of the handle under a canvas position, if any.
    handleAt(position: Cartesian2) {
      let best: number | null = null
      let bestDistance = HIT_RADIUS
      vertices.forEach((v, i) => {
        if (!v.screen) return
        const d = Math.hypot(v.screen.x - position.x, v.screen.y - position.y)
        if (d <= bestDistance) {
          best = i
          bestDistance = d
        }
      })
      return best
    },
    // Moves a handle while it is dragged. Pass null to end the drag.
    drag(index: number | null, point?: LatLon) {
      dragging = index
      if (index !== null && point && vertices[index]) vertices[index] = project({ ...vertices[index], point })
      redraw()
    },
    destroy() {
      clearTimeout(later)
      removeProgress()
      removeRender()
      canvas.remove()
    },
  }
}

export type PlanOverlay = ReturnType<typeof addPlanOverlay>
