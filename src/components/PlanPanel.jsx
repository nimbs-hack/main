import { useEffect, useId, useRef, useState } from 'react'
import { distance } from '../data/geo'
import { DEFAULT_PRESET, PRESETS, formatDuration, presetFor } from '../data/plan'
import { slopeLevel } from '../data/route-profile'
import { SITES } from '../data/sites'
import { formatLatLon } from '../format'
import { formatDistance, formatSlope } from './RouteProfile'
import './plan-panel.css'

/*
 * EVA settings laid out like a 3D-printer slicer's settings panel. A site
 * block on top, then a limits block with a preset picker, an Advanced
 * switch and a search. The icon rail picks one tab of settings at a time,
 * and the tab shows only its own groups, so you focus on one concern.
 * Search looks across all tabs. A dot on a rail icon flags a tab with a
 * problem. The verdict and Walk it button sit in a dock at the bottom,
 * like Slice plate and Send print.
 *
 * Props:
 *   plan        { start, startName, target, waypoints } in [lat, lon] degrees
 *   limits      { slope °, pace m/s, eva s, work s, range m }
 *   assessment  result of assess() in src/data/plan.ts, or null
 *   status      profile sampling: 'idle' | 'loading' | 'ready' | 'error'
 *   placing     'start' | 'target' | 'waypoint' | null, what a map click does
 *   dose        { site, when, measurement } for the radiation reference
 *   onPlacing(mode), onSite(id), onRemoveWaypoint(index), onLimits(limits),
 *   onRetry(), onWalk(), onClear()
 *   onAddToMission  adds this EVA to the mission. Null while there is no
 *                   assessed route, undefined when no mission is open.
 *   missionSites    content of an extra rail tab, the mission's sites and
 *                   tasks. missionFlag puts a dot on its icon, and the tab
 *                   opens when missionFocus, the selected site, changes.
 *                   With it the mission's points are the route, so the Site
 *                   card and the waypoint and Clear controls are not shown.
 *                   routeNote says why there is no route yet.
 *   methods         ways to join the mission's points, as { id, name, note }.
 *                   method is the one in use, and onMethod(id) changes it.
 */

const ICONS = {
  route: <path d="M4 18c3 0 3-6 8-6s5-6 8-6M4 18h.01M20 6h.01" />,
  terrain: <path d="M3 19 9 9l4 6 3-4 5 8Z" />,
  time: <><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></>,
  range: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /></>,
  dose: <><circle cx="12" cy="12" r="1.5" /><path d="M12 4a8 8 0 0 1 7 4l-5 3M5 8a8 8 0 0 1 7-4M5 8l5 3M12 20a8 8 0 0 1-7-4l5-3M19 16a8 8 0 0 1-7 4v-6" /></>,
  site: <path d="M12 21s-6-6-6-11a6 6 0 0 1 12 0c0 5-6 11-6 11ZM12 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />,
  mission: <path d="M6 21V4m0 1h11l-2.5 4L17 13H6" />,
  limits: <path d="M5 4v16M12 4v16M19 4v16M3 8h4M10 15h4M17 10h4" />,
  pick: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" />,
  search: <><circle cx="11" cy="11" r="6" /><path d="m20 20-4.5-4.5" /></>,
}

function Icon({ name }) {
  return (
    <svg className="plan__icon" viewBox="0 0 24 24" aria-hidden="true">{ICONS[name]}</svg>
  )
}

// Editable limits. Display units convert to and from the SI values in limits.
const FIELDS = {
  slope: { unit: '°', step: 1, min: 5, max: 35, toView: (v) => v, fromView: (v) => v },
  pace: { unit: 'km/h', step: 0.1, min: 1, max: 6, toView: (v) => +(v * 3.6).toFixed(1), fromView: (v) => v / 3.6 },
  eva: { unit: 'h', step: 0.5, min: 0.5, max: 10, toView: (v) => +(v / 3600).toFixed(2), fromView: (v) => v * 3600 },
  work: { unit: 'min', step: 5, min: 0, max: 240, toView: (v) => Math.round(v / 60), fromView: (v) => v * 60 },
  range: { unit: 'km', step: 0.25, min: 0.25, max: 20, toView: (v) => +(v / 1000).toFixed(2), fromView: (v) => v * 1000 },
  climb: { unit: 'm/h', step: 10, min: 50, max: 3000, toView: (v) => Math.round(v * 3600), fromView: (v) => v / 3600 },
  descent: { unit: 'm/h', step: 10, min: 50, max: 3000, toView: (v) => Math.round(v * 3600), fromView: (v) => v / 3600 },
}

