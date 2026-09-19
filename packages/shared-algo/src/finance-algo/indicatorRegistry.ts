import type { MarketData } from './screener'

/**
 * SINGLE SOURCE OF TRUTH for documented AST indicators.
 *
 * The public schema reference (apps/docs/public/ast-reference.md) renders its
 * indicator tables FROM this registry (scripts/generate_ast_reference_indicators.ts
 * regenerates the section between the GENERATED:INDICATORS markers), and
 * tests/astReferenceSync.test.ts FAILS CI when the published markdown drifts
 * from the registry.
 *
 * Registry ⊆ reality is compile-enforced: every key below must be a valid
 * dot-path into MarketData (the AstEvaluator resolves `indicator` strings as
 * paths against MarketData — see AstEvaluator.get / evaluateCustomStrategy).
 * Adding a registry key that no longer exists in MarketData, or renaming a
 * MarketData field that a documented indicator points at, is a COMPILE ERROR
 * (the _IndicatorRegistryPathCheck assertion below).
 *
 * The reverse (every MarketData path must be documented) is deliberately NOT
 * enforced — many fields are internal (moat*, prevHighs, rsiHistory, ...) and
 * are not user-facing AST indicators.
 *
 * When adding an indicator: add the MarketData field (if missing), add the
 * registry entry, then run `bun run scripts/generate_ast_reference_indicators.ts`.
 */

export type IndicatorCategory = 'price-trend' | 'ai-sentiment' | 'fundamentals' | 'macro-market'

export interface IndicatorDocEntry {
  category: IndicatorCategory
  description: string
  /** Optional honesty/scale caveat rendered in italics after the description. */
  caveat?: string
}

export const INDICATOR_CATEGORY_LABELS: Record<IndicatorCategory, string> = {
  'price-trend': 'Price action & trend',
  'ai-sentiment': 'AI & sentiment',
  'fundamentals': 'Fundamentals & FCF',
  'macro-market': 'Market & macro',
}

