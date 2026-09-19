import { isFiniteNumber } from '../utils/numbers'
import {
  alignReturns, lookbackReturn, pearson,
  type DatedReturn,
} from '../utils/stats'
import { CohortRole } from '../core/types'

import type { CohortCapitalFlip, CohortGroupRule } from './ast'

export const COHORT_LOOKBACK = 20
export const FOLLOW_CORR_MIN = 0.4
export const REVERSE_CORR_MAX = -0.2
export const CORR_WINDOW = 60

export { CohortRole }

export interface CohortMembership {
  group: CohortGroupRule
  role: CohortRole
}

export type CohortCapitalAction = 'KEEP' | 'TRIM' | 'FLIP_TO_MEMBERS' | 'CASH'

function norm(t: string): string {
  return t.trim().toUpperCase()
}

export function resolveCohortMembership(ticker: string, groups: CohortGroupRule[] | undefined): CohortMembership | undefined {
  if (!groups || groups.length === 0) return undefined
  const t = norm(ticker)
  for (const group of groups) {
    if (group.leaders.some(l => norm(l) === t)) return { group, role: CohortRole.leader }
  }
  for (const group of groups) {
    if (group.members.some(m => norm(m) === t)) return { group, role: CohortRole.member }
  }
  return undefined
}

export function lastIndexOnOrBefore(bars: Array<{ date: string }>, asOf: string): number | undefined {
  let found: number | undefined
  for (let i = 0; i < bars.length; i++) {
    if (bars[i]!.date <= asOf) found = i
    else break
  }
  return found
}

export function excess20dAt(
  leaderBars: Array<{ date: string; close: number }>,
  spyBars: Array<{ date: string; close: number }>,
  asOf: string,
): number | undefined {
  const li = lastIndexOnOrBefore(leaderBars, asOf)
  const si = lastIndexOnOrBefore(spyBars, asOf)
  if (li == null || si == null) return undefined
  const lr = lookbackReturn(leaderBars.map(b => b.close), li, COHORT_LOOKBACK)
  const sr = lookbackReturn(spyBars.map(b => b.close), si, COHORT_LOOKBACK)
  if (lr == null || sr == null) return undefined
  return lr - sr
}

export function buildLeaderExcessMap(
  candlesByTicker: Record<string, Array<{ date: string; close: number }>>,
  spyBars: Array<{ date: string; close: number }>,
  asOf: string,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [ticker, bars] of Object.entries(candlesByTicker)) {
    const key = norm(ticker)
    if (key === 'SPY') continue
    const excess = excess20dAt(bars, spyBars, asOf)
    if (excess != null) out[key] = excess
  }
  return out
}

export function memberPolicyFromCorr(corr: number | undefined): 'FOLLOW' | 'REVERSE' | undefined {
  if (corr == null || !isFiniteNumber(corr)) return undefined
  if (corr >= FOLLOW_CORR_MIN) return 'FOLLOW'
  if (corr <= REVERSE_CORR_MAX) return 'REVERSE'
  return undefined
}

export interface CorrAssignment {
  follow: string[]
  reverse: string[]
  unclear: string[]
}

export const COHORT_MACRO_STATUSES = new Set([
  'ACTIVE',
  'CAPEX_EXPANSION',
  'SUPPLY_SHORTAGE',
])

export interface MacroCohortRow {
  narrativeName: string
  status: string
  ticker: string
  exposureType: string
  derivativeTier: number
  explicitTickers?: string[]
}

export function parseTickerList(raw: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of raw.split(/[\s,;]+/)) {
    const t = norm(part)
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

export function parseExplicitTickers(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v: unknown = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map(norm)
  } catch {
    return []
  }
}

export function mapMacroToCohortGroups(
  rows: MacroCohortRow[],
  returnsByTicker: Record<string, DatedReturn[]>,
): CohortGroupRule[] {
  const byName = new Map<string, MacroCohortRow[]>()
  for (const row of rows) {
    if (!COHORT_MACRO_STATUSES.has(row.status.toUpperCase())) continue
    if (row.exposureType.toUpperCase() !== 'BENEFICIARY') continue
    const list = byName.get(row.narrativeName) ?? []
    list.push(row)
    byName.set(row.narrativeName, list)
  }
  const out: CohortGroupRule[] = []
  for (const [name, list] of byName) {
    const explicit = list[0]?.explicitTickers?.map(norm) ?? []
    const tickers = [...new Set(list.map(r => norm(r.ticker)))]
    let leaders = explicit.filter(t => tickers.includes(t) && returnsByTicker[t])
    if (leaders.length === 0) {
      leaders = [...new Set(
        list.filter(r => r.derivativeTier <= 1).map(r => norm(r.ticker)),
      )].filter(t => returnsByTicker[t])
    }
    if (leaders.length === 0) continue
    const leaderRets = returnsByTicker[leaders[0]!]
    if (!leaderRets) continue
    const candidates: Record<string, DatedReturn[]> = {}
    for (const t of tickers) {
      if (leaders.includes(t)) continue
      const rets = returnsByTicker[t]
      if (rets) candidates[t] = rets
    }
    const assigned = assignMembersByCorr(leaderRets, candidates)
    if (assigned.follow.length > 0) {
      out.push({
        name: `${name}/FOLLOW`,
        leaders,
        members: assigned.follow,
        memberPolicy: 'FOLLOW',
      })
    }
    if (assigned.reverse.length > 0) {
      out.push({
        name: `${name}/REVERSE`,
        leaders,
        members: assigned.reverse,
        memberPolicy: 'REVERSE',
      })
    }
  }
  return out
}

