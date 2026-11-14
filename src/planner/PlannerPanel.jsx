import { useEffect, useState } from 'react'
import { formatDistance } from '../components/RouteProfile'
import { ROUTE_LABELS, formatHours } from './api'
import { MAX_VIA } from './usePlanner'
import './planner.css'
import WeatherPanel from './WeatherPanel'
import PointsPanel from './PointsPanel'

function Waypoint({ name, point, picking, onPick, onSubmit, bounds }) {
  const [lat, setLat] = useState('')
  const [lon, setLon] = useState('')
  useEffect(() => { setLat(point?.lat.toFixed(6) ?? ''); setLon(point?.lon.toFixed(6) ?? '') }, [point])
  return (
    <fieldset className="planner__waypoint">
      <legend>{name === 'a' ? 'A · Start' : 'B · Destination'}</legend>
      <button type="button" aria-pressed={picking} onClick={onPick}>{picking ? 'Click the map · Esc cancels' : 'Pick on map'}</button>
      <form onSubmit={(event) => { event.preventDefault(); onSubmit({ lat: Number(lat), lon: Number(lon) }) }}>
        <label>Latitude<input required type="number" step="any" min={bounds[1]} max={bounds[3]} value={lat} onChange={(event) => setLat(event.target.value)} /></label>
        <label>Longitude<input required type="number" step="any" min={bounds[0]} max={bounds[2]} value={lon} onChange={(event) => setLon(event.target.value)} /></label>
        <button type="submit" aria-label={`Set waypoint ${name.toUpperCase()}`}>Set</button>
      </form>
    </fieldset>
  )
}

function Stops({ planner: p }) {
  return (
    <fieldset className="planner__waypoint">
      <legend>Stops</legend>
      {p.via.length > 0 && <ol className="planner__stops">
        {p.via.map((point, i) => <li key={`${point.lat},${point.lon},${i}`}>
          <span>S{i + 1} · {point.lat.toFixed(4)}°, {point.lon.toFixed(4)}° E</span>
          <button type="button" aria-label={`Move S${i + 1} earlier`} disabled={i === 0} onClick={() => p.moveStop(i, -1)}>↑</button>
          <button type="button" aria-label={`Move S${i + 1} later`} disabled={i === p.via.length - 1} onClick={() => p.moveStop(i, 1)}>↓</button>
          <button type="button" aria-label={`Remove S${i + 1}`} onClick={() => p.removeStop(i)}>×</button>
        </li>)}
      </ol>}
      <button type="button" aria-pressed={p.picking === 'stop'} disabled={p.via.length >= MAX_VIA && p.picking !== 'stop'} onClick={() => p.setPicking(p.picking === 'stop' ? null : 'stop')}>
        {p.picking === 'stop' ? 'Click the map · Esc cancels' : p.via.length >= MAX_VIA ? `${MAX_VIA} stops maximum` : 'Add stop on map'}
      </button>
    </fieldset>
  )
}

function Slider({ label, value, unit, onChange, min, max, step = 1 }) {
  return (
    <label className="planner__slider">
      <span>{label}<output>{value}{unit}</output></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  )
}

