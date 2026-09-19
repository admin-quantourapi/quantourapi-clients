import {
  afterAll, beforeEach, describe, expect, mock, test,
} from 'bun:test'

import {
  applyOptimizationActions,
  computePortfolioRotations,
  getAvailableCash,
  handleApplyOptimization,
  handleBuy,
  handleFreeCash,
  handlePortfolioAdd,
  handlePortfolioStatus,
} from './portfolioHandlers'

// Mock dependencies
const mockSendGenericMessage = mock()
const mockSendPhotoMessage = mock()

// Order-proofing: capture the CURRENT module surface and spread it below —
// mock.module is process-global and never restored between bun test files,
// so a partial export set starves later importers in shuffled orders.
const realTelegramService = await import('~/services/telegramService')
mock.module('~/services/telegramService', () => ({
  ...realTelegramService,
  sendGenericMessage: mockSendGenericMessage,
  sendPhotoMessage: mockSendPhotoMessage,
  sendRawTelegram: mock(() => Promise.resolve({ ok: true })),
}))

import { randomUUID } from 'crypto'
import {
  and,
  eq,
} from 'drizzle-orm'

import { db } from '~/db'
import {
  customStrategies, portfolioStats, settings, trades, userBudgets,
} from '~/db/clientSchema'

// Mock global fetch for API calls inside portfolioHandlers
const originalFetch = globalThis.fetch
const mockFetch = mock((url: unknown) => {
  const urlStr = String(url)
  if (urlStr.includes('/market/historical') || urlStr.includes('/fmp/historical-price-full/')) {
    return Promise.resolve(new Response(JSON.stringify({ success: true, data: {} })))
  }
  if (urlStr.includes('/fmp/profile/') || urlStr.includes('/market/profile/')) {
    return Promise.resolve(new Response(JSON.stringify({ sector: 'Technology' })))
  }
  if (urlStr.includes('/market/quote/') || urlStr.includes('/fmp/quote/')) {
    return Promise.resolve(new Response(JSON.stringify({ price: 150.0 })))
  }
  if (urlStr.includes('/market/quotes') || urlStr.includes('/market/snapshot')) {
    return Promise.resolve(new Response(JSON.stringify([
      { symbol: 'AAPL', price: 165.0 },
      { symbol: 'TEST', price: 150.0 },
      { symbol: 'NVDA', price: 175.0 },
      { symbol: 'MSFT', price: 420.0 },
      { symbol: 'AVGO', price: 170.0 },
    ])))
  }
  if (urlStr.includes('/rotations/recommend')) {
    return Promise.resolve(new Response(JSON.stringify({ recommendations: '[]' })))
  }
  if (urlStr.includes('/v1/signals')) {
    // Real candidate setup (NVDA quote 175 comes from the /market/quotes mock).
    return Promise.resolve(new Response(JSON.stringify({
      signals: [
        {
          ticker: 'NVDA', entry: 175, stopLoss: 165, target: 210, strategyName: 'AI_COMBINED', 
        },
      ],
    })))
  }
  if (urlStr.includes('/ticker/')) {
    return Promise.resolve(new Response(JSON.stringify({
      success: true,
      data: { ticker: { sector: 'Technology' }, quote: { symbol: 'AAPL', price: 165.0 } },
    })))
  }
  return Promise.resolve(new Response(JSON.stringify(null), { status: 404 }))
})

