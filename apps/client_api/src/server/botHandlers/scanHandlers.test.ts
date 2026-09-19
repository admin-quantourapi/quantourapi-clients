import {
  afterAll, beforeEach, describe, expect, mock, test, 
} from 'bun:test'

import {
  handleAddScan, handleListScan, handleRemoveScan, 
} from './scanHandlers'

// Mock dependencies
const mockSendGenericMessage = mock()

// Order-proofing: capture the CURRENT module surface and spread it below —
// mock.module is process-global and never restored between bun test files,
// so a partial export set starves later importers in shuffled orders.
const realTelegramService = await import('~/services/telegramService')
mock.module('~/services/telegramService', () => ({
  ...realTelegramService,
  sendGenericMessage: mockSendGenericMessage,
  sendRawTelegram: mock(() => Promise.resolve({ ok: true })),
}))

import { randomUUID } from 'crypto'
import { eq } from 'drizzle-orm'

import { db } from '~/db'
import { portfolioItems, settings } from '~/db/clientSchema'

// fetchFromApi 401s ("No API key configured") unless a settings row carries a
// quantourApiKey — other test files seed one as a side effect, making these
// tests order-dependent (passing in full local runs, failing standalone and
// on CI's file order). Seed our own per-chat key so the file is hermetic.
const TEST_API_KEY = 'scan-handlers-test-key'

async function seedChatApiKey(chatId: string): Promise<void> {
  await db.insert(settings).values({ telegramChatId: chatId, quantourApiKey: TEST_API_KEY })
}

// Mock global fetch for API calls inside scanHandlers
const originalFetch = globalThis.fetch
const mockFetch = mock((url: unknown) => {
  const urlStr = String(url)
  if (urlStr.includes('/market/quote/PENY') || urlStr.includes('/fmp/quote/PENY')) {
    return Promise.resolve(new Response(JSON.stringify({
      symbol: 'PENY', price: 2.0, marketCap: 500000000, avgVolume: 100000,
    })))
  }
  if (urlStr.includes('/market/quote/AAPL') || urlStr.includes('/fmp/quote/AAPL')) {
    return Promise.resolve(new Response(JSON.stringify({
      symbol: 'AAPL', name: 'Apple Inc.', price: 150.0, marketCap: 2500000000000, avgVolume: 50000000,
    })))
  }
  return Promise.resolve(new Response(JSON.stringify(null), { status: 404 }))
})

describe('scanHandlers', () => {
  beforeEach(async () => {
    globalThis.fetch = mockFetch as unknown as typeof fetch
    mockSendGenericMessage.mockClear()
    await db.delete(portfolioItems)
    await db.delete(settings).where(eq(settings.quantourApiKey, TEST_API_KEY))
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
  })

  test('handleAddScan fails on invalid ticker', async () => {
    const chatId = randomUUID()
    await seedChatApiKey(chatId)
    await handleAddScan('INVALID', chatId, 'en')
    expect(mockSendGenericMessage).toHaveBeenCalled()
    expect(mockSendGenericMessage.mock.calls[0][0]).toContain('Cannot find ticker <b>INVALID</b>')
  })

  test('handleAddScan rejects penny stocks', async () => {
    const chatId = randomUUID()
    await seedChatApiKey(chatId)
    await handleAddScan('PENY', chatId, 'en')
    expect(mockSendGenericMessage).toHaveBeenCalled()
    expect(mockSendGenericMessage.mock.calls[0][0]).toContain('Rejected: PENY')
    expect(mockSendGenericMessage.mock.calls[0][0]).toContain('This stock does not meet institutional quality requirements')
  })

  test('handleAddScan adds valid stock', async () => {
    const chatId = randomUUID()
    await seedChatApiKey(chatId)
    await handleAddScan('AAPL', chatId, 'en')

    const items = await db.select().from(portfolioItems)
    const ourItem = items.find(i => i.ticker === 'AAPL' && i.portfolioId === 1)
    expect(ourItem).toBeDefined()
    expect(ourItem!.ticker).toBe('AAPL')
    expect(mockSendGenericMessage).toHaveBeenCalled()
    expect(mockSendGenericMessage.mock.calls[0][0]).toContain('Successfully added <b>AAPL</b> (Apple Inc.) to scan list')
  })

  test('handleListScan shows empty message', async () => {
    const chatId = randomUUID()
    await handleListScan(chatId, 'en')
    
    expect(mockSendGenericMessage).toHaveBeenCalled()
    expect(mockSendGenericMessage.mock.calls[0][0]).toContain('No stocks are currently being scanned')
  })

  test('handleListScan shows active scans', async () => {
    const chatId = randomUUID()
    await db.insert(portfolioItems).values([
      { portfolioId: 1, ticker: 'AAPL' },
      { portfolioId: 1, ticker: 'MSFT' },
    ])
    
    await handleListScan(chatId, 'en')
    
    expect(mockSendGenericMessage).toHaveBeenCalled()
    const msg = mockSendGenericMessage.mock.calls[0][0]
    expect(msg).toContain('AAPL')
    expect(msg).toContain('MSFT')
  })

  test('handleRemoveScan removes existing scan', async () => {
    const chatId = randomUUID()
    await db.insert(portfolioItems).values([
      { portfolioId: 1, ticker: 'AAPL' },
    ])
    
    await handleRemoveScan('AAPL', chatId, 'en')
    
    const items = await db.select().from(portfolioItems).where(eq(portfolioItems.portfolioId, 1))
    const ourItem = items.find(i => i.ticker === 'AAPL')
    expect(ourItem).toBeUndefined()

    expect(mockSendGenericMessage).toHaveBeenCalled()
    expect(mockSendGenericMessage.mock.calls[0][0]).toContain('Successfully removed <b>AAPL</b>')
  })
})
