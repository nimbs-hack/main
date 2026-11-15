import { useEffect, useMemo, useState } from 'react'
import type { Site, Task } from '../api'
import { Button } from '../components/controls'
import { assessStart, DAYLIGHT_RESERVE, findWindows, sunriseHour } from '../data/eva-window'
import type { EvaWindow, Range } from '../data/eva-window'
import { loadEva, setEvaStart } from '../data/eva-storage'
import { distance } from '../data/geo'
import type { LatLon } from '../data/geo'
import { loadHud } from '../data/hud-snapshot'
import { formatSolarTime, localSolarTime, sunState } from '../data/mars-time'
import { DEFAULT_LIMITS } from '../data/plan'
import type { Verdict } from '../data/plan'
import { OBSERVATIONS } from '../data/science-observations'
import { fetchSpaceWeather, formatWhen, strength } from '../data/space-weather'
import type { SpaceWeather } from '../data/space-weather'
import { ageDays, celsius, fetchWeather, formatAge, STATIONS } from '../data/weather'
import type { Report } from '../data/weather'
import { formatDuration } from '../data/duration'
import { formatLatLon } from '../format.js'
import { num } from '../numbers'

// Best time to start the mission's EVA: the Sun from the Mars24 algorithm,
// temperatures estimated from the nearest rover station, CMEs from DONKI.

const SOLS = 7
const STALE_DAYS = 30
// Ten minutes, the search step. `now` is rounded to it so the search reruns at most that often.
const TICK = 600_000

const RAD = OBSERVATIONS.find((o) => o.id === 'curiosity-rad-2012-2013')!
const DOSE_RATE = RAD.measurements[0]!.value

type Load<T> = { status: 'loading' } | { status: 'ready', data: T } | { status: 'error' }

const LEVEL: Record<Verdict, string | undefined> = { go: undefined, caution: 'is-caution', 'no-go': 'is-hazard' }

const temp = (r: Range | null) => (r ? `${Math.round(celsius(r.min))} to ${Math.round(celsius(r.max))} °C` : 'No data')
const day = (utc: number) => formatWhen(new Date(utc).toISOString()).split(' ').slice(0, 2).join(' ')
const clock = (utc: number) => formatWhen(new Date(utc).toISOString()).replace(' UTC', '')
const percent = (hours: number) => `${(Math.max(0, Math.min(24, hours)) / 24) * 100}%`

// What the EVA is: the assessed route if there is one, else a mission site and its EVA tasks.
function subject(missionId: string, sites: Site[], tasks: Task[], selectedSite: number) {
  const hud = loadHud(missionId)
  const route = hud?.route
  if (route) {
    const point = route.samples[0]!.point
    return {
      point,
      duration: route.total,
      text: `Route from ${route.startName ?? formatLatLon(...point)}, ${formatDuration(route.total)} out and back${hud.status === 'ready' ? '' : ', as last assessed'}`,
    }
  }
  const evaSite = tasks.find((task) => task.eva)?.site
  const index = selectedSite >= 0 ? selectedSite : (evaSite ?? 0)
  const site = sites[index]
  if (!site) return null
  const hours = tasks.filter((task) => task.eva && task.site === index).reduce((sum, task) => sum + task.hours, 0)
  const duration = hours > 0 ? hours * 3600 : DEFAULT_LIMITS.eva
  return {
    point: [site.lat, site.lon] as LatLon,
    duration,
    text: `${site.name}, ${formatDuration(duration)} of ${hours > 0 ? 'EVA tasks' : 'EVA, the default budget'}. Plan a route on Sites for its real time.`,
  }
}

