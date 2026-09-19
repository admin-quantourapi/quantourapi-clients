import { z } from 'zod'

import {
  Language, t,
} from '../core/i18n'
import { getTradingDaysBetween } from '../core/marketHours'
import {
  CohortRole,
  FedRateTrajectory,
  GlobalLiquidityTrend,
  ImpactType,
  LiquidityPhase,
  MacroExposureType,
  MarketRegime,
  RecentOutcomeType,
  RiskProfile,
} from '../core/types'
import { isFiniteNumber } from '../utils/numbers'

import {
  type CohortGroupRule, CustomStrategyAST, UniverseRules,
} from './ast'
import {
  cohortEntryRejectReason, mergeCohortGroups, resolveCohortMembership, weakestLeaderExcess,
} from './cohortGroups'
import { AstEvaluator } from './AstEvaluator'
import { computeSma20ExtensionAtr } from './atr'
import { expectedRPerDay } from './branchStats'
import { isNewsScoreFeedPresent, rotationSellVeto, type RotationSellVeto } from './rotationSellVeto'

/**
 * Classification of a ticker's company-vs-sector news relationship. Declared
 * here (next to the MarketData field it types); the proprietary divergence
 * classifier imports it from this module.
 */
export type NewsAlignment =
  | 'CONFIRMED_LEADER' // strong company news in a hot sector — trend-confirmed
  | 'IDIOSYNCRATIC_STRENGTH' // strong company news in a cold/neutral sector — isolated catalyst
  | 'LAGGARD_IN_HOT_SECTOR' // weak company news in a hot sector — distribution candidate
  | 'IDIOSYNCRATIC_WEAKNESS' // weak company news in a NEUTRAL sector — company-specific deterioration (value-trap signature: bleeds while its group is fine)
  | 'CONFIRMED_WEAK' // weak company news in a cold sector — sell/avoid
  | 'NEUTRAL' // mid-band company — no divergence signal

export const NEWS_ALIGNMENT_VALUES: readonly NewsAlignment[] = [
  'CONFIRMED_LEADER',
  'IDIOSYNCRATIC_STRENGTH',
  'LAGGARD_IN_HOT_SECTOR',
  'IDIOSYNCRATIC_WEAKNESS',
  'CONFIRMED_WEAK',
  'NEUTRAL',
] as const

export const MarketDataCoercionSchema = z.object({
  ticker: z.string(),
  currentPrice: z.coerce.number(),
  structuralFloor: z.coerce.number().optional(),
  atr: z.coerce.number().optional(),
  sma200: z.coerce.number().optional(),
  sma50: z.coerce.number().optional(),
  sma20: z.coerce.number().optional(),
  sma20ExtensionAtr: z.coerce.number().optional(),
  overnightGapPct: z.coerce.number().optional(),
  overnightGapAtr: z.coerce.number().optional(),
  sma10: z.coerce.number().optional(),
  rsi: z.coerce.number().optional(),
  relativeStrength: z.coerce.number().optional(),
  ema8: z.coerce.number().optional(),
  ema21: z.coerce.number().optional(),
  vwap: z.coerce.number().optional(),
  newsScore: z.coerce.number().optional(),
  insiderScore: z.coerce.number().optional(),
  marketCap: z.coerce.number().optional(),
  avgVolume: z.coerce.number().optional(),
  volumePace: z.coerce.number().optional(),
}).passthrough()

export interface MarketData {
  ticker: string
  currentPrice: number
  marketCap?: number
  // Technical indicator fields are OPTIONAL: omit when unknown (live scan
  // stale metrics, or IndicatorEngine when candles.length < period). Never
  // fabricate RSI 50 / ATR 0 / short-window SMAs to make them required.
  // AST comparisons against undefined fail-closed. Use CandleMarketData
  // when a candle path has actually produced atr/sma20/sma10/rsi.
  structuralFloor?: number
  atr?: number
  avgAtr?: number
  fiftyTwoWeekHigh?: number
  atrMultiplier?: number
  maxRisk: number
  sma200?: number
  sma50?: number
  sma20?: number
  sma20ExtensionAtr?: number
  overnightGapPct?: number
  overnightGapAtr?: number
  sma10?: number
  rsi?: number
  avgVolume?: number
  currentVolume?: number
  volumePace?: number
  marketPrice?: number
  marketSma200?: number
  marketSma50?: number
  techMarketPrice?: number
  techMarketSma200?: number
  marketBreadth?: number
  marketAtrPercent?: number
  relativeStrength?: number
  ema8?: number
  ema21?: number
  vwap?: number
  vwapDeviation?: number
  rsiHistory?: number[]
  isMomentumPositive?: boolean
  prevHighs?: number[]
  prevLows?: number[]
  /**
   * Kaufman Efficiency Ratio over the recent window (0..1).
   * 1.0 = perfectly trending, 0.0 = perfectly choppy.
   * Populated by the backtest engine from `history`; live callers (masterScanner,
   * forwardTestMarketData) leave this undefined, and `evaluateCustomStrategy`
   * falls back to a neutral 0.5. Deliberately NOT in `MarketDataCoercionSchema`
   * — external/B2D API callers must not inject it.
   */
  efficiencyRatio?: number
  latestEarnings?: string
  nextEarnings?: string
  dividendAmount?: number
  exDividendDate?: string
  analystTarget?: number
  marketStatus?: string
  sectorPerformance?: string
  sectorName?: string
  industryName?: string
  beta?: number
  isDefensive?: boolean
  defensiveReason?: string
  isDangerous?: boolean
  /**
   * True when this ticker supplies at least one name whose trailing 12-month
   * close-to-close return exceeds +200%. Fail-closed undefined when the
   * second-derivative scan has not classified the ticker (missing 1y close
   * or no supplier edges). Live/FT: table lookup. Backtest: current graph +
   * trailing 1y as-of-T (stamped CURRENT_GRAPH+TRAILING_1Y).
   */
  isSupplierOfBigWinner?: boolean
  /**
   * True only when this ticker supplies a *fresh* +200% 12m winner (crossed
   * that threshold in the last ~90d) whose next earnings print is within
   * 14 calendar days. Fail-closed undefined when earnings or 1y closes are
   * missing. Not a standing overweight of last year's winners.
   */
  isSupplierEarningsPlay?: boolean
  binaryEventSummary?: string
  binaryEventImpact?: ImpactType
  macroNarratives?: Array<{ exposureType: string; derivativeTier: number; narrativeName: string; status: string }>
  hasMacroNarrativeTailwind?: boolean
  /**
   * Moat fields are DISPLAY-ONLY research context (UI badges / deep research).
   * They MUST NOT gate setup validity, AST score, or conviction sizing.
   */
  moatWindScore?: number
  moatStrength?: number
  /** Multi-factor label helper for UI (−1..1); not used by evaluateCustomStrategy. */
  moatConfluence?: number
  macroNarrativeHype?: number // Hype score (0-100) based on update volume
  newsScore?: number
  insiderScore?: number
  /**
   * Group-level news sentiment — INDEPENDENT of newsScore (never blended):
   * sectorNewsScore = sector-ETF news via Gemini (1-10), macroNewsScore =
   * derived from macro_narrative_exposure polarity (1-10). Both fail closed
   * (undefined) when their source has no fresh data. Divergence/alignment
   * below classify a ticker as group-aligned or outlier.
   */
  sectorNewsScore?: number
  macroNewsScore?: number
  /** newsScore − sectorNewsScore; undefined when either input is missing. */
  newsDivergence?: number
  /** Classification of company-vs-sector divergence (see newsDivergence.ts). */
  newsAlignment?: NewsAlignment
  /**
   * News VELOCITY (the DIFF — explosive moves live here): change at the most
   * recent company re-score (persists until the next re-score), and the
   * change vs the score a quarter ago. Big negative diffs on fragile names
   * (high P/E / weak FCF) are the danger pattern. Fail-closed undefined.
   */
  newsScoreDelta?: number
  newsScoreDeltaQuarterly?: number
  /** Sector-channel velocity: latest sector re-score jump / quarterly change. */
  sectorNewsDelta?: number
  sectorNewsDeltaQuarterly?: number
  /**
   * News INERTIA (direction-of-drift over the last ~10 re-scores; see
   * newsInertia.ts): median(second half) − median(first half) — a sustained
   * −2 slide spread over many small jumps is visible here while remaining
   * invisible to the single-jump `newsScoreDelta`. Fail-closed undefined
   * under 4 score points (live scan path only — honest backtests have no
   * score-history series and must never fabricate one).
   */
  newsScoreTrend?: number
  /** Calendar days since the ticker's most recent score (freshness gate input). */
  newsScoreAgeDays?: number
  /**
   * Cross-sectional percentile rank of newsScore within the scored active
   * universe (0..1; fraction of scored tickers strictly below this score).
   * The ROTATION gate input: conviction must be current AND in the leading
   * cohort. Undefined when the scored cohort is under 20 names.
   */
  newsScoreRank?: number
  /** Same drift measure computed on the sector-score history (sector cooling). */
  sectorNewsTrend?: number
  /**
   * 20d excess vs SPY (decimal, 0.05 = 5pp) keyed by ticker. Writers fill
   * whatever candles they have; cohortGroups look up the group's leaders.
   * Missing keys fail-closed at the cohort entry gate.
   */
  leaderExcess20dByTicker?: Record<string, number>
  /** Weakest leader 20d excess vs SPY for this ticker's cohort group. */
  cohortLeaderExcess20d?: number
  cohortGroupName?: string
  cohortRole?: CohortRole
  /** Live-only groups from active macros + 60d corr. Honest backtests omit. */
  macroDerivedCohortGroups?: CohortGroupRule[]
  lang?: Language
  macroRegime?: MarketRegime
  federalFundingAmount?: number
  recentOutcomes?: Array<{
    eventName: string
    type: RecentOutcomeType
    outcome: string
    finishedAt: Date
    impactType: ImpactType
    impliedPriceAtEvent?: number
    confidence?: number // 0-1 from Gemini
  }>
  creditSpiking?: boolean
  creditVelocity?: number // changePercent4W
  riskProfile?: RiskProfile
  riskFreeRate?: number
  inflationRate?: number
  netLiquidity?: number
  tga?: number
  m2?: number
  liquidityTrend?: LiquidityPhase
  growthDriverProfile?: string
  fcfData?: import('../fcf/types').FcfDataPoint[]
  fcfInflection?: import('../core/types').FcfInflection
  /**
   * Coiled Spring Factor — FCF growth (from SEC filings) relative to trailing
   * price return (e.g. 2.5 = cash flow compounding while price is flat).
   * Computed server-side from SEC filings and served as a market-data field.
   * Declared here so the indicator registry's compile-time path check
   * (indicatorRegistry.ts) can verify it — previously it reached the
   * evaluator only via the passthrough coercion schema.
   */
  fcfSpringFactor?: number
  daysSinceLatestCatalyst?: number
  atrMoveSinceCatalyst?: number
  latestCatalystImpact?: ImpactType
  drawdownFrom52WeekHigh?: number
  peRatio?: number
  tag?: string
  isNarrativeSafe?: boolean
  macro?: {
    regime?: MarketRegime | string
    vix?: number
    putCallRatio?: number
    chicagoPmi?: number
    chicagoPmiChange?: number
    consumerSentiment?: number
    consumerSentimentChange?: number
    marginCallSeverityScore?: number // 0-100 score of systemic liquidation danger
    finraMarginDebtYoY?: number // YoY % change in FINRA margin debt
    cotNetPositionScore?: number // CFTC COT net positioning score
    putCallRatio5d?: number // 5-day SMA option put/call ratio
    global_liquidity?: {
      trend: GlobalLiquidityTrend
      value?: number
      tga?: number
      m2?: number
    }
    fed_rate?: {
      trajectory: FedRateTrajectory
    }
  }
  stock?: {
    macro_exposure?: {
      type: MacroExposureType
      hype_velocity: number
    }
  }
  // Total portfolio equity; when present, live sizing enforces each AST's
  // positionSizing.maxPortfolioAllocationPercent cap (parity with the backtest).
  portfolioValue?: number
  // Rate vulnerability score (0-10) from balance-sheet data. Used by dynamicScoring
  // to penalise/exclude highly-levered companies during Fed hiking cycles.
  rateVulnerabilityScore?: number
  // Fed Funds Rate trajectory ('HIKING' | 'PAUSED' | 'CUTTING'), computed from FRED DFF.
  fedRateTrajectory?: FedRateTrajectory
}

