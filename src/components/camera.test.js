import { expect, test } from 'bun:test'
import { MIN_GROUND_CLEARANCE, zoomBy, orbitCenter, setupControls, tiltLimit } from './camera'
import { Camera, Cartesian3, Ellipsoid, Event, GeographicProjection, Matrix4 } from 'cesium'

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

// 3× relief puts some crater floors below the reference sphere. Include
// its surface and positive heights to cover the return from a crater to orbit.
test.each([
  [-4000, 0],
  [-4000, -Math.PI / 2],
  [0, 0],
  [40, 0],
  [100_000, 0],
  [9_000_000, 0],
])('tilt limit keeps a valid camera at height %s and pitch %s', (height, pitch) => {
  const ellipsoid = new Ellipsoid(3396190, 3396190, 3396190)
  const scene = {
    ellipsoid,
    mapProjection: new GeographicProjection(ellipsoid),
    drawingBufferWidth: 1440,
    drawingBufferHeight: 900,
    preUpdate: new Event(),
    screenSpaceCameraController: { enableInputs: true },
  }
  const camera = new Camera(scene)
  scene.camera = camera
  const destination = Cartesian3.fromDegrees(137.4, -4.6, height, ellipsoid)
  const heading = 1.2
  camera.setView({ destination, orientation: { heading, pitch, roll: 0 } })
  const stop = setupControls({
    scene,
    screenSpaceEventHandler: { removeInputAction() {}, setInputAction() {} },
  })
  try {
    expect(() => scene.preUpdate.raiseEvent()).not.toThrow()
    expect(Matrix4.equals(camera.transform, Matrix4.IDENTITY)).toBe(true)
    expect(Cartesian3.magnitude(camera.directionWC)).toBeCloseTo(1)
    expect(Cartesian3.magnitude(camera.upWC)).toBeCloseTo(1)
    expect(Cartesian3.dot(camera.directionWC, camera.upWC)).toBeCloseTo(0)
    expect(camera.pitch).toBeLessThanOrEqual(tiltLimit(height) - Math.PI / 2 + 0.01)
    if (height <= 0) {
      expect(Cartesian3.distance(camera.positionWC, destination)).toBeLessThan(1e-6)
      expect(camera.heading).toBeCloseTo(heading)
      if (pitch === -Math.PI / 2) expect(camera.pitch).toBeCloseTo(pitch)
    }
    // A subsequent frame must keep rendering with the corrected camera.
    expect(() => scene.preUpdate.raiseEvent()).not.toThrow()
  } finally {
    stop()
  }
})
