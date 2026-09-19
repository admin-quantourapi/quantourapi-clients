import {
  Language, local, t,
} from '@quantour/shared-algo/src/core/i18n'
import type { RotationRules } from '@quantour/shared-algo/src/finance-algo/ast'
import {
  calculateATR, computeStopsFromAtr, DEFAULT_ATR_PERIOD,
} from '@quantour/shared-algo/src/finance-algo/atr'
import type { RotationAsset, RotationResult } from '@quantour/shared-algo/src/finance-algo/screener'
import {
  formatRotationResult, recommendPortfolioRotations,
} from '@quantour/shared-algo/src/finance-algo/screener'
import {
  parseStructuralThesis, type StructuralThesisSnapshot,
  structuralThesisVerdict, 
} from '@quantour/shared-algo/src/finance-algo/structuralThesis'
import {
  and, desc, eq, inArray, lt, or,
} from 'drizzle-orm'
import { z } from 'zod'

import { db as localDb } from '~/db'
import {
  customStrategies, pnlHistory, portfolioStats, settings, tradeAuditLog, trades,
} from '~/db/clientSchema'
import type { DashboardScope } from '~/server/dashboardIdentity'
import { fetchFromApi } from '~/services/apiClient'
import { logger } from '~/services/logger'
import { fetchPutCallRatio } from '~/services/optionsSentimentService'
import { getChatLanguage } from '~/services/telegramService'
import {
  sendGenericMessage,
} from '~/services/telegramService'

import {
  getUserBudget, setUserBudget,
} from '../budgetService'

// In-memory cache: stores last optimize result per scope (1 entry per
// account = userId, or per set of chatIds when userId is absent).
// Cache key includes a build identifier (commit hash from env, or process
// start time as fallback) so stale entries from a prior deploy can never be
// served after a container restart.
const CACHE_BUILD = process.env.COMMIT_HASH || `t${Date.now()}`
const optimizeCache = new Map<string, {
  concise: string
  detailed: string
  rotationResult?: RotationResult
}>()

/**
 * Scope-based cache key. userId is preferred (one account = one entry,
 * shared across all chats/devices on that key). Falls back to a joined
 * chatIds key for legacy rows lacking userId. The dashboard scope
 * (instance row → key → userId) and the telegram scope (chatId → its
 * userId) both hash to the same key when they share the key — so an
 * optimize triggered from one surface can be applied from the other.
 */
function scopeCacheKey(scope: DashboardScope): string {
  const id = scope.userId
    ? `user:${scope.userId}`
    : `chats:${scope.chatIds.length > 0 ? scope.chatIds.join(',') : '_empty_'}`
  return `${id}:${CACHE_BUILD}`
}

// --- Permissive response schemas (passthrough + optional): typed + runtime-
// validated via Zod without over-constraining cloud shapes. Mismatches throw
// ZodError; helpers degrade to null/[] via .catch so existing null-checks hold. ---
const QuoteSchema = z.object({
  symbol: z.string().optional(),
  price: z.coerce.number().optional(),
  changesPercentage: z.coerce.number().optional(),
  marketCap: z.coerce.number().optional(),
  name: z.string().optional(),
  sector: z.string().optional(),
  dayLow: z.coerce.number().optional(),
  dayHigh: z.coerce.number().optional(),
}).passthrough()

const QuotesListSchema = z.array(QuoteSchema)

const HistoricalCandleSchema = z.object({
  date: z.string().optional(),
  open: z.coerce.number(),
  high: z.coerce.number(),
  low: z.coerce.number(),
  close: z.coerce.number(),
  volume: z.coerce.number().optional(),
}).passthrough()

/** Bulk historical envelope: { success?, data: { TICKER: candle[] } }. */
const HistoricalBulkSchema = z.object({
  success: z.boolean().optional(),
  data: z.record(z.string(), z.array(HistoricalCandleSchema)).optional(),
}).passthrough()

const TickerInfoEnvelopeSchema = z.object({
  success: z.boolean().optional(),
  data: z.object({
    ticker: z.object({
      sector: z.string().optional(),
      companyName: z.string().optional(),
    }).passthrough().optional(),
    quote: QuoteSchema.optional(),
  }).passthrough().optional(),
}).passthrough()

const TickersListSchema = z.object({
  success: z.boolean().optional(),
  data: z.array(z.object({
    ticker: z.string(),
    lastPrice: z.coerce.number().optional(),
  }).passthrough()).optional(),
}).passthrough()

// Live-quote TTL cache (60s). Buy gating / scan alerts call getQuotesBatch on
// hot paths; without a cache every trade would hammer the quote endpoint. The
// dashboard's deployed-at-market-value computation shares the same cache.
const QUOTE_CACHE_TTL_MS = 60_000
const quoteCache = new Map<string, { price: number; ts: number }>()

/** Test hook — clears the quote TTL cache (isolation between test cases). */
export function clearQuoteCache(): void {
  quoteCache.clear()
}

async function getQuotesBatch(tickers: string[], chatId?: string) {
  if (tickers.length === 0) return []

  const now = Date.now()
  const resolved = new Map<string, { symbol: string; price: number; dayLow?: number; dayHigh?: number }>()
  const missing: string[] = []
  for (const t of tickers) {
    const cached = quoteCache.get(t)
    if (cached && now - cached.ts < QUOTE_CACHE_TTL_MS) {
      resolved.set(t, { symbol: t, price: cached.price })
    } else {
      missing.push(t)
    }
  }

  if (missing.length > 0) {
    const quotes = await fetchFromApi(
      `/market/quotes?symbols=${encodeURIComponent(missing.join(','))}`, QuotesListSchema, {}, chatId,
    ).catch(() => null)

    if (Array.isArray(quotes) && quotes.length > 0) {
      for (const q of quotes) {
        if (q.symbol && q.price && q.price > 0) {
          quoteCache.set(q.symbol, { price: q.price, ts: now })
          resolved.set(q.symbol, {
            symbol: q.symbol, price: q.price, dayLow: q.dayLow, dayHigh: q.dayHigh, 
          })
        }
      }
    } else {
      // Fallback: fetch individual quotes for each missing ticker
      const individualQuotes = await Promise.all(missing.map(async (t) => {
        const q = await getQuote(t, chatId)
        if (q && q.price && q.price > 0) {
          quoteCache.set(t, { price: q.price, ts: now })
          return { symbol: q.symbol || t, price: q.price }
        }
        return null
      }))
      for (const q of individualQuotes) {
        if (q) resolved.set(q.symbol, q)
      }
    }
  }

  return [
    ...resolved.values(),
  ].filter((q): q is { symbol: string; price: number; dayLow?: number; dayHigh?: number } => Boolean(q.symbol && q.price && q.price > 0))
}

async function getQuote(ticker: string, chatId?: string) {
  return await fetchFromApi(
    `/market/quote/${ticker}`, QuoteSchema, {}, chatId,
  ).catch(() => null)
}

async function getTickerInfo(ticker: string, chatId?: string) {
  return await fetchFromApi(
    `/market/profile/${ticker}`, QuoteSchema, {}, chatId,
  ).catch(() => null)
}

async function getPutCallRatioData(ticker: string) {
  try {
    return await fetchPutCallRatio(ticker)
  } catch {
    return null
  }
}

async function getHistorical(ticker: string, days: number = 30, chatId?: string) {
  // Public API serves the BULK endpoint at /v1/market/historical?symbols=&days=
  // (the per-symbol /v1/market/historical/:symbol route does NOT exist on the
  // public-api — the old URL 404'd in production, which is why candle-based
  // ATR stops never engaged and the entry-$2.50 fallback kept firing).
  const hist = await fetchFromApi(
    `/market/historical?symbols=${encodeURIComponent(ticker)}&days=${days}`,
    HistoricalBulkSchema,
    {},
    chatId,
  ).catch(() => null)
  const candles = hist?.data?.[ticker.toUpperCase()]
  return Array.isArray(candles) ? candles : []
}

export interface SignalOverride {
  entry?: number
  stopLoss?: number
  target?: number
  atr?: number
  strategy?: string
  firedBranchName?: string
}

export interface ResolvedStops {
  fillPrice: number
  stopLoss: number
  target: number
  partialTarget: number
  risk: number
  atr: number
  strategy: string
  firedBranchName?: string
}

/**
 * Resolve a safe stop-loss / take-profit for a new position.
 *
 * Priority:
 *  1. Explicit signal stop (override from optimizer payload, or same-day scanCache).
 *  2. Wilder ATR(14) from historical candles -> 2.5x stop, 1:3 R target.
 *  3. If neither is usable -> return null so the caller REJECTS the trade
 *     (per the Strict Financial & Price Safety Mandate: never emit a dummy
 *     stop. The prior `atr = ... : 1` fallback produced `entry - $2.50`
 *     stops that tripped instantly on bid/ask spread).
 *
 * `atr` is always derived (override > candles) so the persisted atr column
 * stays valid for chandelier trailing-stop math.
 */
async function resolvePositionStops(
  ticker: string,
  quotePrice: number,
  chatId: string,
  override?: SignalOverride,
  defaultStrategy: string = 'MANUAL_ADD',
): Promise<ResolvedStops | null> {
  const { getScanCache } = await import('../clientScanner')
  const signalSetup = getScanCache(chatId)?.setups?.find(s => s.ticker === ticker)

  const fillPrice = override?.entry ?? signalSetup?.entry ?? quotePrice
  if (!Number.isFinite(fillPrice) || fillPrice <= 0) return null

  const explicitStop = override?.stopLoss ?? signalSetup?.stopLoss
  const hasExplicitStop = typeof explicitStop === 'number'
    && Number.isFinite(explicitStop) && explicitStop > 0 && explicitStop < fillPrice

  let atr = (typeof override?.atr === 'number' && override.atr > 0) ? override.atr : 0
  if (atr === 0) {
    const candles = await getHistorical(ticker, 30, chatId)
    atr = calculateATR(candles, DEFAULT_ATR_PERIOD)
  }

  const strategy = override?.strategy ?? signalSetup?.strategy ?? defaultStrategy
  const firedBranchName = override?.firedBranchName ?? signalSetup?.firedBranchName

  if (hasExplicitStop) {
    const stopLoss = explicitStop as number
    const risk = fillPrice - stopLoss
    const target = override?.target ?? signalSetup?.target ?? (fillPrice + risk * 3)
    return {
      fillPrice, stopLoss, risk, target, partialTarget: fillPrice + risk * 2, atr, strategy, firedBranchName,
    }
  }

  if (atr > 0) {
    const stops = computeStopsFromAtr(fillPrice, atr)
    return {
      fillPrice,
      stopLoss: stops.stopLoss,
      risk: stops.risk,
      target: stops.target,
      partialTarget: stops.partialTarget,
      atr: stops.atr,
      strategy,
      firedBranchName,
    }
  }

  return null
}


async function ensurePortfolioInitialized(chatId: string) {
  let chat = (await localDb.select().from(settings).where(eq(settings.telegramChatId, chatId)).limit(1))[0]
  if (!chat) {
    await localDb.insert(settings).values({
      telegramChatId: chatId,
      userId: chatId,
      status: 'pending',
    })
    chat = (await localDb.select().from(settings).where(eq(settings.telegramChatId, chatId)).limit(1))[0]
  } else if (!chat.userId) {
    await localDb.update(settings).set({ userId: chatId }).where(eq(settings.id, chat.id))
    chat.userId = chatId
  }
  
  const resolvedUserId = chat?.userId || chatId
  const existing = await localDb.select().from(portfolioStats).where(or(eq(portfolioStats.chatId, chatId), eq(portfolioStats.userId, resolvedUserId))).limit(1)
  if (existing.length === 0) {
    const budget = await getUserBudget(localDb, chat?.userId)
    const initial = budget.totalCapital
    await localDb.insert(portfolioStats).values({
      chatId,
      userId: resolvedUserId,
      initialCapital: initial,
      currentCapital: initial,
      dailyStartingCapital: initial,
      weeklyStartingCapital: initial,
      monthlyStartingCapital: initial,
    })
  } else if (!existing[0].userId) {
    await localDb.update(portfolioStats).set({ userId: resolvedUserId }).where(eq(portfolioStats.id, existing[0].id))
  }
}

