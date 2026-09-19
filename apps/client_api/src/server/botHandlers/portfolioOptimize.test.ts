import {
  afterAll, afterEach, beforeEach, describe, expect, mock, test,
} from 'bun:test'
import { randomUUID } from 'crypto'
import {
  and, eq,
} from 'drizzle-orm'

import { db } from '~/db'
import {
  portfolioStats, settings, trades,
} from '~/db/clientSchema'

const mockSendGenericMessage = mock()

// Order-proofing: capture the CURRENT module surface and spread it below —
// mock.module is process-global and never restored between bun test files,
// so a partial export set starves later importers in shuffled orders.
const realTelegramService = await import('~/services/telegramService')
mock.module('~/services/telegramService', () => ({
  ...realTelegramService,
  sendGenericMessage: mockSendGenericMessage,
  sendPhotoMessage: mock(() => Promise.resolve({ ok: true })),
  sendRawTelegram: mock(() => Promise.resolve({ ok: true })),
  getChatLanguage: mock(() => Promise.resolve('en')),
}))

const originalFetch = globalThis.fetch

// Per-test payloads for the mocked central API.
let signalsPayload: unknown = { signals: [] }
let quotesAvailable = true
let quotesPayload: unknown = [
  { symbol: 'OLD', price: 100 },
  { symbol: 'STRONG', price: 150 },
]

const mockFetch = mock(async (url: unknown, init?: unknown) => {
  const urlStr = String(url)
  const method = (init as RequestInit | undefined)?.method ?? 'GET'
  if (urlStr.includes('/v1/signals') && method === 'GET') {
    return new Response(JSON.stringify(signalsPayload), { status: 200 })
  }
  if (urlStr.includes('/market/quotes')) {
    if (!quotesAvailable) return new Response(JSON.stringify([]), { status: 200 })
    return new Response(JSON.stringify(quotesPayload), { status: 200 })
  }
  if (urlStr.includes('/market/historical')) {
    return new Response(JSON.stringify({ success: true, data: {} }), { status: 200 })
  }
  if (urlStr.includes('/market/quote/')) {
    if (!quotesAvailable) return new Response(JSON.stringify(null), { status: 404 })
    return new Response(JSON.stringify({ symbol: 'STRONG', price: 150 }), { status: 200 })
  }
  if (urlStr.includes('/ticker/')) {
    if (!quotesAvailable) return new Response(JSON.stringify(null), { status: 404 })
    return new Response(JSON.stringify({
      success: true,
      data: { quote: { symbol: 'STRONG', price: 150 } },
    }), { status: 200 })
  }
  return new Response(JSON.stringify(null), { status: 404 })
})

const MINIMAL_AST = JSON.stringify({
  rotationRules: {
    enabled: true,
    scoreGainMultiplier: 2.5,
    allowCashDeployment: true,
  },
})

async function seedAccount(chatId: string) {
  await db.insert(settings).values({
    telegramChatId: chatId,
    userId: chatId,
    quantourApiKey: 'test_key',
    status: 'approved',
    mainStrategyAst: MINIMAL_AST,
  })
  await db.insert(portfolioStats).values({
    chatId, userId: chatId, initialCapital: '30000', currentCapital: '30000',
  })
  // One weak held position: $5,000 deployed → $25,000 free cash.
  await db.insert(trades).values({
    chatId,
    userId: chatId,
    ticker: 'OLD',
    entry: '100',
    stopLoss: '95',
    target: '110',
    capitalDeployed: '5000',
    riskPerShare: '5',
    riskAmountUsd: '250',
    atr: '3',
  })
}

function setupSignal(): unknown {
  return {
    signals: [
      {
        ticker: 'STRONG',
        entry: 150,
        stopLoss: 140,
        target: 195,
        strategyName: 'AI_COMBINED',
      },
    ],
  }
}

