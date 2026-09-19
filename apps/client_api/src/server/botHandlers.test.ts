import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { randomUUID } from 'crypto'

import {
  db,
} from '../db'
import {
  settings,
  trades,
} from '../db/clientSchema'

import {
  runDeepPortfolio,
  runDeepScan,
} from './botHandlers'

// Mock dependencies
const mockSendGenericMessage = mock()

mock.module('../services/telegramService', () => ({
  sendGenericMessage: mockSendGenericMessage,
  sendRawTelegram: mock(() => Promise.resolve({ ok: true })),
  registerBotHandlers: mock(),
  getChatLanguage: mock(() => Promise.resolve('en')),
}))

// Mock global fetch for API calls inside runDeepScan
const originalFetch = globalThis.fetch
const mockFetch = mock((): Promise<Response> => Promise.resolve(new Response('')))

describe('botHandlers - runDeepScan', () => {
  beforeEach(async () => {
    globalThis.fetch = mockFetch as unknown as typeof fetch
    mockSendGenericMessage.mockClear()
    // Order-proofing: mockReset drops sticky per-test mockResolvedValue
    // overrides (the 402 test leaked into shuffled successors) but ALSO the
    // original impl — re-seed the deterministic empty-200 baseline.
    mockFetch.mockReset()
    mockFetch.mockImplementation((): Promise<Response> => Promise.resolve(new Response(String())))
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
  })

  test('runDeepScan aborts if no Quantour API Key', async () => {
    const chatId = randomUUID()
    await runDeepScan('AAPL', chatId)

    expect(mockSendGenericMessage).toHaveBeenCalledTimes(1)

    const errMessage = mockSendGenericMessage.mock.calls[0][0]
    expect(errMessage).toContain('Unauthorized')
  })

  test('runDeepScan completes successfully with mock AI response', async () => {
    const chatId = randomUUID()
    const apiKey = `test-key-${randomUUID()}`
    await db.insert(settings).values({ telegramChatId: chatId, quantourApiKey: apiKey })


    mockFetch.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      analysis: 'Apple is a great AI stock.',
    }), { status: 200 }))

    const researchResult = await runDeepScan('AAPL', chatId)

    expect(mockFetch).toHaveBeenCalled()
    const fetchArgs = mockFetch.mock.calls[0] as unknown as [string, { headers: { Authorization: string }; body: string }]
    expect(fetchArgs[0]).toContain('/api/v1/research')
    expect(fetchArgs[1].headers.Authorization).toBe(`Bearer ${apiKey}`)
    expect(fetchArgs[1].body).toContain('AAPL')

    expect(researchResult).toBe('Apple is a great AI stock.')
  })

  test('runDeepScan handles API failure correctly', async () => {
    const chatId = randomUUID()
    await db.insert(settings).values({ telegramChatId: chatId, quantourApiKey: `test-key-${randomUUID()}` })

    mockFetch.mockResolvedValue(new Response(JSON.stringify({
      success: false,
      error: 'API rate limit exceeded',
    }), { status: 400 }))

    const researchResult = await runDeepScan('AAPL', chatId)
    expect(researchResult).toContain('Deep scan failed: API rate limit exceeded')
  })
})

describe('botHandlers - runDeepPortfolio', () => {
  beforeEach(async () => {
    globalThis.fetch = mockFetch as unknown as typeof fetch
    mockSendGenericMessage.mockClear()
    // Order-proofing: mockReset drops sticky per-test mockResolvedValue
    // overrides (the 402 test leaked into shuffled successors) but ALSO the
    // original impl — re-seed the deterministic empty-200 baseline.
    mockFetch.mockReset()
    mockFetch.mockImplementation((): Promise<Response> => Promise.resolve(new Response(String())))
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
  })

  test('runDeepPortfolio aborts if no Quantour API Key', async () => {
    const chatId = randomUUID()
    await runDeepPortfolio(chatId)

    expect(mockSendGenericMessage).toHaveBeenCalledTimes(1)
    const errMessage = mockSendGenericMessage.mock.calls[0][0]
    expect(errMessage).toContain('Unauthorized')
  })

  test('runDeepPortfolio returns empty portfolio message if no tracked stocks', async () => {
    const chatId = randomUUID()
    await db.insert(settings).values({ telegramChatId: chatId, quantourApiKey: `test-key-${randomUUID()}` })

    const res = await runDeepPortfolio(chatId)
    expect(res).toBeUndefined()
    expect(mockSendGenericMessage).toHaveBeenCalled()
    const msg = mockSendGenericMessage.mock.calls[0][0]
    expect(msg).toContain('Portfolio is empty')
  })

  test('runDeepPortfolio posts to /api/v1/deep-portfolio and returns analysis', async () => {
    const chatId = randomUUID()
    const apiKey = `test-key-${randomUUID()}`
    await db.insert(settings).values({ telegramChatId: chatId, quantourApiKey: apiKey })
    await db.insert(trades).values({
      chatId,
      ticker: 'NVDA',
      entry: '120.00',
      stopLoss: '110.00',
      target: '150.00',
      riskPerShare: '10.00',
      riskAmountUsd: '500',
      capitalDeployed: '6000',
    })

    // Fresh Response per call — the account-scope /v1/ping fetch consumes its
    // body, and a shared Response would fail the later deep-portfolio read.
    mockFetch.mockImplementation(async () => new Response(JSON.stringify({
      success: true,
      analysis: '<b>Portfolio Deep Analysis</b>: NVDA is positioned well above 5d and 10d VWAP.',
    }), { status: 200 }))

    const result = await runDeepPortfolio(chatId)

    expect(mockFetch).toHaveBeenCalled()
    // The account-scope resolution (/v1/ping for the API key) may issue an
    // earlier fetch — locate the deep-portfolio call rather than assuming index 0.
    const deepPortfolioCall = mockFetch.mock.calls
      .map(call => call as unknown as [string, { headers: { Authorization: string }; body: string }])
      .find(call => String(call[0]).includes('/api/v1/deep-portfolio'))
    expect(deepPortfolioCall).toBeDefined()
    const fetchArgs = deepPortfolioCall!
    expect(fetchArgs[0]).toContain('/api/v1/deep-portfolio')
    expect(fetchArgs[1].headers.Authorization).toBe(`Bearer ${apiKey}`)
    expect(fetchArgs[1].body).toContain('NVDA')
    expect(result).toContain('NVDA is positioned well above 5d and 10d VWAP')
  })

  test('runDeepPortfolio handles 402 insufficient credits error', async () => {
    const chatId = randomUUID()
    await db.insert(settings).values({ telegramChatId: chatId, quantourApiKey: `test-key-${randomUUID()}` })
    await db.insert(trades).values({
      chatId,
      ticker: 'AAPL',
      entry: '180.00',
      stopLoss: '170.00',
      target: '210.00',
      riskPerShare: '10.00',
      riskAmountUsd: '500',
      capitalDeployed: '5000',
    })

    mockFetch.mockResolvedValue(new Response(JSON.stringify({
      success: false,
      error: 'Insufficient AI credits',
    }), { status: 402 }))

    const result = await runDeepPortfolio(chatId)
    expect(result).toContain('requires 15 credits')
  })
})

// Restore module mocks so the telegramService mock (getChatLanguage etc.) does
// not leak into subsequent test files run in the same process.
afterAll(() => {
  mock.restore()
})
