/**
 * Generic return-statistics helpers (pure math, no strategy logic).
 *
 * Extracted from finance-algo/cohortLeader.ts so published client packages can
 * depend on the math without shipping the proprietary cohort thesis.
 */
import { isFiniteNumber } from './numbers'

export const COHORT_MIN_N = 20
export const COHORT_MIN_MEMBERS = 3

export interface DatedReturn {
  date: string
  ret: number
}

export function closesToReturns(bars: Array<{ date: string; close: number }>): DatedReturn[] {
  const out: DatedReturn[] = []
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1]!.close
    const cur = bars[i]!.close
    if (!(prev > 0) || !isFiniteNumber(cur)) continue
    out.push({ date: bars[i]!.date, ret: (cur - prev) / prev })
  }
  return out
}

export function alignReturns(a: DatedReturn[], b: DatedReturn[]): Array<{ date: string; a: number; b: number }> {
  const bByDate = new Map(b.map(r => [r.date, r.ret]))
  const out: Array<{ date: string; a: number; b: number }> = []
  for (const row of a) {
    const bv = bByDate.get(row.date)
    if (!isFiniteNumber(bv) || !isFiniteNumber(row.ret)) continue
    out.push({ date: row.date, a: row.ret, b: bv })
  }
  return out
}

export function equalWeightReturns(members: DatedReturn[][], minMembers: number = COHORT_MIN_MEMBERS): DatedReturn[] {
  const byDate = new Map<string, number[]>()
  for (const series of members) {
    for (const row of series) {
      if (!isFiniteNumber(row.ret)) continue
      const list = byDate.get(row.date)
      if (list) list.push(row.ret)
      else byDate.set(row.date, [row.ret])
    }
  }
  const dates = [...byDate.keys()].sort()
  const out: DatedReturn[] = []
  for (const date of dates) {
    const vals = byDate.get(date)!
    if (vals.length < minMembers) continue
    const sum = vals.reduce((acc, v) => acc + v, 0)
    out.push({ date, ret: sum / vals.length })
  }
  return out
}

export function pearson(xs: number[], ys: number[], minN: number = COHORT_MIN_N): number | undefined {
  if (xs.length !== ys.length || xs.length < minN) return undefined
  let sx = 0
  let sy = 0
  for (let i = 0; i < xs.length; i++) {
    if (!isFiniteNumber(xs[i]) || !isFiniteNumber(ys[i])) return undefined
    sx += xs[i]!
    sy += ys[i]!
  }
  const n = xs.length
  const mx = sx / n
  const my = sy / n
  let num = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < n; i++) {
    const xa = xs[i]! - mx
    const ya = ys[i]! - my
    num += xa * ya
    dx += xa * xa
    dy += ya * ya
  }
  if (!(dx > 0) || !(dy > 0)) return undefined
  return num / Math.sqrt(dx * dy)
}

export function lookbackReturn(closes: number[], idx: number, bars: number): number | undefined {
  const j = idx - bars
  if (j < 0 || idx >= closes.length) return undefined
  const a = closes[j]!
  const b = closes[idx]!
  if (!(a > 0) || !isFiniteNumber(b)) return undefined
  return (b - a) / a
}