export type CandleMarketData = MarketData & {
  atr: number
  sma20: number
  sma10: number
  rsi: number
}

export function asCandleMarketData(data: MarketData): CandleMarketData | undefined {
  const { atr, sma20, sma10, rsi } = data
  if (!isFiniteNumber(atr) || atr <= 0) return undefined
  if (!isFiniteNumber(sma20) || !isFiniteNumber(sma10) || !isFiniteNumber(rsi)) return undefined
  return {
    ...data, atr, sma20, sma10, rsi, 
  }
}

/**
 * Absolute per-share risk (entry to stop), floored to 0 when nil. Use this
 * instead of ad-hoc `(risk || 1)` guards: dividing by the synthetic 1 produced
 * absurd share counts (e.g. 300 shares at a $0.01 risk distance) whenever
 * price ~= stop, silently defeating fixed-fractional sizing.
 */
export function safeRiskPerShare(entryPrice: number, stopLoss: number): number {
  const risk = Math.abs(entryPrice - stopLoss)
  return risk > 1e-6 ? risk : 0
}

/**
 * Institutional Thresholds by Profile
 */
export const PROFILE_CONFIG: Record<RiskProfile, {
  creditTriggerVelocity: number
  pricedInAtr: number
  fundingMid: number // +0.25 boost
  fundingMin: number // +0.50 boost
}> = {
  AGGRESSIVE: {
    creditTriggerVelocity: 40.0,
    pricedInAtr: 2.0,
    fundingMid: 100_000_000,
    fundingMin: 500_000_000,
  },
  BALANCED: {
    creditTriggerVelocity: 20.0,
    pricedInAtr: 1.5,
    fundingMid: 500_000_000,
    fundingMin: 1_000_000_000,
  },
  CONSERVATIVE: {
    creditTriggerVelocity: 10.0,
    pricedInAtr: 1.2,
    fundingMid: 1_000_000_000,
    fundingMin: 5_000_000_000,
  },
}

/**
 * Calculates effective USD risk per trade from a setting string (e.g. "3%", "500", "0")
 * and user's total capital account.
 */
export function getEffectiveRisk(maxRiskStr?: string, totalCapital?: string | number): number {
  if (!maxRiskStr || maxRiskStr === '0') return 300
  const cleanStr = maxRiskStr.trim()
  const capital = typeof totalCapital === 'number' ? totalCapital : (parseFloat(String(totalCapital || '30000')) || 30000)

  if (cleanStr.endsWith('%')) {
    const percent = parseFloat(cleanStr.replace('%', ''))
    if (isNaN(percent) || percent <= 0) return 300
    return Math.round((capital * percent) / 100)
  }

  const numericRisk = parseFloat(cleanStr)
  return isNaN(numericRisk) || numericRisk <= 0 ? 300 : numericRisk
}

/**
 * Conviction multiplier stacking. All factors are MULTIPLICATIVE (*= (1 +/- x))
 * so the result is invariant to evaluation order (the previous mix of *= and +=
 * was order-dependent). The final value is clamped to [0.25, 1.5] so a single
 * high-conviction name can never dominate the book (the old uncapped stacking
 * could reach ~2.5x, sizing a $300 risk budget to $750 per trade).
 */
export function calculateConvictionMultiplier(data: MarketData, strategyName?: string, tags?: string[]): number {
  const profile = data.riskProfile || 'BALANCED'
  const cfg = PROFILE_CONFIG[profile]
  let m = 1.0
  const isTrendTagged = !!tags?.includes('trend_continuation') || strategyName === 'TREND_RIDER'
  const isRotationTagged = !!tags?.includes('mean_reversion') || strategyName === 'ROTATION_EX_LOSERS'
  const isMomentumTagged = !!tags?.includes('momentum_breakout') || strategyName === 'TREND_RIDER' || strategyName === 'EARNINGS_MOMENTUM'

  // 1. Systemic Risk Dial (Credit Stress) — cut risk 50% during institutional stress.
  const isSpiking = data.creditVelocity !== undefined
    ? data.creditVelocity > cfg.creditTriggerVelocity
    : data.creditSpiking
  if (isSpiking) m *= 0.5

  // 2. Macro Regime Boost (trend-following archetypes in RISK_ON).
  if (isTrendTagged && data.macroRegime === 'RISK_ON') m *= 1.5

  // 3. Federal Funding Boost (Tiered, multiplicative).
  if (data.federalFundingAmount) {
    if (data.federalFundingAmount >= cfg.fundingMin) m *= 1.5
    else if (data.federalFundingAmount >= cfg.fundingMid) m *= 1.25
  }

  // 4. Beta De-risking. Regime-conditional: full penalty (x0.8) in RISK_OFF
  //    and RISK_NEUTRAL. Relaxed (x0.95) in RISK_ON so bull-market high-beta
  //    leaders (NVDA, TSLA) get sized closer to full instead of being
  //    over-penalized. Sweep-validated: TUNED config won on Calmar at every
  //    AI accuracy level (0.50/0.55/0.65/0.75).
  if (data.beta && data.beta > 1.5) {
    m *= data.macroRegime === 'RISK_ON' ? 0.95 : 0.8
  }

  // 5. Rotation Catalyst Boost (ex-loser rotation into undervalued names while
  //    tech is overextended). Each confluence factor compounds multiplicatively.
  if (isRotationTagged) {
    if (data.analystTarget && data.currentPrice < data.analystTarget * 0.8) m *= 1.25
    if (data.techMarketPrice && data.techMarketSma200 && data.techMarketPrice > data.techMarketSma200 * 1.15) m *= 1.25
  } else if (isMomentumTagged) {
    // Buy-high-sell-higher momentum: if tech is historically stretched (>15% over
    // 200SMA), drain capital because a pullback/rotation is imminent.
    if (data.techMarketPrice && data.techMarketSma200 && data.techMarketPrice > data.techMarketSma200 * 1.15) m *= 0.5
  }

  // 6. News-signal sizing damper (2026-08-20, sizing-symmetry finding —
  //    EXPERIMENTAL, live-FT-validated before any tightening): news-driven
  //    entries (newsScore >= 6, the 🔮🔥🎯 signature) deploy MORE capital per
  //    unit risk (tight stops ⇒ shares = risk/riskPerShare balloons) and the
  //    measured live edge on bull-news is ≤ coin-flip (39% +5d excess hit,
  //    IC −0.41, 2026-08-20). Damp sizing 20% on that signature. Fail-closed:
  //    undefined newsScore ⇒ no damper (honest backtests + unscored tickers
  //    keep prior behavior). This is the SIZING axis; the 🧊 non-mega haircut
  //    covers the score axis — they are complementary, not duplicates.
  if (data.newsScore !== undefined && data.newsScore >= 6) m *= 0.8

  // Moat is intentionally excluded from conviction — display/research context only.

  return Math.min(1.5, Math.max(0.25, m))
}

export interface SetupResult {
  isValid: boolean
  strategyName?: string
  firedBranchName?: string
  firedBranchDescription?: string
  firedSubsignals?: string[]
  entry?: number
  stopLoss?: number
  target?: number
  partialTarget?: number 
  breakEvenPrice?: number
  trailingStopActivation?: number
  shares?: number
  capitalRequired?: number
  riskAmountUsd?: number
  reason?: string
  score?: number
  satisfiedCount?: number
  totalCount?: number
  dividendAmount?: number
  exDividendDate?: string
  analystTarget?: number
  narrativeThesis?: string
  convictionMultiplier?: number
  catalystStatus?: import('../core/types').CatalystStatus
  fcfInflection?: import('../core/types').FcfInflection
  atrMove?: number
  minHoldingDays?: number
  riskProfile?: import('./ast').BranchRiskProfile
  timeframeHorizon?: string
  estimatedHoldingDays?: number
  rrRatio?: number
  /**
   * Probability-adjusted Expected Value per trading day, in R-multiples.
   * Computed via `expectedRPerDay(firedBranchName, rrRatio, estimatedHoldingDays)`
   * using per-branch calibration stats. Falls back to naive
   * `rrRatio / estimatedHoldingDays` when no per-branch stats are available.
   * Higher = more capital-efficient. Used as a tiebreaker in selection.
   */
  expectedRPerDay?: number
  /**
   * Per-setup risk budget override threaded from the AST's
   * `riskManagement.overrideRiskPerTrade`. Falls back to `MarketData.maxRisk`
   * when unset. Applied in evaluateSetup before the conviction multiplier so
   * the AST's own risk budget is not silently replaced by the caller's.
   */
  riskPerTradeOverride?: number
}

/**
 * Main entrance for setup evaluation.
 */
