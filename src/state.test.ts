import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { Astronaut } from './api'
import { loadRoster } from './state'

const person: Astronaut = {
  name: 'VEGA', sex: 'female', age: 41, massKg: 70, heightCm: 168,
  role: 'commander', activity: 'active', evaShare: 1,
}
const catalog = { sampleRoster: [{ ...person, name: 'Christina Koch' }] }
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
let saved: Astronaut[]

beforeEach(() => {
  saved = []
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => JSON.stringify(saved) },
  })
})

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
  else Reflect.deleteProperty(globalThis, 'localStorage')
})

test('updating the sample roster keeps edited inputs and custom people', () => {
  const custom = { ...person, name: 'STIVEN', massKg: 82 }
  saved = [person, custom]
  const roster = loadRoster(catalog)
  expect(roster).toEqual([{ ...person, name: 'Christina Koch' }, custom])
  saved = roster
  expect(loadRoster(catalog)).toEqual(roster)
})

test('an existing astronaut profile wins over the former sample entry', () => {
  const edited = { ...person, name: 'Christina Koch', massKg: 75 }
  saved = [person, edited]
  expect(loadRoster(catalog)).toEqual([edited])
})

test('moving a site reorders the route and its tasks go with it', async () => {
  const { createEdits } = await import('./state')
  const edits = createEdits({ taskKinds: ['sample'] } as unknown as Parameters<typeof createEdits>[0])
  const site = (name: string) => ({ name, lat: 0, lon: 0 })
  const task = (at: number, note: string) => ({ site: at, phase: 0, crew: [], kind: 'sample', eva: true, hours: 1, note })
  const draft = { sites: [site('A'), site('B'), site('C')], tasks: [task(0, 'a'), task(2, 'c'), task(1, 'b')] } as unknown as Parameters<typeof edits.moveSite>[0]
  const moved = edits.moveSite(draft, 2, 0)
  expect(moved.sites.map((s) => s.name)).toEqual(['C', 'A', 'B'])
  // Each task still points at the site it was made for.
  expect(moved.tasks.map((t) => [moved.sites[t.site]!.name, t.note])).toEqual([['A', 'a'], ['C', 'c'], ['B', 'b']])
  expect(edits.moveSite(draft, 0, -1)).toBe(draft)
  expect(edits.moveSite(draft, 2, 3)).toBe(draft)
})
