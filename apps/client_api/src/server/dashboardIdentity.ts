import {
  desc, eq, inArray, isNull, 
} from 'drizzle-orm'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'

import type * as schema from '../db/clientSchema'
import { settings } from '../db/clientSchema'
import { resolveUserIdFromKey } from '../services/userResolver'

export type SettingsRow = typeof settings.$inferSelect

/**
 * The dashboard panel's account identity = the INSTANCE settings row
 * (`telegram_chat_id IS NULL`), the row the self-host settings UI creates.
 *
 * WHY: the previous "most recently updated row" heuristic breaks on
 * multi-account instances — with 2+ telegram chats, the panel silently showed
 * whichever chat touched settings last (worst case: a different API key's
 * portfolio). The chat-less row is a stable anchor: it holds the instance's
 * quantourApiKey, and per the product model (key → userId → one portfolio)
 * all devices/chats sharing that key belong to the same account.
 *
 * Fallback: the most recently updated row for legacy single-row instances
 * (set up purely via Telegram, no dashboard row yet).
 */
export async function getDashboardSettings(db: BunSQLiteDatabase<typeof schema>): Promise<SettingsRow | null> {
  const instanceRow = await db.select().from(settings)
    .where(isNull(settings.telegramChatId))
    .orderBy(desc(settings.id))
    .limit(1)
  if (instanceRow.length > 0) return instanceRow[0]!
  const fallback = await db.select().from(settings)
    .orderBy(desc(settings.updatedAt), desc(settings.id))
    .limit(1)
  return fallback[0] || null
}

export interface DashboardScope {
  userId: string | null
  chatIds: string[]
}

/**
 * Resolve ONE account scope from an API key — the single source of truth for
 * "all devices/chats sharing a key see one portfolio" (key → userId via
 * /v1/ping → one set of trade rows).
 *
 * - userId: the account's stored userId, live-re-resolved from the key via
 *   /v1/ping when the key is present.
 * - chatIds: every settings row sharing this key (sibling telegram chats) +
 *   'dashboard_user' when one of them is the chat-less instance row (the
 *   dashboard's own manual trades are tagged with that fallback).
 */
export async function getAccountScopeByKey(db: BunSQLiteDatabase<typeof schema>,
  quantourApiKey: string | null | undefined): Promise<DashboardScope> {
  if (!quantourApiKey) return { userId: null, chatIds: [] }

  const rows = await db.select().from(settings)
    .where(eq(settings.quantourApiKey, quantourApiKey))

  let userId: string | null = null
  const chatIds = new Set<string>()
  let hasInstanceRow = false
  for (const row of rows) {
    if (row.userId && !userId) userId = row.userId
    if (row.telegramChatId) chatIds.add(row.telegramChatId)
    else hasInstanceRow = true
  }
  if (hasInstanceRow) chatIds.add('dashboard_user')

  const uid = await resolveUserIdFromKey(quantourApiKey)
  if (uid) userId = uid

  return {
    userId,
    chatIds: [
      ...chatIds,
    ],
  }
}

/**
 * Resolve the portfolio scope for the dashboard panel: the INSTANCE row's
 * (chat-less) API key determines the account. See getAccountScopeByKey.
 */
export async function getDashboardScope(db: BunSQLiteDatabase<typeof schema>): Promise<DashboardScope> {
  const row = await getDashboardSettings(db)
  if (!row) return { userId: null, chatIds: [] }
  return getAccountScopeByKey(db, row.quantourApiKey)
}

/** Build a `WHERE user_id = ? OR chat_id IN (...)` condition set for a scope. */
export function scopeConditions(scope: DashboardScope,
  table: { userId?: unknown; chatId?: unknown }) {
  const conds = []
  if (scope.userId) conds.push(eq(table.userId as never, scope.userId))
  if (scope.chatIds.length > 0) conds.push(inArray(table.chatId as never, scope.chatIds))
  return conds
}