export function evaluateSetup(data: MarketData, strategyParams?: { custom?: CustomStrategyAST | CustomStrategyAST[]; [key: string]: unknown }): SetupResult[] {
  const results: SetupResult[] = []

  if (strategyParams?.custom) {
    const customList = Array.isArray(strategyParams.custom) ? strategyParams.custom : [
      strategyParams.custom,
    ]
    for (const ast of customList) {
      const customResult = evaluateCustomStrategy(data, ast)
      if (customResult) {
        results.push(customResult)
      }
    }
  }

  // Most-restrictive position-sizing allocation cap across the supplied ASTs,
  // used to enforce maxPortfolioAllocationPercent in live sizing (parity with
  // the backtest engine) when portfolio equity is provided on MarketData.
  const customs = strategyParams?.custom ? (Array.isArray(strategyParams.custom) ? strategyParams.custom : [
    strategyParams.custom,
  ]) : []
  const allocPcts = customs.map(c => c.positionSizing?.maxPortfolioAllocationPercent).filter((v): v is number => typeof v === 'number' && v > 0)
  const effectiveMaxAllocPct = allocPcts.length > 0 ? Math.min(...allocPcts) : undefined
  // Per-trade capital caps (2026-08-21 cap/risk decoupling — parity with the
  // backtest engine): most-restrictive declared maxCapitalPerTrade and
  // capitalRiskRatioCap across the supplied ASTs. Previously the B2D/engine
  // sizing paths ignored maxCapitalPerTrade entirely (only the allocation-%
  // cap was honored), so tight-stop setups deployed unbounded capital per
  // unit risk.
  const capPerTrade = customs.map(c => c.positionSizing?.maxCapitalPerTrade).filter((v): v is number => typeof v === 'number' && v > 0)
  const effectiveMaxCapitalPerTrade = capPerTrade.length > 0 ? Math.min(...capPerTrade) : undefined
  const ratioCaps = customs.map(c => c.positionSizing?.capitalRiskRatioCap).filter((v): v is number => typeof v === 'number' && v > 0)
  const effectiveCapitalRiskRatioCap = ratioCaps.length > 0 ? Math.min(...ratioCaps) : undefined
  // Union of AST tags, threaded into conviction so tag-gated boosts fire for any
  // archetype (e.g. trend_continuation) rather than only literal strategy names.
  const effectiveTags = Array.from(new Set(customs.flatMap(c => c.tags ?? [])))

  // Filter and refine: a SetupResult is emitted iff it is valid. The per-AST
  // minScoreToEmit floor (default 0 = emit all valid) is enforced inside
  // evaluateCustomStrategy so B2D callers can opt into emitting every scored
  // setup while dashboard ASTs set 1.0 to suppress sub-threshold candidates.
  return results.filter(r => r.isValid).map((s) => {
    // Shared risk management refinement
    const stopLoss = s.stopLoss || data.currentPrice * 0.95
    const riskPerShare = safeRiskPerShare(data.currentPrice, stopLoss)

    // VWAP penalty: reduce conviction if below VWAP instead of hard gate. Applied
    // to the multiplier BEFORE risk sizing so the penalty reaches both the
    // returned convictionMultiplier and the share count (previously it mutated a
    // field the return object overwrote — dead code).
    const belowVwap = data.vwap !== undefined && data.vwap > 0 && data.currentPrice < data.vwap
    const convictionMultiplier = calculateConvictionMultiplier(data, s.strategyName, effectiveTags) * (belowVwap ? 0.85 : 1)
    // AST risk budget override (riskManagement.overrideRiskPerTrade) wins over the
    // caller's maxRisk when declared.
    const riskUsd = (s.riskPerTradeOverride ?? data.maxRisk) * convictionMultiplier
    // Nil risk -> no sizing (avoids the old `|| 1` blow-up). Then enforce the
    // AST's maxPortfolioAllocationPercent against portfolio equity when known.
    let shares = riskPerShare > 0 ? Math.floor(riskUsd / riskPerShare) : 0
    // Cap/risk decoupling, engine order: structural ratio cap first, then the
    // hard per-trade $ cap, then the allocation-% cap (below). Each shrinks
    // shares (accepting lower actual $ risk than nominal), never enlarges.
    const capitalBeforeCaps = shares * data.currentPrice
    if (shares > 0 && effectiveCapitalRiskRatioCap !== undefined && capitalBeforeCaps > effectiveCapitalRiskRatioCap * riskUsd) {
      shares = Math.floor((effectiveCapitalRiskRatioCap * riskUsd) / data.currentPrice)
    }
    if (shares > 0 && effectiveMaxCapitalPerTrade !== undefined && shares * data.currentPrice > effectiveMaxCapitalPerTrade) {
      shares = Math.floor(effectiveMaxCapitalPerTrade / data.currentPrice)
    }
    if (shares > 0 && effectiveMaxAllocPct !== undefined && effectiveMaxAllocPct < 100 && (data.portfolioValue ?? 0) > 0) {
      const maxCapital = (data.portfolioValue ?? 0) * (effectiveMaxAllocPct / 100)
      shares = Math.min(shares, Math.floor(maxCapital / data.currentPrice))
    }
    const capitalDeployed = shares * data.currentPrice

    const breakEvenPrice = data.currentPrice + (riskPerShare * 0.5)

    // Auto-fail if capital required is > 50% of balance (Sanity check).
    // ATR-missing setups never reach here (halted inside
    // evaluateCustomStrategy); ?? 0 keeps the arithmetic total under NaN.
    const atrPercent = (data.atr ?? 0) / data.currentPrice
    const minAtrPercent = 0.005
    const isBelowMinAtr = atrPercent < minAtrPercent

    const isValid = s.isValid && (capitalDeployed < data.maxRisk * 50) && !isBelowMinAtr
    const reason = isValid
      ? s.reason
      : isBelowMinAtr
        ? '🚫 Halted: ATR too low for reliable signal (below 0.5%)'
        : capitalDeployed >= data.maxRisk * 50
          ? '🚫 Halted: Position size exceeds risk limits'
          : s.reason

    return {
      ...s,
      isValid,
      reason,
      shares,
      capitalRequired: capitalDeployed,
      riskAmountUsd: riskUsd,
      breakEvenPrice,
      convictionMultiplier,
      dividendAmount: data.dividendAmount,
      exDividendDate: data.exDividendDate,
      analystTarget: data.analystTarget,
    }
  })
}

/**
 * Simple EMA Cross Strategy (Classic momentum)
 */
function resolveUniverse(config: CustomStrategyAST): UniverseRules | undefined {
  return config.universe ?? config.universeRules
}

function universeRejectReason(data: MarketData, universe: UniverseRules): string | undefined {
  const ticker = data.ticker.toUpperCase()
  if (universe.excludedTickers?.some(t => t.toUpperCase() === ticker)) {
    return `🚫 Halted: ${data.ticker} is excluded from the universe`
  }
  if (universe.whitelistTickers && universe.whitelistTickers.length > 0
    && !universe.whitelistTickers.some(t => t.toUpperCase() === ticker)) {
    return `🚫 Halted: ${data.ticker} is not on the universe whitelist`
  }
  if (universe.minMarketCap !== undefined) {
    if (!(typeof data.marketCap === 'number' && data.marketCap > 0)) {
      return '🚫 Halted: Market cap missing — cannot apply universe floor'
    }
    if (data.marketCap < universe.minMarketCap) {
      return `🚫 Halted: Market cap ($${(data.marketCap / 1e9).toFixed(2)}B) below $${(universe.minMarketCap / 1e9).toFixed(2)}B universe floor`
    }
  }
  if (universe.maxMarketCap !== undefined && typeof data.marketCap === 'number' && data.marketCap > universe.maxMarketCap) {
    return `🚫 Halted: Market cap ($${(data.marketCap / 1e9).toFixed(2)}B) above $${(universe.maxMarketCap / 1e9).toFixed(2)}B universe ceiling`
  }
  if (universe.minAvgVolume !== undefined) {
    if (!(typeof data.avgVolume === 'number' && data.avgVolume > 0)) {
      return '🚫 Halted: Average volume missing — cannot apply universe liquidity floor'
    }
    if (data.avgVolume < universe.minAvgVolume) {
      return `🚫 Halted: Avg volume (${Math.round(data.avgVolume).toLocaleString()}) below ${universe.minAvgVolume.toLocaleString()} universe floor`
    }
  }
  const sector = data.sectorName
  if (universe.allowedSectors && universe.allowedSectors.length > 0) {
    if (!sector) {
      return '🚫 Halted: Sector missing — cannot apply allowedSectors'
    }
    if (!universe.allowedSectors.some(s => s.toLowerCase() === sector.toLowerCase())) {
      return `🚫 Halted: Sector ${sector} is outside the allowed universe`
    }
  }
  if (sector && universe.excludedSectors?.some(s => s.toLowerCase() === sector.toLowerCase())) {
    return `🚫 Halted: Sector ${sector} is excluded`
  }
  const industry = data.industryName
  if (universe.allowedIndustries && universe.allowedIndustries.length > 0) {
    if (!industry) {
      return '🚫 Halted: Industry missing — cannot apply allowedIndustries'
    }
    if (!universe.allowedIndustries.some(s => s.toLowerCase() === industry.toLowerCase())) {
      return `🚫 Halted: Industry ${industry} is outside the allowed universe`
    }
  }
  return undefined
}

function haltedSetup(
  data: MarketData, customConfig: CustomStrategyAST, reason: string, score = 0,
): SetupResult {
  return {
    isValid: false,
    score,
    strategyName: customConfig.strategyName || 'CUSTOM_AST',
    entry: data.currentPrice,
    stopLoss: data.currentPrice * 0.95,
    target: data.currentPrice * 1.1,
    shares: 0,
    reason,
  }
}

