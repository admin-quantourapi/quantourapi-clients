import { MACRO_INDEX_ETFS } from '@quantour/shared-algo/src/core/constants'
import { local } from '@quantour/shared-algo/src/core/i18n'
import { isMarketOpen } from '@quantour/shared-algo/src/core/marketHours'
import {
  CustomStrategyAST,
} from '@quantour/shared-algo/src/finance-algo/ast'
import {
  evaluateCustomStrategy, evaluateSetup, getBranchTimeframeHorizon, type MarketData, type SetupResult,
} from '@quantour/shared-algo/src/finance-algo/screener'
import { detectRotationVetoBlocks } from '@quantour/shared-algo/src/finance-algo/rotationGateDiagnostics'
import { groupSignalsByAggressiveness } from '@quantour/shared-algo/src/finance-algo/signalGrouping'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

import { logger } from '~/services/logger'

import { db } from '../db'
import { settings } from '../db/clientSchema'
import {
  AccountEventType, lastNoticeWithin, NOTICE_THROTTLE_MS, type NoticeReason, recordEvent, 
} from '../services/accountEvents'
import {
  sendGenericMessage,
} from '../services/telegramService'

import { getUserBudget } from './budgetService'
import {
  getAvailableCash, tightenHeldPositionStops,
} from './botHandlers/portfolioHandlers'

export interface SentSignalRecord {
  timestamp: number
  price: number
  branchName?: string
}

/**
 * Runtime-validated shape of a metric record flowing out of the Central API
 * `/api/v1/metrics` endpoint (or the dailyMetricsHistory DB fallback). Every
 * `data.*` access below is typed through this schema instead of a blind
 * `as` cast on untrusted JSON.
 */
const MetricRecordSchema = z.object({
  ticker: z.string(),
  price: z.coerce.number(),
  symbol: z.string().optional(),
  relativeStrength: z.coerce.number().optional(),
  sma50: z.coerce.number().optional(),
  sma200: z.coerce.number().optional(),
  sma20: z.coerce.number().optional(),
  sma10: z.coerce.number().optional(),
  ema8: z.coerce.number().optional(),
  ema21: z.coerce.number().optional(),
  volume: z.coerce.number().optional(),
  volumePace: z.coerce.number().optional(),
  avgVolume: z.coerce.number().optional(),
  rsi: z.coerce.number().optional(),
  atr: z.coerce.number().optional(),
  marketCap: z.coerce.number().optional(),
  peRatio: z.coerce.number().optional(),
  psRatio: z.coerce.number().optional(),
  score: z.coerce.number().optional(),
  newsScore: z.coerce.number().nullish(),
  insiderScore: z.coerce.number().nullish(),
  // Group-level news sentiment + derived divergence (independent fields; null
  // when unscored — AstEvaluator short-circuits null/undefined fail-closed).
  sectorNewsScore: z.coerce.number().nullish(),
  macroNewsScore: z.coerce.number().nullish(),
  newsDivergence: z.coerce.number().nullish(),
  newsAlignment: z.string().nullish(),
  // News velocity (the DIFF): re-score jumps + quarterly change.
  newsScoreDelta: z.coerce.number().nullish(),
  newsScoreDeltaQuarterly: z.coerce.number().nullish(),
  sectorNewsDelta: z.coerce.number().nullish(),
  sectorNewsDeltaQuarterly: z.coerce.number().nullish(),
  // ROTATION CONTEXT (rotation_conviction_v1): cross-sectional score rank +
  // inertia fields served by /api/v1/metrics (fail-closed nullish).
  newsScoreRank: z.coerce.number().nullish(),
  newsScoreTrend: z.coerce.number().nullish(),
  newsScoreAgeDays: z.coerce.number().nullish(),
  sectorNewsTrend: z.coerce.number().nullish(),
  sentimentScore: z.coerce.number().optional(),
  macroScore: z.coerce.number().optional(),
  dayHigh: z.coerce.number().optional(),
  dayLow: z.coerce.number().optional(),
  fiftyTwoWeekHigh: z.coerce.number().optional(),
  analystTarget: z.coerce.number().optional(),
  marketStatus: z.string().optional(),
  sectorName: z.string().optional(),
  industryName: z.string().optional(),
  latestEarnings: z.string().optional(),
  nextEarnings: z.string().optional(),
  fcfInflection: z.string().optional(),
  liquidationThreat: z.unknown().optional(),
  macro: z.record(z.string(), z.unknown()).optional(),
  macroExposures: z.array(z.unknown()).optional(),
}).passthrough()
type MetricRecord = z.infer<typeof MetricRecordSchema>

declare global {
  var sentSignalsCache: Map<string, SentSignalRecord>
}

export interface ScanCacheEntry {
  timestamp: number
  totalCount: number
  top5Text: string
  allText: string
  sectorText: string
  catalystText: string
  setups?: Array<{ ticker: string; entry: number; target: number; stopLoss: number; strategy: string; sectorName?: string; isRsLeader?: boolean; expectedRPerDay?: number; firedBranchName?: string }>
}

