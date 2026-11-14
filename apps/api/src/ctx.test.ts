import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCtxApi } from './ctx'
import sharp from 'sharp'

const png = new Uint8Array(await sharp({ create: { width: 512, height: 512, channels: 3, background: '#888888' } }).png().toBuffer())
const jpeg = new Uint8Array(await sharp(png).jpeg().toBuffer())

const dirs: string[] = []
async function tempCache() {
  const dir = await mkdtemp(join(tmpdir(), 'mars-ctx-test-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

function tileResponse() {
  return new Response(png, { headers: { 'Content-Type': 'image/png' } })
}

test('coalesces requests and keeps tiles across API restarts', async () => {
  const cacheDir = await tempCache()
  let calls = 0
  const fetchTile = async () => { calls++; return tileResponse() }
  const app = createCtxApi({ cacheDir, fetchTile })
  const path = '/api/imagery/ctx-v01/12/1612/3340.png'
  const results = await Promise.all([app.request(path), app.request(path)])
  expect(results.map((r) => r.status)).toEqual([200, 200])
  expect(calls).toBe(1)
  await app.flushCache()
  const restarted = createCtxApi({ cacheDir, fetchTile })
  expect((await restarted.request(path)).status).toBe(200)
  expect(calls).toBe(1)
})

test('rejects out-of-grid coordinates and levels beyond source detail', async () => {
  let calls = 0
  const fetchTile = async () => { calls++; return tileResponse() }
  const app = createCtxApi({ cacheDir: await tempCache(), fetchTile })
  for (const path of ['13/0/0', '0/1/0', '0/0/2', '-1/0/0', '0/0/-1', '00/0/0']) {
    expect((await app.request(`/api/imagery/ctx-v01/${path}.png`)).status).toBe(400)
  }
  expect(calls).toBe(0)
})

test('never persists upstream errors or HTML responses', async () => {
  const cacheDir = await tempCache()
  let calls = 0
  const fetchTile = async () => {
    calls++
    return calls === 1 ? new Response('Unavailable', { status: 503 }) :
      new Response('<html>', { headers: { 'Content-Type': 'text/html' } })
  }
  const app = createCtxApi({ cacheDir, fetchTile })
  for (let i = 0; i < 2; i++) expect((await app.request('/api/imagery/ctx-v01/0/0/0.png')).status).toBe(502)
  expect(calls).toBe(2)
  expect(await readdir(cacheDir)).toEqual([])
})

test('evicts old disk tiles at the configured limit', async () => {
  const cacheDir = await tempCache()
  const fetchTile = async () => tileResponse()
  const app = createCtxApi({ cacheDir, fetchTile, maxTiles: 2 })
  for (const x of [0, 1, 2]) expect((await app.request(`/api/imagery/ctx-v01/1/0/${x}.png`)).status).toBe(200)
  await app.flushCache()
  expect((await readdir(cacheDir)).sort()).toEqual(['1-0-1.png', '1-0-2.png'])
})

test('serves JPEG tiles unchanged with the correct MIME type, including disk hits', async () => {
  const cacheDir = await tempCache()
  let calls = 0
  const fetchTile = async () => { calls++; return new Response(jpeg, { headers: { 'Content-Type': 'image/jpeg' } }) }
  const app = createCtxApi({ cacheDir, fetchTile })
  const path = '/api/imagery/ctx-v01/12/2154/7224.png'
  const response = await app.request(path)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('image/jpeg')
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(jpeg)
  await app.flushCache()
  const restarted = createCtxApi({ cacheDir, fetchTile })
  expect((await restarted.request(path)).headers.get('content-type')).toBe('image/jpeg')
  expect(calls).toBe(1)
})

test('repairs a previously cached truncated PNG instead of serving it again', async () => {
  const cacheDir = await tempCache()
  await writeFile(join(cacheDir, '12-1792-1719.png'), png.slice(0, -40))
  let calls = 0
  const app = createCtxApi({ cacheDir, fetchTile: async () => { calls++; return tileResponse() } })
  const response = await app.request('/api/imagery/ctx-v01/12/1792/1719.png?cache=2')
  expect(response.status).toBe(200)
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(png)
  expect(response.headers.get('x-imagery-source')).toBe('CTX V01')
  expect(calls).toBe(1)
  await app.flushCache()
})

test('rejects corrupt V01 and serves the explicitly selected backup without mixing sources', async () => {
  const cacheDir = await tempCache()
  const urls: string[] = []
  const fetchTile = async (url: string) => {
    urls.push(url)
    return url.includes('/CTX1/') ?
      new Response(png.slice(0, -40), { headers: { 'Content-Type': 'image/png' } }) :
      new Response(jpeg, { headers: { 'Content-Type': 'image/jpeg' } })
  }
  const app = createCtxApi({ cacheDir, fetchTile })
  const path = '/api/imagery/ctx-v01/12/1792/1719.png?cache=3&source=beta01'
  expect((await app.request('/api/imagery/ctx-v01/12/1792/1719.png?source=v01')).status).toBe(502)
  const response = await app.request(path)
  expect(response.status).toBe(200)
  expect(response.headers.get('x-imagery-source')).toBe('CTX beta01 fallback')
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(jpeg)
  await app.flushCache()
  const restarted = createCtxApi({ cacheDir, fetchTile })
  expect((await restarted.request(path)).headers.get('x-imagery-source')).toBe('CTX beta01 fallback')
  expect(urls.length).toBe(2)
})

test('rebuilds misplaced level-10 imagery from correctly oriented children and reuses them on zoom', async () => {
  const cacheDir = await tempCache()
  // A valid old image must not bypass the repair just because it decodes.
  await writeFile(join(cacheDir, '10-416-732.png'), png)
  const urls: string[] = []
  const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffffff']
  const children = await Promise.all(colors.map((background) => sharp({
    create: { width: 512, height: 512, channels: 3, background },
  }).png().toBuffer()))
  const fetchTile = async (url: string) => {
    urls.push(url)
    const match = /\/11\/(832|833)\/(1464|1465)$/.exec(url)
    if (!match) throw new Error(`Unexpected tile: ${url}`)
    const quadrant = (Number(match[1]) - 832) * 2 + Number(match[2]) - 1464
    return new Response(children[quadrant], { headers: { 'Content-Type': 'image/png' } })
  }
  const app = createCtxApi({ cacheDir, fetchTile })
  const path = '/api/imagery/ctx-v01/10/416/732.png?cache=4'
  const responses = await Promise.all([app.request(path), app.request(path)])
  expect(responses.map((response) => response.status)).toEqual([200, 200])
  const { data, info } = await sharp(new Uint8Array(await responses[0].arrayBuffer())).raw().toBuffer({ resolveWithObject: true })
  expect([info.width, info.height]).toEqual([512, 512])
  const pixel = (x: number, y: number) => [...data.subarray((y * 512 + x) * info.channels, (y * 512 + x) * info.channels + 3)]
  expect(pixel(128, 128)).toEqual([255, 0, 0])
  expect(pixel(384, 128)).toEqual([0, 255, 0])
  expect(pixel(128, 384)).toEqual([0, 0, 255])
  expect(pixel(384, 384)).toEqual([255, 255, 255])
  expect((await app.request('/api/imagery/ctx-v01/11/833/1465.png')).status).toBe(200)
  await app.flushCache()
  const restarted = createCtxApi({ cacheDir, fetchTile })
  expect((await restarted.request(path)).status).toBe(200)
  expect(urls.length).toBe(4)
})

test('never caches a rebuilt parent when one child is corrupt', async () => {
  const cacheDir = await tempCache()
  const app = createCtxApi({ cacheDir, fetchTile: async (url) => url.endsWith('/833/1465')
    ? new Response(png.slice(0, -40), { headers: { 'Content-Type': 'image/png' } })
    : tileResponse() })
  expect((await app.request('/api/imagery/ctx-v01/10/416/732.png')).status).toBe(502)
  await app.flushCache()
  expect((await readdir(cacheDir)).sort()).toEqual(['11-832-1464.png', '11-832-1465.png', '11-833-1464.png'])
})