export function evaluateCustomStrategy(data: MarketData, customConfig: CustomStrategyAST): SetupResult | null {
  if (!customConfig || !customConfig.entryLogic) return null

  const coerced = MarketDataCoercionSchema.parse(data)
  const sma20ExtensionAtr = coerced.sma20ExtensionAtr
    ?? (isFiniteNumber(coerced.sma20) && isFiniteNumber(coerced.atr)
      ? computeSma20ExtensionAtr(coerced.currentPrice, coerced.sma20, coerced.atr)
      : undefined)
  const safeData = { ...coerced, sma20ExtensionAtr } as unknown as MarketData

  const universe = resolveUniverse(customConfig)
  if (universe) {
    const halt = universeRejectReason(safeData, universe)
    if (halt) return haltedSetup(safeData, customConfig, halt)
  }

  const cohortGroups = mergeCohortGroups(
    customConfig.cohortGroups, safeData.macroDerivedCohortGroups, customConfig.cohortFromMacros,
  )
  const membership = resolveCohortMembership(safeData.ticker, cohortGroups)
  if (membership) {
    const excess = weakestLeaderExcess(membership.group, safeData.leaderExcess20dByTicker)
    if (excess != null) {
      safeData.cohortLeaderExcess20d = excess
      safeData.cohortGroupName = membership.group.name
      safeData.cohortRole = membership.role
    }
    const cohortHalt = cohortEntryRejectReason(safeData.ticker, cohortGroups, safeData.leaderExcess20dByTicker)
    if (cohortHalt) return haltedSetup(safeData, customConfig, cohortHalt)
  }

  // Entry guards (entry_guard_v1): per-stock price-state gates, evaluated
  // BEFORE branches. FAIL-OPEN on missing indicators — an unverifiable
  // extension never vetoes (epistemics contract, mirrors rotation vetoes).
  // Chase guard evidence: hypothesis #12 in docs/strategy-history-2026-08.md.
  const maxExtensionAtr = customConfig.entryGuards?.maxSma20ExtensionAtr
  if (maxExtensionAtr != null && safeData.sma20ExtensionAtr != null && safeData.sma20ExtensionAtr > maxExtensionAtr) {
    return haltedSetup(
      safeData, customConfig,
      `🚫 Halted: Entry guard — price ${safeData.sma20ExtensionAtr.toFixed(1)} ATR above SMA20 exceeds max ${maxExtensionAtr}`,
    )
  }

  const evalDetails = AstEvaluator.evaluateWithDetails(customConfig.entryLogic, safeData as unknown as Record<string, unknown>)
  let isValid = evalDetails.isValid

  // Confluence scoring (hybrid OR): a single matching branch yields base score 1.0
  // (matches legacy behavior); each ADDITIONAL matching branch adds +1.0 so multi-branch
  // confluence rises to the top of ranked outputs. Per-branch `weight` may override
  // the +1.0 default in future ASTs (currently uniform).
  //
  // Weight-sum scoring: score = Σ weights of all matched branches (default 1.0 each).
  // With uniform weights this is identical to the legacy count-based
  // `1.0 + (matchedCount - 1) * 1.0`; non-uniform weights reward the declared
  // confluence weight instead of raw branch count. The primary branch (which
  // supplies riskProfile, stop/target multipliers, and expectedRPerDay stats) is
  // the highest-weight match — see AstEvaluator.evaluateWithDetails.
  const matchedCount = evalDetails.matchedBranchCount ?? (isValid ? 1 : 0)
  let score = isValid ? (evalDetails.matchedBranchWeight ?? matchedCount) : 0.0

  const reason = isValid
    ? (evalDetails.firedBranchName && evalDetails.firedBranchName !== 'Base Strategy Logic Met'
      ? (matchedCount > 1
        ? `${evalDetails.firedBranchName} (+${matchedCount - 1} confluence)`
        : evalDetails.firedBranchName)
      : 'Custom AST Entry conditions met')
    : 'Custom logic conditions not met'
  const firedSubsignals: string[] = []

  if (evalDetails.firedBranchName && evalDetails.firedBranchName !== 'Base Strategy Logic Met') {
    firedSubsignals.push(reason)
  }
  if (matchedCount > 1 && evalDetails.matchedBranchNames && evalDetails.matchedBranchNames.length > 1) {
    firedSubsignals.push(`🎯 Confluence: ${matchedCount} branches matched (${evalDetails.matchedBranchNames.join(' | ')})`)
  }

  // Apply dynamic scoring rules to adjust score and conviction
  if (customConfig.dynamicScoring) {
    for (const rule of customConfig.dynamicScoring) {
      if (AstEvaluator.evaluate(rule.condition, safeData as unknown as Record<string, unknown>)) {
        let effectiveBoost = rule.boost
        if (rule.regimeMultiplier && data.macroRegime) {
          const currentRegimeStr = data.macroRegime as keyof typeof rule.regimeMultiplier
          if (rule.regimeMultiplier[currentRegimeStr]) {
            effectiveBoost *= rule.regimeMultiplier[currentRegimeStr]!
          }
        }
        score += effectiveBoost
        // Positive dynamic scoring boost on a base-valid entry reinforces high conviction
        if (effectiveBoost > 0 && score >= 1.0 && evalDetails.isValid) {
          isValid = true
        }
        if (rule.reason) {
          const sign = effectiveBoost >= 0 ? '+' : ''
          firedSubsignals.push(`${rule.reason} (${sign}${effectiveBoost.toFixed(1)})`)
        }
      }
    }
    // Snap accumulated float noise (e.g. 5.45 - 0.3 → 5.150000000000001).
    // Boosts are specified at ≤2 decimals; rounding the SUM (not each add)
    // keeps arbitrary-precision intent while removing binary-float artifacts
    // that otherwise leak into snapshots, logs, and threshold comparisons.
    score = Math.round(score * 100) / 100
  }

  // Mandatory Net Score Floor Gate: per-AST emit threshold (default 0 = emit all valid).
  // Dashboard ASTs set minScoreToEmit=1.0 so a single-branch match (score=1.0) still passes
  // while a setup eroded by penalties below 1.0 is suppressed. B2D API callers pass 0 to
  // expose every scored setup (subscribers apply their own threshold).
  if (score < (customConfig.minScoreToEmit ?? 0)) {
    isValid = false
  }

  if (!isValid) {
    return {
      isValid: false,
      // Preserve the computed score even on invalid results so B2D callers can apply
      // their own thresholds (e.g. "show me setups that scored 0.5+ even if the dashboard
      // floor of 1.0 suppressed them"). evaluateSetup filters on isValid, not score.
      score,
      strategyName: customConfig.strategyName || 'CUSTOM_AST',
      entry: data.currentPrice,
      stopLoss: data.currentPrice * 0.95,
      target: data.currentPrice * 1.1,
      shares: 0,
      reason,
      firedBranchName: evalDetails.firedBranchName,
      firedBranchDescription: evalDetails.firedBranchDescription,
      firedSubsignals,
    }
  }

  // 📅 Pre-Earnings Blackout Check from AST Risk Management (e.g. maxDaysToEarnings)
  const maxDaysToEarnings = customConfig.riskManagement?.maxDaysToEarnings
  if (maxDaysToEarnings && data.nextEarnings && data.nextEarnings !== 'N/A') {
    const earningsDateMs = new Date(data.nextEarnings).getTime()
    if (!isNaN(earningsDateMs)) {
      const now = new Date()
      const earningsDateObj = new Date(earningsDateMs)
      const diffMs = earningsDateMs - now.getTime()
      
      // Calculate trading days if earnings are in future or today
      if (diffMs >= -12 * 60 * 60 * 1000 && diffMs <= maxDaysToEarnings * 3 * 24 * 60 * 60 * 1000) {
        const tradingDays = getTradingDaysBetween(now, earningsDateObj)
        if (tradingDays <= maxDaysToEarnings) {
          return {
            isValid: false,
            score, // Preserve the computed score (B2D callers apply their own thresholds)
            strategyName: customConfig.strategyName || 'CUSTOM_AST',
            entry: data.currentPrice,
            stopLoss: data.currentPrice * 0.95,
            target: data.currentPrice * 1.1,
            shares: 0,
            reason: `🚫 Halted: Imminent earnings report in ${tradingDays === 0 ? 'today' : `${tradingDays} trading day(s)`} (${data.nextEarnings})`,
          }
        }
      }
    }
  }

  // Extract branch-level AST overrides if available. The lookup walks the WHOLE
  // entry tree recursively — a branch fired inside a nested `or` group (Branch-9
  // style) must still contribute its risk overrides, not just top-level branches.
  const findBranchByName = (node: import('./ast').ASTNode | undefined, name: string): import('./ast').LogicGroupNode | undefined => {
    if (!node || typeof node !== 'object') return undefined
    const group = node as import('./ast').LogicGroupNode
    if ('name' in group && group.name === name) return group
    for (const child of [
      ...(group.and ?? []),
      ...(group.or ?? []),
    ]) {
      const found = findBranchByName(child, name)
      if (found) return found
    }
    return undefined
  }

  const entryGroup = customConfig.entryLogic as import('./ast').LogicGroupNode | undefined
  const matchedBranch = evalDetails.firedBranchName ? findBranchByName(entryGroup, evalDetails.firedBranchName) : undefined
  let branchTargetMult: number | undefined
  let branchStopMult: number | undefined
  let branchRiskProfile: import('./ast').BranchRiskProfile | undefined
  let branchTimeframe: string | undefined
  if (matchedBranch) {
    branchTargetMult = matchedBranch.targetRiskMultiplier
    branchStopMult = matchedBranch.stopLossAtrMultiplier
    branchRiskProfile = matchedBranch.riskProfile
    branchTimeframe = matchedBranch.timeframeHorizon
  }

  // Calculate dynamic risk sizing
  let stopAtrMult = branchStopMult ?? customConfig.riskManagement?.stopLossAtrMultiplier ?? 2.0
  let targetRiskMult = branchTargetMult ?? customConfig.riskManagement?.targetRiskMultiplier ?? 3.0
  
  // Adjust based on macro regime if defined in AST
  const regimeAdjustments = customConfig.riskManagement?.regimeAdjustments
  if (data.macroRegime === 'RISK_OFF' && regimeAdjustments?.RISK_OFF) {
    stopAtrMult *= regimeAdjustments.RISK_OFF.stopMultiplier ?? 1.0
    targetRiskMult *= regimeAdjustments.RISK_OFF.targetMultiplier ?? 1.0
  } else if (data.macroRegime === 'RISK_ON' && regimeAdjustments?.RISK_ON) {
    stopAtrMult *= regimeAdjustments.RISK_ON.stopMultiplier ?? 1.0
    targetRiskMult *= regimeAdjustments.RISK_ON.targetMultiplier ?? 1.0
  }

  // Price-safety: no honest risk sizing without a real ATR. The old
  // `data.currentPrice * 0.02` dummy fabricated a plausible-looking band for
  // every ticker with stale metrics (and by construction always passed the
  // 0.5% ATR sanity floor). Halt instead — setups without verified volatility
  // data MUST be dropped, never sized on a guess.
  const effectiveAtr = (data.atr && data.atr > 0) ? data.atr : undefined
  if (!effectiveAtr) {
    return {
      isValid: false,
      score: 0,
      strategyName: customConfig.strategyName || 'CUSTOM_AST',
      entry: data.currentPrice,
      stopLoss: data.currentPrice * 0.95,
      target: data.currentPrice * 1.1,
      shares: 0,
      reason: '🚫 Halted: ATR missing — cannot size risk without verified volatility data',
    }
  }
  const riskPerShare = effectiveAtr * stopAtrMult
  // ── Sweep-zone stop placement (2026-08-21 sweep hardening) ────────────────
  // Stops sitting just above the 20-day structural floor cluster with the
  // liquidity sweeps hunt. When the AST opts in, anchor the stop BELOW the
  // sweep zone (floor − 0.75×ATR), taking the lower of formula/sweep levels,
  // with widening bounded to 1.5× the formula distance (stop_ab: unbounded
  // widening hurts). Sizing re-derives from the ACTUAL stop distance so
  // dollar risk stays constant (risk-parity + caps still apply downstream);
  // the TARGET keeps the formula geometry (moving a stop ≠ moving a thesis).
  // Fail-closed: missing/zero structuralFloor ⇒ formula stop unchanged.
  let stopLoss = data.currentPrice - riskPerShare
  if (customConfig.riskManagement?.stopPlacement === 'sweep_zone'
    && data.structuralFloor !== undefined && data.structuralFloor > 0) {
    const sweepCandidate = data.structuralFloor - 0.75 * effectiveAtr
    const widestAllowed = data.currentPrice - 1.5 * riskPerShare
    const bounded = Math.max(sweepCandidate, widestAllowed)
    if (bounded < stopLoss) stopLoss = bounded
  }
  const actualRiskPerShare = data.currentPrice - stopLoss
  const target = data.currentPrice + riskPerShare * targetRiskMult

  if (riskPerShare <= 0 || stopLoss >= data.currentPrice || target <= data.currentPrice) {
    return {
      isValid: false,
      score: 0,
      strategyName: customConfig.strategyName || 'CUSTOM_AST',
      entry: data.currentPrice,
      stopLoss: data.currentPrice * 0.95,
      target: data.currentPrice * 1.1,
      shares: 0,
      reason: 'Invalid risk sizing or missing volatility data',
    }
  }

  const branchHoldingDays = customConfig.rotationRules?.branchMinHoldingDays && evalDetails.firedBranchName
    ? customConfig.rotationRules.branchMinHoldingDays[evalDetails.firedBranchName]
    : undefined

  // Dynamic expected holding horizon: replace the legacy fixed 0.7×ATR factor
  // (which assumed every setup has 70% directional efficiency) with Kaufman's
  // Efficiency Ratio × ATR. ER = |net change| / Σ|step changes| over the recent
  // window — i.e. the fraction of recent volatility that was actually directional.
  // In a strong trend (ER≈1) daily progress toward target ≈ ATR; in choppy tape
  // (ER≈0.2) progress is ~1/5 of ATR → horizon stretches proportionally.
  // Regime-agnostic: for mean-reversion, ER captures how efficiently price has
  // been reverting to mean (same direction-of-travel logic, opposite sign).
  // Live callers without `history` pass no `efficiencyRatio` → neutral 0.5
  // (slightly more conservative than the legacy 0.7, appropriate for display-only use).
  const targetUsd = Math.max(0, target - data.currentPrice)
  const erClamped = Math.min(1.0, Math.max(0.1, data.efficiencyRatio ?? 0.5))
  const dailyMoveUsd = effectiveAtr * erClamped
  const calculatedHoldingDays = dailyMoveUsd > 0
    ? Math.min(60, Math.max(3, Math.round(targetUsd / dailyMoveUsd)))
    : 10

  const estimatedHoldingDays = branchHoldingDays !== undefined
    ? branchHoldingDays
    : (customConfig.rotationRules?.minHoldingDays ?? calculatedHoldingDays)

  const rrRatio = actualRiskPerShare > 0 ? Number(((target - data.currentPrice) / actualRiskPerShare).toFixed(1)) : 3.0

  // Probability-adjusted EV/day. Uses per-branch realized win rate from
  // branchStats.ts (materialized by scripts/diagnose_branch_anatomy.ts).
  // Falls back to naive rrRatio/estimatedHoldingDays when no stats exist
  // for the branch (untracked or new branches).
  const expectedRPerDayValue = expectedRPerDay(evalDetails.firedBranchName, rrRatio, estimatedHoldingDays)

  return {
    isValid: true,
    score,
    strategyName: customConfig.strategyName || 'CUSTOM_AST',
    firedBranchName: evalDetails.firedBranchName,
    firedBranchDescription: evalDetails.firedBranchDescription,
    firedSubsignals,
    entry: data.currentPrice,
    stopLoss,
    target,
    // riskPerTradeOverride is threaded to evaluateSetup, which sizes shares from
    // (riskPerTradeOverride ?? maxRisk) × convictionMultiplier. Shares are NOT
    // computed here — evaluateSetup owns the final sizing (conviction + alloc cap).
    riskPerTradeOverride: customConfig.riskManagement?.overrideRiskPerTrade,
    minHoldingDays: estimatedHoldingDays,
    estimatedHoldingDays,
    riskProfile: branchRiskProfile,
    timeframeHorizon: branchTimeframe,
    rrRatio,
    expectedRPerDay: expectedRPerDayValue,
    reason,
  }
}

