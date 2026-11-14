import { useId } from 'react'
import './weather-panel.css'

const LIMITS = [
  { key: 'minTemp', setter: 'setMinTemp', label: 'Minimum air temperature', unit: '°C', min: -130, max: 10, step: 1, initial: -75 },
  { key: 'maxWind', setter: 'setMaxWind', label: 'Maximum wind', unit: 'm/s', min: 2, max: 35, step: 0.5, initial: 15 },
  { key: 'minPressure', setter: 'setMinPressure', label: 'Minimum pressure', unit: 'Pa', min: 400, max: 950, step: 5, initial: 650 },
  { key: 'maxPressureSwing', setter: 'setMaxPressureSwing', label: 'Maximum pressure swing', unit: 'Pa', min: 5, max: 100, step: 1, initial: 35 },
  { key: 'maxEvaHours', setter: 'setMaxEvaHours', label: 'Maximum EVA duration', unit: 'Earth h', min: 0.5, max: 12, step: 0.5, initial: 4 },
]
const CHECK_LABELS = { air_temp: 'Air temperature', wind_speed: 'Wind', pressure: 'Pressure', pressure_swing: 'Pressure swing', eva_duration: 'EVA duration' }
const SCENARIOS = [['auto', 'Auto'], ['nominal', 'Nominal'], ['dust-storm', 'Dust storm'], ['cold-snap', 'Cold snap']]
const number = (value, decimals = 1) => Number.isFinite(value) ? value.toFixed(decimals) : 'Unavailable'
const celsius = (value) => Number.isFinite(value) ? value - 273.15 : undefined

function clock(offset) {
  if (offset === 48) return '24:00'
  const minutes = Math.round(((offset % 24) + 24) % 24 * 60) % 1440
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}
function Status({ value }) {
  return <span className="weather-panel__status" data-status={value}>{value}</span>
}
function Readout({ label, value, unit, detail }) {
  return <div><dt>{label}</dt><dd>{value} <small>{unit}</small></dd>{detail && <dd className="weather-panel__muted">{detail}</dd>}</div>
}

