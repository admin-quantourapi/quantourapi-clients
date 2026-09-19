
import {
  Language,t, 
} from '@quantour/shared-algo/src/core/i18n'
import { CustomStrategyAST } from '@quantour/shared-algo/src/finance-algo/ast'
import type { MarketData } from '@quantour/shared-algo/src/finance-algo/screener'
import { isThesisManagedPosition } from '@quantour/shared-algo/src/finance-algo/sleeveExemptions'
import { isNewsShockExit } from '@quantour/shared-algo/src/finance-algo/structuralThesis'
import { z } from 'zod'

import { db as localDb } from '~/db'
import { logger } from '~/services/logger'

import { config } from '../config'
import { settings } from '../db/clientSchema'

async function fetchFromApi(endpoint: string, options: RequestInit = {}, apiKey?: string) {
  try {
    const res = await fetch(`${config.PUBLIC_API_URL}/v1${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey || '',
        'Connection': 'close',
        ...(options.headers || {}),
      },
    })
    if (!res.ok) return null
    return await res.json()
  } catch (e) {
    logger.error({ error: e, endpoint }, '[API] fetchFromApi failed')
    return null
  }
}

import { calculateSellSignal } from '@quantour/shared-algo/src/finance-algo/sellSignalCalculator'

type TradedStock = Awaited<ReturnType<typeof import('./botHandlers/portfolioHandlers')['loadTrackedStocks']>>[number]

export async function checkTrackedExits(): Promise<{ chatId: string; messages: string[]; buttons: Record<string, unknown>[][] }[]> {
  const { loadTrackedStocks, updateTrackedStock } = await import('./botHandlers/portfolioHandlers')
  const tracked = await loadTrackedStocks()
  if (tracked.length === 0) return []

  const notifications = new Map<string, { chatId: string; messages: string[]; buttons: Record<string, unknown>[][] }>()
  function getNote(chatId: string): { chatId: string; messages: string[]; buttons: Record<string, unknown>[][] } {
    if (!notifications.has(chatId)) notifications.set(chatId, { chatId, messages: [], buttons: [] })
    return notifications.get(chatId)!
  }

  // Load every settings row once and index API keys by chatId AND userId so
  // each trade can be attributed to the account (key) that owns it. Trades
  // are then quote-checked with THEIR account's key instead of the first
  // valid key found globally — closes a cross-account leak on multi-user
  // instances where account A's positions were priced under account B's key.
  const allSettings = (await localDb.select().from(settings)) as (typeof settings.$inferSelect)[]
  const keyByChatId = new Map<string, string>()
  const keyByUserId = new Map<string, string>()
  for (const s of allSettings) {
    const k = s.quantourApiKey
    if (!k || typeof k !== 'string' || k.length <= 5) continue
    if (s.telegramChatId) keyByChatId.set(s.telegramChatId, k)
    if (s.userId) keyByUserId.set(s.userId, k)
  }

  const groups = new Map<string, TradedStock[]>()
  for (const stock of tracked) {
    if (!stock.chatId) continue
    const accountKey = keyByChatId.get(stock.chatId)
      ?? (stock.userId ? keyByUserId.get(stock.userId) : undefined)
    if (!accountKey) {
      logger.debug({ ticker: stock.ticker, chatId: stock.chatId }, '[EXIT_CHECK] No API key for trade account; skipping')
      continue
    }
    const arr = groups.get(accountKey)
    if (arr) arr.push(stock)
    else groups.set(accountKey, [
      stock,
    ])
  }

  for (const [
    apiKey,
    accountTracked,
  ] of groups) {
    await checkExitsForAccount(
      accountTracked, apiKey, allSettings, updateTrackedStock, getNote,
    )
  }
  return Array.from(notifications.values())
}

async function checkExitsForAccount(
  tracked: TradedStock[],
  apiKey: string,
  allSettings: (typeof settings.$inferSelect)[],
  updateTrackedStock: (stock: { id: number; stopLoss: number; highestHigh?: number; entry: number; isPartialTaken?: boolean }) => Promise<void>,
  getNote: (chatId: string) => { chatId: string; messages: string[]; buttons: Record<string, unknown>[][] },
): Promise<void> {
  const uniqueTickers = Array.from(new Set(tracked.map(t => t.ticker)))

  let metricsData: Record<string, unknown>[] = []
  try {
    const QuotesEnvelopeSchema = z.union([
      z.array(z.record(z.string(), z.unknown())),
      z.object({
        success: z.boolean().optional(),
        data: z.object({
          tickers: z.array(z.record(z.string(), z.unknown())).optional(),
        }).passthrough().optional(),
      }).passthrough(),
    ])
    const rawQuotes = await fetchFromApi(`/market/quotes?symbols=${encodeURIComponent(uniqueTickers.join(','))}`, {}, apiKey)
    const response = rawQuotes != null ? QuotesEnvelopeSchema.parse(rawQuotes) : null
    if (Array.isArray(response)) {
      metricsData = response
    } else if (response && typeof response === 'object' && 'data' in response && Array.isArray((response as { data?: { tickers?: Record<string, unknown>[] } }).data?.tickers)) {
      metricsData = (response as { data: { tickers: Record<string, unknown>[] } }).data.tickers!
    }
  } catch (e) {
    logger.error({ error: e }, '[EXIT_CHECK] Failed to fetch market quotes')
  }

  const metricsMap = new Map<string, Record<string, unknown>>()
  metricsData.forEach(d => {
    const tickerSymbol = d.symbol || d.ticker
    if (tickerSymbol && typeof tickerSymbol === 'string') {
      metricsMap.set(tickerSymbol, d)
    }
  })

  // ROTATION CONTEXT (rotation_conviction_v1) — one batched fetch for the
  // whole position set; feeds the SECTOR_ROTATION_TRIM velocity exit arm.
  // Fail-soft: a context fetch failure skips the arm for this cycle (a
  // missing context must never fabricate a trim signal).
  interface RotationEntry {
    rank?: number
    trend?: number
    ageDays?: number
    newsScore?: number
    sectorNewsTrend?: number
    sector?: string
  }
  const RotationContextSchema = z.object({
    context: z.record(
      z.string(),
      z.object({
        rank: z.coerce.number().nullish(),
        trend: z.coerce.number().nullish(),
        ageDays: z.coerce.number().nullish(),
        newsScore: z.coerce.number().nullish(),
        sectorNewsTrend: z.coerce.number().nullish(),
        sector: z.string().nullish(),
      }),
    ),
  })
  const rotationMap = new Map<string, RotationEntry>()
  // ROTATION GATE INSTRUMENTATION (rotation_conviction_v1): collected
  // TRIM_SIGNAL events, POSTed to the central store once per check (batched,
  // fail-soft — instrumentation must never break the exit pass).
  const trimEvents: Array<import('@quantour/shared-algo/src/finance-algo/rotationGateDiagnostics').RotationGateEvent> = []
  try {
    const raw = await fetch(`${config.API_URL}/api/v1/market/rotation-context?tickers=${encodeURIComponent(uniqueTickers.join(','))}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey || '',
      },
      signal: AbortSignal.timeout(30_000),
    }).catch((err) => {
      logger.warn({ error: err }, '[EXIT_CHECK] rotation-context fetch failed — trim arm skipped this cycle')
      return null
    })
    if (raw && raw.ok) {
      const parsed = RotationContextSchema.safeParse(await raw.json())
      if (parsed.success) {
        for (const [
          ticker,
          entry,
        ] of Object.entries(parsed.data.context)) {
          // Zod `.nullish()` parses to null|undefined — normalize to the
          // domain shape (absence typing: undefined = omit).
          rotationMap.set(ticker, {
            rank: entry.rank ?? undefined,
            trend: entry.trend ?? undefined,
            ageDays: entry.ageDays ?? undefined,
            newsScore: entry.newsScore ?? undefined,
            sectorNewsTrend: entry.sectorNewsTrend ?? undefined,
            sector: entry.sector ?? undefined,
          })
        }
      } else {
        logger.warn({ error: parsed.error.message }, '[EXIT_CHECK] rotation-context schema mismatch — trim arm skipped')
      }
    }
  } catch (e) {
    logger.warn({ error: e }, '[EXIT_CHECK] rotation-context fetch threw — trim arm skipped')
  }

  for (const stock of tracked) {
    if (!stock.chatId) continue
    try {
      let currentClose: number
      let currentHigh: number
      let currentLow: number
      let marketData: Record<string, unknown> | null = null

      const data = metricsMap.get(stock.ticker)
      if (data) {
        currentClose = Number(data.price || 0)
        currentHigh = Number(data.dayHigh || data.price || 0)
        currentLow = Number(data.dayLow || data.price || 0)
        marketData = {
          ...data,
          currentPrice: Number(data.price || 0),
          currentVolume: Number(data.volume || 0),
          // Real 52w high from the metrics payload when present; never
          // fabricate price-as-high.
          ...(data.fiftyTwoWeekHigh !== undefined ? { fiftyTwoWeekHigh: data.fiftyTwoWeekHigh } : {}),
        }
      } else {
        // Fallback to fetchFromApi /ticker/:ticker/info if metrics misses this symbol.
        // Uses THIS account's key (not the prior global key).
        const quoteRes = await fetchFromApi(`/ticker/${stock.ticker}/info`, {}, apiKey)
        const quote = quoteRes?.data?.quote
        if (!quote || !quote.price) continue

        currentClose = quote.price
        currentHigh = quote.dayHigh || currentClose
        currentLow = quote.dayLow || currentClose

        marketData = {
          ticker: stock.ticker,
          currentPrice: currentClose,
          ...(quote.yearHigh ? { fiftyTwoWeekHigh: quote.yearHigh } : {}),
          atr: stock.atr || 1,
          maxRisk: 300,
        }
      }

      const userSet = allSettings.find(s => s.telegramChatId === stock.chatId)
      let exitReason: string | null = null
      // Rotation context for this position (SECTOR_ROTATION_TRIM arm below).
      const rotationEntry = rotationMap.get(stock.ticker.toUpperCase())

      // AST-declared stop trigger semantics: default 'close'
      // (A/B-justified: ret 113.1 vs 77.6, maxDD better); the parsed AST below
      // may override per-strategy ('wick' = pessimistic resting-stop assumption).
      let astStopFillMode: 'wick' | 'close' = 'close'

      // Evaluate Custom AST Exit Logic
      let parsedAst: CustomStrategyAST | null = null
      if (userSet?.mainStrategyAst) {
        try {
          const ast: CustomStrategyAST = JSON.parse(userSet.mainStrategyAst as string) as CustomStrategyAST
          parsedAst = ast
          if (ast.riskManagement?.stopFillMode === 'wick' || ast.riskManagement?.stopFillMode === 'close') {
            astStopFillMode = ast.riskManagement.stopFillMode
          }
          if (ast.exitLogic) {
            const { AstEvaluator } = await import('@quantour/shared-algo/src/finance-algo/AstEvaluator')
            const isStrategyExit = AstEvaluator.evaluate(ast.exitLogic, marketData)
            if (isStrategyExit) {
              // Sleeve thesis-break arms (FCF NEGATIVE / IDIOSYNCRATIC_WEAKNESS)
              // live on the same global exitLogic OR. Velocity positions only
              // honor the news-shock subset; 🌱 honors the full node.
              const sleeve = isThesisManagedPosition(
                stock.firedBranchName ?? '',
                ast.rotationRules?.rotationExemptBranches,
              )
              if (sleeve || isNewsShockExit(marketData ?? {})) {
                exitReason = 'STRATEGY_LOGIC_SELL'
              }
            }
          }

          // Strategy handoff: proactively close profitable positions when their
          // original branch stops firing. Mirrors the backtest engine's
          // enableStrategyHandoff logic (sweep winner — Calmar 1.11 → 2.87).
          // Requires: AST flag set + persisted firedBranchName on the trade +
          // ≥1R profit captured + daysHeld > 5 (give thesis time) + the AST's
          // entryLogic no longer fires (re-evaluated against current data).
          // THESIS-MANAGED EXEMPTION (parity with the engine):
          // branches in rotationRules.rotationExemptBranches (structural
          // sleeve) are NOT handoff-eligible — their entry gates oscillate
          // day-to-day so branch non-firing is noise, not thesis decay; a
          // handoff here would churn slow theses out on fast signals.
          if (!exitReason
            && ast.riskManagement?.enableStrategyHandoff
            && stock.firedBranchName
            && !isThesisManagedPosition(stock.firedBranchName, ast.rotationRules?.rotationExemptBranches)
            && (stock.daysHeld || 0) > 5
            && ast.entryLogic) {
            const riskPerShare = Math.abs(stock.entry - stock.stopLoss)
            if (riskPerShare > 0) {
              const currentR = (currentClose - stock.entry) / riskPerShare
              const minR = ast.riskManagement.handoffMinProfitR ?? 1
              if (currentR >= minR && currentClose > stock.entry) {
                try {
                  const { evaluateSetup } = await import('@quantour/shared-algo/src/finance-algo/screener')
                  const freshSetups = marketData ? evaluateSetup(marketData as unknown as MarketData, { custom: ast }) : []
                  const originalBranchStillFiring = freshSetups.some(s => s.isValid && s.firedBranchName === stock.firedBranchName)
                  if (!originalBranchStillFiring) {
                    exitReason = 'STRATEGY_HANDOFF'
                    // TODO: review the first week of these alerts. The
                    // backtest sweep validated the C1 threshold, but live
                    // data carries the newsScore mock caveat so live handoff
                    // behavior may diverge. If firing too aggressively or on
                    // weird tickers, bump handoffMinProfitR from 1 → 2 in
                    // the strategy AST and re-run the sweep to confirm.
                    logger.info({
                      ticker: stock.ticker,
                      chatId: stock.chatId,
                      firedBranchName: stock.firedBranchName,
                      currentR: Number(currentR.toFixed(2)),
                      daysHeld: stock.daysHeld,
                      minR,
                      freshBranches: freshSetups.filter(s => s.isValid).map(s => s.firedBranchName),
                    }, '[HANDOFF] Strategy handoff fired — original branch no longer in fresh evaluation')
                  }
                } catch (e) {
                  logger.debug({ error: e, ticker: stock.ticker }, '[HANDOFF] Re-evaluation failed; skipping')
                }
              }
            }
          }
        } catch (e) {
          logger.error({ error: e }, 'Failed to parse AST for exit logic')
        }

        // SECTOR ROTATION TRIM (rotation_conviction_v1, review-hardened):
        // velocity-only exit candidate. Three legs:
        //   1. The sector's news baseline is COOLING (sectorNewsTrend <= -1.0,
        //      median drift over ~10 sector re-scores ≈ 2 weeks of prints).
        //      Asymmetry vs the entry veto (-1.5): sector scores oscillate
        //      ±1 window-to-window (the inertia noise band), so -1.0 on a
        //      sector ≈ the same evidence mass as -1.5 on a ticker — and the
        //      arm ALSO requires the second leg below, so a lone mild drift
        //      cannot fire it. Logged for FT review; tighten if it fires on
        //      noise.
        //   2. The position's own news conviction is mediocre (< 6) on the
        //      SAME live snapshot the entry gates read (tickers.newsScore,
        //      carry-inclusive — deliberately consistent with entry-path
        //      semantics; the gemini-only freshness lives in age/trend).
        //   3. HOLD FLOOR: daysHeld >= rotationRules.minHoldingDays (default
        //      20) — the same floor that fixed the FORCED_ROTATION churn
        //      (82% exits at 3-day holds harvesting recent buys near zero).
        //      daysHeld > 5 was review-rejected as a churn reopen.
        // Structural sleeve (🌱) is exempt — its thesis is managed by its own
        // break arms, not by fast signal decay. Fail-soft by design: any
        // missing input skips the arm (no fabricated trim signals from
        // partial data).
        if (!exitReason && rotationEntry && parsedAst) {
          const isStructural = isThesisManagedPosition(
            stock.firedBranchName ?? '',
            parsedAst.rotationRules?.rotationExemptBranches,
          )
          const trimFloor = parsedAst.rotationRules?.minHoldingDays ?? 20
          const sectorCooling = rotationEntry.sectorNewsTrend !== undefined
            && rotationEntry.sectorNewsTrend <= -1.0
          const ownConvictionWeak = rotationEntry.newsScore !== undefined
            && rotationEntry.newsScore < 6.0
          if (!isStructural && sectorCooling && ownConvictionWeak && (stock.daysHeld || 0) >= trimFloor) {
            exitReason = 'SECTOR_ROTATION_TRIM'
            trimEvents.push({
              kind: 'TRIM_SIGNAL',
              ticker: stock.ticker,
              branchName: stock.firedBranchName ?? undefined,
              trend: rotationEntry.sectorNewsTrend ?? undefined,
              rank: rotationEntry.rank ?? undefined,
              ageDays: rotationEntry.ageDays ?? undefined,
              newsScore: rotationEntry.newsScore ?? undefined,
              priceAtSignal: currentClose,
              rescued: false,
              chatId: stock.chatId ?? undefined,
            })
            logger.info({
              ticker: stock.ticker,
              chatId: stock.chatId,
              sectorNewsTrend: rotationEntry.sectorNewsTrend,
              newsScore: rotationEntry.newsScore,
              sector: rotationEntry.sector,
              daysHeld: stock.daysHeld,
              trimFloor,
              firedBranchName: stock.firedBranchName,
            }, '[ROTATION_TRIM] Sector cooling + weak own conviction — trim candidate')
          }
        }
      }

      // Check tech exits — stop trigger semantics come from the user's AST
      // (riskManagement.stopFillMode, default 'close' = close-through; the
      // day's wick low alone no longer force-exits a recovering position).
      // Live currentClose is the live quote, so 'close' here is
      // quote-through-at-check — between backtest wick and daily-close modes.
      const { exitReason: techExit, slMoved, updatedStock } = calculateSellSignal(
        stock, currentHigh, currentLow, currentClose, false, false, undefined, undefined, astStopFillMode,
      )

      if (!exitReason && techExit) {
        exitReason = techExit
      }

      if (slMoved) {
        await updateTrackedStock({
          id: stock.id,
          stopLoss: updatedStock.stopLoss,
          highestHigh: updatedStock.highestHigh,
          entry: updatedStock.entry,
          isPartialTaken: updatedStock.isPartialTaken,
        })
        getNote(stock.chatId).messages.push(`🛡️ <b>STOP LOSS UPDATE: ${stock.ticker}</b>\nNew Exit: <b>$${updatedStock.stopLoss.toFixed(2)}</b>`)
      }

      if (exitReason) {
        const chatLang = (userSet?.language as Language) || 'en'
        const note = getNote(stock.chatId)
        const isStopHit = exitReason.includes('STOP_LOSS')
        const isHandoff = exitReason === 'STRATEGY_HANDOFF'
        if (isStopHit) {
          note.messages.push(t('STOP_LOSS_HIT_ALERT', chatLang, { ticker: stock.ticker, sl: stock.stopLoss.toFixed(2) }))
        } else if (isHandoff) {
          // Thesis-decay handoff: original branch no longer fires, profit captured.
          // Surface as a partial-win alert (not a stop-loss) so the user understands
          // this is proactive capital recycling, not a defensive exit.
          const currentR = stock.stopLoss > 0
            ? ((currentClose - stock.entry) / Math.abs(stock.entry - stock.stopLoss)).toFixed(1)
            : 'N/A'
          note.messages.push(`🔁 <b>${t('SELL_SIGNAL_TITLE', chatLang, { ticker: stock.ticker })}</b> (Strategy Handoff)\n<b>${t('ACTION_SELL', chatLang)}</b>\nCaptured <b>${currentR}R</b> — original thesis no longer active, recycling capital.`)
        } else if (exitReason === 'SECTOR_ROTATION_TRIM' && rotationEntry) {
          // rotation_conviction_v1: sector cooling + mediocre own conviction —
          // capital is rotating elsewhere; this position is the stale side.
          const trendVal = rotationEntry.sectorNewsTrend?.toFixed(1) ?? 'N/A'
          note.messages.push(`🪃 <b>${t('SELL_SIGNAL_TITLE', chatLang, { ticker: stock.ticker })}</b> (Sector Rotation)\n<b>${t('ACTION_SELL', chatLang)}</b>\n${t('SECTOR_ROTATION_TRIM_NOTE', chatLang, { trend: trendVal, sector: rotationEntry.sector ?? '', score: rotationEntry.newsScore?.toFixed(1) ?? 'N/A' })}`)
        } else {
          note.messages.push(`📉 <b>${t('SELL_SIGNAL_TITLE', chatLang, { ticker: stock.ticker })}</b>\n<b>${t('ACTION_SELL', chatLang)}</b>\n<b>${t('REASON', chatLang)}:</b> ${exitReason}`)
        }
        if (!note.buttons) note.buttons = []
        note.buttons.push([
          { text: t('CONFIRM_SELL', chatLang, { ticker: stock.ticker }), callback_data: `sell:${stock.ticker}` },
        ])
      }
    } catch (e) {
      logger.error({ error: e, ticker: stock.ticker }, '[EXIT_CHECK] Failed to evaluate ticker')
    }
  }

  if (trimEvents.length > 0) {
    try {
      const res = await fetch(`${config.API_URL}/api/v1/market/rotation-gates`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey || '',
        },
        body: JSON.stringify({ events: trimEvents }),
        signal: AbortSignal.timeout(15_000),
      }).catch((err) => {
        logger.warn({ error: err }, '[EXIT_CHECK] rotation-gate event POST failed (non-fatal)')
        return null
      })
      if (res && !res.ok) {
        logger.warn({ status: res.status }, '[EXIT_CHECK] rotation-gate event POST rejected (non-fatal)')
      }
    } catch (e) {
      logger.warn({ error: e }, '[EXIT_CHECK] rotation-gate event POST threw (non-fatal)')
    }
  }
}
