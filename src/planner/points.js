import { useState, useSyncExternalStore } from 'react'
import { normalizeLon180 } from '../../packages/shared/src/coords'

export const POINTS_STORAGE_KEY = 'nimbs.mars-map-points.v2'
const LEGACY_STORAGE_KEY = 'nimbs.mars-map-points.v1'
export const DEFAULT_POINT_CLASSES = [
  { id: 'science', name: 'Science target', color: '#38bdf8' },
  { id: 'sample', name: 'Sample cache', color: '#a855f7' },
  { id: 'habitat', name: 'Habitat / base', color: '#3fb68b' },
  { id: 'supply', name: 'Depot / power', color: '#eab308' },
  { id: 'hazard', name: 'Terrain hazard', color: '#f59e0b' },
]

const defaults = () => ({ classes: DEFAULT_POINT_CLASSES.map((item) => ({ ...item })), points: [], hiddenClassIds: [] })
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value) => typeof value === 'string' ? value.trim() : ''
const validColor = (value) => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value)

function coordinates(coord) {
  if (!coord || !Number.isFinite(coord.lat) || !Number.isFinite(coord.lon) || Math.abs(coord.lat) > 90) {
    throw new Error('Enter a latitude from -90 to 90 and a finite longitude.')
  }
  // Planetocentric latitude, east-positive longitude in [-180, 180).
  return { lat: coord.lat, lon: normalizeLon180(coord.lon) }
}

function pointClass(value, id) {
  const name = text(value.name)
  if (!name || name.length > 28) throw new Error('Use a class name of 1 to 28 characters.')
  if (!validColor(value.color)) throw new Error('Choose a six-digit hex color.')
  return { id, name, color: value.color.toLowerCase() }
}

function pointRecord(value, id, classes) {
  const name = text(value.name)
  if (!name || name.length > 64) throw new Error('Use a point name of 1 to 64 characters.')
  if (!classes.some((item) => item.id === value.classId)) throw new Error('Choose an existing class.')
  if (typeof value.notes !== 'string' || value.notes.length > 280) throw new Error('Keep notes to 280 characters.')
  return { id, name, ...coordinates(value), classId: value.classId, notes: value.notes.trim() }
}

/** Read our compact records or migrate the reference planner's coord/description fields. */
export function parsePointState(raw, legacy = false) {
  if (raw === null) return defaults()
  const parsed = JSON.parse(raw)
  if (!record(parsed) || !Array.isArray(parsed.classes) || !Array.isArray(parsed.points)) {
    throw new Error('Saved points could not be read.')
  }
  const classes = legacy ? defaults().classes : []
  const classIds = new Set(classes.map((item) => item.id))
  for (const item of parsed.classes) {
    if (!record(item) || !text(item.id) || classIds.has(text(item.id))) continue
    try {
      classes.push(pointClass(item, text(item.id)))
      classIds.add(text(item.id))
    } catch { /* Skip malformed stored records without discarding valid neighbors. */ }
  }
  if (!classes.length) classes.push(...defaults().classes)
  const points = []
  const pointIds = new Set()
  for (const item of parsed.points) {
    if (!record(item) || !text(item.id) || pointIds.has(text(item.id))) continue
    try {
      const point = pointRecord({
        ...item,
        ...(legacy ? item.coord : {}),
        notes: legacy ? (item.description ?? '') : (item.notes ?? ''),
        classId: classes.some((cls) => cls.id === item.classId) ? item.classId : classes[0].id,
      }, text(item.id), classes)
      points.push(point)
      pointIds.add(point.id)
    } catch { /* Invalid coordinates must never reach the map. */ }
  }
  const hiddenClassIds = [...new Set(Array.isArray(parsed.hiddenClassIds) ? parsed.hiddenClassIds : [])]
    .filter((id) => classes.some((item) => item.id === id))
  return { classes, points, hiddenClassIds }
}

/** The hook and persistence tests share this store. Actions return false on validation failure. */
export function createPointStore(getStorage = () => window.localStorage) {
  let state = defaults()
  let error = ''
  try {
    const storage = getStorage()
    const current = storage.getItem(POINTS_STORAGE_KEY)
    state = current === null ? parsePointState(storage.getItem(LEGACY_STORAGE_KEY), true) : parsePointState(current)
  } catch {
    error = 'Saved points could not be loaded. New edits stay in this tab until storage is available.'
  }
  const listeners = new Set()
  const snapshot = () => ({ ...state, visiblePoints: state.points.filter((point) => !state.hiddenClassIds.includes(point.classId)), error })
  let current = snapshot()
  function publish() {
    current = snapshot()
    listeners.forEach((listener) => listener())
  }
  function change(update) {
    let next
    try { next = update(state) } catch (failure) {
      error = failure.message
      publish()
      return false
    }
    state = next
    try {
      getStorage().setItem(POINTS_STORAGE_KEY, JSON.stringify(state))
      error = ''
    } catch {
      error = 'Changes are only in this tab. Browser storage could not save them.'
    }
    publish()
    return true
  }
  const actions = {
    addPoint(coord) {
      let added
      const ok = change((state) => {
        let number = state.points.length + 1
        while (state.points.some((point) => point.name === `Point ${number}`)) number++
        added = pointRecord({ ...coord, name: `Point ${number}`, classId: state.classes[0].id, notes: '' }, crypto.randomUUID(), state.classes)
        return { ...state, points: [...state.points, added] }
      })
      return ok ? added : false
    },
    updatePoint(id, patch) {
      return change((state) => {
        const point = state.points.find((item) => item.id === id)
        if (!point) throw new Error('This point no longer exists.')
        const updated = pointRecord({ ...point, ...patch }, id, state.classes)
        return { ...state, points: state.points.map((item) => item.id === id ? updated : item) }
      })
    },
    removePoint(id) { return change((state) => ({ ...state, points: state.points.filter((point) => point.id !== id) })) },
    addClass(name, color) {
      let added
      const ok = change((state) => {
        added = pointClass({ name, color }, crypto.randomUUID())
        return { ...state, classes: [...state.classes, added] }
      })
      return ok ? added : false
    },
    updateClass(id, patch) {
      return change((state) => {
        const cls = state.classes.find((item) => item.id === id)
        if (!cls) throw new Error('This class no longer exists.')
        const updated = pointClass({ ...cls, ...patch }, id)
        return { ...state, classes: state.classes.map((item) => item.id === id ? updated : item) }
      })
    },
    removeClass(id) {
      return change((state) => {
        if (state.classes.length === 1) throw new Error('Keep at least one class for new points.')
        if (state.points.some((point) => point.classId === id)) throw new Error('Move or delete the points in this class first.')
        return { ...state, classes: state.classes.filter((item) => item.id !== id), hiddenClassIds: state.hiddenClassIds.filter((item) => item !== id) }
      })
    },
    toggleClass(id) {
      return change((state) => {
        if (!state.classes.some((item) => item.id === id)) throw new Error('This class no longer exists.')
        return { ...state, hiddenClassIds: state.hiddenClassIds.includes(id) ? state.hiddenClassIds.filter((item) => item !== id) : [...state.hiddenClassIds, id] }
      })
    },
  }
  return {
    getSnapshot: () => current,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    ...actions,
  }
}

export function usePoints() {
  const [store] = useState(() => createPointStore())
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const { getSnapshot, subscribe, ...actions } = store
  return { ...state, ...actions }
}

export default usePoints
