export type Operator = '>' | '<' | '>=' | '<=' | '==' | '!=' | 'exists' | 'missing'

export type BranchRiskProfile = 'MOMENTUM' | 'MEAN_REVERSION' | 'VALUE' | 'GROWTH'

// A leaf node that compares a data field to a static value OR another data field
export interface ConditionNode {
  indicator: string        // e.g., "rsi", "currentPrice", "marketRegime.isSafe"
  operator: Operator
  value?: number | string | boolean // Compare against a static value (e.g., 30)
  target?: string          // OR Compare against another indicator (e.g., "sma200")
}

// A branch node that groups conditions
export interface LogicGroupNode {
  and?: ASTNode[]
  or?: ASTNode[]
  name?: string
  description?: string
  tags?: string[] // Behavior/pattern tags (e.g. ['golden_cross', 'fcf_inflection', 'oversold_dip'])
  weight?: number // Optional per-branch confluence weight (default 1.0). Higher = contributes more to score when matched.
  riskProfile?: BranchRiskProfile // Investment thesis classification (MOMENTUM / MEAN_REVERSION / VALUE / GROWTH)
  timeframeHorizon?: string // Custom holding horizon label (e.g. "3-10 Days", "1-4 Weeks", "1-6 Months")
  targetRiskMultiplier?: number // Per-branch risk-to-reward target multiplier override (e.g. 2.0, 2.5, 3.2, 4.0)
  stopLossAtrMultiplier?: number // Per-branch stop-loss ATR multiplier override (e.g. 2.0, 2.5, 3.0)
}

export type ASTNode = ConditionNode | LogicGroupNode

export interface DynamicScoringRule {
  condition: ASTNode
  boost: number
  reason?: string
  regimeMultiplier?: {
    RISK_OFF?: number
    RISK_ON?: number
  }
}

export type SellNewsGate = 'off' | 'require_score' | 'require_score_hold_dip'

export interface RotationRules {
  enabled?: boolean
  minCandidateScore?: number // e.g. 2.0 (minimum score required for rotation entry)
  minScoreDiff?: number // e.g. 1.5 (minimum score differential required)
  scoreGainMultiplier?: number // e.g. 1.25 (Candidate score must be 25% higher than Position score)
  weights?: {
    w_rr?: number // Risk-Reward weight (default: 1.0)
    w_s?: number  // Sentiment/News weight (default: 1.0)
    w_m?: number  // Macro/Geopolitical weight (default: 1.0)
    w_t?: number  // Trailing stop sensitivity weight (default: 1.0)
  }
  allowCashDeployment?: boolean // Allow deploying idle cash into top candidate (default: true)
  maxPortfolioPositions?: number // Max active portfolio slots
  minHoldingDays?: number // ⏳ Minimum trading days a stock must be held before rotation out (cooldown)
  branchMinHoldingDays?: Record<string, number> // ⏱️ Archetype-based minimum holding cooldown mapping (e.g. BREAKOUT: 7d, MACRO: 15d, TREND: 30d)
  maxHoldingDays?: number // ⏳ Maximum trading days a stock can be held before forced time-based exit
  rotationCooldownDays?: number // ⏳ Cooldown period before re-entering a recently rotated out ticker
  /**
   * ⏳ Per-branch MAX holding days (2026-08-21 structural sleeve): overrides
   * the flat maxHoldingDays for trades opened by the named branch — e.g.
   * `{"🌱 FCF Spring & Sector Tailwind": 120}` gives structural theses a
   * quarter while velocity branches keep the 30-60d cap. Keyed by exact
   * branch name (same convention as branchMinHoldingDays).
   */
  branchMaxHoldingDays?: Record<string, number>
  /**
   * 🛡️ Thesis-managed branches (2026-08-21 structural sleeve): branch names
   * whose open positions are exempt from BOTH capital-recycling paths that
   * churn slow theses on fast signals: (1) forced rotation — the EV/day
   * ranking structurally starves multi-quarter theses; (2) strategy handoff —
   * a slow thesis's entry gates oscillate day-to-day, so branch non-firing is
   * noise, not thesis decay (see sleeveExemptions.ts). Thesis-break exits and
   * stops still apply. Field name kept for stored-AST compatibility.
   */
  rotationExemptBranches?: string[]
  protectWinnerProfitPercent?: number // 🏆 Protect positions with profit > X% from forced rotation (default: 5.0)
  excludedSectors?: string[] // 🚫 Dynamic or static sector exclusions
  excludedIndustries?: string[] // 🚫 Dynamic or static industry exclusions
  onlyExcludeInRiskOff?: boolean // 🛡️ Enforce sector exclusions ONLY during RISK_OFF / High-Vol regimes
  /**
   * Candidate-ranking key for forced rotation. 'score' = confluence score
   * (default, legacy). 'efficiency' = naive R/day (rrRatio/holdDays).
   * 'ev' = probability-adjusted expectedRPerDay from BRANCH_STATS.
   * Validated via scripts/diagnose_rotation_handoff_sweep.ts: 'ev' won ALL
   * 3 regime windows on a 50-ticker cached-FMP sweep, lifting Calmar from
   * 1.11 → 2.87 avg when combined with strategy handoff.
   */
  rotationScoring?: 'score' | 'efficiency' | 'ev'
  /**
   * Rotation SWAP gate (live/FT; honest backtest fail-opens when no news
   * feed is present). `off` (default) = legacy. `require_score` = do not
   * rotate out a name whose newsScore is missing. `require_score_hold_dip`
   * = also hold when news≥7 AND insider≥7 AND price < sma20.
   */
  sellNewsGate?: SellNewsGate
}