// The hook owns requests and playback. Manual selections pause its timer.
export default function WeatherPanel({ planner: p }) {
  const id = useId()
  const response = p.weather?.result
  const snapshot = response?.weather
  const evaluation = response?.evaluation
  const current = response?.current ?? snapshot?.current ?? evaluation?.selectedHourWeather
  const error = p.weather?.error
  const loading = !response && !error
  const solOffset = p.hour >= 24 ? 1 : 0
  const forecast = solOffset ? snapshot?.nextSol : snapshot
  const baseSol = snapshot?.sol ?? p.sol
  const selectedSol = baseSol + solOffset
  const selectHour = (hour) => { p.setPlaying(false); p.setHour(hour) }
  const resetLimits = () => { p.setPlaying(false); LIMITS.forEach((spec) => p[spec.setter](spec.initial)) }

  return <section className="weather-panel" aria-labelledby={`${id}-title`}>
    <header className="weather-panel__heading">
      <h3 id={`${id}-title`}>Weather and EVA</h3>
      <button type="button" onClick={p.retryWeather} disabled={loading}>Recalculate</button>
    </header>
    <p>Simulated conditions, not live telemetry. Route filtering uses departure conditions; EVA checks follow the walk.</p>
    <div className="weather-panel__controls">
      <label>Scenario<select value={p.scenario} onChange={(event) => { p.setPlaying(false); p.setScenario(event.target.value) }}>
        {SCENARIOS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label>Base sol<input type="number" min={0} max={100000} step={1} value={p.sol} onChange={(event) => {
        if (event.target.value !== '' && event.target.validity.valid) { p.setPlaying(false); p.setSol(Number(event.target.value)) }
      }} /></label>
    </div>
    <div className="weather-panel__time">
      <div className="weather-panel__heading">
        <output htmlFor={`${id}-hour`}>Sol {selectedSol} · {clock(p.hour)} LMST</output>
        <button type="button" aria-pressed={p.playing} onClick={() => p.setPlaying(!p.playing)}>{p.playing ? 'Pause' : 'Play'}</button>
      </div>
      <label className="weather-panel__slider" htmlFor={`${id}-hour`}>Simulation time · 48 LMST hours
        <input id={`${id}-hour`} type="range" min={0} max={48} step={0.5} value={p.hour}
          aria-valuetext={`Sol ${selectedSol}, ${clock(p.hour)} LMST`} onChange={(event) => selectHour(Number(event.target.value))} />
      </label>
      <div className="weather-panel__axis"><span>00:00</span><span>12:00</span><span>Sol +1</span><span>12:00</span><span>24:00</span></div>
      <div className="weather-panel__jumps" role="group" aria-label="Quick jumps in selected sol">
        {[7, 12, 15, 22].map((hour) => <button type="button" key={hour} aria-pressed={p.hour === solOffset * 24 + hour}
          onClick={() => selectHour(solOffset * 24 + hour)}>{clock(hour)}</button>)}
      </div>
      <p className="weather-panel__muted">The timeline spans two sols, about 49.32 Earth hours. Walking durations use Earth hours.</p>
    </div>
    <details className="weather-panel__limits" open>
      <summary>Suit limits</summary>
      {LIMITS.map((spec) => <label className="weather-panel__slider" key={spec.key}>
        <span>{spec.label}<output>{number(p[spec.key], spec.step < 1 ? 1 : 0)} {spec.unit}</output></span>
        <input type="range" min={spec.min} max={spec.max} step={spec.step} value={p[spec.key] ?? spec.initial}
          onChange={(event) => { p.setPlaying(false); p[spec.setter](Number(event.target.value)) }} />
        <span className="weather-panel__bounds"><span>{spec.min} {spec.unit}</span><span>{spec.max} {spec.unit}</span></span>
      </label>)}
      <button type="button" onClick={resetLimits}>Reset limits</button>
    </details>
    {loading && <p role="status">Calculating weather and departure windows…</p>}
    {error && <div role="alert" className="weather-panel__error"><p>{String(error)}</p><button type="button" onClick={p.retryWeather}>Retry weather</button></div>}
    {snapshot && !error && <>
      <p className="weather-panel__muted">{snapshot.sourceLabel} · Ls {number(current?.lsDeg ?? snapshot.lsDeg)}°</p>
      {current && <>
        <h4>Conditions at {clock(current.offsetHours)} LMST · Sol {current.sol}</h4>
        <p>{current.isDaylight ? 'Daylight' : 'Night'} · Reference elevation {number(current.referenceElevationM, 0)} m</p>
        <dl className="weather-panel__readouts">
          <Readout label="Air temperature" value={number(celsius(current.tempK))} unit="°C" />
          <Readout label="Pressure" value={number(current.pressurePa, 0)} unit="Pa" />
          <Readout label="Wind" value={number(current.windSpeedMps)} unit="m/s" detail={forecast?.wind?.compassPoint} />
          <Readout label="UV index" value={number(current.uvIndex)} detail={`Dust opacity τ ${number(current.dustOpacityTau, 2)}`} />
          <Readout label="Solar irradiance" value={number(current.solarIrradianceWm2, 0)} unit="W/m²" />
          <Readout label="Pressure swing" value={number(forecast?.pressure?.swingPa)} unit="Pa" />
        </dl>
        {evaluation && <dl className="weather-panel__readouts">
          {[['Floor', evaluation.floorElevationM], ['Highest route elevation', evaluation.evaluationElevationM]].map(([label, elevation]) => {
            const delta = elevation - current.referenceElevationM
            return <Readout key={label} label={`${label} · ${number(elevation, 0)} m`}
              value={number(celsius(current.tempK - 0.0025 * delta))} unit="°C"
              detail={`${number(current.pressurePa * Math.exp(-delta / 10800), 0)} Pa · elevation model`} />
          })}
        </dl>}
        {forecast?.daylight && <p>Sunrise {forecast.daylight.sunriseLmst} · Sunset {forecast.daylight.sunsetLmst} LMST</p>}
      </>}
      <HourlyChart snapshot={snapshot} hour={p.hour} minTemp={p.minTemp} maxWind={p.maxWind} selectHour={selectHour} />
      {evaluation && <>
        <div className="weather-panel__heading"><h4>Daily evaluation</h4><Status value={evaluation.status} /></div>
        <p>{p.selected ? `${number(evaluation.estimatedRouteHours, 2)} Earth-hour walk on selected route.` : `${number(evaluation.estimatedRouteHours, 2)} Earth-hour example EVA. Select a route to evaluate its terrain.`}</p>
        <details><summary>Five weather checks</summary><ul className="weather-panel__checks">
          {evaluation.checks.map((check) => <li key={check.id}>
            <div className="weather-panel__heading"><strong>{CHECK_LABELS[check.id] ?? check.id}</strong><Status value={check.status} /></div>
            <p>{number(check.unit === 'K' ? celsius(check.measuredValue) : check.measuredValue)} {check.unit === 'K' ? '°C' : check.unit} · Limit {number(check.unit === 'K' ? celsius(check.limitValue) : check.limitValue)} {check.unit === 'K' ? '°C' : check.unit}</p>
            <p>{check.reason}</p>
          </li>)}
        </ul></details>
        {evaluation.safeWindow && <p>{evaluation.safeWindow.startLmstHour != null && evaluation.safeWindow.endLmstHour != null
          ? `Thermal and wind window: ${clock(evaluation.safeWindow.startLmstHour)} to ${evaluation.safeWindow.endLmstHour === 24 ? '24:00' : clock(evaluation.safeWindow.endLmstHour)} LMST, ${number(evaluation.safeWindow.durationHours, 2)} Earth h.`
          : 'No daylight interval meets the thermal and wind limits.'} Departure checks also include pressure and route duration.</p>}
        <Departures evaluation={evaluation} hour={p.hour} selectHour={selectHour} />
      </>}
      <details><summary>Model and source</summary><p>{snapshot.disclaimer}</p>
        <p>Walking estimate: 2.5 km/h, plus one hour per 350 m climbed and per 800 m descended. Stops and suit thermal balance are not modeled.</p>
        {snapshot.simulatedChannels?.length > 0 && <p>Modeled channels: {snapshot.simulatedChannels.join(', ')}.</p>}
      </details>
    </>}
  </section>
}

function HourlyChart({ snapshot, hour, minTemp, maxWind, selectHour }) {
  const secondSol = hour >= 24
  const forecast = secondSol ? snapshot.nextSol : snapshot
  const hourly = forecast?.hourly ?? []
  if (!hourly.length) return null
  const offset = secondSol ? 24 : 0
  const localHour = hour - offset
  const series = [
    { key: 'tempK', label: 'Temperature', unit: '°C', limit: minTemp, convert: celsius },
    { key: 'windSpeedMps', label: 'Wind', unit: 'm/s', limit: maxWind, convert: (value) => value },
  ]
  return <details className="weather-panel__hourly" open><summary>Hourly conditions · Sol {forecast.sol}</summary>
    {series.map((spec) => {
      const values = hourly.map((point) => spec.convert(point[spec.key]))
      const low = Math.min(...values, spec.limit) - 3
      const high = Math.max(...values, spec.limit) + 3
      const y = (value) => 82 - (value - low) / (high - low) * 68
      const x = (value) => 38 + value / 24 * 260
      const path = hourly.map((point, index) => `${index ? 'L' : 'M'}${x(point.lmstHour)},${y(values[index])}`).join(' ')
      return <figure key={spec.key} className="weather-panel__chart">
        <figcaption>{spec.label} · {number(Math.min(...values))} to {number(Math.max(...values))} {spec.unit}</figcaption>
        <svg viewBox="0 0 312 100" role="img" aria-label={`${spec.label} in ${spec.unit} across sol ${forecast.sol}; dashed line is the configured limit`}>
          <title>{`${spec.label}, sol ${forecast.sol}`}</title>
          <rect className="weather-panel__daylight" x={x(forecast.daylight.sunriseHour)} y="10" width={(forecast.daylight.sunsetHour - forecast.daylight.sunriseHour) / 24 * 260} height="76" />
          <text x="0" y="18">{number(high, 0)}</text><text x="0" y="84">{number(low, 0)}</text>
          <line className="weather-panel__threshold" x1="38" x2="298" y1={y(spec.limit)} y2={y(spec.limit)} />
          <path className="weather-panel__curve" d={path} />
          <line className="weather-panel__cursor" x1={x(localHour)} x2={x(localHour)} y1="10" y2="86" />
          <text x="38" y="99">00</text><text x="168" y="99">12</text><text x="298" y="99" textAnchor="end">24</text>
        </svg>
      </figure>
    })}
    <p className="weather-panel__muted">Dashed: limit · Shaded: daylight · Solid vertical: selected time</p>
    <div className="weather-panel__hours" role="group" aria-label={`Select hourly conditions for sol ${forecast.sol}`}>
      {hourly.map((point) => <button type="button" key={point.lmstHour} aria-pressed={hour === offset + point.lmstHour}
        aria-label={`Sol ${forecast.sol}, ${point.lmstLabel} LMST, ${number(celsius(point.tempK))} degrees Celsius, ${number(point.windSpeedMps)} meters per second wind`}
        title={`${number(celsius(point.tempK))} °C · ${number(point.pressurePa, 0)} Pa · ${number(point.windSpeedMps)} m/s`}
        onClick={() => selectHour(offset + point.lmstHour)}>{point.lmstLabel}</button>)}
    </div>
  </details>
}

function Departures({ evaluation, hour, selectHour }) {
  const slots = evaluation.departureSlots ?? []
  const windows = evaluation.recommendedWindows ?? []
  const selected = slots.find((slot) => Math.abs(slot.offsetHours - hour) < 0.001)
  return <div className="weather-panel__departures">
    <h4>Departure windows · 48 LMST hours</h4>
    <p>Daily checks use daily extremes. Each departure below follows conditions during the walk.</p>
    <div className="weather-panel__legend">{['GO', 'DEGRADED', 'NO-GO'].map((status) => <Status key={status} value={status} />)}</div>
    {[0, 1].map((solOffset) => {
      const group = slots.filter((slot) => slot.solOffset === solOffset)
      if (!group.length) return null
      return <details key={solOffset} open={Math.floor(Math.min(hour, 47.5) / 24) === solOffset}>
        <summary>Sol {group[0].sol} departures</summary>
        <div className="weather-panel__slots" role="group" aria-label={`Departure times for sol ${group[0].sol}`}>
          {group.map((slot) => <button type="button" key={slot.offsetHours} data-status={slot.status}
            aria-pressed={selected?.offsetHours === slot.offsetHours} onClick={() => selectHour(slot.offsetHours)}
            title={`${slot.status} · ${slot.reason}`} aria-label={`Depart sol ${slot.sol} at ${slot.startLmstLabel} LMST: ${slot.status}. ${slot.reason}`}>
            <span>{slot.startLmstLabel}</span><span className="weather-panel__slot-mark" aria-hidden="true" />
          </button>)}
        </div>
      </details>
    })}
    {selected ? <div className="weather-panel__departure-detail">
      <div className="weather-panel__heading"><strong>{selected.startLmstLabel} departure</strong><Status value={selected.status} /></div>
      <p>{number(selected.durationHours, 2)} Earth h · Arrival {selected.endLmstLabel} LMST · Score {number(selected.score, 0)}/100</p>
      <dl className="weather-panel__readouts">
        <Readout label="Temperature range" value={`${number(celsius(selected.minEncounteredTempK))} to ${number(celsius(selected.maxEncounteredTempK))}`} unit="°C" />
        <Readout label="Minimum pressure" value={number(selected.minEncounteredPressurePa, 0)} unit="Pa" />
        <Readout label="Maximum wind" value={number(selected.maxEncounteredWindMps)} unit="m/s" />
        <Readout label="Daylight during walk" value={number(selected.daylightFraction * 100, 0)} unit="%" detail={`Maximum UV ${number(selected.maxUvIndex)}`} />
      </dl><p>{selected.reason}</p>
    </div> : <p>No departure at this time. The forecast ends at 48 LMST hours.</p>}
    <h4>Recommended departures</h4>
    {windows.length === 0 ? <p>No departure meets the current limits. Review the NO-GO reasons or change the scenario and limits.</p>
      : <ol className="weather-panel__windows">{windows.map((window) => <li key={`${window.sol}-${window.startOffsetHours}-${window.status}`}>
        <button type="button" aria-pressed={hour === window.bestDepartureOffsetHours} onClick={() => selectHour(window.bestDepartureOffsetHours)}>
          <span className="weather-panel__heading"><strong>#{window.rank} · Sol {window.sol}</strong><Status value={window.status} /></span>
          <span>Depart {clock(window.startOffsetHours)} to {clock(window.endOffsetHours)} LMST</span>
          <strong>Use {window.bestDepartureLmst} LMST</strong>
          <span>{number(window.estimatedDurationHours, 2)} Earth h · Score {number(window.score, 0)}/100</span>
          <span className="weather-panel__muted">{window.summary}</span>
        </button>
      </li>)}</ol>}
  </div>
}
