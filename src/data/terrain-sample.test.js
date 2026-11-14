import { expect, test } from 'bun:test'
import { GeographicTilingScheme } from 'cesium'
import { samplingProvider, sampleSurface } from './terrain-sample'
import { DATUM_OFFSET } from './terrain'

const tile = (height) => ({ interpolateHeight: () => height })

test('sampling shares pending geometry and reuses it across routes and tools', async () => {
  let calls = 0
  const provider = {
    requestTileGeometry: async () => { calls++; return tile(123) },
  }
  const sampler = samplingProvider(provider)
  const a = sampler.requestTileGeometry(1, 2, 14)
  const b = samplingProvider(provider).requestTileGeometry(1, 2, 14)
  expect(a).toBe(b)
  const data = await a
  expect(await sampler.requestTileGeometry(1, 2, 14)).toBe(data)
  expect(calls).toBe(1)
  expect(await samplingProvider({ ...provider }).requestTileGeometry(1, 2, 14)).not.toBe(data)
})

test('sampling retries failed and throttled requests', async () => {
  let calls = 0
  const provider = {
    requestTileGeometry: () => {
      calls++
      if (calls === 1) return undefined
      if (calls === 2) return Promise.reject(Error('network'))
      return Promise.resolve(tile(456))
    },
  }
  const sampler = samplingProvider(provider)
  expect(sampler.requestTileGeometry(0, 0, 14)).toBeUndefined()
  await expect(sampler.requestTileGeometry(0, 0, 14)).rejects.toThrow('network')
  expect((await sampler.requestTileGeometry(0, 0, 14)).interpolateHeight()).toBe(456)
  expect(calls).toBe(3)
})

test('known missing coverage falls back without downloads; unknown coverage still loads', async () => {
  const levels = []
  const provider = {
    tilingScheme: new GeographicTilingScheme(),
    getTileDataAvailable: (_x, _y, level) => level > 10 ? false : undefined,
    requestTileGeometry: async (_x, _y, level) => { levels.push(level); return tile(DATUM_OFFSET + 100) },
  }
  const samples = await sampleSurface(provider, [[18.4, 77.4]], 14)
  expect(levels).toEqual([10])
  expect(samples).toEqual([{ elevation: 100, slope: 0 }])
})

test('the sampling cache evicts least recently used tiles', async () => {
  let calls = 0
  const sampler = samplingProvider({ requestTileGeometry: async () => { calls++; return tile(123) } })
  for (let x = 0; x < 64; x++) await sampler.requestTileGeometry(x, 0, 14)
  await sampler.requestTileGeometry(0, 0, 14)
  await sampler.requestTileGeometry(64, 0, 14)
  await sampler.requestTileGeometry(0, 0, 14)
  expect(calls).toBe(65)
  await sampler.requestTileGeometry(1, 0, 14)
  expect(calls).toBe(66)
})
