import { CTX_TILE_SIZE } from '../../../src/data/ctx.js'
import sharp from 'sharp'

// Read the format for response headers. This alone does not validate a file.
export function tileImageType(data: Uint8Array) {
  if (data.byteLength < 24) return null
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => data[i] === byte)) {
    return view.getUint32(16) === CTX_TILE_SIZE && view.getUint32(20) === CTX_TILE_SIZE ? 'image/png' : null
  }
  if (data[0] !== 0xff || data[1] !== 0xd8) return null
  let offset = 2
  while (offset + 3 < data.length) {
    if (data[offset++] !== 0xff) return null
    while (data[offset] === 0xff) offset++
    const marker = data[offset++]
    if (marker === 0xda || marker === 0xd9 || offset + 2 > data.length) return null
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd8) continue
    const length = view.getUint16(offset)
    if (length < 2 || offset + length > data.length) return null
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return length >= 8 && view.getUint16(offset + 3) === CTX_TILE_SIZE &&
        view.getUint16(offset + 5) === CTX_TILE_SIZE ? 'image/jpeg' : null
    }
    offset += length
  }
  return null
}

// Some upstream PNGs have valid headers but truncated IDAT streams. Decode
// every pixel before accepting new or previously cached tiles. Serve the
// original bytes afterward, so validation does not recompress the imagery.
export async function isValidTileImage(data: Uint8Array) {
  if (!tileImageType(data)) return false
  try {
    await sharp(data, { failOn: 'warning', limitInputPixels: CTX_TILE_SIZE ** 2 }).raw().toBuffer()
    return true
  } catch {
    return false
  }
}