// Same value within float noise from unit conversion.
function same(a, b) {
  return Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(b))
}

// An editable limit. When it differs from the preset it was based on, the box
// is marked and a reset button shows the preset value, as slicers do.
function NumberField({ field, value, base, presetName, onChange, label }) {
  const spec = FIELDS[field]
  const [draft, setDraft] = useState(null)
  const shown = draft ?? String(spec.toView(value))
  const modified = base !== undefined && !same(value, base)
  const commit = (text) => {
    const n = Number(text)
    if (text !== '' && Number.isFinite(n)) onChange(spec.fromView(Math.min(spec.max, Math.max(spec.min, n))))
  }
  const presetValue = modified ? `${spec.toView(base)} ${spec.unit}` : null
  return (
    <span className={`plan__box plan__box--edit${modified ? ' is-modified' : ''}`} title={modified ? `${presetName}: ${presetValue}` : undefined}>
      {modified && (
        <button
          type="button"
          className="plan__reset"
          onClick={() => { setDraft(null); onChange(base) }}
          aria-label={`Reset ${label} to ${presetName} value, ${presetValue}`}
        >
          ↺
        </button>
      )}
      <input
        type="number"
        inputMode="decimal"
        aria-label={label}
        step={spec.step}
        min={spec.min}
        max={spec.max}
        value={shown}
        onChange={(event) => {
          setDraft(event.target.value)
          commit(event.target.value)
        }}
        onBlur={() => setDraft(null)}
      />
      <span className="plan__unit">{spec.unit}</span>
    </span>
  )
}

function Value({ children, unit, level }) {
  return (
    <span className={`plan__box${level ? ` is-${level}` : ''}`}>
      <output>{children}</output>
      {unit && <span className="plan__unit">{unit}</span>}
    </span>
  )
}

function Row({ label, hint, wide, children }) {
  return (
    <div className={`plan__row${wide ? ' plan__row--wide' : ''}`} title={hint}>
      <span className="plan__label">{label}</span>
      {children}
    </div>
  )
}

// Whole minutes for a value box with a "min" unit.
function minutes(seconds) {
  return Math.round(seconds / 60)
}

function SiteCard({ plan, placing, onPlacing, onSite }) {
  const siteId = SITES.find((s) => plan.startName?.startsWith(s.name))?.id ?? ''
  const pick = (mode) => onPlacing(placing === mode ? null : mode)
  return (
    <section className="plan__card" aria-label="Site">
      <h2 className="plan__card-title"><Icon name="site" />Site</h2>
      <div className="plan__line">
        <label className="plan__line-label" htmlFor="plan-site">Start</label>
        <select
          id="plan-site"
          className="plan__select"
          value={siteId}
          onChange={(event) => event.target.value && onSite(event.target.value)}
        >
          <option value="">{plan.start ? 'Custom point' : 'Choose a site'}</option>
          {SITES.map((s) => (
            <option key={s.id} value={s.id}>{s.name} · {s.traverse ? `sol ${s.traverse.lastSol}` : s.landed}</option>
          ))}
        </select>
        <button type="button" className="plan__tool" aria-pressed={placing === 'start'} onClick={() => pick('start')} aria-label="Pick start on map" title="Pick start on map">
          <Icon name="pick" />
        </button>
      </div>
      <div className="plan__line">
        <span className="plan__line-label">Target</span>
        <span className={`plan__select plan__select--static${plan.target ? '' : ' is-empty'}`}>
          {placing === 'target' ? 'Click the map · Esc' : plan.target ? formatLatLon(...plan.target) : 'Not set'}
        </span>
        <button type="button" className="plan__tool" aria-pressed={placing === 'target'} disabled={!plan.start} onClick={() => pick('target')} aria-label="Pick target on map" title="Pick target on map">
          <Icon name="pick" />
        </button>
      </div>
      {placing === 'start' && <p className="plan__placing">Click the map to set the start. Esc cancels.</p>}
    </section>
  )
}

