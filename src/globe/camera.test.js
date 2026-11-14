import { expect, test } from 'bun:test'
import { imageryZoomLimit, zoomBy, orbitCenter } from './camera'
import { Cartesian3, Ellipsoid } from 'cesium'

test('zoom limit keeps a 5 m source pixel within two screen pixels', () => {
  const height = 1080
  const fov = Math.PI / 3
  const limit = imageryZoomLimit(height, fov)
  const groundSpan = 2 * limit * Math.tan(fov / 2)
  expect(5 / (groundSpan / height)).toBeCloseTo(2)
  expect(imageryZoomLimit(height * 2, fov)).toBeCloseTo(limit * 2)
})

test('zoom buttons and tilt changes preserve the minimum ground clearance', () => {
  const ellipsoid = new Ellipsoid(3396190, 3396190, 3396190)
  const ground = 22755
  const target = Cartesian3.fromDegrees(-104.448, 11.25, ground, ellipsoid)
  let destination
  let orbit
  const viewer = {
    camera: {
      positionWC: Cartesian3.fromDegrees(-104.448, 11.25, ground + 3000, ellipsoid),
      pitch: -Math.PI / 2, heading: 0,
      getPickRay: () => ({}),
      flyTo: (options) => { destination = options.destination },
      flyToBoundingSphere: (_sphere, options) => { orbit = options.offset },
    },
    scene: {
      ellipsoid,
      canvas: { clientWidth: 1280, clientHeight: 800 },
      globe: { pick: () => target, getHeight: () => ground },
      screenSpaceCameraController: { minimumZoomDistance: 2800, maximumZoomDistance: 14000000 },
    },
  }
  zoomBy(viewer, 0.5)
  expect(ellipsoid.cartesianToCartographic(destination).height - ground).toBeCloseTo(2800)
  const pitch = -Math.PI / 6
  orbitCenter(viewer, { pitch })
  expect(orbit.range * -Math.sin(pitch)).toBeGreaterThanOrEqual(2800)
})