export const INDICATOR_REGISTRY = {
  'currentPrice': { category: 'price-trend', description: 'Latest price' },
  'sma10': { category: 'price-trend', description: '10-period simple moving average' },
  'sma20': { category: 'price-trend', description: '20-period simple moving average' },
  'sma20ExtensionAtr': { category: 'price-trend', description: '`(price − sma20) / atr` — how many ATRs price sits above (or below) the 20-day SMA', caveat: 'undefined when price, sma20, or atr is missing or atr ≤ 0 — fail-closed, never fabricated.' },
  'overnightGapPct': { category: 'price-trend', description: '`(open − previousClose) / previousClose` — signed overnight gap as a decimal (`-0.03` = 3% down gap)', caveat: 'undefined when open or previousClose is missing or previousClose ≤ 0 — fail-closed.' },
  'overnightGapAtr': { category: 'price-trend', description: '`(open − previousClose) / atr` — signed overnight gap in ATR units', caveat: 'undefined when open, previousClose, or atr is missing or atr ≤ 0 — fail-closed.' },
  'sma50': { category: 'price-trend', description: '50-period simple moving average' },
  'sma200': { category: 'price-trend', description: '200-period simple moving average' },
  'ema8': { category: 'price-trend', description: '8-period exponential moving average' },
  'ema21': { category: 'price-trend', description: '21-period exponential moving average' },
  'vwap': { category: 'price-trend', description: 'Volume-weighted average price' },
  'rsi': { category: 'price-trend', description: 'Relative Strength Index' },
  'relativeStrength': { category: 'price-trend', description: '20-day performance vs SPY, as a decimal (`0.05` = 5% outperformance)' },
  'drawdownFrom52WeekHigh': { category: 'price-trend', description: '% drop from 52-week high' },
  'fiftyTwoWeekHigh': { category: 'price-trend', description: 'Absolute 52-week high price' },
  'structuralFloor': { category: 'price-trend', description: 'Absolute 20-day low price' },

  'newsScore': {
    category: 'ai-sentiment',
    description: '1 = catastrophic bearish news, 5 = neutral, 10 = exceptionally bullish',
    caveat: '1–10 scale; undefined when the AI worker has no fresh score — conditions fail closed except `==`/`!=`.',
  },
  'insiderScore': {
    category: 'ai-sentiment',
    description: '1 = heavy insider selling, 10 = heavy insider buying',
    caveat: '1–10 scale; undefined when unscored — see newsScore.',
  },
  'sectorNewsScore': {
    category: 'ai-sentiment',
    description: 'Sector-level news sentiment (1–10), scored independently from sector-ETF news — never blended into newsScore',
    caveat: '1–10 scale; undefined when the sector has no fresh score or is unmapped to an ETF proxy.',
  },
  'macroNewsScore': {
    category: 'ai-sentiment',
    description: 'Macro-narrative exposure score (1–10): bullish-beneficiary exposures push up, bearish headwinds push down',
    caveat: '1–10 scale; undefined when the ticker has no directional macro-narrative exposures.',
  },
  'newsDivergence': {
    category: 'ai-sentiment',
    description: '`newsScore − sectorNewsScore` — positive = company news outperforming its group (idiosyncratic catalyst), negative = laggard',
    caveat: 'undefined when either input is missing — an unknown is not a zero.',
  },
  'newsAlignment': {
    category: 'ai-sentiment',
    description: '`\'CONFIRMED_LEADER\'` \\| `\'IDIOSYNCRATIC_STRENGTH\'` \\| `\'LAGGARD_IN_HOT_SECTOR\'` \\| `\'IDIOSYNCRATIC_WEAKNESS\'` \\| `\'CONFIRMED_WEAK\'` \\| `\'NEUTRAL\'` (compare with `==`)',
    caveat: 'undefined when either company or sector score is missing. IDIOSYNCRATIC_WEAKNESS = weak company in a neutral sector (value-trap signature).',
  },
  'newsScoreDelta': {
    category: 'ai-sentiment',
    description: 'Company news VELOCITY — change at the most recent re-score (persists until the next re-score); +1.5+ = explosive upgrade, −1.5− = deteriorating',
    caveat: 'undefined until a second re-score exists; 0 on pure carry days is NOT fabricated — undefined means no jump recorded.',
  },
  'newsScoreDeltaQuarterly': {
    category: 'ai-sentiment',
    description: 'Company news score change vs ~1 quarter (63 trading days) ago',
    caveat: 'undefined when the score history is younger than a quarter.',
  },
  'sectorNewsDelta': {
    category: 'ai-sentiment',
    description: 'Sector news VELOCITY — latest sector re-score jump (persists until the next sector re-score)',
    caveat: 'undefined until a second sector score exists.',
  },
  'sectorNewsDeltaQuarterly': {
    category: 'ai-sentiment',
    description: 'Sector news score change vs ~1 quarter ago',
    caveat: 'undefined when the sector history is younger than a quarter.',
  },
  'newsScoreTrend': {
    category: 'ai-sentiment',
    description: 'News-score INERTIA — median(second half) − median(first half) over the last ~10 re-scores; a sustained decay spread across small jumps (invisible to `newsScoreDelta`)',
    caveat: 'undefined under 4 score points (rotation_conviction_v1 gates use a `missing` escape for the veto — an unknown never gates as "trend is fine"). Live-scan only; always undefined in backtests.',
  },
  'newsScoreAgeDays': {
    category: 'ai-sentiment',
    description: 'Calendar days since the ticker\'s most recent news score (freshness input for conviction gates)',
    caveat: 'undefined with no score history; conviction arms require ≤ 5 days — a stale high score is not live conviction.',
  },
  'newsScoreRank': {
    category: 'ai-sentiment',
    description: 'Cross-sectional percentile of newsScore within the scored active universe (0..1) — the ROTATION gate: conviction must be current AND in the leading cohort',
    caveat: 'undefined when the scored cohort is under 20 names — evidence-gated fail-open (an unknown passes the veto; only present-and-lagging measurements block).',
  },
  'sectorNewsTrend': {
    category: 'ai-sentiment',
    description: 'Sector-score INERTIA — same drift measure as `newsScoreTrend`, computed on the sector-score history (sector cooling signal)',
    caveat: 'undefined under 4 sector-score points; used by the velocity-exit arm (sector cooling + own score < 6 → trim candidate).',
  },
  'binaryEventSummary': { category: 'ai-sentiment', description: 'AI summary string of a binary event (earnings, FDA, ...)' },

  'isSupplierOfBigWinner': {
    category: 'fundamentals',
    description: '`true` when this ticker supplies a name up +200% over the trailing 12 months',
    caveat: 'research/page flag — not used as a standing AI_COMBINED boost.',
  },
  'isSupplierEarningsPlay': {
    category: 'fundamentals',
    description: '`true` when this ticker supplies a *fresh* +200% winner (crossed in the last ~90d) that reports within 14 days',
    caveat: 'undefined when winner earnings date or 1y closes are missing. Not in default AI_COMBINED scoring — watchlist/custom AST only.',
  },
  'fcfInflection': { category: 'fundamentals', description: '`\'POSITIVE\'` \\| `\'NEGATIVE\'` \\| `\'NONE\'` — structural FCF shift from SEC filings' },
  'fcfSpringFactor': { category: 'fundamentals', description: 'FCF growth vs trailing price return; `>= 2.5` = cash flow compounding while price is compressed' },
  'beta': { category: 'fundamentals', description: 'Volatility vs S&P 500' },

  'marketPrice': { category: 'macro-market', description: 'SPY latest price' },
  'marketSma50': { category: 'macro-market', description: 'SPY 50-period moving average' },
  'marketSma200': { category: 'macro-market', description: 'SPY 200-period moving average' },
  'macroNarrativeHype': { category: 'macro-market', description: 'Sector theme momentum score (shipped presets gate at `>= 6.0`)' },
  'cohortLeaderExcess20d': {
    category: 'macro-market',
    description: 'Weakest named-cohort leader 20d excess vs SPY as a decimal (`0.05` = 5pp). FOLLOW members need this `> threshold`; REVERSE members need `< -threshold`',
    caveat: 'undefined when the ticker is not in `cohortGroups` or leader/SPY lack 20 bars — fail-closed. Not in default AI_COMBINED. Example: NVDA-led AI_INFRA FOLLOW vs CAT robotics REVERSE.',
  },
  'cohortGroupName': { category: 'macro-market', description: 'Name of the matching `cohortGroups` rule (compare with `==`)' },
  'cohortRole': {
    category: 'macro-market',
    description: '`(LEADER | MEMBER)` for the matching cohort group (compare with `==`)',
  },
  'macro.vix': { category: 'macro-market', description: 'CBOE VIX index level' },
  'macro.putCallRatio': {
    category: 'macro-market',
    description: 'Equity put/call ratio',
    caveat: 'Live: options PCR. Historical backtests use the stamped `PROXY_SPY_SMA50` proxy.',
  },
  'macro.chicagoPmi': { category: 'macro-market', description: 'Manufacturing activity (PMI-like scale)' },
  'macro.chicagoPmiChange': { category: 'macro-market', description: 'Prior-print delta on the PMI-like scale' },
  'macro.consumerSentiment': { category: 'macro-market', description: 'U. Michigan consumer sentiment level' },
  'macro.consumerSentimentChange': { category: 'macro-market', description: 'U. Michigan sentiment prior-print delta' },
  'macroRegime': { category: 'macro-market', description: '`\'RISK_ON\'` \\| `\'EARLY_RECOVERY\'` \\| `\'RISK_OFF\'`' },
  'sectorName': { category: 'macro-market', description: 'Sector name, e.g. `\'Technology\'`' },
} satisfies Record<string, IndicatorDocEntry>