// One sol on a 24-hour local solar time track: daylight, the window, CMEs and now.
function Track({ lat, lon, at, w, now, planned, cmes, span }: {
  lat: number
  lon: number
  at: number
  w: EvaWindow | null
  now: number
  planned: number | null
  cmes: { at: number, full: boolean }[]
  // UTC range this row covers, for placing now, the planned start and CMEs.
  span: [number, number]
}) {
  const rise = sunriseHour(lat, sunState(at).declination)
  const within = (t: number) => t >= span[0] && t < span[1]
  return (
    <span className="evatime__track" aria-hidden="true">
      <span className="evatime__day" style={{ left: percent(rise), right: percent(rise) }} />
      {w && (
        <span
          className={`evatime__window ${LEVEL[w.verdict] ?? ''}`}
          style={{ left: percent(w.startSolar), width: percent(Math.max(0.25, w.endSolar - w.startSolar)) }}
        />
      )}
      {within(now) && <span className="evatime__now" style={{ left: percent(localSolarTime(now, lon)) }} />}
      {planned !== null && within(planned) && (
        <span className="evatime__planned" style={{ left: percent(localSolarTime(planned, lon)) }} />
      )}
      {cmes.filter((c) => within(c.at)).map((c) => (
        <span key={c.at} className={`evatime__cme ${c.full ? 'is-hazard' : 'is-caution'}`} style={{ left: percent(localSolarTime(c.at, lon)) }}>
          {c.full ? '▲' : '△'}
        </span>
      ))}
    </span>
  )
}

