import { cors } from '@elysiajs/cors'
import { CustomStrategyAST } from '@quantour/shared-algo/src/finance-algo/ast'
import {
  and, desc, eq, gte, isNull, or, sql,
} from 'drizzle-orm'
import {
  Elysia,
} from 'elysia'
import fs from 'fs/promises'
import path from 'path'
import { z } from 'zod'

import { config as envConfig } from './config'
import { startCronJobs } from './cronJobs'
import { db } from './db'
import {
  clientLogs, customScenarios, customSignals, customStrategies, pnlHistory, portfolioItems, portfolios, portfolioStats, settings, tradeAuditLog, trades,
} from './db/clientSchema'
import { seedScenarios } from './db/seedScenarios'
import {
  getUserBudget, setUserBudget, 
} from './server/budgetService'
import {
  getDashboardScope, getDashboardSettings, scopeConditions,
} from './server/dashboardIdentity'
import { validateAndStampStrategyAst } from './server/strategyAstValidation'
import {
  getTimeframeWindow, parseTimeframe, 
} from './server/timeframes'
import { logger } from './services/logger'
import { loadLocalUniverse, resolveTickersFallback } from './services/localUniverse'
import type { TelegramUpdate } from './services/telegramService'
import {
  initBotWebSocket, reconnectBotWebSocket, stopBotWebSocket,
} from './services/telegramWsClient'
import { resolveKeyIdentity } from './services/userResolver'
import { instanceKeyIsReadOnly, readOnlySettingsViolations } from './services/readOnlyGuard'
import { isClientReadOnlyWrite } from './services/readOnlyRoutes'

envConfig.init()
startCronJobs()
seedScenarios()

async function autoMigrateUserIds() {
  try {
    await db.update(settings).set({ userId: sql`COALESCE(userId, telegramChatId, 'dashboard_user')` }).where(isNull(settings.userId))
    await db.update(trades).set({ userId: sql`COALESCE(userId, chatId, 'dashboard_user')` }).where(isNull(trades.userId))
    await db.update(portfolioStats).set({ userId: sql`COALESCE(userId, chatId, 'dashboard_user')` }).where(isNull(portfolioStats.userId))
    await db.update(tradeAuditLog).set({ userId: sql`COALESCE(userId, chatId, 'dashboard_user')` }).where(isNull(tradeAuditLog.userId))
    await db.update(pnlHistory).set({ userId: sql`COALESCE(userId, chatId, 'dashboard_user')` }).where(isNull(pnlHistory.userId))
  } catch {
    // Ignore migration error
  }
}
autoMigrateUserIds().catch(console.error)
// Data-loss guard: a wiped client_api DB used to be silently re-created. If
// the local DB has portfolio data but the settings table is empty, the
// settings rows (chat↔API-key links) were wiped — log a CRITICAL and notify
// the operator chat instead of quietly starting fresh.
void (async () => {
  try {
    const [
      settingsCount,
    ] = await db.select({ value: sql`count(*)` }).from(settings)
    const [
      tradesCount,
    ] = await db.select({ value: sql`count(*)` }).from(trades)
    const settingsRows = Number(settingsCount?.value ?? 0)
    const tradesRows = Number(tradesCount?.value ?? 0)
    if (settingsRows === 0 && tradesRows > 0) {
      const msg = '⚠️ DATA LOSS ALERT: client_api SQLite has portfolio data but ZERO settings rows — the chat↔API-key links were wiped. Re-link with /link <API_KEY> or restore the DB backup.'
      console.error(`[DATA LOSS ALERT] ${msg}`)
      const operatorChatId = process.env.TELEGRAM_CHAT_ID
      if (operatorChatId) {
        const { sendGenericMessage } = await import('./services/telegramService')
        await sendGenericMessage(msg, undefined, operatorChatId).catch(() => {})
      }
    }
  } catch (err) {
    console.warn('[DATA LOSS ALERT] Check skipped:', err)
  }
})()
// Seed the latest built-in strategy AST to any user whose stored
// mainStrategyAst predates it. Idempotent — runs every boot. Dynamic +
// tolerant: the published open-source tree ships WITHOUT this seeding
// module (it lazily imports private strategy data), so a static import
// would crash the public distribution at boot. Here the module
// always exists (canonical seeding); there the load rejects and we degrade to
// the dashboard builder's embedded library templates instead.
import('./migrateStrategyAst')
  .then(({ migrateStrategyAst }) => migrateStrategyAst())
  .catch((err) => console.warn('[MIGRATION] Strategy auto-seeding unavailable in this distribution — use the dashboard strategy builder templates.', err instanceof Error ? err.message : err))

