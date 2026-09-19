import {
  afterAll, beforeEach, describe, expect, mock, test,
} from 'bun:test'
import { randomUUID } from 'crypto'

import { db } from '~/db'
import {
  settings, trades,
} from '~/db/clientSchema'

// Mock telegramService — captures sendGenericMessage calls
const mockSendGenericMessage = mock((..._args: unknown[]): Promise<number | undefined> => Promise.resolve(1))
// Order-proofing: capture the CURRENT module surface and spread it below —
// mock.module is process-global and never restored between bun test files,
// so a partial export set starves later importers in shuffled orders.
const realTelegramService = await import('~/services/telegramService')
mock.module('~/services/telegramService', () => ({
  ...realTelegramService,
  sendGenericMessage: mockSendGenericMessage,
  sendRawTelegram: mock(() => Promise.resolve({ ok: true })),
  getChatLanguage: mock((..._args: unknown[]): Promise<string> => Promise.resolve('en')),
}))

// Mock global fetch for metrics call
const twoDaysAhead = new Date(Date.now() + 2 * 86400000).toISOString()
const originalFetch = globalThis.fetch
const mockFetch = mock((url: unknown): Promise<Response> => {
  const urlStr = String(url)
  if (urlStr.includes('/metrics')) {
    return Promise.resolve(new Response(JSON.stringify([
      { ticker: 'CATTEST', nextEarnings: twoDaysAhead },
    ])))
  }
  return Promise.resolve(new Response(JSON.stringify([])))
})

describe('catalystChecker', () => {
  beforeEach(async () => {
    globalThis.fetch = mockFetch as unknown as typeof fetch
    mockSendGenericMessage.mockClear()
    mockFetch.mockClear()
    await db.delete(trades)
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
  })

  test('sends notification when a held position has earnings within 3 days', async () => {
    const { checkPositionCatalysts } = await import('~/server/catalystChecker')
    const chatId = randomUUID()

    await db.insert(settings).values({
      telegramChatId: chatId,
      quantourApiKey: 'test-key-catalyst',
    })

    await db.insert(trades).values({
      chatId,
      ticker: 'CATTEST',
      entry: '100',
      stopLoss: '95',
      target: '115',
      capitalDeployed: '1000',
      riskPerShare: '5',
      riskAmountUsd: '50',
    })

    await checkPositionCatalysts()

    expect(mockSendGenericMessage).toHaveBeenCalled()
    const msg = String(mockSendGenericMessage.mock.calls[0][0])
    expect(msg).toContain('CATTEST')
    expect(msg).toContain('Earnings')
  })

  test('does not send notification when no positions held', async () => {
    const { checkPositionCatalysts } = await import('~/server/catalystChecker')

    // No trades inserted for this chatId
    mockSendGenericMessage.mockClear()
    await checkPositionCatalysts()

    // With no positions, no fetch or notification should happen
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

// Restore module mocks so the telegramService mock does not leak into later files.
afterAll(() => {
  mock.restore()
})