describe('portfolio /optimize — client_api integration with mocked data', () => {
  beforeEach(async () => {
    globalThis.fetch = mockFetch as unknown as typeof fetch
    signalsPayload = { signals: [] }
    quotesAvailable = true
    quotesPayload = [
      { symbol: 'OLD', price: 100 },
      { symbol: 'STRONG', price: 150 },
    ]
    mockSendGenericMessage.mockClear()
    mockFetch.mockClear()
    await db.delete(trades)
    await db.delete(portfolioStats)
    await db.delete(settings)
    const { scanCacheMap } = await import('../clientScanner')
    scanCacheMap.clear()
    const { clearQuoteCache } = await import('./portfolioHandlers')
    clearQuoteCache()
  })

  afterEach(async () => {
    const { scanCacheMap } = await import('../clientScanner')
    scanCacheMap.clear()
    const { clearQuoteCache } = await import('./portfolioHandlers')
    clearQuoteCache()
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
    mock.restore()
  })

  test('real setups from /v1/signals: rotation recommended and BUY carries the signal stop', async () => {
    const chatId = randomUUID()
    await seedAccount(chatId)
    signalsPayload = setupSignal()

    const { computePortfolioRotations, handlePortfolioRotations, applyOptimizationActions } = await import('./portfolioHandlers')
    const scope = {
      userId: chatId,
      chatIds: [
        chatId,
      ], 
    }

    // 1. Structured result: cash deployed into STRONG with the SIGNAL stops.
    const result = await computePortfolioRotations(scope)
    expect(result).not.toBeNull()
    expect(result!.rotationResult.rationale).toBe('RECOMMENDATIONS')
    // Real signals were used — NOT the fallback.
    expect(result!.usedFallback).toBe(false)
    const buy = result!.rotationResult.actions.find(a => a.type === 'BUY' && a.ticker === 'STRONG')
    expect(buy).toBeDefined()
    // Signal stops threaded through PortfolioAction (regression guard).
    expect(buy!.entry).toBe(150)
    expect(buy!.stopLoss).toBe(140)
    expect(buy!.target).toBe(195)

    // 2. Telegram message surfaces the recommendation (not "already optimal").
    mockSendGenericMessage.mockClear()
    await handlePortfolioRotations(chatId)
    const optimizeMsg = mockSendGenericMessage.mock.calls.map(c => String(c[0])).join('\n')
    expect(optimizeMsg).toContain('STRONG')
    expect(optimizeMsg).not.toContain('optimal')

    // 3. Apply persists the trade with the SIGNAL stop (not a dummy fallback).
    const applied = await applyOptimizationActions(scope)
    expect(applied.success).toBe(true)
    const created = await db.select().from(trades).where(and(eq(trades.ticker, 'STRONG'), eq(trades.chatId, chatId)))
    expect(created.length).toBe(1)
    expect(parseFloat(created[0]!.entry)).toBe(150)
    expect(parseFloat(created[0]!.stopLoss)).toBe(140)
    expect(parseFloat(created[0]!.target)).toBe(195)
  })

  test('empty /v1/signals falls back to the scanCache setups', async () => {
    const chatId = randomUUID()
    await seedAccount(chatId)
    signalsPayload = { signals: [] }

    // Populate the scanCache for this chat (as the scanner would).
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
          ticker: 'STRONG', entry: 150, stopLoss: 140, target: 195, strategy: 'AI_COMBINED', 
        },
      ],
    })

    const { computePortfolioRotations } = await import('./portfolioHandlers')
    const result = await computePortfolioRotations({
      userId: chatId,
      chatIds: [
        chatId,
      ], 
    })
    expect(result).not.toBeNull()
    expect(result!.rotationResult.rationale).toBe('RECOMMENDATIONS')
    const buy = result!.rotationResult.actions.find(a => a.type === 'BUY' && a.ticker === 'STRONG')
    expect(buy).toBeDefined()
    expect(buy!.stopLoss).toBe(140)
  })

  test('no signals, no scanCache, AND no quotes: honest "no setups" verdict (never fabricated "already optimal")', async () => {
    const chatId = randomUUID()
    await seedAccount(chatId)
    // signalsPayload stays empty; scanCache stays empty; quotes unavailable.
    quotesAvailable = false

    const { computePortfolioRotations, handlePortfolioRotations } = await import('./portfolioHandlers')
    const result = await computePortfolioRotations({
      userId: chatId,
      chatIds: [
        chatId,
      ], 
    })
    expect(result).not.toBeNull()
    expect(result!.rotationResult.rationale).toBe('NO_SETUPS')
    expect(result!.rotationResult.actions).toEqual([])

    mockSendGenericMessage.mockClear()
    await handlePortfolioRotations(chatId)
    const optimizeMsg = mockSendGenericMessage.mock.calls.map(c => String(c[0])).join('\n')
    expect(optimizeMsg).toContain('No current market setups')
    // The misleading "already optimal" verdict must NOT be sent.
    expect(optimizeMsg).not.toContain('optimal')
  })

  test('no signals but LIVE quotes: fallback candidates derive REAL stops from intraday range', async () => {
    const chatId = randomUUID()
    await seedAccount(chatId)
    // signalsPayload empty, scanCache empty, but quotes available for the
    // default candidate universe (real prices + real day range).
    quotesPayload = [
      {
        symbol: 'NVDA', price: 150, dayLow: 148, dayHigh: 152, 
      },
      {
        symbol: 'AVGO', price: 200, dayLow: 198, dayHigh: 202, 
      },
    ]

    const { computePortfolioRotations } = await import('./portfolioHandlers')
    const result = await computePortfolioRotations({
      userId: chatId,
      chatIds: [
        chatId,
      ], 
    })
    expect(result).not.toBeNull()
    expect(result!.rotationResult.rationale).not.toBe('NO_SETUPS')
    // Fallback path flagged so the Telegram message can add the honesty notice.
    expect(result!.usedFallback).toBe(true)

    // Fallback candidates carry REAL stops derived from the intraday range:
    // stop = price - 2.5 * (dayHigh - dayLow). For NVDA: 150 - 2.5*4 = 140.
    const buy = result!.rotationResult.actions.find(a => a.type === 'BUY' && a.ticker === 'NVDA')
    expect(buy).toBeDefined()
    expect(buy!.stopLoss).toBe(140)
    expect(buy!.target).toBe(180)
  })
})