export interface RotationAsset {
  ticker: string
  entry: number
  target: number
  stopLoss: number
  strategy: string
  currentPrice: number
  shares?: number
  capitalDeployed?: number
  highestHigh?: number
  atr?: number
  chandelierExitStop?: number
  trailingStopDistance?: number
  daysHeld?: number
  minHoldingDays?: number
  sma20?: number
}

export interface RotationSetup {
  ticker: string
  entry: number
  target: number
  stopLoss: number
  strategy: string
  currentPrice: number
  sectorName?: string
  industryName?: string
  isRsLeader?: boolean
  /**
   * Probability-adjusted Expected Value per trading day (R/day). When present
   * AND the AST declares `rotationRules.rotationScoring: 'ev'`, the ranker
   * uses this directly instead of the multiplicative OpportunityScore blend.
   * Threaded from `SetupResult.expectedRPerDay` via the caller.
   */
  expectedRPerDay?: number
  /** Original branch that fired (used for audit + future per-branch tracking). */
  firedBranchName?: string
}

export interface RotationInputData {
  portfolio: RotationAsset[]
  setups: RotationSetup[]
  scores: Record<string, { newsScore?: number; insiderScore?: number }>
  budget: { total: number; risk: number; cash: number }
  chatId?: string
  macroRegime?: string
  // Real VIX index value (NOT the VIXY ETF price). When omitted, scoring falls
  // back to a neutral 18.0 and all VIX-adaptive regime multipliers collapse to 1.0.
  vixPrice?: number
  rotationRules?: import('./ast').RotationRules
}

export interface ComponentWeights {
  w_rr: number
  w_s: number
  w_m: number
  w_t: number
}

const DEFAULT_WEIGHTS: ComponentWeights = {
  w_rr: 1.0,
  w_s: 1.0,
  w_m: 1.0,
  w_t: 1.0,
}

const SECTOR_WEIGHTS: Record<string, Partial<ComponentWeights>> = {
  'TECHNOLOGY': {
    w_s: 1.3,
  },
  'INDUSTRIALS': {
    w_m: 1.5,
  },
  'ENERGY': {
    w_m: 1.5,
  },
  'HEALTHCARE': {
    w_rr: 1.5,
  },
}

function calculateInitialRR(asset: { entry: number; target: number; stopLoss: number }): number {
  const risk = Math.max(0.01, asset.entry - asset.stopLoss)
  return (asset.target - asset.entry) / risk
}

function calculateRemainingRR(asset: { currentPrice: number; target: number; stopLoss: number; chandelierExitStop?: number }): number {
  const effectiveStop = asset.chandelierExitStop || asset.stopLoss
  const risk = Math.max(0.01, asset.currentPrice - effectiveStop)
  if (asset.currentPrice >= asset.target) return 0
  return (asset.target - asset.currentPrice) / risk
}

function getRegimeMultipliers(vix: number): ComponentWeights {
  if (vix >= 25.0) {
    return {
      w_rr: 0.8,
      w_s: 0.5,
      w_m: 1.5,
      w_t: 1.8,
    }
  } else if (vix < 15.0) {
    return {
      w_rr: 1.2,
      w_s: 1.2,
      w_m: 0.8,
      w_t: 0.8,
    }
  } else {
    return {
      w_rr: 1.0,
      w_s: 1.0,
      w_m: 1.0,
      w_t: 1.0,
    }
  }
}

export function calculateOpportunityScore(
  ticker: string,
  isPortfolio: boolean,
  prices: {
    entry: number
    target: number
    stopLoss: number
    currentPrice: number
    chandelierExitStop?: number
    trailingStopDistance?: number
  },
  scoresData: Record<string, { newsScore?: number; insiderScore?: number }> = {},
  sector = 'DEFAULT',
  vixPrice = 18.0,
  binaryRiskMap: Record<string, { isHighRisk?: boolean; impactType?: string }> = {},
  tickerMacroExposures: Map<string, Array<{ exposureType: string; derivativeTier: number }>> = new Map(),
  customWeights?: import('./ast').RotationRules['weights'],
): { score: number; rr: number; sentiment: number; macro: number; trailing: number; narrativeMultiplier: number } {
  const baseWeights = { 
    ...DEFAULT_WEIGHTS, 
    ...(SECTOR_WEIGHTS[sector] || {}),
    ...(customWeights || {}),
  }
  const multipliers = getRegimeMultipliers(vixPrice)

  const w_rr = baseWeights.w_rr * multipliers.w_rr
  const w_s = baseWeights.w_s * multipliers.w_s
  const w_m = baseWeights.w_m * multipliers.w_m
  const w_t = baseWeights.w_t * multipliers.w_t

  const rr = isPortfolio
    ? calculateRemainingRR({ ...prices, stopLoss: prices.stopLoss, chandelierExitStop: prices.chandelierExitStop })
    : calculateInitialRR(prices)
  const rr_weighted = rr * w_rr

  const sObj = scoresData[ticker] ?? { newsScore: 0, insiderScore: 0 } // calc default: 0 = neutral ranking weight (not a data default)
  // When AI scores are undefined (AI hasn't scored this ticker), use 0 so the
  // sentiment component is neutral (0.5). This is a CALCULATION default, not a
  // DATA default — the branch already fired via technical OR-fallback; this
  // only affects the ranking weight, not the entry decision.
  const sentiment = 0.5 + 0.1 * (0.6 * (sObj.newsScore ?? 0) + 0.4 * (sObj.insiderScore ?? 0))
  const sentiment_weighted = 1.0 + (sentiment - 1.0) * w_s

  const riskObj = binaryRiskMap[ticker]
  let macro = 1.0
  if (riskObj) {
    if (riskObj.isHighRisk) {
      macro = 0.5
    } else if (riskObj.impactType === 'POSITIVE') {
      macro = 1.2
    }
  }
  const macro_weighted = 1.0 + (macro - 1.0) * w_m

  let trailing = 1.0
  if (isPortfolio && prices.trailingStopDistance !== undefined) {
    if (prices.trailingStopDistance < 2) {
      trailing = 0.1
    } else if (prices.trailingStopDistance < 5) {
      trailing = 0.5
    }
  }
  const trailing_weighted = Math.max(0.01, 1.0 + (trailing - 1.0) * w_t)

  let narrativeMultiplier = 1.0
  const activeExposures = tickerMacroExposures.get(ticker) || []
  for (const exp of activeExposures) {
    if (exp.exposureType === 'BENEFICIARY') {
      if (exp.derivativeTier === 1) narrativeMultiplier *= 1.30
      else if (exp.derivativeTier === 2) narrativeMultiplier *= 1.15
      else if (exp.derivativeTier === 3) narrativeMultiplier *= 1.05
    } else if (exp.exposureType === 'VICTIM') {
      if (exp.derivativeTier === 1) narrativeMultiplier *= 0.60
      else if (exp.derivativeTier === 2) narrativeMultiplier *= 0.75
      else if (exp.derivativeTier === 3) narrativeMultiplier *= 0.90
    }
  }

  const finalScore = Number((rr_weighted * sentiment_weighted * macro_weighted * trailing_weighted * narrativeMultiplier).toFixed(2))

  return {
    score: finalScore,
    rr: Number(rr.toFixed(2)),
    sentiment: Number(sentiment.toFixed(2)),
    macro: Number(macro.toFixed(2)),
    trailing: Number(trailing.toFixed(2)),
    narrativeMultiplier: Number(narrativeMultiplier.toFixed(2)),
  }
}

