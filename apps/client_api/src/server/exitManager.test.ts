import {
  afterAll, beforeEach, describe, expect, mock, test,
} from 'bun:test'
import { randomUUID } from 'crypto'

import { db } from '~/db'
import {
  settings, trades,
} from '~/db/clientSchema'

// Mock telegramService so exitManager's sendGenericMessage calls are captured
const mockSendGenericMessage = mock((): Promise<number | undefined> => Promise.resolve(1))
// Order-proofing: capture the CURRENT module surface and spread it below —
// mock.module is process-global and never restored between bun test files,
// so a partial export set starves later importers in shuffled orders.
const realTelegramService = await import('~/services/telegramService')
mock.module('~/services/telegramService', () => ({
  ...realTelegramService,
  sendGenericMessage: mockSendGenericMessage,
  sendRawTelegram: mock(() => Promise.resolve({ ok: true })),
  getChatLanguage: mock(() => Promise.resolve('en')),
}))

// Mock global fetch — exitManager uses its own local fetchFromApi which wraps fetch
const mockFetch = mock((input: string | URL | Request): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  // Rotation-context endpoint (SECTOR_ROTATION_TRIM arm): default healthy
  // sector (no cooling) + strong score so the arm stays dormant unless a
  // test explicitly asks for a cooling context.
  if (url.includes('/rotation-context')) {
    return Promise.resolve(new Response(JSON.stringify({
      context: {
        SLTEST: {
          rank: 0.7,
          trend: 0.2,
          ageDays: 1,
          newsScore: 7.5,
          sectorNewsTrend: 0.8,
          sector: 'Technology',
        },
      },
    })))
  }
  return Promise.resolve(new Response(JSON.stringify({
    success: true,
    data: {
      tickers: [
        {
          ticker: 'SLTEST',
          symbol: 'SLTEST',
          price: 90.0,
          dayHigh: 92.0,
          dayLow: 88.0,
        },
      ],
    },
  })))
})
const originalFetch = globalThis.fetch

describe('exitManager — SL-hit notification', () => {
  beforeEach(async () => {
    globalThis.fetch = mockFetch as unknown as typeof fetch
    mockSendGenericMessage.mockClear()
    mockFetch.mockClear()
    await db.delete(trades)
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
  })

  test('checkTrackedExits returns STOP LOSS HIT notification when stop is breached', async () => {
    const { checkTrackedExits } = await import('~/server/exitManager')
    const chatId = randomUUID()

    // Settings with API key (exitManager requires quantourApiKey to fetch market data)
    await db.insert(settings).values({
      telegramChatId: chatId,
      quantourApiKey: 'test-key-1234567890',
      language: 'en',
    })

    // Trade: entry 100, stopLoss 95 → mocked price 90 (below stop)
    await db.insert(trades).values({
      chatId,
      ticker: 'SLTEST',
      entry: '100',
      stopLoss: '95',
      target: '115',
      capitalDeployed: '1000',
      riskPerShare: '5',
      riskAmountUsd: '50',
      highestHigh: '100',
      atr: '2',
    })

    const notifications = await checkTrackedExits()

    // Find the notification for our chatId
    const note = notifications.find(n => n.chatId === chatId)
    expect(note).toBeDefined()

    // At least one message should reference the stop-loss exit
    const hasStopHit = note!.messages.some(m =>
      m.includes('STOP LOSS') || m.includes('SELL_SIGNAL'))
    expect(hasStopHit).toBe(true)
  })
})

