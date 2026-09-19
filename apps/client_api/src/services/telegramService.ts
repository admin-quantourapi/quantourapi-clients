import { BotCommand } from '@quantour/shared-algo/src/core/commands'
import {
  Language, local, LocalizedString, t,
} from '@quantour/shared-algo/src/core/i18n'
import { getTradingDaysBetween } from '@quantour/shared-algo/src/core/marketHours'
import { eq } from 'drizzle-orm'

import { config } from '~/config'

import { db } from '../db'
import {
  notificationBatches, portfolioStats, settings, trades,
} from '../db/clientSchema'
import { getUserBudget } from '../server/budgetService'

import { analysisCache } from './analysisCache'
import { logger } from './logger'

async function fetchFromApi(endpoint: string, options: RequestInit = {}) {
  try {
    const [
      allSettings,
    ] = await db.select().from(settings).limit(1)
    const apiKey = allSettings?.quantourApiKey
    if (!apiKey) return null

    const res = await fetch(`${config.PUBLIC_API_URL}/v1${endpoint}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${apiKey}`, 'x-api-key': apiKey, 'Connection': 'close', ...options.headers, 
      },
    })
    if (!res.ok) return null
    return await res.json()
  } catch (e) {
    logger.error({ error: e, endpoint }, '[API] fetchFromApi failed')
    return null
  }
}

import { sendRawTelegram } from './rawTelegramDispatcher'

const handlersContainer: {
  handlePortfolioSell: ((ticker: string, chatId: string, lang: Language) => Promise<void>) | null
  handlePortfolioStatus: ((chatId: string, lang?: Language) => Promise<void>) | null
  handleOptimizeDetails: ((chatId?: string) => Promise<void>) | null
  handlePortfolioRotations: ((chatId: string) => Promise<void>) | null
  handleBudget: ((chatId: string, lang?: Language) => Promise<void>) | null
  handleFreeCash: ((chatId: string, amount: number, lang?: Language) => Promise<void>) | null
  handlePnl: ((chatId: string, lang?: Language, timeframe?: 'wtd' | 'mtd' | 'ytd' | 'all') => Promise<void>) | null
  handleInfo: ((ticker: string, chatId: string, lang?: Language) => Promise<void>) | null
  handleMacroCheck: ((chatId: string, lang?: Language) => Promise<void>) | null
  runDeepPortfolio: ((chatId: string, onProgress?: (msg: string) => Promise<void>) => Promise<string | undefined>) | null
  handleApplyOptimization: ((chatId?: string) => Promise<void>) | null
  handleMe: ((chatId: string, lang?: Language) => Promise<void>) | null
} = {
  handlePortfolioSell: null,
  handlePortfolioStatus: null,
  handleOptimizeDetails: null,
  handlePortfolioRotations: null,
  handleBudget: null,
  handleFreeCash: null,
  handlePnl: null,
  handleInfo: null,
  handleMacroCheck: null,
  runDeepPortfolio: null,
  handleApplyOptimization: null,
  handleMe: null,
}

export const registeredHandlers = handlersContainer

export const webConsoleInterceptors = new Map<string, (text: string) => void>()

// In-memory sliding window of last 5 execution durations (in ms) per command
const commandHistoryMap = new Map<string, number[]>()
const COMMAND_HISTORY_WINDOW = 5

/** Record a completed command's wall-clock duration (ms), keeping the last N runs. */
function recordCommandDuration(cmdKey: string, ms: number): void {
  if (!cmdKey) return
  const history = commandHistoryMap.get(cmdKey) ?? []
  history.push(ms)
  commandHistoryMap.set(cmdKey, history.slice(-COMMAND_HISTORY_WINDOW))
}

/**
 * ETA for the "processing" ack: default until history exists, then the
 * AVERAGE of the last 5 completed runs. (The previous min/max over the full
 * history was outlier-dominated — one cold-path 90s vs cached 5s printed
 * "~5-90s" — and the history was never even written, so it always showed
 * the '~15-20s' default.)
 */
export function formatCommandEstimate(cmdKey: string, fallback = '~15-20s'): string {
  const history = commandHistoryMap.get(cmdKey)
  if (!history || history.length === 0) return fallback
  const avgSec = Math.max(1, Math.round(history.reduce((a, b) => a + b, 0) / history.length / 1000))
  return `~${avgSec}s`
}

// Active processing guard per Telegram user_id
const activeProcessingMap = new Map<string, { query: string; startTime: number }>()

const PREVIEW_ACCOUNT_ID = 'PREVIEW_ACCOUNT'
const PREVIEW_ACCOUNT_STANDARD_AGGRESSIVE = 'PREVIEW_ACCOUNT_STAND_AGGR'
const PREVIEW_ACCOUNT_STANDARD_CONSERVATIVE = 'PREVIEW_ACCOUNT_STAND_CONS'

export const PREVIEW_CHAT_IDS = new Set([
  PREVIEW_ACCOUNT_ID,
  PREVIEW_ACCOUNT_STANDARD_AGGRESSIVE,
  PREVIEW_ACCOUNT_STANDARD_CONSERVATIVE,
])

export async function getChatLanguage(chatId: string): Promise<Language> {
  const chat = await db.select().from(settings).where(eq(settings.telegramChatId, String(chatId))).limit(1)
  return (chat[0]?.language as Language) || 'en'
}

export async function setChatLanguage(chatId: string, lang: Language): Promise<void> {
  const existing = await db.select().from(settings).where(eq(settings.telegramChatId, String(chatId))).limit(1)
  if (existing.length > 0) {
    await db.update(settings).set({ language: lang }).where(eq(settings.telegramChatId, String(chatId)))
  } else {
    await db.insert(settings).values({ telegramChatId: String(chatId), language: lang })
  }
}

export function registerBotHandlers(fns: {
  handleBuy?: (params: {
    ticker: string
    entry: number
    sl: number
    tp: number
    strategy: string
    chatId: string
    atr?: number
  }) => Promise<void>
  getAvailableCash?: (chatId: string) => Promise<number | undefined>
  handlePortfolioSell?: (ticker: string, chatId: string, lang: Language) => Promise<void>
  handlePortfolioStatus?: (chatId: string, lang?: Language) => Promise<void>
  handleOptimizeDetails?: (chatId?: string) => Promise<void>
  handlePortfolioRotations?: (chatId: string) => Promise<void>
  handleBudget?: (chatId: string, lang?: Language) => Promise<void>
  handleFreeCash?: (chatId: string, amount: number, lang?: Language) => Promise<void>
  handleInfo?: (ticker: string, chatId: string, lang?: Language) => Promise<void>
  handleMacroCheck?: (chatId: string, lang?: Language) => Promise<void>
  runDeepPortfolio?: (chatId: string, onProgress?: (msg: string) => Promise<void>) => Promise<string | undefined>
  handleApplyOptimization?: (chatId?: string) => Promise<void>
  handleMe?: (chatId: string, lang?: Language) => Promise<void>
}) {
  if (fns.handlePortfolioSell) handlersContainer.handlePortfolioSell = fns.handlePortfolioSell
  if (fns.handlePortfolioStatus) handlersContainer.handlePortfolioStatus = fns.handlePortfolioStatus
  if (fns.handleOptimizeDetails) handlersContainer.handleOptimizeDetails = fns.handleOptimizeDetails
  if (fns.handlePortfolioRotations) handlersContainer.handlePortfolioRotations = fns.handlePortfolioRotations
  if (fns.handleBudget) handlersContainer.handleBudget = fns.handleBudget
  if (fns.handleFreeCash) handlersContainer.handleFreeCash = fns.handleFreeCash
  if (fns.handleInfo) handlersContainer.handleInfo = fns.handleInfo
  if (fns.handleMacroCheck) handlersContainer.handleMacroCheck = fns.handleMacroCheck
  if (fns.runDeepPortfolio) handlersContainer.runDeepPortfolio = fns.runDeepPortfolio
  if (fns.handleApplyOptimization) handlersContainer.handleApplyOptimization = fns.handleApplyOptimization
  if (fns.handleMe) handlersContainer.handleMe = fns.handleMe
}



