import { Database } from 'bun:sqlite'
import { like, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import { config } from '../config'

import * as schema from './clientSchema'
const dbPath = config.SQLITE_DB_PATH
const sqlite = new Database(dbPath, { create: true })
sqlite.exec('PRAGMA journal_mode = WAL;')
sqlite.exec('PRAGMA busy_timeout = 5000;')

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS settings (
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
    key_read_only INTEGER,
    updated_at INTEGER
  );
`)

// Legacy column rename: installs created before the quantour rebrand stored
// the API key under the old name. Rename in place (preserves the linked key —
// never drop and re-add a data-bearing column). No-op on fresh DBs.
try {
  const settingsColumns = sqlite.query(`PRAGMA table_info(settings)`).all() as Array<{ name: string }>
  const hasLegacy = settingsColumns.some(c => c.name === 'contour_api_key')
  const hasCurrent = settingsColumns.some(c => c.name === 'quantour_api_key')
  if (hasLegacy && !hasCurrent) {
    sqlite.exec(`ALTER TABLE settings RENAME COLUMN contour_api_key TO quantour_api_key`)
  }
} catch (err) {
  console.error('[DB] legacy settings column rename failed:', err)
}

// Auto-migrate missing columns for existing local DBs
const missingSettingsColumns = [
  'telegram_chat_id TEXT',
  'user_name TEXT',
  'is_budget_aware INTEGER NOT NULL DEFAULT 0',
  'portfolio_strategy TEXT NOT NULL DEFAULT \'standard\'',
  'signal_mode TEXT NOT NULL DEFAULT \'all\'',
  'language TEXT NOT NULL DEFAULT \'en\'',
  'status TEXT NOT NULL DEFAULT \'pending\'',
  'is_heartbeat_enabled INTEGER NOT NULL DEFAULT 1',
  'risk_profile TEXT NOT NULL DEFAULT \'BALANCED\'',
  'main_strategy_ast TEXT',
  'user_id TEXT',
  'user_email TEXT',
  'key_read_only INTEGER',
]

for (const col of missingSettingsColumns) {
  try {
    sqlite.exec(`ALTER TABLE settings ADD COLUMN ${col}`)
  } catch {
    // Ignore if column already exists
  }
}

// Phase 3 branch anatomy: 3 new columns on trades. Existing self-hosters' DBs
// don't have these; ALTER each one idempotently. Mirrors the missingSettingsColumns
// pattern. Required for live STRATEGY_HANDOFF exits (see exitManager.ts).
const missingTradesColumns = [
  'fired_branch_name TEXT',
  'entry_regime TEXT',
  'entry_sector TEXT',
]
for (const col of missingTradesColumns) {
  try {
    sqlite.exec(`ALTER TABLE trades ADD COLUMN ${col}`)
  } catch {
    // Ignore if column already exists
  }
}

const userTablesWithUserId = [
  'portfolio_stats',
  'trades',
  'pnl_history',
  'trade_audit_log',
]
for (const table of userTablesWithUserId) {
  try {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN user_id TEXT`)
  } catch {
    // Ignore if column already exists
  }
}