describe('exitManager — SECTOR_ROTATION_TRIM (rotation_conviction_v1)', () => {
  beforeEach(async () => {
    globalThis.fetch = mockFetch as unknown as typeof fetch
    mockSendGenericMessage.mockClear()
    mockFetch.mockClear()
    await db.delete(trades)
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
  })

  async function seedPosition(chatId: string, overrides: Partial<Record<string, unknown>> = {}) {
    await db.insert(settings).values({
      telegramChatId: chatId,
      quantourApiKey: 'test-key-1234567890',
      language: 'en',
      // Single-object form (canonical for client_api mainStrategyAst — the
      // ARRAY form exists only in the central forward_test_portfolios store).
      mainStrategyAst: JSON.stringify({
        strategyName: 'AI_COMBINED',
        entryLogic: { or: [] },
        exitLogic: { or: [] },
        rotationRules: { rotationExemptBranches: ['🌱 FCF Spring & Sector Tailwind'] },
      }),
    })
    const tradeRow: Record<string, unknown> = {
      chatId,
      ticker: 'SLTEST',
      entry: '100',
      stopLoss: '95',
      target: '115',
      capitalDeployed: '1000',
      riskPerShare: '5',
      riskAmountUsd: '50',
      highestHigh: '100',
      atr: '2',
      daysHeld: 25, // >= rotationRules.minHoldingDays(20) trim floor
      firedBranchName: '🔮 High AI Conviction & Early Reclaim',
      ...overrides,
    }
    await db.insert(trades).values(tradeRow as typeof trades.$inferInsert)
  }

  test('fires SECTOR_ROTATION_TRIM when sector cools + own score < 6 + daysHeld > 5', async () => {
    const { checkTrackedExits } = await import('~/server/exitManager')
    const chatId = randomUUID()
    await seedPosition(chatId)

    // Swap the rotation context to a cooling sector + weak conviction.
    mockFetch.mockImplementation(((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/rotation-context')) {
        return Promise.resolve(new Response(JSON.stringify({
          context: {
            SLTEST: {
              rank: 0.4, trend: -1.2, ageDays: 2, newsScore: 5.2,
              sectorNewsTrend: -1.2, sector: 'Technology',
            },
          },
        })))
      }
      return Promise.resolve(new Response(JSON.stringify({
        success: true,
        data: { tickers: [{ ticker: 'SLTEST', symbol: 'SLTEST', price: 102.0, dayHigh: 103.0, dayLow: 101.0 }] },
      })))
    }) as never)

    const notifications = await checkTrackedExits()
    const note = notifications.find(n => n.chatId === chatId)
    expect(note).toBeDefined()
    const hasTrim = note!.messages.some(m => m.includes('Sector Rotation') && m.includes('SLTEST'))
    expect(hasTrim).toBe(true)
  })

  test('no trim when own conviction is strong (>= 6) even with sector cooling', async () => {
    const { checkTrackedExits } = await import('~/server/exitManager')
    const chatId = randomUUID()
    await seedPosition(chatId)

    mockFetch.mockImplementation(((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/rotation-context')) {
        return Promise.resolve(new Response(JSON.stringify({
          context: {
            SLTEST: {
              rank: 0.7, trend: 0.1, ageDays: 1, newsScore: 7.4,
              sectorNewsTrend: -1.2, sector: 'Technology',
            },
          },
        })))
      }
      return Promise.resolve(new Response(JSON.stringify({
        success: true,
        data: { tickers: [{ ticker: 'SLTEST', symbol: 'SLTEST', price: 102.0, dayHigh: 103.0, dayLow: 101.0 }] },
      })))
    }) as never)

    const notifications = await checkTrackedExits()
    const note = notifications.find(n => n.chatId === chatId)
    const hasTrim = note?.messages.some(m => m.includes('Sector Rotation')) ?? false
    expect(hasTrim).toBe(false)
  })

  test('structural sleeve (🌱) is exempt from the trim arm', async () => {
    const { checkTrackedExits } = await import('~/server/exitManager')
    const chatId = randomUUID()
    await seedPosition(chatId, { firedBranchName: '🌱 FCF Spring & Sector Tailwind' })

    mockFetch.mockImplementation(((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/rotation-context')) {
        return Promise.resolve(new Response(JSON.stringify({
          context: {
            SLTEST: {
              rank: 0.4, trend: -1.2, ageDays: 2, newsScore: 5.2,
              sectorNewsTrend: -1.2, sector: 'Technology',
            },
          },
        })))
      }
      return Promise.resolve(new Response(JSON.stringify({
        success: true,
        data: { tickers: [{ ticker: 'SLTEST', symbol: 'SLTEST', price: 102.0, dayHigh: 103.0, dayLow: 101.0 }] },
      })))
    }) as never)

    const notifications = await checkTrackedExits()
    const note = notifications.find(n => n.chatId === chatId)
    const hasTrim = note?.messages.some(m => m.includes('Sector Rotation')) ?? false
    expect(hasTrim).toBe(false)
  })

  test('no trim below the rotationRules.minHoldingDays hold floor (daysHeld 5)', async () => {
    const { checkTrackedExits } = await import('~/server/exitManager')
    const chatId = randomUUID()
    // Seeded AST declares no minHoldingDays → floor defaults to 20 (the
    // FORCED_ROTATION churn lesson). daysHeld 5 must NOT trim, even with a
    // cooling sector and weak conviction.
    await seedPosition(chatId, { daysHeld: 5 })

    mockFetch.mockImplementation(((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/rotation-context')) {
        return Promise.resolve(new Response(JSON.stringify({
          context: {
            SLTEST: {
              rank: 0.4, trend: -1.2, ageDays: 2, newsScore: 5.2,
              sectorNewsTrend: -1.2, sector: 'Technology',
            },
          },
        })))
      }
      return Promise.resolve(new Response(JSON.stringify({
        success: true,
        data: { tickers: [{ ticker: 'SLTEST', symbol: 'SLTEST', price: 102.0, dayHigh: 103.0, dayLow: 101.0 }] },
      })))
    }) as never)

    const notifications = await checkTrackedExits()
    const note = notifications.find(n => n.chatId === chatId)
    const hasTrim = note?.messages.some(m => m.includes('Sector Rotation')) ?? false
    expect(hasTrim).toBe(false)
  })

  test('no trim when sector trend is missing (fail-soft: no fabricated trim)', async () => {
    const { checkTrackedExits } = await import('~/server/exitManager')
    const chatId = randomUUID()
    await seedPosition(chatId)

    mockFetch.mockImplementation(((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/rotation-context')) {
        return Promise.resolve(new Response(JSON.stringify({
          context: {
            SLTEST: {
              rank: 0.4, trend: -1.2, ageDays: 2, newsScore: 5.2,
              sectorNewsTrend: null, sector: 'Technology',
            },
          },
        })))
      }
      return Promise.resolve(new Response(JSON.stringify({
        success: true,
        data: { tickers: [{ ticker: 'SLTEST', symbol: 'SLTEST', price: 102.0, dayHigh: 103.0, dayLow: 101.0 }] },
      })))
    }) as never)

    const notifications = await checkTrackedExits()
    const note = notifications.find(n => n.chatId === chatId)
    const hasTrim = note?.messages.some(m => m.includes('Sector Rotation')) ?? false
    expect(hasTrim).toBe(false)
  })
})

