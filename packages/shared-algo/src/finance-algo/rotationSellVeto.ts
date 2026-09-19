import { isFiniteNumber } from '../utils/numbers'

import type { SellNewsGate } from './ast'

export type RotationSellVeto = 'UNSCORED' | 'LEADER_DIP'

export function isNewsScoreFeedPresent(
  scores: Record<string, { newsScore?: number }>,
): boolean {
  return Object.values(scores).some(s => isFiniteNumber(s?.newsScore))
}

export function rotationSellVeto(opts: {
  gate: SellNewsGate | undefined
  newsScore?: number
  insiderScore?: number
  price?: number
  sma20?: number
  scoreFeedPresent: boolean
}): RotationSellVeto | null {
  const gate = opts.gate ?? 'off'
  if (gate === 'off') return null
  if (!opts.scoreFeedPresent) return null
  if (!isFiniteNumber(opts.newsScore)) return 'UNSCORED'
  if (gate === 'require_score_hold_dip'
    && opts.newsScore >= 7
    && isFiniteNumber(opts.insiderScore) && opts.insiderScore >= 7
    && isFiniteNumber(opts.price) && isFiniteNumber(opts.sma20)
    && opts.price < opts.sma20) {
    return 'LEADER_DIP'
  }
  return null
}
