/**
 * Forward-test portfolio naming — "Strategy Risk M/D" labels that tell the
 * user at a glance what a portfolio tests and how it behaves, instead of
 * opaque auto-increment ids ("B2D Portfolio #12").
 *
 * Pure module (no DB/network): the same helpers pre-fill the dashboard deploy
 * modal, generate the server-side fallback for REST clients that omit a name,
 * and power the case-insensitive duplicate check on both sides.
 */

/** Max stored name length — matches forward_test_portfolios.name varchar(120). */
export const PORTFOLIO_NAME_MAX_LENGTH = 120

export type PortfolioAggressiveness = 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE'

const AGGRESSIVENESS_LABELS: Record<PortfolioAggressiveness, string> = {
  CONSERVATIVE: 'Conservative',
  BALANCED: 'Balanced',
  AGGRESSIVE: 'Aggressive',
}

/** Trim, collapse internal whitespace, cap at the column length. */
export function normalizePortfolioName(raw: string): string {
  const collapsed = raw.trim().replace(/\s+/g, ' ')
  return collapsed.length > PORTFOLIO_NAME_MAX_LENGTH
    ? collapsed.slice(0, PORTFOLIO_NAME_MAX_LENGTH)
    : collapsed
}

/**
 * Default name: "<strategyName> <Risk> <M/D>", e.g. "AI_COMBINED Conservative 8/19".
 * Date is month/day (no year) in local time — the label is a glanceable
 * descriptor, not a unique key; per-user uniqueness is enforced separately.
 */
export function defaultForwardTestName(strategyName: string,
  aggressiveness: PortfolioAggressiveness | string,
  date: Date = new Date()): string {
  const strategy = normalizePortfolioName(strategyName) || 'Custom'
  const risk = AGGRESSIVENESS_LABELS[aggressiveness as PortfolioAggressiveness] ?? String(aggressiveness)
  const month = date.getMonth() + 1
  const day = date.getDate()
  return normalizePortfolioName(`${strategy} ${risk} ${month}/${day}`)
}

/** Case-insensitive comparison key for duplicate detection. */
export function nameComparisonKey(name: string): string {
  return normalizePortfolioName(name).toLowerCase()
}

/** True when `candidate` collides (case-insensitive) with any existing name. */
export function isDuplicatePortfolioName(candidate: string, existingNames: readonly string[]): boolean {
  const key = nameComparisonKey(candidate)
  if (!key) return false
  return existingNames.some((existing) => nameComparisonKey(existing) === key)
}