/**
 * Load the tracked stocks for ONE account. Scope = chatId OR userId OR any
 * account chatId — the account chatIds come from getAccountScopeByKey (all
 * devices/chats sharing the same quantourApiKey see one portfolio).
 */
export async function loadTrackedStocks(chatId?: string, userId?: string, accountChatIds?: string[]) {
  let query
  if (chatId && userId) {
    query = localDb.select().from(trades).where(or(eq(trades.chatId, chatId), eq(trades.userId, userId)))
  } else if (userId) {
    query = localDb.select().from(trades).where(eq(trades.userId, userId))
  } else if (chatId) {
    query = localDb.select().from(trades).where(eq(trades.chatId, chatId))
  } else {
    query = localDb.select().from(trades)
  }

  if (accountChatIds && accountChatIds.length > 0) {
    query = localDb.select().from(trades).where(or(...(chatId ? [
      eq(trades.chatId, chatId),
    ] : []),
    ...(userId ? [
      eq(trades.userId, userId),
    ] : []),
    inArray(trades.chatId, accountChatIds)))
  }
      
  const dbTrades = await query
  return dbTrades.map(t => ({
    id: t.id,
    chatId: t.chatId,
    userId: t.userId,
    ticker: t.ticker,
    entry: parseFloat(t.entry),
    stopLoss: parseFloat(t.stopLoss),
    target: parseFloat(t.target),
    partialTarget: t.partialTarget ? parseFloat(t.partialTarget) : undefined,
    isPartialTaken: t.isPartialTaken || false,
    risk: parseFloat(t.risk || '0'),
    riskAmountUsd: parseFloat(t.riskAmountUsd || '0'),
    capitalDeployed: parseFloat(t.capitalDeployed || '0'),
    strategyName: t.strategyName || 'UNKNOWN',
    stage: t.stage || 0,
    daysHeld: t.daysHeld || 0,
    highestHigh: t.highestHigh ? parseFloat(t.highestHigh) : parseFloat(t.entry),
    atr: t.atr ? parseFloat(t.atr) : (parseFloat(t.risk || '1') * 0.8),
    entryDate: t.entryDate || new Date(),
    thesis: t.thesis || undefined,
    confirmationSignals: t.confirmationSignals || undefined,
    reversalSignals: t.reversalSignals || undefined,
    ttl: t.ttl || undefined,
    // Phase 3 branch anatomy — surfaced so exitManager can detect thesis decay
    // and fire STRATEGY_HANDOFF when firedBranchName no longer matches a fresh
    // evaluation against current market data.
    firedBranchName: t.firedBranchName || undefined,
    entryRegime: t.entryRegime || undefined,
    entrySector: t.entrySector || undefined,
  }))
}

export async function updateTrackedStock(stock: {
  id: number
  stopLoss: number
  highestHigh?: number
  entry: number
  isPartialTaken?: boolean
}) {
  if (!stock.id) return
  try {
    await localDb.update(trades)
      .set({
        stopLoss: stock.stopLoss.toString(),
        highestHigh: (stock.highestHigh ?? stock.entry).toString(),
        isPartialTaken: stock.isPartialTaken,
      })
      .where(eq(trades.id, stock.id))
  } catch (e) {
    logger.error({ error: e }, '[DB ERROR] Failed to update tracked stock')
  }
}

export interface FreshSignalSetup {
  ticker: string
  entry: number
  stopLoss: number
  target: number
  atr?: number
  firedBranchName?: string
}

/**
 * Capture the ENTRY THESIS for a just-opened position (structural
 * sleeve). Slow-sleeve branches are thesis-managed: /status and the dashboard
 * show the entry structural state + a live validity verdict. Fetches current
 * /metrics for the ticker (seconds old — same scan), resolves the branch
 * (explicit param, else the chat's scan cache — the Telegram buy-callback
 * cannot carry it within the 64-byte limit), and writes a compact JSON to
 * `trades.thesis`. Fire-and-forget: failure must never block a buy.
 */
export async function captureEntryThesis(ticker: string, chatId: string, firedBranchName?: string): Promise<void> {
  try {
    // Branch resolution: explicit → scan cache (setups fired in the last scan
    // for this chat) → none (velocity trade; thesis stays null).
    let branch = firedBranchName
    if (!branch) {
      const { getScanCache } = await import('../clientScanner')
      branch = getScanCache(chatId)?.setups?.find(s => s.ticker === ticker)?.firedBranchName
    }
    if (!branch) return

    // Thesis-managed? Read the user's AST exemption list.
    const setting = (await localDb.select({ ast: settings.mainStrategyAst }).from(settings)
      .where(eq(settings.telegramChatId, chatId)).limit(1))[0]
    let exempt: string[] | undefined
    if (setting?.ast) {
      try {
        const ast = JSON.parse(setting.ast) as { rotationRules?: { rotationExemptBranches?: string[] } }
        exempt = ast.rotationRules?.rotationExemptBranches
      } catch { /* unparseable AST — treat as no exemptions */ }
    }
    if (!exempt?.includes(branch)) return // velocity trade — no thesis snapshot

    // Current structural state (best-effort; fields fail closed when unscored).
    const MetricSchema = z.object({
      ticker: z.string().optional(),
      fcfInflection: z.string().nullish(),
      fcfSpringFactor: z.coerce.number().nullish(),
      sectorNewsScore: z.coerce.number().nullish(),
      newsScore: z.coerce.number().nullish(),
      newsAlignment: z.string().nullish(),
      sectorName: z.string().nullish(),
    }).passthrough()
    const res = await fetchFromApi(
      '/metrics', z.union([
        z.array(MetricSchema),
        z.object({ data: z.array(MetricSchema).optional() }).passthrough(),
      ]).catch({ data: [] }), {
        method: 'POST',
        body: JSON.stringify({
          tickers: [
            ticker,
          ], 
        }),
      }, chatId,
    ).catch(() => null)
    const m = (Array.isArray(res) ? res[0] : res?.data?.[0]) ?? null

    const thesis = {
      branch,
      structural: true,
      capturedAt: new Date().toISOString(),
      horizonDays: 120,
      ...(m?.fcfInflection !== undefined && m?.fcfInflection !== null ? { fcfInflection: m.fcfInflection } : {}),
      ...(m?.fcfSpringFactor != null ? { fcfSpringFactor: m.fcfSpringFactor } : {}),
      ...(m?.sectorNewsScore != null ? { sectorNewsScore: m.sectorNewsScore } : {}),
      ...(m?.newsScore != null ? { newsScore: m.newsScore } : {}),
      ...(m?.newsAlignment != null ? { newsAlignment: m.newsAlignment } : {}),
      ...(m?.sectorName ? { sector: m.sectorName } : {}),
    }

    // Write to the OPEN trade row for this ticker (latest entry).
    const openTrade = (await localDb.select({ id: trades.id }).from(trades)
      .where(and(eq(trades.ticker, ticker),
        eq(trades.chatId, chatId),
        lt(trades.stage, 4)))
      .orderBy(desc(trades.id)).limit(1))[0]
    if (!openTrade) return
    await localDb.update(trades)
      .set({ thesis: JSON.stringify(thesis) })
      .where(eq(trades.id, openTrade.id))
  } catch (e) {
    logger.warn({ error: e, ticker, chatId }, '[THESIS] Entry-thesis capture failed — position continues without snapshot')
  }
}

export interface StopTightenChange {
  ticker: string
  oldStop: number
  newStop: number
  oldTarget: number
  newTarget: number
  atrRefreshed: boolean
  branchReanchored: boolean
}

/**
 * When a fresh signal fires for a ticker the user already holds, refresh the
 * monitored stops from that signal — TIGHTEN-ONLY (never lower risk).
 *
 * - stopLoss: raised to max(current, fresh) only when the fresh stop is below
 *   the live/signal price. Never lowered. Coexists with the break-even +
 *   chandelier ratchet in calculateSellSignal (both already take max()), so a
 *   higher floor never disables trailing logic.
 * - target: raised to max(current, fresh). Never lowered (would force a
 *   premature exit).
 * - atr: always refreshed to the fresh signal's volatility — the persisted atr
 *   drives the chandelier trailing stop, and a stale buy-day atr makes it wrong.
 * - firedBranchName: re-anchored to the fresh branch so STRATEGY_HANDOFF decay
 *   detection runs against the CURRENT thesis, not the stale entry thesis.
 *
 * Only writes when something changed. Returns a description of each change for
 * the caller to surface (or log) — does NOT notify itself, so the scanner can
 * batch one message per scan tick.
 */
export async function tightenHeldPositionStops(chatId: string,
  setups: FreshSignalSetup[]): Promise<StopTightenChange[]> {
  const tracked = await loadTrackedStocks(chatId)
  if (tracked.length === 0 || setups.length === 0) return []

  const byTicker = new Map<string, FreshSignalSetup>()
  for (const s of setups) byTicker.set(s.ticker.toUpperCase(), s)

  const changes: StopTightenChange[] = []
  for (const stock of tracked) {
    const setup = byTicker.get(stock.ticker.toUpperCase())
    if (!setup) continue

    const updates: Partial<typeof trades.$inferInsert> = {}
    let oldStop = stock.stopLoss
    let newStop = stock.stopLoss
    let oldTarget = stock.target
    let newTarget = stock.target
    let atrRefreshed = false
    let branchReanchored = false

    const freshAtr = setup.atr ?? 0
    if (freshAtr > 0 && Math.abs(freshAtr - stock.atr) > 0.001) {
      updates.atr = freshAtr.toFixed(2)
      atrRefreshed = true
    }

    if (
      Number.isFinite(setup.stopLoss)
      && setup.stopLoss > stock.stopLoss
      && setup.stopLoss < setup.entry
    ) {
      updates.stopLoss = setup.stopLoss.toFixed(2)
      newStop = setup.stopLoss
      oldStop = stock.stopLoss
      const newRisk = Math.abs(stock.entry - setup.stopLoss)
      updates.riskPerShare = newRisk.toFixed(2)
      updates.risk = newRisk.toFixed(2)
      const shares = stock.entry > 0 ? stock.capitalDeployed / stock.entry : 0
      updates.riskAmountUsd = (shares * newRisk).toFixed(2)
    }

    if (Number.isFinite(setup.target) && setup.target > stock.target) {
      updates.target = setup.target.toFixed(2)
      newTarget = setup.target
      oldTarget = stock.target
    }

    if (setup.firedBranchName && setup.firedBranchName !== stock.firedBranchName) {
      updates.firedBranchName = setup.firedBranchName
      branchReanchored = true
    }

    if (!updates.stopLoss && !updates.target && !updates.atr && !updates.firedBranchName) continue

    try {
      await localDb.update(trades).set(updates).where(eq(trades.id, stock.id))
      changes.push({
        ticker: stock.ticker, oldStop, newStop, oldTarget, newTarget, atrRefreshed, branchReanchored,
      })
    } catch (e) {
      logger.error({ error: e, ticker: stock.ticker, chatId }, '[TIGHTEN] Failed to refresh held-position stop')
    }
  }

  return changes
}