export type CohortMemberPolicy = 'FOLLOW' | 'REVERSE'
export type CohortLeaderPolicy = 'TRADE' | 'SIGNAL_ONLY'
export type CohortCapitalFlip = 'NONE' | 'TRIM_LEADERS' | 'ROTATE_TO_MEMBERS' | 'ROTATE_TO_CASH'

/**
 * Named cohort: one narrative, different capital paths.
 * Example: leaders=['NVDA'], members=['ASML','TSM'] memberPolicy='FOLLOW' (AI infra)
 * vs leaders=['NVDA'], members=['CAT'] memberPolicy='REVERSE' (robotics/practical AI
 * that takes the other side when GPU-infra leadership fades).
 */
export interface CohortGroupRule {
  name: string
  leaders: string[]
  members: string[]
  memberPolicy: CohortMemberPolicy
  leaderPolicy?: CohortLeaderPolicy
  /** Decimal excess vs SPY over 20d. Default 0. FOLLOW needs weakest leader > this; REVERSE needs < -this. */
  slowdownThreshold?: number
  capitalFlip?: CohortCapitalFlip
}

export interface UniverseRules {
  minMarketCap?: number       // e.g. 1,000,000,000 ($1B)
  maxMarketCap?: number
  minAvgVolume?: number       // e.g. 500,000 shares/day
  allowedSectors?: string[]    // e.g. ["Technology", "Healthcare", "Financials"]
  excludedSectors?: string[]
  allowedIndustries?: string[]
  excludedTickers?: string[]   // e.g. ["MEME"]
  whitelistTickers?: string[]  // e.g. ["AAPL", "NVDA", "MSFT"]
}

/**
 * Entry-time per-stock price-state gates, evaluated BEFORE any branch fires.
 * All guards FAIL-OPEN on missing data (an unverifiable price state is not a
 * veto) — mirrors the rotation-veto epistemics contract. Undefined field =
 * guard off = prior behavior.
 */
export interface EntryGuards {
  /**
   * Chase guard (entry_guard_v1, 2026-09-02): block entries when price sits
   * more than N ATRs above SMA20 (`sma20ExtensionAtr`). Measured (hypothesis
   * #12, cross-sectional replay n=10.7k): the 3-5 ATR band ran 45.5% win /
   * −0.05R vs baseline +0.14R — entries deep in extension are the weak cell,
   * and they pile up exactly on broad melt-up days when signal volume balloons.
   */
  maxSma20ExtensionAtr?: number
}

