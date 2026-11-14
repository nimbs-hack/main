const MAX_BLOB_URL_ENTRIES = 32;

const blobUrlCache = new Map<string, string>();
const inFlightRenders = new Map<string, Promise<string>>();

function rememberBlobUrl(key: string, blob: Blob): string {
  const existing = blobUrlCache.get(key);
  if (existing) {
    blobUrlCache.delete(key);
    blobUrlCache.set(key, existing);
    return existing;
  }

  const url = URL.createObjectURL(blob);
  blobUrlCache.set(key, url);

  while (blobUrlCache.size > MAX_BLOB_URL_ENTRIES) {
    const oldestKey = blobUrlCache.keys().next().value;
    if (!oldestKey) break;
    const oldestUrl = blobUrlCache.get(oldestKey);
    blobUrlCache.delete(oldestKey);
    if (oldestUrl) {
      URL.revokeObjectURL(oldestUrl);
    }
  }
  return url;
}

export function getCachedOverlayBlobUrl(key: string): string | null {
  const existing = blobUrlCache.get(key);
  if (!existing) return null;
  blobUrlCache.delete(key);
  blobUrlCache.set(key, existing);
  return existing;
}

export function cacheOverlayBlob(key: string, blob: Blob): string {
  return rememberBlobUrl(key, blob);
}

/**
 * Encode raw RGBA pixel buffer into a browser-native PNG Blob without main-thread zlib.
 * Uses OffscreenCanvas when available and falls back to an off-DOM HTMLCanvasElement.
 */
export async function encodeRgbaBufferToPngBlob(
  cols: number,
  rows: number,
  rgbaBuffer: ArrayBuffer,
): Promise<Blob> {
  const clamped = new Uint8ClampedArray(rgbaBuffer);
  const imageData = new ImageData(clamped, cols, rows);

  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(cols, rows);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("2D context unavailable for OffscreenCanvas");
    }
    ctx.putImageData(imageData, 0, 0);
    return canvas.convertToBlob({ type: "image/png" });
  }

  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = cols;
    canvas.height = rows;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("2D context unavailable for canvas");
    }
    ctx.putImageData(imageData, 0, 0);
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Canvas toBlob produced null"));
      }, "image/png");
    });
  }

  throw new Error("No browser Canvas implementation available to encode overlay PNG");
}

/** Coalesce concurrent requests for the same overlay cache key cleanly. */
export function runCoalescedOverlayRender(
  key: string,
  task: () => Promise<string>,
): Promise<string> {
  const cached = getCachedOverlayBlobUrl(key);
  if (cached) return Promise.resolve(cached);

  const pending = inFlightRenders.get(key);
  if (pending) return pending;

  const promise = task().finally(() => {
    inFlightRenders.delete(key);
  });
  inFlightRenders.set(key, promise);
  return promise;
}