/** The kind of rotation decision (maps to a translation template in the formatter). */
export const RotationReasonKey = {
  INITIAL_BUY: 'INITIAL_BUY',
  TRIM_RISK: 'TRIM_RISK',
  SWAP: 'SWAP',
  CASH_DEPLOY: 'CASH_DEPLOY',
} as const
export type RotationReasonKey = (typeof RotationReasonKey)[keyof typeof RotationReasonKey]

/** Non-ticker sentinel values that can appear in a RotationAction's buy/sell field. */
export const RotationSpecialTarget = {
  CASH: 'CASH',
  TRIM_RISK: 'TRIM_RISK',
} as const
export type RotationSpecialTarget = (typeof RotationSpecialTarget)[keyof typeof RotationSpecialTarget]

export type RotationRationale = 'INITIAL_ALLOCATION' | 'RECOMMENDATIONS' | 'ALREADY_OPTIMIZED' | 'NO_SETUPS'

/** A single rotation decision as structured data (no presentation/translation). */
export interface RotationAction {
  sell: string
  buy: string
  shares?: number
  price?: number
  allocatedUsd?: number
  riskUsd?: number
  /** Formatter key; the matching translation template is selected from reasonData. */
  reasonKey: RotationReasonKey
  /** Raw interpolation values for the formatter (numbers unformatted). */
  reasonData: Record<string, string | number>
}

/** Structured output of recommendPortfolioRotations (presentation-free). */
export interface TargetPosition {
  ticker: string
  shares: number
  price: number
  allocatedUsd: number
  pctAllocation: number
}

export interface PortfolioAction {
  type: 'SELL' | 'TRIM' | 'BUY'
  ticker: string
  shares: number
  price: number
  amountUsd: number
  reasonKey?: RotationReasonKey
  reasonData?: Record<string, string | number>
  /**
   * Signal stops threaded from the candidate RotationSetup for BUY actions.
   * Lets the consumer (client_api applyOptimizationActions) persist a real
   * signal-derived stop instead of falling back to a candle-derived one —
   * closes the "entry - $2.50" gap when the optimizer path bypassed the
   * scanCache. Absent for SELL/TRIM and for BUYs whose ticker has no setup.
   */
  entry?: number
  stopLoss?: number
  target?: number
  strategy?: string
  firedBranchName?: string
}

/**
 * One sellNewsGate veto activation recorded during the SWAP loop. Structured
 * data only — consumers decide whether to log and/or persist it (e.g. the
 * client_api optimize path ships these to POST /api/v1/market/rotation-gates
 * as VETO_BLOCK / SELL_NEWS rows so veto counts survive container restarts).
 */
export interface SellNewsVetoEvent {
  ticker: string
  veto: RotationSellVeto
  price?: number
  sma20?: number
  newsScore?: number
  insiderScore?: number
}

export interface RotationResult {
  rotations: RotationAction[]
  targetPortfolio: TargetPosition[]
  actions: PortfolioAction[]
  rationale: RotationRationale
  /**
   * Present when rotationRules.sellNewsGate blocked at least one SWAP this
   * cycle. Additive/optional — backtests and older consumers ignore it.
   */
  sellNewsVetoes?: SellNewsVetoEvent[]
}

/**
 * Main entrance for setup evaluation -> rotation decisions.
 *
 * Returns a structured {@link RotationResult} (data only). Use
 * {@link formatRotationResult} to render it as a translated user-facing string.
 * Separating decision from presentation lets backtests consume rotations
 * without parsing JSON, and lets callers render in any language after the fact.
 */
 