/**
 * The DASHBOARD's settings row = the INSTANCE row (telegram_chat_id IS NULL),
 * created by the self-host settings UI. NEVER "most recently updated row" —
 * on multi-account instances that silently shows whichever chat touched
 * settings last. Telegram/bot flows keep their per-chat rows via chatId.
 */
async function getActiveSettings() {
  return getDashboardSettings(db)
}

/**
 * Resolve the portfolio scope for the dashboard panel: the instance row's
 * userId (live-resolved from its API key via /v1/ping) plus every chatId
 * sharing the instance's key (same account) — see dashboardIdentity.ts.
 */
async function getPortfolioScope() {
  return getDashboardScope(db)
}

initBotWebSocket()

const simulateCache = new Map<string, { signals: unknown[] }>()

/**
 * Failure path for `/proxy/v1/market/tickers` (central down/mislinked):
 * serve the agent-installed local universe if one exists, else fail closed.
 * NEVER fabricate rows — a hardcoded house list with invented sectors was
 * removed on purpose (data-honesty mandate + the list is not public content).
 * The file contract lives in QUANTOUR_AGENT.md STEP 4b / agent-skill docs.
 */
function tickersFailureResponse(upstreamStatus?: number): Response {
  const universe = loadLocalUniverse(envConfig.SQLITE_DB_PATH)
  const fallback = resolveTickersFallback({ upstreamOk: false, localUniverse: universe })
  if (fallback.source === 'local') {
    logger.warn({ count: fallback.tickers.length }, '[UNIVERSE] central /market/tickers unavailable — serving local.universe.json fallback')
    return new Response(JSON.stringify({
      success: true,
      data: fallback.tickers,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const detail = upstreamStatus !== undefined
    ? `central responded HTTP ${upstreamStatus}`
    : 'central unreachable'
  return new Response(JSON.stringify({
    success: false,
    error: `Market universe unavailable: ${detail}; no local.universe.json configured (QUANTOUR_AGENT.md STEP 4b)`,
  }), {
    status: 502,
    headers: { 'content-type': 'application/json' },
  })
}

const proxySubApp = new Elysia({ prefix: '/proxy' })
  .all('*', async ({ request }) => {
    const url = new URL(request.url)
    const rawPath = url.pathname.replace('/proxy', '')
    const cleanPath = rawPath.startsWith('/v1') ? rawPath.substring(3) : rawPath

    const activeSetting = await getActiveSettings()
    const apiKey = activeSetting?.quantourApiKey
    if (!apiKey) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing Quantour API key. Link a key via Instance Settings or Telegram /link.',
      }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    }

    const publicApiUrl = envConfig.PUBLIC_API_URL
    const upstreamUrl = `${publicApiUrl}/v1${cleanPath}${url.search}`

    const upstreamHeaders = new Headers(request.headers)
    upstreamHeaders.set('x-api-key', apiKey)
    upstreamHeaders.set('Connection', 'close')
    upstreamHeaders.delete('host')

    try {
      const response = await fetch(upstreamUrl, {
        method: request.method,
        headers: upstreamHeaders,
        body: [
          'GET',
          'HEAD',
        ].includes(request.method) ? undefined : await request.arrayBuffer(),
      })

      if (!response.ok && cleanPath === '/market/tickers') {
        return tickersFailureResponse(response.status)
      }

      const responseBody = await response.arrayBuffer()
      const responseHeaders = new Headers(response.headers)
      responseHeaders.delete('content-encoding')
      responseHeaders.delete('content-length')
      responseHeaders.delete('transfer-encoding')
      responseHeaders.delete('connection')
      responseHeaders.delete('keep-alive')

      return new Response(responseBody, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      })
    } catch (error: unknown) {
      if (cleanPath === '/market/tickers') {
        return tickersFailureResponse()
      }
      const message = error instanceof Error ? error.message : String(error)
      return new Response(JSON.stringify({ error: 'Upstream connection failed', details: message }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  })

const app = new Elysia({
  serve: {
    maxRequestBodySize: 25 * 1024 * 1024, // 25MB
  },
})
  .use(cors())
  .use(proxySubApp)
  // Read-only key scope (agent/advisor view-layer keys): one deterministic
  // enforcement point for LOCAL portfolio/config writes. /api/settings is
  // NOT here — its handler field-gates so key linking (including upgrading
  // back to a full key) keeps working while read-only.
  .onBeforeHandle(async ({ request, set }) => {
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return
    const path = new URL(request.url).pathname
    if (!isClientReadOnlyWrite(request.method, path)) return
    if (await instanceKeyIsReadOnly(db)) {
      set.status = 403
      return {
        success: false,
        error: 'Read-only API key: this instance cannot modify portfolios, budgets, or strategies. Link a full-access key to operate.',
      }
    }
  })
  .get('/', () => 'Client API is running locally!')
  .post('/v1/bot/update', async ({ body }) => {
    const { processUpdate } = await import('./services/telegramService')
    const handlers = await import('./server/botHandlers')
    await processUpdate(body as TelegramUpdate, handlers)
    return { ok: true }
  })
  // -- Settings API --
  .get('/api/settings', async () => {
    const active = await getActiveSettings()
    return active || {}
  })
  .post('/api/settings', async ({ body, set }) => {
    const bodyObj: Record<string, unknown> = { ...(body as Record<string, unknown>) }

    // Read-only key scope: while the instance key is read-only (or the key
    // being linked IS read-only), only identity/linking + cosmetic fields may
    // change. Strategy/signal/telegram mutations are portfolio control — a
    // view-layer agent must not touch them. Re-linking a FULL key upgrades
    // the instance back (keyReadOnly resets to false).
    const incomingReadOnly = bodyObj.quantourApiKey !== undefined
      ? (await resolveKeyIdentity(bodyObj.quantourApiKey as string)).readOnly
      : undefined
    const effectiveReadOnly = incomingReadOnly ?? (await instanceKeyIsReadOnly(db))
    if (effectiveReadOnly) {
      const offending = readOnlySettingsViolations(Object.keys(bodyObj))
      if (offending.length > 0) {
        set.status = 403
        return {
          success: false,
          error: `Read-only API key: settings mutations blocked (${offending.join(', ')}). Link a full-access key to operate.`,
        }
      }
    }

    // When an API key is set, resolve the central userId so all chats/devices
    // sharing the key see the same portfolio (key -> userId -> one portfolio).
    if (bodyObj.quantourApiKey) {
      const identity = await resolveKeyIdentity(bodyObj.quantourApiKey as string)
      if (identity.userId) bodyObj.userId = identity.userId
      bodyObj.keyReadOnly = identity.readOnly
    }
    // Validate + ownership-stamp custom strategy ASTs. Structured 400 issues
    // give AI agents (and humans) an actionable feedback loop against the
    // published AST schema; the USER_CUSTOM_AST_TAG guarantees the boot-time
    // migrateStrategyAst() NEVER overwrites a saved custom strategy.
    if (bodyObj.mainStrategyAst !== undefined) {
      const astValidation = validateAndStampStrategyAst(bodyObj.mainStrategyAst)
      if (!astValidation.ok) {
        set.status = 400
        return { success: false, error: astValidation.error, issues: astValidation.issues }
      }
      bodyObj.mainStrategyAst = astValidation.json
    }
    // Upsert ONLY the instance row (telegram_chat_id IS NULL). The previous
    // blanket `db.update(settings).set(...)` (no WHERE) overwrote EVERY account
    // on multi-user instances. If no chat-less row exists yet, CREATE one —
    // the dashboard identity anchor — instead of mutating a telegram row.
    const instanceRow = await db.select().from(settings)
      .where(isNull(settings.telegramChatId))
      .limit(1)
    if (instanceRow.length > 0) {
      await db.update(settings)
        .set({ ...bodyObj, updatedAt: new Date() })
        .where(eq(settings.id, instanceRow[0]!.id))
    } else {
      await db.insert(settings).values({ ...bodyObj, updatedAt: new Date() })
    }
    reconnectBotWebSocket().catch(console.error)
    return { success: true }
  })

  // -- Portfolios API --
  .get('/api/portfolios', async () => {
    return await db.select().from(portfolios)
  })
  .post('/api/portfolios', async ({ body }) => {
    const { name } = body as { name: string }
    const res = await db.insert(portfolios).values({ name, createdAt: new Date() }).returning()
    return res[0]
  })
  .delete('/api/portfolios/:id', async ({ params }) => {
    await db.delete(portfolios).where(eq(portfolios.id, parseInt(params.id)))
    return { success: true }
  })

  // -- Trades & Portfolio API --
  .get('/api/trades', async () => {
    const scope = await getPortfolioScope()
    const conditions = scopeConditions(scope, trades)
    // Never fall back to "all users' trades" — an identity-less scope must
    // return an empty portfolio, not leak every account on the instance.
    if (conditions.length === 0) return []
    return await db.select().from(trades).where(or(...conditions))
  })
  .get('/api/positions/news-alignment', async () => {
    // News-divergence badges for held positions (dashboard). Joins the
    // dashboard scope's open trades against the central /metrics newsAlignment
    // (company vs sector). Degrades to an empty map on any failure — the UI
    // renders no badge rather than a fabricated one.
    const scope = await getPortfolioScope()
    const conditions = scopeConditions(scope, trades)
    const openTrades = conditions.length > 0
      ? await db.select().from(trades).where(or(...conditions))
      : []
    const tickers = [
      ...new Set(openTrades.map(t => String(t.ticker).toUpperCase())),
    ]
    if (tickers.length === 0) return { items: [] }

    const activeSetting = await getActiveSettings()
    const apiKey = activeSetting?.quantourApiKey
    if (!apiKey) return { items: [] }

    try {
      const { config } = await import('./config')
      const apiUrl = config.API_URL || 'http://localhost:3001'
      const response = await fetch(`${apiUrl}/api/v1/metrics`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ tickers }),
        signal: AbortSignal.timeout(30000),
      })
      if (!response.ok) return { items: [] }
      const resJson = await response.json() as unknown
      const arr = Array.isArray(resJson) ? resJson : ((resJson as { data?: unknown[] })?.data ?? [])
      // Structural-thesis join (2026-08-21): per open trade, parse the entry
      // snapshot and compute the live verdict from the same metrics payload.
      const { parseStructuralThesis, structuralThesisVerdict } = await import('@quantour/shared-algo/src/finance-algo/structuralThesis')
      const tradeByTicker = new Map(openTrades.map(tr => [
        String(tr.ticker).toUpperCase(),
        tr,
      ]))
      const items = arr.flatMap((raw): Array<{
        ticker: string
        newsScore: number | null
        sectorNewsScore: number | null
        newsDivergence: number | null
        newsAlignment: string | null
        structural: boolean
        thesisVerdict: string | null
        thesisDaysHeld: number | null
        thesisHorizonDays: number | null
      }> => {
        if (!raw || typeof raw !== 'object') return []
        const o = raw as Record<string, unknown>
        const ticker = typeof o.ticker === 'string' ? o.ticker.toUpperCase() : null
        if (!ticker || !tickers.includes(ticker)) return []
        const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null
        const trade = tradeByTicker.get(ticker)
        const thesis = parseStructuralThesis(trade?.thesis ?? null)
        const verdict = thesis
          ? structuralThesisVerdict(thesis, {
            fcfInflection: typeof o.fcfInflection === 'string' ? o.fcfInflection : undefined,
            sectorNewsScore: num(o.sectorNewsScore) ?? undefined,
            newsScore: num(o.newsScore) ?? undefined,
            newsAlignment: typeof o.newsAlignment === 'string' ? o.newsAlignment : undefined,
          })
          : null
        return [
          {
            ticker,
            newsScore: num(o.newsScore),
            sectorNewsScore: num(o.sectorNewsScore),
            newsDivergence: num(o.newsDivergence),
            newsAlignment: typeof o.newsAlignment === 'string' ? o.newsAlignment : null,
            structural: thesis !== null,
            thesisVerdict: verdict,
            thesisDaysHeld: thesis ? (trade?.daysHeld ?? 0) : null,
            thesisHorizonDays: thesis ? thesis.horizonDays : null,
          },
        ]
      })
      return { items }
    } catch {
      return { items: [] }
    }
  })
  .get('/api/trades/history', async (ctx) => {
    const query = (ctx.query || {}) as Record<string, string>
    const page = Math.max(1, parseInt(query.page || '1', 10) || 1)
    const rawPageSize = parseInt(query.pageSize || '20', 10) || 20
    const pageSize = [
      10,
      20,
      50,
      100,
    ].includes(rawPageSize) ? rawPageSize : 20
    const timeframe = parseTimeframe(query.timeframe)
    const windowStart = getTimeframeWindow(timeframe)

    const scope = await getPortfolioScope()
    const cond = (table: { userId?: unknown; chatId?: unknown }) => {
      const conds = scopeConditions(scope, table)
      return conds.length > 0 ? or(...conds) : undefined
    }

    const auditCond = cond(tradeAuditLog)
    const pnlCond = cond(pnlHistory)
    const statsCond = cond(portfolioStats)

    // Paginated audit logs (table)
    const auditLogs = auditCond
      ? await db.select().from(tradeAuditLog).where(auditCond).orderBy(desc(tradeAuditLog.exitDate)).limit(pageSize).offset((page - 1) * pageSize)
      : []
    const countRow = auditCond
      ? await db.select({ n: sql<number>`count(*)` }).from(tradeAuditLog).where(auditCond)
      : [
        { n: 0 },
      ]
    const totalAuditLogs = countRow[0]?.n || 0

    // Timeframe-filtered PnL series (chart) — full series within the window
    const pnlSeriesWhere = auditCond && windowStart
      ? and(auditCond, gte(tradeAuditLog.exitDate, windowStart))
      : auditCond
    const pnlSeries = pnlSeriesWhere
      ? await db.select({
        ticker: tradeAuditLog.ticker, pnlUsd: tradeAuditLog.pnlUsd, exitDate: tradeAuditLog.exitDate,
      }).from(tradeAuditLog).where(pnlSeriesWhere).orderBy(tradeAuditLog.exitDate).limit(2000)
      : []

    const pnl = pnlCond
      ? await db.select().from(pnlHistory).where(pnlCond).orderBy(desc(pnlHistory.timestamp)).limit(100)
      : []
    const statsList = statsCond
      ? await db.select().from(portfolioStats).where(statsCond).limit(1)
      : []

    return {
      auditLogs,
      pnlSeries,
      pnlHistory: pnl,
      stats: statsList[0] || null,
      totalAuditLogs,
      page,
      pageSize,
    }
  })
  .post('/api/trades/buy', async ({ body }) => {
    const {
      ticker, shares, entry, stopLoss, target, 
    } = body as {
      ticker: string
      shares?: number
      entry?: number
      stopLoss?: number
      target?: number
    }
    if (!ticker) return { success: false, error: 'Ticker is required' }

    const active = await getActiveSettings()
    const chatId = active?.telegramChatId || 'dashboard_user'

    const { handleManualAdd } = await import('./server/botHandlers/portfolioHandlers')
    const override = (entry || stopLoss || target)
      ? { entry, stopLoss, target }
      : undefined
    // No hardcoded lang: handleManualAdd resolves the chat's language via
    // getChatLanguage so buy confirmations arrive in the user's locale
    // (dashboard-originated buys still route to the linked Telegram chat).
    const ok = await handleManualAdd(
      ticker.toUpperCase(), shares && shares > 0 ? shares : 1, chatId, undefined, override,
    )
    return { success: ok }
  })
  .post('/api/trades/sell', async ({ body }) => {
    const { ticker } = body as { ticker: string }
    if (!ticker) return { success: false, error: 'Ticker is required' }

    const active = await getActiveSettings()
    const chatId = active?.telegramChatId || 'dashboard_user'

    const { handleSell } = await import('./server/botHandlers/portfolioHandlers')
    // Same as buy: let handleSell resolve the chat's language.
    await handleSell(ticker.toUpperCase(), chatId, undefined)
    return { success: true }
  })
  .get('/api/portfolio/budget', async () => {
    // Canonical per-user budget read for the dashboard. Resolves the account
    // (key → userId → one portfolio) and returns the user_budgets row with
    // max_risk_per_trade resolved to an effective $ amount (percent → $) plus
    // LIVE deployed/available computed from market value (budget = deployed +
    // free cash identity). deployedUsd/availableCash are never
    // stored; they are recomputed on every read.
    const scope = await getPortfolioScope()
    const budget = await getUserBudget(db, scope.userId)

    const tradeConds = scopeConditions(scope, trades)
    const accountTrades = tradeConds.length > 0
      ? await db.select().from(trades).where(or(...tradeConds))
      : []
    const { computeDeployedMarketValue } = await import('./server/botHandlers/portfolioHandlers')
    const deployedUsd = await computeDeployedMarketValue(accountTrades)
    const totalCapital = parseFloat(budget.totalCapital) || 0
    return {
      ...budget,
      deployedUsd,
      availableCash: Math.max(0, totalCapital - deployedUsd),
    }
  })
  .post('/api/portfolio/budget', async ({ body }) => {
    const { totalCapital, maxRiskPerTrade } = body as { totalCapital: number; maxRiskPerTrade?: number }
    if (!totalCapital || totalCapital <= 0) return { success: false, error: 'Valid total capital is required' }

    // Budget is per-USER (key → userId → one account). user_budgets is the
    // single source of truth; the settings-row budget columns are no longer
    // written. portfolioStats.currentCapital (running capital for /status) is
    // still synced per-chatId so Telegram /status keeps reflecting the budget.
    const scope = await getPortfolioScope()
    if (!scope.userId) return { success: false, error: 'No account configured' }

    const fields: { totalCapital?: string; maxRiskPerTrade?: string } = {
      totalCapital: totalCapital.toString(),
    }
    if (maxRiskPerTrade && maxRiskPerTrade > 0) {
      fields.maxRiskPerTrade = maxRiskPerTrade.toString()
    }
    await setUserBudget(db, scope.userId, fields)

    // Sync portfolioStats for each chatId in scope so telegram /status matches.
    for (const cid of scope.chatIds) {
      if (!cid) continue
      const existing = await db.select().from(portfolioStats).where(eq(portfolioStats.chatId, cid)).limit(1)
      if (existing.length > 0) {
        await db.update(portfolioStats).set({ currentCapital: totalCapital.toString(), updatedAt: new Date() }).where(eq(portfolioStats.chatId, cid))
      } else {
        await db.insert(portfolioStats).values({
          chatId: cid,
          initialCapital: totalCapital.toString(),
          currentCapital: totalCapital.toString(),
          dailyStartingCapital: totalCapital.toString(),
          weeklyStartingCapital: totalCapital.toString(),
          monthlyStartingCapital: totalCapital.toString(),
        }).catch(() => {})
      }
    }

    return { success: true }
  })

  // -- Portfolio Optimize (Dashboard parity with Telegram /optimize) --
  // Runs recommendPortfolioRotations across the dashboard scope (instance
  // row → key → userId → one portfolio) and caches the structured result
  // for the subsequent /apply call. Returns the structured RotationResult
  // (targetPortfolio + actions + rationale) so the dashboard can render it
  // natively — not the Telegram-formatted HTML string.
  .get('/api/portfolio/optimize', async () => {
    const scope = await getPortfolioScope()
    if (!scope.userId && scope.chatIds.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'NO_ACCOUNT',
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    try {
      const { computePortfolioRotations } = await import('./server/botHandlers/portfolioHandlers')
      const result = await computePortfolioRotations(scope)
      if (!result) {
        return { success: false, error: 'CONFIG_MISSING_SCOREGAINMULTIPLIER' }
      }
      return { success: true, ...result }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error({ error: message }, '[CLIENT_API] /api/portfolio/optimize failed')
      return new Response(JSON.stringify({
        success: false,
        error: 'OPTIMIZE_FAILED',
        details: message,
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  })
  .post('/api/portfolio/apply', async () => {
    const scope = await getPortfolioScope()
    if (!scope.userId && scope.chatIds.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'NO_ACCOUNT',
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    try {
      const { applyOptimizationActions } = await import('./server/botHandlers/portfolioHandlers')
      const result = await applyOptimizationActions(scope)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error({ error: message }, '[CLIENT_API] /api/portfolio/apply failed')
      return new Response(JSON.stringify({
        success: false,
        applied: 0,
        error: 'APPLY_FAILED',
        details: message,
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  })

  // -- Portfolio Items --
  .get('/api/portfolios/:id/items', async ({ params }) => {
    return await db.select()
      .from(portfolioItems)
      .where(eq(portfolioItems.portfolioId, parseInt(params.id)))
  })
  .post('/api/portfolios/:id/items', async ({ params, body }) => {
    const { ticker } = body as { ticker: string }
    const res = await db.insert(portfolioItems)
      .values({ portfolioId: parseInt(params.id), ticker, addedAt: new Date() })
      .returning()
    return res[0]
  })
  .delete('/api/portfolios/:id/items/:itemId', async ({ params }) => {
    await db.delete(portfolioItems).where(eq(portfolioItems.id, parseInt(params.itemId)))
    return { success: true }
  })

  // -- Custom Signals API --
  .get('/api/signals', async () => {
    return await db.select().from(customSignals)
  })
  .post('/api/signals', async ({ body }) => {
    // Validate the POST body with Zod before persisting.
    // "Parse every cloud/external JSON response with Zod — never blind `as`
    // casts". The dashboard sends this; treat it as untrusted input.
    const CreateSignalSchema = z.object({
      name: z.string().min(1),
      conditions: z.string().min(1),
      action: z.string().min(1),
      isActive: z.boolean().optional().default(true),
    })
    const parsed = CreateSignalSchema.safeParse(body)
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: 'Invalid signal payload', details: parsed.error.flatten() }),
        { status: 400, headers: { 'Content-Type': 'application/json' } })
    }
    const res = await db.insert(customSignals)
      .values({
        name: parsed.data.name,
        conditions: parsed.data.conditions,
        action: parsed.data.action,
        isActive: parsed.data.isActive,
        createdAt: new Date(),
      })
      .returning()
    return res[0]
  })
  .delete('/api/signals/:id', async ({ params }) => {
    await db.delete(customSignals).where(eq(customSignals.id, parseInt(params.id)))
    return { success: true }
  })

  // -- Custom Strategies API --
  .get('/api/strategies', async () => {
    return await db.select().from(customStrategies)
  })
  .get('/api/client-logs', async ({ query }) => {
    // Persistent client_api log query — consumed by the admin user-health page.
    const level = typeof query.level === 'string' ? query.level : undefined
    const chatId = typeof query.chatId === 'string' ? query.chatId : undefined
    const limit = Math.min(parseInt(String(query.limit ?? '100'), 10) || 100, 500)
    const conds = []
    if (level) conds.push(eq(clientLogs.level, level))
    if (chatId) conds.push(eq(clientLogs.chatId, chatId))
    return await db.select().from(clientLogs)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(clientLogs.id))
      .limit(limit)
  })
  .post('/api/strategies', async ({ body }) => {
    const { name, astJson } = body as { name: string; astJson: string }
    const res = await db.insert(customStrategies)
      .values({ name, astJson, createdAt: new Date() })
      .returning()
    return res[0]
  })
  .delete('/api/strategies/:id', async ({ params }) => {
    await db.delete(customStrategies).where(eq(customStrategies.id, parseInt(params.id)))
    return { success: true }
  })
  .put('/api/strategies/:id', async ({ params, body }) => {
    const { name, astJson } = body as { name?: string; astJson?: string }
    const updateData: { name?: string; astJson?: string } = {}
    if (name) updateData.name = name
    if (astJson) updateData.astJson = astJson
    
    if (Object.keys(updateData).length > 0) {
      await db.update(customStrategies)
        .set(updateData)
        .where(eq(customStrategies.id, parseInt(params.id)))
    }
    return { success: true }
  })
  .post('/api/strategies/sync', async ({ body }) => {
    const strategiesToSync = body as { id: number; name: string; astJson: string }[]
    for (const st of strategiesToSync) {
      // Upsert strategy using the explicit ID
      const existing = await db.select().from(customStrategies).where(eq(customStrategies.id, st.id)).limit(1)
      if (existing.length === 0) {
        await db.insert(customStrategies).values({
          id: st.id,
          name: st.name,
          astJson: st.astJson,
          createdAt: new Date(),
        })
      }
    }
    return { success: true }
  })
  .post('/api/strategies/simulate', async ({ body }) => {
    const { ast: rawAst, marketDataArray } = body as { ast: unknown; marketDataArray: Record<string, unknown>[] }
    // The UI keeps the AST in a 1-element array wrapper; evaluateSetup expects the single strategy object.
    const ast = Array.isArray(rawAst) ? rawAst[0] : rawAst

    const mdHash = marketDataArray.length > 0
      ? `${marketDataArray.length}-${marketDataArray[0].symbol}-${marketDataArray[marketDataArray.length - 1].symbol}-${marketDataArray[0].date}-${marketDataArray[marketDataArray.length - 1].date}`
      : 'empty'
    const cacheKey = Bun.hash(JSON.stringify(ast) + mdHash).toString()

    if (simulateCache.has(cacheKey)) {
      return simulateCache.get(cacheKey)
    }

    // We dynamically import evaluateSetup so that the logic lives purely in the shared-algo
    const { evaluateSetup } = await import('@quantour/shared-algo/src/finance-algo/screener')

    const signals = []

    for (const dataPoint of marketDataArray) {
      try {
        // Evaluate the AST against this specific point in time
        const setups = evaluateSetup(dataPoint as never, { custom: ast as CustomStrategyAST })

        for (const setup of setups) {
          // Collect strictly valid AST signals to display on chart and execute in backtest
          if (setup.isValid) {
            signals.push({
              date: (dataPoint.date || dataPoint.timestamp || new Date().toISOString()) as string,
              price: (dataPoint.currentPrice || dataPoint.price) as number,
              symbol: dataPoint.symbol as string,
              day: dataPoint.day as string,
              score: setup.score ?? 5.0,
              // Omit the full setup object to save bandwidth and prevent ECONNRESET
            })
          }
        }
      } catch {
        // Skip a malformed data point instead of failing the whole batch (no 500)
      }
    }

    const result = { signals }
    simulateCache.set(cacheKey, result)
    return result
  })

  // -- Custom Scenarios API --
  .get('/api/scenarios', async () => {
    try {
      const data = await db.select().from(customScenarios)
      // Parse the curve array from string before returning
      const parsed = data.map(sc => ({
        ...sc,
        curve: JSON.parse(sc.curve),
      }))
      return { success: true, scenarios: parsed }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // -- Portfolio Evaluate API --
  .get('/api/portfolios/:id/evaluate', async ({ params: { id } }) => {
    const portfolioId = parseInt(id)
    const items = await db.select().from(portfolioItems).where(eq(portfolioItems.portfolioId, portfolioId))
    const tickers = items.map(i => i.ticker)
    if (tickers.length === 0) return { success: true, results: [] }

    const userSetting = await getActiveSettings()
    if (!userSetting || !userSetting.quantourApiKey) {
      return { success: false, error: 'No API key' }
    }

    let ast = null
    if (userSetting.mainStrategyAst && userSetting.mainStrategyAst.startsWith('{')) {
      try {
        ast = JSON.parse(userSetting.mainStrategyAst)
      } catch {
        ast = null
      }
    }

    if (!ast) {
      return { success: false, error: 'No strategy configured. Please configure your strategy AST in settings.' }
    }

    const response = await fetch('http://127.0.0.1:3001/api/v1/metrics', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userSetting.quantourApiKey}`,
      },
      body: JSON.stringify({ tickers }),
    })
    
    if (!response.ok) return { success: false, error: 'Failed to fetch metrics' }
    
    const metricsData = await response.json()
    const { evaluateSetup } = await import('@quantour/shared-algo/src/finance-algo/screener')
    
    const budget = await getUserBudget(db, userSetting.userId)
    const userMaxRiskUsd = budget.maxRiskPerTradeUsd

    const results = []
    for (const data of metricsData) {
      const marketData = {
        ...data,
        currentPrice: data.price,
        currentVolume: data.volume,
        // Real 52w high when the central API supplies it; never fabricate
        // price-as-high (0% drawdown by construction).
        ...(data.fiftyTwoWeekHigh !== undefined ? { fiftyTwoWeekHigh: data.fiftyTwoWeekHigh } : {}),
        maxRisk: userMaxRiskUsd,
      }
      
      let setups: unknown[] = []
      if (ast) {
        setups = evaluateSetup(marketData, { custom: ast as CustomStrategyAST })
      }
      results.push({ ticker: data.ticker, metrics: marketData, setups })
    }

    return { success: true, results }
  })

// Private CI-failure → Telegram notify bridge. Lives in src/internal/ciNotify.ts,
// which the public mirror excludes — registered via dynamic import so the public
// build never references it. Dormant unless CI_NOTIFY_ENABLED=1.
if (process.env.CI_NOTIFY_ENABLED === '1') {
  const { ciNotify } = await import('./internal/ciNotify')
  app.use(ciNotify)
}

// Private per-branch stats registration. Lives in src/internal/branchStatsPrivate.ts,
// which the public mirror excludes — registered via dynamic import so the public
// build never references it. Dormant unless PRIVATE_BRANCH_STATS=1.
if (process.env.PRIVATE_BRANCH_STATS === '1') {
  await import('./internal/branchStatsPrivate')
}

// Private cross-account performance surface for the admin panel (read-only,
// operator console only). Lives in src/internal/accountPerformance.ts, which
// the public mirror excludes — registered via dynamic import so the public
// build never references it. Dormant unless ADMIN_PERFORMANCE_ENABLED=1;
// requests must carry x-internal-secret = INTERNAL_API_SECRET (fail-closed).
if (process.env.ADMIN_PERFORMANCE_ENABLED === '1') {
  const { accountPerformance } = await import('./internal/accountPerformance')
  app.use(accountPerformance)
}

app.listen(envConfig.PORT)


console.log(`[CLIENT API] Proxy is running on ${app.server?.hostname}:${app.server?.port}`)

// Graceful shutdown: close the bot-gateway WebSocket cleanly so the gateway
// learns of the disconnect immediately instead of holding a half-open socket
// until its keepalive notices.
const shutdown = (signal: string) => {
  console.log(`[CLIENT API] ${signal} received, closing bot WebSocket...`)
  stopBotWebSocket()
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
