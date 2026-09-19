import {
  and, desc, eq, gt, 
} from 'drizzle-orm'

import { db } from '~/db'
import { accountEvents } from '~/db/clientSchema'

import { logger } from './logger'

/**
 * Discriminator values stored in `account_events.event_type`. Keeping them
 * in one const object (with a derived union type) gives callers
 * autocomplete + makes the exhaustive set grep-able. New values can be
 * added here without a schema change (the column is free-form TEXT).
 */
export const AccountEventType = {
  NOTICE_NO_KEY: 'notice:no_key',
  NOTICE_EXPIRED: 'notice:expired',
  KEY_QUARANTINED: 'key_quarantined',
  KEY_RESTORED: 'key_restored',
} as const
export type AccountEventType = (typeof AccountEventType)[keyof typeof AccountEventType]

/** Reason namespace for notice throttling — maps to the `notice:*` event types. */
export type NoticeReason = 'no_key' | 'expired'

/**
 * Notice throttle window. A chat that is unlinked or whose key expired
 * receives at most one "please /link" / "key expired" notice per 24h,
 * regardless of how many scan cycles fire in that window. Shared by the
 * scanner and the daily sweep so both honor the same cadence.
 */
export const NOTICE_THROTTLE_MS = 24 * 60 * 60 * 1000

const LOUD_TYPES: ReadonlySet<AccountEventType> = new Set([
  AccountEventType.KEY_QUARANTINED,
  AccountEventType.KEY_RESTORED,
])

/**
 * Store only the last 6 chars of an API key so the audit trail never
 * contains a recoverable secret. (The full key already lives in the
 * settings row for the rare case it's genuinely needed.)
 */
function hashKey(key?: string): string | null {
  if (!key) return null
  return key.length > 6 ? key.slice(-6) : key
}

/**
 * Append an account event row. Significant events (quarantine / restore)
 * also emit a `logger.warn` so live `docker logs` / file-tail surfaces the
 * change immediately, while the SQLite row persists it for historical
 * "why did my chat stop getting signals?" diagnosis. Insertion failures
 * are swallowed + warned — the scanner must never abort a cycle because
 * the audit log was unwritable.
 */
export async function recordEvent(chatId: string,
  eventType: AccountEventType,
  opts: { detail?: string; key?: string } = {}): Promise<void> {
  try {
    await db.insert(accountEvents).values({
      chatId,
      eventType,
      detail: opts.detail ?? null,
      keyHash: hashKey(opts.key),
      createdAt: new Date(),
    })
    if (LOUD_TYPES.has(eventType)) {
      logger.warn({
        chatId, eventType, detail: opts.detail, keyHash: hashKey(opts.key), 
      }, `[ACCOUNT] ${eventType}`)
    }
  } catch (err) {
    logger.warn({ error: err, chatId, eventType }, '[ACCOUNT] Failed to record account event')
  }
}

/**
 * Throttle check backed by the persistent `account_events` table. Returns
 * true if a `notice:<reason>` row exists for this chat within `windowMs`,
 * meaning the caller should suppress the repeat notice. On query failure
 * we return false (allow the notice) so a transient DB issue cannot
 * permanently silence an unlinked chat.
 */
export async function lastNoticeWithin(chatId: string, reason: NoticeReason, windowMs: number): Promise<boolean> {
  try {
    const eventType: AccountEventType = reason === 'no_key'
      ? AccountEventType.NOTICE_NO_KEY
      : AccountEventType.NOTICE_EXPIRED
    const cutoff = new Date(Date.now() - windowMs)
    const rows = await db.select({ id: accountEvents.id })
      .from(accountEvents)
      .where(and(eq(accountEvents.chatId, chatId),
        eq(accountEvents.eventType, eventType),
        gt(accountEvents.createdAt, cutoff)))
      .limit(1)
    return rows.length > 0
  } catch (err) {
    logger.warn({ error: err, chatId, reason }, '[ACCOUNT] Throttle check failed; allowing notice')
    return false
  }
}

/**
 * Recent event history for a chat — intended for a future diagnostic bot
 * command (e.g. `/account-history`) answering "why did my signals stop?".
 * Not wired to any handler yet; the query exists so the audit trail is
 * queryable on demand.
 */
export async function recentEvents(chatId: string, limit = 20): Promise<
  Array<{ eventType: string; detail: string | null; keyHash: string | null; createdAt: Date | null }>
> {
  try {
    return await db.select({
      eventType: accountEvents.eventType,
      detail: accountEvents.detail,
      keyHash: accountEvents.keyHash,
      createdAt: accountEvents.createdAt,
    })
      .from(accountEvents)
      .where(eq(accountEvents.chatId, chatId))
      .orderBy(desc(accountEvents.createdAt))
      .limit(limit)
  } catch (err) {
    logger.warn({ error: err, chatId }, '[ACCOUNT] recentEvents query failed')
    return []
  }
}
