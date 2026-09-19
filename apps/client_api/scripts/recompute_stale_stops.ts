/**
 * One-off repair for trades whose stop-loss was computed from the legacy
 * `atr = ... : 1` fallback (portfolioHandlers pre-fix), which produced
 * `stopLoss = entry - $2.50` regardless of price — so tight that the exit
 * monitor tripped on the first bid/ask fluctuation.
 *
 * Detects stale rows by EITHER:
 *   - persisted `atr == 1` (the literal fallback value), OR
 *   - stop within 1.5% of entry (the $2.50 signature across $75–$600 prices).
 *
 * Recomputes a proper Wilder ATR(14) stop from fresh candles and rewrites
 * stopLoss / target / partialTarget / risk / atr. DRY-RUN by default —
 * pass `--apply` to persist changes.
 *
 * Usage: bun run apps/client_api/scripts/recompute_stale_stops.ts [--apply]
 */
import {
  calculateATR, computeStopsFromAtr, DEFAULT_ATR_PERIOD,
} from '@quantour/shared-algo/src/finance-algo/atr'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

import { db as localDb } from '../src/db'
import { trades } from '../src/db/clientSchema'
import { fetchFromApi } from '../src/services/apiClient'

const HistoricalCandleSchema = z.object({
  date: z.string().optional(),
  open: z.coerce.number(),
  high: z.coerce.number(),
  low: z.coerce.number(),
  close: z.coerce.number(),
  volume: z.coerce.number().optional(),
}).passthrough()

const APPLY = process.argv.includes('--apply')
const STALE_BUFFER_PCT = 0.015

const HistoricalBulkSchema = z.object({
  success: z.boolean().optional(),
  data: z.record(z.string(), z.array(HistoricalCandleSchema)).optional(),
}).passthrough()

async function getHistorical(ticker: string, chatId: string | null) {
  try {
    const hist = await fetchFromApi(
      `/market/historical?symbols=${encodeURIComponent(ticker)}&days=30`,
      HistoricalBulkSchema,
      {},
      chatId || undefined,
    )
    const candles = hist?.data?.[ticker.toUpperCase()]
    return Array.isArray(candles) ? candles : []
  } catch {
    return []
  }
}

function isStale(entry: number, stopLoss: number, atr: number): boolean {
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(stopLoss)) return false
  if (atr === 1) return true
  const buffer = Math.abs(entry - stopLoss)
  return buffer > 0 && buffer / entry < STALE_BUFFER_PCT
}

async function main() {
  const allTrades = await localDb.select().from(trades)
  const stale = allTrades.filter(t => {
    const entry = parseFloat(t.entry)
    const sl = parseFloat(t.stopLoss)
    const atr = t.atr ? parseFloat(t.atr) : 0
    return isStale(entry, sl, atr)
  })

  console.log(`[RECOMPUTE] Found ${stale.length} stale trade(s) of ${allTrades.length} total.${APPLY ? ' (APPLY mode — writes enabled)' : ' (DRY-RUN — pass --apply to persist)'}`)

  let repaired = 0
  let skipped = 0
  for (const trade of stale) {
    const entry = parseFloat(trade.entry)
    const oldSl = parseFloat(trade.stopLoss)
    const chatId = trade.chatId
    const candles = await getHistorical(trade.ticker, chatId)
    const atr = calculateATR(candles, DEFAULT_ATR_PERIOD)
    if (atr <= 0) {
      console.log(`  ✗ ${trade.ticker} (id=${trade.id}): no usable candle data (${candles.length} bars) — skipping`)
      skipped++
      continue
    }
    const stops = computeStopsFromAtr(entry, atr)
    const deployed = parseFloat(trade.capitalDeployed || '0')
    const shares = entry > 0 ? deployed / entry : 0
    const riskAmountUsd = shares * stops.risk
    console.log(`  ${APPLY ? '↻' : '•'} ${trade.ticker} (id=${trade.id}): entry $${entry.toFixed(2)} | SL $${oldSl.toFixed(2)} → $${stops.stopLoss.toFixed(2)} | TP → $${stops.target.toFixed(2)} | atr ${trade.atr} → ${stops.atr.toFixed(2)}`)
    if (APPLY) {
      await localDb.update(trades).set({
        stopLoss: stops.stopLoss.toFixed(2),
        target: stops.target.toFixed(2),
        partialTarget: stops.partialTarget.toFixed(2),
        risk: stops.risk.toFixed(2),
        riskPerShare: stops.risk.toFixed(2),
        atr: stops.atr.toFixed(2),
        riskAmountUsd: riskAmountUsd.toFixed(2),
      }).where(eq(trades.id, trade.id))
      repaired++
    }
  }

  console.log(`[RECOMPUTE] Done. ${APPLY ? `Repaired ${repaired}, ` : ''}skipped ${skipped} (no candle data).`)
  if (!APPLY && stale.length > 0) {
    console.log('[RECOMPUTE] Re-run with --apply to persist these changes.')
  }
  process.exit(0)
}

main().catch((err) => {
  console.error('[RECOMPUTE] Fatal error:', err)
  process.exit(1)
})