async function removeTrackedStock(
  ticker: string, chatId: string, exitPrice?: number, exitReason?: string, lang?: Language,
) {
  if (!lang) lang = await getChatLanguage(chatId)
  try {
    const tickerUpper = ticker.toUpperCase()
    let existing = await localDb.select().from(trades).where(and(eq(trades.ticker, tickerUpper), eq(trades.chatId, chatId))).limit(1)

    if (existing.length === 0) {
      existing = await localDb.select().from(trades).where(eq(trades.ticker, tickerUpper)).limit(1)
    }

    if (existing.length === 0) {
      await sendGenericMessage(t('TICKER_NOT_IN_PORTFOLIO', lang, { ticker: tickerUpper }), undefined, chatId).catch(() => {})
      return
    }

    const stock = existing[0]!
    let finalExitPrice = exitPrice
    if (finalExitPrice === undefined || finalExitPrice === null) {
      const quote = await getQuote(tickerUpper, chatId)
      if (quote?.price) {
        finalExitPrice = quote.price
      } else {
        finalExitPrice = parseFloat(stock.entry)
      }
    }

    let pnlAmount: number | null = null
    let pnlPercent: number | null = null
    if (finalExitPrice !== undefined && finalExitPrice !== null) {
      const entryPriceVal = parseFloat(stock.entry)
      const capital = parseFloat(stock.capitalDeployed)
      pnlPercent = entryPriceVal > 0 ? ((finalExitPrice - entryPriceVal) / entryPriceVal) * 100 : 0
      pnlAmount = (pnlPercent / 100) * capital

      const stats = (await localDb.select().from(portfolioStats).where(eq(portfolioStats.chatId, chatId)).limit(1))[0]
      if (stats) {
        const newTotalCapital = parseFloat(stats.currentCapital) + pnlAmount
        await localDb.update(portfolioStats).set({
          currentCapital: newTotalCapital.toString(),
          updatedAt: new Date(),
        }).where(eq(portfolioStats.chatId, chatId))
        // NOTE: the configured budget (user_budgets.totalCapital) is NOT adjusted
        // by realized PnL — only the running capital (portfolioStats.currentCapital)
        // reflects gains/losses. The previous settings.totalCapital write here was a
        // bug that drifted the configured budget on every closed trade.
      }
    }

    await localDb.insert(tradeAuditLog).values({
      chatId: stock.chatId,
      userId: stock.userId || 'dashboard_user',
      ticker: stock.ticker,
      entryPrice: stock.entry,
      exitPrice: finalExitPrice !== undefined && finalExitPrice !== null ? finalExitPrice.toString() : stock.entry,
      exitReason: exitReason || 'MANUAL',
      entryDate: stock.entryDate,
      exitDate: new Date(),
      pnlUsd: pnlAmount !== null ? pnlAmount.toString() : '0',
      pnlPercent: pnlPercent !== null ? pnlPercent.toString() : '0',
      strategyName: stock.strategyName || 'MANUAL',
      thesis: stock.thesis,
    })

    await localDb.delete(trades).where(eq(trades.id, stock.id))

    const remainingCash = await getAvailableCash(chatId)
    const pnlStr = pnlAmount !== null
      ? `\n• PnL: <b>${pnlAmount >= 0 ? '+' : ''}$${pnlAmount.toFixed(2)} (${pnlPercent! >= 0 ? '+' : ''}${pnlPercent!.toFixed(2)}%)</b>`
      : ''
    const exitPriceStr = finalExitPrice !== undefined && finalExitPrice !== null ? `\n• ${t('LABEL_EXIT_PRICE', lang)}: <b>$${finalExitPrice.toFixed(2)}</b>` : ''

    const sellMsg = `🔴 <b>${t('SELL_TITLE', lang)}: ${ticker}</b>` +
      exitPriceStr + pnlStr +
      `\n• ${t('AVAILABLE_CASH', lang)}: <b>$${remainingCash.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>`

    await sendGenericMessage(local(sellMsg), undefined, chatId)
  } catch (e) {
    logger.error({ error: e, ticker, chatId }, '[DB ERROR] Failed to remove tracked stock')
  }
}

export async function handleBudget(chatId: string, lang?: Language) {
  if (!lang) lang = await getChatLanguage(chatId)
  await ensurePortfolioInitialized(chatId)

  const chat = (await localDb.select().from(settings).where(eq(settings.telegramChatId, chatId)).limit(1))[0]
  if (!chat) {
    await sendGenericMessage(t('ERR_PROCESSING', lang), undefined, chatId)
    return
  }

  const budget = await getUserBudget(localDb, chat.userId)
  const activeTrades = await localDb.select().from(trades).where(eq(trades.chatId, chatId))
  
  const cash = await getAvailableCash(chatId)
  const totalConfigured = parseFloat(budget.totalCapital)
  const riskUsd = budget.maxRiskPerTradeUsd
  const isPercent = budget.maxRiskPerTrade?.endsWith('%')
  const riskDisplay = !budget.maxRiskPerTrade || budget.maxRiskPerTrade === '0'
    ? t('RISK_SETTING_AUTO', lang)
    : (isPercent
      ? `$${riskUsd.toLocaleString()} (${budget.maxRiskPerTrade})`
      : `$${riskUsd.toLocaleString()}`)
  const invested = await computeDeployedMarketValue(activeTrades, chatId)
  
  let msg = `💰 <b>${t('BUDGET_OVERVIEW', lang)}</b>\n\n`
  msg += `• <b>${t('BUDGET_TOTAL_ACCOUNT', lang)}</b>: $${totalConfigured.toLocaleString(undefined, { maximumFractionDigits: 2 })}\n`
  msg += `• <b>${t('BUDGET_FREE_CASH', lang)}</b>: $${cash.toLocaleString(undefined, { maximumFractionDigits: 2 })}\n`
  msg += `• <b>${t('BUDGET_INVESTED', lang)}</b>: $${invested.toLocaleString(undefined, { maximumFractionDigits: 2 })}\n`
  msg += `• <b>${t('BUDGET_MAX_RISK', lang)}</b>: ${riskDisplay}\n\n`
  msg += `<i>${t('BUDGET_HINT', lang)}</i>`

  await sendGenericMessage(msg, undefined, chatId)
}

