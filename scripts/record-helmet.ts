// Records the helmet view (helmet.html) as a video, one frame at a time, so
// the result does not depend on how fast this machine draws.
//
//   bun scripts/record-helmet.ts --snapshot route.json
//   bun scripts/record-helmet.ts --snapshot route.json --tour quick --hide-notes
//   bun scripts/record-helmet.ts --stills 0,8,13 --out output/helmet
//
// --snapshot     a HUD snapshot: the value the planner keeps in localStorage
//                under nimbs.hud:<mission id>. Without it the HUD says there
//                is no EVA route.
// --out          the video, or with --stills the start of each PNG's name.
//                Default output/helmet.mp4.
// --tour         slow (30 s, the default) or quick (6 s). See src/helmet/look.ts.
// --seconds      default: one pass of the tour.
// --arrive       opens in thick dust that clears while the HUD comes up, and
//                holds the head still for a second first. For the demo film,
//                where this follows a fall from orbit.
// --fps, --width, --height  default 30, 1920, 1080.
// --scale        pixels drawn per output pixel and side, default 2. The extra
//                pixels are averaged away, which smooths rock edges.
// --stills       seconds to save as PNGs instead of a video.
// --silent       no sound.
// --sound        a recording of breathing to use, any format ffmpeg reads.
//                Without it the breathing is made from noise by
//                scripts/breath-sound.ts, in time with the mist on the visor.
// --sound-start  seconds into the recording to begin at, default 0.
// --hide-notes   leaves out the HUD's footer and the "Generated ground" line.
//                The page itself always shows them. A video without them
//                needs the same said wherever it is shown.
// --drop-reason  leaves out HUD reasons that contain this text. The verdict
//                is not recomputed, so only drop a reason that does not carry it.
//
// It drives Chrome over the DevTools protocol and pipes frames to ffmpeg.
// Set CHROME_PATH when Chrome is not in the usual place.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { ARRIVAL_HOLD, BREATH_SECONDS, tourName, tourSeconds } from '../src/helmet/look'
import { SOUND_RATE, breathWav } from './breath-sound'
import type { Recording } from './breath-sound'

const root = fileURLToPath(new URL('../', import.meta.url))
const MISSION = 'recording'

