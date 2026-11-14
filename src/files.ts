import { type Astronaut, type Mission, PlannerError, decodeFile, requestPlan } from './api'

// Reads a packed mission file or a mission JSON. A packed file starts with a
// packet header; JSON starts with a brace. The planner does the checking.
export async function readMissionFile(file: File, roster: Astronaut[]): Promise<Mission> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const text = new TextDecoder()
  if (!text.decode(bytes.subarray(0, 64)).trimStart().startsWith('{')) return decodeFile(bytes)
  let json: unknown
  try {
    json = JSON.parse(text.decode(bytes))
  } catch {
    throw new PlannerError('the file is not valid JSON', 'invalid')
  }
  return (await requestPlan(json, roster)).mission
}

export function download(name: string, content: Uint8Array | string, type: string): void {
  const url = URL.createObjectURL(new Blob([content as BlobPart], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}

export const fileStem = (mission: Mission): string =>
  mission.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mission'
