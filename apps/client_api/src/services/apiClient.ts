import { eq } from 'drizzle-orm'
import { z } from 'zod'

import { config } from '~/config'
import { db as localDb } from '~/db'
import { settings } from '~/db/clientSchema'
import { logger } from '~/services/logger'

/**
 * Raised when the cloud API returns a non-2xx status. Zod parse failures surface
 * as the standard ZodError instead — both are caught by handler try/catch and
 * degrade gracefully. Replaces the three copy-pasted untyped `fetchFromApi`
 * helpers in scan/info/portfolioHandlers.
 */
export class ApiClientError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'ApiClientError'
  }
}

/** Resolve the API key for a chat, falling back to the bot token (legacy parity). */
async function resolveApiKey(chatId?: string): Promise<string | null> {
  if (chatId) {
    const rows = await localDb.select().from(settings).where(eq(settings.telegramChatId, String(chatId))).limit(1)
    if (rows[0]?.quantourApiKey) return rows[0].quantourApiKey
  }
  const allSettings = await localDb.select().from(settings).limit(10)
  const withKey = allSettings.find(s => !!s.quantourApiKey)
  return withKey?.quantourApiKey || null
}

/**
 * Fetch a JSON endpoint from the cloud API and validate the body against a Zod
 * schema, returning the typed payload.
 *
 * - Throws {@link ApiClientError} on a non-2xx response (auth failure, 5xx, etc.).
 * - Throws `ZodError` when the body does not match the schema, surfacing upstream
 *   contract drift loudly instead of silently returning malformed data.
 *
 * Callers should wrap the call in try/catch and degrade gracefully (e.g. show an
 * "unavailable" message). Passing a Zod schema is mandatory — there is no untyped
 * overload, by design.
 */
export async function fetchFromApi<T>(
  endpoint: string,
  schema: z.ZodType<T>,
  options: RequestInit = {},
  chatId?: string,
): Promise<T> {
  const apiKey = await resolveApiKey(chatId)
  if (!apiKey) {
    throw new ApiClientError(401, `No API key configured for chat ${chatId ?? '(none)'}`)
  }

  let res: Response
  try {
    res = await fetch(`${config.PUBLIC_API_URL}/v1${endpoint}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'x-api-key': apiKey,
        'Connection': 'close',
        ...options.headers,
      },
    })
  } catch (e) {
    logger.error({ error: e, endpoint }, '[apiClient] network failure')
    throw new ApiClientError(0, `Network failure calling ${endpoint}`)
  }

  if (!res.ok) {
    throw new ApiClientError(res.status, `API ${res.status} ${res.statusText} at ${endpoint}`)
  }

  return schema.parse(await res.json())
}
