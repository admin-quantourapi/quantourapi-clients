/**
 * Per-branch realized statistics registry, consumed by `evaluateCustomStrategy`
 * (via `expectedRPerDay`) to compute probability-adjusted Expected Value (EV)
 * per day.
 *
 * The registry ships EMPTY — this module is generic engine mechanics. A
 * deployment that maintains its own per-branch measurement data registers it
 * at boot with `registerBranchStats()`; every consumer then picks the values
 * up through `getBranchStat`. Without registration, all branches resolve to
 * `DEFAULT_BRANCH_STAT` (neutral prior) and `expectedRPerDay` falls back to
 * the naive `rrRatio / estimatedHoldingDays` metric.
 *
 * Stat semantics:
 *   - n: closed trades with realized R pooled across evaluation windows
 *   - winProb: realized win probability in [0, 1]
 *   - avgR: mean realized R-multiple at exit (+0.5 = average winner of half
 *     a risk unit)
 *   - avgHoldDays: mean holding period in trading days
 *
 * CAVEAT: small samples (n < MIN_BRANCH_STAT_N) have wide bootstrap
 * confidence intervals — point estimates from such buckets are directional,
 * not precise. `getBranchStat` substitutes the neutral prior for them rather
 * than trusting the estimate.
 */

/**
 * Register (or extend) the per-branch realized statistics. Idempotent per
 * branch name — later registrations overwrite earlier ones. Intended to run
 * once at deployment boot, before any evaluation consumes the registry.
 */
export interface BranchStat {
  /** Sample size (closed trades with realized R at exit, pooled). */
  n: number
  /** Realized win probability in [0, 1]. */
  winProb: number
  /** Mean realized R-multiple at exit. +0.5 = average winner of half a risk unit. */
  avgR: number
  /** Mean holding period in trading days. */
  avgHoldDays: number
}

/** Populated only via `registerBranchStats` — empty in an unconfigured deployment. */
export const BRANCH_STATS: Record<string, BranchStat> = {}

/**
 * Register (or extend) the per-branch realized statistics. Idempotent per
 * branch name — later registrations overwrite earlier ones. Intended to run
 * once at deployment boot, before any evaluation consumes the registry.
 */
export function registerBranchStats(stats: Record<string, BranchStat>): void {
  Object.assign(BRANCH_STATS, stats)
}

/** Default fallback when a branch has no stats (untagged, defensive, or new branch). */
export const DEFAULT_BRANCH_STAT: BranchStat = {
  n: 0,
  winProb: 0.5, // neutral prior
  avgR: 0,
  avgHoldDays: 20, // matches the AST's prior flat-rotationRules.minHoldingDays
}

/**
 * Anatomy n below this uses the neutral prior instead of the point estimate.
 * Small buckets have wide confidence intervals — a striking point estimate
 * from a small sample is noise until more trades close.
 */
export const MIN_BRANCH_STAT_N = 100

/**
 * Look up realized stats for a branch. Returns the default neutral prior
 * (winProb=0.5, avgR=0, avgHoldDays=20) when the branch has no recorded data
 * or the sample is below MIN_BRANCH_STAT_N.
 */
export function getBranchStat(branchName?: string): BranchStat {
  if (!branchName) return DEFAULT_BRANCH_STAT
  const stat = BRANCH_STATS[branchName]
  if (!stat || stat.n < MIN_BRANCH_STAT_N) return DEFAULT_BRANCH_STAT
  return stat
}

/**
 * Probability-adjusted Expected Value (EV) per trading day.
 *
 * EV = (winProb × rewardR) − (lossProb × riskR), where rewardR = rrRatio (target
 * in R units), riskR = 1 (one R stopped out). Normalizing by holding days gives
 * capital-efficiency in R/day — a 1:2 R setup that pays off in 5 days beats a
 * 1:4 R setup that takes 30 days, even though the second has higher headline R:R.
 *
 * Returns undefined when inputs are missing (caller should fall back to the
 * naive rrRatio/estimatedHoldingDays metric).
 */
export function expectedRPerDay(branchName: string | undefined,
  rrRatio: number | undefined,
  estimatedHoldingDays: number | undefined): number | undefined {
  if (!rrRatio || !estimatedHoldingDays || estimatedHoldingDays <= 0) return undefined
  const stat = getBranchStat(branchName)
  if (stat.n === 0) {
    // No branch data → fall back to naive R/day (no probability weighting).
    return Number((rrRatio / estimatedHoldingDays).toFixed(2))
  }
  const winProb = stat.winProb
  const lossProb = 1 - winProb
  const evPerTrade = winProb * rrRatio - lossProb // riskR = 1
  return Number((evPerTrade / estimatedHoldingDays).toFixed(2))
}
