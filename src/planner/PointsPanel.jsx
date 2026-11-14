import { useState } from 'react'
import { DEFAULT_POINT_CLASSES } from './points'
import './points.css'

function ClassForm({ initial, onSave, onCancel }) {
  const [name, setName] = useState(initial?.name ?? '')
  const [color, setColor] = useState(initial?.color ?? DEFAULT_POINT_CLASSES[0].color)
  return <form className="points__form" onSubmit={(event) => {
    event.preventDefault()
    if (onSave(name, color) !== false) onCancel()
  }}>
    <div className="points__class-fields">
      <label>Class name<input required maxLength={28} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>Color<input type="color" value={color} onChange={(event) => setColor(event.target.value)} /></label>
    </div>
    <div className="points__actions">
      <button type="submit">{initial ? 'Save class' : 'Add class'}</button>
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
  </form>
}

function PointForm({ point, store, onClose }) {
  const [draft, setDraft] = useState(point)
  const field = (key) => (event) => setDraft((current) => ({ ...current, [key]: event.target.value }))
  return <form className="points__form" onSubmit={(event) => {
    event.preventDefault()
    if (store.updatePoint(point.id, { ...draft, lat: Number(draft.lat), lon: Number(draft.lon) })) onClose()
  }}>
    <label>Name<input required maxLength={64} value={draft.name} onChange={field('name')} /></label>
    <label>Class<select value={draft.classId} onChange={field('classId')}>
      {store.classes.map((cls) => <option key={cls.id} value={cls.id}>{cls.name}</option>)}
    </select></label>
    <div className="points__coordinates">
      <label>Latitude<input required type="number" min={-90} max={90} step="any" value={draft.lat} onChange={field('lat')} /></label>
      <label>Longitude<input required type="number" step="any" value={draft.lon} onChange={field('lon')} /></label>
    </div>
    <label>Notes<textarea rows={3} maxLength={280} value={draft.notes} onChange={field('notes')} /></label>
    <div className="points__actions">
      <button type="submit">Save point</button>
      <button type="button" onClick={onClose}>Cancel</button>
    </div>
  </form>
}

export function PointsPanel({ store, onPick, onFocus, onWaypoint }) {
  const [editingPointId, setEditingPointId] = useState(null)
  const [editingClassId, setEditingClassId] = useState(null)
  const [addingClass, setAddingClass] = useState(false)
  const [query, setQuery] = useState('')
  const classMap = new Map(store.classes.map((cls) => [cls.id, cls]))
  const search = query.trim().toLowerCase()
  const points = store.points.filter((point) => [point.name, point.notes, classMap.get(point.classId)?.name ?? '']
    .some((value) => value.toLowerCase().includes(search)))
  function setAllVisible(visible) {
    for (const cls of store.classes) {
      if (store.hiddenClassIds.includes(cls.id) === visible) store.toggleClass(cls.id)
    }
  }
  return <section className="points" aria-label="Saved points">
    <button type="button" className="points__pick" onClick={onPick}>Add point from map</button>
    {store.error && <p className="points__error" role="alert">{store.error}</p>}
    <div className="points__heading">
      <h3>Classes</h3>
      <div className="points__actions">
        <button type="button" onClick={() => setAllVisible(true)}>Show all</button>
        <button type="button" onClick={() => setAllVisible(false)}>Hide all</button>
        <button type="button" aria-expanded={addingClass} onClick={() => setAddingClass(!addingClass)}>New class</button>
      </div>
    </div>
    {addingClass && <ClassForm onSave={store.addClass} onCancel={() => setAddingClass(false)} />}
    <ul className="points__classes">
      {store.classes.map((cls) => {
        const count = store.points.filter((point) => point.classId === cls.id).length
        return <li key={cls.id}>
          <div className="points__class-row">
            <label className="points__visibility">
              <input type="checkbox" checked={!store.hiddenClassIds.includes(cls.id)} onChange={() => store.toggleClass(cls.id)} aria-label={`Show ${cls.name} points`} />
              <span className="points__swatch" style={{ backgroundColor: cls.color }} />
              <span>{cls.name} <span className="points__count">{count}</span></span>
            </label>
            <div className="points__actions">
              <button type="button" aria-label={`Edit ${cls.name} class`} aria-expanded={editingClassId === cls.id} onClick={() => setEditingClassId(editingClassId === cls.id ? null : cls.id)}>Edit</button>
              <button type="button" aria-label={`Delete ${cls.name} class`} disabled={count > 0 || store.classes.length === 1}
                title={count > 0 ? 'Move or delete these points first' : store.classes.length === 1 ? 'Keep at least one class' : `Delete ${cls.name}`}
                onClick={() => store.removeClass(cls.id)}>Delete</button>
            </div>
          </div>
          {editingClassId === cls.id && <ClassForm initial={cls} onSave={(name, color) => store.updateClass(cls.id, { name, color })} onCancel={() => setEditingClassId(null)} />}
        </li>
      })}
    </ul>
    <div className="points__heading"><h3>Saved points</h3><span className="points__count">{store.visiblePoints.length} of {store.points.length} shown</span></div>
    {store.points.length > 0 && <label className="points__search">Search points<input type="search" placeholder="Name, class, or notes" value={query} onChange={(event) => setQuery(event.target.value)} /></label>}
    {store.points.length === 0 && <p>No saved points. Use Add point from map to place one.</p>}
    {store.points.length > 0 && points.length === 0 && <p>No points match this search.</p>}
    <div className="points__list">
      {points.map((point) => {
        const cls = classMap.get(point.classId)
        const hidden = store.hiddenClassIds.includes(point.classId)
        return <article key={point.id} className="points__card">
          <div className="points__point-heading"><span className="points__swatch" style={{ backgroundColor: cls?.color }} /><h4>{point.name}</h4>{hidden && <span className="points__count">Hidden</span>}</div>
          <p className="points__class-name">{cls?.name}</p>
          {point.notes && <p className="points__notes">{point.notes}</p>}
          <p className="points__location">Lat {point.lat.toFixed(5)}° · Lon {point.lon.toFixed(5)}° E</p>
          <div className="points__actions">
            <button type="button" onClick={() => onFocus(point)}>Focus</button>
            <button type="button" onClick={() => onWaypoint('a', point)}>Set A</button>
            <button type="button" onClick={() => onWaypoint('b', point)}>Set B</button>
            <button type="button" onClick={() => onWaypoint('stop', point)}>Add stop</button>
            <button type="button" aria-expanded={editingPointId === point.id} onClick={() => setEditingPointId(editingPointId === point.id ? null : point.id)}>Edit</button>
            <button type="button" aria-label={`Delete ${point.name}`} onClick={() => store.removePoint(point.id)}>Delete</button>
          </div>
          {editingPointId === point.id && <PointForm point={point} store={store} onClose={() => setEditingPointId(null)} />}
        </article>
      })}
    </div>
  </section>
}

export default PointsPanel
