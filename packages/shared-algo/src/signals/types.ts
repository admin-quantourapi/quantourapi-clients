import type {
  CatalystStatus, FcfInflection, 
} from '../core/types'

/**
 * Signal alert payload dispatched to subscribers (Telegram, Discord, Cache, DB).
 */
export interface SignalAlertPayload {
  ticker: string
  price?: number
  entry?: number
  change?: number
  strategy?: string
  strategyName?: string
  userId?: string
  reason?: string
  rsi: number
  volume_vs_avg?: number
  volumeVsAvg?: number
  volumeChange?: number
  near_support?: boolean
  nearSupport?: boolean
  supportDistance?: string
  relative_strength?: number
  relativeStrength?: number
  ema_context?: string
  emaContext?: string
  ema8?: number
  ema21?: number
  sma10?: number
  sma20?: number
  sma50?: number
  sma200?: number
  market_context?: string
  marketStatus?: string
  sector_context?: string
  sectorStatus?: string
  sectorName?: string
  sectorPerformance?: string
  earnings_date?: string
  earningsDate?: string
  nextEarnings?: string
  latestEarnings?: string
  exDividendDate?: string
  dividendAmount?: number
  analyst_consensus?: string
  analystConsensus?: string
  analyst_upside?: number
  analystUpside?: number
  analystTarget?: number
  news_sentiment?: string
  newsSentiment?: string
  newsSummary?: string
  narrative?: string
  narrativeThesis?: string
  alignmentStatus?: string
  stop_loss?: number
  stopLoss?: number
  target: number
  atr?: number
  breakEvenPrice?: number
  shares?: number
  capitalRequired?: number
  floor?: string
  maxRisk?: number
  atrMultiplier?: number
  convictionMultiplier?: number
  minHoldingDays?: number
  riskProfile?: string
  catalystStatus?: CatalystStatus
  fcfInflection?: FcfInflection
  atrMove?: number
  score?: number
  factors?: Record<string, unknown>
  isBroadcasted?: boolean
  connections?: Array<{ connectionType: string; toTicker: string }>
  /**
   * Branch anatomy + EV fields (Phase 3+). Threaded from SetupResult so the
   * /v1/signals API can expose them, enabling cold-cache /optimize rotation
   * to rank by EV/day instead of falling back to OpportunityScore.
   */
  firedBranchName?: string
  rrRatio?: number
  estimatedHoldingDays?: number
  expectedRPerDay?: number
}

/** Legacy alias for SignalAlertPayload */
export type TelegramPayload = SignalAlertPayload