export function recommendPortfolioRotations(data: RotationInputData): RotationResult {
  const portfolioScores: Array<{ asset: RotationAsset; score: number; remainingRR: number }> = []
  const setupScores: Array<{ setup: RotationSetup; score: number; sortScore: number; initialRR: number }> = []
  const customWeights = data.rotationRules?.weights
  const effectiveVix = data.vixPrice ?? 18.0

  for (const p of data.portfolio) {
    const res = calculateOpportunityScore(
      p.ticker, true, p, data.scores, 'DEFAULT', effectiveVix, {}, new Map(), customWeights,
    )
    const remainingRR = calculateRemainingRR(p)
    portfolioScores.push({ asset: p, score: res.score, remainingRR })
  }

  const excludedSectors = new Set((data.rotationRules?.excludedSectors || []).map(sec => sec.toLowerCase()))
  const excludedIndustries = new Set((data.rotationRules?.excludedIndustries || []).map(ind => ind.toLowerCase()))
  const onlyExcludeInRiskOff = data.rotationRules?.onlyExcludeInRiskOff ?? false
  const isRiskOff = data.macroRegime === 'RISK_OFF'

  for (const s of data.setups) {
    const isExcludedSector = s.sectorName && excludedSectors.has(s.sectorName.toLowerCase())
    const isExcludedIndustry = s.industryName && excludedIndustries.has(s.industryName.toLowerCase())
    const shouldEnforceExclusion = !onlyExcludeInRiskOff || isRiskOff

    if ((isExcludedSector || isExcludedIndustry) && shouldEnforceExclusion && !s.isRsLeader) continue

    const res = calculateOpportunityScore(
      s.ticker, false, s, data.scores, 'DEFAULT', effectiveVix, {}, new Map(), customWeights,
    )
    const initialRR = calculateInitialRR(s)
    // Decouple SORT key from THRESHOLD score. The swap gate at L~1092 compares
    // topCandidate.score vs pItem.score (OpportunityScore); both must be on
    // the same scale or the gate is unreachable. The SORT key may differ —
    // when rotationScoring='ev', we rank by EV/day (range ~0.05-0.50) but
    // still threshold on OpportunityScore (range ~2-10+). This mirrors the
    // backtest engine (portfolioBacktestEngine.ts:898 sort=EV, :990 threshold
    // = setup.score vs currentScore both confluence). Prior bug: overriding
    // .score with EV made the swap branch mathematically unreachable.
    const useEvSort = data.rotationRules?.rotationScoring === 'ev' && s.expectedRPerDay !== undefined
    setupScores.push({
      setup: s,
      score: res.score, // OpportunityScore — used for threshold comparisons
      sortScore: useEvSort ? s.expectedRPerDay! : res.score, // EV when configured, else OppScore
      initialRR,
    })
  }

  // Sort by sortScore (EV when rotationScoring='ev', OpportunityScore otherwise).
  // Threshold comparisons below still use .score (always OpportunityScore).
  setupScores.sort((a, b) => b.sortScore - a.sortScore)

  // Lookup of signal stops by ticker (uppercased) so BUY actions emitted in
  // section 3 can carry the candidate setup's real entry/stopLoss/target —
  // consumers then persist a signal-derived stop instead of a fallback.
  const setupStopsByKey = new Map<string, Pick<PortfolioAction, 'entry' | 'stopLoss' | 'target' | 'strategy' | 'firedBranchName'>>()
  for (const s of data.setups) {
    setupStopsByKey.set(s.ticker.toUpperCase(), {
      entry: s.entry, stopLoss: s.stopLoss, target: s.target, strategy: s.strategy, firedBranchName: s.firedBranchName,
    })
  }

  // Candidate score floor. Explicit `minCandidateScore` in the AST always
  // wins. When unset, scale the default to the score range: OpportunityScore
  // is ~2-10+ (default 2.0); EV/day is ~0.05-0.50 (default 0.05). Without
  // this scaling, every EV candidate would short-circuit at the floor gate
  // since 0.50 < 2.0.
  const minCandidateScoreThreshold = data.rotationRules?.minCandidateScore
    ?? (data.rotationRules?.rotationScoring === 'ev' ? 0.05 : 2.0)
  const allowCash = data.rotationRules?.allowCashDeployment ?? true
  const defaultMinHoldingDays = data.rotationRules?.minHoldingDays ?? 0

  // 1. Empty Portfolio Initial Allocation Mode
  if (data.portfolio.length === 0) {
    const highConvictionSetups = setupScores.filter(s => s.score >= minCandidateScoreThreshold)
    const maxSlots = (data.rotationRules?.maxPortfolioPositions && data.rotationRules.maxPortfolioPositions > 0)
      ? data.rotationRules.maxPortfolioPositions
      : 3
    const initialBuySetups = (highConvictionSetups.length > 0 ? highConvictionSetups : setupScores).slice(0, maxSlots)

    const initialAllocations = initialBuySetups
      .map(s => {
        const perTradeRisk = Math.max(1, Math.abs(s.setup.currentPrice - s.setup.stopLoss))
        const maxRiskTarget = data.budget.risk > 0 ? data.budget.risk : Math.max(100, data.budget.total * 0.01)
        const sharesByRisk = Math.floor(maxRiskTarget / perTradeRisk)
        const perTradeCashLimit = data.budget.cash / Math.max(1, initialBuySetups.length)
        const sharesByCash = Math.floor(perTradeCashLimit / s.setup.currentPrice)
        const shares = Math.min(sharesByRisk, sharesByCash)
        if (shares < 1) return null

        const allocUsd = shares * s.setup.currentPrice
        const totalRiskUsd = shares * perTradeRisk

        return {
          sell: RotationSpecialTarget.CASH,
          buy: s.setup.ticker,
          shares,
          price: s.setup.currentPrice,
          allocatedUsd: Number(allocUsd.toFixed(2)),
          riskUsd: Number(totalRiskUsd.toFixed(2)),
          reasonKey: RotationReasonKey.INITIAL_BUY,
          reasonData: {
            shares, ticker: s.setup.ticker, price: s.setup.currentPrice, allocated: allocUsd, risk: totalRiskUsd,
          },
        }
      })
      .filter((a): a is NonNullable<typeof a> => a !== null)

    return {
      rotations: initialAllocations,
      targetPortfolio: initialAllocations.map(a => ({
        ticker: a.buy,
        shares: a.shares,
        price: a.price,
        allocatedUsd: a.allocatedUsd,
        pctAllocation: Number(((a.allocatedUsd / (data.budget.total || 30000)) * 100).toFixed(1)),
      })),
      actions: initialAllocations.map(a => ({
        type: 'BUY',
        ticker: a.buy,
        shares: a.shares,
        price: a.price,
        amountUsd: a.allocatedUsd,
        reasonKey: a.reasonKey,
        reasonData: a.reasonData,
        ...setupStopsByKey.get(a.buy.toUpperCase()),
      })),
      rationale: 'INITIAL_ALLOCATION',
    }
  }

  // 2. Active Portfolio Optimization & Risk Alignment
  portfolioScores.sort((a, b) => a.score - b.score)
  const rotations: RotationAction[] = []
  const sellNewsVetoes: SellNewsVetoEvent[] = []
  const availableSetups = [
    ...setupScores,
  ]
  const minGainMultiplier = data.rotationRules?.scoreGainMultiplier || 1.25
  const maxRiskPerTrade = data.budget.risk > 0 ? data.budget.risk : Math.max(100, data.budget.total * 0.01)

  let freedCash = 0
  // Track positions trimmed in section A so section B does not also swap them
  // (which double-counted the same capital in freedCash).
  const trimmedTickers = new Set<string>()
  // Slot budget for NEW positions opened from cash (section C). Swaps (B) replace
  // one-for-one so they don't consume slots; trims (A) keep the slot occupied.
  const maxPositions = data.rotationRules?.maxPortfolioPositions
  let slotsRemaining = (maxPositions && maxPositions > 0) ? Math.max(0, maxPositions - data.portfolio.length) : Infinity

  // A. Position Sizing & Risk Adjustments (TRIM over-risked positions)
  for (const pItem of portfolioScores) {
    const riskPerShare = Math.max(0.01, Math.abs(pItem.asset.currentPrice - pItem.asset.stopLoss))
    const actualShares = (pItem.asset.shares && pItem.asset.shares > 0)
      ? pItem.asset.shares
      : (pItem.asset.capitalDeployed && pItem.asset.entry > 0
        ? Math.floor(pItem.asset.capitalDeployed / pItem.asset.entry)
        : Math.max(1, Math.floor((data.budget.total * 0.1) / (pItem.asset.entry > 0 ? pItem.asset.entry : pItem.asset.currentPrice))))

    const currentPositionRisk = actualShares * riskPerShare

    if (currentPositionRisk > maxRiskPerTrade * 1.25) {
      const targetShares = Math.floor(maxRiskPerTrade / riskPerShare)
      const sharesToTrim = Math.min(actualShares, Math.max(1, actualShares - targetShares))
      if (sharesToTrim > 0) {
        const freedFromTrim = sharesToTrim * pItem.asset.currentPrice
        freedCash += freedFromTrim
        trimmedTickers.add(pItem.asset.ticker)

        rotations.push({
          sell: pItem.asset.ticker,
          buy: RotationSpecialTarget.TRIM_RISK,
          reasonKey: RotationReasonKey.TRIM_RISK,
          reasonData: {
            ticker: pItem.asset.ticker,
            risk: currentPositionRisk,
            maxRisk: maxRiskPerTrade,
            shares: sharesToTrim,
            freed: freedFromTrim,
          },
        })
      }
    }
  }

  // B. R:R & Opportunity Score Replacements
  const newsFeedPresent = isNewsScoreFeedPresent(data.scores)
  for (const pItem of portfolioScores) {
    if (availableSetups.length === 0) break
    // A position trimmed for risk in section A is not also swapped this cycle
    // (avoids double-counting its capital in freedCash).
    if (trimmedTickers.has(pItem.asset.ticker)) continue
    const heldScores = data.scores[pItem.asset.ticker]
      ?? data.scores[pItem.asset.ticker.toUpperCase()]
    const sellVeto = rotationSellVeto({
      gate: data.rotationRules?.sellNewsGate,
      newsScore: heldScores?.newsScore,
      insiderScore: heldScores?.insiderScore,
      price: pItem.asset.currentPrice,
      sma20: pItem.asset.sma20,
      scoreFeedPresent: newsFeedPresent,
    })
    if (sellVeto) {
      // [ROTATION_VETO] evidence trail (hypothesis #9c): record the blocked
      // sell as structured data; the consumer decides logging/persistence.
      sellNewsVetoes.push({
        ticker: pItem.asset.ticker.toUpperCase(),
        veto: sellVeto,
        price: pItem.asset.currentPrice,
        sma20: pItem.asset.sma20,
        newsScore: heldScores?.newsScore,
        insiderScore: heldScores?.insiderScore,
      })
      continue
    }
    const branchHoldingOverride = data.rotationRules?.branchMinHoldingDays && pItem.asset.strategy
      ? data.rotationRules.branchMinHoldingDays[pItem.asset.strategy]
      : undefined

    const requiredHoldingDays = pItem.asset.minHoldingDays !== undefined
      ? pItem.asset.minHoldingDays
      : (branchHoldingOverride !== undefined ? branchHoldingOverride : defaultMinHoldingDays)

    // Exclude recently bought tickers (< strategy minHoldingDays) from rotation selling to prevent churn
    if (pItem.asset.daysHeld !== undefined && requiredHoldingDays > 0 && pItem.asset.daysHeld < requiredHoldingDays) {
      continue
    }

    const topCandidate = availableSetups[0]
    // Candidate must clear the absolute minCandidateScore floor AND beat the holder
    // by minGainMultiplier, so a near-zero holder score can't pull in a weak setup.
    if (topCandidate && topCandidate.score >= minCandidateScoreThreshold && topCandidate.score > pItem.score * minGainMultiplier) {
      const actualShares = (pItem.asset.shares && pItem.asset.shares > 0)
        ? pItem.asset.shares
        : (pItem.asset.capitalDeployed && pItem.asset.entry > 0
          ? Math.floor(pItem.asset.capitalDeployed / pItem.asset.entry)
          : Math.max(1, Math.floor((data.budget.total * 0.1) / (pItem.asset.entry > 0 ? pItem.asset.entry : pItem.asset.currentPrice))))
      const releasedCapital = actualShares * pItem.asset.currentPrice

      const perTradeRisk = Math.max(1, topCandidate.setup.currentPrice - topCandidate.setup.stopLoss)
      const sharesByRisk = Math.floor(maxRiskPerTrade / perTradeRisk)
      const sharesByCapital = Math.floor(releasedCapital / topCandidate.setup.currentPrice)
      const buyShares = Math.max(1, Math.min(sharesByRisk, sharesByCapital > 0 ? sharesByCapital : sharesByRisk))
      const boughtCapital = buyShares * topCandidate.setup.currentPrice

      if (releasedCapital > boughtCapital) {
        freedCash += (releasedCapital - boughtCapital)
      }

      rotations.push({
        sell: pItem.asset.ticker,
        buy: topCandidate.setup.ticker,
        shares: buyShares,
        reasonKey: RotationReasonKey.SWAP,
        reasonData: {
          sellTicker: pItem.asset.ticker,
          remRR: pItem.remainingRR,
          shares: buyShares,
          buyTicker: topCandidate.setup.ticker,
          initRR: topCandidate.initialRR,
          scoreGain: Math.round((topCandidate.score / Math.max(0.1, pItem.score) - 1) * 100),
        },
      })
      availableSetups.shift()
    }
  }

  // C. Unallocated & Freed Cash Deployment (Enforces combined position risk per stock)
  const availableCash = data.budget.cash + freedCash
  const existingPositionRiskMap = new Map<string, number>()

  for (const p of data.portfolio) {
    const riskPerShare = Math.max(0.01, Math.abs(p.currentPrice - p.stopLoss))
    const actualShares = (p.shares && p.shares > 0)
      ? p.shares
      : (p.capitalDeployed && p.entry > 0
        ? Math.floor(p.capitalDeployed / p.entry)
        : 0)
    existingPositionRiskMap.set(p.ticker.toUpperCase(), actualShares * riskPerShare)
  }

  if (allowCash && availableCash > 200 && availableSetups.length > 0) {
    let remainingCash = availableCash
    while (remainingCash >= 200 && availableSetups.length > 0 && slotsRemaining > 0) {
      const candidate = availableSetups.shift()
      if (!candidate) continue

      const tickerUpper = candidate.setup.ticker.toUpperCase()
      const existingRiskUsd = existingPositionRiskMap.get(tickerUpper) || 0

      const remainingRiskBudget = Math.max(0, maxRiskPerTrade - existingRiskUsd)
      if (remainingRiskBudget <= 0) continue

      const perTradeRisk = Math.max(1, Math.abs(candidate.setup.currentPrice - candidate.setup.stopLoss))
      const sharesByRisk = Math.floor(remainingRiskBudget / perTradeRisk)
      const sharesByCash = Math.floor(remainingCash / candidate.setup.currentPrice)

      const shares = Math.min(sharesByRisk, sharesByCash)
      if (shares < 1 || (shares * candidate.setup.currentPrice > remainingCash)) continue

      const allocUsd = shares * candidate.setup.currentPrice
      const totalRiskUsd = shares * perTradeRisk

      rotations.push({
        sell: RotationSpecialTarget.CASH,
        buy: candidate.setup.ticker,
        shares,
        price: candidate.setup.currentPrice,
        allocatedUsd: Number(allocUsd.toFixed(2)),
        riskUsd: Number(totalRiskUsd.toFixed(2)),
        reasonKey: RotationReasonKey.CASH_DEPLOY,
        reasonData: {
          totalFreed: availableCash,
          shares,
          ticker: candidate.setup.ticker,
          price: candidate.setup.currentPrice,
          allocated: allocUsd,
          risk: totalRiskUsd,
        },
      })

      existingPositionRiskMap.set(tickerUpper, existingRiskUsd + totalRiskUsd)
      remainingCash -= allocUsd
      slotsRemaining -= 1
    }
  }

  // 3. Compute Target Portfolio State & Net Consolidated Actions
  const currentPortfolioMap = new Map<string, { ticker: string; shares: number; price: number }>()
  const targetMap = new Map<string, { ticker: string; shares: number; price: number }>()

  for (const p of data.portfolio) {
    const tickerUpper = p.ticker.toUpperCase()
    const shares = (p.shares && p.shares > 0)
      ? p.shares
      : (p.capitalDeployed && p.entry > 0
        ? Math.floor(p.capitalDeployed / p.entry)
        : Math.max(1, Math.floor((data.budget.total * 0.1) / (p.entry > 0 ? p.entry : p.currentPrice))))
    const price = p.currentPrice || p.entry || 1.0

    currentPortfolioMap.set(tickerUpper, { ticker: tickerUpper, shares, price })
    targetMap.set(tickerUpper, { ticker: tickerUpper, shares, price })
  }

  for (const rot of rotations) {
    if (rot.reasonKey === RotationReasonKey.INITIAL_BUY || rot.reasonKey === RotationReasonKey.CASH_DEPLOY) {
      const buyTicker = rot.buy.toUpperCase()
      const price = rot.price || (rot.reasonData.price ? Number(rot.reasonData.price) : 1.0)
      const buyShares = rot.shares || Number(rot.reasonData.shares) || 0
      const existing = targetMap.get(buyTicker)
      if (existing) {
        existing.shares += buyShares
      } else {
        targetMap.set(buyTicker, { ticker: buyTicker, shares: buyShares, price })
      }
    } else if (rot.reasonKey === RotationReasonKey.TRIM_RISK) {
      const sellTicker = rot.sell.toUpperCase()
      const trimShares = Number(rot.reasonData.shares) || 0
      const existing = targetMap.get(sellTicker)
      if (existing) {
        existing.shares = Math.max(0, existing.shares - trimShares)
      }
    } else if (rot.reasonKey === RotationReasonKey.SWAP) {
      const sellTicker = rot.sell.toUpperCase()
      const buyTicker = rot.buy.toUpperCase()
      const buyShares = rot.shares || Number(rot.reasonData.shares) || 0
      const setupObj = data.setups.find(s => s.ticker.toUpperCase() === buyTicker)
      const buyPrice = setupObj?.currentPrice || Number(rot.reasonData.price || 1.0)

      targetMap.set(sellTicker, { ticker: sellTicker, shares: 0, price: targetMap.get(sellTicker)?.price || 1.0 })
      const existingBuy = targetMap.get(buyTicker)
      if (existingBuy) {
        existingBuy.shares += buyShares
      } else {
        targetMap.set(buyTicker, { ticker: buyTicker, shares: buyShares, price: buyPrice })
      }
    }
  }

  const totalCapital = data.budget.total || 30000
  const targetPortfolio: TargetPosition[] = []

  for (const [
    ticker,
    pos,
  ] of targetMap.entries()) {
    if (pos.shares > 0) {
      const allocatedUsd = Number((pos.shares * pos.price).toFixed(2))
      const pctAllocation = Number(((allocatedUsd / totalCapital) * 100).toFixed(1))
      targetPortfolio.push({
        ticker,
        shares: pos.shares,
        price: pos.price,
        allocatedUsd,
        pctAllocation,
      })
    }
  }

  const actions: PortfolioAction[] = []
  const allTickers = new Set([
    ...currentPortfolioMap.keys(),
    ...targetMap.keys(),
  ])

  for (const ticker of allTickers) {
    const cur = currentPortfolioMap.get(ticker)
    const tgt = targetMap.get(ticker)
    const curShares = cur?.shares || 0
    const tgtShares = tgt?.shares || 0
    const price = tgt?.price || cur?.price || 1.0
    const diff = tgtShares - curShares

    if (diff < 0 && tgtShares === 0 && curShares > 0) {
      actions.push({
        type: 'SELL',
        ticker,
        shares: curShares,
        price,
        amountUsd: Number((curShares * price).toFixed(2)),
      })
    } else if (diff < 0 && tgtShares > 0) {
      const trimCount = Math.abs(diff)
      actions.push({
        type: 'TRIM',
        ticker,
        shares: trimCount,
        price,
        amountUsd: Number((trimCount * price).toFixed(2)),
      })
    } else if (diff > 0) {
      actions.push({
        type: 'BUY',
        ticker,
        shares: diff,
        price,
        amountUsd: Number((diff * price).toFixed(2)),
        ...setupStopsByKey.get(ticker),
      })
    }
  }

  return {
    rotations,
    targetPortfolio,
    actions,
    rationale: (rotations.length > 0 || actions.length > 0) ? 'RECOMMENDATIONS' : 'ALREADY_OPTIMIZED',
    sellNewsVetoes: sellNewsVetoes.length > 0 ? sellNewsVetoes : undefined,
  }
}