export function EvaTime({ missionId, sites, tasks, selectedSite }: {
  missionId: string
  sites: Site[]
  tasks: Task[]
  selectedSite: number
}) {
  // Read on every render: the Sites page may have changed the route or the start.
  const eva = subject(missionId, sites, tasks, selectedSite)
  const planned = loadEva(missionId).plan.when ?? null
  // Bumped after setting the start, to read it back.
  const [, reread] = useState(0)

  const now = Math.floor(Date.now() / TICK) * TICK
  const [retry, setRetry] = useState(0)
  const [space, setSpace] = useState<Load<SpaceWeather>>({ status: 'loading' })
  const [weather, setWeather] = useState<Load<{ report: Report, distance: number }> | null>(null)

  useEffect(() => {
    const abort = new AbortController()
    setSpace({ status: 'loading' })
    fetchSpaceWeather(abort.signal).then(
      (data) => setSpace({ status: 'ready', data }),
      () => !abort.signal.aborted && setSpace({ status: 'error' }),
    )
    return () => abort.abort()
  }, [retry])

  const lat = eva?.point[0]
  const lon = eva?.point[1]
  useEffect(() => {
    if (lat === undefined || lon === undefined) {
      setWeather(null)
      return
    }
    const abort = new AbortController()
    setWeather({ status: 'loading' })
    // The rover positions live with the traverse files, which stay out of the main bundle.
    import('../data/sites.js').then(({ SITES }) => {
      const near = STATIONS.map(({ id, siteId }) => {
        const position = SITES.find((s) => s.id === siteId)!.traverse!.position as LatLon
        return { id, distance: distance([lat, lon], position) }
      }).sort((a, b) => a.distance - b.distance)[0]!
      return fetchWeather(near.id, abort.signal).then((report) => setWeather({ status: 'ready', data: { report, distance: near.distance } }))
    }).catch(() => !abort.signal.aborted && setWeather({ status: 'error' }))
    return () => abort.abort()
  }, [lat, lon, retry])

  const reading = weather?.status === 'ready' ? weather.data.report.latest : null
  const forecast = space.status === 'ready' ? space.data : null
  const duration = eva?.duration
  const input = useMemo(
    () => (lat === undefined || lon === undefined || duration === undefined ? null : { point: [lat, lon] as LatLon, duration, now, reading, space: forecast }),
    [lat, lon, duration, now, reading, forecast],
  )
  const search = useMemo(() => (input ? findWindows({ ...input, sols: SOLS }) : null), [input])
  const plannedAt = planned ? Date.parse(planned) : NaN
  const plannedWindow = useMemo(
    () => (input && Number.isFinite(plannedAt) && plannedAt > now ? assessStart(input, plannedAt) : null),
    [input, plannedAt, now],
  )

  const [picked, setPicked] = useState<number | null>(null)
  if (!eva || !search || !input) {
    return (
      <section>
        <h2 className="planner__title">Best EVA start</h2>
        <p className="note">Add a site or plan a route on the Sites page to find the best start.</p>
      </section>
    )
  }

  const options = [plannedWindow, ...search.sols.map((s) => s.best)].filter((w): w is EvaWindow => w !== null)
  const chosen = options.find((w) => w.start === picked) ?? search.best ?? plannedWindow
  const cmes = (forecast?.arrivals ?? []).map((a) => ({ at: Date.parse(a.arrival), full: strength(a) === 'full' }))
  const report = weather?.status === 'ready' ? weather.data.report : null
  const age = reading ? ageDays(reading) : null
  const stale = age !== null && age > STALE_DAYS
  const half = 44_388_000 // half a sol
  const isPlanned = chosen !== null && Number.isFinite(plannedAt) && chosen.start === plannedAt

  const row = (key: string, label: string, w: EvaWindow | null, at: number, best: boolean) => (
    <li key={key}>
      <button
        type="button"
        className="evatime__row"
        aria-pressed={w !== null && w === chosen}
        disabled={!w}
        onClick={() => w && setPicked(w.start)}
        title={w ? `${clock(w.start)} to ${clock(w.end)} UTC, ${formatSolarTime(w.startSolar)} to ${formatSolarTime(w.endSolar)} local solar time${w.reasons.length ? `. ${w.reasons.map((r) => r.text).join('. ')}` : ''}` : undefined}
      >
        <span className="evatime__date">{label}</span>
        <Track lat={input.point[0]} lon={input.point[1]} at={at} w={w} now={now} planned={Number.isFinite(plannedAt) ? plannedAt : null} cmes={cmes} span={[at - half, at + half]} />
        <span className={`evatime__time ${w ? (LEVEL[w.verdict] ?? '') : ''}`}>
          {w ? clock(w.start).split(' ').at(-1) : 'No daylight'}
          {best && <span className="evatime__best"> best</span>}
        </span>
      </button>
    </li>
  )

  return (
    <section className="evatime" aria-label="Best EVA start">
      <h2 className="planner__title">Best EVA start</h2>
      <p className="note">{eva.text}</p>

      {chosen ? (
        <div className="review__grid">
          <div className="figure">
            <span className="readout__label">Start, UTC</span>
            <span className={`readout__value ${LEVEL[chosen.verdict] ?? ''}`}>{clock(chosen.start)}</span>
            <span className="readout__sub">{formatSolarTime(chosen.startSolar)} local solar time</span>
          </div>
          <div className="figure">
            <span className="readout__label">Back by, UTC</span>
            <span className="readout__value">{clock(chosen.end)}</span>
            <span className="readout__sub">{formatSolarTime(chosen.endSolar)} local solar time</span>
          </div>
        </div>
      ) : (
        <p className="note">No start in the next {SOLS} sols keeps the Sun up to an hour after the end. Shorten the EVA.</p>
      )}

      <div className="evatime__chart">
        <ol className="evatime__sols" aria-label="Best start each sol">
          {plannedWindow && row('planned', 'Planned', plannedWindow, plannedWindow.start, false)}
          {search.sols.map((s) => row(String(s.sol), day(s.noon), s.best, s.noon, s.best !== null && s.best === search.best))}
        </ol>
        <div className="evatime__axis" aria-hidden="true">
          <span />
          <span className="evatime__ticks">
            {[0, 6, 12, 18, 24].map((h) => <span key={h} style={{ left: percent(h) }}>{String(h).padStart(2, '0')}</span>)}
          </span>
          <span>Local solar</span>
        </div>
        <ul className="evatime__key">
          <li><span className="evatime__swatch evatime__swatch--day" />Daylight</li>
          <li><span className="evatime__swatch evatime__swatch--chosen" />Shown below</li>
          <li><span className="evatime__swatch evatime__swatch--other" />Best that sol</li>
          <li><span className="evatime__swatch evatime__swatch--now" />Now</li>
          {Number.isFinite(plannedAt) && <li><span className="evatime__swatch evatime__swatch--planned" />Planned start</li>}
          {cmes.length > 0 && <li><span className="is-hazard">▲</span> CME at Mars, <span className="is-caution">△</span> glancing</li>}
        </ul>
      </div>

      {chosen && chosen.reasons.length > 0 && (
        <ul className="evatime__reasons">
          {chosen.reasons.map((r) => (
            <li key={r.text} className={r.level === 'no-go' ? 'is-hazard' : 'is-caution'}>{r.text}</li>
          ))}
        </ul>
      )}

      {chosen && (
        <dl className="facts evatime__facts">
          <dt>Sun</dt>
          <dd>{Math.round(chosen.sun.min)}° to {Math.round(chosen.sun.max)}° up</dd>
          <dt>Daylight after the end</dt>
          <dd className={chosen.daylightLeft < DAYLIGHT_RESERVE ? 'is-caution' : undefined}>{formatDuration(Math.max(0, chosen.daylightLeft) / 1000)}</dd>
          <dt>Station</dt>
          <dd className={stale ? 'is-caution' : undefined} title={report && weather?.status === 'ready' ? `${report.site}, ${num(weather.data.distance / 1000)} km from the start. Latest sol ${reading?.date ?? ''}, ${formatAge(age)}. Every sol below uses this reading.${report.stale ? ' Feed down, showing the last copy.' : ''}` : undefined}>
            {weather?.status === 'ready' ? `${report!.rover} ${report!.instrument}${reading ? `, sol ${reading.sol}` : ''}` : weather?.status === 'error' ? 'Feed unavailable' : 'Loading'}
          </dd>
          <dt>Air, estimate</dt>
          <dd title="The station's latest low and high laid on a typical daily curve: coldest at sunrise, warmest at 14:00 local solar time. Not a forecast.">{temp(chosen.air)}</dd>
          <dt>Ground, infrared, estimate</dt>
          <dd title="From the station's infrared ground temperature sensor, low and high on a daily curve that peaks at 13:00 local solar time. Not a forecast.">{temp(chosen.ground)}</dd>
          <dt>Sky</dt>
          <dd>{reading?.opacity || 'No data'}</dd>
          <dt>UV index</dt>
          <dd title={`The station's daily UV index. UV is strongest with the Sun highest, ${Math.round(chosen.sun.max)}° in this window.`}>{reading?.uv || 'No data'}</dd>
          <dt>Pressure at station</dt>
          <dd>{reading?.pressurePa == null ? 'No data' : `${(reading.pressurePa / 100).toFixed(2)} hPa`}</dd>
          <dt>Wind</dt>
          <dd title="The public rover weather feeds carry no wind readings.">No data</dd>
          <dt>Radiation, quiet sun</dt>
          <dd title={`${num(DOSE_RATE * 1000, 2)} mSv a day, the Curiosity RAD mean for ${RAD.epoch}. The same at any hour. A solar particle event can raise it many times over.`}>
            {num(DOSE_RATE * 1000 * (input.duration / 86400), 3)} mSv
          </dd>
          <dt>Space weather</dt>
          <dd className={chosen.cmes.some((c) => strength(c) === 'full') ? 'is-hazard' : chosen.cmes.length ? 'is-caution' : undefined}>
            {space.status === 'loading' ? 'Loading' : !forecast ? 'No forecast' : chosen.cmes.length ? `CME ${formatWhen(chosen.cmes[0]!.arrival)}` : 'No CME forecast'}
          </dd>
        </dl>
      )}

      {(weather?.status === 'error' || space.status === 'error') && (
        <p className="note">
          {weather?.status === 'error' ? 'Station weather did not load, so temperatures, sky and UV are missing. ' : ''}
          {space.status === 'error' ? 'The CME forecast did not load, so no start can be cleared for space weather. ' : ''}
          <button type="button" onClick={() => setRetry((n) => n + 1)}>Retry</button>
        </p>
      )}

      {chosen && (
        <Button
          disabled={isPlanned}
          onClick={() => {
            const iso = new Date(chosen.start).toISOString().slice(0, 19) + 'Z'
            setEvaStart(missionId, iso)
            reread((n) => n + 1)
          }}
          title={isPlanned ? 'This is the EVA start on the Sites page' : 'Sets the Schedule start on the Sites page'}
        >
          Use as EVA start
        </Button>
      )}
    </section>
  )
}
