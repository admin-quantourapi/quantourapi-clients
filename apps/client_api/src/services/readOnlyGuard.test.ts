import { Database } from 'bun:sqlite'
import {
  beforeEach, describe, expect, test,
} from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import * as clientSchema from '../db/clientSchema'

import {
  instanceKeyIsReadOnly, readOnlySettingsViolations,
} from './readOnlyGuard'
import { isClientReadOnlyWrite } from './readOnlyRoutes'

// Dedicated in-memory DB (dashboardIdentity.test.ts convention — never the
// shared test DB).
const sqlite = new Database(':memory:')
sqlite.exec(`
  CREATE TABLE settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quantour_api_key TEXT,
    telegram_bot_token TEXT,
    telegram_chat_id TEXT,
    user_name TEXT,
    is_budget_aware INTEGER NOT NULL DEFAULT 0,
    portfolio_strategy TEXT NOT NULL DEFAULT 'standard',
    signal_mode TEXT NOT NULL DEFAULT 'all',
    language TEXT NOT NULL DEFAULT 'en',
    status TEXT NOT NULL DEFAULT 'pending',
    is_heartbeat_enabled INTEGER NOT NULL DEFAULT 1,
    risk_profile TEXT NOT NULL DEFAULT 'BALANCED',
    main_strategy_ast TEXT,
    user_id TEXT,
    user_email TEXT,
    key_read_only INTEGER,
    updated_at INTEGER
  );
`)
const db = drizzle(sqlite, { schema: clientSchema })
const { settings } = clientSchema

beforeEach(async () => {
  sqlite.exec('DELETE FROM settings')
})

describe('isClientReadOnlyWrite', () => {
  test('blocks local portfolio/config writes', () => {
    expect(isClientReadOnlyWrite('POST', '/api/trades/buy')).toBe(true)
    expect(isClientReadOnlyWrite('POST', '/api/trades/sell')).toBe(true)
    expect(isClientReadOnlyWrite('POST', '/api/portfolio/budget')).toBe(true)
    expect(isClientReadOnlyWrite('POST', '/api/portfolio/apply')).toBe(true)
    expect(isClientReadOnlyWrite('POST', '/api/portfolios')).toBe(true)
    expect(isClientReadOnlyWrite('DELETE', '/api/portfolios/3')).toBe(true)
    expect(isClientReadOnlyWrite('POST', '/api/portfolios/3/items')).toBe(true)
    expect(isClientReadOnlyWrite('POST', '/api/signals')).toBe(true)
    expect(isClientReadOnlyWrite('DELETE', '/api/signals/5')).toBe(true)
    expect(isClientReadOnlyWrite('PUT', '/api/strategies/2')).toBe(true)
    expect(isClientReadOnlyWrite('POST', '/api/strategies/sync')).toBe(true)
  })

  test('keeps reads, stateless simulate, settings, and Telegram ingestion open', () => {
    expect(isClientReadOnlyWrite('GET', '/api/trades')).toBe(false)
    expect(isClientReadOnlyWrite('POST', '/api/strategies/simulate')).toBe(false)
    expect(isClientReadOnlyWrite('POST', '/api/settings')).toBe(false)
    expect(isClientReadOnlyWrite('POST', '/v1/bot/update')).toBe(false)
  })
})

describe('instanceKeyIsReadOnly', () => {
  test('true only when the chat-less instance row carries key_read_only=1', async () => {
    // Legacy instance row without the flag → full access.
    await db.insert(settings).values({ telegramChatId: null, language: 'en' })
    expect(await instanceKeyIsReadOnly(db)).toBe(false)

    // Explicit false → full access.
    await db.insert(settings).values({ telegramChatId: null, keyReadOnly: false })
    expect(await instanceKeyIsReadOnly(db)).toBe(false)

    // Read-only instance row (highest id wins — the dashboard identity).
    await db.insert(settings).values({ telegramChatId: null, keyReadOnly: true })
    expect(await instanceKeyIsReadOnly(db)).toBe(true)

    // Telegram chat rows never influence the instance flag.
    await db.insert(settings).values({ telegramChatId: '999', keyReadOnly: true })
    expect(await instanceKeyIsReadOnly(db)).toBe(true)

    sqlite.exec('DELETE FROM settings')
    await db.insert(settings).values({ telegramChatId: '999', keyReadOnly: true })
    expect(await instanceKeyIsReadOnly(db)).toBe(false)
  })

  test('empty table degrades to full access', async () => {
    expect(await instanceKeyIsReadOnly(db)).toBe(false)
  })
})

describe('readOnlySettingsViolations', () => {
  test('allows key linking + cosmetic prefs, blocks strategy/signal/telegram control', () => {
    expect(readOnlySettingsViolations(['quantourApiKey'])).toEqual([])
    expect(readOnlySettingsViolations(['quantourApiKey', 'language', 'userName'])).toEqual([])
    expect(readOnlySettingsViolations(['mainStrategyAst'])).toEqual(['mainStrategyAst'])
    expect(readOnlySettingsViolations(['signalMode', 'telegramBotToken', 'language']))
      .toEqual(['signalMode', 'telegramBotToken'])
  })
})
