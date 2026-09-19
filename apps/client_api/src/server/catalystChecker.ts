import {
  local, t,
} from '@quantour/shared-algo/src/core/i18n'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

import { db } from '~/db'
import {
  settings, trades,
} from '~/db/clientSchema'
import { fetchFromApi } from '~/services/apiClient'
import { logger } from '~/services/logger'
import {
  getChatLanguage, sendGenericMessage,
} from '~/services/telegramService'

const CatalystItemSchema = z.object({
  ticker: z.string().optional(),
  nextEarnings: z.string().nullable().optional(),
}).passthrough()

const CatalystSchema = z.union([
  z.array(CatalystItemSchema),
  z.object({ data: z.array(CatalystItemSchema).optional() }).passthrough(),
]).catch({ data: [] })

/**
 * Daily catalyst check — for every user with held positions, fetch nextEarnings
 * from the central API and notify if any catalyst falls within 3 days. Runs at
 * noon NY time (cronJobs) so the user has time to act before close.
 */
export async function checkPositionCatalysts(): Promise<void> {
  try {
    const allSettings = await db.select().from(settings)
    const now = Date.now()
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000

    for (const user of allSettings) {
      if (!user.telegramChatId) continue
      const userTrades = await db.select().from(trades).where(eq(trades.chatId, user.telegramChatId))
      if (userTrades.length === 0) continue

      const tickers = [
        ...new Set(userTrades.map(tr => tr.ticker)),
      ]
      const res = await fetchFromApi(
        '/metrics', CatalystSchema, {
          method: 'POST',
          body: JSON.stringify({ tickers }),
        }, user.telegramChatId,
      ).catch(() => null)
      if (!res) continue

      const items = Array.isArray(res) ? res : (res.data ?? [])
      const lang = await getChatLanguage(user.telegramChatId)
      const upcoming: string[] = []

      for (const item of items) {
        if (!item.nextEarnings) continue
        const earningsDate = new Date(item.nextEarnings)
        if (isNaN(earningsDate.getTime())) continue
        const msUntil = earningsDate.getTime() - now
        if (msUntil >= 0 && msUntil <= threeDaysMs) {
          upcoming.push(`• <b>${item.ticker || '?'}</b> — ${t('CATALYST_EARNINGS', lang)}: ${item.nextEarnings.slice(0, 10)}`)
        }
      }

      if (upcoming.length > 0) {
        const msg = `📅 <b>${t('UPCOMING_CATALYSTS', lang)}</b>\n${upcoming.join('\n')}`
        await sendGenericMessage(local(msg), undefined, user.telegramChatId)
      }
    }
  } catch (e) {
    logger.error({ error: e }, '[CATALYST_CHECK] Failed')
  }
}
