import type {
  ElevationResponse,
  MapLayerMeta,
  RoutePlanRequest,
  RoutePlanResponse,
  SiteMetadata,
} from "@nimbs/shared";

export async function fetchSiteMeta(): Promise<SiteMetadata> {
  const res = await fetch("/api/site");
  if (!res.ok) {
    throw new Error(`Failed to load site metadata (${res.status})`);
  }
  const data = (await res.json()) as { meta: SiteMetadata };
  return data.meta;
}

export async function fetchBaseLayers(): Promise<MapLayerMeta[]> {
  const res = await fetch("/api/layers");
  if (!res.ok) {
    throw new Error(`Failed to load layers (${res.status})`);
  }
  const data = (await res.json()) as { layers: MapLayerMeta[] };
  return data.layers;
}

export async function fetchElevation(lat: number, lon: number): Promise<ElevationResponse> {
  const res = await fetch(`/api/terrain/elevation?lat=${lat}&lon=${lon}`);
  if (!res.ok) {
    throw new Error(`Elevation query failed (${res.status})`);
  }
  return (await res.json()) as ElevationResponse;
}

export async function planGraphRoutes(payload: RoutePlanRequest): Promise<RoutePlanResponse> {
  const res = await fetch("/api/graph/routes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Route calculation failed (${res.status})`);
  }
  return (await res.json()) as RoutePlanResponse;
}
