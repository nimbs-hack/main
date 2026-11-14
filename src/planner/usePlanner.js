import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePoints } from './points'
import { insideSite, request, routeProfile } from './api'

const EMPTY_ROUTES = []
// The API accepts A, B, and up to eight stops between them.
export const MAX_VIA = 8

export default function usePlanner() {
  const [open, setOpen] = useState(true)
  const [site, setSite] = useState({ status: 'loading', meta: null, error: '' })
  const [retry, setRetry] = useState(0)
  const [waypoints, setWaypoints] = useState({ a: null, b: null })
  const [via, setVia] = useState([])
  const [roundTrip, setRoundTrip] = useState(true)
  const [picking, setPicking] = useState(null)
  const [pickError, setPickError] = useState('')
  const [slope, setSlope] = useState(20)
  const [weatherEnabled, setWeatherEnabled] = useState(false)
  const [scenario, setScenario] = useState('nominal')
  const [hour, setHour] = useState(12)
  const [sol, setSol] = useState(1000)
  const [minTemp, setMinTemp] = useState(-75)
  const [minPressure, setMinPressure] = useState(650)
  const pointsStore = usePoints()
  const [tab, setTab] = useState('route')
  const [layers, setLayers] = useState({ hillshade: false, slope: false, temperature: false, pressure: false })
  const [showBounds, setShowBounds] = useState(true)
  const [opacity, setOpacity] = useState(0.65)
  const [maxWind, setMaxWind] = useState(15)
  const [maxPressureSwing, setMaxPressureSwing] = useState(35)
  const [maxEvaHours, setMaxEvaHours] = useState(4)
  const [playing, setPlaying] = useState(false)
  const [weatherAttempt, setWeatherAttempt] = useState(0)
  useEffect(() => {
    if (!playing || !open) return
    const timer = setInterval(() => setHour(value => (value + 0.5) % 48), 1600)
    return () => clearInterval(timer)
  }, [playing, open])
  const [selectedId, setSelectedId] = useState(null)
  const [routeAttempt, setRouteAttempt] = useState(0)
  const [response, setResponse] = useState(null)
  const [weather, setWeather] = useState(null)

  useEffect(() => {
    const controller = new AbortController()
    setSite({ status: 'loading', meta: null, error: '' })
    request('/api/site', controller.signal).then(({ meta }) => {
      setSite({ status: 'ready', meta, error: '' })
    }, (error) => {
      if (!controller.signal.aborted) setSite({ status: 'error', meta: null, error: error.message })
    })
    return () => controller.abort()
  }, [retry])

  const putWaypoint = useCallback((which, point) => {
    if (!site.meta || !insideSite(point, site.meta)) {
      setPickError('Choose a point inside the outlined DEM area.')
      return false
    }
    if (which === 'stop') setVia((current) => current.length < MAX_VIA ? [...current, point] : current)
    else setWaypoints((current) => ({ ...current, [which]: point }))
    setPicking(null)
    setPickError('')
    return true
  }, [site.meta])

  const pick = useCallback((point) => {
    if (!open || !picking) return false
    if (picking === 'point') {
      pointsStore.addPoint({ lat: point[0], lon: point[1] })
      setPicking(null)
    } else putWaypoint(picking, { lat: point[0], lon: point[1] })
    return true
  }, [open, picking, putWaypoint, pointsStore.addPoint])

  const body = useMemo(() => ({
    waypointA: waypoints.a,
    waypointB: waypoints.b,
    via,
    roundTrip,
    maxSlopeDeg: slope,
    weatherConstraints: { enabled: weatherEnabled, scenario, sol, lmstHour: hour, minAirTempC: minTemp, minPressurePa: minPressure, thermalWeight: 0.35 },
  }), [waypoints, via, roundTrip, slope, weatherEnabled, scenario, sol, hour, minTemp, minPressure])
  const key = JSON.stringify(body)
  useEffect(() => {
    if (!open || !waypoints.a || !waypoints.b) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      request('/api/graph/routes', controller.signal, body).then(
        (result) => setResponse({ key, result }),
        (error) => { if (!controller.signal.aborted) setResponse({ key, error: error.message }) },
      )
    }, 200)
    return () => { clearTimeout(timer); controller.abort() }
  }, [key, body, open, waypoints, routeAttempt])
  const current = response?.key === key ? response : null
  const result = open ? current?.result : null
  const routes = result?.routes ?? EMPTY_ROUTES
  const selected = routes.find((route) => route.id === selectedId) ?? routes[0] ?? null
  const samples = useMemo(() => selected ? routeProfile(selected) : null, [selected])

  const weatherBody = useMemo(() => ({
    scenario, sol, lmstHour: hour,
    limits: { minAirTempC: minTemp, minPressurePa: minPressure, maxWindSpeedMps: maxWind, maxPressureSwingPa: maxPressureSwing, maxEvaHours },
    route: selected ? {
      totalDistanceM: selected.totalDistanceM,
      elevationGainM: selected.elevationGainM,
      elevationLossM: selected.elevationLossM,
      points: selected.points,
    } : undefined,
  }), [scenario, sol, hour, minTemp, minPressure, maxWind, maxPressureSwing, maxEvaHours, selected])
  const weatherKey = JSON.stringify(weatherBody)
  useEffect(() => {
    if (!open || !site.meta) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      request('/api/weather/evaluate', controller.signal, weatherBody).then(
        (result) => setWeather({ key: weatherKey, result }),
        (error) => { if (!controller.signal.aborted) setWeather({ key: weatherKey, error: error.message }) },
      )
    }, 250)
    return () => { clearTimeout(timer); controller.abort() }
  }, [open, site.meta, weatherKey, weatherBody, weatherAttempt])

  useEffect(() => {
    if (!picking) return
    const cancel = (event) => { if (event.key === 'Escape') setPicking(null) }
    window.addEventListener('keydown', cancel)
    return () => window.removeEventListener('keydown', cancel)
  }, [picking])

  return {
    open, setOpen, site, retry: () => setRetry((value) => value + 1),
    waypoints, picking, setPicking, pick, pickError, putWaypoint,
    swap: () => { setWaypoints(({ a, b }) => ({ a: b, b: a })); setVia((current) => [...current].reverse()) },
    clear: () => { setWaypoints({ a: null, b: null }); setVia([]); setPicking(null); setPickError('') },
    via, roundTrip, setRoundTrip,
    removeStop: (index) => setVia((current) => current.filter((_, i) => i !== index)),
    moveStop: (index, step) => setVia((current) => {
      const target = index + step
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    }),
    slope, setSlope, weatherEnabled, setWeatherEnabled, scenario, setScenario,
    hour, setHour, sol, setSol, minTemp, setMinTemp, minPressure, setMinPressure, layers, setLayers, showBounds, setShowBounds, opacity, setOpacity,
    tab, setTab, pointsStore, playing, setPlaying, maxWind, setMaxWind, maxPressureSwing, setMaxPressureSwing, maxEvaHours, setMaxEvaHours,
    retryWeather: () => { setWeather(null); setWeatherAttempt(value => value + 1) },
    routes, result, selected, samples, setSelectedId,
    loading: open && Boolean(waypoints.a && waypoints.b && !current),
    error: current?.error,
    retryRoute: () => { setResponse(null); setRouteAttempt((attempt) => attempt + 1) },
    weather: weather?.key === weatherKey ? weather : null,
  }
}