export function escapeHtml(text: string): string {
  if (!text) return ''
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function stripHtml(text: string): string {
  if (!text) return ''
  return String(text).replace(/<\/?[^>]+(>|$)/g, '')
}

export function sanitizeTelegramHtml(html: string): string {
  if (!html) return ''
  // Whitelist = Telegram Bot API "HTML style" officially supported tags
  // (core.telegram.org/bots/api#html-style). Aliases included: strong/em/ins/
  // strike/del and tg-spoiler. tg-emoji/tg-time are intentionally NOT
  // whitelisted: they require validated attributes (emoji-id/unix) and an
  // emitted-but-invalid one would make Telegram reject the whole message.
  return String(html)
    .replace(/&(?!amp;|lt;|gt;|quot;|#\d+;|[a-zA-Z]+;)/g, '&amp;')
    .replace(/<(?!\/?(b|strong|i|em|u|ins|s|strike|del|span|tg-spoiler|a|code|pre|blockquote)\b[^>]*>)/gi, '&lt;')
}

export const TELEGRAM_API = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}`

export interface TelegramPayload {
  type?: 'signal' | 'alert' | 'system' | 'exit' | string
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
  catalystStatus?: import('@quantour/shared-algo/src/core/types').CatalystStatus
  fcfInflection?: import('@quantour/shared-algo/src/core/types').FcfInflection
  atrMove?: number
  isBroadcasted?: boolean
  connections?: Array<{ connectionType: string; toTicker: string }>
}

export interface BatchNotification {
  chatId: string
  messages: string[]
  buttons?: unknown[]
}

export interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    from?: unknown
    chat: { id: number | string; type?: string; title?: string }
    date?: number
    text?: string
    reply_to_message?: unknown
  }
  edited_message?: {
    message_id: number
    chat: { id: number | string }
    text?: string
  }
  callback_query?: {
    id: string
    from?: unknown
    message?: { message_id: number; chat: { id: number | string }; text?: string }
    data?: string
    chat_instance?: string
  }
}

export interface TelegramHandlers {
  handleBuy: (params: {
    ticker: string
    entry: number
    sl: number
    tp: number
    strategy: string
    chatId: string
    riskAmountUsd?: number
    atr?: number
  }) => Promise<void>
  handleSell: (ticker: string, chatId: string, lang?: Language, exitReason?: string) => Promise<void>
  handleRemoveBatch: (tickers: string[], chatId: string, lang?: Language) => Promise<void>
  handleTrackAdd: (tickers: string[], chatId: string, lang?: Language) => Promise<void>
  handleManualAdd: (ticker: string, shares: number, chatId: string, lang?: Language) => Promise<boolean>
  handleSellStrategy: (ticker: string, chatId: string, lang?: Language) => Promise<void>
  handlePortfolioStatus: (chatId: string, lang?: Language) => Promise<void>
  handlePending: (chatId: string, lang?: Language) => Promise<void>
  handleSetName: (chatId: string, name: string, lang?: Language) => Promise<void>
  handleSetCapital: (chatId: string, capital: number, lang?: Language) => Promise<void>
  handleSetRisk: (chatId: string, amount: string | number, lang?: Language) => Promise<void>
  handleSetSilent: (chatId: string, arg?: string, lang?: Language) => Promise<void>
  handleSetBudget: (chatId: string, isEnabled: boolean, lang?: Language) => Promise<void>
  handleMode: (chatId: string, lang?: Language) => Promise<void>
  handleRiskGuide: (chatId: string, lang?: Language) => Promise<void>
  handleFriday: (chatId: string, lang?: Language) => Promise<void>
  handleCrawl: (chatId: string) => Promise<void>
  handleNarrativeUpdate: (chatId: string) => Promise<void>
  handleSectors: (chatId: string, lang?: Language) => Promise<void>
  handleNames: (chatId: string) => Promise<void>
  handleThesis: (chatId: string, args: string[], lang?: Language) => Promise<void>
  handlePortfolioRotations: (chatId?: string) => Promise<void>
  handleSendDM: (targetChatId: string, message: string, adminChatId: string) => Promise<void>
  handleDailyReport?: (chatId: string) => Promise<void>
  handleAddScan: (ticker: string, chatId: string, lang?: Language) => Promise<void>
  handleListScan: (chatId: string, lang?: Language) => Promise<void>
  handleRemoveScan: (ticker: string, chatId: string, lang?: Language) => Promise<void>
  handleLogs: (lines: number, chatId: string, lang?: Language) => Promise<void>
  handleAiStats: (chatId: string) => Promise<void>
  handleReset: (chatId: string, lang?: Language) => Promise<void>
  handleResetConfirm: (chatId: string) => Promise<void>
  handlePreviewStatus: (chatId: string) => Promise<void>
  handlePreviewAllStatus: (chatId: string) => Promise<void>
  handleResetPreview: (amount: number, chatId: string) => Promise<void>
  handleExplainBinary?: (ticker: string, chatId: string, lang?: Language) => Promise<void>
  handleFreeCash: (chatId: string, amount: number, lang?: Language) => Promise<void>
  handleInfo: (ticker: string, chatId: string, lang?: Language) => Promise<void>
  handleWantBuy: (ticker: string, chatId: string, lang?: Language) => Promise<void>
  handlePnl: (chatId: string, lang?: Language, timeframe?: 'wtd' | 'mtd' | 'ytd' | 'all') => Promise<void>
  handleStrategyMenu: (chatId: string, lang?: Language) => Promise<void>
  handleMe?: (chatId: string, lang?: Language) => Promise<void>

  handleRiskProfileMenu: (chatId: string, lang?: Language) => Promise<void>
  handleSetRiskProfile: (chatId: string, profile: import('@quantour/shared-algo/src/core/types').RiskProfile, lang?: Language) => Promise<void>
  runMasterScanner: (options: {
    isManual?: boolean
    summaryTitle?: string
    chatId?: string
    isPowerHour?: boolean
  }) => Promise<void>
  runSingleTickerScan: (ticker: string, chatId: string) => Promise<void>
  runDeepScan: (ticker: string, chatId: string, onProgress?: (msg: string) => Promise<void>) => Promise<string | undefined>
  runDeepPortfolio?: (chatId: string, onProgress?: (msg: string) => Promise<void>) => Promise<string | undefined>
  handleMacroCheck: (chatId: string, lang?: Language) => Promise<void>
  handleOptimizeDetails: (chatId?: string) => Promise<void>
  handleApplyOptimization?: (chatId: string) => Promise<void>
}



export const getBotCommands = (lang: 'en' | 'ua'): { command: string; description: string }[] => {
  return [
    // --- CORE PORTFOLIO & EXECUTION ---
    { command: BotCommand.BUY, description: t('CMD_DESC_ADD', lang) },
    { command: BotCommand.SELL, description: t('CMD_DESC_SELL', lang) },
    { command: BotCommand.STATUS, description: t('CMD_DESC_STATUS', lang) },
    { command: BotCommand.OPTIMIZE, description: t('CMD_DESC_OPTIMIZE', lang) },
    { command: BotCommand.EXIT, description: t('CMD_DESC_EXIT', lang) },
    { command: BotCommand.DEEP_PORTFOLIO, description: t('CMD_DESC_DEEP_PORTFOLIO', lang) },

    // --- RESEARCH & INTEL ---
    { command: BotCommand.SCAN, description: t('CMD_DESC_SCAN', lang) },
    { command: BotCommand.RESEARCH, description: t('CMD_DESC_RESEARCH', lang) },
    { command: BotCommand.MACRO, description: t('CMD_DESC_MACRO', lang) },
    { command: BotCommand.INFO, description: t('CMD_DESC_INFO', lang) },

    // --- SYSTEM & USER ---
    { command: BotCommand.HELP, description: t('CMD_DESC_HELP', lang) },
    { command: BotCommand.SETTINGS, description: t('HELP_SETTINGS_DESC', lang) },
    { command: BotCommand.BUDGET, description: t('CMD_DESC_BUDGET', lang) },
    { command: BotCommand.PNL, description: t('CMD_DESC_PNL', lang) },
    { command: BotCommand.RISK, description: lang === 'ua' ? 'Налаштування ризику на угоду ($ або %)' : 'Set risk level per trade ($ or %)' },
    { command: BotCommand.API, description: t('CMD_DESC_API', lang) },
    { command: BotCommand.ME, description: t('CMD_DESC_ME', lang) },
    { command: BotCommand.LINK, description: lang === 'ua' ? 'Прив\'язати API ключ' : 'Link Quantour API key' },
  ]
}

export async function setBotCommands() {
  try {
    // 1. Set default fallback commands (no language code)
    await sendRawTelegram('setMyCommands', {
      commands: getBotCommands('en'),
    })

    // 2. Set localized commands for EN and UA
    await sendRawTelegram('setMyCommands', {
      commands: getBotCommands('en'),
      language_code: 'en',
    })
    await sendRawTelegram('setMyCommands', {
      commands: getBotCommands('ua'),
      language_code: 'ua',
    })

    logger.info('[TELEGRAM] Bot commands registered successfully.')
  } catch (e) {
    logger.error({ error: e }, '[TELEGRAM] Failed to set bot commands')
  }
}

export function getLocalizedHelp(lang: Language): string {
  const lines = [
    t('HELP_HEADER', lang),
    '',
    `/${BotCommand.BUY} - ${t('CMD_DESC_ADD', lang)}`,
    `/${BotCommand.SELL} - ${t('CMD_DESC_SELL', lang)}`,
    `/${BotCommand.STATUS} - ${t('CMD_DESC_STATUS', lang)}`,
    `/${BotCommand.OPTIMIZE} - ${t('CMD_DESC_OPTIMIZE', lang)}`,
    `/${BotCommand.EXIT} - ${t('CMD_DESC_EXIT', lang)}`,
    `/${BotCommand.DEEP_PORTFOLIO} - ${t('CMD_DESC_DEEP_PORTFOLIO', lang)}`,
    `/${BotCommand.SCAN} - ${t('CMD_DESC_SCAN', lang)}`,
    `/${BotCommand.RESEARCH} - ${t('CMD_DESC_RESEARCH', lang)}`,
    `/${BotCommand.MACRO} - ${t('CMD_DESC_MACRO', lang)}`,
    `/${BotCommand.INFO} - ${lang === 'ua' ? 'Отримати детальну інформацію про акцію' : 'Get detailed stock info'}`,
    `/${BotCommand.HELP} - ${t('CMD_DESC_HELP', lang)}`,
    `/${BotCommand.SETTINGS} - ${t('HELP_SETTINGS_DESC', lang)}`,
    `/${BotCommand.BUDGET} - ${t('CMD_DESC_BUDGET', lang)}`,
    `/${BotCommand.PNL} - ${t('CMD_DESC_PNL', lang)}`,
    `/${BotCommand.RISK} - ${lang === 'ua' ? 'Налаштування ризику на угоду ($ або %)' : 'Set risk level per trade ($ or %)'}`,
    `/${BotCommand.API} - ${t('CMD_DESC_API', lang)}`,
    `/${BotCommand.ME} - ${t('CMD_DESC_ME', lang)}`,
    `/${BotCommand.LINK} - ${lang === 'ua' ? 'Прив\'язати API ключ' : 'Link Quantour API key'}`,
  ]

  return lines.join('\n')
}

export async function sendTelegramAlert(payload: TelegramPayload, chatId: string, replacementFor?: string) {
  const [
    chat,
  ] = await db.select().from(settings).where(eq(settings.telegramChatId, String(chatId))).limit(1)
  if (!chat) return

  const lang = (chat.language as Language) || 'en'
  const ticker = payload.ticker
  const strategy = payload.strategy || payload.strategyName || 'N/A'
  
  const fcfIcon = payload.fcfInflection === 'POSITIVE' ? '💎' : payload.fcfInflection === 'NEGATIVE' ? '⚠️' : ''
  const displayTicker = fcfIcon ? `${ticker} ${fcfIcon}` : ticker

  const marketCtx = payload.marketStatus || payload.market_context || 'N/A'
  const marketBadge = marketCtx.includes('BULL') ? '🟢' : marketCtx.includes('BEAR') ? '🔴' : '🟡'

  const title = t('SIGNAL_TITLE', lang, { ticker: displayTicker, strategy, marketBadge })

  const price = payload.entry || payload.price || 0
  const sl = payload.stopLoss || payload.stop_loss || 0
  const target = payload.target
  const atr = payload.atr || 0

  const sector = payload.sectorStatus || payload.sector_context || payload.sectorName || 'N/A'
  const news = payload.newsSentiment || payload.news_sentiment || payload.newsSummary || 'Neutral'
  const thesis = payload.narrative || payload.narrativeThesis || 'N/A'
  const reason = payload.reason || 'Technical breakout'

  // NOTE: translation for non-English users is not implemented in client_api
  // (Gemini lives in apps/api, which is across the open-source boundary).
  // Previously this branch did `const { translateText } = ({} as {...})` which
  // crashed with "translateText is not a function" for any non-English chat.
  // Non-English users now see the English text instead of a crash; wire a
  // proper client_api translator if/when i18n parity is needed.

  const formatP = (n: number | undefined | null) => {
    if (n === undefined || n === null) return '0.00'
    return n.toFixed(2)
  }

  // Calculate Target Gain %, Stop Loss %, and R:R Ratio
  let targetStr = `$${formatP(target)}`
  if (target && price > 0) {
    const gainPct = ((target - price) / price) * 100
    targetStr += ` (+${gainPct.toFixed(1)}%)`
  }

  let stopStr = `$${formatP(sl)}`
  let rrStr = 'N/A'
  if (sl && price > 0 && price > sl) {
    const lossPct = ((price - sl) / price) * 100
    stopStr += ` (-${lossPct.toFixed(1)}%)`

    if (target && target > price) {
      const risk = price - sl
      const reward = target - price
      const ratio = reward / risk
      rrStr = `1 : ${ratio.toFixed(2)} R`
    }
  }

  let text = `${title}\n\n`
  text += `💰 <b>${t('ENTRY', lang)}: $${formatP(price)}</b>\n`
  text += `🎯 <b>${t('TARGET', lang)}: ${targetStr}</b>\n`
  text += `🛑 <b>${t('STOP', lang)}: ${stopStr}</b>\n`
  if (rrStr !== 'N/A') {
    text += `⚖️ <b>${t('RR_RATIO', lang)}: ${rrStr}</b>\n`
  }
  const ARCHETYPE_HOLD_MAP: Record<string, number> = {
    '🔮 High AI Conviction & Early Reclaim': 7,
    '🔥 Bullish AI News Trend': 7,
    'Momentum Breakout': 7,
    'Earnings Momentum': 7,
    '⚡ Macro Acceleration & Velocity Inflection': 15,
    '📈 High FCF Inflection': 15,
    '🚀 AI Macro Narrative Sector Breakout': 15,
    '🛡️ High AI Conviction Low Beta Safety': 20,
    '💎 High Margin Quality Enterprise Leader': 20,
    '🏆 Deep Value High FCF Margin': 20,
    'Trend Rider': 30,
    'Government Funding Capex': 30,
  }
  const holdDays = payload.minHoldingDays ?? (payload.strategyName && ARCHETYPE_HOLD_MAP[payload.strategyName] ? ARCHETYPE_HOLD_MAP[payload.strategyName] : 20)
  text += `⏱ <b>${t('TYPICAL_HOLD_PERIOD', lang)}: ~${holdDays} ${lang === 'ua' ? 'торг. днів' : 'trading days'}</b>\n\n`

  text += `📝 <b>${t('REASON', lang)}:</b> ${reason}\n\n`

  text += `${t('TECHNICAL_CONTEXT', lang)}\n`
  const formattedRsi = typeof payload.rsi === 'number' ? payload.rsi.toFixed(1) : (payload.rsi ?? 'N/A')
  text += `• RSI: ${formattedRsi}\n`

  const rawRs = payload.relativeStrength ?? payload.relative_strength
  const formattedRs = (rawRs !== undefined && rawRs !== null && rawRs !== 0)
    ? `${rawRs > 0 ? '+' : ''}${rawRs.toFixed(2)}%`
    : 'N/A'

  const rawVol = payload.volumeVsAvg ?? payload.volume_vs_avg ?? payload.volumeChange
  const formattedVol = (rawVol !== undefined && rawVol !== null && rawVol !== 0) ? `${(rawVol * 100).toFixed(0)}%` : 'N/A'
  const nearSupport = payload.nearSupport ?? payload.near_support ?? false

  text += `• ${t('REL_STRENGTH', lang)}: ${formattedRs}\n`
  text += `• ${t('VOLUME_AVG', lang)}: ${formattedVol}\n`

  if (payload.catalystStatus && payload.catalystStatus !== 'NEUTRAL') {
    const statusKey = payload.catalystStatus === 'LAGGING' ? 'STATUS_LAGGING' : 'STATUS_PRICED_IN'
    const statusLabel = t(statusKey as string, lang)
    const moveVal = payload.atrMove !== undefined ? payload.atrMove : undefined
    const formattedAtrMove = moveVal !== undefined ? ((moveVal === 0 || Math.abs(moveVal) < 0.05) ? '0.0' : moveVal.toFixed(1)) : undefined
    const moveLabel = formattedAtrMove !== undefined ? ` (${formattedAtrMove}x ATR)` : undefined
    text += `• ${t('CATALYST_ALPHA', lang)}: ${statusLabel}${moveLabel}\n`
  }

  text += `• ${t('NEAR_SUPPORT', lang)}: ${nearSupport ? '✅' : '❌'}\n`

  const isBearish = marketCtx.includes('BEAR')
  const isCautious = marketCtx.includes('CAUTIOUS') || marketCtx.includes('NEUTRAL')
  const safetyValue = isBearish
    ? t('MARKET_DANGEROUS', lang)
    : (isCautious ? t('MARKET_CAUTIOUS', lang) : t('MARKET_SAFE', lang))
  text += `• ${t('MARKET_SAFETY_LABEL', lang)}: <b>${safetyValue}</b>\n\n`

  let emaCtx = payload.emaContext || payload.ema_context
  if ((!emaCtx || emaCtx === 'N/A') && (payload.ema8 || payload.ema21 || payload.sma10 || payload.sma20 || payload.sma50 || payload.sma200)) {
    const parts = []
    if (payload.ema8) parts.push(`EMA 8: $${formatP(payload.ema8)}`)
    if (payload.ema21) parts.push(`EMA 21: $${formatP(payload.ema21)}`)
    if (payload.sma50) parts.push(`SMA 50: $${formatP(payload.sma50)}`)
    if (payload.sma200) parts.push(`SMA 200: $${formatP(payload.sma200)}`)
    emaCtx = parts.join(' | ')
  }

  if (emaCtx && emaCtx !== 'N/A') {
    text += `${t('PRICE_VS_EMA', lang)}\n• ${emaCtx}\n\n`
  }

  text += `${t('MARKET_DASHBOARD', lang)}\n`
  text += `• ${t('BROADER_MARKET', lang)}: ${marketCtx}\n`
  if (sector !== 'N/A') {
    text += `• ${t('SECTOR', lang)}: ${sector}\n`
  }
  text += '\n'

  const earnings = payload.earningsDate || payload.earnings_date || payload.nextEarnings
  if (earnings && earnings !== 'N/A') {
    let countdownStr = ''
    const earningsDateMs = new Date(earnings).getTime()
    if (!isNaN(earningsDateMs)) {
      const now = new Date()
      const earningsDateObj = new Date(earningsDateMs)
      const diffMs = earningsDateMs - now.getTime()
      if (diffMs >= -12 * 60 * 60 * 1000 && diffMs <= 30 * 24 * 60 * 60 * 1000) {
        const tradingDays = getTradingDaysBetween(now, earningsDateObj)
        if (tradingDays === 0) {
          countdownStr = lang === 'ua' ? ' (Сьогодні ⚠️)' : ' (Today ⚠️)'
        } else if (tradingDays > 0) {
          countdownStr = lang === 'ua' ? ` (Через ${tradingDays} тр. дн. ⚠️)` : ` (In ${tradingDays} trading day${tradingDays > 1 ? 's' : ''} ⚠️)`
        }
      }
    }
    text += `${t('EARNINGS_INFO', lang)}\n• ${t('NEXT', lang)}: ${earnings}${countdownStr}\n\n`
  }

  let consensus = payload.analystConsensus || payload.analyst_consensus
  let upside = payload.analystUpside || payload.analyst_upside || 0

  if (!consensus && payload.analystTarget) {
    consensus = `$${payload.analystTarget.toFixed(2)}`
    if (price > 0) {
      upside = ((payload.analystTarget - price) / price) * 100
    }
  }

  if (consensus && consensus !== 'N/A') {
    text += `${t('ANALYST_CONSENSUS', lang)}\n• ${t('LATEST', lang)}: ${consensus} (${upside.toFixed(1)}% ${t('UPSIDE', lang)})\n\n`
  }

  if (news && news !== 'Neutral' && news !== 'N/A') {
    text += `${t('NEWS_SENTIMENT', lang)}\n${news}\n\n`
  }

  if (payload.alignmentStatus && thesis !== 'N/A') {
    text += `🔗 <b>NARRATIVE ALIGNMENT (${payload.alignmentStatus})</b>\n${thesis}\n\n`
    if (payload.connections && payload.connections.length > 0) {
      text += '<b>Key Dependencies:</b>\n'
      payload.connections.slice(0, 3).forEach(c => {
        text += `• ${c.connectionType}: ${c.toTicker}\n`
      })
      text += '\n'
    }
  } else if (thesis && thesis !== 'N/A') {
    text += `${t('NARRATIVE_THESIS', lang)}\n${thesis}\n\n`
  }

  if (replacementFor) {
    text += t('REPLACEMENT_SUGGESTION', lang, { ticker: replacementFor }) + '\n\n'
  }

  // Position Sizing if not already provided
  let shares = payload.shares || 0
  let capitalRequired = payload.capitalRequired || 0

  const { getAvailableCash, loadTrackedStocks } = await import('../server/botHandlers/portfolioHandlers')
  const tracked = await loadTrackedStocks(chatId)
  const existingTrade = tracked.find(t => t.ticker === ticker)

  if (existingTrade) {
    logger.info({ chatId, ticker }, '[SCAN] Skipping alert: user already holds this position in standard portfolio')
    return
  }

  if (price > 0 && sl > 0 && sl < price) {
    const budget = await getUserBudget(db, chat?.userId)
    const baseRiskAmount = budget.maxRiskPerTradeUsd
    const riskAmount = baseRiskAmount * (payload.convictionMultiplier || 1.0)
    const riskPerShare = price - sl
    shares = Math.floor(riskAmount / riskPerShare)
    capitalRequired = shares * price
  }
  const availableCash = await getAvailableCash(chatId)
  if (capitalRequired > availableCash) {
    shares = price > 0 ? Math.floor(availableCash / price) : 0
    capitalRequired = shares * price
  }

  if (shares > 0) {
    const formattedCap = capitalRequired.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    text += `⚖️ <b>${t('POSITION_SIZE', lang)}: $${formattedCap} (~${shares} shares)</b>\n`
    if (payload.breakEvenPrice) {
      text += `🎯 <b>${t('BREAK_EVEN', lang)}: $${payload.breakEvenPrice.toFixed(2)}</b>\n`
    }
    text += '\n'
  }


  // Optimize callback data to avoid 64-byte limit
  const shortStrategy = strategy.substring(0, 15)
  const targetVal = target || (price * 1.05)
  const buyData = `buy:${ticker}:${price.toFixed(2)}:${sl.toFixed(2)}:${targetVal.toFixed(2)}:${atr.toFixed(2)}:${shortStrategy}`

  const buttons = {
    inline_keyboard: [
      [
        { text: t('TRACK_BUY', lang), callback_data: buyData },
        { text: t('IGNORE', lang), callback_data: `ignore:${ticker}` },
      ],
      [
        { text: t('DEEP_SCAN_BTN', lang), callback_data: `deepscan:${ticker}` },
      ],
    ],
  }

  await sendGenericMessage(local(text), buttons, chatId)


}

export async function sendHeartbeatMessage(dbStatus: boolean, apiStatus: boolean, keyStatusByChat: Map<string, boolean> = new Map()) {
  const activeUsers = await db.select().from(settings).where(eq(settings.isHeartbeatEnabled, true))

  for (const user of activeUsers) {
    if (!user.telegramChatId) continue

    const lang = await getChatLanguage(user.telegramChatId)
    const dbIcon = dbStatus ? '✅' : '❌'
    const apiIcon = apiStatus ? '✅' : '❌'
    const keyOk = keyStatusByChat.get(user.telegramChatId)
    const keyIcon = keyOk === undefined ? '—' : (keyOk ? '✅' : '❌')

    const message = `
${t('HEARTBEAT_TITLE', lang)}

• ${t('DB_STATUS', lang)}: ${dbIcon}
• ${t('API_STATUS', lang)}: ${apiIcon}
• ${t('KEY_STATUS', lang)}: ${keyIcon}

${t('HEARTBEAT_FOOTER', lang)}
`
    await sendGenericMessage(local(message), undefined, user.telegramChatId)
  }
}



export async function ensureMasterChatApproved() {
  
  const defaultSettings = await db.select().from(settings).limit(1)
  const masterId = defaultSettings[0]?.telegramChatId || undefined

  if (!masterId) return

  const existing = await db.select().from(settings).where(eq(settings.telegramChatId, String(masterId))).limit(1)
  if (existing.length === 0) {
    await db.insert(settings).values({
      telegramChatId: masterId,
      status: 'approved',
      language: 'en',
    })
  } else if (existing[0]?.status !== 'approved') {
    await db.update(settings).set({ status: 'approved' }).where(eq(settings.telegramChatId, String(masterId)))
  }
}

async function sendLanguageSelection(chatId: string) {
  await sendRawTelegram('sendMessage', {
    chat_id: chatId,
    text: t('CHOOSE_LANGUAGE'),
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🇺🇸 English', callback_data: 'set_lang:en' },
          { text: '🇺🇦 Українська', callback_data: 'set_lang:ua' },
        ],
      ],
    },
  })
}

export async function sendKeyboard(text: LocalizedString | string, replyMarkup: unknown, chatId: string) {
  await sendGenericMessage(text, replyMarkup, chatId)
}

export async function sendGenericMessage(text: LocalizedString | string, reply_markup?: unknown, chatId?: string) {
  if (chatId && PREVIEW_CHAT_IDS.has(chatId)) {
    // Suppress preview account messages from spamming the admin chat
    return
  }
  
  let target = chatId
  if (!target) {
    const defaultSettings = await db.select().from(settings).limit(1)
    target = defaultSettings[0]?.telegramChatId || undefined
  }

  if (!target) return

  if (webConsoleInterceptors.has(target)) {
    webConsoleInterceptors.get(target)!(String(text))
    return
  }

  const fullText = sanitizeTelegramHtml(String(text))
  const MAX_LEN = 4000

  if (fullText.length <= MAX_LEN) {
    const res = await sendRawTelegram('sendMessage', {
      chat_id: target,
      text: fullText,
      parse_mode: 'HTML',
      reply_markup,
    })
    return res?.result?.message_id
  }

  const paragraphs = fullText.split('\n\n')
  let currentChunk = ''
  let lastMessageId

  for (const p of paragraphs) {
    if (currentChunk.length + p.length + 2 > MAX_LEN) {
      if (currentChunk) {
        const res = await sendRawTelegram('sendMessage', {
          chat_id: target,
          text: currentChunk,
          parse_mode: 'HTML',
        })
        lastMessageId = res?.result?.message_id
        currentChunk = ''
      }
      
      if (p.length > MAX_LEN) {
        let tempP = p
        while (tempP.length > 0) {
          const slice = tempP.slice(0, MAX_LEN)
          const res = await sendRawTelegram('sendMessage', {
            chat_id: target,
            text: slice,
            parse_mode: 'HTML',
          })
          lastMessageId = res?.result?.message_id
          tempP = tempP.slice(MAX_LEN)
        }
      } else {
        currentChunk = p
      }
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + p
    }
  }

  if (currentChunk) {
    const res = await sendRawTelegram('sendMessage', {
      chat_id: target,
      text: currentChunk,
      parse_mode: 'HTML',
      reply_markup,
    })
    lastMessageId = res?.result?.message_id
  }

  return lastMessageId
}

export async function sendPhotoMessage(
  photo: string | Buffer | Blob | Uint8Array, caption?: string, reply_markup?: unknown, chatId?: string,
) {
  if (!photo) {
    throw new Error('No photo content provided for sendPhotoMessage')
  }
  if (chatId && PREVIEW_CHAT_IDS.has(chatId)) {
    // Suppress preview account messages from spamming the admin chat
    return
  }
  
  let target = chatId
  if (!target) {
    const defaultSettings = await db.select().from(settings).limit(1)
    target = defaultSettings[0]?.telegramChatId || undefined
  }

  if (!target) return

  if (webConsoleInterceptors.has(target)) {
    webConsoleInterceptors.get(target)!(String(caption || '[Photo]'))
    return
  }

  const res = await sendRawTelegram('sendPhoto', {
    chat_id: target,
    photo,
    caption,
    parse_mode: 'HTML',
    reply_markup,
  })

  if (!res?.ok) {
    throw new Error('Failed to send photo via Telegram WS proxy')
  }
}

export async function sendDocumentMessage(
  document: string | Buffer | Blob | Uint8Array, caption?: string, reply_markup?: unknown, chatId?: string, filename: string = 'backup.sql',
) {
  if (chatId && PREVIEW_CHAT_IDS.has(chatId)) {
    return
  }
  
  let target = chatId
  if (!target) {
    const defaultSettings = await db.select().from(settings).limit(1)
    target = defaultSettings[0]?.telegramChatId || undefined
  }

  if (!target) return

  if (webConsoleInterceptors.has(target)) {
    webConsoleInterceptors.get(target)!(String(caption || `[Document: ${filename}]`))
    return
  }

  await sendRawTelegram('sendDocument', {
    chat_id: target,
    document,
    caption,
    parse_mode: 'HTML',
    reply_markup,
  })
}

export async function sendFridayMacroReport(riskLevel: string) {
  const approvedChats = await db.select().from(settings).where(eq(settings.status, 'approved'))
  
  for (const chat of approvedChats) {
    if (chat.signalMode === 'silent') continue
    const lang = (chat.language as Language) || 'en'
    
    let msg = `📊 <b>${t('FRIDAY_REPORT_TITLE', lang)}</b>\n\n`
    msg += `🧭 <b>${t('MACRO_RISK_ASSESSMENT', lang)}:</b> ${riskLevel}\n\n`
    
    if (riskLevel === 'High') {
      msg += `⚠️ <b>${t('WEEKEND_CATALYST_WARNING', lang)}:</b> High volatility expected. Consider trimming positions.\n`
    } else if (riskLevel === 'Low') {
      msg += `✅ <b>${t('WEEKEND_CATALYST_WARNING', lang)}:</b> Market looks stable. No immediate action required.\n`
    } else {
      msg += `🟡 <b>${t('WEEKEND_CATALYST_WARNING', lang)}:</b> Standard weekend risk. Monitor your stops.\n`
    }

    msg += `\n<i>${t('FRIDAY_REPORT_NOTE', lang)}</i>`

    await sendGenericMessage(msg, undefined, chat.telegramChatId ?? undefined)
  }
}



export async function startPolling(handlers: TelegramHandlers) {
  let lastUpdateId = 0
  logger.info('[TELEGRAM] Starting Polling...')

  while (true) {
    try {
      const res = await fetch(`${TELEGRAM_API}/bot${config.TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`)
      if (!res.ok) throw new Error(`HTTP Error: ${res.status}`)
      
      const data = await res.json() as { ok: boolean; result: TelegramUpdate[] }
      if (data.ok && data.result.length > 0) {
        for (const update of data.result) {
          lastUpdateId = update.update_id
          await processUpdate(update, handlers)
        }
      }
    } catch (e) {
      logger.error({ error: e }, '[TELEGRAM] Poll Failed')
      await new Promise(resolve => setTimeout(resolve, 5000))
    }
  }
}

export async function processUpdate(update: TelegramUpdate, handlers: TelegramHandlers) {
  let chatId: string | undefined = undefined
  let lang: Language = 'en'
  try {
    const rawChatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id
    if (!rawChatId) return

    chatId = String(rawChatId)

    lang = await getChatLanguage(chatId)

    if (update.message?.text) {
      const text = update.message.text.trim()
      const startTime = Date.now()
      const cmdKey = text.startsWith('/') ? text.split(/[\s_]/)[0]!.toLowerCase() : ''
      const lockKey = `${chatId}:${text.toLowerCase()}`
      const readOnlyCommands = [
        BotCommand.STATUS,
        BotCommand.PORTFOLIO,
        BotCommand.HELP,
        BotCommand.SETTINGS,
        BotCommand.BUDGET,
        BotCommand.API,
        BotCommand.CREDIT,
        BotCommand.ME,
        BotCommand.LANG,
      ]
      const isReadOnlyCmd = readOnlyCommands.some(cmd => text === `/${cmd}` || text.startsWith(`/${cmd} `))

      if (!isReadOnlyCmd) {
        if (activeProcessingMap.has(lockKey)) {
          const active = activeProcessingMap.get(lockKey)!
          const elapsedSec = Math.max(1, Math.round((Date.now() - active.startTime) / 1000))
          if (Date.now() - active.startTime < 20000) {
            await sendGenericMessage(t('ALREADY_PROCESSING', lang, { query: active.query, startedAgo: elapsedSec }), undefined, chatId)
            return
          }
          activeProcessingMap.delete(lockKey)
        }
        activeProcessingMap.set(lockKey, { query: text, startTime })
      }

      try {
        if (text.startsWith('/')) {
          const longCommands = [
            BotCommand.SCAN,
            BotCommand.MARKET_SCAN,
            BotCommand.RESEARCH,
            BotCommand.EXIT,
            // Multi-second commands get the same calibrated ETA ack (avg of
            // last 5 runs — see formatCommandEstimate). deep_portfolio is
            // Gemini-driven; optimize is pure rotation math + a /v1/signals
            // fetch — no AI, but still worth an ack.
            BotCommand.OPTIMIZE,
            BotCommand.DEEP_PORTFOLIO,
          ]

          if (longCommands.some(cmd => text === `/${cmd}` || text.startsWith(`/${cmd} `) || text.startsWith(`/${cmd}_`))) {
            // Default for the first runs, then the average of the last 5
            // completed executions of THIS command (see formatCommandEstimate).
            const estimate = formatCommandEstimate(cmdKey)

            await sendGenericMessage(t('ACK_PROCESSING', lang, { query: text, estimate }), undefined, chatId)
          }
        }

        logger.debug({ text, chatId }, '[TELEGRAM] Message received')

        if (text.startsWith('/')) {
          const rawCmd = text.split(/[\s_]/)[0]!.toLowerCase()
          const cmdRoot = rawCmd.split('@')[0]!
          const openCommands = [
            `/${BotCommand.LINK}`,
            `/${BotCommand.START}`,
            `/${BotCommand.HELP}`,
            `/${BotCommand.SETTINGS}`,
          ]

          if (!openCommands.includes(cmdRoot)) {
            const userSetting = (await db.select().from(settings).where(eq(settings.telegramChatId, String(chatId))).limit(1))[0]
            if (!userSetting?.quantourApiKey) {
              await sendGenericMessage(t('ERR_NO_API_KEY', lang), undefined, chatId)
              return
            }
          }
        }

        await sendRawTelegram('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {})

        const rawCmd = text.startsWith('/') ? text.split(/[\s_]/)[0]!.toLowerCase() : ''
        const cmdClean = rawCmd.split('@')[0]!
        const fullCmdClean = text.startsWith('/') ? text.split(/\s+/)[0]!.toLowerCase().split('@')[0]! : ''

        if (cmdClean === `/${BotCommand.SETTINGS}`) {
          await sendGenericMessage(local(getLocalizedHelp(lang)), undefined, chatId)
        } else if (cmdClean === `/${BotCommand.HELP}`) {
          await sendGenericMessage(local(getLocalizedHelp(lang)), undefined, chatId)
        } else if (cmdClean === `/${BotCommand.SCAN}`) {
          let msg = t('SCAN_STARTING', lang)
          try {

            const marketStatus = await fetchFromApi('/market/status')
            if (marketStatus && !marketStatus.isTheStockMarketOpen) {
              msg = (msg + '\n\n<i>' + t('MARKET_CLOSED_RUNNING_LATEST', lang) + '</i>') as LocalizedString
            }
          } catch { 
            // Ignore error
          }
          await sendGenericMessage(msg, undefined, chatId)
          await handlers.runMasterScanner({ isManual: true, chatId })
        } else if (cmdClean === `/${BotCommand.MACRO}`) {
          if (registeredHandlers.handleMacroCheck) await registeredHandlers.handleMacroCheck(chatId, lang)

        } else if (cmdClean === `/${BotCommand.API}` || cmdClean === `/${BotCommand.CREDIT}`) {
          const defaultSettings = await db.select().from(settings).where(eq(settings.telegramChatId, String(chatId))).limit(1)
          const apiKey = defaultSettings[0]?.quantourApiKey
          if (!apiKey) {
            await sendGenericMessage(local('⚠️ You have not linked your Quantour API Key. Send /link <API_KEY> to link.'), undefined, chatId)
          } else {
            try {
              const res = await fetch(`${config.PUBLIC_API_URL}/v1/ping`, {
                headers: { 'x-api-key': apiKey, 'Authorization': `Bearer ${apiKey}`, 'Connection': 'close' },
              })
              if (res.ok) {
                const data = await res.json()
                const plan = data.plan || 'Unknown'
                const credits = data.unlimited ? 'Unlimited' : (data.credits || 0)
                const maskedKey = apiKey.length > 12 ? `${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}` : apiKey
                const msg = `🔑 <b>API Status</b>\n\n• <b>API Token:</b> <code>${maskedKey}</code>\n• <b>Plan:</b> ${plan.toUpperCase()}\n• <b>Remaining Credits:</b> ${credits}\n\n<a href="https://quantourapi.com/dashboard">Manage your account here</a>`
                await sendGenericMessage(local(msg), undefined, chatId)
              } else {
                await sendGenericMessage(local('❌ Invalid or expired API Key. Please /link a valid one.'), undefined, chatId)
              }
            } catch {
              await sendGenericMessage(local('⚠️ Error connecting to API servers.'), undefined, chatId)
            }
          }
        }
        
        else if (cmdClean === `/${BotCommand.ME}`) {
          if (registeredHandlers.handleMe) {
            await registeredHandlers.handleMe(chatId, lang)
          }
        } else if (cmdClean === `/${BotCommand.STATUS}` || cmdClean === `/${BotCommand.PORTFOLIO}`) {
          if (registeredHandlers.handlePortfolioStatus) {
            await registeredHandlers.handlePortfolioStatus(chatId, lang)
          } else {
            await handlers.handlePortfolioStatus(chatId, lang)
          }
        } else if (fullCmdClean === `/${BotCommand.DEEP_PORTFOLIO}` || text.startsWith(`/${BotCommand.DEEP_PORTFOLIO} `)) {
          let loadingMsgId: number | undefined
          const onProgress = async (msg: string) => {
            if (loadingMsgId) {
              await sendRawTelegram('editMessageText', {
                chat_id: chatId,
                message_id: loadingMsgId,
                text: `⏳ ${msg}`,
                parse_mode: 'HTML',
              })
            } else {
              loadingMsgId = await sendGenericMessage(`⏳ ${msg}`, undefined, chatId) as number | undefined
            }
          }
          const runner = handlersContainer.runDeepPortfolio || handlers.runDeepPortfolio
          if (runner) {
            const analysis = await runner(chatId, onProgress)
            if (analysis) {
              if (loadingMsgId) {
                await sendRawTelegram('editMessageText', {
                  chat_id: chatId,
                  message_id: loadingMsgId,
                  text: analysis,
                  parse_mode: 'HTML',
                })
              } else {
                await sendGenericMessage(analysis, undefined, chatId)
              }
            }
          }
        } else if (text.startsWith(`/${BotCommand.BUY} `)) {
          const cmd = `/${BotCommand.BUY} `
          const parts = text.replace(cmd, '').trim().split(/\s+/)
          const ticker = parts[0]?.toUpperCase()
          const rawShares = parseFloat(parts[1] || '0')
          const shares = !isNaN(rawShares) && rawShares > 0 ? rawShares : 0
          if (ticker && shares > 0) {
            await handlers.handleManualAdd(
              ticker, shares, chatId, lang,
            )
          } else {
            await sendGenericMessage(t('CMD_ADD_USAGE', lang, { cmd }), undefined, chatId)
          }
        } else if (text.startsWith(`/${BotCommand.WANT_BUY} `)) {
          const wantTicker = text.replace(`/${BotCommand.WANT_BUY} `, '').trim().split(/\s+/)[0]?.toUpperCase()
          if (wantTicker) {
            await handlers.handleWantBuy(wantTicker, chatId, lang)
          } else {
            await sendGenericMessage(t('CMD_WANT_BUY_USAGE', lang), undefined, chatId)
          }
        } else if (text === `/${BotCommand.SELL}` || text.startsWith(`/${BotCommand.SELL} `) || text.startsWith(`/${BotCommand.SELL}_`)) {
          const cmd = `/${BotCommand.SELL}`
          let ticker = ''
          if (text.startsWith(`/${BotCommand.SELL} `)) {
            const raw = text.replace(`/${BotCommand.SELL} `, '').trim()
            ticker = (raw.split(/\s+/)[0] || '').toUpperCase()
          } else if (text.startsWith(`/${BotCommand.SELL}_`)) {
            const raw = text.replace(`/${BotCommand.SELL}_`, '').trim()
            ticker = (raw.split(/\s+/)[0] || '').toUpperCase()
          }
          if (ticker) {
            if (registeredHandlers.handlePortfolioSell) {
              await registeredHandlers.handlePortfolioSell(ticker, chatId, lang)
            } else {
              await handlers.handleSell(ticker, chatId, lang)
            }
          } else {
            await sendGenericMessage(t('CMD_SELL_USAGE', lang, { cmd: `${cmd} ` }), undefined, chatId)
          }
        } else if (cmdClean === `/${BotCommand.OPTIMIZE}` || cmdClean === '/rotations') {
          if (registeredHandlers.handlePortfolioRotations) {
            await registeredHandlers.handlePortfolioRotations(chatId)
          } else if (handlers.handlePortfolioRotations) {
            await handlers.handlePortfolioRotations(chatId)
          } else {
            logger.warn('handlePortfolioRotationsHandler not registered!')
          }
        } else if (text === `/${BotCommand.BUDGET}` || text.startsWith(`/${BotCommand.BUDGET} `)) {
          const cmd = text.startsWith(`/${BotCommand.BUDGET} `) ? `/${BotCommand.BUDGET} ` : `/${BotCommand.BUDGET}`
          const amountStr = text.replace(cmd, '').trim()
          
          if (amountStr) {
            const amount = parseFloat(amountStr)
            if (!isNaN(amount) && amount > 0) {
              await handlers.handleSetCapital(chatId, amount, lang)
            } else {
              await sendGenericMessage(t('INVALID_BUDGET_USAGE', lang), undefined, chatId)
            }
          }

          if (registeredHandlers.handleBudget) {
            await registeredHandlers.handleBudget(chatId, lang)
          } else {
            logger.warn('handleBudgetHandler not registered!')
          }
        } else if (text === `/${BotCommand.FREE_CASH}` || text.startsWith(`/${BotCommand.FREE_CASH} `)) {
          const cmd = text.startsWith(`/${BotCommand.FREE_CASH} `) ? `/${BotCommand.FREE_CASH} ` : `/${BotCommand.FREE_CASH}`
          const amountStr = text.replace(cmd, '').trim()
          const amount = parseFloat(amountStr)
          if (!isNaN(amount) && amount > 0) {
            if (registeredHandlers.handleFreeCash) {
              await registeredHandlers.handleFreeCash(chatId, amount, lang)
            } else {
              logger.warn('handleFreeCashHandler not registered!')
            }
          } else {
            await sendGenericMessage(t('FREE_CASH_HELP', lang), undefined, chatId)
          }
        } else if (text === `/${BotCommand.PNL}` || text.startsWith(`/${BotCommand.PNL} `)) {
          const arg = text.replace(`/${BotCommand.PNL}`, '').trim().toLowerCase()
          const validTimeframes = [
            'wtd',
            'mtd',
            'ytd',
            'all',
          ]
          const timeframe = validTimeframes.includes(arg) ? arg as 'wtd' | 'mtd' | 'ytd' | 'all' : undefined
          if (arg && !validTimeframes.includes(arg)) {
            await sendGenericMessage(t('PNL_USAGE', lang), undefined, chatId)
          } else if (handlersContainer.handlePnl) {
            await handlersContainer.handlePnl(chatId, lang, timeframe)
          } else {
            await handlers.handlePnl(chatId, lang, timeframe)
          }
        } else if (text === `/${BotCommand.RISK}` || text.startsWith(`/${BotCommand.RISK} `)) {
          const cmd = text.startsWith(`/${BotCommand.RISK} `) ? `/${BotCommand.RISK} ` : `/${BotCommand.RISK}`
          const paramStr = text.replace(cmd, '').trim()

          if (paramStr) {
            await handlers.handleSetRisk(chatId, paramStr, lang)
          } else {
            await handlers.handleRiskProfileMenu(chatId, lang)
          }
        }

        else if (text.startsWith(`/${BotCommand.RESEARCH} `) || text.startsWith(`/${BotCommand.RESEARCH}_`)) {
          let prefix = ''
          if (text.startsWith(`/${BotCommand.RESEARCH} `)) prefix = `/${BotCommand.RESEARCH} `
          else if (text.startsWith(`/${BotCommand.RESEARCH}_`)) prefix = `/${BotCommand.RESEARCH}_`

          const cleanTicker = text.substring(prefix.length).trim().toUpperCase()
          if (cleanTicker) {
            let loadingMsgId: number | undefined
            const onProgress = async (msg: string) => {
              if (loadingMsgId) {
                await sendRawTelegram('editMessageText', {
                  chat_id: chatId,
                  message_id: loadingMsgId,
                  text: `⏳ ${msg}`,
                  parse_mode: 'HTML',
                })
              } else {
                loadingMsgId = await sendGenericMessage(`⏳ ${msg}`, undefined, chatId) as number | undefined
              }
            }
            const analysis = await handlers.runDeepScan(cleanTicker, chatId, onProgress)
            if (analysis) {
              if (loadingMsgId) {
                await sendRawTelegram('editMessageText', {
                  chat_id: chatId,
                  message_id: loadingMsgId,
                  text: analysis,
                  parse_mode: 'HTML',
                })
              } else {
                await sendGenericMessage(analysis, undefined, chatId)
              }
            }
          } else {
            await sendGenericMessage(t('CMD_RESEARCH_USAGE', lang), undefined, chatId)
          }
        }

        else if (text.startsWith(`/${BotCommand.INFO} `) || text.startsWith(`/${BotCommand.INFO}_`)) {
          let prefix = ''
          if (text.startsWith(`/${BotCommand.INFO} `)) prefix = `/${BotCommand.INFO} `
          else if (text.startsWith(`/${BotCommand.INFO}_`)) prefix = `/${BotCommand.INFO}_`

          const cleanTicker = text.substring(prefix.length).trim().toUpperCase()
          if (cleanTicker) {
            if (registeredHandlers.handleInfo) {
              await registeredHandlers.handleInfo(cleanTicker, chatId, lang)
            } else if (handlers.handleInfo) {
              await handlers.handleInfo(cleanTicker, chatId, lang)
            } else {
              logger.warn('handleInfoHandler not registered!')
            }
          } else {
            await sendGenericMessage(t('CMD_INFO_USAGE', lang), undefined, chatId)
          }
        }

        else if (
          text.startsWith(`/${BotCommand.SCAN} `) || text.startsWith(`/${BotCommand.SCAN}_`) || 
          text.startsWith(`/${BotCommand.MARKET_SCAN} `) || text.startsWith(`/${BotCommand.MARKET_SCAN}_`)
        ) {
          let prefix = ''
          if (text.startsWith(`/${BotCommand.SCAN} `)) prefix = `/${BotCommand.SCAN} `
          else if (text.startsWith(`/${BotCommand.SCAN}_`)) prefix = `/${BotCommand.SCAN}_`
          else if (text.startsWith(`/${BotCommand.MARKET_SCAN} `)) prefix = `/${BotCommand.MARKET_SCAN} `
          else if (text.startsWith(`/${BotCommand.MARKET_SCAN}_`)) prefix = `/${BotCommand.MARKET_SCAN}_`

          const cleanTicker = text.substring(prefix.length).trim().toUpperCase()
          if (cleanTicker) {
            await sendGenericMessage(t('SCAN_FOR', lang, { ticker: cleanTicker }), undefined, chatId)
            await handlers.runSingleTickerScan(cleanTicker, chatId)
          }
        }
        
        else if (text.startsWith(`/${BotCommand.NAME} `)) {
          const name = text.replace(`/${BotCommand.NAME} `, '').trim()
          if (name) await handlers.handleSetName(chatId, name, lang)
        } else if (text === `/${BotCommand.LANG}` || text.startsWith(`/${BotCommand.LANG} `)) {
          const parts = text.split(' ')
          const newLang = parts[1]?.toLowerCase() as Language | undefined
          if (newLang && [
            'en',
            'ua',
          ].includes(newLang)) {
            await db.update(settings).set({ language: newLang }).where(eq(settings.telegramChatId, String(chatId)))
            setChatLanguage(chatId, newLang)
            const confirmMsg = t('LANGUAGE_CHANGED', newLang)
            await sendGenericMessage(confirmMsg, undefined, chatId)
            await sendGenericMessage(local(getLocalizedHelp(newLang)), undefined, chatId)
          } else {
            await sendLanguageSelection(chatId)
          }
        } else if (text === `/${BotCommand.SILENT}` || text.startsWith(`/${BotCommand.SILENT} `) || text.startsWith(`/${BotCommand.SILENT}_`)) {
          const arg = text.startsWith(`/${BotCommand.SILENT} `)
            ? text.replace(`/${BotCommand.SILENT} `, '').trim()
            : (text.startsWith(`/${BotCommand.SILENT}_`) ? text.replace(`/${BotCommand.SILENT}_`, '').trim() : undefined)
          await handlers.handleSetSilent(chatId, arg, lang)
        } else if (text === `/${BotCommand.MODE}`) {
          await handlers.handleSetSilent(chatId, undefined, lang)
        } else if (
          text === `/${BotCommand.GUIDE}` ||
          text.startsWith(`/${BotCommand.GUIDE}_`)
        ) {
          if (text.startsWith(`/${BotCommand.GUIDE}_`)) {
            const prefix = `/${BotCommand.GUIDE}_`
            const strat = text.substring(prefix.length).split('@')[0]?.trim()
            const guideKey = strat ? (`GUIDE_${strat.toUpperCase()}` as string) : null
            const guideText = guideKey ? t(guideKey, lang) : null
            if (guideText && guideText !== guideKey) {
              await sendGenericMessage(guideText, undefined, chatId)
            }
          } else {
            await handlers.handleRiskGuide(chatId, lang)
          }

        } else if (text === `/${BotCommand.LINK}` || text.startsWith(`/${BotCommand.LINK} `)) {
          const apiKey = text.replace(`/${BotCommand.LINK}`, '').trim()
          if (!apiKey) {
            await sendGenericMessage(t('LINK_KEY_USAGE', lang), undefined, chatId)
          } else if (apiKey.includes('...')) {
            await sendGenericMessage(local(lang === 'ua' ? '❌ Будь ласка, вкажіть ПОВНИЙ API ключ з дашборду, а не маскований шаблон з "...".' : '❌ Please provide your FULL API Key from the dashboard, not the masked placeholder key containing "...".'), undefined, chatId)
          } else {
            try {
              const apiUrl = config.PUBLIC_API_URL
              const response = await fetch(`${apiUrl}/v1/ping`, { headers: { 'x-api-key': apiKey, 'Connection': 'close' }, signal: AbortSignal.timeout(10000) })
              if (!response.ok) {
                // 401/402 = the key itself is rejected; 5xx/timeouts are
                // server-side issues that a retry may resolve — do not tell
                // the user their key is invalid when the server is the problem.
                if (response.status >= 500) {
                  await sendGenericMessage(t('KEY_VERIFY_NETWORK_ERROR', lang), undefined, chatId)
                } else {
                  await sendGenericMessage(t('INVALID_API_KEY', lang), undefined, chatId)
                }
              } else {
                const data = await response.json()
                const tier = data.plan || 'starter'
                const existing = await db.select().from(settings).where(eq(settings.telegramChatId, String(chatId))).limit(1)
                if (existing.length > 0) {
                  await db.update(settings).set({
                    quantourApiKey: apiKey, userId: data.userId || undefined, status: 'approved', updatedAt: new Date(), 
                  }).where(eq(settings.telegramChatId, String(chatId)))
                } else {
                  await db.insert(settings).values({
                    telegramChatId: String(chatId), quantourApiKey: apiKey, userId: data.userId || undefined, status: 'approved', updatedAt: new Date(),
                  })
                }
                await db.update(trades).set({ chatId: String(chatId) }).where(eq(trades.chatId, 'dashboard_user'))
                await db.update(portfolioStats).set({ chatId: String(chatId) }).where(eq(portfolioStats.chatId, 'dashboard_user'))
                const { reconnectBotWebSocket } = await import('./telegramWsClient')
                await reconnectBotWebSocket().catch(console.error)
                await sendGenericMessage(t('LINK_SUCCESS', lang, { tier: tier.toUpperCase() }), undefined, chatId)
                
                const heartbeatPrompt = t('HEARTBEAT_PROMPT', lang)
                const heartbeatButtons = {
                  inline_keyboard: [
                    [
                      { text: '✅ Yes (Enable)', callback_data: 'enable_heartbeat' },
                      { text: '❌ No (Disable)', callback_data: 'disable_heartbeat' },
                    ],
                  ],
                }
                await sendGenericMessage(heartbeatPrompt, heartbeatButtons, chatId)
              }
            } catch {
              await sendGenericMessage(t('KEY_VERIFY_NETWORK_ERROR', lang), undefined, chatId)
            }
          }
        }
      } finally {
        // Feed the ETA estimator: record the completed run's wall-clock
        // duration for this command (last-5 window; read by formatCommandEstimate).
        recordCommandDuration(cmdKey, Date.now() - startTime)
        if (!isReadOnlyCmd) {
          activeProcessingMap.delete(lockKey)
        }
      }

      // NOTE: a natural-language command interpreter is not implemented in
      // client_api (the original code did `const { InterpreterService } = ({} as {...})`
      // which crashed with "InterpreterService.interpret is not a function" on
      // every non-command message). Non-command text now no-ops instead of
      // crashing; wire a local interpreter if/when NL commands are needed.
    }

    if (update.callback_query) {
      const callbackQuery = update.callback_query
      const chatId = String(callbackQuery.message?.chat.id)
      const data = (callbackQuery.data ?? '').split(':')
      const action = data[0]
      const args = data.slice(1)

      if (action !== 'sync_confirm') {
        await sendRawTelegram('answerCallbackQuery', { callback_query_id: update.callback_query.id })
      }

      if (action === 'stops_why') {
        const { getLastTightenExplain } = await import('../server/clientScanner')
        const { t } = await import('@quantour/shared-algo/src/core/i18n')
        const explain = getLastTightenExplain(chatId)
        await sendGenericMessage(explain ?? t('STOP_WHY_EXPIRED', lang), undefined, chatId)
        return
      }

      if (action === 'scan_view') {
        const viewMode = args[0] as 'top5' | 'all' | 'sector' | 'catalyst'
        const { getScanCache } = await import('../server/clientScanner')
        const cached = getScanCache(chatId)

        if (!cached) {
          const expiredMsg = lang === 'ua' ? '⚠️ Кеш сканування застарiв. Виконай новий /scan.' : '⚠️ Scan cache expired. Please run a new /scan.'
          await sendGenericMessage(local(expiredMsg), undefined, chatId)
          return
        }

        const { t } = await import('@quantour/shared-algo/src/core/i18n')

        let text = ''
        let inline_keyboard: { text: string; callback_data: string }[][] = []

        if (viewMode === 'top5') {
          text = cached.top5Text
          // Show All only when the top-5 view actually truncated something.
          inline_keyboard = [
            [
              ...(cached.totalCount > 5
                ? [
                  { text: `📊 ${t('BTN_SCAN_SHOW_ALL', lang, { count: String(cached.totalCount) })}`, callback_data: 'scan_view:all' },
                ]
                : []),
              { text: `📁 ${t('BTN_SCAN_BY_SECTOR', lang)}`, callback_data: 'scan_view:sector' },
              { text: `🚀 ${t('BTN_SCAN_BY_CATALYST', lang)}`, callback_data: 'scan_view:catalyst' },
            ],
          ]
        } else if (viewMode === 'all') {
          text = cached.allText
          inline_keyboard = [
            [
              { text: `🔝 ${t('BTN_SCAN_TOP5', lang)}`, callback_data: 'scan_view:top5' },
              { text: `📁 ${t('BTN_SCAN_BY_SECTOR', lang)}`, callback_data: 'scan_view:sector' },
              { text: `🚀 ${t('BTN_SCAN_BY_CATALYST', lang)}`, callback_data: 'scan_view:catalyst' },
            ],
          ]
        } else if (viewMode === 'sector') {
          text = cached.sectorText
          inline_keyboard = [
            [
              { text: `🔝 ${t('BTN_SCAN_TOP5', lang)}`, callback_data: 'scan_view:top5' },
              ...(cached.totalCount > 5
                ? [
                  { text: `📊 ${t('BTN_SCAN_SHOW_ALL', lang, { count: String(cached.totalCount) })}`, callback_data: 'scan_view:all' },
                ]
                : []),
              { text: `🚀 ${t('BTN_SCAN_BY_CATALYST', lang)}`, callback_data: 'scan_view:catalyst' },
            ],
          ]
        } else if (viewMode === 'catalyst') {
          text = cached.catalystText
          inline_keyboard = [
            [
              { text: `🔝 ${t('BTN_SCAN_TOP5', lang)}`, callback_data: 'scan_view:top5' },
              ...(cached.totalCount > 5
                ? [
                  { text: `📊 ${t('BTN_SCAN_SHOW_ALL', lang, { count: String(cached.totalCount) })}`, callback_data: 'scan_view:all' },
                ]
                : []),
              { text: `📁 ${t('BTN_SCAN_BY_SECTOR', lang)}`, callback_data: 'scan_view:sector' },
            ],
          ]
        }

        const msgId = callbackQuery.message?.message_id
        if (msgId) {
          await sendRawTelegram('editMessageText', {
            chat_id: chatId,
            message_id: msgId,
            text,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard },
          }).catch(async () => {
            await sendGenericMessage(local(text), { inline_keyboard }, chatId)
          })
        } else {
          await sendGenericMessage(local(text), { inline_keyboard }, chatId)
        }
      } else if (action === 'set_lang') {
        const newLang = args[0] as Language
        await db.update(settings).set({ language: newLang }).where(eq(settings.telegramChatId, String(chatId)))
        setChatLanguage(chatId, newLang)
        await sendRawTelegram('sendMessage', {
          chat_id: chatId,
          text: t('WELCOME_APPROVED', newLang) + '\n\n' + getLocalizedHelp(newLang),
          parse_mode: 'HTML',
        })
      } else if (action === 'set_risk') {
        const profile = args[0] as import('@quantour/shared-algo/src/core/types').RiskProfile
        await handlers.handleSetRiskProfile(chatId, profile, lang)
        try {
          if (update.callback_query?.message?.message_id) {
            await sendRawTelegram('deleteMessage', { chat_id: chatId, message_id: update.callback_query.message.message_id })
          }
        } catch (e) {
          logger.warn({ err: e }, '[TELEGRAM] Failed to delete message after setting risk profile')
        }
      } else if (action === 'start_ai_fix') {
        const logId = args[0]
        const { handleStartAiFix } = await import('../internal/ciNotify')
        await handleStartAiFix(chatId, logId)
      } else if (action === 'approve_ai_fix') {
        const logId = args[0]
        const { handleApproveAiFix } = await import('../internal/ciNotify')
        await handleApproveAiFix(chatId, logId)
      } else if (action === 'feedback_ai_fix') {
        await sendRawTelegram('sendMessage', {
          chat_id: chatId,
          text: '💬 Please reply to this message with your feedback/guidance for the fix.',
          reply_markup: JSON.stringify({
            force_reply: true,
            selective: true,
          }),
        })
      } else if (action === 'portfolio_optimize') {
        const estimate = '~10-15s'
        await sendGenericMessage(t('ACK_PROCESSING', lang, { query: 'portfolio_optimize', estimate }), undefined, chatId)
        await handlers.handlePortfolioRotations(chatId)
      } else if (action === 'optimize_details') {
        await handlers.handleOptimizeDetails(chatId)
      } else if (action === 'apply_optimization') {
        if (registeredHandlers.handleApplyOptimization) {
          await registeredHandlers.handleApplyOptimization(chatId)
        } else if (handlers.handleApplyOptimization) {
          await handlers.handleApplyOptimization(chatId)
        }
      } else if (action === 'sync_confirm') {
        const lang = await getChatLanguage(chatId)
        await sendRawTelegram('answerCallbackQuery', { callback_query_id: update.callback_query.id, text: t('PORTFOLIO_SYNCED', lang).replace(/<\/?[^>]+(>|$)/g, '') })
        await sendGenericMessage(t('PORTFOLIO_SYNCED', lang), undefined, chatId)
        try {
          if (update.callback_query?.message?.message_id) {
            await sendRawTelegram('deleteMessage', { chat_id: chatId, message_id: update.callback_query.message.message_id })
          }
        } catch (e) {
          logger.error({ error: e }, '[TELEGRAM] Failed to delete sync prompt')
        }
      } else if (action === 'update_checkpoint') {
        const [
          ,
          newBalance,
        ] = args
        await sendGenericMessage(`✅ Checkpoint updated to $${newBalance}. Position sizing risk will now be evaluated against this new baseline.`, undefined, chatId)
        try {
          if (update.callback_query?.message?.message_id) {
            await sendRawTelegram('deleteMessage', { chat_id: chatId, message_id: update.callback_query.message.message_id })
          }
        } catch (e) {
          logger.error({ error: e }, '[TELEGRAM] Failed to delete checkpoint prompt')
        }
      } else if (action === 'keep_checkpoint') {
        await sendGenericMessage('✅ Checkpoint unchanged.', undefined, chatId)
        try {
          if (update.callback_query?.message?.message_id) {
            await sendRawTelegram('deleteMessage', { chat_id: chatId, message_id: update.callback_query.message.message_id })
          }
        } catch (e) {
          logger.error({ error: e }, '[TELEGRAM] Failed to delete checkpoint prompt')
        }
      } else if (action === 'disable_auto_checkpoint') {
        const portfolioId = args[0]
        await sendGenericMessage(`⚙️ Auto-Ratchet disabled for Portfolio ${portfolioId}. You will now receive manual prompts.`, undefined, chatId)
      } else if (action === 'enable_auto_checkpoint') {
        const portfolioId = args[0]
        await sendGenericMessage(`🔄 Auto-Ratchet enabled for Portfolio ${portfolioId}. Profits will be automatically locked in.`, undefined, chatId)
      } else if (action === 'reset_confirm' ) {
        await handlers.handleResetConfirm(chatId)
        try {
          if (update.callback_query?.message?.message_id) {
            await sendRawTelegram('deleteMessage', { chat_id: chatId, message_id: update.callback_query.message.message_id })
          }
        } catch (e) {
          logger.error({ error: e }, '[TELEGRAM] Failed to delete confirmation message')
        }
      } else if (action === 'reset_cancel' ) {
        await sendGenericMessage(t('RESET_CANCELLED', lang), undefined, chatId)
        try {
          if (update.callback_query?.message?.message_id) {
            await sendRawTelegram('deleteMessage', { chat_id: chatId, message_id: update.callback_query.message.message_id })
          }
        } catch (e) {
          logger.error({ error: e }, '[TELEGRAM] Failed to delete confirmation message')
        }
      } else if (action === 'macro_status' ) {
        const [
          narrativeId,
          status,
        ] = args
        if (narrativeId && status) {
          const id = parseInt(narrativeId)
          const defaultSettings = await db.select().from(settings).limit(1)
          const apiKey = defaultSettings[0]?.quantourApiKey
          if (apiKey) {
            try {
              await fetch(`${config.API_URL}/api/v1/macro/${id}`, {
                method: 'PATCH',
                headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ status }),
              })
            } catch { /* ignore */ }
          }
          await sendGenericMessage(t('NARRATIVE_STATUS_UPDATED', lang, { status }), undefined, chatId)
          try {
            if (update.callback_query?.message?.message_id) {
              await sendRawTelegram('deleteMessage', { chat_id: chatId, message_id: update.callback_query.message.message_id })
            }
          } catch (e) {
            logger.error({ error: e }, '[TELEGRAM] Failed to delete callback message')
          }
        }
      }
      if (action === 'buy') {
        // buy:${ticker}:${entry}:${sl}:${tp}:${atr}:${strategy}
        await handlers.handleBuy({
          ticker: args[0]!,
          entry: parseFloat(args[1]!),
          sl: parseFloat(args[2]!),
          tp: parseFloat(args[3]!),
          atr: parseFloat(args[4]!),
          strategy: args[5]!,
          chatId,
        })
      } else if (action === 'sell') {
        await handlers.handleSell(args[0]!, chatId)
      } else if (action === 'explain_binary') {
        const ticker = args[0]
        if (ticker) {
          const estimate = '~5-10s'
          await sendGenericMessage(local(`🔍 ${t('ACK_PROCESSING', lang, { query: `explain ${ticker}`, estimate })}`), undefined, chatId)
          if (handlers.handleExplainBinary) await handlers.handleExplainBinary(ticker, chatId, lang)
        }
      } else if (action === 'deepscan') {
        await handlers.runDeepScan(args[0]!, chatId)
      } else if (action === 'deep_portfolio') {
        const runner = handlersContainer.runDeepPortfolio || handlers.runDeepPortfolio
        if (runner) await runner(chatId)
      } else if (action === 'scan') {
        const ticker = args[0]!
        const cached = null
        if (cached) {
          await sendTelegramAlert(cached, chatId)
        } else {
          await handlers.runSingleTickerScan(ticker, chatId)
        }
      } else if (action === 'run_scan') {
        let msg = t('SCAN_STARTING', lang)
        try {

          const marketStatus = await fetchFromApi('/market/status')
          if (marketStatus && !marketStatus.isTheStockMarketOpen) {
            msg = (msg + '\n\n<i>' + t('MARKET_CLOSED_RUNNING_LATEST', lang) + '</i>') as LocalizedString
          }
        } catch {
          // ignore error to still send start message
        }
        await sendGenericMessage(msg, undefined, chatId)
        await handlers.runMasterScanner({ isManual: true, chatId })
      } else if (action === 'settings') {
        await sendGenericMessage(local(getLocalizedHelp(lang)), undefined, chatId)
      } else if (action === 'ignore') {
        await sendGenericMessage(t('SETUP_IGNORED', lang, { name: args[0]! }), undefined, chatId)
      } else if (action === 'approve_chat') {
        const targetChatId = args[0]!
        await db.update(settings).set({ status: 'approved' }).where(eq(settings.telegramChatId, String(chatId)))
        await sendRawTelegram('sendMessage', {
          chat_id: chatId,
          text: `✅ Chat <code>${targetChatId}</code> approved.`,
          parse_mode: 'HTML',
        })
        await sendRawTelegram('sendMessage', {
          chat_id: targetChatId,
          text: '✅ Your access has been approved! You will now receive market signals and can use bot commands.',
          parse_mode: 'HTML',
        })
      } else if (action === 'interpret') {
        const cmd = args[0]!
        const paramsBase64 = args[1]!
        try {
          const params = JSON.parse(Buffer.from(paramsBase64, 'base64').toString('utf-8')) as { ticker?: string; shares?: string }
          const ticker = (params.ticker || '').toUpperCase()
          const shares = parseInt(params.shares || '0', 10)

          switch (cmd) {
            case 'buy':
              if (ticker && shares > 0) await handlers.handleManualAdd(
                ticker, shares, chatId, lang,
              )
              break
            case 'sell':
              if (ticker) await handlers.handleSell(ticker, chatId, lang)
              break
            case 'info':
              if (ticker) await handlers.handleInfo(ticker, chatId, lang)
              break
            case 'research':
              if (ticker) await handlers.runDeepScan(ticker, chatId)
              break
            case 'status':
              await handlers.handlePortfolioStatus(chatId, lang)
              break
            case 'scan': {
              let scanMsg = t('SCAN_STARTING', lang)
              try {
                const marketStatus = await fetchFromApi('/market/status')
                if (marketStatus && !marketStatus.isTheStockMarketOpen) {
                  scanMsg = (scanMsg + '\n\n<i>' + t('MARKET_CLOSED_RUNNING_LATEST', lang) + '</i>') as LocalizedString
                }
              } catch { 
                // ignore error to still send start message
              }
              await sendGenericMessage(scanMsg, undefined, chatId)
              await handlers.runMasterScanner({ isManual: true, chatId })
              break
            }
            case 'macro':
              if (registeredHandlers.handleMacroCheck) await registeredHandlers.handleMacroCheck(chatId, lang)
              break
          }
          
          if (update.callback_query?.message?.message_id) {
            await sendRawTelegram('deleteMessage', { chat_id: chatId, message_id: update.callback_query.message.message_id })
          }
        } catch (e) {
          logger.error({ error: e }, '[INTERPRETER] Failed to execute interpreted command')
        }
      } else if (action === 'decline_chat') {
        const targetChatId = args[0]!
        await db.update(settings).set({ status: 'declined' }).where(eq(settings.telegramChatId, String(chatId)))
        await sendRawTelegram('sendMessage', {
          chat_id: chatId,
          text: `❌ Chat <code>${targetChatId}</code> declined.`,
          parse_mode: 'HTML',
        })
      } else if (action === 'liquidate' ) {
        const ticker = args[0]!
        const targetChatId = args[1]!
        await handlers.handleSell(
          ticker, targetChatId, undefined, 'NARRATIVE_INVALIDATED',
        )
        await sendGenericMessage(local(`🔴 Stopped tracking ${ticker} in portfolio ${targetChatId} (marked as sold).`), undefined, chatId)
        try {
          if (update.callback_query?.message?.message_id) {
            await sendRawTelegram('deleteMessage', { chat_id: chatId, message_id: update.callback_query.message.message_id })
          }
        } catch (e) {
          logger.error({ error: e }, '[TELEGRAM] Failed to delete callback message')
        }
      } else if (action === 'approve_thesis') {
        const ticker = args[0]!
        const targetChatId = args[1]!
        const msgText = lang === 'ua'
          ? `✅ <b>Інвестиційну тезу для ${ticker} успішно затверджено!</b>`
          : `✅ <b>Investment thesis for ${ticker} successfully approved!</b>`
        await sendGenericMessage(local(msgText), undefined, targetChatId)
        try {
          if (update.callback_query?.message?.message_id) {
            await sendRawTelegram('deleteMessage', { chat_id: chatId, message_id: update.callback_query.message.message_id })
          }
        } catch (e) {
          logger.error({ error: e }, '[TELEGRAM] Failed to delete callback message')
        }
      } else if (action === 'edit_thesis') {
        const ticker = args[0]!
        const targetChatId = args[1]!
        const msgText = lang === 'ua'
          ? `✏️ <b>Щоб змінити тезу</b>, надішліть команду у форматі:\n<code>/thesis ${ticker} &lt;ваша нова теза&gt;</code>`
          : `✏️ <b>To edit the thesis</b>, please send a command in the format:\n<code>/thesis ${ticker} &lt;your new thesis text&gt;</code>`
        await sendGenericMessage(local(msgText), undefined, targetChatId)
        try {
          if (update.callback_query?.message?.message_id) {
            await sendRawTelegram('deleteMessage', { chat_id: chatId, message_id: update.callback_query.message.message_id })
          }
        } catch (e) {
          logger.error({ error: e }, '[TELEGRAM] Failed to delete callback message')
        }
      } else if (action === 'enable_heartbeat') {
        await db.update(settings).set({ isHeartbeatEnabled: true }).where(eq(settings.telegramChatId, String(chatId)))
        await sendGenericMessage(t('HEARTBEAT_ENABLED_MSG', lang), undefined, chatId)
        try { if (update.callback_query?.message?.message_id) await sendRawTelegram('deleteMessage', { chat_id: chatId, message_id: update.callback_query.message.message_id }) } catch { /* ignore */ }
      } else if (action === 'disable_heartbeat') {
        await db.update(settings).set({ isHeartbeatEnabled: false }).where(eq(settings.telegramChatId, String(chatId)))
        await sendGenericMessage(t('HEARTBEAT_DISABLED_MSG', lang), undefined, chatId)
        try { if (update.callback_query?.message?.message_id) await sendRawTelegram('deleteMessage', { chat_id: chatId, message_id: update.callback_query.message.message_id }) } catch { /* ignore */ }
      } else if (action === 'dismiss_alert') {
        try {
          if (update.callback_query?.message?.message_id) {
            await sendRawTelegram('deleteMessage', { chat_id: chatId, message_id: update.callback_query.message.message_id })
          }
        } catch (e) {
          logger.error({ error: e }, '[TELEGRAM] Failed to delete callback message')
        }
      } else if (action === 'dismiss_global_event' ) {
        const eventId = parseInt(args[0] || '')
        if (!isNaN(eventId)) {
          const defaultSettings = await db.select().from(settings).limit(1)
          const apiKey = defaultSettings[0]?.quantourApiKey
          if (!apiKey) return
          
          try {
            const res = await fetch(`${config.API_URL}/api/v1/events/dismiss/${eventId}`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${apiKey}` },
            })
            if (res.ok) {
              await sendGenericMessage(local(`❌ Dismissed macro catalyst: ${eventId}`), undefined, chatId)
            } else {
              await sendGenericMessage(local('⚠️ Failed to dismiss catalyst.'), undefined, chatId)
            }
          } catch {
            await sendGenericMessage(local('⚠️ Failed to dismiss catalyst.'), undefined, chatId)
          }
          try {
            if (update.callback_query?.message?.message_id) {
              await sendRawTelegram('deleteMessage', { chat_id: chatId, message_id: update.callback_query.message.message_id })
            }
          } catch (e) {
            logger.error({ error: e }, '[TELEGRAM] Failed to delete callback message')
          }
        }
      } else if (action === 'approve_global_event' ) {
        const eventId = parseInt(args[0] || '')
        if (!isNaN(eventId)) {
          const defaultSettings = await db.select().from(settings).limit(1)
          const apiKey = defaultSettings[0]?.quantourApiKey
          if (!apiKey) return
          
          try {
            const res = await fetch(`${config.API_URL}/api/v1/events/approve/${eventId}`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${apiKey}` },
            })
            if (res.ok) {
              await sendGenericMessage(local(`✅ Approved macro catalyst: ${eventId}`), undefined, chatId)
            } else {
              await sendGenericMessage(local('⚠️ Failed to approve catalyst.'), undefined, chatId)
            }
          } catch {
            await sendGenericMessage(local('⚠️ Failed to approve catalyst.'), undefined, chatId)
          }
          try {
            if (update.callback_query?.message?.message_id) {
              await sendRawTelegram('deleteMessage', { chat_id: chatId, message_id: update.callback_query.message.message_id })
            }
          } catch (e) {
            logger.error({ error: e }, '[TELEGRAM] Failed to delete callback message')
          }
        }
      } else if (action === 'rotation_rationale') {
        const targetChatId = args[0]!
        const rationale = analysisCache.getRotationRationale(targetChatId, lang)
        if (rationale) {
          await sendGenericMessage(local(`${t('DETAILED_RATIONALE', lang)}\n\n${rationale}`), undefined, chatId)
        } else {
          await sendGenericMessage(t('ERR_RATIONALE_NOT_FOUND', lang), undefined, chatId)
        }
      } else if (action === 'show_batch') {
        const batchIdStr = args[0]
        if (batchIdStr) {
          const batchId = parseInt(batchIdStr, 10)
          const [
            batch,
          ] = await db.select().from(notificationBatches).where(eq(notificationBatches.id, batchId)).limit(1)
          if (batch && update.callback_query?.message?.message_id) {
            const chatInfo = (await db.select().from(settings).where(eq(settings.telegramChatId, String(chatId))).limit(1))[0]
            const lang = (chatInfo?.language as Language) || 'en'
            const buttons = [
              [
                { text: t('BATCH_HIDE', lang), callback_data: `hide_batch:${batch.id}` },
              ],
            ]
            await sendRawTelegram('editMessageText', {
              chat_id: chatId,
              message_id: update.callback_query.message.message_id,
              text: batch.fullText,
              parse_mode: 'HTML',
              reply_markup: { inline_keyboard: buttons },
            })
          }
        }
      } else if (action === 'hide_batch') {
        const batchIdStr = args[0]
        if (batchIdStr) {
          const batchId = parseInt(batchIdStr, 10)
          const [
            batch,
          ] = await db.select().from(notificationBatches).where(eq(notificationBatches.id, batchId)).limit(1)
          if (batch && update.callback_query?.message?.message_id) {
            const chatInfo = (await db.select().from(settings).where(eq(settings.telegramChatId, String(chatId))).limit(1))[0]
            const lang = (chatInfo?.language as Language) || 'en'
            const buttons = [
              [
                { text: t('BATCH_SHOW_FULL', lang), callback_data: `show_batch:${batch.id}` },
              ],
            ]
            await sendRawTelegram('editMessageText', {
              chat_id: chatId,
              message_id: update.callback_query.message.message_id,
              text: batch.summary,
              parse_mode: 'HTML',
              reply_markup: { inline_keyboard: buttons },
            })
          }
        }
      }
    }
  } catch (e) {
    logger.error({ error: e, update }, '[TELEGRAM] Failed to process update')
    try {
      const err = e instanceof Error ? e : new Error(String(e))
      const errorMsg = err.message
      const isExpected = errorMsg.includes('API key') || errorMsg.includes('Not found') || errorMsg.includes('Invalid')
      const msg = isExpected 
        ? `❌ ${errorMsg}` 
        : `${t('CMD_ERROR', lang)}\n\n<pre>${errorMsg}</pre>`
      await sendGenericMessage(msg, undefined, chatId)
    } catch {
      // Ignore
    }
  }
}

export { sendRawTelegram } from './rawTelegramDispatcher'

export async function queueNotification() {}

export async function processPendingNotifications() {
  // Disabled in client_api
}
