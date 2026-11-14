import { useEffect, useState } from 'react'

function useUtcClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])
  return now.toISOString().slice(0, 19).replace('T', ' ')
}

export default function TopBar({ system, status }) {
  const utc = useUtcClock()
  return (
    <header className="topbar">
      <span className="topbar__mark" aria-hidden="true" />
      <strong className="topbar__title">Mission console</strong>
      <span className="topbar__view">Mars global map</span>
      <div className="topbar__meta">
        <span className="topbar__item">
          System <b>{system}</b>
        </span>
        <span className="topbar__item">
          UTC <b>{utc}</b>
        </span>
        <span className="badge">
          <span className={`dot dot--${status}`} aria-hidden="true" />
          Live
        </span>
      </div>
    </header>
  )
}
