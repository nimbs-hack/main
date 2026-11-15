import type { Mission } from '../api'

// The plan: site positions in the order the EVA visits them. A site can come
// back, but never twice in a row. A mission without a plan visits its sites
// in list order, so files from before plans still have a route.
export const planStops = (mission: Pick<Mission, 'sites' | 'route'>): number[] =>
  mission.route?.length ? mission.route : mission.sites.map((_, i) => i)

// The stops with any site that follows itself dropped.
export const withoutRepeats = (stops: number[]): number[] => stops.filter((site, i) => i === 0 || site !== stops[i - 1])
