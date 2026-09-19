import { desc, isNull } from 'drizzle-orm'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'

import { settings } from '../db/clientSchema'
import type * as schema from '../db/clientSchema'

/**
 * Read-only key guard (2026-09-10, agent/advisor view-layer keys).
 *
 * TRUE when the chat-less INSTANCE settings row (the dashboard identity) has
 * a linked key that resolved read-only at link time. NULL (legacy rows) and
 * missing rows degrade to FALSE — full access; enforcement on the central
 * verifiers never depends on this state.
 *
 * db is a parameter (dashboardIdentity convention): production callers pass
 * the singleton, tests their own in-memory DB.
 */
export async function instanceKeyIsReadOnly(db: BunSQLiteDatabase<typeof schema>): Promise<boolean> {
  const rows = await db.select({ keyReadOnly: settings.keyReadOnly })
    .from(settings)
    .where(isNull(settings.telegramChatId))
    .orderBy(desc(settings.id))
    .limit(1)
  return rows[0]?.keyReadOnly === true
}

/**
 * Settings fields a read-only instance may still change: the key itself
 * (linking — including upgrading back to a full key) plus cosmetic prefs.
 * Everything else (strategy AST, signal mode, telegram wiring) is portfolio
 * control a view-layer key must not touch.
 */
const READ_ONLY_ALLOWED_SETTINGS_FIELDS = new Set(['quantourApiKey', 'language', 'userName', 'userId', 'keyReadOnly'])

/** Fields in a settings POST body a read-only instance is NOT allowed to change. */
export function readOnlySettingsViolations(bodyKeys: string[]): string[] {
  return bodyKeys.filter(k => !READ_ONLY_ALLOWED_SETTINGS_FIELDS.has(k))
}
