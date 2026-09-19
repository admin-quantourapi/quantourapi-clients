import { Database } from 'bun:sqlite'
import {
  beforeEach, describe, expect, test, 
} from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import * as clientSchema from '../db/clientSchema'

import {
  getDashboardScope, getDashboardSettings, scopeConditions, 
} from './dashboardIdentity'

// Dedicated in-memory DB for this suite — the shared test DB is wiped by
// other test files mid-run, which made global "most recent" assertions flaky.
const sqlite = new Database(':memory:')
sqlite.exec(`
  CREATE TABLE settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quantour_api_key TEXT,
    telegram_bot_token TEXT,
    telegram_chat_id TEXT,
    user_name TEXT,
    total_capital TEXT NOT NULL DEFAULT '30000',
    max_risk_per_trade TEXT NOT NULL DEFAULT '300',
    is_budget_aware INTEGER NOT NULL DEFAULT 0,
    portfolio_strategy TEXT NOT NULL DEFAULT 'standard',
    signal_mode TEXT NOT NULL DEFAULT 'all',
    language TEXT NOT NULL DEFAULT 'en',
    status TEXT NOT NULL DEFAULT 'pending',
    is_heartbeat_enabled INTEGER NOT NULL DEFAULT 1,
    risk_profile TEXT NOT NULL DEFAULT 'BALANCED',
    main_strategy_ast TEXT,
    available_cash TEXT,
    user_id TEXT,
    user_email TEXT,
    key_read_only INTEGER,
    updated_at INTEGER
  );
`)
const db = drizzle(sqlite, { schema: clientSchema })

beforeEach(async () => {
  await db.delete(clientSchema.settings)
})

async function seed(rows: Array<Partial<typeof clientSchema.settings.$inferInsert>>) {
  await db.insert(clientSchema.settings).values(rows as never[])
}

describe('dashboardIdentity', () => {
  test('getDashboardSettings picks the chat-less instance row over newer chat rows', async () => {
    await seed([
      // Chat rows updated AFTER the instance row — must NOT win.
      {
        telegramChatId: 'chat_a', quantourApiKey: 'KEY_ALPHA', userId: 'chat_a_uid', updatedAt: new Date(Date.now() + 2000), 
      },
      {
        telegramChatId: 'chat_b', quantourApiKey: 'KEY_ALPHA', userId: 'chat_b_uid', updatedAt: new Date(Date.now() + 1000), 
      },
      {
        telegramChatId: null, quantourApiKey: 'KEY_ALPHA', userId: 'instance_uid', updatedAt: new Date(Date.now() - 1000), 
      },
    ])

    const row = await getDashboardSettings(db)
    expect(row?.telegramChatId).toBeNull()
    expect(row?.userId).toBe('instance_uid')
  })

  test('getDashboardSettings falls back to most-recent row when no chat-less row exists', async () => {
    await seed([
      {
        telegramChatId: 'fb_1', quantourApiKey: 'KEY_ALPHA', userId: 'fb1', updatedAt: new Date(Date.now() + 1000), 
      },
      {
        telegramChatId: 'fb_2', quantourApiKey: 'KEY_ALPHA', userId: 'fb2', updatedAt: new Date(Date.now() + 5000), 
      },
    ])

    const row = await getDashboardSettings(db)
    expect(row?.telegramChatId).toBe('fb_2')
  })

  test('getDashboardScope: instance row + sibling chats sharing the key + dashboard_user', async () => {
    await seed([
      // Instance row (chat-less) + two chats sharing its key + one foreign-key chat.
      {
        telegramChatId: null, quantourApiKey: 'KEY_ALPHA', userId: 'instance_uid', updatedAt: new Date(), 
      },
      {
        telegramChatId: 'chat_a', quantourApiKey: 'KEY_ALPHA', userId: 'chat_a_uid', updatedAt: new Date(), 
      },
      {
        telegramChatId: 'chat_b', quantourApiKey: 'KEY_ALPHA', userId: 'chat_b_uid', updatedAt: new Date(), 
      },
      {
        telegramChatId: 'other_key_chat', quantourApiKey: 'KEY_BETA', userId: 'other_uid', updatedAt: new Date(), 
      },
    ])

    const scope = await getDashboardScope(db)
    // userId falls back to the stored instance userId when /v1/ping is
    // unreachable in tests (resolveUserIdFromKey returns null).
    expect(scope.userId).toBe('instance_uid')
    // Same-key account: instance's own dashboard_user marker + both sibling chats.
    expect(scope.chatIds).toEqual(expect.arrayContaining([
      'dashboard_user',
      'chat_a',
      'chat_b',
    ]))
    // Foreign key's chat must NOT leak into the instance scope.
    expect(scope.chatIds).not.toContain('other_key_chat')
  })

  test('getDashboardScope: no rows → empty scope (never all-users fallback)', async () => {
    const scope = await getDashboardScope(db)
    expect(scope.userId).toBeNull()
    expect(scope.chatIds).toEqual([])
    expect(scopeConditions(scope, { userId: 'userId', chatId: 'chatId' })).toEqual([])
  })

  test('scopeConditions builds userId + chatId-IN conditions', () => {
    const conds = scopeConditions({
      userId: 'uid1',
      chatIds: [
        'chat1',
        'chat2',
      ], 
    }, { userId: 'userId', chatId: 'chatId' })
    expect(conds.length).toBe(2)
  })
})
