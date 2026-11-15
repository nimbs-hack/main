// The sound of the helmet view: breathing over the hum and hiss of a suit
// fan. The fan is always made here, from sines and filtered noise. The
// breathing is a recording when one is given (see "Helmet view sound" in
// data/SOURCES.md for the ones we use). Without one it is made from
// filtered noise, each breath lasting `period` seconds in time with the
// mist on the visor in src/helmet/look.ts: out while the mist grows, in
// while it clears. A recording keeps its own pace.
//
// Returns a 16-bit stereo WAV. The noise comes from a seeded generator, so
// the same call always gives the same sound.

const RATE = 48_000

// Parts of a breath, as shares of its period. A breath out straddles the
// start of the period, so its end is past 1.
const OUT = { from: 0.78, to: 1.24 }
const IN = { from: 0.3, to: 0.66 }

export function noise(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 31 - 1
  }
}

// A band-pass filter whose center can move from sample to sample.
export function band(q: number) {
  let low = 0
  let mid = 0
  return (input: number, hertz: number) => {
    const f = 2 * Math.sin((Math.PI * hertz) / RATE)
    low += f * mid
    mid += f * (input - low - mid / q)
    return mid
  }
}

// 0 outside the part, rising fast and falling slowly inside it.
function swell(phase: number, part: { from: number; to: number }) {
  const at = phase < part.from && part.to > 1 ? phase + 1 : phase
  if (at < part.from || at > part.to) return null
  const x = (at - part.from) / (part.to - part.from)
  return { x, level: Math.sin(Math.PI * x ** 0.7) ** 1.3 }
}

function channel(seconds: number, period: number, seed: number, echoes: [ms: number, gain: number][], breaths: boolean) {
  const count = Math.round(seconds * RATE)
  const dry = new Float32Array(count)
  const air = noise(seed)
  const [outLow, outHigh, inLow, inHigh, hiss] = [band(1.1), band(0.8), band(1.3), band(0.8), band(0.5)]
  for (let i = 0; i < count; i++) {
    const time = i / RATE
    const phase = (time / period) % 1
    const sample = air()
    let value = 0
    const out = breaths ? swell(phase, OUT) : null
    const breatheIn = breaths ? swell(phase, IN) : null
    // Out is the lower, fuller sound and falls in pitch. In is thinner and rises.
    value += (out?.level ?? 0) * (0.9 * outLow(sample, 950 - 430 * (out?.x ?? 0)) + 0.22 * outHigh(sample, 1900))
    value += (breatheIn?.level ?? 0) * (0.5 * inLow(sample, 1400 + 1000 * (breatheIn?.x ?? 0)) + 0.2 * inHigh(sample, 3600))
    // The fan: a low hum with two overtones, and air moving through the helmet.
    value += 0.014 * (Math.sin(2 * Math.PI * 118 * time) + 0.5 * Math.sin(2 * Math.PI * 236 * time) + 0.25 * Math.sin(2 * Math.PI * 354 * time))
    value += 0.09 * hiss(sample, 2600)
    dry[i] = value
  }
  // A helmet is a small hard shell: the sound comes back within milliseconds.
  const wet = new Float32Array(count)
  let smooth = 0
  for (let i = 0; i < count; i++) {
    let value = dry[i]
    for (const [ms, gain] of echoes) {
      const from = i - Math.round((ms / 1000) * RATE)
      if (from >= 0) value += gain * dry[from]
    }
    // The shell also dulls the top end.
    smooth += 0.5 * (value - smooth)
    const edge = Math.min(1, i / (0.02 * RATE), (count - 1 - i) / (0.02 * RATE))
    wet[i] = smooth * edge
  }
  return wet
}

// A recorded breath, 48 kHz, as long as the sound wanted or longer.
export type Recording = { left: Float32Array; right: Float32Array }

export const SOUND_RATE = RATE

// The sound as samples, its loudest at half of full scale.
export function breathSound(seconds: number, period: number, recording?: Recording): Recording {
  const left = channel(seconds, period, 1, [[2.9, 0.4], [6.7, 0.28], [11.3, 0.18]], !recording)
  const right = channel(seconds, period, 2, [[3.4, 0.4], [7.9, 0.28], [10.1, 0.18]], !recording)
  if (recording) {
    if (recording.left.length < left.length) throw new Error('The breathing recording is shorter than the video')
    let loudest = 0
    for (let i = 0; i < left.length; i++) loudest = Math.max(loudest, Math.abs(recording.left[i]), Math.abs(recording.right[i]))
    // The fan sits about 30 dB under the breath, as it does under the made one.
    const level = loudest > 0 ? 0.8 / loudest : 0
    for (let i = 0; i < left.length; i++) {
      const edge = Math.min(1, i / (0.03 * RATE), (left.length - 1 - i) / (0.03 * RATE))
      left[i] += recording.left[i] * level * edge
      right[i] += recording.right[i] * level * edge
    }
  }
  let peak = 0
  for (let i = 0; i < left.length; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]))
  const gain = peak > 0 ? 0.5 / peak : 0
  for (let i = 0; i < left.length; i++) {
    left[i] *= gain
    right[i] *= gain
  }
  return { left, right }
}

// Samples from -1 to 1 as a 16-bit stereo WAV.
export function wav({ left, right }: Recording): Buffer {
  const bytes = left.length * 4
  const file = Buffer.alloc(44 + bytes)
  file.write('RIFF', 0)
  file.writeUInt32LE(36 + bytes, 4)
  file.write('WAVEfmt ', 8)
  file.writeUInt32LE(16, 16)
  file.writeUInt16LE(1, 20) // PCM
  file.writeUInt16LE(2, 22) // channels
  file.writeUInt32LE(RATE, 24)
  file.writeUInt32LE(RATE * 4, 28)
  file.writeUInt16LE(4, 32)
  file.writeUInt16LE(16, 34)
  file.write('data', 36)
  file.writeUInt32LE(bytes, 40)
  const whole = (value: number) => Math.round(Math.max(-1, Math.min(1, value)) * 32767)
  for (let i = 0; i < left.length; i++) {
    file.writeInt16LE(whole(left[i]), 44 + i * 4)
    file.writeInt16LE(whole(right[i]), 46 + i * 4)
  }
  return file
}

export const breathWav = (seconds: number, period: number, recording?: Recording): Buffer => wav(breathSound(seconds, period, recording))
