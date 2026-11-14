const KJ_PER_KCAL = 4.184
const MJ_PER_KWH = 3.6

export const num = (value: number, digits = 0): string =>
  value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })

export const kcal = (megajoules: number): number => (megajoules * 1000) / KJ_PER_KCAL
export const kwh = (megajoules: number): number => megajoules / MJ_PER_KWH

export const range = (r: { min: number; max: number }): string => `${num(r.min)}-${num(r.max)}`

export function duration(seconds: number): string {
  if (seconds < 1) return `${num(seconds * 1000)} ms`
  if (seconds < 120) return `${num(seconds, 1)} s`
  return `${num(seconds / 60, 1)} min`
}

// "flight-engineer" reads better on screen as "flight engineer".
export const words = (id: string): string => id.replaceAll('-', ' ')
