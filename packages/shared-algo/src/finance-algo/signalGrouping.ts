import {
  BranchRiskProfile, CustomStrategyAST,
} from './ast'
import {
  type SetupResult,
} from './screener'

/**
 * AST-driven signal grouping — the consumer-layer diversification step.
 *
 * Single continuous dial `signalAggressiveness` (0.0..1.0):
 *  - 1.0 = max aggressive: zero penalty -> pure score ranking (top-N by score,
 *    could be all same thesis/sector).
 *  - 0.0 = max diversified: strong penalty for repeating a thesis/sector.
 * A hard `maxTotalSignals` ceiling always bounds the count.
 *
 * Greedy selection: each step picks the candidate maximizing
 *   normalizedScore - (1-aggressiveness) * (W_THESIS*sameThesisAlreadyPicked + W_SECTOR*sameSectorAlreadyPicked)
 * This is a smooth function of ONE float -- no discrete/guessable caps.
 *
 * Shared by the live consumer (apps/client_api clientScanner) and the backtest
 * engine so A/B sweeps measure the exact production logic. Callers pass a
 * `getSector` accessor because the candidate shape differs between contexts.
 */
export interface SignalGroupingOptions {
  signalAggressiveness?: number
  maxTotalSignals?: number
  entryLogic?: CustomStrategyAST['entryLogic']
}

export function groupSignalsByAggressiveness<T extends { setup: SetupResult }>(candidates: T[],
  opts: SignalGroupingOptions,
  getSector: (candidate: T) => string): T[] {
  if (candidates.length === 0) return candidates

  const aggressiveness = Math.max(0, Math.min(1, Number(opts.signalAggressiveness ?? 0.5)))
  const maxTotal = Number(opts.maxTotalSignals ?? 8)
  const penaltyFactor = 1 - aggressiveness // 0 = pure score, 1 = max diversify
  const W_THESIS = 0.5
  const W_SECTOR = 0.5

  // branch name -> investment thesis (riskProfile). Untagged branches bucket as MOMENTUM.
  const thesisOf = new Map<string, BranchRiskProfile>()
  const branches = (opts.entryLogic as { or?: Array<{ name?: string; riskProfile?: BranchRiskProfile }> } | undefined)?.or ?? []
  for (const b of branches) {
    if (b.name && b.riskProfile) thesisOf.set(b.name, b.riskProfile)
  }

  // Normalize raw scores to [0,1] so the penalty scale is comparable across ASTs.
  const scores = candidates.map(c => c.setup.score ?? 0)
  const minS = Math.min(...scores)
  const maxS = Math.max(...scores)
  const range = maxS - minS || 1

  const thesisCount = new Map<string, number>()
  const sectorCount = new Map<string, number>()
  const remaining = new Set<number>(candidates.map((_, i) => i))
  const order: number[] = []

  while (order.length < maxTotal && remaining.size > 0) {
    let bestIdx = -1
    let bestEff = -Infinity
    let bestThesis = 'MOMENTUM'
    let bestSector = 'Unknown'
    for (const i of remaining) {
      const c = candidates[i]!
      const normScore = ((c.setup.score ?? 0) - minS) / range
      const thesis = thesisOf.get((c.setup.firedBranchName ?? '').replace(/ \(\+\d+ confluence\)$/, '')) ?? 'MOMENTUM'
      const sector = getSector(c) || 'Unknown'
      const penalty = penaltyFactor * (W_THESIS * (thesisCount.get(thesis) ?? 0) + W_SECTOR * (sectorCount.get(sector) ?? 0))
      const eff = normScore - penalty
      if (eff > bestEff) {
        bestEff = eff
        bestIdx = i
        bestThesis = thesis
        bestSector = sector
      }
    }
    order.push(bestIdx)
    remaining.delete(bestIdx)
    thesisCount.set(bestThesis, (thesisCount.get(bestThesis) ?? 0) + 1)
    sectorCount.set(bestSector, (sectorCount.get(bestSector) ?? 0) + 1)
  }
  return order.map(i => candidates[i]!)
}
