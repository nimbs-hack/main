import { Hono } from 'hono'
import { join } from 'node:path'
import sharp from 'sharp'
import { CTX_API_PATH, CTX_MAX_LEVEL, CTX_TILE_SIZE, CTX_UPSTREAM, CTX_BACKUP_UPSTREAM } from '../../../src/data/ctx.js'
import { createTileCache } from './tile-cache.ts'
import type { TileBytes } from './tile-cache.ts'
import { tileImageType, isValidTileImage } from './tile-image.ts'

const MAX_TILE_BYTES = 1024 * 1024
const MAX_TILES = 2048

type Options = {
  cacheDir: string
  fetchTile?: (url: string, options: RequestInit) => Promise<Response>
  maxTiles?: number
}

// Fixed upstream and validated coordinates keep this from becoming an open proxy.
export function createCtxApi({ cacheDir, fetchTile = fetch, maxTiles = MAX_TILES }: Options) {
  const app = new Hono()
  const cache = createTileCache({ cacheDir, maxTiles, validate: isValidTileImage })
  const backup = createTileCache({ cacheDir: join(cacheDir, 'beta01'), maxTiles: 512, validate: isValidTileImage })

  async function load(z: number, y: number, x: number, source: 'v01' | 'beta01'): Promise<TileBytes> {
    // CTX1 level 10 includes decodable images from the wrong locations.
    // Rebuild this level from its four level-11 children, which also warms
    // the next zoom level. Never reuse the old, header-valid cache entries.
    if (source === 'v01' && z === 10) {
      return cache.get(`10-rebuilt-1-${y}-${x}.png`, async () => {
        const half = CTX_TILE_SIZE / 2
        const children = await Promise.all([0, 1, 2, 3].map(async (quadrant) => {
          const dx = quadrant % 2
          const dy = Math.floor(quadrant / 2)
          const bytes = await load(11, y * 2 + dy, x * 2 + dx, source)
          return {
            input: await sharp(bytes).resize(half, half).png().toBuffer(),
            left: dx * half,
            top: dy * half,
          }
        }))
        return new Uint8Array(await sharp({
          create: { width: CTX_TILE_SIZE, height: CTX_TILE_SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
        }).composite(children).png().toBuffer())
      })
    }
    const name = `${z}-${y}-${x}.png`
    const download = async (upstream: string) => {
      const response = await fetchTile(`${upstream}/${z}/${y}/${x}`, {
        signal: AbortSignal.timeout(20_000),
      })
      const type = response.headers.get('content-type')?.split(';')[0]
      if (!response.ok || type !== 'image/png' && type !== 'image/jpeg') {
        throw new Error(`CTX upstream returned ${response.status} ${type}`)
      }
      const data = new Uint8Array(await response.arrayBuffer())
      if (data.length > MAX_TILE_BYTES || !tileImageType(data)) {
        throw new Error('CTX upstream returned an invalid tile')
      }
      return data
    }
    // The viewer switches the whole layer on failure. Mixing versions tile
    // by tile produces joins between differently registered mosaics.
    return source === 'v01'
      ? cache.get(name, () => download(CTX_UPSTREAM))
      : backup.get(name, () => download(CTX_BACKUP_UPSTREAM))
  }

  app.get(`${CTX_API_PATH}/:z/:y/:file`, async (c) => {
    const { z, y, file } = c.req.param()
    const source = c.req.query('source') ?? 'v01'
    const x = /^(0|[1-9]\d*)\.png$/.exec(file)?.[1]
    if (source !== 'v01' && source !== 'beta01' ||
      !/^(0|[1-9]\d*)$/.test(z) || !/^(0|[1-9]\d*)$/.test(y) || x === undefined ||
      Number(z) > CTX_MAX_LEVEL || Number(y) >= 2 ** Number(z) || Number(x) >= 2 ** (Number(z) + 1)) {
      return c.text('Invalid CTX tile coordinates', 400)
    }
    try {
      const data = await load(Number(z), Number(y), Number(x), source)
      const type = tileImageType(data)
      if (!type) throw new Error('Invalid cached CTX image')
      return new Response(data, {
        headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=2592000', 'X-Imagery-Source': source === 'v01' ? 'CTX V01' : 'CTX beta01 fallback' },
      })
    } catch (error) {
      console.warn('CTX tile unavailable', error)
      return c.text('CTX tile unavailable', 502, { 'Cache-Control': 'no-store' })
    }
  })
  return Object.assign(app, { flushCache: () => Promise.all([cache.flush(), backup.flush()]) })
}
