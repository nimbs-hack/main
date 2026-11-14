import { Hono } from 'hono'
import { TERRAIN_API_PATH, TERRAIN_UPSTREAM, TERRAIN_VERSION } from '../../../src/data/terrain-source.js'
import { createTileCache } from './tile-cache.ts'

type Options = {
  cacheDir: string
  fetchTile?: (url: string, options: RequestInit) => Promise<Response>
}

export function createTerrainApi({ cacheDir, fetchTile = fetch }: Options) {
  const app = new Hono()
  const cache = createTileCache({ cacheDir, maxTiles: 8192, memoryBytes: 16 * 1024 * 1024 })
  const headers = { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'public, max-age=2592000' }

  app.get(`${TERRAIN_API_PATH}/layer.json`, async (c) => {
    try {
      const bytes = await cache.get('layer.json', async () => {
        const response = await fetchTile(`${TERRAIN_UPSTREAM}/layer.json`, { signal: AbortSignal.timeout(20_000) })
        if (!response.ok) throw new Error(`Terrain metadata returned ${response.status}`)
        const metadata: unknown = await response.json()
        if (!metadata || typeof metadata !== 'object' ||
          !('format' in metadata) || metadata.format !== 'quantized-mesh-1.0' ||
          !('version' in metadata) || metadata.version !== TERRAIN_VERSION ||
          !('available' in metadata) || !Array.isArray(metadata.available)) {
          throw new Error('Unexpected terrain metadata')
        }
        // Pin the local route. Availability and TMS row order remain unchanged.
        return new TextEncoder().encode(JSON.stringify({
          ...metadata, tiles: [`{z}/{x}/{y}.terrain?v=${TERRAIN_VERSION}`],
        }))
      })
      return new Response(bytes, { headers: { ...headers, 'Content-Type': 'application/json' } })
    } catch (error) {
      console.warn('Terrain metadata unavailable', error)
      return c.text('Terrain metadata unavailable', 502, { 'Cache-Control': 'no-store' })
    }
  })

  app.get(`${TERRAIN_API_PATH}/:z/:x/:file`, async (c) => {
    const { z, x, file } = c.req.param()
    const y = /^(0|[1-9]\d*)\.terrain$/.exec(file)?.[1]
    if (!/^(0|[1-9]\d*)$/.test(z) || !/^(0|[1-9]\d*)$/.test(x) || y === undefined ||
      Number(z) > 18 || Number(x) >= 2 ** (Number(z) + 1) || Number(y) >= 2 ** Number(z)) {
      return c.text('Invalid terrain tile coordinates', 400)
    }
    try {
      // Trek's S3 tiles are static bytes. Accept/extension headers do not vary them.
      const bytes = await cache.get(`${z}-${x}-${y}.terrain`, async () => {
        const response = await fetchTile(`${TERRAIN_UPSTREAM}/${z}/${x}/${y}.terrain?v=${TERRAIN_VERSION}`, {
          signal: AbortSignal.timeout(20_000),
        })
        if (!response.ok) throw new Error(`Terrain upstream returned ${response.status}`)
        const data = new Uint8Array(await response.arrayBuffer())
        if (data.byteLength < 96 || data.byteLength > 2 * 1024 * 1024 ||
          response.headers.get('content-type')?.includes('text/')) throw new Error('Invalid terrain tile')
        const view = new DataView(data.buffer)
        const count = view.getUint32(88, true)
        if (!count || 92 + count * 6 + 4 > data.length ||
          !Number.isFinite(view.getFloat32(24, true)) || !Number.isFinite(view.getFloat32(28, true))) {
          throw new Error('Invalid quantized-mesh header')
        }
        return data
      })
      return new Response(bytes, { headers })
    } catch (error) {
      console.warn('Terrain tile unavailable', error)
      return c.text('Terrain tile unavailable', 502, { 'Cache-Control': 'no-store' })
    }
  })
  return Object.assign(app, { flushCache: cache.flush })
}
