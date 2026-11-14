import { useEffect, useState } from 'react'

function useUtcClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])
  return now.toISOString().slice(0, 19).replace('T', ' ')
}

export default function TopBar() {
  const utc = useUtcClock()
  return (
    <header className="topbar">
      <strong className="topbar__title">Mission console</strong>
      <div className="topbar__meta">
        <span className="topbar__item">
          UTC <b>{utc}</b>
        </span>
      </div>
    </header>
  )
}
