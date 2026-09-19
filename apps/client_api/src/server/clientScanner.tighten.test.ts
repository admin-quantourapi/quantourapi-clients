import {
  afterAll, beforeEach, describe, expect, mock, test,
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

// MOCK DISCIPLINE: `mock.module` is process-wide in bun:test and leaks into
// later test files (see clientScanner.gate.test.ts). Load the REAL marketHours
// first, then spread it and override ONLY isMarketOpen — so a leak into
// queueService/cronJobs still exposes real isMarketDay/isMarketHoliday.
const realMarketHours = await import('@quantour/shared-algo/src/core/marketHours')
mock.module('@quantour/shared-algo/src/core/marketHours', () => ({
  ...realMarketHours,
  isMarketOpen: () => true,
}))

const originalFetch = globalThis.fetch

/**
 * Minimal real AST (same convention as clientScanner.gate.test.ts):
 * currentPrice > 0 fires on any metrics row — no screener mocking needed.
 * With atr=2 the signal computes stopLoss = 150 - 2*2 = 146, target = 162.
 * enableSignalStopRefresh opts the strategy into fresh-signal stop tightening
 * (STRATEGY-GATED: without it the scanner must never re-manage held stops).
 */
const MINIMAL_AST = JSON.stringify({
  entryLogic: {
    or: [
      {
        name: 'Test Branch',
        and: [
          { indicator: 'currentPrice', operator: '>', value: 0 },
        ],
        weight: 1.0,
      },
    ],
  },
  riskManagement: { enableSignalStopRefresh: true },
  maxTotalSignals: 8,
  maxSignalsPerRiskProfile: 3,
  signalAggressiveness: 0.5,
})

function firingMetrics() {
  return [
    {
      ticker: 'NVDA',
      price: 150,
      atr: 2,
    },
  ]
}

const mockFetch = mock((url: unknown, init?: unknown) => {
  const urlStr = String(url)
  const method = (init as RequestInit | undefined)?.method ?? 'GET'
  if (urlStr.includes('/api/v1/metrics') && method === 'POST') {
    return Promise.resolve(new Response(JSON.stringify(firingMetrics())))
  }
  if (urlStr.includes('/api/v1/market/signals')) {
    return Promise.resolve(new Response(JSON.stringify({ success: true })))
  }
  return Promise.resolve(new Response(JSON.stringify(null), { status: 404 }))
})

async function seedHeldPosition(chatId: string, opts: {
  mainStrategyAst?: string
  stopLoss?: string
  target?: string
  atr?: string
  riskPerShare?: string
} = {}) {
  await db.insert(settings).values({
    telegramChatId: chatId,
    userId: chatId,
    quantourApiKey: 'test_key',
    status: 'approved',
    mainStrategyAst: opts.mainStrategyAst,
  })
  await db.insert(portfolioStats).values({ chatId, userId: chatId, currentCapital: '30000' })
  await db.insert(trades).values({
    chatId,
    userId: chatId,
    ticker: 'NVDA',
    entry: '150',
    stopLoss: opts.stopLoss ?? '140',
    target: opts.target ?? '180',
    capitalDeployed: '1500',
    riskPerShare: opts.riskPerShare ?? '10',
    riskAmountUsd: '100',
    atr: opts.atr ?? '4',
  })
}

describe('held-position stop tightening on fresh signals', () => {
  beforeEach(async () => {
    globalThis.fetch = mockFetch as unknown as typeof fetch
    mockSendGenericMessage.mockClear()
    await db.delete(trades)
    await db.delete(portfolioStats)
    await db.delete(settings)
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
    mock.restore()
  })

  test('tightenHeldPositionStops tightens SL, refreshes atr, raises target (real DB)', async () => {
    const chatId = randomUUID()
    await seedHeldPosition(chatId)

    const { tightenHeldPositionStops } = await import('./botHandlers/portfolioHandlers')
    const changes = await tightenHeldPositionStops(chatId, [
      {
        ticker: 'NVDA', entry: 150, stopLoss: 146, target: 200, atr: 2, firedBranchName: '🔮 Test Branch', 
      },
    ])

    expect(changes.length).toBe(1)
    expect(changes[0]!.newStop).toBe(146)
    expect(changes[0]!.newTarget).toBe(200)
    expect(changes[0]!.atrRefreshed).toBe(true)
    expect(changes[0]!.branchReanchored).toBe(true)

    const updated = await db.select().from(trades).where(and(eq(trades.ticker, 'NVDA'), eq(trades.chatId, chatId)))
    expect(updated[0]!.stopLoss).toBe('146.00')
    expect(updated[0]!.atr).toBe('2.00')
    expect(updated[0]!.target).toBe('200.00')
    expect(updated[0]!.firedBranchName).toBe('🔮 Test Branch')
    expect(updated[0]!.riskPerShare).toBe('4.00')
  })

  test('tightenHeldPositionStops NEVER lowers the stop (tighten-only safety)', async () => {
    const chatId = randomUUID()
    await seedHeldPosition(chatId, { stopLoss: '148', riskPerShare: '2', atr: '3' })

    const { tightenHeldPositionStops } = await import('./botHandlers/portfolioHandlers')
    const changes = await tightenHeldPositionStops(chatId, [
      {
        ticker: 'NVDA', entry: 150, stopLoss: 145, target: 200, atr: 5, 
      },
    ])

    expect(changes.length).toBe(1)
    const updated = await db.select().from(trades).where(and(eq(trades.ticker, 'NVDA'), eq(trades.chatId, chatId)))
    expect(updated[0]!.stopLoss).toBe('148')
    expect(updated[0]!.target).toBe('200.00')
    expect(updated[0]!.atr).toBe('5.00')
  })

  test('tightenHeldPositionStops does NOT lower target (raise-only)', async () => {
    const chatId = randomUUID()
    await seedHeldPosition(chatId)

    const { tightenHeldPositionStops } = await import('./botHandlers/portfolioHandlers')
    await tightenHeldPositionStops(chatId, [
      {
        ticker: 'NVDA', entry: 150, stopLoss: 146, target: 160, atr: 2, 
      },
    ])

    const updated = await db.select().from(trades).where(and(eq(trades.ticker, 'NVDA'), eq(trades.chatId, chatId)))
    expect(updated[0]!.target).toBe('180')
  })

  test('runMasterScanner tightens a held position when a fresh signal fires (real scanner + real DB)', async () => {
    const chatId = randomUUID()
    await seedHeldPosition(chatId, { mainStrategyAst: MINIMAL_AST })

    const { runMasterScanner } = await import('./clientScanner')
    await runMasterScanner({
      isManual: true, chatId, ticker: 'NVDA',
    })

    const updated = await db.select().from(trades).where(and(eq(trades.ticker, 'NVDA'), eq(trades.chatId, chatId)))
    expect(updated.length).toBe(1)

    expect(parseFloat(updated[0]!.stopLoss)).toBeGreaterThan(144)
    expect(parseFloat(updated[0]!.stopLoss)).toBeLessThanOrEqual(148)
    expect(parseFloat(updated[0]!.atr || '0')).toBeLessThan(3)
    expect(updated[0]!.firedBranchName).toBeTruthy()

    const tightenNotice = mockSendGenericMessage.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes('NVDA') && c[0].includes('refreshed'))
    expect(tightenNotice).toBeDefined()
  })

  test('runMasterScanner does NOT tighten when enableSignalStopRefresh is off (AST-gated)', async () => {
    const chatId = randomUUID()
    // Same AST but WITHOUT the riskManagement flag — the strategy did not opt in.
    const noFlagAst = JSON.stringify({
      entryLogic: {
        or: [
          {
            name: 'Test Branch',
            and: [
              { indicator: 'currentPrice', operator: '>', value: 0 },
            ],
            weight: 1.0,
          },
        ],
      },
      maxTotalSignals: 8,
      maxSignalsPerRiskProfile: 3,
      signalAggressiveness: 0.5,
    })
    await seedHeldPosition(chatId, { mainStrategyAst: noFlagAst })

    const { runMasterScanner } = await import('./clientScanner')
    await runMasterScanner({
      isManual: true, chatId, ticker: 'NVDA',
    })

    const updated = await db.select().from(trades).where(and(eq(trades.ticker, 'NVDA'), eq(trades.chatId, chatId)))
    expect(updated.length).toBe(1)
    // Position untouched: loose stop stays 140, stale atr stays 4.
    expect(updated[0]!.stopLoss).toBe('140')
    expect(updated[0]!.atr || '').toBe('4')
    expect(updated[0]!.firedBranchName).toBeNull()

    // No tighten notification surfaced (signal broadcast still happened).
    const tightenNotice = mockSendGenericMessage.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes('NVDA') && c[0].includes('refreshed'))
    expect(tightenNotice).toBeUndefined()
  })
})
