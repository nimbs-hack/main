import type { LatLon } from './geo'

// Geologic map unit under a point, from USGS SIM 3292 through the Go
// server. Planetocentric latitude, east longitude -180 to 180.

export type Unit = { unit: string, description: string, source: string }

// Null where the map has no unit. Throws when the lookup fails.
export async function fetchUnit([lat, lon]: LatLon, signal?: AbortSignal): Promise<Unit | null> {
  const response = await fetch(`/api/geology/unit?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`, { signal })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Geology lookup returned ${response.status}`)
  return response.json()
}
