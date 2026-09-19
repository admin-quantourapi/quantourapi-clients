/**
 * Rotation gate diagnostics — ATTRIBUTION for the live-only gates
 * (rotation_conviction_v1 rank/trend/age vetoes + the SECTOR_ROTATION_TRIM
 * exit arm).
 *
 * WHY this exists (2026-09-01): the vetoes live in the AST as or-groups, so
 * when a momentum branch is blocked the scanner just sees "branch did not
 * fire" — the BLOCK is invisible. These gates are also NOT backtestable
 * (fields don't exist in any backtest mode; the `missing` escape passes
 * them), so the live forward test is the ONLY arbiter — and without an
 * activation log there is no arbiter at all. Every event records the price
 * AT SIGNAL TIME so `scripts/diagnose_rotation_gates.ts` can later join the
 * candle cache and answer the counterfactual: "did the veto block a trade
 * that would have made money?"
 *
 * Detection principle: for each GROWTH/MOMENTUM branch, evaluate a clone
 * with the veto or-groups REMOVED ("technical-armed" projection). If the
 * projection fires but the full branch does not, a gate blocked it; the
 * individual veto groups are then evaluated to attribute RANK vs TREND, and
 * a residual (both veto groups pass, branch still fails) attributes AGE —
 * the arm-level freshness gates are the dominant residual cause (documented
 * imperfection: another arm could theoretically be the blocker).
 *
 * Pure + unit-tested (AstEvaluator-driven, no DB, no network).
 */
import type { CustomStrategyAST, ASTNode } from './ast'
import { AstEvaluator } from './AstEvaluator'
import type { MarketData } from './screener'

export type RotationGateKind = 'VETO_BLOCK' | 'TRIM_SIGNAL'
export type RotationGateVetoType = 'RANK' | 'TREND' | 'AGE'

export interface RotationGateEvent {
  kind: RotationGateKind
  ticker: string
  branchName?: string
  vetoType?: RotationGateVetoType
  rank?: number
  trend?: number
  ageDays?: number
  sectorNewsScore?: number
  newsScore?: number
  priceAtSignal?: number
  rescued?: boolean
  strategyName?: string
  /** Client provenance (telegram chatId) for client_api-emitted events. */
  chatId?: string
}

/** A veto or-group: an `or` node containing a rank or trend condition. */
function isVetoGroup(node: ASTNode): 'RANK' | 'TREND' | null {
  if (!('or' in node) || !Array.isArray((node as { or?: unknown[] }).or)) return null
  const arms = (node as { or: Array<Record<string, unknown>> }).or
  for (const arm of arms) {
    const indicator = typeof arm?.indicator === 'string' ? arm.indicator : ''
    if (indicator === 'newsScoreRank') return 'RANK'
    if (indicator === 'newsScoreTrend') return 'TREND'
  }
  return null
}

interface GateContext {
  branch: Extract<ASTNode, { and?: unknown }> & Record<string, unknown>
  rankGroup: ASTNode | null
  trendGroup: ASTNode | null
}

function collectVetoGroups(branch: Record<string, unknown>): GateContext | null {
  const and = branch.and
  if (!Array.isArray(and)) return null
  let rankGroup: ASTNode | null = null
  let trendGroup: ASTNode | null = null
  for (const node of and) {
    const kind = isVetoGroup(node as ASTNode)
    if (kind === 'RANK' && !rankGroup) rankGroup = node as ASTNode
    if (kind === 'TREND' && !trendGroup) trendGroup = node as ASTNode
  }
  return { branch, rankGroup, trendGroup }
}

function stripGroups(ctx: GateContext): ASTNode {
  const clone = JSON.parse(JSON.stringify(ctx.branch)) as Record<string, unknown>
  // Remove the veto or-groups AND every arm-level freshness condition
  // (newsScoreAgeDays) — the AGE attribution needs a projection where ONLY
  // the freshness gates can block. Without this, a stale-age block never
  // reaches the detector (the stripped branch would still fail on the arm).
  const stripAgeDeep = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(stripAgeDeep).filter(n => n !== undefined)
    if (node && typeof node === 'object') {
      const rec = node as Record<string, unknown>
      if (rec.indicator === 'newsScoreAgeDays') return undefined
      const out: Record<string, unknown> = {}
      for (const [
        k,
        v,
      ] of Object.entries(rec)) {
        const stripped = stripAgeDeep(v)
        if (stripped !== undefined) out[k] = stripped
      }
      return out
    }
    return node
  }
  clone.and = stripAgeDeep(clone.and)
  clone.and = (clone.and as unknown[]).filter(n => {
    const kind = isVetoGroup(n as ASTNode)
    return kind === null
  })
  return clone as unknown as ASTNode
}

/**
 * Detect every momentum/GROWTH candidate whose TECHNICAL arms matched but a
 * rotation gate blocked. Emits one event per blocked branch.
 */
export function detectRotationVetoBlocks(
  ast: CustomStrategyAST,
  data: MarketData,
): RotationGateEvent[] {
  const events: RotationGateEvent[] = []
  const branches = (ast.entryLogic as { or?: Array<Record<string, unknown>> } | undefined)?.or ?? []
  for (const branch of branches) {
    const profile = branch.riskProfile
    if (profile !== 'GROWTH' && profile !== 'MOMENTUM') continue
    const ctx = collectVetoGroups(branch)
    if (!ctx) continue
    const dataRecord: Record<string, unknown> = { ...data }
    const fullFires = AstEvaluator.evaluate(branch as unknown as ASTNode, dataRecord)
    if (fullFires) continue
    const strippedFires = AstEvaluator.evaluate(stripGroups(ctx), dataRecord)
    if (!strippedFires) continue // technical arms themselves failed — not a gate story

    const rankPasses = ctx.rankGroup ? AstEvaluator.evaluate(ctx.rankGroup, dataRecord) : true
    const trendPasses = ctx.trendGroup ? AstEvaluator.evaluate(ctx.trendGroup, dataRecord) : true
    let vetoType: RotationGateVetoType
    let rescued = false
    if (!rankPasses) {
      vetoType = 'RANK'
      // The rank group's own escape arms (rank missing / hot sector) failing
      // means the group itself says "known laggard"; rescued describes the
      // positive evidence present: a hot sector that nevertheless did not
      // clear the 6.5 threshold.
      rescued = typeof data.sectorNewsScore === 'number' && data.sectorNewsScore >= 6.0
    } else if (!trendPasses) {
      vetoType = 'TREND'
    } else {
      // Both explicit vetoes passed but the branch still failed → the block
      // came from an arm-level gate. AGE (the freshness gates added with
      // rotation_conviction_v1) is the dominant candidate; logged with the
      // actual age so the analyst can verify.
      vetoType = 'AGE'
      rescued = false
    }
    events.push({
      kind: 'VETO_BLOCK',
      ticker: String(data.ticker ?? ''),
      branchName: typeof branch.name === 'string' ? branch.name : undefined,
      vetoType,
      rank: typeof data.newsScoreRank === 'number' ? data.newsScoreRank : undefined,
      trend: typeof data.newsScoreTrend === 'number' ? data.newsScoreTrend : undefined,
      ageDays: typeof data.newsScoreAgeDays === 'number' ? data.newsScoreAgeDays : undefined,
      sectorNewsScore: typeof data.sectorNewsScore === 'number' ? data.sectorNewsScore : undefined,
      newsScore: typeof data.newsScore === 'number' ? data.newsScore : undefined,
      priceAtSignal: typeof data.currentPrice === 'number' ? data.currentPrice : undefined,
      rescued,
      strategyName: ast.strategyName,
    })
  }
  return events
}
