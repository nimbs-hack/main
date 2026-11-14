import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type TileBytes = Uint8Array<ArrayBuffer>

type Options = {
  cacheDir: string
  maxTiles?: number
  memoryBytes?: number
  validate?: (data: TileBytes) => boolean | Promise<boolean>
}

// Network responses go to the renderer immediately. Disk writes drain separately.
export function createTileCache({ cacheDir, maxTiles = 2048, memoryBytes = 32 * 1024 * 1024, validate }: Options) {
  const memory = new Map<string, TileBytes>()
  const pending = new Map<string, Promise<TileBytes>>()
  let usedBytes = 0
  let files: Set<string> | undefined
  let writes = Promise.resolve()

  function remember(key: string, data: TileBytes) {
    const previous = memory.get(key)
    if (previous) usedBytes -= previous.byteLength
    memory.delete(key)
    memory.set(key, data)
    usedBytes += data.byteLength
    for (const [old, bytes] of memory) {
      if (usedBytes <= memoryBytes) break
      memory.delete(old)
      usedBytes -= bytes.byteLength
    }
  }

  function store(key: string, data: TileBytes) {
    writes = writes.then(async () => {
      await mkdir(cacheDir, { recursive: true })
      files ??= new Set((await readdir(cacheDir, { withFileTypes: true }))
        .filter((file) => file.isFile() && !file.name.endsWith('.tmp')).map((file) => file.name))
      const file = join(cacheDir, key)
      const temp = `${file}.${crypto.randomUUID()}.tmp`
      try {
        await writeFile(temp, data)
        await rename(temp, file)
      } finally {
        await rm(temp, { force: true })
      }
      files.delete(key)
      files.add(key)
      for (const old of files) {
        if (files.size <= maxTiles) break
        await rm(join(cacheDir, old), { force: true })
        files.delete(old)
      }
    }).catch((error: unknown) => console.warn('Tile disk cache unavailable', error))
  }

  async function read(key: string) {
    const hit = memory.get(key)
    if (hit) {
      remember(key, hit)
      return hit
    }
    const disk = await readFile(join(cacheDir, key)).catch(() => null)
    if (!disk) return undefined
    const data = new Uint8Array(disk)
    if (validate && !await validate(data)) {
      await rm(join(cacheDir, key), { force: true })
      files?.delete(key)
      return undefined
    }
    remember(key, data)
    return data
  }

  async function get(key: string, fetchTile: () => Promise<TileBytes>): Promise<TileBytes> {
    const existing = pending.get(key)
    if (existing) return existing
    const job = (async () => {
      const hit = await read(key)
      if (hit) return hit
      const data = await fetchTile()
      if (validate && !await validate(data)) throw new Error('Invalid tile image')
      remember(key, data)
      store(key, data)
      return data
    })()
    pending.set(key, job)
    try {
      return await job
    } finally {
      pending.delete(key)
    }
  }

  async function flush() {
    // A failed composite can leave its other child downloads in flight.
    // Let them finish before waiting for the writes they enqueue.
    await Promise.allSettled([...pending.values()])
    await writes
  }

  return { get, read, flush }
}
