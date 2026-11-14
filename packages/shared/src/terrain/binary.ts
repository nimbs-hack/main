import type { SiteMetadata } from "../types";

export interface StaticSiteManifest {
  version: number;
  generatedAt: string;
  meta: SiteMetadata;
  terrainBinFile: string;
  terrainByteLength: number;
  hillshadeFile: string;
  weatherFallbackFile: string;
}

const HOST_IS_LITTLE_ENDIAN =
  new Uint32Array(new Uint8Array([1, 2, 3, 4]).buffer)[0] === 0x04030201;

/** Encode row-major elevation floats as compact little-endian Float32 bytes. */
export function encodeTerrainBinary(elevations: Float32Array | readonly number[]): Uint8Array {
  const count = elevations.length;
  const bytes = new Uint8Array(count * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < count; i += 1) {
    view.setFloat32(i * 4, elevations[i] ?? 0, true);
  }
  return bytes;
}

/** Decode little-endian Float32 elevation buffer back into Float32Array. */
export function decodeTerrainBinary(buffer: ArrayBuffer, expectedCells: number): Float32Array {
  const expectedBytes = expectedCells * 4;
  if (buffer.byteLength !== expectedBytes) {
    throw new Error(
      `Invalid terrain binary length: expected ${expectedBytes} bytes for ${expectedCells} cells, got ${buffer.byteLength}`,
    );
  }
  if (HOST_IS_LITTLE_ENDIAN) {
    return new Float32Array(buffer);
  }
  const view = new DataView(buffer);
  const out = new Float32Array(expectedCells);
  for (let i = 0; i < expectedCells; i += 1) {
    out[i] = view.getFloat32(i * 4, true);
  }
  return out;
}