export interface ScanSignalPayload {
  ticker: string
  strategyName?: string
  entry: number
  stopLoss: number
  target: number
  breakEvenPrice?: number
  shares?: number
  capitalRequired?: number
  rsi?: number
  relativeStrength?: number
  volumeChange?: number
  marketStatus?: string
  sectorName?: string
  latestEarnings?: string
  nextEarnings?: string
  analystTarget?: number
  atr?: number
  sma50?: number
  sma200?: number
  /**
   * Risk-reward ratio (e.g. 3.2 for a 1:3.2 setup). Computed by
   * `evaluateCustomStrategy` from the actual entry/stop/target; surfaced here
   * so the display reads from one source instead of recomputing inline.
   */
  rrRatio?: number
  /**
   * Per-trade holding-horizon estimate in trading days, derived from
   * Efficiency-Ratio × ATR (see screener.ts). Surfaces the actually-computed
   * dynamic number to the display, replacing the static AST branch label.
   */
  estimatedHoldingDays?: number
  /**
   * Capital-efficiency metric = rrRatio / estimatedHoldingDays. R-multiples
   * of edge per trading day at risk. Useful as a tiebreaker: a 1:2 R setup
   * finishing in 5 days (0.40 R/day) beats a 1:4 R setup taking 30 days
   * (0.13 R/day) on capital velocity.
   */
  efficiencyRPerDay?: number
  /**
   * Free cash flow inflection ('POSITIVE' | 'NEGATIVE' | 'NONE') computed by
   * the central API from annual FCF history. Drives the 💎/⚠️ badges in the
   * dashboard, Telegram signal cards, and the catalyst view.
   */
  fcfInflection?: string
  /**
   * Name of the AST entry branch that fired this setup. Persisted on the
   * central `signals` table so live branch anatomy (which branches actually
   * alert, and at what score) is auditable instead of guessable.
   */
  firedBranchName?: string
  /**
   * Weighted branch-match score from the AST evaluator. Persisted alongside
   * `firedBranchName` for the branch-conviction audit trail.
   */
  score?: number
  /**
   * Investment-thesis classification of the fired branch (MOMENTUM |
   * MEAN_REVERSION | VALUE | GROWTH). Persisted for per-profile attribution.
   */
  riskProfile?: string
  /**
   * Probability-adjusted EV per trading day (R-multiples), threaded from the
   * setup so cold-cache /optimize rotation ranks by EV/day without a rebuild.
   */
  expectedRPerDay?: number
}

/**
 * AST-driven signal grouping — the CONSUMER-LAYER diversification step.
 * Delegates to the shared `groupSignalsByAggressiveness` (single source of truth,
 * also used by the backtest engine for A/B sweeps). See signalGrouping.ts for the
 * continuous-dial semantics. The central engine (apps/api) emits raw setups;
 * grouping lives here in the client_api consumer.
 */
function applySignalGrouping<C extends { setup: SetupResult; data: { sectorName?: string } }>(candidates: C[], ast: CustomStrategyAST | null): C[] {
  if (!ast || candidates.length === 0) return candidates
  return groupSignalsByAggressiveness(candidates, ast, (c) => String(c.data.sectorName ?? 'Unknown'))
}

export const scanCacheMap = new Map<string, ScanCacheEntry>()

/**
 * Build the evaluator MarketData view for one metric record. Shared by the
 * emission loop and the zero-signal diagnostic pass so both evaluate the
 * exact same data shape (parity guarantee — the diagnostics must explain the
 * emission path, not a subtly different one).
 */
function buildScanMarketData(data: MetricRecord, maxRisk: number, riskProfile: string) {
  return {
    ...data,
    currentPrice: data.price,
    currentVolume: data.volume,
    // Real 52-week high from the central API's live quote (yearHigh). Never
    // fabricate price-as-high — that made drawdown-from-high gates see 0%
    // drawdown by construction. Omitted when the quote lacks it.
    ...(data.fiftyTwoWeekHigh !== undefined ? { fiftyTwoWeekHigh: data.fiftyTwoWeekHigh } : {}),
    maxRisk,
    riskProfile,
    // macro comes from the central API (MacroSync). No fabricated fallback:
    // if absent, gates see undefined and short-circuit fail-closed instead of
    // evaluating against an invented RISK_ON/vix 18/pcr 0.95 regime.
    ...(data.macro ? { macro: data.macro } : {}),
  }
}

/**
 * Normalize a universe-gate "🚫 Halted: …" reason into a stable gate label so
 * tallies aggregate across tickers (strip per-ticker names and magnitudes).
 * Labels mirror universeRejectReason in shared-algo screener.ts — keep both in
 * sync when a gate is added there.
 */
function gateRejectLabel(reason: string): string {
  const r = reason.replace('🚫 Halted: ', '')
  if (r.includes('is excluded from the universe')) return 'excludedTicker'
  if (r.includes('not on the universe whitelist')) return 'notWhitelisted'
  if (r.includes('Market cap missing')) return 'marketCapMissing'
  if (r.includes('Market cap') && r.includes('below')) return 'marketCapBelowFloor'
  if (r.includes('Market cap') && r.includes('above')) return 'marketCapAboveCeiling'
  if (r.includes('Average volume missing')) return 'avgVolumeMissing'
  if (r.includes('Avg volume') && r.includes('below')) return 'avgVolumeBelowFloor'
  if (r.includes('Sector missing')) return 'sectorMissing'
  if (r.includes('Sector') && r.includes('outside the allowed universe')) return 'sectorNotAllowed'
  if (r.includes('Sector') && r.includes('is excluded')) return 'sectorExcluded'
  if (r.includes('Industry missing')) return 'industryMissing'
  if (r.includes('Industry') && r.includes('outside the allowed universe')) return 'industryNotAllowed'
  if (r.includes('Entry guard')) return 'entryGuard'
  return 'other'
}

/**
 * Zero-signal near-miss diagnostics. Motivated by a past outage where NULL
 * volume_pace on most ticker_metrics rows silently killed every
 * volumePace-gated branch while Gemini scores were healthy — a week of "no
 * signals" with no explanation. Re-evaluates the universe against the user's
 * AST, which preserves scores on invalid results, so a scan that emits
 * nothing explains itself in one structured log line: which branches matched
 * but were suppressed (below minScoreToEmit or failed a gate), which data
 * fields were missing, and how many tickers each universe gate rejected
 * (a gate rejection happens BEFORE branch evaluation, so near-miss counts
 * alone cannot see it).
 * Pure and in-memory; runs only for users whose scan produced zero candidate
 * setups.
 */
