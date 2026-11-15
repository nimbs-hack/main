// The viewer's map: the mission's sites on 3D ground, with the route through
// the plan's stops (./route) once the region's terrain is in.
//
// The ground is flat-projected around the middle of the mission: meters east
// and north of that point. That is exact enough for one site and the routes
// around it, which is what the viewer is for. Far from the middle, east-west
// distances stretch.
//
// The map loads only the mission's own region, its sites and symbols with a
// margin around them, and keeps the camera over it. It draws two sets of
// tiles. The first loads once and covers the region. The second follows the
// camera, is as fine as the zoom needs, and is cut to the region. While a new
// one loads, the one before it stays. Nothing is drawn unless something
// changed.
//
// Heights are always drawn three times taller, and the map key says so.

import type { Site } from '../api'
import type { Marker } from '../data/markers'
import { DATUM_OFFSET } from '../data/terrain-source.js'
import { formatElevation, formatLatLon } from '../format.js'
import { h } from './dom'
import { type IconName, icon } from './icons'
import type { CrewPosition } from './live'
import { type Frame, createFlatRenderer, createGlRenderer } from './gl'
import { type MissionRegion, intersectBounds, missionRegion } from './region'
import { type RouteLeg, type SiteRoute, routeSites } from './route'
import { type Bounds, MAX_LEVEL, METERS_PER_DEGREE, type Patch, createTileSource, patchId } from './tiles'
import { type Basis, HALF_FOV, MIN_PITCH, type View, basis, ground, matrix, pixelsPerMeter, project } from './view'

export interface MapStatus {
  loading: boolean
  imageryMissing: boolean
  terrainMissing: boolean
  // The device cannot draw 3D, so the ground is flat.
  flat: boolean
}

export interface MapEvents {
  // A site pin was clicked.
  select(site: number): void
  selectCrew(member: number): void
  status(status: MapStatus): void
  // Coordinates and elevation under the pointer, or '' when there is none.
  cursor(text: string): void
  // Pixels per meter at the middle of the map.
  scale(pixelsPerMeter: number): void
  // The route between the sites, found once the region's terrain is in.
  // Null with fewer than two sites, and until then.
  route(route: SiteRoute | null): void
}

const MIN_DIST = 150
const MAX_DIST = 22_000_000
const TILTED = (50 * Math.PI) / 180
const TOP_DOWN = Math.PI / 2
export const RELIEF = 3
// Candidate line style from src/components/plan-overlay.ts: dashes of 6 on
// 5, 2.5 px wide, on a dark band.
const DASH = 6 / 11
const PIN = 20

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