describe('portfolioHandlers', () => {
  beforeEach(async () => {
    globalThis.fetch = mockFetch as unknown as typeof fetch
    mockSendGenericMessage.mockClear()
    mockSendPhotoMessage.mockClear()
    await db.delete(trades)
    await db.delete(portfolioStats)
    await db.delete(customStrategies)
    await db.delete(userBudgets)
    await db.delete(settings)
    const { clearQuoteCache } = await import('./portfolioHandlers')
    clearQuoteCache()
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
  })

  test('handlePortfolioStatus shows not initialized if no stats', async () => {
    const chatId = randomUUID()
    
    await handlePortfolioStatus(chatId, 'en')
    
    expect(mockSendGenericMessage).toHaveBeenCalled()
    expect(mockSendGenericMessage.mock.calls[0][0]).toContain('Portfolio not initialized')
  })

  test('handlePortfolioStatus shows portfolio info via sendGenericMessage (text, not photo)', async () => {
    const chatId = randomUUID()
    await db.insert(portfolioStats).values({ 
      chatId: chatId, 
      currentCapital: '30000', 
      isMarginCalled: false, 
    })
    await db.insert(settings).values({
      telegramChatId: chatId,
    })
    
    await db.insert(trades).values({
      chatId: chatId,
      ticker: 'AAPL',
      entry: '150', 
      stopLoss: '140',
      target: '180',
      capitalDeployed: '5000',
      riskPerShare: '10',
      riskAmountUsd: '333.33',
    })

    await handlePortfolioStatus(chatId, 'en')

    // /status must use sendGenericMessage (text), never sendPhotoMessage
    expect(mockSendGenericMessage).toHaveBeenCalled()
    const msg = String(mockSendGenericMessage.mock.calls[0][0])
    expect(msg).toContain('AAPL')
    expect(msg).toContain('30,000') // capital
  })

  test('handlePortfolioStatus shows aggregate PnL', async () => {
    const chatId = randomUUID()
    await db.insert(portfolioStats).values({
      chatId: chatId,
      currentCapital: '30000',
      isMarginCalled: false,
    })
    await db.insert(settings).values({
      telegramChatId: chatId,
      quantourApiKey: 'test_key',
    })
    // Position: entry 150, capitalDeployed 5000 → quote mock returns 165
    // PnL = 5000 * (165/150 - 1) = 500 (+10%)
    await db.insert(trades).values({
      chatId: chatId,
      ticker: 'AAPL',
      entry: '150',
      stopLoss: '140',
      target: '180',
      capitalDeployed: '5000',
      riskPerShare: '10',
      riskAmountUsd: '333.33',
    })

    await handlePortfolioStatus(chatId, 'en')

    const msg = String(mockSendGenericMessage.mock.calls[0][0])
    expect(msg).toContain('Total PnL')
    // +$500 = 5000 * (165/150 - 1)
    expect(msg).toContain('500')
  })

  test('handlePortfolioAdd uses signal entry price from scanCache (not live quote)', async () => {
    const chatId = randomUUID()
    await db.insert(settings).values({
      telegramChatId: chatId,
      quantourApiKey: 'test_key',
    })

    // Populate scanCache with a signal for TEST ticker
    const { scanCacheMap } = await import('../clientScanner')
    scanCacheMap.set(chatId, {
      timestamp: Date.now(),
      totalCount: 1,
      top5Text: '',
      allText: '',
      sectorText: '',
      catalystText: '',
      setups: [
        {
          ticker: 'TEST',
          entry: 145,
          target: 180,
          stopLoss: 130,
          strategy: 'Test Signal',
        },
      ],
    })

    await handlePortfolioAdd(
      'TEST', 10, chatId, 'en',
    )

    // Verify the trade was created with the SIGNAL entry (145), not the live quote (150)
    const createdTrades = await db.select().from(trades).where(and(eq(trades.ticker, 'TEST'), eq(trades.chatId, chatId)))
    expect(createdTrades.length).toBe(1)
    expect(createdTrades[0]!.entry).toBe('145')
    expect(createdTrades[0]!.stopLoss).toBe('130')

    // Cleanup scanCache
    scanCacheMap.delete(chatId)
  })

  test('handlePortfolioAdd REJECTS the buy when no signal and no candle data (no more entry-$2.50 fallback)', async () => {
    const chatId = randomUUID()
    await db.insert(settings).values({
      telegramChatId: chatId,
      quantourApiKey: 'test_key',
    })

    // No scanCache signal for NODATA; mockFetch returns [] for /market/historical.
    const ok = await handlePortfolioAdd(
      'NODATA', 10, chatId, 'en',
    )

    // Must reject: no safe stop can be computed.
    expect(ok).toBe(false)
    const created = await db.select().from(trades).where(and(eq(trades.ticker, 'NODATA'), eq(trades.chatId, chatId)))
    expect(created.length).toBe(0)
    // And surface a clear stop-compute-failed message.
    const rejectMsg = mockSendGenericMessage.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes('safe stop-loss'))?.[0]
    expect(rejectMsg).toBeDefined()
  })

  test('handlePortfolioAdd computes a real Wilder-ATR stop when candles are available (not entry-$2.50)', async () => {
    const chatId = randomUUID()
    await db.insert(settings).values({
      telegramChatId: chatId,
      quantourApiKey: 'test_key',
    })

    // Inject 30 days of realistic candles (~$4 daily range) for the historical fetch.
    const candleMock = mock((url: unknown) => {
      const urlStr = String(url)
      if (urlStr.includes('/market/historical')) {
        const series: Array<{ open: number; high: number; low: number; close: number }> = []
        let close = 150
        for (let i = 0; i < 30; i++) {
          const open = close
          const high = close + 2
          const low = close - 2
          close = close + (i % 3 === 0 ? -1 : 1)
          series.push({
            open, high, low, close, 
          })
        }
        return Promise.resolve(new Response(JSON.stringify({ success: true, data: { ATRTEST: series } })))
      }
      // Fall through to the default mock for other endpoints.
      return mockFetch(url)
    })
    const savedFetch = globalThis.fetch
    globalThis.fetch = candleMock as unknown as typeof fetch

    try {
      const ok = await handlePortfolioAdd(
        'ATRTEST', 10, chatId, 'en',
      )
      expect(ok).toBe(true)
      const created = await db.select().from(trades).where(and(eq(trades.ticker, 'ATRTEST'), eq(trades.chatId, chatId)))
      expect(created.length).toBe(1)
      const entry = parseFloat(created[0]!.entry)
      const sl = parseFloat(created[0]!.stopLoss)
      const atr = parseFloat(created[0]!.atr || '0')
      // ATR must be a real value (~4), never the legacy fallback of 1.
      expect(atr).toBeGreaterThan(2)
      // Stop must be a real percentage below entry (~5%), never the $2.50 flat buffer.
      expect(entry - sl).toBeGreaterThan(5)
      expect((entry - sl) / entry).toBeGreaterThan(0.02)
    } finally {
      globalThis.fetch = savedFetch
    }
  })

  test('handlePortfolioRotations queries DB correctly', async () => {
    const { handlePortfolioRotations } = await import('./portfolioHandlers')
    const chatId = randomUUID()
    
    // Add trade to DB
    await db.insert(trades).values({
      chatId: chatId,
      ticker: 'MSFT',
      entry: '300', 
      stopLoss: '280',
      target: '350',
      capitalDeployed: '5000',
      riskPerShare: '20',
      riskAmountUsd: '333.33',
    })

    // Should not throw SQL syntax error
    await handlePortfolioRotations(chatId)
    // Note: It might call fetchFromApi, but we just verify it doesn't crash on DB
  })

  test('handleBudget calculates and sends budget overview', async () => {
    const { handleBudget } = await import('./portfolioHandlers')
    const chatId = randomUUID()
    
    // Add stats to DB
    await db.insert(portfolioStats).values({ 
      chatId: chatId, 
      currentCapital: '100000', 
    })
    
    await db.insert(settings).values({
      telegramChatId: chatId,
      userId: chatId,
    })
    await db.insert(userBudgets).values({ userId: chatId, totalCapital: '100000', maxRiskPerTrade: '500' })

    // Add trades to DB
    await db.insert(trades).values({
      chatId: chatId,
      ticker: 'TSLA',
      entry: '200', 
      stopLoss: '180',
      target: '250',
      capitalDeployed: '10000',
      riskPerShare: '10',
      riskAmountUsd: '500',
    })

    await handleBudget(chatId, 'en')

    expect(mockSendGenericMessage).toHaveBeenCalled()
    const msg = mockSendGenericMessage.mock.calls.find(call => typeof call[0] === 'string' && call[0].includes('Budget Overview'))?.[0] as string | undefined
    expect(msg).toContain('Total Account Size')
    expect(msg).toContain('100,000') // capital
    expect(msg).toContain('10,000') // deployed
    expect(msg).toContain('90,000') // free cash ($100,000 - $10,000)
  })

  test('percentage risk (3%) is calculated from Total Account Capital ($30,000) regardless of invested/free cash split', async () => {
    const { handleBudget, handlePortfolioStatus } = await import('./portfolioHandlers')
    const { getEffectiveRisk } = await import('@quantour/shared-algo/src/finance-algo/screener')
    const chatId = randomUUID()

    // 1. User has $30,000 total capital with 3% max risk per trade
    await db.insert(portfolioStats).values({ 
      chatId: chatId, 
      currentCapital: '30000', 
    })
    await db.insert(settings).values({
      telegramChatId: chatId,
      userId: chatId,
    })
    await db.insert(userBudgets).values({ userId: chatId, totalCapital: '30000', maxRiskPerTrade: '3%' })

    // 2. Add an active trade ($20,000 capital deployed)
    await db.insert(trades).values({
      chatId: chatId,
      ticker: 'NVDA',
      entry: '120', 
      stopLoss: '110',
      target: '150',
      capitalDeployed: '20000',
      riskPerShare: '10',
      riskAmountUsd: '900',
    })

    // 3. Verify getEffectiveRisk calculates 3% of $30,000 = $900 (NOT 3% of $10,000 = $300)
    const effectiveRiskUsd = getEffectiveRisk('3%', 30000)
    expect(effectiveRiskUsd).toBe(900)

    // 4. Verify /budget displays $900 (3%)
    mockSendGenericMessage.mockClear()
    await handleBudget(chatId, 'en')
    const budgetMsg = mockSendGenericMessage.mock.calls.find(call => typeof call[0] === 'string' && call[0].includes('Budget Overview'))?.[0] as string | undefined
    expect(budgetMsg).toContain('$900 (3%)')

    // 5. Verify /status displays $900 (3%)
    mockSendGenericMessage.mockClear()
    await handlePortfolioStatus(chatId, 'en')
    const statusMsg = mockSendGenericMessage.mock.calls.find(call => typeof call[0] === 'string' && call[0].includes('Max Risk'))?.[0] as string | undefined
    expect(statusMsg).toContain('$900 (3%)')
  })

  test('Integration: /budget 48000 recomputes free cash from MARKET value of holdings ($23,475.41 cost, quote 165)', async () => {
    const { handleBudget, getAvailableCash } = await import('./portfolioHandlers')
    const { handleSetCapital, handleSetRisk } = await import('./settingsHandlers')
    const chatId = randomUUID()

    // 1. User registers initial portfolio settings
    await db.insert(settings).values({
      telegramChatId: chatId,
      userId: chatId,
      quantourApiKey: 'test_key',
    })
    await db.insert(portfolioStats).values({
      chatId: chatId,
      userId: chatId,
      initialCapital: '30000',
      currentCapital: '30000',
    })

    // 2. User sets capital to $48,000 via /budget 48000 or handleSetCapital
    await handleSetCapital(chatId, 48000, 'en')
    await handleSetRisk(chatId, '3%', 'en')

    // 2. Add active invested position: cost $23,475.41 @ entry 150; the mock
    // quote endpoint returns AAPL at 165 → market value $25,822.95.
    await db.insert(trades).values({
      chatId: chatId,
      ticker: 'AAPL',
      entry: '150',
      stopLoss: '140',
      target: '180',
      capitalDeployed: '23475.41',
      riskPerShare: '10',
      riskAmountUsd: '1440',
    })

    // 3. Free cash = budget − MARKET value of holdings = 48000 − 25822.95
    const freeCash = await getAvailableCash(chatId)
    expect(freeCash).toBeCloseTo(22177.05, 2)

    // 4. Trigger /budget overview output
    mockSendGenericMessage.mockClear()
    await handleBudget(chatId, 'en')

    const budgetMsg = mockSendGenericMessage.mock.calls.find(call => typeof call[0] === 'string' && call[0].includes('Budget Overview'))?.[0] as string | undefined

    expect(budgetMsg).toBeDefined()
    expect(budgetMsg).toContain('48,000') // Total Account Size
    expect(budgetMsg).toContain('22,177.05') // Free Available Cash (market-value)
    expect(budgetMsg).toContain('25,822.95') // Invested at market value
    expect(budgetMsg).toContain('$1,440 (3%)') // Max Risk per trade (3% of $48,000)
  })

  test('Integration: /optimize recommends buy setups utilizing unallocated free cash', async () => {
    const { handlePortfolioRotations } = await import('./portfolioHandlers')
    const chatId = randomUUID()

    // 1. Setup user with $30,000 total capital and $30,000 free cash (0 open positions)
    await db.insert(settings).values({
      telegramChatId: chatId,
      userId: chatId,
    })
    await db.insert(portfolioStats).values({
      chatId: chatId,
      userId: chatId,
      initialCapital: '30000',
      currentCapital: '30000',
    })

    // 2. Trigger /optimize (handlePortfolioRotations)
    mockSendGenericMessage.mockClear()
    await handlePortfolioRotations(chatId)

    expect(mockSendGenericMessage).toHaveBeenCalled()
    const msg = mockSendGenericMessage.mock.calls[0]?.[0] as string | undefined
    expect(msg).toBeDefined()
  })

  test('handleApplyOptimization executes target portfolio actions transactionally', async () => {
    const { handlePortfolioRotations } = await import('./portfolioHandlers')
    const chatId = randomUUID()

    await db.insert(settings).values({
      telegramChatId: chatId,
      quantourApiKey: 'test_key',
      userId: chatId,
    })
    await db.insert(portfolioStats).values({
      chatId: chatId,
      userId: chatId,
      initialCapital: '30000',
      currentCapital: '30000',
    })

    // Run optimize to populate optimizeCache
    await handlePortfolioRotations(chatId)

    // Call handleApplyOptimization
    mockSendGenericMessage.mockClear()
    await handleApplyOptimization(chatId)

    expect(mockSendGenericMessage).toHaveBeenCalled()
    const msg = mockSendGenericMessage.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes('Target Portfolio Applied'))?.[0] as string | undefined
    expect(msg).toBeDefined()

    // Calling again should return no pending optimization notice
    mockSendGenericMessage.mockClear()
    await handleApplyOptimization(chatId)
    const noPendingMsg = mockSendGenericMessage.mock.calls[0][0] as string
    expect(noPendingMsg).toContain('No pending optimization')
  })

  // -- Pure function tests (dashboard endpoint path) --

  test('computePortfolioRotations returns null when scope has no settings row', async () => {
    const result = await computePortfolioRotations({ userId: 'nonexistent', chatIds: [] })
    expect(result).toBeNull()
  })

  test('computePortfolioRotations returns structured RotationResult for a valid scope', async () => {
    const userId = randomUUID()
    await db.insert(settings).values({
      telegramChatId: null,
      userId,
      quantourApiKey: 'test_key',
      // AST with valid rotationRules so scoreGainMultiplier resolves.
      mainStrategyAst: JSON.stringify({
        entryLogic: { or: [] },
        exitLogic: {},
        rotationRules: { enabled: true, scoreGainMultiplier: 2.5 },
      }),
    })
    await db.insert(portfolioStats).values({
      chatId: 'dashboard_user',
      userId,
      initialCapital: '30000',
      currentCapital: '30000',
    })

    const result = await computePortfolioRotations({
      userId,
      chatIds: [
        'dashboard_user',
      ], 
    })
    expect(result).not.toBeNull()
    expect(result!.scoreGainMultiplier).toBe(2.5)
    expect(result!.rotationResult).toBeDefined()
    expect(Array.isArray(result!.rotationResult.actions)).toBe(true)
    expect(Array.isArray(result!.rotationResult.targetPortfolio)).toBe(true)
    expect([
      'INITIAL_ALLOCATION',
      'RECOMMENDATIONS',
      'ALREADY_OPTIMIZED',
      'NO_SETUPS',
    ]).toContain(result!.rotationResult.rationale)
  })

  test('applyOptimizationActions returns error when no cached result exists', async () => {
    const userId = randomUUID()
    const result = await applyOptimizationActions({ userId, chatIds: [] })
    expect(result.success).toBe(false)
    expect(result.applied).toBe(0)
    expect(result.error).toBe('NO_CACHED_RESULT')
  })

  test('compute then apply roundtrip: cache is keyed by scope and cleared after apply', async () => {
    const userId = randomUUID()
    await db.insert(settings).values({
      telegramChatId: null,
      userId,
      quantourApiKey: 'test_key',
      mainStrategyAst: JSON.stringify({
        entryLogic: { or: [] },
        exitLogic: {},
        rotationRules: { enabled: true, scoreGainMultiplier: 2.5 },
      }),
    })
    await db.insert(portfolioStats).values({
      chatId: 'dashboard_user',
      userId,
      initialCapital: '30000',
      currentCapital: '30000',
    })

    // Compute populates cache keyed by userId scope
    const computed = await computePortfolioRotations({
      userId,
      chatIds: [
        'dashboard_user',
      ], 
    })
    expect(computed).not.toBeNull()

    // Apply reads from the same scope → cache key matches
    const result = await applyOptimizationActions({
      userId,
      chatIds: [
        'dashboard_user',
      ], 
    })
    expect(result.success).toBe(true)

    // A second apply on the same scope must report no cached result (cleared)
    const stale = await applyOptimizationActions({
      userId,
      chatIds: [
        'dashboard_user',
      ], 
    })
    expect(stale.success).toBe(false)
    expect(stale.error).toBe('NO_CACHED_RESULT')
  })

  test('telegram wrapper and dashboard pure fn share the same cache key (cross-surface apply)', async () => {
    // A telegram /optimize caches by chatId-derived scope; the dashboard
    // endpoint resolves the same userId → same scopeCacheKey → apply works.
    const userId = randomUUID()
    const chatId = randomUUID()
    await db.insert(settings).values({
      telegramChatId: chatId,
      userId,
      quantourApiKey: 'test_key',
    })
    await db.insert(portfolioStats).values({
      chatId,
      userId,
      initialCapital: '30000',
      currentCapital: '30000',
    })

    // Telegram wrapper caches under scope derived from chatId → userId
    const { handlePortfolioRotations } = await import('./portfolioHandlers')
    await handlePortfolioRotations(chatId)

    // Dashboard pure apply uses userId scope — same key (userId matches)
    const result = await applyOptimizationActions({
      userId,
      chatIds: [
        chatId,
      ],
    })
    expect(result.success).toBe(true)
  })

  // -- Budget canonical storage -------------------------------------------
  test('handleFreeCash grows user_budgets.totalCapital AND portfolioStats.currentCapital', async () => {
    const chatId = randomUUID()
    const userId = randomUUID()
    await db.insert(settings).values({ telegramChatId: chatId, userId })
    await db.insert(userBudgets).values({ userId, totalCapital: '40000', maxRiskPerTrade: '300' })
    await db.insert(portfolioStats).values({
      chatId, userId, currentCapital: '40000', initialCapital: '40000', 
    })

    await handleFreeCash(chatId, 5000)

    const budget = (await db.select().from(userBudgets).where(eq(userBudgets.userId, userId)))[0]
    expect(budget?.totalCapital).toBe('45000')
    const stats = (await db.select().from(portfolioStats).where(eq(portfolioStats.chatId, chatId)))[0]
    expect(stats?.currentCapital).toBe('45000')
  })

  test('getAvailableCash uses MARKET value of holdings (budget − Σ shares × price)', async () => {
    const chatId = randomUUID()
    const userId = randomUUID()
    await db.insert(settings).values({ telegramChatId: chatId, userId, quantourApiKey: 'test_key' })
    await db.insert(userBudgets).values({ userId, totalCapital: '50000', maxRiskPerTrade: '300' })
    // One deployed trade: cost $10,000 @ entry 100 → mock quote returns AAPL 165
    // → market value $16,500 → available = 50000 − 16500 = 33500.
    await db.insert(trades).values({
      chatId,
      userId,
      ticker: 'AAPL',
      entry: '100',
      stopLoss: '90',
      target: '130',
      riskPerShare: '10',
      riskAmountUsd: '1000',
      capitalDeployed: '10000',
      strategyName: 'MANUAL',
    })

    const cash = await getAvailableCash(chatId)
    expect(cash).toBe(33500)
  })

  test('getAvailableCash falls back to COST basis when no live quote exists (no fabricated prices)', async () => {
    const chatId = randomUUID()
    const userId = randomUUID()
    await db.insert(settings).values({ telegramChatId: chatId, userId, quantourApiKey: 'test_key' })
    await db.insert(userBudgets).values({ userId, totalCapital: '50000', maxRiskPerTrade: '300' })
    // Ticker ZZZZ has no quote in the mock → deployed stays at cost basis
    // $10,000 → available = 50000 − 10000 = 40000.
    await db.insert(trades).values({
      chatId,
      userId,
      ticker: 'ZZZZ',
      entry: '100',
      stopLoss: '90',
      target: '130',
      riskPerShare: '10',
      riskAmountUsd: '1000',
      capitalDeployed: '10000',
      strategyName: 'MANUAL',
    })

    const cash = await getAvailableCash(chatId)
    expect(cash).toBe(40000)
  })

  test('handlePortfolioStatus anchors the total to the configured BUDGET and shows market-value available', async () => {
    const chatId = randomUUID()
    const userId = randomUUID()
    await db.insert(portfolioStats).values({ chatId, userId, currentCapital: '50000' })
    await db.insert(settings).values({ telegramChatId: chatId, userId, quantourApiKey: 'test_key' })
    // Budget = $50,000; holding cost $10,000 @ entry 100 → quote 165 → market $16,500.
    await db.insert(userBudgets).values({ userId, totalCapital: '50000', maxRiskPerTrade: '300' })
    await db.insert(trades).values({
      chatId,
      userId,
      ticker: 'AAPL',
      entry: '100',
      stopLoss: '90',
      target: '130',
      riskPerShare: '10',
      riskAmountUsd: '1000',
      capitalDeployed: '10000',
      strategyName: 'MANUAL',
    })

    await handlePortfolioStatus(chatId, 'en')

    const msg = String(mockSendGenericMessage.mock.calls[0][0])
    expect(msg).toContain('$33,500.00') // available = 50000 − 16500
    expect(msg).toContain('/ $50,000') // total = configured budget, NOT currentCapital drift
  })

  test('handleBuy sizes the position from user_budgets (percent of configured capital) regardless of settings defaults', async () => {
    const chatId = randomUUID()
    const userId = randomUUID()
    // settings carries schema defaults — must NOT drive sizing.
    await db.insert(settings).values({ telegramChatId: chatId, userId })
    // The canonical budget: $60,000 capital, 2% risk → effective risk $1,200.
    await db.insert(userBudgets).values({ userId, totalCapital: '60000', maxRiskPerTrade: '2%' })
    await db.insert(portfolioStats).values({
      chatId, userId, currentCapital: '60000', initialCapital: '60000', 
    })

    // entry 145, stop 130 → riskPerShare 15. $1,200 / $15 = 80 shares ≈ $11,600
    // deployed. (Settings-default $300 risk would give 20 shares ≈ $2,900.)
    await handleBuy({
      ticker: 'SIZETEST', entry: 145, sl: 130, tp: 200, strategy: 'Test', chatId,
    })

    const row = (await db.select().from(trades).where(and(eq(trades.chatId, chatId), eq(trades.ticker, 'SIZETEST'))))[0]
    expect(row).toBeDefined()
    expect(Number(row.capitalDeployed)).toBeGreaterThan(11000)
    expect(Number(row.capitalDeployed)).toBeLessThan(12000)
  })

  test('handleBuy caps the position at the MARKET-VALUE free cash (budget − market holdings)', async () => {
    const chatId = randomUUID()
    const userId = randomUUID()
    await db.insert(settings).values({ telegramChatId: chatId, userId, quantourApiKey: 'test_key' })
    // Budget $50,000 with 10% risk → riskUsd $5,000 → would size 333 sh @ $145.
    await db.insert(userBudgets).values({ userId, totalCapital: '50000', maxRiskPerTrade: '10%' })
    await db.insert(portfolioStats).values({
      chatId, userId, currentCapital: '50000', initialCapital: '50000', 
    })
    // Existing holding: cost $10,000 @ entry 100, quote 165 → market $16,500.
    // Available = 50000 − 16500 = 33,500 → buy must cap at 33500/145 ≈ 231 sh.
    await db.insert(trades).values({
      chatId,
      userId,
      ticker: 'AAPL',
      entry: '100',
      stopLoss: '90',
      target: '130',
      riskPerShare: '10',
      riskAmountUsd: '1000',
      capitalDeployed: '10000',
      strategyName: 'MANUAL',
    })

    await handleBuy({
      ticker: 'SIZETEST', entry: 145, sl: 130, tp: 200, strategy: 'Test', chatId,
    })

    const row = (await db.select().from(trades).where(and(eq(trades.chatId, chatId), eq(trades.ticker, 'SIZETEST'))))[0]
    expect(row).toBeDefined()
    // Capped by market-value available (~33.5k), well below the uncapped $48k.
    expect(Number(row.capitalDeployed)).toBeGreaterThan(33000)
    expect(Number(row.capitalDeployed)).toBeLessThan(34000)
  })
})
