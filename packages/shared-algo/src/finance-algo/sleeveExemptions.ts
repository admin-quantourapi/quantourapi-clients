/**
 * Thesis-managed positions (2026-08-21 structural sleeve).
 *
 * A branch listed in `rotationRules.rotationExemptBranches` declares that its
 * positions are managed by THESIS, not by the velocity machinery. The
 * semantics cover BOTH capital-recycling paths that would otherwise churn
 * slow theses out on fast signals:
 *
 *   1. FORCED_ROTATION (capital pressure) — engine already skips exempt trades.
 *   2. STRATEGY_HANDOFF ("branch stopped firing" decay exits) — a slow
 *      thesis's entry gates oscillate day-to-day (RSI band, spring factor),
 *      so branch non-firing is NOISE for these positions, not thesis decay.
 *      Handoff must not close them; the AST's thesis-break exitLogic arms and
 *      stops remain the only exits.
 *
 * The field name stays `rotationExemptBranches` for stored-AST compatibility
 * (seeded canonicals read it); its meaning is "thesis-managed".
 */

/** True when the trade's opening branch is thesis-managed (exempt from rotation AND handoff). */
export function isThesisManagedPosition(firedBranchName: string | undefined | null,
  rotationExemptBranches: string[] | undefined): boolean {
  if (!firedBranchName || !rotationExemptBranches || rotationExemptBranches.length === 0) return false
  return rotationExemptBranches.includes(firedBranchName)
}
