import {
  getChatLanguage, Language, local,t, 
} from '@quantour/shared-algo/src/core/i18n'
import { execSync } from 'child_process'
import { eq } from 'drizzle-orm'
import { existsSync } from 'fs'

import { db as localDb } from '~/db'
import {
  portfolioStats, settings, trades, 
} from '~/db/clientSchema'
import { logger } from '~/services/logger'
import { sendGenericMessage } from '~/services/telegramService'

const INITIAL_TEST_PORTFOLIO = 30000

export async function handleLogs(lines: number, chatId: string, lang?: Language) {
  if (!lang) lang = await getChatLanguage(chatId)

  const filename = 'bot.log' // or wherever it writes
  if (!existsSync(filename)) {
    await sendGenericMessage(t('ERR_LOG_FILE_NOT_FOUND', lang, { filename }), undefined, chatId)
    return
  }
  try {
    const logs = execSync(`tail -n ${lines} ${filename}`).toString()
    const truncatedLogs = logs.length > 3900 ? logs.slice(-3900) : logs
    await sendGenericMessage(local(t('LOGS_HEADER', lang, { lines }) + `\n<pre>${truncatedLogs}</pre>`), undefined, chatId)
  } catch (e: unknown) {
    const errorMsg = e instanceof Error ? e.message : String(e)
    await sendGenericMessage(t('ERR_READ_LOGS_FAILED', lang, { errorMsg }), undefined, chatId)
  }
}

export async function handleAiStats(chatId: string) {
  const filename = 'bot.log'
  if (!existsSync(filename)) {
    await sendGenericMessage('No logs found to calculate AI stats.', undefined, chatId)
    return
  }
  try {
    const totalSentiments = parseInt(execSync(`grep -c "\\[SENTIMENT\\]" ${filename} || true`).toString().trim()) || 0
    const rejections = parseInt(execSync(`grep -c "\\[SENTIMENT\\] Rejecting" ${filename} || true`).toString().trim()) || 0
    
    let msg = '🤖 <b>AI Sentiment Monitoring</b> 🤖\n\n'
    msg += `Total Sentiment Checks (in logs): ${totalSentiments}\n`
    msg += `Total Rejections (< 60% safe threshold): ${rejections}\n`
    
    if (totalSentiments > 0) {
      const rate = ((rejections / totalSentiments) * 100).toFixed(1)
      msg += `Rejection Rate: <b>${rate}%</b>\n\n`
      
      if (parseFloat(rate) > 50) {
        msg += '⚠️ <b>ALERT: Excessive rejections detected!</b> The 60% safety threshold might be too aggressive.'
      } else {
        msg += '✅ Rejection rate is within normal bounds.'
      }
    }
    await sendGenericMessage(local(msg), undefined, chatId)
  } catch (e: unknown) {
    const errorMsg = e instanceof Error ? e.message : String(e)
    await sendGenericMessage(`Failed to calculate stats: ${errorMsg}`, undefined, chatId)
  }
}

export async function handleReset(chatId: string, lang?: Language) {
  if (!lang) lang = await getChatLanguage(chatId)
  const message = t('TRACKING_RESET_CONFIRM', lang)
  const buttons = {
    inline_keyboard: [
      [
        { text: '🔥 ' + t('BTN_YES_RESET', lang), callback_data: 'reset_confirm' },
        { text: '❌ ' + t('BTN_CANCEL', lang), callback_data: 'reset_cancel' },
      ],
    ],
  }
  await sendGenericMessage(message, buttons, chatId)
}

export async function handleResetConfirm(chatId: string) {
  const lang = await getChatLanguage(chatId)
  
  await localDb.delete(trades).where(eq(trades.chatId, chatId))
  
  await localDb.update(portfolioStats).set({
    initialCapital: INITIAL_TEST_PORTFOLIO.toString(),
    currentCapital: INITIAL_TEST_PORTFOLIO.toString(),
    dailyStartingCapital: INITIAL_TEST_PORTFOLIO.toString(),
    weeklyStartingCapital: INITIAL_TEST_PORTFOLIO.toString(),
    monthlyStartingCapital: INITIAL_TEST_PORTFOLIO.toString(),
    isMarginCalled: false,
  }).where(eq(portfolioStats.chatId, chatId))

  const { setUserBudget } = await import('../budgetService')
  const chatRow = (await localDb.select().from(settings).where(eq(settings.telegramChatId, chatId)).limit(1))[0]
  await setUserBudget(localDb, chatRow?.userId, { totalCapital: INITIAL_TEST_PORTFOLIO.toString() })
  
  await sendGenericMessage(t('PORTFOLIO_TRACKING_CLEARED', lang), undefined, chatId)
}

export async function handleSendDM(targetChatId: string, message: string, adminChatId: string) {
  try {
    const user = (await localDb.select().from(settings).where(eq(settings.telegramChatId, targetChatId)).limit(1))[0]
    if (!user) {
      await sendGenericMessage(t('USER_NOT_FOUND', 'en', { chatId: targetChatId }), undefined, adminChatId)
      return
    }

    const lang = (user.language as Language) || 'en'
    const formatted = t('DM_RECEIVED', lang, { message })
    
    await sendGenericMessage(formatted, undefined, targetChatId)
    await sendGenericMessage(t('DM_SENT', 'en', { name: user.userName || 'Unknown', chatId: targetChatId }), undefined, adminChatId)
  } catch (e) {
    logger.error({ error: e }, '[BOT] DM failed')
    const adminLang = await getChatLanguage(adminChatId)
    await sendGenericMessage(t('ERR_DM_FAILED', adminLang), undefined, adminChatId)
  }
}