sqlite.exec(`

  CREATE TABLE IF NOT EXISTS portfolios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS portfolio_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id INTEGER REFERENCES portfolios(id) ON DELETE CASCADE,
    ticker TEXT NOT NULL,
    added_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS custom_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    conditions TEXT NOT NULL,
    action TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS custom_strategies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    ast_json TEXT NOT NULL,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS portfolio_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    user_id TEXT NOT NULL DEFAULT 'dashboard_user',
    initial_capital TEXT NOT NULL DEFAULT '50000',
    current_capital TEXT NOT NULL DEFAULT '50000',
    daily_starting_capital TEXT,
    weekly_starting_capital TEXT,
    monthly_starting_capital TEXT,
    is_margin_called INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    user_id TEXT NOT NULL DEFAULT 'dashboard_user',
    ticker TEXT NOT NULL,
    entry_price TEXT NOT NULL,
    stop_loss TEXT NOT NULL,
    target TEXT NOT NULL,
    risk_per_share TEXT NOT NULL,
    risk_amount_usd TEXT NOT NULL,
    capital_deployed TEXT NOT NULL,
    entry_date INTEGER,
    stage INTEGER NOT NULL DEFAULT 0,
    days_held INTEGER NOT NULL DEFAULT 0,
    in_resistance_zone INTEGER NOT NULL DEFAULT 0,
    highest_high TEXT,
    atr TEXT,
    strategy_name TEXT,
    partial_target TEXT,
    is_partial_taken INTEGER NOT NULL DEFAULT 0,
    thesis TEXT,
    confirmation_signals TEXT,
    reversal_signals TEXT,
    risk TEXT,
    ttl INTEGER,
    fired_branch_name TEXT,
    entry_regime TEXT,
    entry_sector TEXT
  );

  CREATE TABLE IF NOT EXISTS pnl_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    user_id TEXT NOT NULL DEFAULT 'dashboard_user',
    type TEXT NOT NULL,
    pnl_amount TEXT NOT NULL,
    pnl_percent TEXT NOT NULL,
    timestamp INTEGER
  );

  CREATE TABLE IF NOT EXISTS trade_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    user_id TEXT NOT NULL DEFAULT 'dashboard_user',
    ticker TEXT NOT NULL,
    strategy_name TEXT NOT NULL,
    entry_date INTEGER,
    exit_date INTEGER,
    entry_price TEXT NOT NULL,
    exit_price TEXT NOT NULL,
    pnl_usd TEXT NOT NULL,
    pnl_percent TEXT NOT NULL,
    exit_reason TEXT NOT NULL,
    thesis TEXT,
    days_held INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS custom_scenarios (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    curve TEXT NOT NULL,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS command_metrics (
    command TEXT PRIMARY KEY,
    avg_duration_ms INTEGER NOT NULL DEFAULT 0,
    sample_count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS daily_metrics_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    date TEXT NOT NULL,
    price TEXT NOT NULL,
    volume TEXT,
    market_cap TEXT,
    pe_ratio TEXT,
    ps_ratio TEXT,
    score TEXT,
    sentiment_score TEXT,
    macro_score TEXT,
    raw_metrics_json TEXT,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS notification_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT,
    user_id TEXT NOT NULL DEFAULT 'dashboard_user',
    summary TEXT NOT NULL,
    full_text TEXT NOT NULL,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS account_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    detail TEXT,
    key_hash TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS client_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    chat_id TEXT,
    meta TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_budgets (
    user_id TEXT PRIMARY KEY,
    total_capital TEXT,
    max_risk_per_trade TEXT,
    updated_at INTEGER
  );
`)

// Drizzle instance over the (now schema-current) database. Constructed before
// the boot-maintenance statements below and exported for the whole app.
export const db = drizzle(sqlite, { schema })

// ---------------------------------------------------------------------------
// Boot-time data maintenance — Drizzle-mediated (raw exec is reserved for
// pragma/DDL/introspection above; data access anywhere in client_api is
// Drizzle-only — tests/clientApiRawSql.test.ts enforces this).
// ---------------------------------------------------------------------------

// Purge any legacy non-US exchange tickers containing dots (e.g., 7731.T, BHARATFORG.NS, AIR.PA)
db.delete(schema.trades).where(like(schema.trades.ticker, '%.%')).run()
db.delete(schema.dailyMetricsHistory).where(like(schema.dailyMetricsHistory.ticker, '%.%')).run()

// Purge duplicate trade entries for the same chat and ticker
// (correlated subquery — no builder equivalent; still Drizzle-mediated via db.run)
db.run(sql`DELETE FROM trades WHERE id NOT IN (SELECT MIN(id) FROM trades GROUP BY chat_id, ticker)`)
