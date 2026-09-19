/**
 * Structural-thesis snapshot & live validity verdict (2026-08-21).
 *
 * Slow-sleeve positions (thesis-managed branches, e.g. 🌱) get an ENTRY
 * THESIS snapshot — the structural state that justified the trade — stored
 * on the trade row (client_api `trades.thesis`, JSON). The live verdict
 * compares that snapshot against CURRENT metrics so /status and the
 * dashboard can answer "is the thesis still intact?" mechanically, matching
 * the AST's thesis-break exit arms (fcfInflection NEGATIVE, weakness flip).
 */

export interface StructuralThesisSnapshot {
  /** Trade-opening branch (identifies the sleeve). */
  branch: string
  /** True when captured branch is thesis-managed (in the AST's rotationExemptBranches) — set at capture time so consumers need no AST access. */
  structural: boolean
  /** ISO timestamp of capture. */
  capturedAt: string
  /** Structural horizon budget (trading days) — display only. */
  horizonDays: number
  fcfInflection?: string
  fcfSpringFactor?: number
  sectorNewsScore?: number
  newsScore?: number
  newsAlignment?: string
  sector?: string
}

export type ThesisVerdict = 'INTACT' | 'WEAKENING' | 'BROKEN'

export interface ThesisCurrentState {
  fcfInflection?: string
  newsAlignment?: string
  sectorNewsScore?: number
  newsScore?: number
}

/**
 * Live verdict vs the entry snapshot. Mirrors the AST's thesis-break arms:
 *   BROKEN   — fcfInflection flipped to NEGATIVE, or alignment flipped to
 *              IDIOSYNCRATIC_WEAKNESS (the exit arms should fire; this is the
 *              "why is this still open" alarm).
 *   WEAKENING— sector baseline went cold (< 4.5) or company news collapsed
 *              (< 4.0) without the hard breaks — watch closely.
 *   INTACT   — structural pillars unchanged.
 * Fail-closed on missing current data: unknown ≠ broken (verdict WEAKENING
 * would spam on unscored days; INTACT requires no contradiction).
 */
export function structuralThesisVerdict(_thesis: StructuralThesisSnapshot, current: ThesisCurrentState): ThesisVerdict {
  if (current.fcfInflection === 'NEGATIVE') return 'BROKEN'
  if (current.newsAlignment === 'IDIOSYNCRATIC_WEAKNESS') return 'BROKEN'
  if (current.sectorNewsScore != null && current.sectorNewsScore < 4.5) return 'WEAKENING'
  if (current.newsScore != null && current.newsScore < 4.0) return 'WEAKENING'
  return 'INTACT'
}

/**
 * Velocity news-shock arms of AI_COMBINED exitLogic (news < 4, insider < 3.5,
 * laggard, fragile+deteriorating). Used by live exitManager so the sleeve
 * thesis-break arms (FCF NEGATIVE / IDIOSYNCRATIC_WEAKNESS) do not dump
 * momentum positions — those are 🌱-only.
 */
export function isNewsShockExit(md: Record<string, unknown>): boolean {
  if (typeof md.newsScore === 'number' && md.newsScore < 4) return true
  if (typeof md.insiderScore === 'number' && md.insiderScore < 3.5) return true
  if (typeof md.sectorNewsScore === 'number' && md.sectorNewsScore >= 7
    && typeof md.newsDivergence === 'number' && md.newsDivergence <= -2.5) return true
  const down = (typeof md.newsScoreDelta === 'number' && md.newsScoreDelta <= -2)
    || (typeof md.newsScoreDeltaQuarterly === 'number' && md.newsScoreDeltaQuarterly <= -2.5)
  const fragile = (typeof md.peRatio === 'number' && md.peRatio > 50)
    || md.fcfInflection === 'NEGATIVE'
  return down && fragile
}

/** Parse a stored thesis JSON; null when absent/malformed/not structural. */
export function parseStructuralThesis(raw: string | null | undefined): StructuralThesisSnapshot | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const o = parsed as Partial<StructuralThesisSnapshot>
    if (typeof o.branch !== 'string' || o.structural !== true) return null
    return {
      branch: o.branch,
      structural: true,
      capturedAt: typeof o.capturedAt === 'string' ? o.capturedAt : '',
      horizonDays: typeof o.horizonDays === 'number' ? o.horizonDays : 120,
      fcfInflection: o.fcfInflection,
      fcfSpringFactor: o.fcfSpringFactor,
      sectorNewsScore: o.sectorNewsScore,
      newsScore: o.newsScore,
      newsAlignment: o.newsAlignment,
      sector: o.sector,
    }
  } catch {
    return null
  }
}
