import { useEffect, useState } from 'react'
import { Math as CesiumMath } from 'cesium'
import { isTilted, resetNorth, toggleTilt, zoomBy } from './camera'

// Compass, 2D/3D and zoom buttons on the right edge of the map, like the
// stack in Google Maps and Earth.
export default function NavControls({ viewer }) {
  const [heading, setHeading] = useState(0)
  const [tilted, setTilted] = useState(false)

  useEffect(() => {
    if (!viewer) return
    const update = () => {
      setHeading(CesiumMath.toDegrees(viewer.camera.heading))
      setTilted(isTilted(viewer))
    }
    update()
    return viewer.camera.changed.addEventListener(update)
  }, [viewer])

  const north = Math.abs(((heading + 180) % 360) - 180) < 0.5

  return (
    <div className="nav" role="group" aria-label="Camera">
      <button
        type="button"
        className="nav__compass"
        onClick={() => viewer && resetNorth(viewer)}
        aria-label={north ? 'Facing north' : `Heading ${Math.round(heading)}°. Turn to face north`}
        title="Face north"
        disabled={!viewer}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" style={{ rotate: `${-heading}deg` }}>
          <path d="M12 3 16 12H8Z" className="nav__needle-n" />
          <path d="M12 21 8 12H16Z" className="nav__needle-s" />
        </svg>
      </button>
      <button
        type="button"
        className="nav__text"
        onClick={() => viewer && toggleTilt(viewer)}
        aria-label={tilted ? 'Look straight down' : 'Tilt the view'}
        disabled={!viewer}
        title={tilted ? 'Look straight down' : 'Tilt the view'}
      >
        {tilted ? '2D' : '3D'}
      </button>
      <button type="button" disabled={!viewer} onClick={() => viewer && zoomBy(viewer, 0.5)} aria-label="Zoom in" title="Zoom in">
        +
      </button>
      <button type="button" disabled={!viewer} onClick={() => viewer && zoomBy(viewer, 2)} aria-label="Zoom out" title="Zoom out">
        −
      </button>
    </div>
  )
}