export function getBranchTimeframeHorizon(riskProfile?: import('./ast').BranchRiskProfile | string,
  lang: Language = 'en'): string {
  switch (riskProfile) {
    case 'MEAN_REVERSION':
      return t('TIMEFRAME_MEAN_REVERSION', lang)
    case 'MOMENTUM':
      return t('TIMEFRAME_MOMENTUM', lang)
    case 'GROWTH':
      return t('TIMEFRAME_GROWTH', lang)
    case 'VALUE':
      return t('TIMEFRAME_VALUE', lang)
    default:
      return t('TIMEFRAME_MOMENTUM', lang)
  }
}

/**
 * Render a {@link RotationResult} as a translated, Telegram-HTML user-facing
 * message. This is the presentation layer — kept separate from the decision
 * logic so callers can consume the structured rotations (e.g. backtests) without
 * paying for formatting, and render in any language after the fact.
 */
export function formatRotationResult(result: RotationResult,
  lang: Language,
  /**
   * REQUIRED: the AST's `rotationRules.scoreGainMultiplier`. Used to populate
   * the {requiredGainPct} placeholder in the "already optimized" message.
   * Callers must resolve this from the user's AST before calling —
   * no silent fallback (the prior misleading `?? 25` default was removed).
   */
  scoreGainMultiplier: number): string {
  if (result.rationale === 'NO_SETUPS') {
    return t('OPTIMIZATION_NO_SETUPS', lang)
  }
  if ((!result.actions || result.actions.length === 0) && (!result.rotations || result.rotations.length === 0)) {
    const requiredGainPct = Math.round((scoreGainMultiplier - 1) * 100)
    return t('OPTIMIZATION_ALREADY_OPTIMIZED', lang, { requiredGainPct: String(requiredGainPct) })
  }

  let msg = ''

  if (result.targetPortfolio && result.targetPortfolio.length > 0) {
    msg += `${t('TARGET_PORTFOLIO_TITLE', lang)}\n`
    for (const p of result.targetPortfolio) {
      msg += `${t('TARGET_POSITION_LINE', lang, {
        ticker: p.ticker,
        shares: p.shares,
        amount: p.allocatedUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        pct: p.pctAllocation.toFixed(1),
      })}\n`
    }
  }

  if (result.actions && result.actions.length > 0) {
    msg += `\n${t('ACTION_PLAN_TITLE', lang)}\n`

    const sellActions = result.actions.filter(a => a.type === 'SELL' || a.type === 'TRIM')
    const buyActions = result.actions.filter(a => a.type === 'BUY')

    if (sellActions.length > 0) {
      msg += `\n${t('ACTION_PLAN_SELL_HEADER', lang)}\n`
      for (const a of sellActions) {
        const key = a.type === 'SELL' ? 'ACTION_SELL_FULL' : 'ACTION_TRIM_PARTIAL'
        msg += `${t(key, lang, {
          ticker: a.ticker,
          shares: a.shares,
          amount: a.amountUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        })}\n`
      }
    }

    if (buyActions.length > 0) {
      msg += `\n${t('ACTION_PLAN_BUY_HEADER', lang)}\n`
      for (const a of buyActions) {
        msg += `${t('ACTION_BUY_NEW', lang, {
          ticker: a.ticker,
          shares: a.shares,
          price: a.price.toFixed(2),
          amount: a.amountUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        })}\n`
      }
    }
  } else if (result.rotations && result.rotations.length > 0) {
    const header = result.rationale === 'INITIAL_ALLOCATION'
      ? t('ROTATION_INITIAL_ALLOCATION_TITLE', lang)
      : t('OPTIMIZATION_RECOMMENDATIONS', lang)
    const lines = result.rotations.map(a => formatRotationAction(a, lang))
    msg += `${header}\n${lines.join('\n')}`
  }

  return msg.trim()
}

function formatRotationAction(a: RotationAction, lang: Language): string {
  const d = a.reasonData
  switch (a.reasonKey) {
    case RotationReasonKey.INITIAL_BUY:
      return t('ROTATION_INITIAL_BUY', lang, {
        shares: d.shares!,
        ticker: String(d.ticker),
        price: Number(d.price).toFixed(2),
        allocated: Number(d.allocated).toFixed(0),
        risk: Number(d.risk).toFixed(0),
      })
    case RotationReasonKey.TRIM_RISK:
      return t('ROTATION_TRIM_REASON', lang, {
        ticker: String(d.ticker),
        risk: Number(d.risk).toFixed(0),
        maxRisk: Number(d.maxRisk).toFixed(0),
        shares: d.shares!,
        freed: Number(d.freed).toFixed(0),
      })
    case RotationReasonKey.SWAP:
      return t('ROTATION_SWAP_REASON', lang, {
        sellTicker: String(d.sellTicker),
        remRR: Number(d.remRR).toFixed(1),
        shares: d.shares!,
        buyTicker: String(d.buyTicker),
        initRR: Number(d.initRR).toFixed(1),
        scoreGain: d.scoreGain!,
      })
    case RotationReasonKey.CASH_DEPLOY:
      return t('ROTATION_REINVEST_REASON', lang, {
        totalFreed: Number(d.totalFreed).toFixed(0),
        shares: d.shares!,
        ticker: String(d.ticker),
        price: Number(d.price).toFixed(2),
        allocated: Number(d.allocated).toFixed(0),
        risk: Number(d.risk).toFixed(0),
      })
  }
}