export function diagnoseZeroSignalScan(
  typedMetrics: MetricRecord[],
  ast: CustomStrategyAST,
  maxRisk: number,
  riskProfile: string,
) {
  let evaluated = 0
  let volumePaceNull = 0
  let newsScoreNull = 0
  let insiderScoreNull = 0
  const branchCounts: Record<string, number> = {}
  const gateRejects: Record<string, number> = {}
  const nearMisses: Array<{ ticker: string; branch: string; score: number; reason: string }> = []
  for (const data of typedMetrics) {
    if (!data.ticker || MACRO_INDEX_ETFS.has(String(data.ticker).toUpperCase())) {
      continue
    }
    evaluated++
    if (data.volumePace == null) volumePaceNull++
    if (data.newsScore == null) newsScoreNull++
    if (data.insiderScore == null) insiderScoreNull++
    const result = evaluateCustomStrategy(buildScanMarketData(data, maxRisk, riskProfile) as unknown as MarketData, ast)
    if (!result) continue
    const reason = result.reason ?? ''
    if (!result.isValid && reason.startsWith('🚫 Halted:')) {
      const label = gateRejectLabel(reason)
      gateRejects[label] = (gateRejects[label] ?? 0) + 1
      continue
    }
    const score = result.score ?? 0
    if (result.isValid || score <= 0) continue
    const branch = result.firedBranchName ?? 'UNKNOWN_BRANCH'
    branchCounts[branch] = (branchCounts[branch] ?? 0) + 1
    nearMisses.push({
      ticker: String(data.ticker),
      branch,
      score: Number(score.toFixed(2)),
      reason: reason.slice(0, 140),
    })
  }
  nearMisses.sort((a, b) => b.score - a.score)
  return {
    evaluated,
    dataGaps: { volumePaceNull, newsScoreNull, insiderScoreNull },
    universeGateRejects: gateRejects,
    nearMissBranchCounts: branchCounts,
    topNearMisses: nearMisses.slice(0, 5),
  }
}

export function getScanCache(chatId: string): ScanCacheEntry | null {
  const cached = scanCacheMap.get(chatId)
  if (!cached) return null
  if (Date.now() - cached.timestamp > 24 * 60 * 60 * 1000) {
    scanCacheMap.delete(chatId)
    return null
  }
  return cached
}

type TightenExplainEntry = { text: string; timestamp: number }
const tightenExplainMap = new Map<string, TightenExplainEntry>()

/** "Why did they move?" details for the last stop-refresh notification (30-min TTL, per chat). */
export function getLastTightenExplain(chatId: string): string | null {
  const cached = tightenExplainMap.get(chatId)
  if (!cached) return null
  if (Date.now() - cached.timestamp > 30 * 60 * 1000) {
    tightenExplainMap.delete(chatId)
    return null
  }
  return cached.text
}

/**
 * Minimal shape `partitionChatsByGate` needs from a settings row. Keeping it
 * structural (not importing the full Drizzle row type) lets the helper be
 * unit-tested with plain object literals.
 */
export type ChatGateRow = {
  telegramChatId: string | null
  quantourApiKey: string | null
  status: string
}

/**
 * Per-chat API-key hard gate. Splits settings rows into:
 *  - `authorized`: has a chatId, its OWN non-null quantourApiKey, AND
 *    `status === 'approved'`. Only these chats may receive signals.
 *  - `skipped`: everything else with a chatId (no key, key present but not
 *    approved, etc.). The caller sends these a throttled "please /link"
 *    notice so an unlinked chat understands why it stopped getting signals.
 *
 * This closes the cross-user key-leak: previously the scanner picked ANY
 * row's key to fetch metrics and then fanned signals out to every chat with
 * a strategy AST — including chats whose own key was null or invalid.
 */
export function partitionChatsByGate<T extends ChatGateRow>(all: T[]): { authorized: T[]; skipped: T[] } {
  const authorized: T[] = []
  const skipped: T[] = []
  for (const row of all) {
    if (!row.telegramChatId) continue
    if (row.quantourApiKey && row.status === 'approved') {
      authorized.push(row)
    } else {
      skipped.push(row)
    }
  }
  return { authorized, skipped }
}

/**
 * Send a notice to a chat, throttled against the `account_events` table.
 * - `manual: true` bypasses the throttle (the user explicitly invoked a
 *   scan and deserves immediate feedback) but STILL records the event so
 *   the next cron notice within 24h is suppressed.
 * - cron path checks `lastNoticeWithin` first and returns silently if a
 *   recent notice exists.
 * Each successful send records a `notice:<reason>` event, which both
 * updates the throttle window and leaves an audit trail.
 */
async function sendNotice(
  chatId: string, reason: NoticeReason, message: string, opts: { manual?: boolean } = {},
): Promise<void> {
  if (!opts.manual) {
    const suppressed = await lastNoticeWithin(chatId, reason, NOTICE_THROTTLE_MS)
    if (suppressed) return
  }
  try {
    await sendGenericMessage(message, undefined, chatId)
  } catch (err) {
    logger.warn({ error: err, chatId }, '[SCANNER] Notice send failed')
  }
  await recordEvent(chatId,
    reason === 'no_key' ? AccountEventType.NOTICE_NO_KEY : AccountEventType.NOTICE_EXPIRED,
    { detail: opts.manual ? 'manual_scan' : 'cron_scan' })
}