export function createMap(root: HTMLElement, events: MapEvents) {
  const colors = { bg: token('--color-bg'), text: token('--color-text'), accent: token('--color-accent'), hazard: token('--color-hazard') }
  const font = `600 ${token('--text-data')} ${token('--font-sans')}`
  const background = rgb(colors.bg)
  const blank = rgb(token('--color-surface-raised'))

  let queued = 0
  const requestDraw = () => {
    queued ||= requestAnimationFrame(draw)
  }

  // `?flat` asks for the flat map on a device whose 3D is broken or slow.
  const wantFlat = new URLSearchParams(location.search).has('flat')
  let canvas = h('canvas', { class: 'map__ground' })
  const gl = wantFlat ? null : createGlRenderer(canvas, background, blank, requestDraw)
  // A canvas that was asked for WebGL cannot draw 2D afterwards.
  if (!gl) canvas = h('canvas', { class: 'map__ground' })
  const renderer = gl ?? createFlatRenderer(canvas, background, blank)
  const overlay = h('canvas', { class: 'map__overlay', tabindex: 0, 'aria-label': 'Map. Drag to move, scroll to zoom, arrow keys to move.' })
  const pen = overlay.getContext('2d')!
  const tiles = createTileSource((image) => renderer.release(image))

  // The middle of the mission. `cos` shortens a degree of longitude there.
  let origin = { lat: 0, lon: 0, cos: 1 }
  // What is loaded, and how far the camera may pull back from it. Null
  // until a mission with a place is shown.
  let region: MissionRegion | null = null
  let maxDist = MAX_DIST
  // The point the camera looks at, meters east and north of the origin.
  const target = { x: 0, y: 0 }
  const view: View = { heading: 0, pitch: renderer.flat ? TOP_DOWN : TILTED, dist: MAX_DIST, width: 1, height: 1 }
  let fitDist = MAX_DIST
  // The terrain height drawn at zero, so drawn heights stay small numbers.
  let h0 = DATUM_OFFSET
  let base: Patch | null = null
  let detail: Patch | null = null
  // The detail patch whose pictures are still arriving.
  let incoming: Patch | null = null
  // The detail patch asked for, and the mission it was asked for.
  let wanted = ''
  let mission = 0
  let loads = 0
  let sites: Site[] = []
  // The plan: site positions in visiting order.
  let stops: number[] = []
  let route: SiteRoute | null = null
  let markers: Marker[] = []
  let selected = -1
  let pins: Array<{ x: number; y: number; site: number }> = []
  const icons = new Map<string, HTMLImageElement>()
  const crewLayer = h('div', { class: 'crew-pins', 'aria-label': 'Crew positions' })
  let crew: CrewPosition[] = []
  let crewSignature = ''
  let crewQueued = 0
  let crewButtons: HTMLButtonElement[] = []

  // Crew markers closer than this on screen merge into one group marker, as
  // a map merges nearby pins. Zooming in, or clicking the group, parts them.
  const GROUP_PX = 26
  let crewPaused = false
  let groupButtons: HTMLButtonElement[] = []
  function groupButton(n: number): HTMLButtonElement {
    let button = groupButtons[n]
    if (!button) {
      const made = h(
        'button',
        {
          type: 'button',
          class: 'crew-pin crew-pin--group',
          onclick: () => lookAt(Number(made.dataset.lat), Number(made.dataset.lon), MIN_DIST),
        },
        h('span', { class: 'crew-pin__dot', 'aria-hidden': 'true' }),
        h('span', { class: 'crew-pin__name' }),
      )
      button = groupButtons[n] = made
      crewLayer.append(made)
    }
    return button
  }

  function drawCrew(b: Basis, tz: number) {
    const labels: Array<[number, number, number, number]> = []
    // Labels give way to the map controls and the site-order key.
    const mapBox = root.getBoundingClientRect()
    for (const control of [rail, key]) {
      if (!control.getClientRects().length) continue
      const box = control.getBoundingClientRect()
      labels.push([box.left - mapBox.left, box.top - mapBox.top, box.width, box.height])
    }
    for (const pin of pins) labels.push([pin.x - 12, pin.y - 12, 32 + pen.measureText(sites[pin.site]!.name).width, 24])

    // Puts a marker at a point, and its name on the side that covers least.
    const place = (button: HTMLButtonElement, point: [number, number]) => {
      button.hidden = false
      button.style.left = `${point[0]}px`
      button.style.top = `${point[1]}px`
      const label = button.querySelector<HTMLElement>('.crew-pin__name')!
      const width = label.offsetWidth,
        height = label.offsetHeight
      const choices = [
        [20, -height / 2],
        [-width - 20, -height / 2],
        [-width / 2, 22],
        [-width / 2, -height - 22],
      ]
      let side = choices[0]!
      let best = Infinity
      for (const candidate of choices) {
        const left = point[0] + candidate[0]!,
          top = point[1] + candidate[1]!
        const outside = left < 0 || top < 0 || left + width > view.width || top + height > view.height
        const overlaps = labels.filter(([x, y, w, h]) => left < x + w + 4 && x < left + width + 4 && top < y + h + 4 && y < top + height + 4).length
        const score = overlaps + (outside ? 100 : 0)
        if (score < best) {
          side = candidate
          best = score
        }
      }
      label.style.left = `${22 + side[0]!}px`
      label.style.top = `${22 + side[1]!}px`
      labels.push([point[0] + side[0]!, point[1] + side[1]!, width, height])
    }

    // Each person joins the first group whose first member is near on screen.
    const groups: Array<{ members: number[]; points: Array<[number, number]>; scene: Array<[number, number]> }> = []
    crew.forEach((person, i) => {
      crewButtons[i]!.hidden = true
      const [x, y] = toScene(person.lat, person.lon)
      const point = project(b, view, [x - target.x, y - target.y, zOf(x, y) - tz])
      if (!point || point[0] < 16 || point[1] < 16 || point[0] > view.width - 16 || point[1] > view.height - 16) return
      const near = groups.find(({ points: [first] }) => Math.hypot(first![0] - point[0], first![1] - point[1]) < GROUP_PX)
      if (near) {
        near.members.push(i)
        near.points.push(point)
        near.scene.push([x, y])
      } else groups.push({ members: [i], points: [point], scene: [[x, y]] })
    })

    const mean = (values: Array<[number, number]>): [number, number] => [
      values.reduce((sum, v) => sum + v[0], 0) / values.length,
      values.reduce((sum, v) => sum + v[1], 0) / values.length,
    ]
    let used = 0
    for (const { members, points, scene } of groups) {
      if (members.length === 1) {
        place(crewButtons[members[0]!]!, points[0]!)
        continue
      }
      const people = members.map((i) => crew[i]!)
      const you = people.some((person) => person.self)
      const button = groupButton(used++)
      const [lat, lon] = toGeo(...mean(scene))
      button.dataset.lat = String(lat)
      button.dataset.lon = String(lon)
      button.classList.toggle('crew-pin--self', you)
      const paused = crewPaused ? ' · Paused' : ''
      button.querySelector('.crew-pin__name')!.textContent = `${you ? `You and ${people.length - 1} ${people.length === 2 ? 'other' : 'others'}` : `${people.length} crew`}${paused}`
      button.setAttribute('aria-label', `Group: ${people.map((person) => (person.self ? `you, ${person.name}` : person.name)).join(', ')}. Zoom in to tell them apart.`)
      place(button, mean(points))
    }
    for (let n = used; n < groupButtons.length; n++) groupButtons[n]!.hidden = true
  }

  const east = () => METERS_PER_DEGREE * origin.cos
  const toScene = (lat: number, lon: number): [number, number] => [(((lon - origin.lon + 540) % 360) - 180) * east(), (lat - origin.lat) * METERS_PER_DEGREE]
  const toGeo = (x: number, y: number): [lat: number, lon: number] => [origin.lat + y / METERS_PER_DEGREE, origin.lon + x / east()]
  const lift = () => (renderer.flat ? 0 : RELIEF)
  // Drawn height of the ground at a point, in meters above the zero level.
  const zOf = (x: number, y: number) => {
    const [lat, lon] = toGeo(x, y)
    return ((tiles.heightAt(lat, lon) ?? h0) - h0) * lift()
  }
  // Coarser patches are drawn first, so finer ground shows over them.
  const active = () => [base, detail, incoming].filter((patch): patch is Patch => patch !== null).sort((a, b) => a.level - b.level)

  const report = () => {
    const shown = active()
    events.status({
      loading: loads > 0,
      imageryMissing: shown.some((patch) => patch.imageryMissing),
      terrainMissing: shown.some((patch) => patch.terrainMissing),
      flat: renderer.flat,
    })
  }

  // The level where one tile is about as wide as the camera is far.
  const levelFor = (dist: number) => clamp(Math.floor(Math.log2((180 * east()) / (dist * 0.7))), 0, MAX_LEVEL)

  // The tiles the camera needs: a square around the target, cut to the
  // mission's region. Null with no region, or when the square misses it.
  function area(): { level: number; bounds: Bounds } | null {
    if (!region) return null
    const [lat, lon] = toGeo(target.x, target.y)
    const half = view.dist * 1.4
    const bounds = intersectBounds(region.bounds, {
      south: lat - half / METERS_PER_DEGREE,
      north: lat + half / METERS_PER_DEGREE,
      west: lon - half / east(),
      east: lon + half / east(),
    })
    return bounds && { level: levelFor(view.dist), bounds }
  }

  // `arrived` gets the patch when its terrain is in, `complete` when every
  // picture is. Neither is called for a mission that is no longer shown.
  async function load(place: { level: number; bounds: Bounds }, arrived: (patch: Patch) => void, complete: (patch: Patch) => void = () => {}) {
    const asked = mission
    loads++
    report()
    try {
      const patch = await tiles.loadPatch(place.bounds, place.level, requestDraw)
      if (asked === mission) arrived(patch)
      requestDraw()
      await patch.pictures
      if (asked === mission) complete(patch)
    } finally {
      loads--
      tiles.trim(active())
      report()
      requestDraw()
    }
  }

  function setDetail(next: Patch | null) {
    for (const old of [detail, incoming]) if (old && old !== next) renderer.drop(old)
    detail = next
    incoming = null
  }

  function refresh() {
    const place = area()
    if (!place) return
    const id = patchId(place.bounds, place.level)
    if (id === wanted) return
    wanted = id
    if (id === base?.id) return setDetail(null)
    // A patch that arrives after the camera moved on is not shown. Its tiles
    // stay in the cache for the next one.
    void load(
      place,
      (patch) => {
        if (patch.id !== wanted) return
        if (incoming) renderer.drop(incoming)
        incoming = patch
      },
      (patch) => incoming === patch && setDetail(patch),
    )
  }

  let baseArea: { level: number; bounds: Bounds } | null = null
  function loadBase() {
    if (!baseArea) return
    void load(baseArea, (patch) => {
      if (base) renderer.drop(base)
      base = patch
      h0 = tiles.heightAt(origin.lat, origin.lon) ?? h0
      findRoute()
    })
  }

  const stopPoints = (): Array<[number, number]> => stops.map((i) => [sites[i]!.lat, sites[i]!.lon])

  // Searches the legs on the terrain loaded so far. The region's own patch is
  // in by now and covers each leg's search corridor.
  function findRoute() {
    route = stops.length > 1 ? routeSites(stopPoints(), tiles.heightAt) : null
    routeKeyText.textContent = route ? `Route, shortest under ${route.limit}°` : 'Site order. Finding the route'
    blockedKey.hidden = !route?.legs.some((leg) => leg.status === 'blocked')
    blockedKeyText.textContent = route ? `No path under ${route.limit}°` : ''
    events.route(route)
    requestDraw()
  }

  // On a slow graphics chip the ground is drawn at half resolution while the
  // camera moves, and sharp again once it stops. `pace` is the usual time
  // between frames of one movement.
  let slow = false
  let coarse = false
  let lastDraw = 0
  let pace = 16
  const sizeGround = () => renderer.resize(view.width, view.height, Math.min(devicePixelRatio, 1.5) * (coarse ? 0.5 : 1))
  const rested = () => {
    if (coarse) {
      coarse = false
      sizeGround()
      requestDraw()
    }
    refresh()
  }

  let timer = 0
  function moved() {
    view.dist = clamp(view.dist, MIN_DIST, maxDist)
    view.pitch = renderer.flat ? TOP_DOWN : clamp(view.pitch, MIN_PITCH, TOP_DOWN)
    if (renderer.flat) view.heading = 0
    // The camera looks at the region and nowhere else.
    if (region) {
      const { south, north, west, east: eastEdge } = region.bounds
      target.x = clamp(target.x, (west - origin.lon) * east(), (eastEdge - origin.lon) * east())
      target.y = clamp(target.y, (south - origin.lat) * METERS_PER_DEGREE, (north - origin.lat) * METERS_PER_DEGREE)
    }
    // Lift the camera until it clears the ground under it.
    for (let i = 0; i < 12 && view.pitch < TOP_DOWN; i++) {
      const { eye } = basis(view)
      if (zOf(target.x, target.y) + eye[2] > zOf(target.x + eye[0], target.y + eye[1]) + view.dist * 0.03) break
      view.pitch = Math.min(TOP_DOWN, view.pitch + 0.08)
    }
    tilt.setAttribute('aria-pressed', String(view.pitch < TOP_DOWN - 0.1))
    events.scale(pixelsPerMeter(view))
    if (slow && !coarse) {
      coarse = true
      sizeGround()
    }
    requestDraw()
    clearTimeout(timer)
    timer = window.setTimeout(rested, 180)
  }

  function draw() {
    queued = 0
    if (view.width < 2 || view.height < 2) return
    const now = performance.now()
    if (now - lastDraw < 200) {
      pace += (now - lastDraw - pace) * 0.2
      slow ||= pace > 45
    }
    lastDraw = now
    const b = basis(view)
    const tz = zOf(target.x, target.y)
    const frame: Frame = {
      matrix: matrix(b, view, view.dist * 0.04, view.dist * 80),
      lift: [lift(), -h0 * lift() - tz],
      scale: pixelsPerMeter(view),
      place: (tile) => [
        (tile.west - origin.lon) * east() - target.x,
        (tile.north - tile.size - origin.lat) * METERS_PER_DEGREE - target.y,
        tile.size * east(),
        tile.size * METERS_PER_DEGREE,
      ],
    }
    renderer.draw(active(), frame)
    drawOverlay(b, tz)
    drawCrew(b, tz)
  }

  function drawOverlay(b: Basis, tz: number) {
    const ratio = overlay.width / view.width
    pen.setTransform(ratio, 0, 0, ratio, 0, 0)
    pen.clearRect(0, 0, view.width, view.height)
    pen.lineCap = 'butt'
    pen.lineJoin = 'round'
    const at = (x: number, y: number, z = zOf(x, y)) => project(b, view, [x - target.x, y - target.y, z - tz])
    const places = sites.map((site) => toScene(site.lat, site.lon))

    // Dashes are measured along the ground, in a length that is a power of
    // two meters, so they stay on the same ground as the camera moves.
    const period = 2 ** Math.round(Math.log2(11 / pixelsPerMeter(view)))
    const station = period * 4
    const reach = view.dist * 3
    const band = new Path2D()
    const dashes = { ok: new Path2D(), blocked: new Path2D() }
    // Draws a line along the ground. `offset` is how far along the whole line
    // the first point is, so dashes run on across its corners.
    const strokeLine = (line: Array<[number, number]>, into: Path2D) => {
      let offset = 0
      for (let i = 1; i < line.length; offset += Math.hypot(line[i]![0] - line[i - 1]![0], line[i]![1] - line[i - 1]![1]), i++) {
        const [ax, ay] = line[i - 1]!
        const [bx, by] = line[i]!
        const length = Math.hypot(bx - ax, by - ay)
        if (length === 0) continue
        // Only the part near the camera target is drawn.
        const along = ((target.x - ax) * (bx - ax) + (target.y - ay) * (by - ay)) / length
        const off = (target.x - ax) ** 2 + (target.y - ay) ** 2 - along ** 2
        if (off > reach ** 2) continue
        const chord = Math.sqrt(reach ** 2 - off)
        const from = Math.max(0, along - chord)
        const to = Math.min(length, along + chord)
        if (to <= from) continue
        // Ground height is read at stations four dashes apart, and is linear
        // between them.
        const first = Math.floor(from / station)
        const heights: number[] = []
        for (let k = first; (k - 1) * station < to; k++) {
          const s = clamp(k * station, 0, length)
          heights.push(zOf(ax + ((bx - ax) * s) / length, ay + ((by - ay) * s) / length))
        }
        const point = (s: number) => {
          const k = Math.min(s / station - first, heights.length - 1.001)
          const low = Math.max(0, Math.floor(k))
          const z = heights[low]! + (heights[low + 1]! - heights[low]!) * (k - low)
          return at(ax + ((bx - ax) * s) / length, ay + ((by - ay) * s) / length, z)
        }
        let open = false
        for (let s = from; ; s = Math.min(to, (Math.floor(s / period) + 1) * period)) {
          const p = point(s)
          if (!p) open = false
          else if (open) band.lineTo(p[0], p[1])
          else band.moveTo(p[0], p[1])
          open = p !== null
          if (s >= to) break
        }
        for (let k = Math.floor((offset + from) / period); k * period < offset + to; k++) {
          const start = point(Math.max(from, k * period - offset))
          const end = point(Math.min(to, (k + DASH) * period - offset))
          if (!start || !end) continue
          into.moveTo(start[0], start[1])
          into.lineTo(end[0], end[1])
        }
      }
    }
    // Until the route is found, the stops in order, straight.
    const points = stopPoints()
    const legs: Array<Pick<RouteLeg, 'status' | 'points'>> = route?.legs ?? points.slice(1).map((point, i) => ({ status: 'unknown', points: [points[i]!, point] }))
    for (const leg of legs) strokeLine(leg.points.map(([lat, lon]) => toScene(lat, lon)), leg.status === 'blocked' ? dashes.blocked : dashes.ok)
    pen.strokeStyle = colors.bg
    pen.lineWidth = 5.5
    pen.stroke(band)
    pen.lineWidth = 2.5
    pen.strokeStyle = colors.accent
    pen.stroke(dashes.ok)
    // A leg with no path under the limit is straight, in the over-limit color.
    pen.lineWidth = 3.5
    pen.strokeStyle = colors.hazard
    pen.stroke(dashes.blocked)

    // Pins and symbols first, then names. A name gives way to a pin, a
    // symbol, or a name already drawn: the selected site's, then the other
    // sites', then the symbols'.
    pen.font = font
    pen.textBaseline = 'middle'
    const taken: Array<[number, number, number, number]> = []
    const labels: Array<[string, number, number]> = []
    pins = []
    places.forEach(([x, y], site) => {
      const p = at(x, y)
      if (p) pins.push({ x: p[0], y: p[1], site })
    })
    for (const marker of markers) {
      const p = at(...toScene(marker.point[0], marker.point[1]))
      const icon = icons.get(marker.symbol)
      if (!p || !icon?.complete) continue
      pen.drawImage(icon, p[0] - 13, p[1] - 13, 26, 26)
      taken.push([p[0] - 13, p[1] - 13, 26, 26])
      labels.push([marker.label, p[0] + 18, p[1]])
    }
    for (const pin of pins) {
      const chosen = pin.site === selected
      const name = String(pin.site + 1)
      const width = Math.max(PIN, pen.measureText(name).width + 8)
      const left = pin.x - width / 2
      const top = pin.y - PIN / 2
      pen.fillStyle = colors.bg
      pen.fillRect(left, top, width, PIN)
      pen.lineWidth = 2
      pen.strokeStyle = chosen ? colors.accent : colors.text
      pen.strokeRect(left + 1, top + 1, width - 2, PIN - 2)
      // Selection is a second outline as well as a color.
      if (chosen) pen.strokeRect(left - 3, top - 3, width + 6, PIN + 6)
      pen.textAlign = 'center'
      pen.fillStyle = colors.text
      pen.fillText(name, pin.x, pin.y + 1)
      taken.push([left, top, width, PIN])
      labels.splice(chosen ? 0 : labels.length - markers.length, 0, [sites[pin.site]!.name, pin.x + width / 2 + 6, pin.y])
    }
    pen.textAlign = 'left'
    pen.lineWidth = 3
    pen.strokeStyle = colors.bg
    pen.fillStyle = colors.text
    for (const [text, x, y] of labels) {
      const width = pen.measureText(text).width
      if (taken.some(([tx, ty, tw, th]) => x < tx + tw && tx < x + width && y - 9 < ty + th && ty < y + 9)) continue
      taken.push([x, y - 9, width, 18])
      pen.strokeText(text, x, y)
      pen.fillText(text, x, y)
    }
  }

  // Pointer, wheel and keys.

  const local = (event: MouseEvent): [number, number] => {
    const box = overlay.getBoundingClientRect()
    return [event.clientX - box.left, event.clientY - box.top]
  }
  // The point of the level ground through the target that a pixel shows.
  const groundAt = (px: number, py: number): [number, number] | null => {
    const hit = ground(basis(view), view, px, py)
    return hit && [target.x + hit[0], target.y + hit[1]]
  }
  const pinAt = (px: number, py: number) => pins.find((pin) => Math.hypot(pin.x - px, pin.y - py) < 16)

  function zoomAbout(px: number, py: number, factor: number) {
    const before = groundAt(px, py)
    view.dist = clamp(view.dist * factor, MIN_DIST, maxDist)
    const after = groundAt(px, py)
    if (before && after) {
      target.x += before[0] - after[0]
      target.y += before[1] - after[1]
    }
    moved()
  }

  function hover(px: number, py: number) {
    overlay.style.cursor = pinAt(px, py) ? 'pointer' : ''
    const b = basis(view)
    const tz = zOf(target.x, target.y)
    // Start on the level ground through the target, then follow the terrain.
    let hit = ground(b, view, px, py)
    for (let i = 0; i < 4 && hit; i++) hit = ground(b, view, px, py, zOf(target.x + hit[0], target.y + hit[1]) - tz)
    const [lat, lon] = hit ? toGeo(target.x + hit[0], target.y + hit[1]) : [NaN, NaN]
    if (!(Math.abs(lat) <= 90)) return events.cursor('')
    const height = tiles.heightAt(lat, lon)
    events.cursor(`${formatLatLon(lat, lon)}${height === null ? '' : `  ${formatElevation(height - DATUM_OFFSET)}`}`)
  }

  const down = new Map<number, { x: number; y: number }>()
  let drag: { turn: boolean; anchor: [number, number] | null; travel: number } | null = null
  let pinch: { gap: number; angle: number } | null = null
  const fingers = () => {
    const [a, b] = [...down.values()]
    return { gap: Math.hypot(b!.x - a!.x, b!.y - a!.y) || 1, angle: Math.atan2(b!.y - a!.y, b!.x - a!.x) }
  }

  overlay.addEventListener('pointerdown', (event) => {
    overlay.setPointerCapture(event.pointerId)
    const [x, y] = local(event)
    down.set(event.pointerId, { x, y })
    drag = down.size === 1 ? { turn: event.button !== 0 || event.shiftKey || event.ctrlKey, anchor: groundAt(x, y), travel: 0 } : null
    pinch = down.size === 2 ? fingers() : null
  })
  overlay.addEventListener('pointermove', (event) => {
    const [x, y] = local(event)
    const was = down.get(event.pointerId)
    if (!was) return hover(x, y)
    down.set(event.pointerId, { x, y })
    if (drag) {
      drag.travel += Math.abs(x - was.x) + Math.abs(y - was.y)
      if (drag.turn) {
        view.heading += (x - was.x) * 0.006
        view.pitch += (y - was.y) * 0.006
      } else {
        const now = groundAt(x, y)
        if (now && drag.anchor) {
          target.x += drag.anchor[0] - now[0]
          target.y += drag.anchor[1] - now[1]
        }
      }
      moved()
    } else if (pinch && down.size === 2) {
      const now = fingers()
      view.dist *= pinch.gap / now.gap
      view.heading -= now.angle - pinch.angle
      pinch = now
      moved()
    }
  })
  const release = (event: PointerEvent) => {
    if (!down.delete(event.pointerId)) return
    if (drag && !drag.turn && drag.travel < 5 && event.type === 'pointerup') {
      const pin = pinAt(...local(event))
      if (pin) {
        selected = pin.site
        events.select(pin.site)
        requestDraw()
      }
    }
    // A finger left on the glass after a pinch carries on as a drag.
    const [rest] = [...down.values()]
    drag = rest ? { turn: false, anchor: groundAt(rest.x, rest.y), travel: 5 } : null
    pinch = null
  }
  overlay.addEventListener('pointerup', release)
  overlay.addEventListener('pointercancel', release)
  overlay.addEventListener('pointerleave', () => events.cursor(''))
  overlay.addEventListener('contextmenu', (event) => event.preventDefault())
  overlay.addEventListener('dblclick', (event) => zoomAbout(...local(event), 0.5))
  overlay.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault()
      // Firefox counts lines where other browsers count pixels.
      const delta = clamp(event.deltaY * (event.deltaMode === 1 ? 33 : 1), -150, 150)
      zoomAbout(...local(event), Math.exp(delta * 0.002))
    },
    { passive: false },
  )
  overlay.addEventListener('keydown', (event) => {
    const step = view.dist * 0.15
    const arrows: Record<string, [ahead: number, across: number]> = { ArrowUp: [1, 0], ArrowDown: [-1, 0], ArrowRight: [0, 1], ArrowLeft: [0, -1] }
    const [ahead, across] = arrows[event.key] ?? [0, 0]
    if (ahead || across) {
      if (event.shiftKey) {
        view.pitch += ahead * 0.1
        view.heading += across * 0.1
      } else {
        target.x += (Math.sin(view.heading) * ahead + Math.cos(view.heading) * across) * step
        target.y += (Math.cos(view.heading) * ahead - Math.sin(view.heading) * across) * step
      }
    } else if (event.key === '+' || event.key === '=') view.dist *= 0.7
    else if (event.key === '-') view.dist /= 0.7
    else return
    event.preventDefault()
    moved()
  })

  // The camera rail.

  const button = (face: IconName, tip: string, act: () => void) =>
    h('button', { type: 'button', class: 'rail__button', 'aria-label': tip, 'data-tip': tip, onclick: act }, icon(face))
  const zoom = (factor: number) => zoomAbout(view.width / 2, view.height / 2, factor)
  const tilt = button('tilt', 'Tilt the view. Right-drag or Shift+drag also turns it.', () => {
    view.pitch = view.pitch < TOP_DOWN - 0.1 ? TOP_DOWN : TILTED
    moved()
  })
  const routeKeyText = h('span', null, 'Site order. Finding the route')
  const orderKey = h(
    'span',
    {
      class: 'key__item',
      title: "The viewer's own route search, on the terrain this map loaded, under the planner's Nominal limits. The planner's Sites stage can find other routes.",
    },
    h('span', { class: 'key__line' }),
    routeKeyText,
  )
  const blockedKeyText = h('span')
  const blockedKey = h(
    'span',
    { class: 'key__item', hidden: true, title: 'Drawn straight. The route search found no path under the slope limit on this leg.' },
    h('span', { class: 'key__line key__line--blocked' }),
    blockedKeyText,
  )
  const reliefKey = h(
    'span',
    { class: 'key__item', title: `Heights are drawn ${RELIEF} times taller than they are, so slopes look steeper. Shading and relief do not show which slopes are safe.` },
    `Heights ×${RELIEF}`,
  )
  const key = h('p', { class: 'key', hidden: true }, reliefKey, orderKey, blockedKey)
  // The page shows these controls only while its sidebar is open.
  const rail = h(
    'div',
    { class: 'rail', role: 'group', 'aria-label': 'Map view', hidden: true },
    button('plus', 'Zoom in', () => zoom(0.6)),
    button('minus', 'Zoom out', () => zoom(1 / 0.6)),
    button('fit', 'Show the whole mission', () => fit()),
    !renderer.flat && [
      button('north', 'North up', () => {
        view.heading = 0
        moved()
      }),
      tilt,
    ],
  )
  // Corner brackets mark the edges of the map, as in the editor.
  const corners = ['tl', 'tr', 'bl', 'br'].map((corner) => h('span', { class: `map__corner map__corner--${corner}`, 'aria-hidden': 'true' }))
  root.append(canvas, overlay, crewLayer, ...corners, rail, key)

  function resize() {
    view.width = root.clientWidth
    view.height = root.clientHeight
    if (view.width < 2 || view.height < 2) return
    // Extra pixels cost a weak graphics chip more than they show.
    sizeGround()
    const ratio = Math.min(devicePixelRatio, 2)
    overlay.width = Math.round(view.width * ratio)
    overlay.height = Math.round(view.height * ratio)
    events.scale(pixelsPerMeter(view))
    cancelAnimationFrame(queued)
    draw()
  }
  new ResizeObserver(resize).observe(root)
  resize()

  // Brings a place to the middle of the map, close enough to see it.
  function lookAt(lat: number, lon: number, distance = 2500) {
    ;[target.x, target.y] = toScene(lat, lon)
    view.dist = Math.min(view.dist, distance)
    moved()
  }

  function fit() {
    target.x = target.y = 0
    view.dist = fitDist
    view.heading = 0
    moved()
  }

  return {
    // Shows a mission's sites and symbols, and the route through `stops`, the
    // plan's site positions in visiting order. Frames them. False when the
    // mission has no place to show, so the map has nothing to load.
    show(nextSites: Site[], nextMarkers: Marker[], nextStops: number[]): boolean {
      sites = nextSites
      stops = nextStops.filter((i) => sites[i] !== undefined)
      markers = nextMarkers
      selected = -1
      mission++
      const points = [...sites.map((site) => [site.lat, site.lon]), ...markers.map((marker) => marker.point)] as Array<[number, number]>
      region = missionRegion(points)
      if (base) renderer.drop(base)
      base = null
      setDetail(null)
      h0 = DATUM_OFFSET
      target.x = target.y = 0
      view.heading = 0
      view.pitch = renderer.flat ? TOP_DOWN : TILTED
      key.hidden = rail.hidden = !region
      orderKey.hidden = stops.length < 2
      route = null
      routeKeyText.textContent = 'Site order. Finding the route'
      blockedKey.hidden = true
      events.route(null)
      reliefKey.hidden = renderer.flat
      if (!region) {
        // Nothing to load. The page shows the globe instead.
        baseArea = null
        wanted = ''
        maxDist = fitDist = view.dist = MAX_DIST
        requestDraw()
        return false
      }
      const { lat, lon, bounds } = region
      origin = { lat, lon, cos: Math.max(0.2, Math.cos((lat * Math.PI) / 180)) }
      const tall = (bounds.north - bounds.south) * METERS_PER_DEGREE
      const wide = (bounds.east - bounds.west) * east()
      const aspect = Math.max(0.5, view.width / view.height)
      fitDist = clamp((Math.max(tall, wide / aspect) * 1.2) / (2 * HALF_FOV), 1200, MAX_DIST)
      // Pulling back past the region would only show empty space around it.
      maxDist = fitDist * 2
      view.dist = fitDist
      baseArea = { level: levelFor(fitDist), bounds }
      wanted = patchId(bounds, baseArea.level)
      loadBase()
      if (markers.length > 0) {
        // The symbol drawings are only fetched for a mission that uses them.
        void import('../data/markers').then(({ symbolImage }) => {
          for (const { symbol } of markers) {
            if (icons.has(symbol)) continue
            const icon = new Image()
            icon.onload = requestDraw
            icon.src = symbolImage(symbol, colors.text, colors.bg, 52)
            icons.set(symbol, icon)
          }
        })
      }
      moved()
      return true
    },
    // Marks a site and brings it to the middle of the map. -1 marks none.
    select(site: number) {
      selected = site
      const place = sites[site]
      if (place) lookAt(place.lat, place.lon)
      else requestDraw()
    },
    lookAt,
    // Moving crew only repositions DOM markers, not the terrain renderer.
    setCrew(next: CrewPosition[], paused: boolean) {
      crew = next
      crewPaused = paused
      const signature = JSON.stringify(next.map((p) => [p.member, p.name, p.self, paused]))
      if (signature !== crewSignature) {
        crewSignature = signature
        crewButtons = crew.map((person) =>
          h(
            'button',
            {
              type: 'button',
              class: person.self ? 'crew-pin crew-pin--self' : 'crew-pin',
              'aria-label': `${person.self ? 'You, ' : ''}${person.name}${paused ? ', paused position' : ''}`,
              onclick: () => events.selectCrew(person.member),
            },
            h('span', { class: 'crew-pin__dot', 'aria-hidden': 'true' }),
            h('span', { class: 'crew-pin__name' }, `${person.self ? 'You' : person.name}${paused ? ' · Paused' : ''}`),
          ),
        )
        groupButtons = []
        crewLayer.replaceChildren(...crewButtons)
      }
      if (!crewQueued)
        crewQueued = requestAnimationFrame(() => {
          crewQueued = 0
          drawCrew(basis(view), zOf(target.x, target.y))
        })
    },
    // Loads again what failed.
    retry() {
      loadBase()
      wanted = ''
      refresh()
    },
  }
}

export type MapView = ReturnType<typeof createMap>
