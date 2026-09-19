export * from './botHandlers/accountHandlers'
export * from './botHandlers/adminHandlers'
export * from './botHandlers/infoHandlers'
export * from './botHandlers/pnlHandlers'
export * from './botHandlers/portfolioHandlers'
export * from './botHandlers/scanHandlers'
export * from './botHandlers/settingsHandlers'
export * from './clientScanner'

import { withQuantourKey } from '../services/apiCheck'
import { registerBotHandlers } from '../services/telegramService'

import { handleMe } from './botHandlers/accountHandlers'
import {
  handleInfo, handleMacroCheck,
} from './botHandlers/infoHandlers'
import {
  getAvailableCash, handleApplyOptimization, handleBudget,
  handleBuy, handleFreeCash, handleOptimizeDetails, handlePortfolioRotations, handlePortfolioSell, handlePortfolioStatus, 
} from './botHandlers/portfolioHandlers'

export const runDeepScan = withQuantourKey(1, async (ticker: string, chatId: string, onProgress?: (msg: string) => Promise<void>) => {
  const { db } = await import('../db')
  const { settings } = await import('../db/clientSchema')
  const { getChatLanguage } = await import('../services/telegramService')
  const { t } = await import('@quantour/shared-algo/src/core/i18n')
  const { translateAiContent } = await import('../services/aiTranslator')
  const lang = await getChatLanguage(chatId)

  if (onProgress) await onProgress(t('DEEP_RESEARCH_START', lang, { ticker: ticker.toUpperCase() }))
  try {
    const { eq } = await import('drizzle-orm')
    const [
      allSettings,
    ] = await db.select().from(settings).where(eq(settings.telegramChatId, String(chatId))).limit(1)

    const { config } = await import('../config')
    const CENTRAL_API_URL = config.API_URL
    const res = await fetch(`${CENTRAL_API_URL}/api/v1/research`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${allSettings?.quantourApiKey}`,
      },
      body: JSON.stringify({ ticker: ticker.toUpperCase() }),
    })

    const escapeHtml = (text: string) => text ? String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : ''

    const data = await res.json()
    if (!res.ok || !data.success) {
      return `❌ Deep scan failed: ${escapeHtml(data.error || 'Unknown error')}`
    }

    // Translate AI-generated analysis to the user's language.
    // Uses GEMINI_TRANSLATION_MODEL (gemini-3.5-flash-lite, the cheapest model). Falls back to English
    // on failure — user always gets a response, never blocked by translation.
    return await translateAiContent(data.analysis as string, lang)
  } catch (e) {
    const escapeHtml = (text: string) => text ? String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : ''
    return `❌ Deep scan error: ${escapeHtml(e instanceof Error ? e.message : String(e))}`
  }
})

export const runSingleTickerScan = async (ticker: string, chatId: string) => { 
  const { runMasterScanner } = await import('./clientScanner')
  await runMasterScanner({ isManual: true, chatId, ticker })
}

export const runDeepPortfolio = withQuantourKey(0, async (chatId: string, onProgress?: (msg: string) => Promise<void>): Promise<string | undefined> => {
  const { db } = await import('../db')
  const { settings } = await import('../db/clientSchema')
  const { loadTrackedStocks } = await import('./botHandlers/portfolioHandlers')
  const { getChatLanguage, sendGenericMessage } = await import('../services/telegramService')
  const { t } = await import('@quantour/shared-algo/src/core/i18n')
  const { translateAiContent } = await import('../services/aiTranslator')
  const { eq } = await import('drizzle-orm')

  const lang = await getChatLanguage(chatId)
  const [
    allSettings,
  ] = await db.select().from(settings).where(eq(settings.telegramChatId, String(chatId))).limit(1)

  // Account scope: all devices/chats sharing this chat's API key see one portfolio.
  const { getAccountScopeByKey } = await import('./dashboardIdentity')
  const accountScope = await getAccountScopeByKey(db, allSettings?.quantourApiKey)
  const tracked = await loadTrackedStocks(chatId, accountScope.userId ?? allSettings?.userId ?? undefined, accountScope.chatIds)
  if (tracked.length === 0) {
    const emptyMsg = t('ERR_PORTFOLIO_EMPTY', lang)
    if (onProgress) await onProgress(emptyMsg)
    else await sendGenericMessage(emptyMsg, undefined, chatId)
    return undefined
  }

  if (onProgress) await onProgress(t('DEEP_PORTFOLIO_START', lang))

  try {
    const { config } = await import('../config')
    const CENTRAL_API_URL = config.API_URL
    const res = await fetch(`${CENTRAL_API_URL}/api/v1/deep-portfolio`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${allSettings?.quantourApiKey}`,
      },
      body: JSON.stringify({
        portfolio: tracked.map(s => ({
          ticker: s.ticker,
          entry: s.entry,
          stopLoss: s.stopLoss,
          target: s.target,
          capitalDeployed: s.capitalDeployed,
        })),
      }),
    })

    const escapeHtml = (text: string) => text ? String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : ''

    if (res.status === 402) {
      return t('ERR_INSUFFICIENT_CREDITS', lang)
    }

    const data = await res.json()
    if (!res.ok || !data.success) {
      return `❌ Deep portfolio analysis failed: ${escapeHtml(data.error || 'Unknown error')}`
    }

    return await translateAiContent(data.analysis as string, lang)
  } catch (e) {
    const escapeHtml = (text: string) => text ? String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : ''
    return `❌ Deep portfolio analysis error: ${escapeHtml(e instanceof Error ? e.message : String(e))}`
  }
})

setTimeout(() => {
  registerBotHandlers({
    handleBuy: withQuantourKey(1, handleBuy),
    getAvailableCash: withQuantourKey(0, getAvailableCash),
    handlePortfolioSell: withQuantourKey(1, handlePortfolioSell),
    handlePortfolioStatus: withQuantourKey(0, handlePortfolioStatus),
    handlePortfolioRotations: withQuantourKey(0, handlePortfolioRotations),
    handleOptimizeDetails: withQuantourKey(0, handleOptimizeDetails),
    handleBudget: withQuantourKey(0, handleBudget),
    handleFreeCash: withQuantourKey(0, handleFreeCash),
    handleInfo: withQuantourKey(1, handleInfo),
    handleMacroCheck: withQuantourKey(0, handleMacroCheck),
    runDeepPortfolio,
    handleApplyOptimization: withQuantourKey(0, handleApplyOptimization),
    handleMe: withQuantourKey(0, handleMe),
  })
}, 0)
