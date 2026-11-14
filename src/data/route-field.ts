import { gridSlopes } from './route-options'
import type { Field, Grid } from './route-options'
import type { SurfaceSample } from './terrain-sample'

type Loaders = {
  elevations: () => Promise<(number | null)[]>
  surface: () => Promise<SurfaceSample[]>
  thermal: () => Promise<(number | null)[]>
}

export type RouteField = {
  grid: Grid
  field: Field
  thermalPending: boolean
  slopesPending: boolean
}

// Publish usable terrain before waiting for infrared imagery or the slope
// probes used in the explanatory note. All final samples keep their detail.
export async function loadRouteField(grid: Grid, load: Loaders, publish: (field: RouteField) => void, signal: AbortSignal) {
  let elevation: (number | null)[] | undefined
  let surface: SurfaceSample[] | undefined
  let thermal: (number | null)[] = grid.points.map(() => null)
  let thermalPending = true
  const update = () => {
    if (!elevation || signal.aborted) return
    const coarse = surface ? gridSlopes(grid, elevation) : []
    publish({
      grid,
      field: { elevation, thermal, slope: grid.points.map((_, i) => surface ? surface[i]?.slope ?? coarse[i] : null) },
      thermalPending,
      slopesPending: !surface,
    })
  }
  await Promise.all([
    load.elevations().then(async (values) => {
      elevation = values
      update()
      if (signal.aborted || !elevation.some((value) => value !== null)) return
      surface = await load.surface().catch(() => [])
      update()
    }),
    load.thermal().catch(() => thermal).then((values) => {
      thermal = values
      thermalPending = false
      update()
    }),
  ])
}
