import {
  t,
} from '@quantour/shared-algo/src/core/i18n'
import { eq } from 'drizzle-orm'

import { db as localDb } from '~/db'
import { settings } from '~/db/clientSchema'
import {
  invalidateKeyCache, pingKey, 
} from '~/services/keyValidator'
import { getChatLanguage } from '~/services/telegramService'

export async function handleLink(chatId: string, apiKey: string, sendMessage: (chatId: string, msg: string) => Promise<void>) {
  if (!apiKey) {
    await sendMessage(chatId, 'Please provide an API key. Usage: /link <API_KEY>')
    return
  }

  // Verify the API Key with the Public API
  try {
    const result = await pingKey(apiKey, { bypassCache: true })

    if (!result.ok) {
      const existing = await localDb.select().from(settings).where(eq(settings.telegramChatId, chatId)).limit(1)
      const wasPreviouslyApproved = existing.some(s => s.quantourApiKey && s.status === 'approved')
      const lang = await getChatLanguage(chatId)
      const status = result.status
      if (!status || status >= 500) {
        // Network error, timeout, or server-side failure — the key may be fine.
        await sendMessage(chatId, t('KEY_VERIFY_NETWORK_ERROR', lang))
        return
      }
      const head = wasPreviouslyApproved
        ? t('KEY_INVALID_PREVIOUS_ACTIVE', lang)
        : t('INVALID_API_KEY', lang)
      await sendMessage(chatId, head)
      return
    }

    const tier = result.plan || 'starter'
    const userId = result.userId || null
    const userEmail = result.email || null

    invalidateKeyCache(apiKey)

    // Upsert into local SQLite
    const existing = await localDb.select().from(settings).where(eq(settings.telegramChatId, chatId)).limit(1)

    if (existing.length > 0) {
      await localDb.update(settings).set({
        quantourApiKey: apiKey,
        status: 'approved',
        userId,
        userEmail,
        updatedAt: new Date(),
      }).where(eq(settings.telegramChatId, chatId))
    } else {
      await localDb.insert(settings).values({
        telegramChatId: chatId,
        quantourApiKey: apiKey,
        status: 'approved',
        userId,
        userEmail,
        updatedAt: new Date(),
      })
    }

    if (userId) {
      const {
        pnlHistory, portfolioStats, tradeAuditLog, trades,
      } = await import('~/db/clientSchema')
      await localDb.update(trades).set({ userId }).where(eq(trades.chatId, chatId))
      await localDb.update(portfolioStats).set({ userId }).where(eq(portfolioStats.chatId, chatId))
      await localDb.update(pnlHistory).set({ userId }).where(eq(pnlHistory.chatId, chatId))
      await localDb.update(tradeAuditLog).set({ userId }).where(eq(tradeAuditLog.chatId, chatId))
    }

    await sendMessage(chatId, `✅ Successfully linked your account! Your tier is set to: **${tier.toUpperCase()}**`)
  } catch (err) {
    console.error('Error linking API Key:', err)
    await sendMessage(chatId, '⚠️ Failed to verify API Key due to a network error. Please try again later.')
  }
}