// The planner owns controls; Cesium and the existing profile own visualization.
export default function PlannerPanel({ planner: p, onFocus, onFocusPoint }) {
  return (
    <section className={`planner${p.open ? ' is-open' : ''}`} aria-label="Route planner">
      <button type="button" className="planner__toggle" aria-expanded={p.open} aria-controls="planner-body" onClick={() => p.setOpen(!p.open)}>
        {p.open ? 'Close planner' : 'Plan route'}
      </button>
      {p.open && <div className="planner__body" id="planner-body">
        <nav className="planner__row" aria-label="Planner tools">{['route', 'weather', 'points', 'layers'].map(tab => <button type="button" key={tab} aria-pressed={p.tab === tab} onClick={() => p.setTab(tab)}>{tab[0].toUpperCase() + tab.slice(1)}</button>)}</nav>
        {p.site.status === 'loading' && <p role="status">Loading planning terrain…</p>}
        {p.site.status === 'error' && <p role="alert">{p.site.error} <button type="button" onClick={p.retry}>Retry</button></p>}
        {p.site.meta && <>
          <p>{p.site.meta.name} · {Math.round(p.site.meta.cellSizeMeters)} m DEM</p>
          <button type="button" className="planner__focus" onClick={onFocus}>Show planning area</button>
          {p.tab === 'route' && <>
          {['a', 'stops', 'b'].map((name) => name === 'stops' ? <Stops key={name} planner={p} /> : <Waypoint key={name} name={name} point={p.waypoints[name]} bounds={p.site.meta.bbox}
            picking={p.picking === name} onPick={() => p.setPicking(p.picking === name ? null : name)} onSubmit={(point) => p.putWaypoint(name, point)} />)}
          <label className="planner__check"><input type="checkbox" checked={p.roundTrip} onChange={(event) => p.setRoundTrip(event.target.checked)} />Return to A on the same path</label>
          <div className="planner__row">
            <button type="button" disabled={!p.waypoints.a && !p.waypoints.b} onClick={p.swap}>Swap A/B</button>
            <button type="button" disabled={!p.waypoints.a && !p.waypoints.b} onClick={p.clear}>Clear</button>
          </div>
          {p.pickError && <p role="alert">{p.pickError}</p>}
          <Slider label="Maximum slope" value={p.slope} unit="°" min={0} max={45} step={0.5} onChange={p.setSlope} />
          <label className="planner__check"><input type="checkbox" checked={p.weatherEnabled} onChange={(event) => p.setWeatherEnabled(event.target.checked)} />Filter routes by modeled weather</label>
          <button type="button" onClick={() => p.setTab('weather')}>Weather and EVA limits</button>
          {p.loading && <p role="status">Calculating routes…</p>}
          {p.error && <p role="alert">{p.error} <button type="button" onClick={p.retryRoute}>Retry</button></p>}
          {p.result?.status !== 'ok' && p.result && <div role="status" className="planner__blocked">
            <p>{p.result.message || 'No route meets these limits.'}</p>
            {p.result.minRequiredSlopeDeg !== undefined && <p>Minimum slope limit: {p.result.minRequiredSlopeDeg}°</p>}
            {p.result.maxFeasibleMinTempC !== undefined && <p>Temperature threshold needed: {p.result.maxFeasibleMinTempC.toFixed(1)} °C</p>}
            {p.result.maxFeasibleMinPressurePa !== undefined && <p>Pressure threshold needed: {Math.floor(p.result.maxFeasibleMinPressurePa)} Pa</p>}
          </div>}
          {p.routes.length > 0 && <div className="planner__routes" role="group" aria-label="Route alternatives">
            {p.routes.map((route) => <button type="button" key={route.id} aria-pressed={route.id === p.selected?.id} onClick={() => p.setSelectedId(route.id)}>
              <strong>{ROUTE_LABELS[route.strategy]}</strong>
              <span className={route.walkHours > p.maxEvaHours ? 'planner__over' : undefined}>{formatHours(route.walkHours)} walk{p.result.roundTrip ? ' round trip' : ''} · {route.walkHours > p.maxEvaHours ? `over ${p.maxEvaHours} h EVA limit` : `${formatHours(p.maxEvaHours - route.walkHours)} spare`}</span>
              <span>{formatDistance(route.totalDistanceM)} · {route.maxSlopeDeg.toFixed(1)}° max · +{Math.round(route.elevationGainM)} m</span><span>Mean slope {route.meanSlopeDeg.toFixed(1)}° · −{Math.round(route.elevationLossM)} m descent</span>
              {route.minTempC != null && <span>{route.minTempC.toFixed(1)} to {route.maxTempC.toFixed(1)} °C · {Math.round(route.minPressurePa)} to {Math.round(route.maxPressurePa)} Pa</span>}
            </button>)}
          </div>}
          </>}
          {p.tab === 'weather' && <WeatherPanel planner={p} />}
          {p.tab === 'points' && <><PointsPanel store={p.pointsStore} onPick={() => p.setPicking(p.picking === 'point' ? null : 'point')} onFocus={onFocusPoint} onWaypoint={(which, point) => { if (p.putWaypoint(which, point)) p.setTab('route') }} />{p.picking === 'point' && <p role="status">Click the map to save a point. Esc cancels.</p>}</>}
          {p.tab === 'layers' && <>
            <p>{p.site.meta.rows} × {p.site.meta.cols} DEM nodes · {Math.round(p.site.meta.minElevationM)} to {Math.round(p.site.meta.maxElevationM)} m elevation</p>
            {p.result && <p>{(p.result.passableEdgeRatio * 100).toFixed(1)}% of graph edges meet the route limits.</p>}
            {Object.entries(p.layers).map(([name, enabled]) => <label className="planner__check" key={name}><input type="checkbox" checked={enabled} onChange={event => p.setLayers(current => ({ ...current, [name]: event.target.checked }))} />{({hillshade:'DEM hillshade',slope:'Slope hazards',temperature:'Modeled temperature',pressure:'Modeled pressure'})[name]}</label>)}
            <label className="planner__check"><input type="checkbox" checked={p.showBounds} onChange={event => p.setShowBounds(event.target.checked)} />Planning boundary</label>
            <Slider label="Layer opacity" value={Math.round(p.opacity * 100)} unit="%" min={10} max={100} onChange={value => p.setOpacity(value / 100)} />
            <p>Slope: orange above the limit, yellow near it. Weather: blue to red from low to high; orange marks values below your limit. Missing data is transparent and blocks routing.</p>
            <p>Temperature scale: −120 to 0 °C. Pressure scale: 400 to 1,000 Pa. Weather layers are simulated.</p>
          </>}
          <p className="planner__note">{p.roundTrip ? 'Return retraces the outbound path.' : 'One-way routes.'} Walk time: 2.5 km/h plus 1 h per 350 m climbed and 800 m descended. Rates and limits are assumptions. Rocks, suit mobility, and radiation are not routing constraints.</p>
        </>}
      </div>}
    </section>
  )
}
