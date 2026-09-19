import {
  afterAll, beforeEach, describe, expect, mock, test, 
} from 'bun:test'

import {
  estimateSlotSize, handleInfo,
} from './infoHandlers'

// Mock dependencies
const mockSendGenericMessage = mock()
const mockGetQuote = mock()
const mockGetProfile = mock()
const mockGetPriceTargetConsensus = mock()
const mockGetFcfData = mock()

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

import { randomUUID } from 'crypto'

import { db } from '~/db'
import { settings } from '~/db/clientSchema'

mock.module('~/services/fcfService', () => ({
  getFcfDataForTicker: mockGetFcfData,
}))

// Mock global fetch for API calls inside handleInfo
const originalFetch = globalThis.fetch
const mockFetch = mock((): Promise<Response> => Promise.resolve(new Response('')))

describe('infoHandlers', () => {
  beforeEach(async () => {
    globalThis.fetch = mockFetch as unknown as typeof fetch
    mockSendGenericMessage.mockClear()
    mockGetQuote.mockClear()
    mockGetProfile.mockClear()
    mockGetPriceTargetConsensus.mockClear()
    mockGetFcfData.mockClear()
    mockFetch.mockClear()
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
    mock.restore()
  })

  test('handleInfo with valid ticker', async () => {
    const chatId = randomUUID()
    await db.insert(settings).values({ telegramChatId: chatId, quantourApiKey: 'test-key-123' })
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      success: true,
      data: {
        ticker: { companyName: 'Apple Inc.', sector: 'Technology' },
        quote: {
          name: 'Apple Inc.', price: 150.0, changesPercentage: 1.5, marketCap: 2500000000000, 
        },
        consensus: { targetMean: 180.0 },
        fcfData: [
          { fcfPerShare: 5.0, ratio: 20 },
        ],
      },
    }), { status: 200 }))
    
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      success: true,
      data: {
        catalysts: [
          { type: 'Earnings', description: 'Q3 Report' },
        ],
        funding: [],
      },
    }), { status: 200 }))

    await handleInfo('AAPL', chatId, 'en')

    expect(mockFetch).toHaveBeenCalled()
    expect(mockSendGenericMessage).toHaveBeenCalled()
    
    const sentMessage = mockSendGenericMessage.mock.calls[0][0]
    expect(sentMessage).toContain('AAPL')
    expect(sentMessage).toContain('Apple Inc.')
    expect(sentMessage).toContain('$150.00')
    expect(sentMessage).toContain('Technology')
    expect(sentMessage).toContain('ACTIVE CATALYSTS')
  })

  test('handleInfo with invalid ticker', async () => {
    const chatId = randomUUID()
    await db.insert(settings).values({ telegramChatId: chatId, quantourApiKey: 'test-key-123' })
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      success: false,
      error: 'Ticker not found',
    }), { status: 404 }))
    
    await handleInfo('INVALID', chatId, 'en')
    
    expect(mockSendGenericMessage).toHaveBeenCalled()
    const sentMessage = mockSendGenericMessage.mock.calls[0][0]
    expect(sentMessage).toContain('Cannot find ticker')
  })

  test('estimateSlotSize: 5% of configured capital, $250 floor', () => {
    expect(estimateSlotSize('50000')).toBe(2500)
    expect(estimateSlotSize('100000')).toBe(5000)
    // Floor enforced for small / sub-floor accounts
    expect(estimateSlotSize('1000')).toBe(250)
    expect(estimateSlotSize('0')).toBe(250)
    // Non-numeric / empty falls back to the floor
    expect(estimateSlotSize('')).toBe(250)
    expect(estimateSlotSize('garbage')).toBe(250)
  })
})