export function mergeCohortGroups(
  declared: CohortGroupRule[] | undefined,
  fromMacros: CohortGroupRule[] | undefined,
  useMacros: boolean | undefined,
): CohortGroupRule[] {
  return [
    ...(declared ?? []),
    ...(useMacros ? (fromMacros ?? []) : []),
  ]
}

export function assignMembersByCorr(
  leaderRets: DatedReturn[],
  candidates: Record<string, DatedReturn[]>,
  window: number = CORR_WINDOW,
): CorrAssignment {
  const follow: string[] = []
  const reverse: string[] = []
  const unclear: string[] = []
  for (const [ticker, rets] of Object.entries(candidates)) {
    const aligned = alignReturns(leaderRets, rets)
    const tail = aligned.length > window ? aligned.slice(-window) : aligned
    const corr = pearson(tail.map(r => r.a), tail.map(r => r.b), Math.min(20, window))
    const policy = memberPolicyFromCorr(corr)
    const key = norm(ticker)
    if (policy === 'FOLLOW') follow.push(key)
    else if (policy === 'REVERSE') reverse.push(key)
    else unclear.push(key)
  }
  return {
    follow, reverse, unclear,
  }
}

export function weakestLeaderExcess(group: CohortGroupRule, excessByTicker: Record<string, number> | undefined): number | undefined {
  if (!excessByTicker) return undefined
  const vals: number[] = []
  for (const leader of group.leaders) {
    const v = excessByTicker[norm(leader)]
    if (isFiniteNumber(v)) vals.push(v)
  }
  if (vals.length === 0) return undefined
  return Math.min(...vals)
}

export function cohortEntryRejectReason(
  ticker: string,
  groups: CohortGroupRule[] | undefined,
  excessByTicker: Record<string, number> | undefined,
): string | undefined {
  if (!groups || groups.length === 0) return undefined
  const t = norm(ticker)
  const asLeader = groups.filter(g => g.leaders.some(l => norm(l) === t))
  if (asLeader.some(g => (g.leaderPolicy ?? 'TRADE') === 'SIGNAL_ONLY')) {
    const g = asLeader.find(x => (x.leaderPolicy ?? 'TRADE') === 'SIGNAL_ONLY')!
    return `Cohort SIGNAL_ONLY: ${t} is a signal leader for ${g.name}`
  }
  const hit = resolveCohortMembership(ticker, groups)
  if (!hit || hit.role === CohortRole.leader) return undefined
  const threshold = hit.group.slowdownThreshold ?? 0
  const excess = weakestLeaderExcess(hit.group, excessByTicker)
  if (excess == null) return `Cohort ${hit.group.memberPolicy} ${hit.group.name}: leader excess missing`
  if (hit.group.memberPolicy === 'FOLLOW' && !(excess > threshold)) {
    return `Cohort FOLLOW ${hit.group.name}: weakest leader excess ${excess.toFixed(3)} <= ${threshold}`
  }
  if (hit.group.memberPolicy === 'REVERSE' && !(excess < -threshold)) {
    return `Cohort REVERSE ${hit.group.name}: weakest leader excess ${excess.toFixed(3)} >= ${-threshold}`
  }
  return undefined
}

const FLIP_RANK: Record<CohortCapitalAction, number> = {
  KEEP: 0, TRIM: 1, FLIP_TO_MEMBERS: 2, CASH: 3,
}

export function cohortCapitalAction(
  ticker: string,
  groups: CohortGroupRule[] | undefined,
  excessByTicker: Record<string, number> | undefined,
): CohortCapitalAction {
  if (!groups || groups.length === 0) return 'KEEP'
  const t = norm(ticker)
  let best: CohortCapitalAction = 'KEEP'
  for (const group of groups) {
    if (!group.leaders.some(l => norm(l) === t)) continue
    const flip: CohortCapitalFlip = group.capitalFlip ?? 'NONE'
    if (flip === 'NONE') continue
    const threshold = group.slowdownThreshold ?? 0
    const excess = weakestLeaderExcess(group, excessByTicker)
    if (excess == null || !(excess < -threshold)) continue
    const action: CohortCapitalAction = flip === 'TRIM_LEADERS' ? 'TRIM' : flip === 'ROTATE_TO_MEMBERS' ? 'FLIP_TO_MEMBERS' : 'CASH'
    if (FLIP_RANK[action] > FLIP_RANK[best]) best = action
  }
  return best
}
