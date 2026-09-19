import {
  Language, local, t, translateStrategyName,
} from '@quantour/shared-algo/src/core/i18n'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

import { db as localDb } from '~/db'
import { settings } from '~/db/clientSchema'
import {
  ApiClientError, fetchFromApi, 
} from '~/services/apiClient'
import { logger } from '~/services/logger'
import { sendGenericMessage } from '~/services/telegramService'

const PingResponseSchema = z.object({
  status: z.string().optional(),
  plan: z.string().optional(),
  credits: z.coerce.number().optional(),
  unlimited: z.boolean().optional(),
  userId: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
}).passthrough()

const ForwardTestItemSchema = z.object({
  accountTitle: z.string().optional(),
  strategy: z.string().optional(),
  isActive: z.boolean().optional(),
}).passthrough()

const ForwardTestsSchema = z.array(ForwardTestItemSchema)

export function maskApiKey(key: string): string {
  if (key.length > 12) {
    return `${key.substring(0, 8)}...${key.substring(key.length - 4)}`
  }
  return key
}

/**
 * /me — account status for the linked API key: plan, remaining credits,
 * the masked API key, active forward tests, and the active strategy.
 * Relies on `withQuantourKey` for the "no key linked" gate.
 */
export async function handleMe(chatId: string, lang: Language = 'en'): Promise<void> {
  try {
    const [
      userSettings,
    ] = await localDb.select().from(settings).where(eq(settings.telegramChatId, chatId)).limit(1)
    const apiKey = userSettings?.quantourApiKey
    if (!apiKey) {
      await sendGenericMessage(t('ME_NO_KEY', lang), undefined, chatId)
      return
    }

    let plan = 'Unknown'
    let creditsText = '0'
    let activeForwardTests = 0
    let forwardTestsKnown = false

    try {
      const ping = await fetchFromApi(
        '/ping', PingResponseSchema, {}, chatId,
      )
      plan = ping.plan || 'Unknown'
      creditsText = ping.unlimited ? t('ME_CREDITS_UNLIMITED', lang) : String(ping.credits ?? 0)
    } catch (err) {
      if (err instanceof ApiClientError && (err.status === 401 || err.status === 402)) {
        await sendGenericMessage(t('ME_NO_KEY', lang), undefined, chatId)
        return
      }
      logger.warn({ error: err, chatId }, '[ME] /v1/ping failed')
    }

    try {
      const tests = await fetchFromApi(
        '/forward-test', ForwardTestsSchema, {}, chatId,
      )
      if (Array.isArray(tests)) {
        activeForwardTests = tests.filter(t => t.isActive === true).length
        forwardTestsKnown = true
      }
    } catch (err) {
      logger.warn({ error: err, chatId }, '[ME] /v1/forward-test failed')
    }

    const lines: string[] = []
    lines.push(`👤 <b>${t('ME_HEADER', lang)}</b>`)
    lines.push('')
    lines.push(`• ${t('ME_PLAN', lang)}: <b>${plan.toUpperCase()}</b>`)
    lines.push(`• ${t('ME_CREDITS', lang)}: <b>${creditsText}</b>`)
    lines.push(`• ${t('ME_API_KEY', lang)}: <code>${maskApiKey(apiKey)}</code>`)
    if (forwardTestsKnown) {
      lines.push(`• ${t('ME_FORWARD_TESTS', lang)}: <b>${activeForwardTests}</b>`)
    } else {
      lines.push(`• ${t('ME_FORWARD_TESTS', lang)}: ${t('ME_FORWARD_TESTS_NONE', lang)}`)
    }
    if (userSettings?.mainStrategyAst) {
      try {
        const parsed = JSON.parse(userSettings.mainStrategyAst) as { strategyName?: string }
        if (parsed.strategyName) {
          lines.push(`• ${t('ME_STRATEGY', lang)}: <b>${translateStrategyName(parsed.strategyName, lang)}</b>`)
        }
      } catch {
        // Non-JSON AST — skip strategy line.
      }
    }

    await sendGenericMessage(local(lines.join('\n')), undefined, chatId)
  } catch (err) {
    logger.error({ error: err, chatId }, '[ME] handleMe failed')
    await sendGenericMessage(t('ME_FETCH_ERROR', lang), undefined, chatId)
  }
}