export async function handlePortfolioStatus(chatId: string, lang?: Language) {
  if (!lang) lang = await getChatLanguage(chatId)
  const chat = (await localDb.select().from(settings).where(eq(settings.telegramChatId, chatId)).limit(1))[0]
  // Account scope: every device sharing this chat's API key sees one portfolio.
  const { getAccountScopeByKey } = await import('../dashboardIdentity')
  const accountScope = await getAccountScopeByKey(localDb, chat?.quantourApiKey)
  const tracked = await loadTrackedStocks(chatId, accountScope.userId ?? chat?.userId ?? undefined, accountScope.chatIds)
  tracked.sort((a, b) => a.ticker.localeCompare(b.ticker))
  
  const stats = (await localDb.select().from(portfolioStats).where(or(eq(portfolioStats.chatId, chatId),
    eq(portfolioStats.userId, chat?.userId || chatId),
    ...(accountScope.chatIds.length > 0 ? [
      inArray(portfolioStats.chatId, accountScope.chatIds),
    ] : []))).limit(1))[0]
  if (!stats) {
    await sendGenericMessage(t('ERR_PORTFOLIO_NOT_INITIALIZED', lang), undefined, chatId)
    return
  }
  
  const budget = await getUserBudget(localDb, chat?.userId)
  const totalCapital = parseFloat(budget.totalCapital) || 0
  const deployed = await computeDeployedMarketValue(tracked, chatId)
  const available = Math.max(0, totalCapital - deployed)

  const sectorExposure: Record<string, number> = {}
  const pcrDataMap: Record<string, unknown> = {}
  const quoteDataMap: Record<string, number> = {}

  if (tracked.length > 0) {
    const tickers = tracked.map(s => s.ticker)
    const quotes = await getQuotesBatch(tickers, chatId)
    for (const q of quotes) {
      if (q && q.symbol && q.price) {
        quoteDataMap[q.symbol] = q.price
      }
    }

    await Promise.all(tracked.map(async (s) => {
      try {
        const capitalStr = s.capitalDeployed?.toString() || '0'
        const capitalNum = parseFloat(capitalStr)
        const validCapital = isNaN(capitalNum) || capitalNum < 0 ? 0 : capitalNum

        let sector = 'Other'
        const infoRes = await fetchFromApi(
          `/ticker/${s.ticker}/info`, z.union([
            z.array(QuoteSchema),
            TickerInfoEnvelopeSchema,
          ]), {}, chatId,
        ).catch(() => null)
        if (infoRes && !Array.isArray(infoRes) && infoRes.success && infoRes.data?.ticker?.sector) {
          sector = infoRes.data.ticker.sector
        } else {
          const profile = await getTickerInfo(s.ticker, chatId)
          const profileObj = Array.isArray(profile) ? profile[0] : profile
          if (profileObj && profileObj.sector) {
            sector = profileObj.sector
          }
        }

        sectorExposure[sector] = (sectorExposure[sector] || 0) + validCapital

        const pcrInfo = await getPutCallRatioData(s.ticker)
        if (pcrInfo) pcrDataMap[s.ticker] = pcrInfo
      } catch {
        const capitalStr = s.capitalDeployed?.toString() || '0'
        const capitalNum = parseFloat(capitalStr)
        const validCapital = isNaN(capitalNum) || capitalNum < 0 ? 0 : capitalNum
        sectorExposure['Other'] = (sectorExposure['Other'] || 0) + validCapital
      }
    }))
  }

  if (available > 0) {
    sectorExposure['Cash'] = available
  }

  const { isMarketOpen } = await import('@quantour/shared-algo/src/core/marketHours')
  const marketOpen = isMarketOpen()

  let message = ''
  if (!marketOpen) {
    message += t('MARKET_CLOSED_PRE_CLOSE_PRICES', lang)
  }

  message += `<b>${t('STATUS_HEADER', lang)}</b>\n\n`
  
  let totalCost = 0
  let totalValue = 0
  if (tracked.length === 0) {
    message += `<i>${t('NO_TRACKED_POS', lang)}</i>`
  } else {
    message += `<b>${t('CURRENTLY_TRACKING', lang, { count: tracked.length })}</b>\n`
    for (const s of tracked) {
      const rawShares = s.capitalDeployed > 0 && s.entry > 0 ? s.capitalDeployed / s.entry : 0
      const shares = Math.round(rawShares * 100) / 100
      const sharesStr = Number.isInteger(shares) ? shares.toString() : shares.toFixed(2)
      const sharesLabel = shares > 0 ? ` x ${sharesStr}` : ''
      const pcrInfo = pcrDataMap[s.ticker] as { label?: string } | undefined
      const sentimentStr = pcrInfo?.label ? ` (${pcrInfo.label})` : ''
      const lastPrice = quoteDataMap[s.ticker] || s.entry
      const pnlPct = s.entry > 0 ? ((lastPrice - s.entry) / s.entry) * 100 : 0
      const pnlSign = pnlPct >= 0 ? '+' : ''
      const priceStr = ` (Last: $${lastPrice.toFixed(2)}, ${pnlSign}${pnlPct.toFixed(1)}%)`
      message += `• <b>${s.ticker}${sharesLabel}</b>: $${s.entry.toFixed(3)}${priceStr} → SL: $${s.stopLoss.toFixed(3)} | TP: $${s.target.toFixed(3)}${sentimentStr}\n`
      if (s.capitalDeployed > 0 && s.entry > 0) {
        totalCost += s.capitalDeployed
        totalValue += (s.capitalDeployed / s.entry) * lastPrice
      }
    }
  }

  if (totalCost > 0) {
    const totalPnl = totalValue - totalCost
    const totalPnlPct = (totalPnl / totalCost) * 100
    const totalPnlSign = totalPnl >= 0 ? '+' : ''
    message += `\n💼 <b>${t('TOTAL_PNL', lang)}</b>: ${totalPnlSign}$${totalPnl.toFixed(2)} (${totalPnlSign}${totalPnlPct.toFixed(1)}%)`
  }

  message += `\n💰 <b>${t('AVAILABLE_CASH', lang)}: $${available.toLocaleString(undefined, { minimumFractionDigits: 2 })}</b> / $${totalCapital.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  
  const riskAmount = chat ? budget.maxRiskPerTradeUsd : 0
  const isPercent = budget.maxRiskPerTrade?.endsWith('%')
  const riskDisplay = !budget.maxRiskPerTrade || budget.maxRiskPerTrade === '0'
    ? t('RISK_SETTING_AUTO', lang)
    : (isPercent
      ? `$${riskAmount.toLocaleString()} (${budget.maxRiskPerTrade})`
      : `$${riskAmount.toLocaleString()}`)
  message += `\n⚖️ <b>${t('MAX_RISK_SET', lang)}: ${riskDisplay}</b>`

  if (Object.keys(sectorExposure).length > 0 && totalCapital > 0) {
    const sortedSectors = Object.entries(sectorExposure).sort((a, b) => b[1] - a[1])
    message += `\n\n📊 <b>${t('SECTOR_CASH_ALLOCATION', lang)}</b>:\n`
    for (const [
      secName,
      amount,
    ] of sortedSectors) {
      const pct = (amount / totalCapital) * 100
      message += `• <b>${secName}</b>: $${Math.round(amount).toLocaleString('en-US')} (${pct.toFixed(1)}%)\n`
    }
  }

  // News-divergence warning: held positions whose company news lags a hot
  // sector (LAGGARD_IN_HOT_SECTOR) — distribution candidates. Fetched from
  // the central /metrics (newsAlignment is computed there); degrades silently
  // when metrics are unavailable (no fabricated warnings).
  if (tracked.length > 0) {
    try {
      const AlignmentItemSchema = z.object({
        ticker: z.string().optional(),
        newsScore: z.coerce.number().nullish(),
        sectorNewsScore: z.coerce.number().nullish(),
        newsDivergence: z.coerce.number().nullish(),
        newsAlignment: z.string().nullish(),
      }).passthrough()
      const AlignmentSchema = z.union([
        z.array(AlignmentItemSchema),
        z.object({ data: z.array(AlignmentItemSchema).optional() }).passthrough(),
      ]).catch({ data: [] })
      const res = await fetchFromApi(
        '/metrics', AlignmentSchema, {
          method: 'POST',
          body: JSON.stringify({
            tickers: [
              ...new Set(tracked.map(s => s.ticker)),
            ], 
          }),
        }, chatId,
      ).catch(() => null)
      if (res) {
        const items = Array.isArray(res) ? res : (res.data ?? [])
        const laggards = items.filter(i => i.newsAlignment === 'LAGGARD_IN_HOT_SECTOR')
        if (laggards.length > 0) {
          message += `\n\n⚠️ <b>${t('STATUS_LAGGARD_WARNING', lang)}</b>\n`
          for (const l of laggards) {
            message += `• ${t('STATUS_LAGGARD_ITEM', lang, {
              ticker: l.ticker || '?',
              news: String(l.newsScore ?? '?'),
              sector: String(l.sectorNewsScore ?? '?'),
              div: String(l.newsDivergence ?? '?'),
            })}\n`
          }
        }
      }
    } catch (e) {
      logger.warn({ error: e }, '[STATUS] Laggard alignment fetch failed — skipping warning section')
    }
  }

  // 🌱 Structural theses: slow-sleeve positions get their own
  // section — entry snapshot + LIVE verdict against current metrics (mirrors
  // the AST's thesis-break exit arms). Velocity positions are unaffected.
  const structuralRows = tracked
    .filter(s => s.stage < 4)
    .map(s => ({ stock: s, thesis: parseStructuralThesis(s.thesis ?? null) }))
    .filter(r => r.thesis !== null) as Array<{ stock: typeof tracked[number]; thesis: StructuralThesisSnapshot }>
  if (structuralRows.length > 0) {
    try {
      const MetricItem = z.object({
        ticker: z.string().optional(),
        fcfInflection: z.string().nullish(),
        sectorNewsScore: z.coerce.number().nullish(),
        newsScore: z.coerce.number().nullish(),
        newsAlignment: z.string().nullish(),
      }).passthrough()
      const res = await fetchFromApi(
        '/metrics', z.union([
          z.array(MetricItem),
          z.object({ data: z.array(MetricItem).optional() }).passthrough(),
        ]).catch({ data: [] }), {
          method: 'POST',
          body: JSON.stringify({ tickers: structuralRows.map(r => r.stock.ticker) }),
        }, chatId,
      ).catch(() => null)
      const items = Array.isArray(res) ? res : (res?.data ?? [])
      const byTicker = new Map(items.map(m => [
        String(m.ticker ?? '').toUpperCase(),
        m,
      ]))

      message += `\n\n🌱 <b>${t('STATUS_STRUCTURAL_HEADER', lang)}</b>\n`
      for (const { stock, thesis } of structuralRows) {
        const cur = byTicker.get(stock.ticker.toUpperCase())
        const verdict = structuralThesisVerdict(thesis, {
          fcfInflection: cur?.fcfInflection ?? undefined,
          sectorNewsScore: cur?.sectorNewsScore ?? undefined,
          newsScore: cur?.newsScore ?? undefined,
          newsAlignment: cur?.newsAlignment ?? undefined,
        })
        const verdictIcon = verdict === 'INTACT' ? '🟢' : verdict === 'WEAKENING' ? '🟡' : '🔴'
        const verdictLabel = verdict === 'INTACT'
          ? t('STATUS_THESIS_INTACT', lang)
          : verdict === 'WEAKENING'
            ? t('STATUS_THESIS_WEAKENING', lang)
            : t('STATUS_THESIS_BROKEN', lang)
        const lastPrice = quoteDataMap[stock.ticker] || stock.entry
        const pnlPct = stock.entry > 0 ? ((lastPrice - stock.entry) / stock.entry) * 100 : 0
        const pnlSign = pnlPct >= 0 ? '+' : ''
        message += `• <b>${stock.ticker}</b>: ${t('STATUS_STRUCTURAL_ITEM', lang, {
          days: String(stock.daysHeld),
          horizon: String(thesis.horizonDays),
          verdict: `${verdictIcon} ${verdictLabel}`,
          pnl: `${pnlSign}${pnlPct.toFixed(1)}%`,
        })}\n`
        const entryBits: string[] = []
        if (thesis.fcfInflection) entryBits.push(`FCF ${thesis.fcfInflection}`)
        if (thesis.fcfSpringFactor !== undefined) entryBits.push(`spring ${thesis.fcfSpringFactor}`)
        if (thesis.sectorNewsScore !== undefined) entryBits.push(`sector ${thesis.sectorNewsScore}`)
        if (entryBits.length > 0) message += `  <i>${t('STATUS_STRUCTURAL_ENTRY', lang)}: ${entryBits.join(' · ')}</i>\n`
      }
    } catch (e) {
      logger.warn({ error: e }, '[STATUS] Structural thesis fetch failed — skipping section')
    }
  }

  if (stats.isMarginCalled) {
    message += '\n\n💀 <b>STATUS: MARGIN CALLED (DEAD)</b>'
  }

  const buttons = {
    inline_keyboard: [
      [
        { text: t('SCAN_BTN', lang), callback_data: 'run_scan' },
        { text: t('OPTIMIZE_BTN', lang), callback_data: 'portfolio_optimize' },
      ],
      [
        { text: '📊 ' + t('CMD_DESC_DEEP_PORTFOLIO', lang), callback_data: 'deep_portfolio' },
        { text: '⚙️ ' + t('HELP_SETTINGS', lang), callback_data: 'settings' },
      ],
    ],
  }

  await sendGenericMessage(local(message), buttons, chatId)
}

export async function handleTrackAdd(tickerList: string[], chatId: string, lang?: Language) {
  if (!lang) lang = await getChatLanguage(chatId)
  const added: string[] = []
  const failed: string[] = []

  for (const ticker of tickerList) {
    if (ticker.includes('.')) {
      failed.push(ticker)
      continue
    }
    try {
      const quote = await getQuote(ticker)
      if (!quote || !quote.price) {
        failed.push(ticker)
        continue
      }
      
      const existing = await localDb.select().from(trades).where(and(eq(trades.ticker, ticker), eq(trades.chatId, chatId))).limit(1)
      if (existing.length > 0) {
        added.push(ticker)
        continue
      }
      const stops = await resolvePositionStops(
        ticker, quote.price, chatId, undefined, 'MANUAL_TRACK',
      )
      if (!stops) {
        logger.warn({ ticker, chatId }, '[TRACK] Rejecting track: could not compute a safe stop-loss (no signal stop and no usable candle ATR)')
        await sendGenericMessage(`⚠️ ${t('STOP_COMPUTE_FAILED', lang, { ticker })}`, undefined, chatId)
        failed.push(ticker)
        continue
      }
      const {
        fillPrice, stopLoss: sl, target: tp, partialTarget, risk, atr, strategy, firedBranchName, 
      } = stops

      await localDb.insert(trades).values({
        chatId,
        ticker,
        entry: fillPrice.toString(),
        stopLoss: sl.toString(),
        target: tp.toString(),
        partialTarget: partialTarget.toString(),
        isPartialTaken: false,
        riskPerShare: risk.toString(),
        risk: risk.toString(),
        strategyName: strategy,
        riskAmountUsd: '0',
        highestHigh: fillPrice.toString(),
        atr: atr.toString(),
        capitalDeployed: '0',
        entryDate: new Date(),
        firedBranchName,
      })
      added.push(ticker)
      captureEntryThesis(ticker, chatId, firedBranchName).catch(err => {
        logger.warn({ error: err, ticker, chatId }, '[THESIS] Entry-thesis capture failed on track')
      })
      triggerThesisValidationOnEntry(ticker, chatId, lang).catch(err => {
        logger.error({ error: err, ticker, chatId }, '[THESIS] Failed async thesis validation on track')
      })
    } catch {
      failed.push(ticker)
    }
  }
  
  if (added.length > 0) {
    await sendGenericMessage(t('TICKERS_ADDED', lang, { count: added.length, tickers: added.join(', ') }), undefined, chatId)
  }
  if (failed.length > 0) {
    await sendGenericMessage(t('ERR_FAILED_TO_TRACK', lang, { tickers: failed.join(', ') }), undefined, chatId)
  }
}

export async function handlePortfolioAdd(
  rawTicker: string, shares: number, chatId: string, lang?: Language, override?: SignalOverride,
): Promise<boolean> {
  if (!lang) lang = await getChatLanguage(chatId)
  const ticker = rawTicker.trim().toUpperCase()

  if (ticker.includes('.')) {
    await sendGenericMessage(t('ERR_NON_US_TICKER', lang), undefined, chatId)
    return false
  }

  const chat = (await localDb.select().from(settings).where(eq(settings.telegramChatId, chatId)).limit(1))[0]

  try {
    let quote: { price: number; symbol?: string } | null = null
    const infoRes = await fetchFromApi(
      `/ticker/${ticker}/info`, z.union([
        z.array(QuoteSchema),
        TickerInfoEnvelopeSchema,
      ]), {}, chatId,
    ).catch(() => null)
    if (infoRes && Array.isArray(infoRes) && infoRes[0]?.price) {
      quote = { price: Number(infoRes[0].price), symbol: ticker }
    } else if (infoRes && !Array.isArray(infoRes) && infoRes.success && infoRes.data?.quote) {
      quote = { price: Number(infoRes.data.quote.price), symbol: ticker }
    } else {
      const qRes = await getQuote(ticker, chatId)
      const q = Array.isArray(qRes) ? qRes[0] : qRes
      if (q && q.price) {
        quote = { price: Number(q.price), symbol: ticker }
      } else {
        const pRes = await getTickerInfo(ticker, chatId)
        const profile = Array.isArray(pRes) ? pRes[0] : pRes
        if (profile && profile.price) {
          quote = { price: Number(profile.price), symbol: ticker }
        }
      }
    }

    if (!quote || !quote.price) {
      const tickersRes = await fetchFromApi(
        '/market/tickers', TickersListSchema, {}, chatId,
      ).catch(() => null)
      if (tickersRes && tickersRes.success && Array.isArray(tickersRes.data)) {
        const matched = tickersRes.data.find(t => t.ticker === ticker)
        if (matched && matched.lastPrice) {
          quote = { price: Number(matched.lastPrice), symbol: ticker }
        }
      }
    }

    if (!quote || !quote.price) {
      const { dailyMetricsHistory } = await import('~/db/clientSchema')
      const cached = await localDb.select().from(dailyMetricsHistory).where(eq(dailyMetricsHistory.ticker, ticker)).limit(1)
      if (cached.length > 0 && cached[0].price) {
        quote = { price: Number(cached[0].price), symbol: ticker }
      }
    }

    if (!quote || !quote.price) {
      await sendGenericMessage(t('TICKER_NOT_FOUND', lang, { ticker }), undefined, chatId)
      return false
    }

    const stops = await resolvePositionStops(
      ticker, quote.price, chatId, override, 'MANUAL_ADD',
    )
    if (!stops) {
      logger.warn({ ticker, chatId }, '[BUY] Rejecting buy: could not compute a safe stop-loss (no signal stop and no usable candle ATR)')
      await sendGenericMessage(`⚠️ ${t('STOP_COMPUTE_FAILED', lang, { ticker })}`, undefined, chatId)
      return false
    }
    const {
      fillPrice, stopLoss: sl, target: tp, partialTarget, risk, atr, strategy, firedBranchName, 
    } = stops
    const capital = shares * fillPrice

    const existing = await localDb.select().from(trades).where(and(eq(trades.ticker, ticker), eq(trades.chatId, chatId))).limit(1)

    if (existing.length > 0) {
      const oldTrade = existing[0]
      const oldCapital = parseFloat(oldTrade.capitalDeployed || '0')
      const newCapital = oldCapital + capital
      const totalShares = newCapital / fillPrice
      const avgEntry = newCapital / totalShares

      await localDb.update(trades).set({
        entry: avgEntry.toString(),
        capitalDeployed: newCapital.toString(),
        stopLoss: sl.toString(),
        target: tp.toString(),
        partialTarget: partialTarget.toString(),
        riskPerShare: risk.toString(),
        risk: risk.toString(),
        strategyName: strategy,
        firedBranchName,
        riskAmountUsd: (totalShares * Math.abs(avgEntry - sl)).toString(),
        atr: atr.toString(),
      }).where(eq(trades.id, oldTrade.id))
    } else {
      await localDb.insert(trades).values({
        chatId,
        userId: chat?.userId || 'dashboard_user',
        ticker,
        entry: fillPrice.toString(),
        stopLoss: sl.toString(),
        target: tp.toString(),
        partialTarget: partialTarget.toString(),
        isPartialTaken: false,
        riskPerShare: risk.toString(),
        risk: risk.toString(),
        strategyName: strategy,
        firedBranchName,
        riskAmountUsd: (shares * risk).toString(),
        highestHigh: fillPrice.toString(),
        atr: atr.toString(),
        capitalDeployed: capital.toString(),
        entryDate: new Date(),
      })
    }

    const remainingCash = await getAvailableCash(chatId)
    const buyMsg = `🟢 <b>${t('BUY_TITLE', lang)}: ${ticker}</b>\n` +
      `• ${t('LABEL_SHARES', lang)}: <b>${shares}</b>\n` +
      `• ${t('LABEL_ENTRY_PRICE', lang)}: <b>$${fillPrice.toFixed(2)}</b>\n` +
      `• ${t('LABEL_CAPITAL_DEPLOYED', lang)}: <b>$${capital.toFixed(2)}</b>\n` +
      `• ${t('AVAILABLE_CASH', lang)}: <b>$${remainingCash.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>`

    await sendGenericMessage(local(buyMsg), undefined, chatId)

    triggerThesisValidationOnEntry(ticker, chatId, lang).catch(err => {
      logger.error({ error: err, ticker, chatId }, '[THESIS] Failed async thesis validation on portfolio add')
    })
    captureEntryThesis(ticker, chatId, firedBranchName).catch(err => {
      logger.warn({ error: err, ticker, chatId }, '[THESIS] Entry-thesis capture failed on manual add')
    })
    return true
  } catch {
    await sendGenericMessage(t('ERR_ADD_TICKER_FAILED', lang, { ticker }), undefined, chatId)
    return false
  }
}

export async function handleSell(
  ticker: string, chatId: string, lang?: Language, exitReason?: string,
) {
  if (!lang) lang = await getChatLanguage(chatId)
  await removeTrackedStock(
    ticker, chatId, undefined, exitReason, lang,
  )
}

export async function handleRemoveBatch(tickers: string[], chatId: string, lang?: Language) {
  if (!lang) lang = await getChatLanguage(chatId)
  for (const t of tickers) {
    await removeTrackedStock(
      t, chatId, undefined, undefined, lang,
    )
  }
}

export async function handleSellStrategy(ticker: string, chatId: string, lang?: Language) {
  const resolvedLang = lang || (await getChatLanguage(chatId))
  await removeTrackedStock(
    ticker, chatId, undefined, 'STRATEGY_EXIT', resolvedLang,
  )
}

export async function handlePending(chatId: string, lang?: Language) {
  const resolvedLang = lang || (await getChatLanguage(chatId))
  await sendGenericMessage(t('NO_PENDING_SIGNALS', resolvedLang), undefined, chatId)
}

/**
 * Build a DashboardScope from a single telegram chatId. Used by the telegram
 * wrappers so they share the same scope-based code path (and cache key) as
 * the dashboard endpoints — an optimize triggered from one surface can be
 * applied from the other.
 */
async function scopeFromChatId(chatId: string): Promise<DashboardScope> {
  const [
    userSettings,
  ] = await localDb.select().from(settings).where(eq(settings.telegramChatId, chatId)).limit(1)
  return {
    userId: userSettings?.userId || null,
    chatIds: [
      chatId,
    ],
  }
}

/**
 * PURE: compute portfolio rotations for a dashboard scope (userId + chatIds).
 * Returns the structured {@link RotationResult} + the resolved
 * `scoreGainMultiplier` (needed by `formatRotationResult` downstream).
 * Caches the result keyed by scope so a subsequent `applyOptimizationActions`
 * on the same scope can find it.
 *
 * No Telegram sends — callers (telegram wrapper or dashboard endpoint) are
 * responsible for any user-facing rendering. Returns `null` when config is
 * broken (missing scoreGainMultiplier) or the scope has no settings row.
 */
export async function computePortfolioRotations(scope: DashboardScope): Promise<{
  rotationResult: RotationResult
  scoreGainMultiplier: number
  usedFallback: boolean
} | null> {
  // Settings: prefer the userId's row, else any chat row in scope.
  const settingsConds = []
  if (scope.userId) settingsConds.push(eq(settings.userId, scope.userId))
  if (scope.chatIds.length > 0) settingsConds.push(inArray(settings.telegramChatId, scope.chatIds))
  if (settingsConds.length === 0) return null
  const [
    userSettings,
  ] = await localDb.select().from(settings).where(or(...settingsConds)).limit(1)
  if (!userSettings) return null

  // Active trades across the entire scope (dashboard identity: key → userId →
  // one portfolio, regardless of which chat/device created the row).
  const tradeConds = []
  if (scope.userId) tradeConds.push(eq(trades.userId, scope.userId))
  if (scope.chatIds.length > 0) tradeConds.push(inArray(trades.chatId, scope.chatIds))
  const activeTrades = tradeConds.length > 0
    ? await localDb.select().from(trades).where(or(...tradeConds))
    : []

  const apiKey = userSettings.quantourApiKey || ''
  const budget = await getUserBudget(localDb, userSettings?.userId)
  // Money model: budget = deployed(market) + free cash. Total capital anchors
  // to the configured budget, never the running portfolioStats.
  const totalCapital = userSettings ? parseFloat(budget.totalCapital) : 30000
  const risk = userSettings ? budget.maxRiskPerTradeUsd : 300
  const invested = await computeDeployedMarketValue(activeTrades, userSettings?.telegramChatId || undefined)
  const cash = Math.max(0, totalCapital - invested)
  const total = totalCapital

  const portfolioForApi: RotationAsset[] = activeTrades.map(t => {
    const createdAtTime = t.entryDate ? new Date(t.entryDate).getTime() : Date.now()
    const daysHeld = Math.max(0, Math.floor((Date.now() - createdAtTime) / (1000 * 60 * 60 * 24)))
    const capDeployed = parseFloat(t.capitalDeployed || '0')
    const entryPx = parseFloat(t.entry || '0')
    const shares = capDeployed > 0 && entryPx > 0 ? Math.round((capDeployed / entryPx) * 100) / 100 : 1
    return {
      ticker: t.ticker,
      entry: entryPx,
      target: parseFloat(t.target),
      stopLoss: parseFloat(t.stopLoss),
      strategy: t.strategyName || 'N/A',
      currentPrice: entryPx,
      daysHeld,
      shares,
      capitalDeployed: capDeployed,
    }
  })

  const lookupChatId = scope.chatIds[0]
  const tickers = portfolioForApi.map(p => p.ticker)
  const quotes = await getQuotesBatch(tickers, lookupChatId)
  const quoteMap = new Map<string, number>()
  for (const q of quotes) {
    if (q && q.symbol && q.price) quoteMap.set(q.symbol, q.price)
  }
  for (const p of portfolioForApi) {
    if (quoteMap.has(p.ticker)) {
      p.currentPrice = quoteMap.get(p.ticker)!
    }
  }

  const { config } = await import('~/config')
  let setups: Array<{ ticker: string; entry: number; target: number; stopLoss: number; strategy: string; currentPrice: number; expectedRPerDay?: number; firedBranchName?: string }> = []

  const response = await fetch(`${config.PUBLIC_API_URL}/v1/signals`, {
    signal: AbortSignal.timeout(5000),
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'x-api-key': apiKey,
      'Connection': 'close',
    },
  }).catch(() => null)

  const setupsData = response && response.ok ? await response.json().catch(() => ({ signals: [] })) : null
  if (setupsData && Array.isArray(setupsData.signals) && setupsData.signals.length > 0) {
    setups = setupsData.signals.map((s: Record<string, unknown>) => ({
      ticker: String(s.ticker || ''),
      entry: parseFloat(String(s.entry || '0')),
      target: parseFloat(String(s.target || '0')),
      stopLoss: parseFloat(String(s.stopLoss || '0')),
      strategy: String(s.strategyName || 'QUANT_SIGNAL'),
      currentPrice: parseFloat(String(s.entry || '0')),
      // Phase 3+ EV fields — surfaced via /v1/signals so cold-cache
      // /optimize can honor rotationScoring:'ev'. Parsed defensively since
      // older API responses (and the column-null cases) won't include them.
      expectedRPerDay: s.expectedRPerDay !== undefined && s.expectedRPerDay !== null
        ? parseFloat(String(s.expectedRPerDay))
        : undefined,
      firedBranchName: s.firedBranchName ? String(s.firedBranchName) : undefined,
    }))
  }

  if (setups.length === 0 && lookupChatId) {
    const { scanCacheMap } = await import('../clientScanner')
    const cachedScan = scanCacheMap.get(lookupChatId)
    if (cachedScan && cachedScan.setups && cachedScan.setups.length > 0) {
      setups = cachedScan.setups.map(s => ({
        ticker: s.ticker,
        entry: s.entry,
        target: s.target,
        stopLoss: s.stopLoss,
        strategy: s.strategy || 'AI_COMBINED',
        currentPrice: s.entry,
        // Thread EV/day + firedBranchName so recommendPortfolioRotations can
        // honor rotationScoring:'ev'. Falls through undefined when absent —
        // ranker then falls back to OpportunityScore (legacy behavior).
        expectedRPerDay: s.expectedRPerDay,
        firedBranchName: s.firedBranchName,
      }))
    }
  }
  if (setups.length > 0) {
    const setupTickers = setups.map(s => s.ticker)
    const setupQuotes = await getQuotesBatch(setupTickers, lookupChatId)
    const setupQuoteMap = new Map<string, number>()
    for (const q of setupQuotes) {
      if (q && q.symbol && q.price && q.price > 0) {
        setupQuoteMap.set(q.symbol, q.price)
      }
    }
    setups = setups.filter(s => {
      if (setupQuoteMap.has(s.ticker)) {
        const livePx = setupQuoteMap.get(s.ticker)!
        s.entry = livePx
        s.currentPrice = livePx
        if (s.stopLoss <= 0 || s.stopLoss >= livePx) {
          s.stopLoss = Number((livePx * 0.90).toFixed(2))
        }
        if (s.target <= livePx) {
          s.target = Number((livePx * 1.30).toFixed(2))
        }
        return true
      }
      logger.warn({ ticker: s.ticker }, '[OPTIMIZE_SAFETY] Dropping candidate setup without verified live price')
      return false
    })
  }

  // Read rotationRules from the USER's mainStrategyAst, not from the global
  // customStrategies table which may be stale or empty. Without this,
  // scoreGainMultiplier and rotationScoring never reach the rotation engine →
  // formatRotationResult falls back to the hardcoded default.
  //
  // Zod-validated runtime type safety — never blind `as`
  // casts on untrusted JSON from the DB.
  const RotationRulesSchema = z.object({
    enabled: z.boolean().optional(),
    scoreGainMultiplier: z.number({ error: 'scoreGainMultiplier is required — configure rotationRules in your strategy AST' }),
    minScoreDiff: z.number().optional(),
    minCandidateScore: z.number().optional(),
    minHoldingDays: z.number().optional(),
    branchMinHoldingDays: z.record(z.string(), z.number()).optional(),
    maxHoldingDays: z.number().optional(),
    rotationCooldownDays: z.number().optional(),
    protectWinnerProfitPercent: z.number().optional(),
    excludedSectors: z.array(z.string()).optional(),
    excludedIndustries: z.array(z.string()).optional(),
    onlyExcludeInRiskOff: z.boolean().optional(),
    allowCashDeployment: z.boolean().optional(),
    maxPortfolioPositions: z.number().optional(),
    rotationScoring: z.enum([
      'score',
      'efficiency',
      'ev',
    ]).optional(),
    sellNewsGate: z.enum([
      'off',
      'require_score',
      'require_score_hold_dip',
    ]).optional(),
    weights: z.object({
      w_rr: z.number().optional(),
      w_s: z.number().optional(),
      w_m: z.number().optional(),
      w_t: z.number().optional(),
    }).optional(),
  }).passthrough()

  const AstRotationRulesSchema = z.object({
    rotationRules: RotationRulesSchema,
  }).passthrough()

  let rotationRules: RotationRules | undefined
  let scoreGainMultiplier: number | undefined
  let astStrategyName: string | undefined

  if (userSettings.mainStrategyAst) {
    const parsed = AstRotationRulesSchema.safeParse(JSON.parse(userSettings.mainStrategyAst as string))
    if (parsed.success) {
      rotationRules = parsed.data.rotationRules
      scoreGainMultiplier = parsed.data.rotationRules.scoreGainMultiplier
      astStrategyName = typeof parsed.data.strategyName === 'string' ? parsed.data.strategyName : undefined
    } else {
      logger.warn({ scope, error: parsed.error.flatten() }, '[OPTIMIZE] mainStrategyAst missing required rotationRules.scoreGainMultiplier — falling through to customStrategies')
    }
  }

  // Fallback: try the global customStrategies table if user settings lack a valid AST
  if (!rotationRules) {
    const [
      customStrat,
    ] = await localDb.select().from(customStrategies).limit(1)
    if (customStrat && customStrat.astJson) {
      const parsed = AstRotationRulesSchema.safeParse(JSON.parse(customStrat.astJson))
      if (parsed.success) {
        rotationRules = parsed.data.rotationRules
        scoreGainMultiplier = parsed.data.rotationRules.scoreGainMultiplier
        astStrategyName = typeof parsed.data.strategyName === 'string' ? parsed.data.strategyName : undefined
      }
    }
  }

  if (!rotationRules) {
    rotationRules = {
      enabled: true,
      scoreGainMultiplier: 2.5,
      onlyExcludeInRiskOff: true,
    }
  } else if (rotationRules.onlyExcludeInRiskOff === undefined) {
    rotationRules.onlyExcludeInRiskOff = true
  }

  // scoreGainMultiplier is mandatory for formatRotationResult. If both the
  // user's AST and the customStrategies fallback failed to provide it, the
  // user's config is broken — surface the error rather than silently using
  // a wrong default.
  if (!scoreGainMultiplier) {
    scoreGainMultiplier = rotationRules.scoreGainMultiplier
  }
  if (!scoreGainMultiplier) {
    logger.error({ scope }, '[OPTIMIZE] No scoreGainMultiplier found in user AST or customStrategies — config is broken')
    return null
  }

  let usedFallback = false

  if (setups.length === 0) {
    // Fallback candidates from LIVE quotes when the signal pipeline is empty
    // (market closed / scan pending / engine degraded). NOT a fabricated-price
    // fallback: prices are verified live quotes, and stops are derived from
    // REAL volatility data — the quote's intraday range as a 2.5x-ATR proxy
    // (mirrors the AST stopLossAtrMultiplier), with a conservative 10% stop as
    // the absolute last resort when no range is present. Candidates whose
    // stop would be degenerate (at/above price) are dropped. These stops flow
    // through PortfolioAction threading into applied trades, so they must be
    // real-data-based — never hardcoded constants.
    const defaultCandidateTickers = [
      'NVDA',
      'AVGO',
      'MSFT',
      'AAPL',
      'AMZN',
      'META',
      'PLTR',
    ]
    const defaultQuotes = await getQuotesBatch(defaultCandidateTickers, lookupChatId)
    for (const q of defaultQuotes) {
      if (!q || !q.symbol || !q.price || q.price <= 0) continue
      const livePx = q.price
      const dayRange = q.dayHigh && q.dayLow ? q.dayHigh - q.dayLow : 0
      const stop = dayRange > 0
        ? Number((livePx - 2.5 * dayRange).toFixed(2))
        : Number((livePx * 0.90).toFixed(2))
      const risk = livePx - stop
      if (risk <= 0 || stop >= livePx) {
        logger.warn({ ticker: q.symbol, price: livePx, stop }, '[OPTIMIZE_FALLBACK] Dropping degenerate fallback candidate')
        continue
      }
      setups.push({
        ticker: q.symbol,
        entry: livePx,
        currentPrice: livePx,
        stopLoss: stop,
        target: Number((livePx + 3 * risk).toFixed(2)),
        strategy: 'AI_COMBINED',
      })
    }
    usedFallback = setups.length > 0
  }

  if (setups.length === 0) {
    // NO fabricated fallback (Financial & Price Safety mandate): the rotation
    // engine must only compare REAL market setups. The prior fallback invented
    // candidates from a hardcoded ticker list with dummy 10% stops — those
    // produced misleading "already optimal" verdicts when the signal pipeline
    // was empty, AND (via PortfolioAction stop threading) would have persisted
    // fake stops on real trades had a rotation fired.
    const rotationResult: RotationResult = {
      rotations: [],
      targetPortfolio: [],
      actions: [],
      rationale: 'NO_SETUPS',
    }
    optimizeCache.set(scopeCacheKey(scope), {
      concise: '',
      detailed: '',
      rotationResult,
    })
    return { rotationResult, scoreGainMultiplier, usedFallback: false }
  }

  const scores: Record<string, { newsScore?: number; insiderScore?: number }> = {}
  try {
    const MetricItem = z.object({
      ticker: z.string().optional(),
      newsScore: z.coerce.number().nullish(),
      insiderScore: z.coerce.number().nullish(),
      sma20: z.coerce.number().nullish(),
    }).passthrough()
    const metricsRes = await fetchFromApi(
      '/metrics',
      z.union([
        z.array(MetricItem),
        z.object({ data: z.array(MetricItem).optional() }).passthrough(),
      ]).catch({ data: [] }),
      {
        method: 'POST',
        body: JSON.stringify({ tickers }),
      },
      lookupChatId,
    ).catch(() => null)
    const metricItems = Array.isArray(metricsRes) ? metricsRes : (metricsRes?.data ?? [])
    for (const m of metricItems) {
      const tkr = String(m.ticker ?? '').toUpperCase()
      if (!tkr) continue
      if (m.newsScore != null) scores[tkr] = { ...scores[tkr], newsScore: m.newsScore }
      if (m.insiderScore != null) scores[tkr] = { ...scores[tkr], insiderScore: m.insiderScore }
      const asset = portfolioForApi.find(p => p.ticker.toUpperCase() === tkr)
      if (asset && m.sma20 != null) asset.sma20 = m.sma20
    }
  } catch (e) {
    logger.warn({ error: e }, '[OPTIMIZE] metrics fetch failed — sellNewsGate fail-opens this cycle')
  }

  const rotationResult = recommendPortfolioRotations({
    portfolio: portfolioForApi,
    setups,
    scores,
    budget: { total, risk, cash },
    chatId: lookupChatId,
    rotationRules,
  })

  // [ROTATION_VETO] sellNewsGate evidence trail (hypothesis #9c): the gate
  // vetoes SWAPs silently inside the screener, and container stdout dies on
  // restart — so log AND persist each activation to the central
  // rotation_gate_events store (VETO_BLOCK / SELL_NEWS). Fail-soft: telemetry
  // must never break the optimize flow.
  if (rotationResult.sellNewsVetoes?.length) {
    logger.info({
      count: rotationResult.sellNewsVetoes.length,
      sample: rotationResult.sellNewsVetoes.slice(0, 3),
    }, '[ROTATION_VETO] sellNewsGate blocked optimize sells this cycle')
    try {
      const { config: cfg } = await import('~/config')
      await fetch(`${cfg.PUBLIC_API_URL}/api/v1/market/rotation-gates`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          events: rotationResult.sellNewsVetoes.map(e => ({
            kind: 'VETO_BLOCK',
            vetoType: 'SELL_NEWS',
            ticker: e.ticker,
            newsScore: e.newsScore,
            priceAtSignal: e.price,
            strategyName: astStrategyName,
            chatId: lookupChatId || undefined,
          })),
        }),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (e) {
      logger.warn({ error: e }, '[ROTATION_VETO] sellNewsGate event POST failed (non-fatal)')
    }
  }

  // Cache the structured result for the subsequent apply step. concise/detailed
  // (Telegram-formatted HTML) are filled in by the telegram wrapper when it
  // calls formatRotationResult; the dashboard endpoint leaves them empty.
  optimizeCache.set(scopeCacheKey(scope), {
    concise: '',
    detailed: '',
    rotationResult,
  })

  return { rotationResult, scoreGainMultiplier, usedFallback }
}

/**
 * Locate the first active trade row for `ticker` within `scope`. Used by
 * applyOptimizationActions to route SELL/TRIM to the owning chatId —
 * necessary because the engine produces one rotation per ticker without
 * saying which chat row holds it. Documented limitation: if two sibling
 * chats both hold the same ticker, only the first match is acted on.
 */
async function findScopedTradeByTicker(ticker: string, scope: DashboardScope) {
  const scopeConds = []
  if (scope.userId) scopeConds.push(eq(trades.userId, scope.userId))
  if (scope.chatIds.length > 0) scopeConds.push(inArray(trades.chatId, scope.chatIds))
  if (scopeConds.length === 0) return null
  const result = await localDb.select().from(trades)
    .where(and(eq(trades.ticker, ticker.toUpperCase()), or(...scopeConds)))
    .limit(1)
  return result[0] || null
}

/**
 * PURE: execute the cached optimization's actions against the dashboard scope.
 * SELL/TRIM route to the chatId of the first matching trade in scope; BUY
 * uses the first chatId in scope (typically 'dashboard_user' for the
 * chat-less instance row). No Telegram sends — returns a structured result.
 */
export async function applyOptimizationActions(scope: DashboardScope): Promise<{
  success: boolean
  applied: number
  error?: string
}> {
  const cacheKey = scopeCacheKey(scope)
  const cached = optimizeCache.get(cacheKey)
  if (!cached || !cached.rotationResult || !cached.rotationResult.actions || cached.rotationResult.actions.length === 0) {
    return { success: false, applied: 0, error: 'NO_CACHED_RESULT' }
  }

  const lang: Language = 'en'
  const actions = cached.rotationResult.actions
  let applied = 0
  for (const action of actions) {
    if (action.type === 'SELL') {
      const trade = await findScopedTradeByTicker(action.ticker, scope)
      if (trade && trade.chatId) {
        await removeTrackedStock(
          action.ticker,
          trade.chatId,
          action.price,
          'OPTIMIZATION_APPLY',
          lang,
        )
        applied++
      }
    } else if (action.type === 'TRIM') {
      const trade = await findScopedTradeByTicker(action.ticker, scope)
      if (trade && trade.chatId) {
        const curCapital = parseFloat(trade.capitalDeployed || '0')
        const curEntry = parseFloat(trade.entry || '0')
        const curShares = curEntry > 0 ? curCapital / curEntry : 1
        const newShares = Math.max(0, curShares - action.shares)
        if (newShares === 0) {
          await removeTrackedStock(
            action.ticker,
            trade.chatId,
            action.price,
            'OPTIMIZATION_APPLY',
            lang,
          )
        } else {
          const newCapital = newShares * curEntry
          await localDb.update(trades).set({
            capitalDeployed: newCapital.toString(),
            riskAmountUsd: (newShares * parseFloat(trade.riskPerShare || trade.risk || '1')).toString(),
          }).where(eq(trades.id, trade.id))
        }
        applied++
      }
    } else if (action.type === 'BUY') {
      // BUY routes to the instance chatId (or 'dashboard_user' fallback,
      // matching /api/trades/buy). scope.chatIds[0] is 'dashboard_user'
      // when the instance row is chat-less — see dashboardIdentity.ts.
      const targetChatId = scope.chatIds[0] || 'dashboard_user'
      const ok = await handlePortfolioAdd(
        action.ticker,
        action.shares,
        targetChatId,
        lang,
        {
          entry: action.entry,
          stopLoss: action.stopLoss,
          target: action.target,
          strategy: action.strategy,
          firedBranchName: action.firedBranchName,
        },
      )
      if (ok) applied++
    }
  }

  optimizeCache.delete(cacheKey)
  return { success: true, applied }
}

export async function handlePortfolioRotations(chatId?: string) {
  if (!chatId) return

  const lang = await getChatLanguage(chatId)
  await ensurePortfolioInitialized(chatId)

  const scope = await scopeFromChatId(chatId)
  let result
  try {
    result = await computePortfolioRotations(scope)
  } catch (err) {
    logger.error({ error: err }, '[BOT] Failed to call rotations api')
    await sendGenericMessage(t('ERR_PROCESSING', lang), undefined, chatId)
    return
  }
  if (!result) {
    await sendGenericMessage(t('ERR_PROCESSING', lang), undefined, chatId)
    return
  }

  const { rotationResult, scoreGainMultiplier, usedFallback } = result
  let conciseMsg = formatRotationResult(rotationResult, lang, scoreGainMultiplier)
  // HONESTY: when the signal pipeline was empty and the engine ran on
  // generic quote-based fallback candidates, say so — otherwise the target
  // portfolio looks like strategy recommendations it is not (/scan may
  // simultaneously report no signals).
  if (usedFallback && rotationResult.rationale !== 'NO_SETUPS') {
    conciseMsg = `${t('OPTIMIZATION_FALLBACK_NOTICE', lang)}\n\n${conciseMsg}`
  }
  const hasRotations = rotationResult.rotations.length > 0 || (rotationResult.actions && rotationResult.actions.length > 0)

  // Backfill the cache entry with the Telegram-formatted concise/detailed
  // strings so /optimize_details can render them.
  const cacheKey = scopeCacheKey(scope)
  const existing = optimizeCache.get(cacheKey)
  if (existing) {
    optimizeCache.set(cacheKey, {
      ...existing,
      concise: conciseMsg,
      detailed: conciseMsg,
    })
  }

  if (hasRotations) {
    const detailsBtn = t('OPTIMIZATION_DETAILS_BTN', lang)
    const inline_keyboard: Array<Array<{ text: string; callback_data: string }>> = [
      [
        { text: detailsBtn, callback_data: 'optimize_details' },
      ],
    ]
    if (rotationResult.actions && rotationResult.actions.length > 0) {
      inline_keyboard.push([
        { text: t('APPLY_OPTIMIZATION_BTN', lang), callback_data: 'apply_optimization' },
      ])
    }

    await sendGenericMessage(conciseMsg, { inline_keyboard }, chatId)
  } else {
    await sendGenericMessage(conciseMsg, undefined, chatId)
  }
}

export async function handleOptimizeDetails(chatId?: string) {
  if (!chatId) return
  const lang = await getChatLanguage(chatId)
  const scope = await scopeFromChatId(chatId)
  const cached = optimizeCache.get(scopeCacheKey(scope))
  if (!cached || !cached.detailed) {
    await sendGenericMessage(t('OPTIMIZATION_NO_CACHED_DETAILS', lang),
      undefined,
      chatId)
    return
  }
  await sendGenericMessage(cached.detailed, undefined, chatId)
}

export async function handleApplyOptimization(chatId?: string) {
  if (!chatId) return
  const lang = await getChatLanguage(chatId)
  const scope = await scopeFromChatId(chatId)
  const result = await applyOptimizationActions(scope)
  if (!result.success) {
    await sendGenericMessage(t('OPTIMIZATION_NO_CACHED_RESULT', lang), undefined, chatId)
    return
  }
  await sendGenericMessage(t('OPTIMIZATION_APPLIED_SUCCESS', lang), undefined, chatId)
}

const PREVIEW_ACCOUNT_ID = 'PREVIEW_ACCOUNT'
const PREVIEW_ACCOUNT_STANDARD_AGGRESSIVE = 'PREVIEW_ACCOUNT_STANDARD_AGGR'
const PREVIEW_ACCOUNT_STANDARD_CONSERVATIVE = 'PREVIEW_ACCOUNT_STANDARD_CONS'

const INITIAL_TEST_PORTFOLIO = 30000

 
export async function ensurePreviewAccountInitialized() {
  const accountsToInit = [
    PREVIEW_ACCOUNT_ID,
    PREVIEW_ACCOUNT_STANDARD_AGGRESSIVE,
    PREVIEW_ACCOUNT_STANDARD_CONSERVATIVE,
  ]

  
  for (const accountId of accountsToInit) {
    const existing = await localDb.select().from(portfolioStats).where(eq(portfolioStats.chatId, accountId)).limit(1)
    if (existing.length === 0) {
      await localDb.insert(portfolioStats).values({
        chatId: accountId,
        initialCapital: INITIAL_TEST_PORTFOLIO.toString(),
        currentCapital: INITIAL_TEST_PORTFOLIO.toString(),
        dailyStartingCapital: INITIAL_TEST_PORTFOLIO.toString(),
        weeklyStartingCapital: INITIAL_TEST_PORTFOLIO.toString(),
        monthlyStartingCapital: INITIAL_TEST_PORTFOLIO.toString(),
      })
    }
  }
}

export async function handleResetPreview(amount: number, chatId: string, targetPreviewAccountId: string = PREVIEW_ACCOUNT_ID) {
   
  const lang = await getChatLanguage(chatId)
  await localDb.delete(trades).where(eq(trades.chatId, targetPreviewAccountId))
  await localDb.update(portfolioStats).set({
    initialCapital: amount.toString(),
    currentCapital: amount.toString(),
    dailyStartingCapital: amount.toString(),
    weeklyStartingCapital: amount.toString(),
    monthlyStartingCapital: amount.toString(),
    isMarginCalled: false,
  }).where(eq(portfolioStats.chatId, targetPreviewAccountId))
  await sendGenericMessage(t('PREVIEW_ACCOUNT_RESET', lang, { id: targetPreviewAccountId, amount: amount.toLocaleString() }), undefined, chatId)
}

/**
 * Market value of the held positions: Σ shares × current price. Shares are
 * derived from cost basis (capitalDeployed / entry). A ticker without a live
 * quote falls back to its cost basis — honest degradation, never a fabricated
 * price (price-safety mandate). The single deployed computation for ALL money
 * surfaces: buy gating, /budget, /status, dashboard, optimize.
 */
export async function computeDeployedMarketValue(positions: Array<{ ticker: string; entry: number | string; capitalDeployed: number | string }>,
  chatId?: string): Promise<number> {
  if (positions.length === 0) return 0
  const tickers = [
    ...new Set(positions.map((t) => t.ticker)),
  ]
  const quotes = await getQuotesBatch(tickers, chatId)
  const priceMap = new Map(quotes.map((q) => [
    q.symbol,
    q.price,
  ]))
  return positions.reduce((sum, t) => {
    const entry = parseFloat(String(t.entry))
    const cost = parseFloat(String(t.capitalDeployed || '0'))
    if (!isFinite(cost) || cost <= 0) return sum
    const price = priceMap.get(t.ticker)
    if (price && price > 0 && entry > 0) {
      return sum + (cost / entry) * price
    }
    return sum + cost
  }, 0)
}

/**
 * Free cash for ONE account: configured budget − market value of holdings.
 * The budget identity (budget = deployed + free cash) — computed live, never
 * stored. Account-scoped via loadTrackedStocks (chatId OR userId) so sibling
 * chats and the dashboard see the same number.
 */
export async function getAvailableCash(chatId: string): Promise<number> {
  const userSettings = (await localDb.select().from(settings).where(eq(settings.telegramChatId, chatId)).limit(1))[0]
  const budget = await getUserBudget(localDb, userSettings?.userId)
  const totalCapital = parseFloat(budget.totalCapital) || 0

  const tracked = await loadTrackedStocks(chatId, userSettings?.userId ?? undefined)
  const deployed = await computeDeployedMarketValue(tracked, chatId)
  return Math.max(0, totalCapital - deployed)
}

export async function handlePreviewStatus(chatId: string) {
   
  const lang = await getChatLanguage(chatId)
  await ensurePreviewAccountInitialized()
  const stats = (await localDb.select().from(portfolioStats).where(eq(portfolioStats.chatId, PREVIEW_ACCOUNT_ID)).limit(1))[0]
  if (!stats) return
  
  const tracked = await localDb.select().from(trades).where(eq(trades.chatId, PREVIEW_ACCOUNT_ID))
  const currentCapital = parseFloat(stats.currentCapital)
  const deployed = tracked.reduce((sum, s) => sum + (parseFloat(s.capitalDeployed?.toString() || '0')), 0)
  const available = Math.max(0, currentCapital - deployed)
  
  let msg = `${t('PREVIEW_STATUS_TITLE', lang)}\n\n`
  msg += `💰 <b>${t('PREVIEW_CAPITAL', lang)}: $${currentCapital.toLocaleString(undefined, { minimumFractionDigits: 2 })}</b>\n`
  msg += `💵 <b>${t('PREVIEW_AVAILABLE', lang)}: $${available.toLocaleString(undefined, { minimumFractionDigits: 2 })}</b>\n\n`

  if (tracked.length > 0) {
    msg += `<b>${t('PREVIEW_ACTIVE_POSITIONS', lang, { count: tracked.length })}:</b>\n`
    for (const t of tracked) {
      msg += `• <b>${t.ticker}</b>: $${parseFloat(t.entry).toFixed(2)} -> SL: $${parseFloat(t.stopLoss).toFixed(2)}\n`
    }
  } else {
    msg += `<i>${t('PREVIEW_NO_POSITIONS', lang)}</i>`
  }
  await sendGenericMessage(local(msg), undefined, chatId)
}

export async function handlePreviewAllStatus(chatId: string) {
   
  const lang = await getChatLanguage(chatId)
  await ensurePreviewAccountInitialized()
  
  const accounts = [
    { id: PREVIEW_ACCOUNT_ID, label: 'AI Strategy (Conservative)' },
    { id: PREVIEW_ACCOUNT_STANDARD_CONSERVATIVE, label: 'Standard (Conservative)' },
    { id: PREVIEW_ACCOUNT_STANDARD_AGGRESSIVE, label: 'Standard (Aggressive)' },
  ]

  let msg = `<b>${t('PREVIEW_ALL_TITLE', lang)}</b>\n\n`

  for (const acc of accounts) {
    const stats = (await localDb.select().from(portfolioStats).where(eq(portfolioStats.chatId, acc.id)).limit(1))[0]
    if (!stats) continue
    
    const tracked = await localDb.select().from(trades).where(eq(trades.chatId, acc.id))
    const currentCapital = parseFloat(stats.currentCapital)
    const deployed = tracked.reduce((sum, s) => sum + (parseFloat(s.capitalDeployed?.toString() || '0')), 0)
    const available = Math.max(0, currentCapital - deployed)
    const pnl = currentCapital - INITIAL_TEST_PORTFOLIO
    const pnlPerc = (pnl / INITIAL_TEST_PORTFOLIO) * 100
    
    const pnlSign = pnl >= 0 ? '+' : ''
    msg += `📊 <b>${acc.label}</b>\n`
    msg += `💰 <b>${t('PREVIEW_CAPITAL', lang)}: $${currentCapital.toLocaleString(undefined, { minimumFractionDigits: 2 })}</b> (${pnlSign}$${pnl.toFixed(2)} | ${pnlSign}${pnlPerc.toFixed(2)}%)\n`
    msg += `💵 <b>${t('PREVIEW_AVAILABLE', lang)}: $${available.toLocaleString(undefined, { minimumFractionDigits: 2 })}</b>\n`
    msg += `${t('PREVIEW_ACTIVE_POSITIONS', lang, { count: tracked.length })}\n\n`
  }
  
  await sendGenericMessage(local(msg), undefined, chatId)
}

export async function getBenchmarkReturns(_type: 'DAILY' | 'WEEKLY' | 'MONTHLY') {
  return { spy: 0, qqq: 0 } // Stub
}

export async function reportPreviewPnL(type: 'DAILY' | 'WEEKLY' | 'MONTHLY') {
  await ensurePreviewAccountInitialized()
  const stats = (await localDb.select().from(portfolioStats).where(eq(portfolioStats.chatId, PREVIEW_ACCOUNT_ID)).limit(1))[0]
  if (!stats) return
  
  const current = parseFloat(stats.currentCapital)
  let start = current
  if (type === 'DAILY') start = parseFloat(stats.dailyStartingCapital || stats.initialCapital)
  if (type === 'WEEKLY') start = parseFloat(stats.weeklyStartingCapital || stats.initialCapital)
  if (type === 'MONTHLY') start = parseFloat(stats.monthlyStartingCapital || stats.initialCapital)
  
  const pnlUsd = current - start
  const pnlPercent = start > 0 ? (pnlUsd / start) * 100 : 0

  await localDb.insert(pnlHistory).values({
    chatId: PREVIEW_ACCOUNT_ID,
    type,
    pnlAmount: pnlUsd.toString(),
    pnlPercent: pnlPercent.toString(),
  })
  
  if (type === 'DAILY') await localDb.update(portfolioStats).set({ dailyStartingCapital: current.toString() }).where(eq(portfolioStats.chatId, PREVIEW_ACCOUNT_ID))
  if (type === 'WEEKLY') await localDb.update(portfolioStats).set({ weeklyStartingCapital: current.toString() }).where(eq(portfolioStats.chatId, PREVIEW_ACCOUNT_ID))
  if (type === 'MONTHLY') await localDb.update(portfolioStats).set({ monthlyStartingCapital: current.toString() }).where(eq(portfolioStats.chatId, PREVIEW_ACCOUNT_ID))
}

export async function handleFreeCash(chatId: string, amount: number, lang?: Language) {
  if (!lang) lang = await getChatLanguage(chatId)
  const stats = (await localDb.select().from(portfolioStats).where(eq(portfolioStats.chatId, chatId)).limit(1))[0]
  if (!stats) {
    await sendGenericMessage(t('ERR_PORTFOLIO_NOT_INITIALIZED', lang), undefined, chatId)
    return
  }
  const newCapital = parseFloat(stats.currentCapital) + amount

  await localDb.update(portfolioStats).set({ currentCapital: newCapital.toString() }).where(eq(portfolioStats.chatId, chatId))
  const chatRow = (await localDb.select().from(settings).where(eq(settings.telegramChatId, chatId)).limit(1))[0]
  await setUserBudget(localDb, chatRow?.userId, { totalCapital: newCapital.toString() })

  await sendGenericMessage(t('FREE_CASH_ADDED', lang, { amount: newCapital.toLocaleString() }), undefined, chatId)
}

export async function handleBuy(params: {
  ticker: string
  entry: number
  sl: number
  tp: number
  strategy: string
  chatId: string
  riskOverride?: number
  lang?: Language
  isPreview?: boolean
  convictionMultiplier?: number
  firedBranchName?: string
}) {
  const {
    ticker, entry, sl, tp, strategy, chatId, riskOverride, isPreview,
  } = params
  const lang = params.lang || await getChatLanguage(chatId)

  try {
    const existing = await localDb.select().from(trades).where(and(eq(trades.chatId, chatId), eq(trades.ticker, ticker))).limit(1)
    if (existing.length > 0) return // Already tracked

    const availableCash = await getAvailableCash(chatId)
    const chatConfig = (await localDb.select().from(settings).where(eq(settings.telegramChatId, chatId)).limit(1))[0]
    const budget = await getUserBudget(localDb, chatConfig?.userId)

    // Calculate risk
    let maxRisk = riskOverride || budget.maxRiskPerTradeUsd
    // Apply conviction scaling (already clamped [0.25, 1.5] by calculateConvictionMultiplier
    // in the screener). Default 1.0 when the caller doesn't supply it (backward compatible).
    maxRisk = maxRisk * (params.convictionMultiplier ?? 1)
    
    const riskPerShare = entry - sl
    if (riskPerShare <= 0) return

    let shares = Math.round((maxRisk / riskPerShare) * 100) / 100
    let capitalRequired = shares * entry
    
    if (capitalRequired > availableCash) {
      shares = Math.round((availableCash / entry) * 100) / 100
      capitalRequired = shares * entry
    }

    if (shares <= 0) {
      if (!isPreview) await sendGenericMessage(t('ERR_INSUFFICIENT_FUNDS_FOR_TRADE', lang, { ticker }), undefined, chatId)
      return
    }

    await localDb.insert(trades).values({
      chatId,
      ticker,
      entry: entry.toString(),
      stopLoss: sl.toString(),
      target: tp.toString(),
      riskPerShare: riskPerShare.toString(),
      riskAmountUsd: (shares * riskPerShare).toString(),
      capitalDeployed: capitalRequired.toString(),
      strategyName: strategy,
      highestHigh: entry.toString(),
      entryDate: new Date(),
      firedBranchName: params.firedBranchName,
    })
    if (!isPreview) {
      // Telegram buy-callback cannot carry the branch (64-byte limit) — the
      // capture helper resolves it from the chat's scan cache.
      captureEntryThesis(ticker, chatId, params.firedBranchName).catch(err => {
        logger.warn({ error: err, ticker, chatId }, '[THESIS] Entry-thesis capture failed on buy')
      })
    }
    
    const msg = `🟢 <b>${t('EXECUTED_BUY_TITLE', lang, { ticker })}</b>\n` +
                `${t('LABEL_STRATEGY', lang)}: ${strategy}\n` +
                `${t('LABEL_ENTRY', lang)}: $${entry.toFixed(2)} | ${t('LABEL_SL', lang)}: $${sl.toFixed(2)} | ${t('LABEL_TP', lang)}: $${tp.toFixed(2)}\n` +
                `${t('LABEL_SHARES', lang)}: ${shares} | ${t('LABEL_CAPITAL', lang)}: $${capitalRequired.toFixed(2)}\n`
    
    if (!isPreview) {
      await sendGenericMessage(local(msg), undefined, chatId)
    }
  } catch (e) {
    logger.error({ error: e, ticker }, '[BUY] Execution failed')
  }
}

export async function handlePortfolioSell(ticker: string, chatId: string, _lang?: Language) {
  await removeTrackedStock(
    ticker, chatId, undefined, 'MANUAL_PORTFOLIO_SELL',
  )
}

export async function getConvictionMultiplierForTicker(_ticker: string, _strategyName: string, _maxRiskPerTrade: string): Promise<number> {
  return 1.0 // Stub for local version
}

export async function rebalancePortfolio(_chatId: string) {
  // Stub for local version
}

export async function triggerThesisValidationOnEntry(_ticker: string, _chatId: string, _lang?: Language) {
  // Stub for local version
}

export const handleManualAdd = handlePortfolioAdd
