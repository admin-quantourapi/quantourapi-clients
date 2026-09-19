import { Database } from 'bun:sqlite'
import {
  beforeEach, describe, expect, test, 
} from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import * as clientSchema from '../db/clientSchema'

import {
  defaultBudget, getUserBudget, setUserBudget, 
} from './budgetService'

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
sqlite.exec(`
  CREATE TABLE user_budgets (
    user_id TEXT PRIMARY KEY,
    total_capital TEXT,
    max_risk_per_trade TEXT,
    updated_at INTEGER
  );
`)
const db = drizzle(sqlite, { schema: clientSchema })

beforeEach(async () => {
  await db.delete(clientSchema.settings)
  await db.delete(clientSchema.userBudgets)
})

describe('budgetService', () => {
  test('getUserBudget returns a safe default for missing/placeholder userId', async () => {
    const blank = await getUserBudget(db, undefined)
    expect(blank.totalCapital).toBe('30000')
    expect(blank.maxRiskPerTrade).toBe('300')
    expect(blank.maxRiskPerTradeUsd).toBe(300)

    const placeholder = await getUserBudget(db, 'dashboard_user')
    expect(placeholder.totalCapital).toBe('30000')
    expect(placeholder.userId).toBe('dashboard_user')
  })

  test('getUserBudget returns the existing user_budgets row with percent resolved to $', async () => {
    await db.insert(clientSchema.userBudgets).values({
      userId: 'uid_1',
      totalCapital: '49545.18',
      maxRiskPerTrade: '3%',
    })

    const budget = await getUserBudget(db, 'uid_1')
    expect(budget.totalCapital).toBe('49545.18')
    expect(budget.maxRiskPerTrade).toBe('3%')
    // 3% of 49545.18 ≈ 1486.36
    expect(Math.round(budget.maxRiskPerTradeUsd)).toBe(1486)
  })

  test('getUserBudget lazy-creates a row with DEFAULTS when no budget row exists (settings budget columns are gone)', async () => {
    await db.insert(clientSchema.settings).values([
      {
        telegramChatId: null, userId: 'uid_2',
      },
      {
        telegramChatId: 'chat_a', userId: 'uid_2',
      },
    ])

    const budget = await getUserBudget(db, 'uid_2')
    expect(budget.totalCapital).toBe('30000')
    expect(budget.maxRiskPerTrade).toBe('300')

    // Row was persisted — a second read hits the table, not lazy-create.
    const rows = await db.select().from(clientSchema.userBudgets)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.totalCapital).toBe('30000')
  })

  test('getUserBudget creates a defaults row even when the userId has no settings rows', async () => {
    const budget = await getUserBudget(db, 'uid_orphan')
    expect(budget.totalCapital).toBe('30000')
    expect(budget.maxRiskPerTradeUsd).toBe(300)
    // Lazy-create always seeds the defaults row for a real userId.
    const rows = await db.select().from(clientSchema.userBudgets)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.userId).toBe('uid_orphan')
  })

  test('setUserBudget inserts then updates (upsert)', async () => {
    await setUserBudget(db, 'uid_3', { totalCapital: '50000', maxRiskPerTrade: '400' })
    let rows = await db.select().from(clientSchema.userBudgets)
    expect(rows[0]?.totalCapital).toBe('50000')

    await setUserBudget(db, 'uid_3', { maxRiskPerTrade: '2%' })
    rows = await db.select().from(clientSchema.userBudgets)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.maxRiskPerTrade).toBe('2%')
    expect(rows[0]?.totalCapital).toBe('50000') // unchanged
  })

  test('setUserBudget is a no-op for placeholder userId', async () => {
    await setUserBudget(db, 'dashboard_user', { totalCapital: '99999' })
    expect(await db.select().from(clientSchema.userBudgets)).toHaveLength(0)
    expect(defaultBudget('dashboard_user').totalCapital).toBe('30000')
  })
})
