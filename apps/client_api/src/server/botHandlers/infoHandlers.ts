import {
  getChatLanguage, Language, local, t,
} from '@quantour/shared-algo/src/core/i18n'
import {
  and, eq,
} from 'drizzle-orm'
import { z } from 'zod'

import { db as localDb } from '~/db'
import {
  settings, trades,
} from '~/db/clientSchema'
import {
  ApiClientError, fetchFromApi, 
} from '~/services/apiClient'
import { logger } from '~/services/logger'
import { sendGenericMessage } from '~/services/telegramService'

import { getUserBudget } from '../budgetService'

import {
  getAvailableCash, loadTrackedStocks,
} from './portfolioHandlers'

// --- Response schemas (permissive: passthrough + optional fields so we get type
// safety + runtime validation without over-constraining cloud shapes we can't
// fully verify here). Mismatches throw ZodError, caught by handler try/catch. ---

const FcfPointSchema = z.object({
  fcfPerShare: z.coerce.number().optional(),
  ratio: z.coerce.number().optional(),
}).passthrough()

const TickerInfoEnvelopeSchema = z.object({
  success: z.boolean().optional(),
  data: z.object({
    quote: z.object({
      price: z.coerce.number().optional(),
      changesPercentage: z.coerce.number().optional(),
      marketCap: z.coerce.number().optional(),
      name: z.string().optional(),
    }).passthrough().optional(),
    ticker: z.object({
      companyName: z.string().optional(),
      sector: z.string().optional(),
    }).passthrough().optional(),
    consensus: z.object({
      targetMean: z.coerce.number().optional(),
    }).passthrough().optional(),
    fcfData: z.array(FcfPointSchema).optional(),
  }).passthrough().optional(),
}).passthrough()

const QuoteArraySchema = z.array(z.object({
  price: z.coerce.number().optional(),
  relativeStrength: z.coerce.number().optional(),
  marketCap: z.coerce.number().optional(),
  name: z.string().optional(),
  tag: z.string().optional(),
  changesPercentage: z.coerce.number().optional(),
  companyName: z.string().optional(),
  sector: z.string().optional(),
}).passthrough())

const ConsensusSchema = z.object({
  targetMean: z.coerce.number().optional(),
}).passthrough()

