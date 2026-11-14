import { expect, test } from 'bun:test'
import { INITIAL_MAP_STATUS, mapStatusReducer, mapStatusText } from './map-status'

test('an empty tile queue cannot declare unloaded terrain ready', () => {
  const state = mapStatusReducer(INITIAL_MAP_STATUS, { type: 'progress', queued: 0 })
  expect(mapStatusText(state)).toBe('Loading terrain')
  expect(mapStatusText(mapStatusReducer(state, { type: 'terrain-ready' }))).toBe('View loaded')
})

test('background loading and queue completion do not hide a terrain failure', () => {
  let state = mapStatusReducer(INITIAL_MAP_STATUS, { type: 'failure', source: 'Terrain' })
  for (const queued of [6, 0]) {
    state = mapStatusReducer(state, { type: 'progress', queued })
    expect(mapStatusText(state)).toContain('Terrain unavailable or incomplete')
  }
})

test('independent failures stay visible without repeated tile-error messages', () => {
  let state = INITIAL_MAP_STATUS
  for (const source of ['CTX imagery', 'Terrain', 'CTX imagery'] as const) {
    state = mapStatusReducer(state, { type: 'failure', source })
  }
  expect(state.failures).toEqual(['CTX imagery', 'Terrain'])
  expect(mapStatusText(state)).toContain('CTX imagery, Terrain unavailable or incomplete')
})

test('retry starts loading again and can recover to a loaded view', () => {
  let state = mapStatusReducer(INITIAL_MAP_STATUS, { type: 'failure', source: 'CTX imagery' })
  state = mapStatusReducer(state, { type: 'reset' })
  expect(state.failures).toEqual([])
  expect(mapStatusText(state)).toBe('Loading terrain')
  state = mapStatusReducer(state, { type: 'terrain-ready' })
  state = mapStatusReducer(state, { type: 'progress', queued: 3 })
  expect(mapStatusText(state)).toBe('Loading map')
  state = mapStatusReducer(state, { type: 'progress', queued: 0 })
  expect(mapStatusText(state)).toBe('View loaded')
})
