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