// ---------------------------------------------------------------------------
// Reality check: every documented indicator must be a real dot-path into
// MarketData (the evaluator's data context). The ASSERTION lives in
// astSchema.conformance.ts (which is imported by astSchema.ts and therefore
// present in every consumer's tsc program — a standalone assertion here
// would be silently skipped whenever this module has no importers).
// ---------------------------------------------------------------------------

/** Recursively enumerate dot-paths of an object type (arrays & primitives are leaves). */
type PathsOf<T> = T extends readonly unknown[] ? never
  : T extends string | number | boolean | bigint | Date | null | undefined ? never
    : { [K in keyof T & string]: K | `${K}.${PathsOf<T[K]>}` }[keyof T & string]

export type AstIndicatorPaths = PathsOf<MarketData>

// ---------------------------------------------------------------------------
// Markdown renderer for the published AST reference. The generator script and
// the CI sync test both call this, so the published docs and the test can
// never disagree about formatting.
// ---------------------------------------------------------------------------

const CATEGORY_ORDER: IndicatorCategory[] = [
  'price-trend',
  'ai-sentiment',
  'fundamentals',
  'macro-market',
]

export function renderIndicatorSection(registry: typeof INDICATOR_REGISTRY): string {
  // Widen the satisfies-preserved literal union to the doc interface so every
  // entry uniformly exposes the optional caveat (plain assignment, no cast).
  const docs: Record<string, IndicatorDocEntry> = registry
  const blocks: string[] = []
  for (const category of CATEGORY_ORDER) {
    const entries = Object.entries(docs).filter(([
      , e,
    ]) => e.category === category)
    if (entries.length === 0) continue
    const lines = [
      `### ${INDICATOR_CATEGORY_LABELS[category]}`,
      '',
      '| Indicator | Description |',
      '|---|---|',
    ]
    for (const [
      key,
      entry,
    ] of entries) {
      const caveat = entry.caveat ? ` — *${entry.caveat}*` : ''
      lines.push(`| \`${key}\` | ${entry.description}${caveat} |`)
    }
    blocks.push(lines.join('\n'))
  }
  return blocks.join('\n\n')
}
