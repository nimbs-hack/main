import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTerrainApi } from './terrain.ts'

const dirs: string[] = []
async function tempCache() {
  const dir = await mkdtemp(join(tmpdir(), 'mars-terrain-test-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

test('preserves mesh bytes and reuses terrain across requests and restarts', async () => {
  const cacheDir = await tempCache()
  const bytes = new Uint8Array(128)
  const view = new DataView(bytes.buffer)
  view.setFloat32(24, 4000, true)
  view.setFloat32(28, 5000, true)
  view.setUint32(88, 3, true)
  let calls = 0
  const fetchTile = async () => { calls++; return new Response(bytes) }
  const app = createTerrainApi({ cacheDir, fetchTile })
  const path = '/api/terrain/mars-v14/9/902/242.terrain?v=2.0'
  const responses = await Promise.all([app.request(path), app.request(path)])
  for (const r of responses) {
    expect(r.status).toBe(200)
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(bytes)
  }
  await app.flushCache()
  const restarted = createTerrainApi({ cacheDir, fetchTile })
  expect((await restarted.request(path)).status).toBe(200)
  expect(calls).toBe(1)
})

test('preserves terrain availability and pins relative metadata tile paths', async () => {
  const metadata = { format: 'quantized-mesh-1.0', version: '2.0', scheme: 'tms',
    tiles: ['https://example.test/{z}/{x}/{y}.terrain'],
    available: [[{ startX: 0, endX: 1, startY: 0, endY: 0 }]],
  }
  const app = createTerrainApi({ cacheDir: await tempCache(), fetchTile: async () => Response.json(metadata) })
  const r = await app.request('/api/terrain/mars-v14/layer.json')
  expect(r.status).toBe(200)
  expect(await r.json()).toEqual({ ...metadata, tiles: ['{z}/{x}/{y}.terrain?v=2.0'] })
  await app.flushCache()
})

test('rejects invalid coordinates and does not persist malformed meshes', async () => {
  const cacheDir = await tempCache()
  let calls = 0
  const app = createTerrainApi({ cacheDir, fetchTile: async () => {
    calls++
    return new Response(new Uint8Array(128))
  } })
  expect((await app.request('/api/terrain/mars-v14/19/0/0.terrain')).status).toBe(400)
  expect((await app.request('/api/terrain/mars-v14/0/2/0.terrain')).status).toBe(400)
  expect((await app.request('/api/terrain/mars-v14/0/0/1.terrain')).status).toBe(400)
  expect(calls).toBe(0)
  expect((await app.request('/api/terrain/mars-v14/0/0/0.terrain')).status).toBe(502)
  await app.flushCache()
  expect(await readdir(cacheDir)).toEqual([])
})