const BASE_KEY = 'nimbs.plan-b.preset'

function loadBase() {
  try {
    return localStorage.getItem(BASE_KEY) ?? DEFAULT_PRESET
  } catch {
    return DEFAULT_PRESET
  }
}

function saveBase(id) {
  try {
    localStorage.setItem(BASE_KEY, id)
  } catch {
    // Not remembered without storage.
  }
}

const CATS = [
  { id: 'route', icon: 'route', title: 'Route' },
  { id: 'terrain', icon: 'terrain', title: 'Terrain' },
  { id: 'time', icon: 'time', title: 'Time' },
  { id: 'range', icon: 'range', title: 'Walk-back' },
  { id: 'dose', icon: 'dose', title: 'Radiation' },
]
const MISSION_CAT = { id: 'mission', icon: 'mission', title: 'Mission points' }

export default function PlanPanel({
  plan, limits, assessment, status, placing, dose,
  onPlacing, onSite, onRemoveWaypoint, onLimits, onRetry, onWalk, onClear, onAddToMission,
  missionSites, missionFlag = null, missionFocus = -1, routeNote = null,
  methods, method, onMethod,
}) {
  const searchId = useId()
  const [advanced, setAdvanced] = useState(false)
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  // With a mission open its points come first, since the mission is why you are here.
  const [active, setActive] = useState(missionSites ? 'mission' : 'route')
  const cats = missionSites ? [MISSION_CAT, ...CATS] : CATS
  // Picking a mission site, on the map or by adding one, opens its tab.
  useEffect(() => {
    if (missionSites && missionFocus >= 0) setActive('mission')
  }, [missionFocus])
  const rail = useRef(null)
  // The preset stays chosen while you edit. Edits show as changes from it.
  const [baseId, setBaseId] = useState(() => presetFor(limits)?.id ?? loadBase())
  const base = PRESETS.find((p) => p.id === baseId) ?? PRESETS.find((p) => p.id === DEFAULT_PRESET)
  const changes = Object.keys(base.limits).filter((key) => !same(limits[key], base.limits[key]))
  // Follow preset matches when limits change from the map controls.
  const exact = presetFor(limits)?.id
  useEffect(() => {
    if (exact && exact !== baseId) setBaseId(exact)
  }, [exact, baseId])
  useEffect(() => saveBase(baseId), [baseId])
  const field = (key, label) => (
    <NumberField field={key} label={label} value={limits[key]} base={base.limits[key]} presetName={base.name} onChange={set(key)} />
  )
  const a = assessment
  const ready = Boolean(plan.start && plan.target)
  const pending = status === 'loading' ? '…' : '—'

  // Arrow keys move between tabs, as in any tab list.
  const onRailKey = (event) => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    event.preventDefault()
    const index = (cats.findIndex((cat) => cat.id === active) + step + cats.length) % cats.length
    setActive(cats[index].id)
    rail.current?.querySelectorAll('button')[index]?.focus()
  }

  const set = (key) => (value) => onLimits({ ...limits, [key]: value })
  const match = (label) => !query || label.toLowerCase().includes(query.toLowerCase())

  // Rows per category. Basic rows always show. Advanced rows need the switch
  // or a search that matches them.
  const rows = {
    route: [
      ...(methods ? [{
        label: 'Method',
        group: 'Routing',
        wide: true,
        basic: true,
        hint: methods.find((entry) => entry.id === method)?.note,
        node: (
          <select className="plan__select" aria-label="Routing method" value={method} onChange={(event) => onMethod(event.target.value)}>
            {methods.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
        ),
      }] : []),
      { label: 'Waypoints', group: 'Points', basic: true, node: (
        <span className="plan__box plan__box--action">
          <output>{plan.waypoints.length}</output>
          {!missionSites && (
            <button type="button" aria-pressed={placing === 'waypoint'} disabled={!ready} onClick={() => onPlacing(placing === 'waypoint' ? null : 'waypoint')}>
              {placing === 'waypoint' ? 'Done' : 'Add'}
            </button>
          )}
        </span>
      ) },
      { label: 'Distance one way', group: 'Points', basic: true, node: <Value unit={a && a.distance >= 1000 ? 'km' : 'm'}>{a ? (a.distance >= 1000 ? (a.distance / 1000).toFixed(2) : Math.round(a.distance)) : pending}</Value> },
      { label: 'Straight line', group: 'Points', basic: false, node: <Value unit={ready && distance(plan.start, plan.target) >= 1000 ? 'km' : 'm'}>{!ready ? '—' : distance(plan.start, plan.target) >= 1000 ? (distance(plan.start, plan.target) / 1000).toFixed(2) : Math.round(distance(plan.start, plan.target))}</Value> },
      ...(a ? a.legs.map((leg, i) => ({
        label: `Leg ${leg.index}`,
        group: 'Legs',
        wide: true,
        basic: true,
        node: (
          <span className={`plan__box plan__box--leg is-${slopeLevel(leg.maxSlope, limits.slope)}`}>
            <output>{formatDistance(leg.length)} · {formatSlope(leg.maxSlope)}</output>
            {!missionSites && i < plan.waypoints.length && (
              <button type="button" onClick={() => onRemoveWaypoint(i)} aria-label={`Remove waypoint ${i + 1}`} title={`Remove waypoint ${i + 1}`}>×</button>
            )}
          </span>
        ),
      })) : []),
    ],
    terrain: [
      { label: 'Slope limit', group: 'Limit', basic: true, node: field('slope', 'Slope limit') },
      { label: 'Caution from', group: 'Limit', basic: false, node: <Value unit="°">{limits.slope - 5}</Value> },
      { label: 'Max slope', group: 'This route', basic: true, node: <Value unit="°" level={a && slopeLevel(a.maxSlope, limits.slope)}>{a?.maxSlope != null ? Math.round(a.maxSlope) : pending}</Value> },
      { label: 'Over limit', group: 'This route', basic: true, node: <Value unit="m" level={a && a.legs.some((l) => l.over > 0) ? 'hazard' : null}>{a ? Math.round(a.legs.reduce((s, l) => s + l.over, 0)) : pending}</Value> },
      { label: 'Near limit', group: 'This route', basic: false, node: <Value unit="m">{a ? Math.round(a.legs.reduce((s, l) => s + l.caution, 0)) : pending}</Value> },
      { label: 'No terrain data', group: 'This route', basic: false, node: <Value unit="m">{a ? Math.round(a.legs.reduce((s, l) => s + l.unknown, 0)) : pending}</Value> },
    ],
    time: [
      { label: 'EVA budget', group: 'Budget', basic: true, node: field('eva', 'EVA budget') },
      { label: 'Time at target', group: 'Budget', basic: true, node: field('work', 'Time at target') },
      { label: 'Flat speed', group: 'Speed', basic: true, hint: 'Over level ground', node: field('pace', 'Flat speed') },
      { label: 'Climb rate', group: 'Speed', basic: false, hint: 'Height gained per hour, added to the time for the distance', node: field('climb', 'Climb rate') },
      { label: 'Descent rate', group: 'Speed', basic: false, hint: 'Height lost per hour, added to the time for the distance', node: field('descent', 'Descent rate') },
      { label: 'Walk out', group: 'This route', basic: false, node: <Value unit="min">{a ? minutes(a.timeOut) : pending}</Value> },
      { label: 'Walk back', group: 'This route', basic: false, node: <Value unit="min">{a ? minutes(a.timeBack) : pending}</Value> },
      { label: 'EVA total', group: 'This route', basic: true, node: <Value level={a && a.total > limits.eva ? 'hazard' : null}>{a ? formatDuration(a.total) : pending}</Value> },
    ],
    range: [
      { label: 'Walk-back limit', group: 'Limit', basic: true, node: field('range', 'Walk-back limit') },
      { label: 'Max from start', group: 'This route', basic: true, node: <Value unit="km" level={a && a.maxFromStart > limits.range ? 'hazard' : null}>{a ? (a.maxFromStart / 1000).toFixed(2) : pending}</Value> },
    ],
    dose: [
      { label: 'Dose rate', group: 'Reference', basic: false, hint: dose ? `${dose.site} RAD mean, ${dose.when}` : undefined, node: <Value unit="mSv/day">{dose ? (dose.measurement.value * 1000).toFixed(2) : '—'}</Value> },
      { label: 'EVA dose', group: 'This route', basic: true, hint: dose ? `${dose.site} RAD mean, ${dose.when}` : undefined, node: <Value unit="mSv">{a?.dose != null ? (a.dose * 1000).toFixed(3) : pending}</Value> },
    ],
    // The mission tab holds a list, not setting rows.
    mission: [],
  }

  const visible = (row) => (query ? match(row.label) : advanced || row.basic)

  // Worst state per tab, for the dot on its rail icon.
  const sum = (key) => (a ? a.legs.reduce((total, leg) => total + leg[key], 0) : 0)
  const flags = {
    route: null,
    terrain: !a ? null : sum('over') > 0 ? 'hazard' : sum('caution') > 0 || sum('unknown') > 0 ? 'caution' : null,
    time: !a ? null : a.total > limits.eva ? 'hazard' : a.total > limits.eva * 0.85 ? 'caution' : null,
    range: a && a.maxFromStart > limits.range ? 'hazard' : null,
    dose: null,
    mission: missionFlag,
  }

  // One tab, or every tab's matches while searching.
  const tabs = query ? CATS : CATS.filter((cat) => cat.id === active)
  const showMission = active === 'mission' && !query
  const panel = tabs.map((cat) => {
    const shown = rows[cat.id].filter(visible)
    const groups = [...new Set(shown.map((row) => row.group))]
    return { cat, groups: groups.map((group) => ({ group, rows: shown.filter((row) => row.group === group) })) }
  }).filter((tab) => tab.groups.length)
  const current = cats.find((cat) => cat.id === active)

  return (
    <aside className="plan" aria-label="EVA plan">
      <div className="plan__rail" role="tablist" aria-label="Settings" aria-orientation="vertical" ref={rail} onKeyDown={onRailKey}>
        {cats.map((cat) => (
          <button
            key={cat.id}
            type="button"
            role="tab"
            id={`plan-tab-${cat.id}`}
            aria-selected={!query && active === cat.id}
            aria-controls="plan-panel"
            tabIndex={active === cat.id ? 0 : -1}
            onClick={() => { setActive(cat.id); setQuery('') }}
            aria-label={flags[cat.id] ? `${cat.title}, ${flags[cat.id] === 'hazard' ? 'over a limit' : 'near a limit'}` : cat.title}
            title={cat.title}
          >
            <Icon name={cat.icon} />
            {flags[cat.id] && <span className={`plan__flag is-${flags[cat.id]}`} aria-hidden="true" />}
          </button>
        ))}
      </div>

      <div className="plan__main">
        {!missionSites && <SiteCard plan={plan} placing={placing} onPlacing={onPlacing} onSite={onSite} />}

        {showMission && (
          <section className="plan__card plan__card--limits" aria-label="Mission points">
            <div className="plan__scroll" id="plan-panel" role="tabpanel" aria-labelledby="plan-tab-mission">
              <h3 className="plan__tab-title"><Icon name="mission" />Mission points</h3>
              {missionSites}
            </div>
          </section>
        )}
        <section className="plan__card plan__card--limits" aria-label="Limits" hidden={showMission}>
          <div className="plan__card-head">
            <h2 className="plan__card-title"><Icon name="limits" />Limits</h2>
            <label className="plan__switch">
              Advanced
              <input type="checkbox" role="switch" checked={advanced} onChange={() => setAdvanced(!advanced)} />
              <span aria-hidden="true" />
            </label>
          </div>
          <div className={`plan__line${changes.length ? ' plan__line--reset' : ''}`}>
            <select
              className={`plan__select${changes.length ? ' is-modified' : ''}`}
              aria-label="Limit preset"
              value={base.id}
              onChange={(event) => {
                const next = PRESETS.find((p) => p.id === event.target.value)
                if (!next) return
                setBaseId(next.id)
                onLimits(next.limits)
              }}
            >
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.limits.slope}° · {formatDuration(p.limits.eva)}
                </option>
              ))}
            </select>
            {changes.length > 0 && (
              <button type="button" className="plan__tool plan__tool--text" onClick={() => onLimits(base.limits)} title={`Reset all to ${base.name}`}>
                Reset
              </button>
            )}
            <button type="button" className="plan__tool" aria-pressed={searching} aria-controls={searchId} aria-label="Search settings" title="Search settings" onClick={() => { setSearching(!searching); setQuery('') }}>
              <Icon name="search" />
            </button>
          </div>
          {searching && (
            <input id={searchId} className="plan__search" type="search" placeholder="Find a setting" value={query} autoFocus onChange={(event) => setQuery(event.target.value)} />
          )}

          <div className="plan__scroll" id="plan-panel" role="tabpanel" aria-labelledby={query ? undefined : `plan-tab-${active}`} aria-label={query ? 'Search results' : undefined}>
            {!query && (
              <h3 className="plan__tab-title"><Icon name={current.icon} />{current.title}</h3>
            )}
            {panel.map(({ cat, groups }) => (
              <div key={cat.id}>
                {query && (
                  <button type="button" className="plan__tab-title plan__tab-title--link" onClick={() => { setActive(cat.id); setQuery('') }}>
                    <Icon name={cat.icon} />{cat.title}
                  </button>
                )}
                {groups.map(({ group, rows: list }) => (
                  <section key={group} className="plan__cat" aria-label={group}>
                    <h4 className="plan__cat-title">{group}</h4>
                    {list.map((row) => <Row key={row.label} label={row.label} hint={row.hint} wide={row.wide}>{row.node}</Row>)}
                  </section>
                ))}
              </div>
            ))}
            {query && !panel.length && <p className="plan__note">No setting matches.</p>}
            {!query && !advanced && rows[active].some((row) => !row.basic) && (
              <button type="button" className="plan__more-rows" onClick={() => setAdvanced(true)}>
                {rows[active].filter((row) => !row.basic).length} more in Advanced
              </button>
            )}
            <p className="plan__note">Limits are planning assumptions. No Mars suit limits are published.</p>
          </div>
        </section>

        <footer className="plan__dock">
          {status === 'error' ? (
            <div className="plan__verdict is-caution">
              <strong>No terrain</strong>
              <button type="button" className="plan__link" onClick={onRetry}>Retry</button>
            </div>
          ) : a ? (
            <div className={`plan__verdict is-${a.verdict}`} role="status">
              <strong>{a.verdict === 'no-go' ? 'No-go' : a.verdict === 'go' ? 'Go' : 'Caution'}</strong>
              <span>{a.reasons[0]?.text ?? `${formatDuration(a.total)} of ${formatDuration(limits.eva)}`}</span>
              {a.reasons.length > 1 && <span className="plan__more" title={a.reasons.slice(1).map((r) => r.text).join('\n')}>+{a.reasons.length - 1}</span>}
            </div>
          ) : status === 'loading' ? (
            <div className="plan__verdict is-routing" role="status">
              <span className="spinner" aria-hidden="true" />
              <strong>Routing</strong>
              <span>Working out the way through {plan.waypoints.length + 2} points</span>
            </div>
          ) : (
            <div className="plan__verdict">
              <span>{routeNote ?? (!plan.start ? 'Choose a start' : 'Pick a target')}</span>
            </div>
          )}
          <div className="plan__actions">
            {!missionSites && <button type="button" className="plan__button" onClick={onClear} disabled={!plan.start}>Clear</button>}
            <button type="button" className={`plan__button plan__button--primary${missionSites ? ' plan__button--wide' : ''}`} onClick={onWalk} disabled={!a}>Walk it</button>
            {onAddToMission !== undefined && (
              <button
                type="button"
                className="plan__button plan__button--wide"
                onClick={onAddToMission ?? undefined}
                disabled={!onAddToMission}
                title="Adds a mission site at the target with one EVA task as long as this EVA"
              >
                Add EVA to mission
              </button>
            )}
          </div>
        </footer>
      </div>
    </aside>
  )
}
