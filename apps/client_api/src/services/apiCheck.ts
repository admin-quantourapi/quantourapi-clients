import { local } from '@quantour/shared-algo/src/core/i18n'
import { eq } from 'drizzle-orm'

import { db } from '../db'
import { settings } from '../db/clientSchema'

import {
  getChatLanguage,sendGenericMessage, 
} from './telegramService'

export function withQuantourKey<T extends unknown[], R>(chatIdIndex: number,
  handler: (...args: T) => Promise<R>): (...args: T) => Promise<R | undefined> {
  return async (...args: T) => {
    const chatId = String(args[chatIdIndex])
    const [
      allSettings,
    ] = await db.select().from(settings).where(eq(settings.telegramChatId, chatId)).limit(1)
    if (!allSettings?.quantourApiKey) {
      const lang = await getChatLanguage(chatId)
      await sendGenericMessage(local(lang === 'ua' ? '⚠️ Помилка авторизації. Будь ласка, прив\'яжіть свій API ключ використовуючи /link <API_KEY>.' : '⚠️ Unauthorized. Please link your Quantour API key by sending /link <API_KEY>.\nYou can generate one in your web dashboard.'), undefined, chatId)
      return undefined
    }
    return handler(...args)
  }
}