describe('exitManager — sleeve thesis-break does not dump velocity', () => {
  beforeEach(async () => {
    globalThis.fetch = mockFetch as unknown as typeof fetch
    mockSendGenericMessage.mockClear()
    mockFetch.mockClear()
    await db.delete(trades)
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
  })

  async function seedWithExitLogic(chatId: string, firedBranchName: string) {
    await db.insert(settings).values({
      telegramChatId: chatId,
      quantourApiKey: 'test-key-1234567890',
      language: 'en',
      mainStrategyAst: JSON.stringify({
        strategyName: 'AI_COMBINED',
        entryLogic: { or: [] },
        exitLogic: {
          or: [
            { indicator: 'newsScore', operator: '<', value: 4.0 },
            { indicator: 'fcfInflection', operator: '==', value: 'NEGATIVE' },
          ],
        },
        rotationRules: { rotationExemptBranches: ['🌱 FCF Spring & Sector Tailwind'] },
      }),
    })
    await db.insert(trades).values({
      chatId,
      ticker: 'SLTEST',
      entry: '100',
      stopLoss: '95',
      target: '115',
      capitalDeployed: '1000',
      riskPerShare: '5',
      riskAmountUsd: '50',
      highestHigh: '100',
      atr: '2',
      daysHeld: 25,
      firedBranchName,
    })
  }

  test('FCF NEGATIVE does not STRATEGY_LOGIC_SELL a 🔮 position', async () => {
    const { checkTrackedExits } = await import('~/server/exitManager')
    const chatId = randomUUID()
    await seedWithExitLogic(chatId, '🔮 High AI Conviction & Early Reclaim')
    mockFetch.mockImplementation(((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/rotation-context')) {
        return Promise.resolve(new Response(JSON.stringify({ context: { SLTEST: { newsScore: 7 } } })))
      }
      return Promise.resolve(new Response(JSON.stringify({
        success: true,
        data: { tickers: [{ ticker: 'SLTEST', symbol: 'SLTEST', price: 102, dayHigh: 103, dayLow: 101, fcfInflection: 'NEGATIVE' }] },
      })))
    }) as never)
    const notifications = await checkTrackedExits()
    const note = notifications.find(n => n.chatId === chatId)
    expect(note?.messages.some(m => m.includes('STRATEGY_LOGIC_SELL') || m.includes('SELL_SIGNAL')) ?? false).toBe(false)
  })

  test('FCF NEGATIVE does STRATEGY_LOGIC_SELL a 🌱 position', async () => {
    const { checkTrackedExits } = await import('~/server/exitManager')
    const chatId = randomUUID()
    await seedWithExitLogic(chatId, '🌱 FCF Spring & Sector Tailwind')
    mockFetch.mockImplementation(((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/rotation-context')) {
        return Promise.resolve(new Response(JSON.stringify({ context: { SLTEST: { newsScore: 7 } } })))
      }
      return Promise.resolve(new Response(JSON.stringify({
        success: true,
        data: { tickers: [{ ticker: 'SLTEST', symbol: 'SLTEST', price: 102, dayHigh: 103, dayLow: 101, fcfInflection: 'NEGATIVE' }] },
      })))
    }) as never)
    const notifications = await checkTrackedExits()
    const note = notifications.find(n => n.chatId === chatId)
    expect(note).toBeDefined()
    expect(note!.messages.some(m => m.includes('SLTEST'))).toBe(true)
  })
})

// Restore module mocks so the telegramService mock does not leak into later files.
afterAll(() => {
  mock.restore()
})