export interface PositionSizingRules {
  minCapitalPerTrade?: number  // e.g. $500 minimum allocation
  maxCapitalPerTrade?: number  // e.g. $5,000 maximum allocation
  maxPortfolioAllocationPercent: number // REQUIRED — e.g. 10.0 = max 10% of portfolio per position. Set to 100 for no cap.
  /**
   * Structural capital/risk decoupler (2026-08-21): max capitalDeployed per
   * entry as a multiple of the entry's dollar risk (shares × riskPerShare).
   * Under raw risk parity capital = risk × price/stopDistance explodes as
   * stops narrow (a 1.5%-ATR name at a 2× stop deploys ~33× risk in capital),
   * which skewed loser/winner sizes 1.28-1.30. E.g. 25 ⇒ never deploy more
   * than 25× the dollar risk. Optional + fail-open: unset = prior behavior.
   */
  capitalRiskRatioCap?: number
  overrideRiskPerTrade?: number
  riskRewardRatio?: number    // e.g. 3.0 (1:3 R:R)
}

export interface CustomStrategyAST {
  strategyName?: string
  tags?: string[] // Top-level behavior & strategy archetype tags (e.g. ['trend_continuation', 'momentum'])
  minScoreToEmit?: number // Minimum net score required for a setup to be emitted. Default 0 (emit all valid). Dashboard ASTs typically set 1.0 to suppress sub-threshold candidates; B2D endpoints pass 0 to expose all scored setups.
  signalAggressiveness?: number // Signal selection diversification dial, 0.0..1.0. 1.0 = max aggressive (pure score ranking, no thesis/sector diversification); 0.0 = max diversified (strong penalty for repeating a thesis/sector). Default: 0.5. Enforced by the consumer (client_api), NOT the central data engine.
  maxTotalSignals?: number // Hard ceiling on total signals surfaced per scan. Default: 8
  entryGuards?: EntryGuards // Per-stock entry-time price-state gates (chase guard etc.), evaluated BEFORE branches. Fail-open on missing indicators.
  universe?: UniverseRules // Target market universe criteria (Market Cap, Volume, Sectors, Ticker Whitelist)
  universeRules?: UniverseRules
  positionSizing?: PositionSizingRules // Min/Max position sizing and portfolio allocation rules
  entryLogic: ASTNode
  exitLogic?: ASTNode
  enableDefensiveRotation?: boolean // 🛡️ Portfolio level switch for macro protection
  rotationProfile?: 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE' // 🔄 Asset rotation profile
  rotationRules?: RotationRules // 🔄 User-configurable rotation weights and threshold multipliers
  /**
   * Optional named cohorts. Off when omitted — default AI_COMBINED does not set this.
   * Entry gate is fail-closed for members when leader 20d excess vs SPY is missing.
   */
  cohortGroups?: CohortGroupRule[]
  /**
   * When true, merge live macro-narrative cohorts (tier-1/explicitTickers as
   * leaders; FOLLOW/REVERSE members from 60d corr). Live/FT only — honest
   * backtests leave macroDerivedCohortGroups undefined (no narrative history).
   */
  cohortFromMacros?: boolean
  aiRiskMode?: 'DEFENSIVE' | 'BALANCED' | 'AGGRESSIVE' // 🤖 AI Sizing Risk Mode during Systemic Liquidation
  riskManagement?: {
    stopLossAtrMultiplier?: number
    targetRiskMultiplier?: number
    chandelierAtrMultiplier?: number
    partialExitTriggerR?: number
    partialExitPercent?: number
    breakEvenActivationR?: number
    chandelierActivationR?: number
    gapExitThresholdPercent?: number
    gapExitThresholdAtr?: number
    overrideRiskPerTrade?: number
    maxDaysToEarnings?: number // 📅 Pre-earnings blackout period in trading days (e.g. 3)
    minHoldingDays?: number // ⏳ Minimum holding period in trading days before position can be closed/rotated
    maxHoldingDays?: number // ⏳ Maximum holding period in trading days before forced time-based exit
    /**
     * Strategy handoff: proactively close profitable positions when their
     * original branch stops firing (thesis decay). Catches decaying winners
     * that today's stop/target/time/forced-rotation exits miss. Validated via
     * scripts/diagnose_rotation_handoff_sweep.ts — combined with rotationScoring:'ev',
     * won ALL 3 regime windows, lifting Calmar from 1.11 → 2.87 avg.
     */
    enableStrategyHandoff?: boolean
    /**
     * Fresh-signal stop refresh: when a NEW signal fires for a ticker the user
     * already holds, raise the monitored stop/TP and refresh the persisted ATR
     * from that signal — TIGHTEN-ONLY (never lowers the stop; coexists with the
     * break-even + chandelier ratchet). Off by default: this changes how held
     * positions are managed, so a strategy must opt in explicitly. Set true
     * only when the strategy intends its signals to re-manage open positions.
     */
    enableSignalStopRefresh?: boolean
    /**
     * Minimum realized R-multiple required before handoff can fire.
     * 0 = any profit (too aggressive — cuts winners early). 1 = require
     * ≥1R captured first (recommended — protects marginal winners).
     */
    handoffMinProfitR?: number
    /**
     * ⚖️ Per-branch risk multiplier (2026-08-21 structural sleeve): scales the
     * position's dollar risk for trades opened by the named branch — e.g.
     * `{"🌱 FCF Spring & Sector Tailwind": 0.5}` enters structural theses at
     * half risk (confirmation-add is future work; never average down).
     * Keyed by exact branch name.
     */
    branchRiskMultiplier?: Record<string, number>
    /**
     * ⏱️ Stop TRIGGER semantics (2026-08-21 sweep hardening, AST-expressible):
     * - 'close' (recommended, A/B-justified): the stop triggers only on
     *   CLOSE-through — ignores intrabar sweep wicks. A/B: ret 113.1 vs 77.6,
     *   maxDD 17.4 vs 19.6 (BETTER), stop-outs −38%. GAP_BEYOND_STOP unaffected.
     * - 'wick': any bar-range touch triggers — pessimistic live-stop-order
     *   assumption; use when the position runs a resting stop order.
     * Consumers: backtest engine (per-trade copy; scenario.stopFillMode
     * overrides for sweeps) and live exitManager (reads the user's AST).
     * Distinct from stopPlacement (WHERE the stop sits).
     */
    stopFillMode?: 'wick' | 'close'
    /**
     * 🎯 Stop placement geometry (2026-08-21 sweep hardening):
     * - 'formula' (default, historical): stop = entry − stopLossAtrMultiplier × ATR.
     * - 'sweep_zone': additionally anchor the stop BELOW the obvious sweep
     *   liquidity — structuralFloor (20-day low) − 0.75×ATR — taking the
     *   lower of the two, with widening bounded to 1.5× the formula distance
     *   (unbounded widening hurts — diagnose_stop_ab). Fail-closed: no
     *   structuralFloor ⇒ formula stop unchanged.
     */
    stopPlacement?: 'formula' | 'sweep_zone'
    regimeAdjustments?: {
      RISK_ON?: {
        stopMultiplier?: number
        targetMultiplier?: number
        gapExitPercent?: number // Override gapExitThresholdPercent in this regime
        gapExitAtr?: number // Override gapExitThresholdAtr in this regime
        panicHoldDays?: number // First N days after regime onset: gap exits DISABLED (don't sell the first panic print)
      }
      RISK_OFF?: {
        stopMultiplier?: number
        targetMultiplier?: number
        gapExitPercent?: number // Override gapExitThresholdPercent in this regime
        gapExitAtr?: number // Override gapExitThresholdAtr in this regime
        panicHoldDays?: number // First N days after regime onset: gap exits DISABLED (don't sell the first panic print)
      }
    }
  }
  dynamicScoring?: DynamicScoringRule[]
}

export interface ForwardTestPortfolioItem {
  id: string | number
  chatId?: string | number
  name?: string
  strategyName?: string
  status?: string
  totalReturnPct?: number
  pnl?: number
  openPositions?: unknown[]
}

