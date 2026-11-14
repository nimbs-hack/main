import { describe, expect, test } from 'bun:test'
import { createPointStore, DEFAULT_POINT_CLASSES, parsePointState, POINTS_STORAGE_KEY } from './points'

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }
}
const create = (storage) => createPointStore(() => storage)

describe('saved points', () => {
  test('persists point and class CRUD, notes, coordinates, and visibility across reloads', () => {
    const storage = memoryStorage()
    const store = create(storage)
    expect(store.getSnapshot().classes).toEqual(DEFAULT_POINT_CLASSES)
    const cls = store.addClass('  Rover relays  ', '#60A5FA')
    const point = store.addPoint({ lat: 18.4, lon: 282.5 })
    expect(point).toMatchObject({ name: 'Point 1', lat: 18.4, lon: -77.5, classId: 'science', notes: '' })
    expect(store.updatePoint(point.id, { name: 'Relay 1', classId: cls.id, notes: '  Check antenna  ' })).toBe(true)
    expect(store.updateClass(cls.id, { name: 'Relays', color: '#3fb68b' })).toBe(true)
    store.toggleClass(cls.id)
    let loaded = create(storage)
    expect(loaded.getSnapshot().points).toEqual([{ ...point, name: 'Relay 1', classId: cls.id, notes: 'Check antenna' }])
    expect(loaded.getSnapshot().classes.at(-1)).toEqual({ id: cls.id, name: 'Relays', color: '#3fb68b' })
    expect(loaded.getSnapshot().visiblePoints).toEqual([])
    expect(loaded.getSnapshot().hiddenClassIds).toEqual([cls.id])
    loaded.toggleClass(cls.id)
    expect(loaded.getSnapshot().visiblePoints).toHaveLength(1)
    loaded.removePoint(point.id)
    loaded.removeClass(cls.id)
    loaded = create(storage)
    expect(loaded.getSnapshot().points).toEqual([])
    expect(loaded.getSnapshot().classes.some((item) => item.id === cls.id)).toBe(false)
    expect(loaded.getSnapshot().hiddenClassIds).toEqual([])
  })

  test('migrates reference planner storage without overwriting it', () => {
    const legacy = JSON.stringify({
      classes: [{ id: 'relay', name: 'Relay', color: '#60a5fa', shortCode: 'RLY', icon: 'marker' }],
      points: [{ id: 'pt-1', name: 'Antenna', classId: 'relay', description: 'Line of sight', coord: { lat: -4.5, lon: 222 } }],
      hiddenClassIds: ['relay'],
    })
    const storage = memoryStorage({ 'nimbs.mars-map-points.v1': legacy })
    const store = create(storage)
    expect(store.getSnapshot().classes).toHaveLength(6)
    expect(store.getSnapshot().points).toEqual([{ id: 'pt-1', name: 'Antenna', classId: 'relay', notes: 'Line of sight', lat: -4.5, lon: -138 }])
    store.updatePoint('pt-1', { notes: 'Updated' })
    expect(storage.getItem('nimbs.mars-map-points.v1')).toBe(legacy)
    expect(create(storage).getSnapshot().points[0].notes).toBe('Updated')
  })

  test('rejects invalid edits without changing or saving records', () => {
    const storage = memoryStorage()
    const store = create(storage)
    const point = store.addPoint({ lat: 0, lon: 0 })
    const saved = storage.getItem(POINTS_STORAGE_KEY)
    for (const patch of [{ name: '' }, { lat: 91 }, { lon: Infinity }, { classId: 'missing' }, { notes: 42 }, { notes: 'x'.repeat(281) }]) {
      expect(store.updatePoint(point.id, patch)).toBe(false)
      expect(storage.getItem(POINTS_STORAGE_KEY)).toBe(saved)
      expect(store.getSnapshot().points).toEqual([point])
      expect(store.getSnapshot().error).not.toBe('')
    }
    expect(store.addPoint({ lat: NaN, lon: 0 })).toBe(false)
    expect(store.addPoint({ lat: 0, lon: '12' })).toBe(false)
    expect(store.addClass('Bad color', 'red')).toBe(false)
    expect(store.updatePoint(point.id, { id: 'changed', name: 'Renamed' })).toBe(true)
    expect(store.getSnapshot().points[0].id).toBe(point.id)
    expect(store.getSnapshot().error).toBe('')
  })

  test('prevents orphaned points and preserves class deletions on reload', () => {
    const storage = memoryStorage()
    const store = create(storage)
    const point = store.addPoint({ lat: 0, lon: 0 })
    expect(store.removeClass(point.classId)).toBe(false)
    store.updatePoint(point.id, { classId: 'sample' })
    store.toggleClass('science')
    expect(store.removeClass('science')).toBe(true)
    expect(create(storage).getSnapshot().classes.some((cls) => cls.id === 'science')).toBe(false)
    expect(create(storage).getSnapshot().hiddenClassIds).toEqual([])
    for (const id of ['habitat', 'supply', 'hazard']) store.removeClass(id)
    store.removePoint(point.id)
    expect(store.removeClass('sample')).toBe(false)
    expect(store.getSnapshot().classes).toHaveLength(1)
  })

  test('filters malformed and duplicate stored records and repairs unknown classes', () => {
    const raw = JSON.stringify({
      classes: [{ id: 'custom', name: 'Custom', color: '#123456' }, { id: 'custom', name: 'Duplicate', color: '#abcdef' }, null],
      points: [
        { id: 'valid', name: 'Valid', lat: 0, lon: 360, classId: 'gone' },
        { id: 'valid', name: 'Duplicate', lat: 5, lon: 5 },
        { id: 'bad', name: 'Bad latitude', lat: 91, lon: 0 },
        { id: 'missing', name: 'No coordinates' },
      ], hiddenClassIds: ['custom', 'custom', 'gone'],
    })
    expect(parsePointState(raw)).toEqual({
      classes: [{ id: 'custom', name: 'Custom', color: '#123456' }],
      points: [{ id: 'valid', name: 'Valid', lat: 0, lon: 0, classId: 'custom', notes: '' }],
      hiddenClassIds: ['custom'],
    })
  })

  test('reports corrupt or blocked storage and keeps unsaved edits in memory', () => {
    const storage = memoryStorage({ [POINTS_STORAGE_KEY]: '{broken' })
    const corrupt = create(storage)
    expect(corrupt.getSnapshot().error).toContain('could not be loaded')
    expect(storage.getItem(POINTS_STORAGE_KEY)).toBe('{broken')
    const inaccessible = createPointStore(() => { throw new Error('SecurityError') })
    expect(inaccessible.getSnapshot().error).not.toBe('')
    expect(inaccessible.addPoint({ lat: 1, lon: 2 })).toBeTruthy()
    expect(inaccessible.getSnapshot().points).toHaveLength(1)
    expect(inaccessible.getSnapshot().error).toContain('only in this tab')
    const quota = create({ ...memoryStorage(), setItem() { throw new Error('QuotaExceededError') } })
    const point = quota.addPoint({ lat: 1, lon: 2 })
    expect(quota.getSnapshot().visiblePoints).toEqual([point])
    expect(quota.getSnapshot().error).toContain('could not save')
  })

  test('successive actions use current state and publish stable snapshots', () => {
    const store = create(memoryStorage())
    const initial = store.getSnapshot()
    expect(store.getSnapshot()).toBe(initial)
    let notifications = 0
    const unsubscribe = store.subscribe(() => { notifications++ })
    const a = store.addPoint({ lat: 1, lon: 2 })
    const b = store.addPoint({ lat: 3, lon: 4 })
    expect(a.id).not.toBe(b.id)
    expect(b.name).toBe('Point 2')
    store.removePoint(a.id)
    const c = store.addPoint({ lat: 5, lon: 6 })
    expect(c.name).not.toBe(b.name)
    for (const cls of store.getSnapshot().classes) store.toggleClass(cls.id)
    expect(store.getSnapshot().visiblePoints).toEqual([])
    expect(notifications).toBe(9)
    unsubscribe()
    store.toggleClass('science')
    expect(notifications).toBe(9)
    expect(initial.points).toEqual([])
    expect(store.getSnapshot().visiblePoints).toHaveLength(2)
  })
})
