import { expect, test } from 'bun:test'
import { tileImageType, isValidTileImage } from './tile-image.ts'
import sharp from 'sharp'

test('rejects truncated, out-of-bounds and wrong-size JPEG headers', () => {
  const jpeg = new Uint8Array(32)
  jpeg.set([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 2, 0, 2, 0, 3])
  expect(tileImageType(jpeg)).toBe('image/jpeg')
  expect(tileImageType(jpeg.slice(0, 24))).toBeNull()
  jpeg[14] = 1
  expect(tileImageType(jpeg)).toBeNull()
  jpeg[14] = 0
  jpeg[4] = 255
  expect(tileImageType(jpeg)).toBeNull()
  expect(tileImageType(new Uint8Array(128))).toBeNull()
})

test('decodes the complete image rather than trusting dimensions in a valid header', async () => {
  const png = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#888888' } }).png().toBuffer()
  const jpeg = await sharp(png).jpeg().toBuffer()
  expect(await isValidTileImage(png)).toBe(true)
  expect(await isValidTileImage(jpeg)).toBe(true)
  const truncated = png.subarray(0, png.length - 40)
  expect(tileImageType(truncated)).toBe('image/png')
  expect(await isValidTileImage(truncated)).toBe(false)
  expect(await isValidTileImage(jpeg.subarray(0, jpeg.length - 40))).toBe(false)
})