function options() {
  const read: Record<string, string> = {}
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) throw new Error(`Unexpected argument ${args[i]}`)
    // An option with nothing after it is a switch.
    read[args[i].slice(2)] = args[i + 1] === undefined || args[i + 1].startsWith('--') ? '' : args[++i]
  }
  const number = (name: string, fallback: number) => {
    const value = read[name] === undefined ? fallback : Number(read[name])
    if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number`)
    return value
  }
  const tour = tourName(read.tour ?? null)
  if (read.tour !== undefined && read.tour !== tour) throw new Error('--tour must be slow or quick')
  return {
    snapshot: read.snapshot,
    stills: read.stills?.split(',').map(Number),
    out: resolve(read.out ?? (read.stills ? 'output/helmet' : 'output/helmet.mp4')),
    tour,
    silent: read.silent !== undefined,
    sound: read.sound,
    soundStart: read['sound-start'] === undefined ? 0 : Number(read['sound-start']),
    hideNotes: read['hide-notes'] !== undefined,
    dropReason: read['drop-reason'],
    arrive: read.arrive !== undefined,
    seconds: number('seconds', tourSeconds(tour) + (read.arrive !== undefined ? ARRIVAL_HOLD : 0)),
    fps: number('fps', 30),
    width: number('width', 1920),
    height: number('height', 1080),
    scale: number('scale', 2),
  }
}

// Decodes part of a sound file to two channels of samples.
export function readRecording(file: string, start: number, seconds: number): Recording {
  const decoded = Bun.spawnSync(['ffmpeg', '-loglevel', 'error', '-ss', String(start), '-t', String(seconds + 0.1), '-i', file, '-ac', '2', '-ar', String(SOUND_RATE), '-f', 'f32le', '-'])
  if (decoded.exitCode !== 0) throw new Error(`ffmpeg could not read ${file}: ${decoded.stderr.toString().trim()}`)
  const bytes = Math.floor(decoded.stdout.byteLength / 8) * 8
  // Copied, since the bytes ffmpeg hands back need not start on a 4-byte boundary.
  const samples = new Float32Array(decoded.stdout.buffer.slice(decoded.stdout.byteOffset, decoded.stdout.byteOffset + bytes))
  const left = new Float32Array(samples.length / 2)
  const right = new Float32Array(samples.length / 2)
  for (let i = 0; i < left.length; i++) {
    left[i] = samples[2 * i]
    right[i] = samples[2 * i + 1]
  }
  return { left, right }
}

function chromePath() {
  const found = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((path) => path && existsSync(path))
  if (!found) throw new Error('Chrome not found. Set CHROME_PATH to its binary.')
  return found
}

// Runs in the page before its own code. The clock then moves only when the
// recorder says so, and timers that tick by the second fire in step with it.
// Without this the HUD's clock would run at the speed frames are drawn.
function pageSetup(snapshot: string | null, hideNotes: boolean) {
  const hidden = `document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style')
      style.textContent = '.visor__foot, .helmet__note { visibility: hidden }'
      document.head.append(style)
    })`
  return `(() => {
    ${snapshot === null ? '' : `localStorage.setItem('nimbs.hud:${MISSION}', ${JSON.stringify(snapshot)})`}
    ${hideNotes ? hidden : ''}
    const start = Date.now()
    let elapsed = 0
    const timers = new Map()
    let ids = 0
    Date.now = () => start + elapsed
    window.setInterval = (run, every = 0) => {
      timers.set(++ids, { run, every: Math.max(1, every), next: elapsed + Math.max(1, every) })
      return ids
    }
    window.clearInterval = (id) => { timers.delete(id) }
    window.recordingClock = (ms) => {
      elapsed = ms
      for (const timer of timers.values()) {
        while (timer.next <= elapsed) {
          timer.next += timer.every
          timer.run()
        }
      }
    }
  })()`
}

type Message = { id?: number; method?: string; result?: unknown; error?: { message: string } }

// The few parts of the DevTools protocol this needs.
async function connect(url: string) {
  const socket = new WebSocket(url)
  await new Promise<void>((done, fail) => {
    socket.onopen = () => done()
    socket.onerror = () => fail(new Error('Could not reach Chrome'))
  })
  let ids = 0
  const waiting = new Map<number, { done: (result: any) => void; fail: (error: Error) => void }>()
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as Message
    const call = message.id === undefined ? undefined : waiting.get(message.id)
    if (!call) return
    waiting.delete(message.id!)
    if (message.error) call.fail(new Error(message.error.message))
    else call.done(message.result)
  }
  return {
    send: (method: string, params: object = {}, sessionId?: string) =>
      new Promise<any>((done, fail) => {
        waiting.set(++ids, { done, fail })
        socket.send(JSON.stringify({ id: ids, method, params, sessionId }))
      }),
    close: () => socket.close(),
  }
}

async function main() {
  const opts = options()
  let snapshot = opts.snapshot ? await readFile(opts.snapshot, 'utf8') : null
  if (snapshot !== null) {
    const saved = JSON.parse(snapshot)
    if (opts.dropReason && saved.route) {
      const kept = saved.route.reasons.filter((reason: { text: string }) => !reason.text.includes(opts.dropReason!))
      console.log(`Left out ${saved.route.reasons.length - kept.length} of ${saved.route.reasons.length} reasons`)
      saved.route.reasons = kept
      snapshot = JSON.stringify(saved)
    }
  }
  await mkdir(dirname(opts.out), { recursive: true })

  // The helmet page needs no API, so this server skips the project's config
  // and the Go process it starts. It does not watch files either: an edit
  // saved halfway through must not reload the page being recorded.
  const server = await createServer({
    configFile: false, root, plugins: [react()], logLevel: 'error',
    server: { port: 0, host: '127.0.0.1', hmr: false, watch: null },
  })
  await server.listen()
  const address = server.httpServer!.address()
  if (!address || typeof address === 'string') throw new Error('The page server has no port')

  const profile = await mkdtemp(join(tmpdir(), 'helmet-chrome-'))
  const chrome = spawn(chromePath(), [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--hide-scrollbars', '--mute-audio',
    // Draw with the real GPU. The ground shader is far too slow in software.
    '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal',
    'about:blank',
  ], { stdio: 'ignore' })

  let encoder: ReturnType<typeof spawn> | null = null
  try {
    const portFile = join(profile, 'DevToolsActivePort')
    for (let tries = 0; !existsSync(portFile); tries++) {
      if (tries > 100) throw new Error('Chrome did not start')
      await Bun.sleep(100)
    }
    const [port, path] = (await readFile(portFile, 'utf8')).trim().split('\n')
    const cdp = await connect(`ws://127.0.0.1:${port}${path}`)
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    const page = (method: string, params: object = {}) => cdp.send(method, params, sessionId)
    const run = async (expression: string) => {
      const { result, exceptionDetails } = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
      return result.value
    }

    await page('Page.enable')
    await page('Emulation.setDeviceMetricsOverride', { width: opts.width, height: opts.height, deviceScaleFactor: opts.scale, mobile: false })
    await page('Page.addScriptToEvaluateOnNewDocument', { source: pageSetup(snapshot, opts.hideNotes) })
    await page('Page.navigate', { url: `http://127.0.0.1:${address.port}/helmet.html?capture&mission=${MISSION}&tour=${opts.tour}${opts.arrive ? '&arrive' : ''}` })
    for (let tries = 0; !(await run('!!window.helmetCapture && document.fonts.status === "loaded"')); tries++) {
      if (tries > 150) throw new Error(`The helmet page did not start: ${await run('document.body.innerText.slice(0, 300)')}`)
      await Bun.sleep(200)
    }
    console.log(`Drawing with ${await run(`(() => {
      const gl = document.createElement('canvas').getContext('webgl2')
      const info = gl.getExtension('WEBGL_debug_renderer_info')
      return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'an unnamed renderer'
    })()`)}`)

    const shot = async (seconds: number) => {
      await run(`(recordingClock(${Math.round(seconds * 1000)}), helmetCapture.frame(${seconds}))`)
      const { data } = await page('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true })
      return Buffer.from(data, 'base64')
    }

    if (opts.stills) {
      for (const seconds of opts.stills) {
        const file = `${opts.out}-${seconds}.png`
        await writeFile(file, await shot(seconds))
        console.log(file)
      }
    } else {
      const sound = join(profile, 'breath.wav')
      if (!opts.silent) await writeFile(sound, breathWav(opts.seconds, BREATH_SECONDS, opts.sound ? readRecording(opts.sound, opts.soundStart, opts.seconds) : undefined))
      encoder = spawn('ffmpeg', [
        '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(opts.fps), '-c:v', 'png', '-i', '-',
        ...(opts.silent ? [] : ['-i', sound, '-c:a', 'aac', '-b:a', '192k']),
        '-vf', `scale=${opts.width}:${opts.height}:flags=lanczos`,
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', opts.out,
      ], { stdio: ['pipe', 'inherit', 'inherit'] })
      const encoded = new Promise<void>((done, fail) => {
        encoder!.once('error', fail)
        encoder!.once('exit', (code) => (code === 0 ? done() : fail(new Error(`ffmpeg ended with code ${code}`))))
      })
      const total = Math.round(opts.seconds * opts.fps)
      const began = Date.now()
      for (let i = 0; i < total; i++) {
        const frame = await shot(i / opts.fps)
        if (!encoder.stdin!.write(frame)) await new Promise((drained) => encoder!.stdin!.once('drain', drained))
        if ((i + 1) % opts.fps === 0) console.log(`${(i + 1) / opts.fps} of ${opts.seconds} s, ${Math.round((Date.now() - began) / 1000)} s spent`)
      }
      encoder.stdin!.end()
      await encoded
      console.log(opts.out)
    }
    cdp.close()
  } finally {
    encoder?.kill()
    chrome.kill()
    await rm(profile, { recursive: true, force: true }).catch(() => {})
  }
}

// Leaving ends the page server too. Closing it first hangs under Bun.
if (import.meta.main) process.exit(await main().then(() => 0, (error) => {
  console.error(error instanceof Error ? error.message : error)
  return 1
}))
