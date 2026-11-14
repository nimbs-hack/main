import type { Plugin, Connect } from 'vite'
import { fileURLToPath } from 'node:url'
import { createCtxApi } from './ctx.ts'
import { CTX_API_PATH } from '../../../src/data/ctx.js'
import { createTerrainApi } from './terrain.ts'
import { TERRAIN_API_PATH } from '../../../src/data/terrain-source.js'

export const ctxCacheDir = fileURLToPath(new URL('../../../data/cache/ctx-v01', import.meta.url))

// Use the same Hono routes in development and when serving the built preview.
export function mapTileProxy(): Plugin {
  const app = createCtxApi({ cacheDir: ctxCacheDir })
  const terrain = createTerrainApi({ cacheDir: fileURLToPath(new URL('../../../data/cache/mars-v14-v2', import.meta.url)) })
  app.route('/', terrain)
  const middleware: Connect.NextHandleFunction = async (req, res, next) => {
    if (!req.url?.startsWith(`${CTX_API_PATH}/`) && !req.url?.startsWith(`${TERRAIN_API_PATH}/`)) return next()
    try {
      const response = await app.fetch(new Request(`http://localhost${req.url}`, { method: req.method }))
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch (error) {
      next(error)
    }
  }
  return {
    name: 'map-tile-proxy',
    configureServer(server) { server.middlewares.use(middleware) },
    configurePreviewServer(server) { server.middlewares.use(middleware) },
  }
}