const FullProfileSchema = z.object({
  success: z.boolean().optional(),
  data: z.object({
    funding: z.array(z.object({ awardAmount: z.coerce.number().optional() }).passthrough()).optional(),
    catalysts: z.array(z.object({
      eventName: z.string().optional(),
      description: z.string().optional(),
    }).passthrough()).optional(),
    moatAnalysis: z.object({
      windLabel: z.string().optional(),
      moatStrength: z.coerce.number().optional(),
      isStale: z.boolean().optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough()

const MacroNarrativesSchema = z.object({
  data: z.array(z.object({
    isHighConviction: z.boolean().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    tickers: z.unknown().optional(),
  }).passthrough()).optional(),
}).passthrough()

const MacroSchema = z.object({
  data: z.unknown().optional(),
}).passthrough()

const RiskAssessorSchema = z.object({
  success: z.boolean().optional(),
}).passthrough()

const EconomicEventSchema = z.object({
  impact: z.string().optional(),
  date: z.string().optional(),
  country: z.string().optional(),
  event: z.string().optional(),
  estimate: z.unknown().optional(),
  previous: z.unknown().optional(),
}).passthrough()
const EconomicCalendarSchema = z.array(EconomicEventSchema)

// Anything we POST and ignore the body for.
const IgnoredSchema = z.unknown()

export async function handleInfo(ticker: string, chatId: string, lang?: Language) {
  if (!lang) lang = await getChatLanguage(chatId)
  logger.info({ ticker, chatId }, `=== INITIATING STOCK INFO: ${ticker} ===`)

  try {
    const tickerSym = ticker.toUpperCase()

    type Quote = { price?: number; changesPercentage?: number; marketCap?: number; name?: string }
    let quote: Quote | null = null
    let consensus: { targetMean?: number } | null = null
    let dbTicker: { companyName?: string; sector?: string } | null = null
    let fcfData: z.infer<typeof FcfPointSchema>[] | null = null

    // Single-request aggregated summary: /ticker/{t}/summary returns { success, data: { ticker, quote, consensus, fcfData } }
    const infoRes = await fetchFromApi(
      `/ticker/${tickerSym}/summary`,
      z.union([
        QuoteArraySchema,
        TickerInfoEnvelopeSchema,
      ]),
      {},
      chatId,
    ).catch((e: unknown) => {
      if (e instanceof ApiClientError && e.status === 401) return { __unauthorized: true } as const
      // Fall through to domain-driven fallbacks
      return null
    })
    if (typeof infoRes === 'object' && infoRes !== null && '__unauthorized' in infoRes) {
      await sendGenericMessage(local(lang === 'ua' ? '⚠️ Помилка авторизації. Будь ласка, прив\'яжіть свій API ключ використовуючи /link <API_KEY>.' : '⚠️ Unauthorized. Please link your Quantour API key by sending /link <API_KEY>.\nYou can generate one in your web dashboard.'), undefined, chatId)
      return
    }

    if (Array.isArray(infoRes) && infoRes[0]?.price) {
      const item = infoRes[0]!
      quote = {
        price: Number(item.price),
        changesPercentage: Number(item.relativeStrength || 0),
        marketCap: Number(item.marketCap || 0),
        name: tickerSym,
      }
      dbTicker = { companyName: tickerSym, sector: item.tag || 'Technology' }
    } else if (infoRes && 'success' in infoRes && infoRes.success && infoRes.data?.quote) {
      dbTicker = infoRes.data.ticker ?? null
      quote = infoRes.data.quote
      consensus = infoRes.data.consensus ?? null
      fcfData = infoRes.data.fcfData ?? null
    } else {
      const [
        qRes,
        pRes,
        cRes,
      ] = await Promise.all([
        fetchFromApi(
          `/market/quote/${tickerSym}`, QuoteArraySchema, {}, chatId,
        ).catch(() => null),
        fetchFromApi(
          `/market/profile/${tickerSym}`, QuoteArraySchema, {}, chatId,
        ).catch(() => null),
        fetchFromApi(
          `/market/price-target-consensus/${tickerSym}`, ConsensusSchema, {}, chatId,
        ).catch(() => null),
      ])
      quote = (qRes && qRes[0]) ? qRes[0] : null
      const profile = (pRes && pRes[0]) ? pRes[0] : null
      consensus = cRes
      if (profile && !dbTicker) {
        dbTicker = { companyName: profile.companyName, sector: profile.sector }
      }
    }

    if (!quote || !quote.price) {
      await sendGenericMessage(t('TICKER_NOT_FOUND', lang, { ticker }), undefined, chatId)
      return
    }

    let msg = `💎 <b>${tickerSym} - ${dbTicker?.companyName || quote.name}</b>\n`
    msg += `<i>${dbTicker?.sector || 'Unknown Sector'} | Cap: $${(Number(quote.marketCap || 0) / 1e9).toFixed(1)}B</i>\n\n`

    msg += `<b>${t('TECHNICAL_CONTEXT', lang)}</b>\n`
    msg += `• ${t('CURRENT_PRICE', lang)}: <b>$${quote.price?.toFixed(2)}</b> (${(quote.changesPercentage || 0).toFixed(2)}%)\n`
    if (consensus?.targetMean) {
      const upside = ((consensus.targetMean - quote.price!) / quote.price!) * 100
      msg += `• ${t('ANALYST_CONSENSUS', lang)}: <b>$${consensus.targetMean.toFixed(2)}</b> (Upside: ${upside.toFixed(1)}%)\n`
    }
    msg += '\n'

    if (fcfData && fcfData.length > 0) {
      const latest = fcfData[fcfData.length - 1]!
      const validRatios = fcfData.filter(d => (d.ratio ?? 0) > 0)
      const avgMult = validRatios.length > 0 ? validRatios.reduce((sum, d) => sum + (d.ratio ?? 0), 0) / validRatios.length : 0
      const undervaluation = avgMult > 0 && (latest.ratio ?? 0) > 0 ? ((avgMult - latest.ratio!) / avgMult) * 100 : 0

      msg += '💸 <b>FCF DIVERGENCE:</b>\n'
      msg += `• FCF/Share: <b>$${latest.fcfPerShare?.toFixed(2)}</b>\n`
      const ratioStr = (latest.ratio ?? 0) > 0 ? `${latest.ratio!.toFixed(1)}x` : 'N/A'
      msg += `• P/FCF Ratio: <b>${ratioStr}</b> (Avg: ${avgMult.toFixed(1)}x)\n`
      if (undervaluation > 0) {
        msg += `✨ <i>Potentially ${undervaluation.toFixed(0)}% Undervalued relative to history.</i>\n`
      }
      msg += '\n'
    }

    // Try to get full profile for catalysts and funding
    const fullProfile = await fetchFromApi(
      `/ticker/${tickerSym}/full-profile`, FullProfileSchema, {}, chatId,
    ).catch(() => null)
    if (fullProfile?.success && fullProfile.data) {
      const funding = fullProfile.data.funding || []
      if (funding.length > 0) {
        const total = funding.reduce((sum, f) => sum + Number(f.awardAmount ?? 0), 0)
        msg += '🏛 <b>GOVERNMENT FUNDING:</b>\n'
        msg += `• Total Awards: <b>$${(total / 1e6).toFixed(1)}M</b> (${funding.length} contracts)\n\n`
      }

      const catalysts = fullProfile.data.catalysts || []
      if (catalysts.length > 0) {
        msg += '🔥 <b>ACTIVE CATALYSTS:</b>\n'
        for (const cat of catalysts.slice(0, 3)) {
          msg += `• <b>${cat.eventName}</b>: ${cat.description}\n`
        }
        msg += '\n'
      }

      // Fresh moat badge only — stale moat is hidden everywhere (UI + bot).
      const moat = fullProfile.data.moatAnalysis
      if (moat && !moat.isStale && moat.windLabel && moat.windLabel !== 'NEUTRAL') {
        const arrow = moat.windLabel === 'TAILWIND' ? '↑' : '↓'
        const strength = moat.moatStrength != null ? ` · str ${moat.moatStrength.toFixed(2)}` : ''
        msg += `🏰 <b>Economic Moat ${arrow}</b> (${moat.windLabel}${strength})\n\n`
      }
    }

    await sendGenericMessage(local(msg), undefined, chatId)
  } catch (e) {
    logger.error({ ticker, error: e }, '[BOT] Info failed')
    await sendGenericMessage(local(lang === 'ua' ? '❌ Помилка завантаження.' : '❌ Failed to load info.'), undefined, chatId)
  }
}

export async function handleSectors(chatId: string, lang?: Language) {
  if (!lang) lang = await getChatLanguage(chatId)

  const json = await fetchFromApi(
    '/market/macro-narratives', MacroNarrativesSchema, {}, chatId,
  ).catch(() => null)
  const clusters = json?.data || []

  if (clusters.length === 0) {
    await sendGenericMessage(t('ERR_NO_SECTOR_DATA', lang), undefined, chatId)
    return
  }

  let msg = `🧩 <b>${t('SECTOR_NARRATIVES_TITLE', lang)}</b>\n\n`
  for (const c of clusters) {
    const icon = c.isHighConviction ? '🔥' : '🔹'
    msg += `${icon} <b>${c.name}</b>\n`
    msg += `   <i>${c.description}</i>\n`
    msg += `   🎯 <b>${t('TARGET_TICKERS', lang)}:</b> ${c.tickers ?? ''}\n\n`
  }
  await sendGenericMessage(local(msg), undefined, chatId)
}

export async function handleNames(chatId: string) {
  const user = (await localDb.select().from(settings).where(eq(settings.telegramChatId, chatId)).limit(1))[0]
  let msg = '👤 <b>REGISTERED USER (LOCAL):</b>\n'
  if (user) {
    msg += `\n• ${user.userName || 'Unknown'} (<code>${user.telegramChatId}</code>) - ${user.language}`
  } else {
    msg += '\n• Not registered yet.'
  }
  await sendGenericMessage(local(msg), undefined, chatId)
}

export async function handleMacroCheck(chatId: string, lang?: Language) {
  if (!lang) lang = await getChatLanguage(chatId)
  try {
    const macro = await fetchFromApi(
      '/market/macro', MacroSchema, {}, chatId,
    ).catch(() => null)
    const risk = await fetchFromApi(
      '/market/risk-assessor?ticker=SPY', RiskAssessorSchema, {}, chatId,
    ).catch(() => null)

    const isMacroSafe = risk?.success

    const safetyStatus = isMacroSafe
      ? t('STATUS_SAFE', lang)
      : t('STATUS_RISK_HALTED', lang)

    let msg = t('MACRO_REPORT_TITLE', lang) + '\n\n' +
      t('MACRO_ENV_SAFETY', lang, { status: safetyStatus }) + '\n\n'

    if (macro?.data) {
      msg += '<b>Data:</b>\n' + JSON.stringify(macro.data).slice(0, 500) + '...'
    }

    await sendGenericMessage(local(msg), undefined, chatId)
  } catch (e) {
    logger.error({ error: e }, '[BOT] Macro check failed')
    await sendGenericMessage(t('ERR_MACRO_FAILED', lang), undefined, chatId)
  }
}

export async function handleCrawl(chatId: string) {
  await sendGenericMessage(local('Crawl triggers are handled centrally by API now.'), undefined, chatId)
}

export async function handleNarrativeUpdate(chatId: string) {
  await sendGenericMessage(local('Narrative updates are handled centrally by API now.'), undefined, chatId)
}

export async function handleFriday(chatId: string, lang?: Language) {
  if (!lang) lang = await getChatLanguage(chatId)
  await sendGenericMessage(local(lang === 'ua' ? '🍻 Пʼятниця! Всі позиції, що не досягли цілі, переглянуто.' : '🍻 Friday! Reviewing all positions... (Managed via central API)'), undefined, chatId)
}

export async function handleThesis(chatId: string, args: string[], lang?: Language) {
  if (!lang) lang = await getChatLanguage(chatId)

  if (args.length === 0) {
    await fetchFromApi(
      '/market/macro-narratives', MacroNarrativesSchema, {}, chatId,
    ).catch(() => null)
    const msg = `🧠 <b>${t('THESIS_LIST', lang)}</b>\n(Please check Web Dashboard for detailed thesis views)\n`
    await sendGenericMessage(local(msg), undefined, chatId)
    return
  }

  const ticker = args[0]!.toUpperCase()
  const activeTrade = (await localDb.select().from(trades).where(and(eq(trades.chatId, chatId), eq(trades.ticker, ticker))).limit(1))[0]

  if (activeTrade) {
    const newThesis = args.slice(1).join(' ')
    if (!newThesis) {
      await sendGenericMessage(local(`⚠️ Please provide the new thesis text: <code>/thesis ${ticker} <your text></code>`), undefined, chatId)
      return
    }
    await localDb.update(trades).set({ thesis: newThesis }).where(eq(trades.id, activeTrade.id))

    // Also post to API if it exists
    await fetchFromApi(
      `/ticker/${ticker}/thesis`, IgnoredSchema, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thesis: newThesis }),
      }, chatId,
    ).catch(() => null)

    await sendGenericMessage(local(`✅ Thesis updated for active position <b>${ticker}</b>:\n"${newThesis}"`), undefined, chatId)
    return
  }

  await sendGenericMessage(t('THESIS_FORMAT', lang), undefined, chatId)
}

const WantBuyQuotesSchema = z.array(z.object({
  symbol: z.string().optional(),
  price: z.coerce.number().optional(),
  changesPercentage: z.coerce.number().optional(),
  relativeStrength: z.coerce.number().optional(),
  rsi: z.coerce.number().optional(),
}).passthrough())

type SnapshotTicker = {
  symbol?: string
  price?: number
  changesPercentage?: number
  relativeStrength?: number
  rsi?: number
}

async function fetchWantBuySnapshot(tickers: string[], chatId: string): Promise<SnapshotTicker[]> {
  if (tickers.length === 0) return []
  const res = await fetchFromApi(
    `/market/quotes?symbols=${encodeURIComponent(tickers.join(','))}`, WantBuyQuotesSchema, {}, chatId,
  ).catch(() => null)
  return Array.isArray(res) ? res : []
}

export function estimateSlotSize(capitalStr: string): number {
  const capital = parseFloat(capitalStr || '0') || 0
  return Math.max(250, Math.round(capital * 0.05))
}

export async function handleWantBuy(ticker: string, chatId: string, _lang?: Language) {
  const sym = ticker.toUpperCase()
  try {
    const userSet = (await localDb.select().from(settings).where(eq(settings.telegramChatId, chatId)).limit(1))[0]
    const [
      available,
      info,
    ] = await Promise.all([
      getAvailableCash(chatId),
      fetchFromApi(
        `/ticker/${sym}/info`, TickerInfoEnvelopeSchema, {}, chatId,
      ).catch(() => null),
    ])
    const price = info?.data?.quote?.price ?? null
    const dayChg = info?.data?.quote?.changesPercentage
    const budget = await getUserBudget(localDb, userSet?.userId)
    const slot = estimateSlotSize(budget.totalCapital)

    let msg = `🔍 <b>Want to buy ${sym}?</b>\n`
    if (price) {
      msg += `💵 ${sym}: <b>$${price.toFixed(2)}</b>`
      if (dayChg !== undefined) msg += ` (${dayChg >= 0 ? '+' : ''}${dayChg.toFixed(2)}% today)`
      msg += '\n'
    }
    msg += `💰 Free cash: <b>$${available.toFixed(2)}</b> · target slot ~$${slot.toFixed(0)}\n`

    // Affordable -> green-light.
    if (available >= slot) {
      msg += '\n✅ You can afford a full position.'
      await sendGenericMessage(local(msg), {
        inline_keyboard: [
          [
            { text: `📡 Deep Scan ${sym}`, callback_data: `deep_scan_${sym}` },
          ],
        ],
      }, chatId)
      return
    }

    // Not enough cash -> rank holdings by weakness and suggest a replacement.
    // Account scope: all devices/chats sharing this chat's API key see one portfolio.
    const { getAccountScopeByKey } = await import('../dashboardIdentity')
    const accountScope = await getAccountScopeByKey(localDb, userSet?.quantourApiKey)
    const tracked = await loadTrackedStocks(chatId, accountScope.userId ?? userSet?.userId ?? undefined, accountScope.chatIds)
    const held = tracked.filter(s => s.ticker.toUpperCase() !== sym)
    if (held.length === 0) {
      msg += '\n⚠️ Not enough cash and nothing held to trim. Free up capital first.'
      await sendGenericMessage(local(msg), undefined, chatId)
      return
    }

    const quotes = await fetchWantBuySnapshot(held.map(s => s.ticker), chatId)
    const qmap = new Map(quotes.map(q => [
      String(q.symbol ?? '').toUpperCase(),
      q,
    ]))
    const scored = held.map(s => {
      const q = qmap.get(s.ticker.toUpperCase())
      const p = q?.price ?? s.entry
      const pnlPct = s.entry > 0 ? ((p - s.entry) / s.entry) * 100 : 0
      const mom = q?.changesPercentage ?? 0
      const rs = q?.relativeStrength ?? 0
      const rsi = q?.rsi
      // weakness: higher = weaker = better candidate to replace
      const weakness = (-pnlPct) + (-mom) * 0.4 + (-rs) * 20 + (rsi !== undefined && rsi > 70 ? 15 : 0)
      return {
        ticker: s.ticker,
        pnlPct,
        deployed: s.capitalDeployed || 0,
        weakness,
      }
    }).sort((a, b) => b.weakness - a.weakness)

    const needed = Math.max(0, slot - available)
    msg += `\n⚠️ Need ~<b>$${needed.toFixed(0)}</b> more.\n<b>Weakest holdings to replace:</b>\n`
    const buttons = {
      inline_keyboard: [] as Array<Array<{ text: string; callback_data: string }>>,
    }
    for (const c of scored.slice(0, 3)) {
      msg += `• <b>${c.ticker}</b>: ${c.pnlPct >= 0 ? '+' : ''}${c.pnlPct.toFixed(1)}% • $${c.deployed.toFixed(0)} deployed\n`
      buttons.inline_keyboard.push([
        {
          text: `♻️ Replace ${c.ticker} → ${sym}`,
          callback_data: `liquidate_${c.ticker}_${chatId}`,
        },
      ])
    }
    await sendGenericMessage(local(msg), buttons, chatId)
  } catch (e) {
    logger.error({
      error: e,
      ticker: sym,
    }, '[BOT] handleWantBuy failed')
    await sendGenericMessage(local(`⚠️ Could not analyze ${sym}. Try again later.`), undefined, chatId)
  }
}

export async function handleEvents(chatId: string) {
  const lang = await getChatLanguage(chatId)
  try {
    const today = new Date()
    const fromStr = today.toISOString().split('T')[0]!

    const nextWeek = new Date()
    nextWeek.setDate(nextWeek.getDate() + 7)
    const toStr = nextWeek.toISOString().split('T')[0]!

    const events = await fetchFromApi(
      `/market/calendar?from=${fromStr}&to=${toStr}`, EconomicCalendarSchema, {}, chatId,
    ).catch(() => null)

    if (!events || events.length === 0) {
      await sendGenericMessage(local(lang === 'ua' ? '📅 Немає економічних подій на найближчі дні.' : '📅 No economic events in the coming days.'), undefined, chatId)
      return
    }

    const filteredEvents = events.filter(e => e.impact === 'High').slice(0, 15)

    if (filteredEvents.length === 0) {
      await sendGenericMessage(local(lang === 'ua' ? '📅 Немає важливих (High Impact) економічних подій на найближчі 7 днів.' : '📅 No high impact economic events in the next 7 days.'), undefined, chatId)
      return
    }

    let msg = `📅 <b>${lang === 'ua' ? 'Економічний календар (High Impact)' : 'Economic Calendar (High Impact)'}</b>\n\n`
    for (const e of filteredEvents) {
      const timePart = e.date ? e.date.split(' ')[1]?.substring(0, 5) || '' : ''
      const datePart = e.date ? e.date.split(' ')[0] : ''
      msg += `🔴 <b>${datePart} ${timePart}</b> | ${e.country || 'US'}\n`
      msg += `   ${e.event}\n`
      if (e.estimate !== null && e.estimate !== undefined) {
        msg += `   Est: <i>${e.estimate}</i> (Prev: ${e.previous})\n`
      }
      msg += '\n'
    }

    await sendGenericMessage(local(msg), undefined, chatId)
  } catch (err) {
    logger.error({ error: err }, '[BOT] Failed to fetch events')
    await sendGenericMessage(t('ERR_PROCESSING', lang), undefined, chatId)
  }
}

export async function handleSyncCongress(chatId: string) {
  const lang = await getChatLanguage(chatId)
  await sendGenericMessage(local(lang === 'ua' ? '🏛 Синхронізація Конгресу...' : '🏛 Syncing Congress...'), undefined, chatId)
}

export async function handleSyncFunding(chatId: string) {
  const lang = await getChatLanguage(chatId)
  await sendGenericMessage(local(lang === 'ua' ? '🏛 Синхронізація фінансування...' : '🏛 Syncing Government Funding...'), undefined, chatId)
}

export async function handleExplainBinary(_ticker: string, chatId: string, _lang?: Language) {
  await sendGenericMessage(local(`🧠 Explanation for ${_ticker} binary outcome coming soon.`), undefined, chatId)
}