export async function runMasterScanner(options: {
  isManual?: boolean
  summaryTitle?: string
  chatId?: string
  isPowerHour?: boolean
  ticker?: string
} = {}) {
  try {
    const marketOpen = isMarketOpen()
    if (!marketOpen) {
      if (options.isManual && options.chatId) {
        const { t } = await import('@quantour/shared-algo/src/core/i18n')
        const { getChatLanguage } = await import('../services/telegramService')
        const lang = await getChatLanguage(options.chatId)
        const marketClosedNotice = t('MARKET_CLOSED_SCAN_PAUSED', lang)
        await sendGenericMessage(marketClosedNotice, undefined, options.chatId)
      } else {
        logger.info('[SCANNER] Market is closed. Skipping signal scan.')
      }
      return
    }
    const allSettings = options.chatId 
      ? await db.select().from(settings).where(eq(settings.telegramChatId, options.chatId))
      : await db.select().from(settings)

    if (allSettings.length === 0) {
      if (options.isManual && options.chatId) {
        await sendGenericMessage(local('⚠️ No valid Quantour API Key found in settings. Please link your account.'), undefined, options.chatId)
      }
      return
    }

    // Per-chat API-key hard gate. A chat may receive signals only when ITS
    // OWN row has a non-null quantourApiKey and status='approved'. Chats
    // failing the gate get a throttled "please /link" notice; they must NOT
    // borrow another row's key (the prior cross-user leak).
    const { authorized: authorizedChats, skipped: skippedChats } = partitionChatsByGate(allSettings)

    for (const skipped of skippedChats) {
      if (!skipped.telegramChatId) continue
      // Manual scan invoked by this specific chat → reply immediately,
      // bypassing the throttle so the user gets feedback on demand.
      const isManualForThisChat = options.isManual && options.chatId === skipped.telegramChatId
      if (isManualForThisChat || !options.isManual) {
        const { t } = await import('@quantour/shared-algo/src/core/i18n')
        const { getChatLanguage: getLang } = await import('../services/telegramService')
        const lang = await getLang(skipped.telegramChatId)
        await sendNotice(
          skipped.telegramChatId, 'no_key', String(t('SCAN_SKIPPED_NO_KEY', lang)), { manual: isManualForThisChat },
        )
      }
    }

    if (authorizedChats.length === 0) {
      logger.info('[SCANNER] No authorized chats (all rows missing/expired key). Skipping scan.')
      return
    }

    // Fetch metrics using the first authorized chat's own key. Metrics are
    // ticker-level (not user-specific), so any valid key yields the same
    // universe; using an authorized chat's key guarantees it is currently
    // approved. The per-signal POST further down uses each chat's OWN key
    // for correct central-API accounting.
    const apiKey = authorizedChats[0]!.quantourApiKey!

    // Fetch unified market snapshot from Central API
    const { config } = await import('../config')
    const apiUrl = config.API_URL || 'http://localhost:3001'
    const metricsUrl = `${apiUrl}/api/v1/metrics`

    const response = await fetch(metricsUrl, {
      method: 'POST',
      // Full-universe sweeps are rate-limited by FMP (~200 req/min ⇒ ~60s
      // floor for ~200 tickers) and compete with deep-scans/universe-sync for
      // the same budget — 120s timed out on cold/cache-contended paths. 240s
      // keeps the manual /scan UX responsive while degrading to the SQLite
      // fallback only on genuine provider outages.
      signal: AbortSignal.timeout(240000),
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        tickers: options.ticker ? [
          options.ticker,
        ] : [], 
      }),
    }).catch((err) => {
      logger.error({ error: err }, '[SCANNER] Metrics fetch timed out or failed')
      return null
    })

    let metricsData: Record<string, unknown>[] = []

    if (response && response.ok) {
      const resJson = await response.json()
      metricsData = Array.isArray(resJson) ? resJson : (resJson.data || [])
    } else if (response && !response.ok) {
      if (response.status === 429) {
        if (options.isManual && options.chatId) {
          await sendGenericMessage(local('⚠️ Daily API Rate Limit Reached. Your account exceeded the daily request limit for your plan. Please upgrade your API key at https://quantourapi.com or try again tomorrow.'), undefined, options.chatId)
        }
        return
      }
      if (response.status === 402) {
        if (options.isManual && options.chatId) {
          await sendGenericMessage(local('⚠️ Insufficient API credits. Your Quantour API Key balance is 0. Please top up your account at https://quantourapi.com or check balance with /api.'), undefined, options.chatId)
        }
        return
      }
      if (response.status === 401) {
        // The fetching key was rejected mid-cycle — quarantine every chat
        // sharing this key so they stop receiving signals until re-link,
        // and notify once (cron) or immediately (manual).
        const { inArray } = await import('drizzle-orm')
        const { t } = await import('@quantour/shared-algo/src/core/i18n')
        const { getChatLanguage: getLang } = await import('../services/telegramService')
        try {
          await db.update(settings).set({ status: 'pending' }).where(inArray(settings.quantourApiKey, [
            apiKey,
          ]))
        } catch (err) {
          logger.warn({ error: err }, '[SCANNER] Failed to quarantine revoked key chats')
        }
        for (const ac of authorizedChats.filter(c => c.quantourApiKey === apiKey)) {
          if (!ac.telegramChatId) continue
          const lang = await getLang(ac.telegramChatId)
          const msg = String(t('KEY_EXPIRED_RELINK_NOTICE', lang))
          // Record the state transition (audit, not throttled): the chat
          // moved approved→pending, which happens once per revocation.
          await recordEvent(ac.telegramChatId, AccountEventType.KEY_QUARANTINED, { key: apiKey, detail: 'scanner_401' })
          const isManualForThisChat = options.isManual && options.chatId === ac.telegramChatId
          if (isManualForThisChat || !options.isManual) {
            await sendNotice(
              ac.telegramChatId, 'expired', msg, { manual: isManualForThisChat },
            )
          }
        }
        if (options.isManual && options.chatId) {
          await sendGenericMessage(local('⚠️ Invalid or expired Quantour API Key. Please re-link your account using /link <API_KEY>.'), undefined, options.chatId)
        }
        return
      }
    }

    // Fallback if API returned null or timed out
    if (!Array.isArray(metricsData) || metricsData.length === 0) {
      logger.info('[SCANNER] Metrics fetch unavailable or timed out. Fetching fallback metrics from database...')
      const { dailyMetricsHistory } = await import('../db/clientSchema')
      const { desc } = await import('drizzle-orm')
      const cached = await db.select().from(dailyMetricsHistory).orderBy(desc(dailyMetricsHistory.createdAt)).limit(100)
      metricsData = cached.map((c): Record<string, unknown> => {
        if (c.rawMetricsJson) {
          try {
            return JSON.parse(c.rawMetricsJson) as Record<string, unknown>
          } catch {
            // fall through to degraded shape
          }
        }
        return {
          ticker: c.ticker,
          price: parseFloat(c.price) || 0,
          score: c.score ? parseFloat(c.score) : null,
          sentimentScore: c.sentimentScore ? parseFloat(c.sentimentScore) : null,
          macroScore: c.macroScore ? parseFloat(c.macroScore) : null,
          peRatio: c.peRatio ? parseFloat(c.peRatio) : null,
        }
      })

      if (metricsData.length > 0 && options.isManual && options.chatId) {
        const { t } = await import('@quantour/shared-algo/src/core/i18n')
        const { getChatLanguage } = await import('../services/telegramService')
        const lang = await getChatLanguage(options.chatId)
        const fallbackNotice = `⚠️ ${t('MARKET_DATA_FALLBACK_NOTICE', lang)}`
        await sendGenericMessage(fallbackNotice, undefined, options.chatId)
      }
    }

    if (!Array.isArray(metricsData) || metricsData.length === 0) {
      if (options.isManual && options.chatId) {
        await sendGenericMessage(local('⚠️ Market data provider is currently offline and no cached metrics were found. Please try again shortly.'), undefined, options.chatId)
      }
      return
    }

    // Save everyday metrics & scores for quantitative backtesting
    const todayStr = new Date().toISOString().split('T')[0]
    if (Array.isArray(metricsData) && metricsData.length > 0) {
      const { dailyMetricsHistory } = await import('../db/clientSchema')
      for (const m of metricsData) {
        if (!m.ticker || !m.price) continue
        try {
          await db.insert(dailyMetricsHistory).values({
            ticker: String(m.ticker).toUpperCase(),
            date: todayStr,
            price: String(m.price),
            volume: m.volume ? String(m.volume) : null,
            marketCap: m.marketCap ? String(m.marketCap) : null,
            peRatio: m.peRatio ? String(m.peRatio) : null,
            psRatio: m.psRatio ? String(m.psRatio) : null,
            score: m.score ? String(m.score) : null,
            sentimentScore: m.sentimentScore ? String(m.sentimentScore) : null,
            macroScore: m.macroScore ? String(m.macroScore) : null,
            rawMetricsJson: JSON.stringify(m),
            createdAt: new Date(),
          })
        } catch {
          // Ignore duplicate daily metrics inserts
        }
      }
    }

    // Validate the metric records through the Zod schema. Invalid records
    // (missing ticker/price, malformed) are dropped to preserve the scanner's
    // graceful-degradation behaviour rather than aborting the whole scan.
    const typedMetrics: MetricRecord[] = metricsData.flatMap((m) => {
      const parsed = MetricRecordSchema.safeParse(m)
      return parsed.success ? [
        parsed.data,
      ] : []
    })

    // Keep track of sent signals to prevent spam in cron mode
    // We will just use a simple in-memory cache
    const now = Date.now()
    if (!global.sentSignalsCache) {
      global.sentSignalsCache = new Map<string, SentSignalRecord>()
    }
    
    // Clear old cache (> 24 hours)
    for (const [
      key,
      record,
    ] of global.sentSignalsCache.entries()) {
      if (now - record.timestamp > 24 * 60 * 60 * 1000) {
        global.sentSignalsCache.delete(key)
      }
    }

    let signalsSent = 0
    const matchedSetups: Array<{ ticker: string; entry: number; stopLoss: number; target: number; shares: number }> = []
    for (const user of authorizedChats) {
      if (!user.telegramChatId) continue

      let ast = null
      if (user.mainStrategyAst && user.mainStrategyAst.startsWith('{')) {
        try {
          ast = JSON.parse(user.mainStrategyAst)
        } catch (e) {
          logger.error({ error: e, chatId: user.telegramChatId }, 'Failed to parse AST')
        }
      }

      if (!ast) {
        if (options.isManual && options.chatId === user.telegramChatId) {
          await sendGenericMessage(local('⚠️ No strategy configured. Please select or create a strategy AST in settings.'), undefined, user.telegramChatId)
        }
        continue
      }

      let candidateSetups: Array<{ setup: SetupResult; data: MetricRecord; payload: ScanSignalPayload }> = []
      const budget = await getUserBudget(db, user.userId)
      const vetoEvents: ReturnType<typeof detectRotationVetoBlocks> = []

      for (const data of typedMetrics) {
        if (!data.ticker || MACRO_INDEX_ETFS.has(String(data.ticker).toUpperCase())) {
          continue
        }

        const marketData = buildScanMarketData(data, budget.maxRiskPerTradeUsd, user.riskProfile)

        const setups = evaluateSetup(marketData as unknown as MarketData, { custom: ast as CustomStrategyAST })

        // ROTATION GATE INSTRUMENTATION (rotation_conviction_v1): attribute
        // momentum candidates whose technical arms matched but a rank/trend/
        // freshness gate blocked them. Events carry priceAtSignal for the
        // later counterfactual join. Fire-and-collect — never affects the
        // scan itself.
        try {
          vetoEvents.push(...detectRotationVetoBlocks(ast as CustomStrategyAST, marketData as unknown as MarketData))
        } catch (err) {
          logger.debug({ error: err, ticker: data.ticker }, '[SCAN] rotation-gate detection failed (non-fatal)')
        }

        for (const setup of setups) {
          if (setup.isValid || (setup.score && setup.score >= 0.3)) {
            if (data.liquidationThreat && !options.isManual) {
              logger.warn({ ticker: data.ticker, threat: data.liquidationThreat }, '[SCAN] Pausing automated signal due to active Systemic Liquidation Threat')
              continue
            }

            const cacheKey = `${user.telegramChatId}:${data.ticker.toUpperCase()}`
            if (!options.isManual && global.sentSignalsCache.has(cacheKey)) {
              const cached = global.sentSignalsCache.get(cacheKey)!
              // 24h suppression window (was 4h): one alert per
              // ticker per trading day unless genuinely new information
              // arrives — a different branch fires, or the tape moved >5%
              // (was 3%; the >+5% band is where the quality harness measured
              // re-alerts chasing weak extensions — hypothesis #12).
              const isExpired = Date.now() - cached.timestamp > 24 * 60 * 60 * 1000
              const isBranchUpgrade = setup.firedBranchName && setup.firedBranchName !== cached.branchName
              const isPriceMoved = cached.price > 0 && Math.abs(data.price - cached.price) / cached.price > 0.05

              if (!isExpired && !isBranchUpgrade && !isPriceMoved) {
                logger.info({ ticker: data.ticker, chatId: user.telegramChatId }, '[SCAN] Suppressing duplicate signal for ticker sent earlier today')
                continue
              }
            }

            const payload = {
              ticker: data.ticker,
              strategyName: setup.strategyName,
              minHoldingDays: setup.minHoldingDays,
              entry: setup.entry || data.price,
              stopLoss: setup.stopLoss || 0,
              target: setup.target || 0,
              breakEvenPrice: setup.breakEvenPrice,
              shares: setup.shares,
              capitalRequired: setup.capitalRequired,
              rsi: data.rsi || 0,
              relativeStrength: data.relativeStrength,
              volumeChange: data.volumePace,
              marketStatus: data.marketStatus,
              sectorName: data.sectorName,
              latestEarnings: data.latestEarnings,
              nextEarnings: data.nextEarnings,
              analystTarget: data.analystTarget,
              atr: data.atr || 0,
              sma50: data.sma50,
              sma200: data.sma200,
              rrRatio: setup.rrRatio,
              estimatedHoldingDays: setup.estimatedHoldingDays,
              efficiencyRPerDay: setup.rrRatio && setup.estimatedHoldingDays && setup.estimatedHoldingDays > 0
                ? Number((setup.rrRatio / setup.estimatedHoldingDays).toFixed(2))
                : undefined,
              fcfInflection: data.fcfInflection,
              firedBranchName: setup.firedBranchName,
              score: setup.score,
              riskProfile: setup.riskProfile,
              expectedRPerDay: setup.expectedRPerDay,
            }

            candidateSetups.push({ setup, data, payload })
          }
        }
      }

      // ROTATION GATE INSTRUMENTATION (rotation_conviction_v1): ship the
      // collected veto events to the central store once per scan (batched,
      // fail-soft — instrumentation must never break the scan).
      if (vetoEvents.length > 0) {
        try {
          await fetch(`${apiUrl}/api/v1/market/rotation-gates`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              events: vetoEvents.map(e => ({
                ...e,
                chatId: user.telegramChatId || undefined,
              })),
            }),
            signal: AbortSignal.timeout(15_000),
          })
        } catch (err) {
          logger.warn({ error: err, count: vetoEvents.length }, '[SCAN] rotation-gate event POST failed (non-fatal)')
        }
        logger.info({ count: vetoEvents.length, sample: vetoEvents.slice(0, 3) }, '[ROTATION_VETO] gates blocked momentum candidates this scan')
      }

      // Sort candidate setups by score descending (highest conviction first), then relativeStrength, then volumePace
      candidateSetups.sort((a, b) => {
        const scoreDiff = (b.setup.score || 0) - (a.setup.score || 0)
        if (Math.abs(scoreDiff) > 0.001) return scoreDiff

        const rsDiff = (b.data.relativeStrength || 0) - (a.data.relativeStrength || 0)
        if (Math.abs(rsDiff) > 0.001) return rsDiff

        return (b.data.volumePace || 0) - (a.data.volumePace || 0)
      })

      // AST-driven consumer-layer grouping: continuous diversification dial (signalAggressiveness)
      // + hard maxTotalSignals ceiling. Central engine emits raw; client_api shapes for the user.
      candidateSetups = applySignalGrouping(candidateSetups, ast as CustomStrategyAST | null)

      // Zero-signal scans must explain themselves: near-miss branches (matched
      // but suppressed) + missing-data counts, one structured log line. Pure
      // re-evaluation against the same builder used by the emission loop.
      if (candidateSetups.length === 0) {
        logger.info({
          chatId: user.telegramChatId,
          ...diagnoseZeroSignalScan(
            typedMetrics, ast as CustomStrategyAST, budget.maxRiskPerTradeUsd, user.riskProfile,
          ),
        }, '[SCAN] Zero-signal diagnostics')
      }

      for (let i = 0; i < candidateSetups.length; i++) {
        const { data, payload } = candidateSetups[i]!
        const cacheKey = `${user.telegramChatId}:${data.ticker.toUpperCase()}`

        signalsSent++
        global.sentSignalsCache.set(cacheKey, {
          timestamp: Date.now(),
          price: data.price,
          branchName: candidateSetups[i]?.setup.firedBranchName,
        })

        if (!matchedSetups.find(s => s.ticker === data.ticker)) {
          matchedSetups.push({
            ticker: data.ticker,
            entry: payload.entry,
            stopLoss: payload.stopLoss,
            target: payload.target,
            shares: payload.shares || 0,
          })
        }

        try {
          await fetch(`${apiUrl}/api/v1/market/signals`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${user.quantourApiKey}`,
            },
            body: JSON.stringify(payload),
          })
        } catch (err) {
          logger.error({ error: err }, '[SCAN] Failed to push signal to central API')
        }
      }

      const isSilentAutomated = !options.isManual && user.signalMode === 'silent'
      if (user.telegramChatId && candidateSetups.length > 0 && !isSilentAutomated) {
        const { getChatLanguage } = await import('../services/telegramService')
        const { t, translateBranchName, BRANCH_NAME_PATTERNS } = await import('@quantour/shared-algo/src/core/i18n')
        const lang = await getChatLanguage(user.telegramChatId)
        // Branch icons live in the CALLER (i18n-emoji rule: translation values
        // carry no emoji), keyed off the same pattern table as the translator.
        const BRANCH_EMOJI: Record<string, string> = {
          'High AI Conviction & Early Reclaim': '🔮',
          'Bullish AI News Trend': '🔥',
          'Insider Buying Dip Reversal': '🏛️',
          'AI Macro Narrative Sector Breakout': '🚀',
          'Market Overreaction & Fundamental Rebound': '💎',
          'Technical Mean Reversion Dip Buy': '🔄',
          'Institutional Technical': '📈',
          'Confluence': '📈',
        }

        // 1. Pre-build Top 5 setups
        const topSetups = candidateSetups.slice(0, 5)

        const top5List = topSetups.map((s, idx) => {
          const payload = s.payload
          // Prefer the pre-computed payload.rrRatio (single source of truth from
          // evaluateCustomStrategy); fall back to inline recomputation only for
          // legacy/non-custom setups that don't populate the field.
          const rr = payload.rrRatio !== undefined
            ? payload.rrRatio.toFixed(1)
            : (payload.stopLoss > 0 ? ((payload.target - payload.entry) / (payload.entry - payload.stopLoss)).toFixed(1) : 'N/A')
          const rawBranchName = s.setup.firedBranchName || ''
          const matchedBranchPattern = BRANCH_NAME_PATTERNS.find(([pattern]) => rawBranchName.includes(pattern))
          const branchEmoji = matchedBranchPattern ? BRANCH_EMOJI[matchedBranchPattern[0]] ?? '' : ''
          const branchTitle = `${branchEmoji}${branchEmoji ? ' ' : ''}${translateBranchName(rawBranchName, lang)}`.trimEnd()
          const branchLabel = t('STRATEGY_BRANCH_LABEL', lang)
          const entryLabel = t('LABEL_ENTRY', lang)
          const slLabel = t('LABEL_SL', lang)
          const tpLabel = t('LABEL_TP', lang)
          const sharesLabel = t('LABEL_SHARES', lang)
          const tfLabel = t('LABEL_TIMEFRAME_HORIZON', lang)
          // Dynamic per-trade horizon (ER×ATR estimate) when available; fall
          // back to the static AST branch label for legacy paths.
          const tfVal = payload.estimatedHoldingDays !== undefined
            ? t('ESTIMATED_HORIZON_DAYS', lang, { days: String(payload.estimatedHoldingDays) })
            : (s.setup.timeframeHorizon || getBranchTimeframeHorizon(s.setup.riskProfile || 'MOMENTUM', lang))
          const efficiencyLine = payload.efficiencyRPerDay !== undefined
            ? `  ⚡ <b>${t('LABEL_EFFICIENCY', lang)}:</b> ${t('EFFICIENCY_R_PER_DAY', lang, { rPerDay: payload.efficiencyRPerDay.toFixed(2) })}`
            : ''
          const branchLine = branchTitle ? `  🏷️ <b>${branchLabel}:</b> ${branchTitle}` : ''
          return [
            `• <code>/scan ${payload.ticker}</code> — <b>${payload.ticker}</b> (#${idx + 1})`,
            branchLine ? `${branchLine}` : '',
            `  💰 ${entryLabel}: <b>$${payload.entry.toFixed(2)}</b>  🛑 ${slLabel}: <b>$${payload.stopLoss.toFixed(2)}</b>  🎯 ${tpLabel}: <b>$${payload.target.toFixed(2)}</b>`,
            `  📦 ${sharesLabel}: <b>${payload.shares || 0}</b>  ⚖️ R:R <b>1:${rr}</b>  ⏱️ <b>${tfLabel}:</b> ${tfVal}`,
            efficiencyLine,
          ].filter(Boolean).join('\n')
        }).join('\n\n')

        const userCash = await getAvailableCash(user.telegramChatId)
        let cashNotice = ''
        if (userCash > 500) {
          cashNotice = `\n💵 <b>${t('UNALLOCATED_CASH', lang)}: $${userCash.toLocaleString()}</b>`
        }

        const headerText = !options.isManual && signalsSent > 0
          ? t('NEW_SETUPS_ALERT_HEADER', lang)
          : t('SCAN_COMPLETE', lang)

        const top5Text = `${headerText} (${candidateSetups.length} ${t('LABEL_FOUND', lang)})${cashNotice}\n\n${top5List}`

        // 2. Pre-build All Setups List
        const allList = candidateSetups.map((s, idx) => {
          const payload = s.payload
          const rr = payload.rrRatio !== undefined
            ? payload.rrRatio.toFixed(1)
            : (payload.stopLoss > 0 ? ((payload.target - payload.entry) / (payload.entry - payload.stopLoss)).toFixed(1) : 'N/A')
          const entryLabel = t('LABEL_ENTRY', lang)
          const slLabel = t('LABEL_SL', lang)
          const tpLabel = t('LABEL_TP', lang)
          const sharesLabel = t('LABEL_SHARES', lang)
          return [
            `• <code>/scan ${payload.ticker}</code> — <b>${payload.ticker}</b> (${idx + 1}/${candidateSetups.length})`,
            `  💰 ${entryLabel}: <b>$${payload.entry.toFixed(2)}</b>  🛑 ${slLabel}: <b>$${payload.stopLoss.toFixed(2)}</b>  🎯 ${tpLabel}: <b>$${payload.target.toFixed(2)}</b>`,
            `  📦 ${sharesLabel}: <b>${payload.shares || 0}</b>  ⚖️ R:R <b>1:${rr}</b>`,
          ].join('\n')
        }).join('\n\n')

        const allText = `📊 <b>${t('ALL_SCAN_SETUPS_TITLE', lang)}</b> (${candidateSetups.length})\n\n${allList}`

        // 3. Pre-build Sector View
        const sectorMap = new Map<string, typeof candidateSetups>()
        for (const item of candidateSetups) {
          const sec = item.data.sectorName || 'Other'
          if (!sectorMap.has(sec)) sectorMap.set(sec, [])
          sectorMap.get(sec)!.push(item)
        }
        const sectorBlocks: string[] = []
        for (const [
          sec,
          items,
        ] of sectorMap.entries()) {
          const header = `📁 <b>${sec.toUpperCase()}</b> (${items.length})`
          const lines = items.map(it => `• <code>/scan ${it.payload.ticker}</code> — <b>${it.payload.ticker}</b> ($${it.payload.entry.toFixed(2)})`).join('\n')
          sectorBlocks.push(`${header}\n${lines}`)
        }
        const sectorText = `📁 <b>${t('SETUPS_BY_SECTOR_TITLE', lang)}</b>\n\n${sectorBlocks.join('\n\n')}`

        // 4. Pre-build Catalyst View
        const catalystMap = new Map<string, typeof candidateSetups>()
        for (const item of candidateSetups) {
          let catKey = '🚀 LAGGING MOMENTUM'
          if (item.data.fcfInflection && item.data.fcfInflection === 'POSITIVE') {
            catKey = '💎 FCF INFLECTION'
          } else if (item.data.macroExposures && item.data.macroExposures.length > 0) {
            catKey = '🌍 MACRO NARRATIVE'
          }
          if (!catalystMap.has(catKey)) catalystMap.set(catKey, [])
          catalystMap.get(catKey)!.push(item)
        }
        const catalystBlocks: string[] = []
        for (const [
          cat,
          items,
        ] of catalystMap.entries()) {
          const header = `<b>${cat}</b> (${items.length})`
          const lines = items.map(it => `• <code>/scan ${it.payload.ticker}</code> — <b>${it.payload.ticker}</b> ($${it.payload.entry.toFixed(2)})`).join('\n')
          catalystBlocks.push(`${header}\n${lines}`)
        }
        const catalystText = `🚀 <b>${t('SETUPS_BY_CATALYST_TITLE', lang)}</b>\n\n${catalystBlocks.join('\n\n')}`

        // Store in cache for instant callback query responses and rotation optimizer
        scanCacheMap.set(user.telegramChatId, {
          timestamp: Date.now(),
          totalCount: candidateSetups.length,
          top5Text,
          allText,
          sectorText,
          catalystText,
          setups: candidateSetups.map(s => ({
            ticker: s.payload.ticker,
            entry: s.payload.entry,
            target: s.payload.target,
            stopLoss: s.payload.stopLoss,
            strategy: s.setup.firedBranchName || 'QUANT_SIGNAL',
            sectorName: s.data.sectorName,
            isRsLeader: (s.data.relativeStrength || 0) > 1.25,
            // Thread EV/day + firedBranchName so the rotation ranker can honor
            // rotationScoring:'ev' when the AST declares it. Without these,
            // /optimize falls back to OpportunityScore even on EV-configured ASTs.
            expectedRPerDay: s.payload.efficiencyRPerDay ?? s.setup.expectedRPerDay,
            firedBranchName: s.setup.firedBranchName,
          })),
        })

        // Tighten stops on HELD positions that received a fresh signal
        // (tighten-only: never lowers risk). STRATEGY-GATED: only runs when the
        // user's AST sets riskManagement.enableSignalStopRefresh — otherwise
        // this would silently re-manage open positions in ways the strategy
        // never declared. Runs after the scanCache is populated so the cached
        // setups (used by handlePortfolioAdd too) are already current. One
        // aggregated notification per scan tick.
        if (ast?.riskManagement?.enableSignalStopRefresh === true) {
          try {
            const tightenSetups = candidateSetups.map(s => ({
              ticker: s.payload.ticker,
              entry: s.payload.entry,
              stopLoss: s.payload.stopLoss,
              target: s.payload.target,
              atr: s.payload.atr ?? s.data.atr,
              firedBranchName: s.setup.firedBranchName,
            }))
            const tightened = await tightenHeldPositionStops(user.telegramChatId, tightenSetups)
            if (tightened.length > 0) {
              const lines = tightened.map(r => {
                const parts: string[] = []
                if (r.newStop > r.oldStop) parts.push(t('STOP_REFRESHED_STOP', lang, { old: r.oldStop.toFixed(2), new: r.newStop.toFixed(2) }))
                if (r.newTarget > r.oldTarget) parts.push(t('STOP_REFRESHED_TARGET', lang, { new: r.newTarget.toFixed(2) }))
                if (r.atrRefreshed) parts.push('ATR↻')
                if (r.branchReanchored) parts.push('thesis↻')
                return `• <b>${r.ticker}</b>: ${parts.join(' · ')}`
              })
              const explainBody = tightened.map(r => {
                const setup = tightenSetups.find(s => s.ticker.toUpperCase() === r.ticker.toUpperCase())
                const atr = setup?.atr
                return t('STOP_WHY_ITEM', lang, {
                  ticker: r.ticker,
                  branch: setup?.firedBranchName ?? '—',
                  old: r.oldStop.toFixed(2),
                  new: r.newStop.toFixed(2),
                  target: Math.max(r.oldTarget, r.newTarget).toFixed(2),
                  atr: atr != null && Number.isFinite(atr) && atr > 0 ? atr.toFixed(2) : '—',
                })
              }).join('\n\n')
              tightenExplainMap.set(user.telegramChatId, {
                text: `<b>${t('STOP_WHY_TITLE', lang)}</b>\n${t('STOP_WHY_INTRO', lang)}\n\n${explainBody}`,
                timestamp: Date.now(),
              })
              await sendGenericMessage(
                `🔒 <b>${t('STOP_REFRESHED_TITLE', lang)}</b>\n${lines.join('\n')}`,
                { inline_keyboard: [[{ text: `❓ ${t('BTN_STOPS_WHY', lang)}`, callback_data: 'stops_why' }]] },
                user.telegramChatId,
              )
            }
          } catch (err) {
            logger.error({ error: err, chatId: user.telegramChatId }, '[SCAN] tightenHeldPositionStops failed')
          }
        }

        // "Show All" is redundant when the top-list already carries every
        // candidate (<=5): the main message shows slice(0,5) in FULL detail.
        const inline_keyboard = [
          [
            ...(candidateSetups.length > 5
              ? [
                { text: `📊 ${t('BTN_SCAN_SHOW_ALL', lang, { count: String(candidateSetups.length) })}`, callback_data: 'scan_view:all' },
              ]
              : []),
            { text: `📁 ${t('BTN_SCAN_BY_SECTOR', lang)}`, callback_data: 'scan_view:sector' },
            { text: `🚀 ${t('BTN_SCAN_BY_CATALYST', lang)}`, callback_data: 'scan_view:catalyst' },
          ],
        ]

        await sendGenericMessage(top5Text, { inline_keyboard }, user.telegramChatId)
      }
    }

    if (options.isManual && options.chatId && signalsSent === 0) {
      const { getChatLanguage } = await import('../services/telegramService')
      const { t } = await import('@quantour/shared-algo/src/core/i18n')
      const lang = await getChatLanguage(options.chatId)
      const targetTicker = options.ticker || 'Watchlist'
      await sendGenericMessage(t('NO_SIGNAL_WEAK_TECHNICALS', lang, { ticker: targetTicker }), undefined, options.chatId)
    }
  } catch (err) {
    logger.error({ error: err }, 'clientScanner failed')
    if (options.isManual && options.chatId) {
      const errMsg = err instanceof Error ? err.message : String(err)
      await sendGenericMessage(local(`⚠️ <b>Scanner Error:</b> ${errMsg}\n<i>Check server logs via SSH or contact support if issue persists.</i>`), undefined, options.chatId)
    }
  }
}
