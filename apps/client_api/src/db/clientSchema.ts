import {
  integer,sqliteTable, text, 
} from 'drizzle-orm/sqlite-core'

export const settings = sqliteTable('settings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  quantourApiKey: text('quantour_api_key'),
  telegramBotToken: text('telegram_bot_token'),
  telegramChatId: text('telegram_chat_id'),
  userName: text('user_name'),
  isBudgetAware: integer('is_budget_aware', { mode: 'boolean' }).default(false).notNull(),
  portfolioStrategy: text('portfolio_strategy').default('ai_combined').notNull(),
  signalMode: text('signal_mode').default('all').notNull(),
  language: text('language').default('en').notNull(),
  status: text('status').default('pending').notNull(),
  riskProfile: text('risk_profile').default('CONSERVATIVE').notNull(),
  mainStrategyAst: text('main_strategy_ast'),
  isHeartbeatEnabled: integer('is_heartbeat_enabled', { mode: 'boolean' }).default(true).notNull(),
  userId: text('user_id'),
  userEmail: text('user_email'),
  /**
   * True when the linked quantourApiKey is a READ-ONLY key (resolved via
   * /v1/ping at link time). Gates every local portfolio write (buy/sell/
   * optimize-apply/budget/strategies/...) — the agent/advisor view-layer
   * contract. Null on legacy rows = treated as false (full access).
   */
  keyReadOnly: integer('key_read_only', { mode: 'boolean' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
})

// Canonical per-USER budget (key → userId → one account). The settings rows
// are per-chat config rows whose budget columns duplicated the account budget;
// user_budgets is the single source of truth, keyed by the central userId
// (resolved from the API key via /v1/ping). Money columns are TEXT per the
// client_api mandate (SQLite has no DECIMAL; REAL loses cent-level precision).
// max_risk_per_trade keeps the raw format ('3%' or '300'). available_cash was
// dropped in Cleanup B — free cash is computed live, never stored.
export const userBudgets = sqliteTable('user_budgets', {
  userId: text('user_id').primaryKey(),
  totalCapital: text('total_capital'),
  maxRiskPerTrade: text('max_risk_per_trade'),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
})

export const portfolios = sqliteTable('portfolios', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }),
})

export const portfolioItems = sqliteTable('portfolio_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  portfolioId: integer('portfolio_id').references(() => portfolios.id, { onDelete: 'cascade' }),
  ticker: text('ticker').notNull(),
  addedAt: integer('added_at', { mode: 'timestamp' }),
})

export const customSignals = sqliteTable('custom_signals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  // JSON array of conditions: e.g. [{"metric": "fcf_score", "operator": ">", "value": 8}]
  conditions: text('conditions').notNull(), 
  // e.g. "telegram"
  action: text('action').notNull(),
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }),
})

export const customStrategies = sqliteTable('custom_strategies', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  astJson: text('ast_json').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }),
})


export const portfolioStats = sqliteTable('portfolio_stats', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: text('chat_id'),
  userId: text('user_id').default('dashboard_user').notNull(),
  initialCapital: text('initial_capital').default('50000').notNull(),
  currentCapital: text('current_capital').default('50000').notNull(),
  dailyStartingCapital: text('daily_starting_capital'),
  weeklyStartingCapital: text('weekly_starting_capital'),
  monthlyStartingCapital: text('monthly_starting_capital'),
  isMarginCalled: integer('is_margin_called', { mode: 'boolean' }).default(false).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }),
})

export const trades = sqliteTable('trades', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: text('chat_id'),
  userId: text('user_id').default('dashboard_user').notNull(),
  ticker: text('ticker').notNull(),
  entry: text('entry_price').notNull(),
  stopLoss: text('stop_loss').notNull(),
  target: text('target').notNull(),
  riskPerShare: text('risk_per_share').notNull(),
  riskAmountUsd: text('risk_amount_usd').notNull(),
  capitalDeployed: text('capital_deployed').notNull(),
  entryDate: integer('entry_date', { mode: 'timestamp' }),
  stage: integer('stage').default(0).notNull(),
  daysHeld: integer('days_held').default(0).notNull(),
  inResistanceZone: integer('in_resistance_zone', { mode: 'boolean' }).default(false).notNull(),
  highestHigh: text('highest_high'),
  atr: text('atr'),
  strategyName: text('strategy_name'),
  partialTarget: text('partial_target'),
  isPartialTaken: integer('is_partial_taken', { mode: 'boolean' }).default(false).notNull(),
  thesis: text('thesis'),
  confirmationSignals: text('confirmation_signals'),
  reversalSignals: text('reversal_signals'),
  risk: text('risk'),
  ttl: integer('ttl'),
  // Phase 3 branch anatomy instrumentation (matches BacktestTrade + forward_test_positions).
  // Populated at trade-insert time so the live exit-manager can detect thesis
  // decay and fire STRATEGY_HANDOFF exits (see exitManager.ts).
  firedBranchName: text('fired_branch_name'),
  entryRegime: text('entry_regime'),
  entrySector: text('entry_sector'),
})

