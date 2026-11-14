import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { fileURLToPath } from 'node:url'
import { createCtxApi } from './ctx.ts'
import { createTerrainApi } from './terrain.ts'

const app = new Hono()
app.route('/', createCtxApi({
  cacheDir: fileURLToPath(new URL('../../../data/cache/ctx-v01', import.meta.url)),
}))
app.route('/', createTerrainApi({
  cacheDir: fileURLToPath(new URL('../../../data/cache/mars-v14-v2', import.meta.url)),
}))
app.all('/api/*', (c) => c.notFound())
app.use('*', serveStatic({ root: './dist' }))
app.get('*', serveStatic({ path: './dist/index.html' }))

export default { port: Number(process.env.PORT || 3000), fetch: app.fetch }
