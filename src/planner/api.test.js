import { expect, test } from 'bun:test'
import { formatHours, insideSite, routeProfile } from './api'
import { summarize } from '../data/route-profile'

test('waypoint bounds use planetocentric latitude and normalized east longitude', () => {
  const meta = { bbox: [77.2, 18.4, 77.6, 18.8] }
  expect(insideSite({ lat: 18.4, lon: 77.2 }, meta)).toBe(true)
  expect(insideSite({ lat: 18.9, lon: 77.4 }, meta)).toBe(false)
  expect(insideSite({ lat: NaN, lon: 77.4 }, meta)).toBe(false)
  expect(insideSite({ lat: 18.5, lon: 437.4 }, meta)).toBe(false)
})

test('planned profile preserves DEM grades and elevations rather than display terrain', () => {
  const samples = routeProfile({ points: [
    { lat: 18.5, lon: 77.3, distanceM: 0, elevationM: -2500, slopeDeg: 0 },
    { lat: 18.501, lon: 77.3, distanceM: 100, elevationM: -2480, slopeDeg: 11.3 },
  ] })
  expect(samples[1]).toEqual({ d: 100, point: [18.501, 77.3], elevation: -2480, slope: 11.3, layers: {} })
  expect(summarize(samples, 10).overLimit).toBe(100)
  expect(summarize(samples, 20).overLimit).toBe(0)
})

test('planned weather profile retains physical values at every vertex', () => {
  const samples = routeProfile({ points: [{ lat: 18.5, lon: 77.3, distanceM: 0, elevationM: -2500, slopeDeg: 0, tempC: -60.5, pressurePa: 750 }] })
  expect(samples[0].tempC).toBe(-60.5)
  expect(samples[0].pressurePa).toBe(750)
})

test('walk times read as hours and minutes', () => {
  expect(formatHours(0.25)).toBe('15 min')
  expect(formatHours(2)).toBe('2 h')
  expect(formatHours(1.425)).toBe('1 h 26 min')
  expect(formatHours(-0.1)).toBe('0 min')
})