export const pnlHistory = sqliteTable('pnl_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: text('chat_id'),
  userId: text('user_id').default('dashboard_user').notNull(),
  type: text('type').notNull(),
  pnlAmount: text('pnl_amount').notNull(),
  pnlPercent: text('pnl_percent').notNull(),
  timestamp: integer('timestamp', { mode: 'timestamp' }),
})

export const tradeAuditLog = sqliteTable('trade_audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: text('chat_id'),
  userId: text('user_id').default('dashboard_user').notNull(),
  ticker: text('ticker').notNull(),
  strategyName: text('strategy_name').notNull(),
  entryDate: integer('entry_date', { mode: 'timestamp' }),
  exitDate: integer('exit_date', { mode: 'timestamp' }),
  entryPrice: text('entry_price').notNull(),
  exitPrice: text('exit_price').notNull(),
  pnlUsd: text('pnl_usd').notNull(),
  pnlPercent: text('pnl_percent').notNull(),
  exitReason: text('exit_reason').notNull(),
  thesis: text('thesis'),
  daysHeld: integer('days_held').default(0).notNull(),
})

export const customScenarios = sqliteTable('custom_scenarios', {
  id: text('id').primaryKey(), // using text id since market scenarios use string IDs
  name: text('name').notNull(),
  description: text('description').notNull(),
  curve: text('curve').notNull(), // JSON string array of numbers
  createdAt: integer('created_at', { mode: 'timestamp' }),
})

export const notificationBatches = sqliteTable('notification_batches', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: text('chat_id'),
  userId: text('user_id').default('dashboard_user').notNull(),
  summary: text('summary').notNull(),
  fullText: text('full_text').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }),
})

export const commandMetrics = sqliteTable('command_metrics', {
  command: text('command').primaryKey(),
  avgDurationMs: integer('avg_duration_ms').notNull().default(0),
  sampleCount: integer('sample_count').notNull().default(0),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
})

export const dailyMetricsHistory = sqliteTable('daily_metrics_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ticker: text('ticker').notNull(),
  date: text('date').notNull(), // 'YYYY-MM-DD'
  price: text('price').notNull(),
  volume: text('volume'),
  marketCap: text('market_cap'),
  peRatio: text('pe_ratio'),
  psRatio: text('ps_ratio'),
  score: text('score'), // Quantour opportunity score
  sentimentScore: text('sentiment_score'), // Macro / news sentiment score
  macroScore: text('macro_score'), // Macro regime / conviction score
  rawMetricsJson: text('raw_metrics_json'), // Full metrics payload for quantitative backtesting
  createdAt: integer('created_at', { mode: 'timestamp' }),
})

/**
 * Append-only audit trail + throttle source for per-chat account events.
 * Serves two purposes:
 *  1. Notice throttle (replaces the in-memory Map): before re-sending a
 *     "please /link" or "key expired" notice to a chat, check whether a
 *     row with `event_type='notice:<reason>'` exists within the window.
 *     Survives bot restarts (the Map reset on every restart, causing one
 *     repeat notice per cycle).
 *  2. Operator audit: every key quarantine / restore is recorded here so
 *     "why did my chat stop getting signals?" is answerable historically.
 *     `keyHash` stores only the last 6 chars of the affected API key.
 */
export const accountEvents = sqliteTable('account_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: text('chat_id').notNull(),
  eventType: text('event_type').notNull(),
  detail: text('detail'),
  keyHash: text('key_hash'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

/**
 * Structured, persistent client_api log store (warn/error). The console-only
 * logger lost everything on container restart — this table survives, and the
 * admin user-health page reads it via GET /api/client-logs.
 */
export const clientLogs = sqliteTable('client_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  level: text('level').notNull(),
  message: text('message').notNull(),
  chatId: text('chat_id'),
  meta: text('meta'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

