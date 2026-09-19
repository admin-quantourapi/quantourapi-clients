import {
  getChatLanguage, Language, local, t,
} from '@quantour/shared-algo/src/core/i18n'
import {
  and, eq,
} from 'drizzle-orm'
import { z } from 'zod'

import { db as localDb } from '~/db'
import {
  portfolioItems,
} from '~/db/clientSchema'
import { fetchFromApi } from '~/services/apiClient'
import { logger } from '~/services/logger'
import { sendGenericMessage } from '~/services/telegramService'

const QuoteSchema = z.object({
  symbol: z.string().optional(),
  name: z.string().nullable().optional(),
  price: z.coerce.number().optional(),
  marketCap: z.coerce.number().optional(),
  avgVolume: z.coerce.number().optional(),
})
type Quote = z.infer<typeof QuoteSchema>

async function fetchQuote(ticker: string, chatId?: string): Promise<Quote | null> {
  try {
    const res = await fetchFromApi(
      `/market/quote/${ticker}`, z.union([
        z.array(QuoteSchema),
        QuoteSchema,
      ]), {}, chatId,
    )
    return Array.isArray(res) ? (res[0] ?? null) : res
  } catch {
    return null
  }
}

// In local mode, we'll store scanned tickers in portfolioItems under a default portfolio (id = 1)
const SCAN_PORTFOLIO_ID = 1

export async function handleAddScan(ticker: string, chatId: string, lang?: Language) {
  if (!lang) lang = await getChatLanguage(chatId)
  try {
    const quote = await fetchQuote(ticker, chatId)
    if (!quote || !quote.symbol) {
      await sendGenericMessage(t('SCAN_TICKER_INVALID', lang, { ticker }), undefined, chatId)
      return
    }

    if ((quote.price || 0) < 5 || (quote.marketCap || 0) < 1000000000 || (quote.avgVolume || 0) < 500000) {
      await sendGenericMessage(local(`❌ <b>Rejected: ${ticker.toUpperCase()}</b>\n` +
        'This stock does not meet institutional quality requirements.\n' +
        `• Price: $${(quote.price || 0).toFixed(2)} (Min $5)\n` +
        `• Market Cap: $${((quote.marketCap || 0)/1e9).toFixed(1)}B (Min $1B)\n` +
        `• Avg Volume: ${((quote.avgVolume || 0)/1e3).toFixed(0)}k (Min 500k)`), 
      undefined,
      chatId)
      return
    }

    const existing = await localDb.select().from(portfolioItems)
      .where(and(eq(portfolioItems.portfolioId, SCAN_PORTFOLIO_ID), eq(portfolioItems.ticker, ticker.toUpperCase())))
      .limit(1)

    if (existing.length > 0) {
      await sendGenericMessage(t('SCAN_TICKER_EXISTS', lang, { ticker }), undefined, chatId)
      return
    }

    await localDb.insert(portfolioItems).values({
      portfolioId: SCAN_PORTFOLIO_ID,
      ticker: ticker.toUpperCase(),
      addedAt: new Date(),
    })

    await sendGenericMessage(t('SCAN_TICKER_ADDED', lang, { ticker, name: quote.name || ticker }), undefined, chatId)
  } catch (e) {
    logger.error({ ticker, error: e }, '[BOT] Add scan failed')
    await sendGenericMessage(t('ERR_ADD_TICKER_GENERIC_FAILED', lang), undefined, chatId)
  }
}

export async function handleListScan(chatId: string, lang?: Language) {
  if (!lang) lang = await getChatLanguage(chatId)
  
  const active = await localDb.select().from(portfolioItems).where(eq(portfolioItems.portfolioId, SCAN_PORTFOLIO_ID))
  
  if (active.length === 0) {
    await sendGenericMessage(t('SCAN_LIST_EMPTY', lang), undefined, chatId)
    return
  }

  let msg = `📋 <b>${t('SCAN_LIST_HEADER', lang)}</b>\n`
  for (const a of active) {
    msg += `\n• <b>${a.ticker}</b>`
  }
  await sendGenericMessage(local(msg), undefined, chatId)
}

export async function handleRemoveScan(ticker: string, chatId: string, lang?: Language) {
  if (!lang) lang = await getChatLanguage(chatId)
  
  const existing = await localDb.select().from(portfolioItems)
    .where(and(eq(portfolioItems.portfolioId, SCAN_PORTFOLIO_ID), eq(portfolioItems.ticker, ticker.toUpperCase())))
    .limit(1)
      
  if (existing.length === 0) {
    await sendGenericMessage(t('SCAN_TICKER_NOT_FOUND', lang, { ticker }), undefined, chatId)
    return
  }

  await localDb.delete(portfolioItems)
    .where(and(eq(portfolioItems.portfolioId, SCAN_PORTFOLIO_ID), eq(portfolioItems.ticker, ticker.toUpperCase())))
    
  await sendGenericMessage(t('SCAN_TICKER_REMOVED', lang, { ticker }), undefined, chatId)
}
