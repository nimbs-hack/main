import { expect, test } from 'bun:test'
import { MIN_GROUND_CLEARANCE, zoomBy, orbitCenter, tiltLimit } from './camera'
import { Cartesian3, Ellipsoid } from 'cesium'

test('zoom buttons and tilt changes preserve the minimum ground clearance', () => {
  const ellipsoid = new Ellipsoid(3396190, 3396190, 3396190)
  const ground = 22755
  const target = Cartesian3.fromDegrees(-104.448, 11.25, ground, ellipsoid)
  let destination
  let orbit
  const viewer = {
    camera: {
      positionWC: Cartesian3.fromDegrees(-104.448, 11.25, ground + 60, ellipsoid),
      pitch: -Math.PI / 2, heading: 0,
      positionCartographic: { height: ground + 60 },
      getPickRay: () => ({}),
      flyTo: (options) => { destination = options.destination },
      flyToBoundingSphere: (_sphere, options) => { orbit = options.offset },
    },
    scene: {
      ellipsoid,
      canvas: { clientWidth: 1280, clientHeight: 800 },
      globe: { pick: () => target, getHeight: () => ground },
      screenSpaceCameraController: { minimumZoomDistance: MIN_GROUND_CLEARANCE, maximumZoomDistance: 14000000 },
    },
  }
  zoomBy(viewer, 0.5)
  expect(ellipsoid.cartesianToCartographic(destination).height - ground).toBeCloseTo(MIN_GROUND_CLEARANCE)
  const pitch = -Math.PI / 6
  orbitCenter(viewer, { pitch })
  expect(orbit.range * -Math.sin(pitch)).toBeGreaterThanOrEqual(MIN_GROUND_CLEARANCE)
})

test('tilt limit shrinks with altitude to straight down from orbit', () => {
  expect(tiltLimit(1000)).toBeCloseTo(Math.PI * 80 / 180)
  expect(tiltLimit(741_000)).toBeLessThan(tiltLimit(100_000))
  expect(tiltLimit(100_000)).toBeLessThan(tiltLimit(30_000))
  expect(tiltLimit(9_000_000)).toBe(0)
})
