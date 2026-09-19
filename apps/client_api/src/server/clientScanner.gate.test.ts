import {
  afterAll, beforeEach, describe, expect, mock, test,
} from 'bun:test'

import { db } from '~/db'
import {
  accountEvents, settings,
} from '~/db/clientSchema'

// ---------------------------------------------------------------------------
// Module mocks — MUST be registered before the scanner is first imported
// (clientScanner is imported dynamically inside each test below).
//
// MOCK DISCIPLINE: `mock.module` is process-wide in bun:test and leaks into
// later test files in the same process. We only mock:
//  1. ~/services/telegramService — the established convention; every other
//     test file re-registers its own, so a leaked mock is overwritten.
//  2. marketHours — spread the REAL module and override only isMarketOpen,
//     so a leak into cronJobs/queueService/portfolioHandlers still exposes
//     isMarketDay & friends with real behavior.
// We deliberately do NOT mock ~/db (the real file-based DB is used with
// per-test cleanup, like exitManager.test.ts) nor the screener (a real
// minimal AST with currentPrice > 0 fires on any metrics row).
// ---------------------------------------------------------------------------

const mockSendGenericMessage = mock((...args: unknown[]) => {
  void args
  return Promise.resolve(1)
})
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

// Load the real module BEFORE registering the mock — a factory that imports
// the same path would resolve to the (already-registered) mock, not the real
// module, and the spread would silently drop every export but isMarketOpen.
const realMarketHours = await import('@quantour/shared-algo/src/core/marketHours')
mock.module('@quantour/shared-algo/src/core/marketHours', () => ({
  ...realMarketHours,
  isMarketOpen: () => true,
}))

// ---------------------------------------------------------------------------
// Fetch mock — routes /api/v1/metrics per-test via `metricsStatus`.
// ---------------------------------------------------------------------------

let metricsStatus = 200
const mockFetch = mock(async (input: string | URL | Request, _init?: RequestInit) => {
  const url = String(input)
  if (url.includes('/api/v1/metrics')) {
    if (metricsStatus === 401) return new Response('Unauthorized', { status: 401 })
    return new Response(JSON.stringify({
      data: [
        METRICS_ROW,
      ],
    }), { status: 200 })
  }
  return new Response('{}', { status: 200 })
})
const originalFetch = globalThis.fetch

/**
 * Minimal real AST. currentPrice > 0 fires on any metrics row — no screener
 * mocking needed. `atr` is provided explicitly: the availability-first pass
 * removed the price*0.02 ATR fabrication (setups without a REAL ATR halt),
 * so fixtures must carry one for risk sizing (stop 2×ATR, target 3×ATR).
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
  maxTotalSignals: 8,
  maxSignalsPerRiskProfile: 3,
  signalAggressiveness: 0.5,
})

const METRICS_ROW = { ticker: 'AAPL', price: 200, atr: 4 }

function sendsTo(chatId: string): unknown[] {
  return mockSendGenericMessage.mock.calls.filter(c => c[2] === chatId).map(c => c[0])
}

beforeEach(async () => {
  globalThis.fetch = mockFetch as unknown as typeof fetch
  metricsStatus = 200
  mockSendGenericMessage.mockClear()
  mockFetch.mockClear()
  await db.delete(settings)
  await db.delete(accountEvents)
})

afterAll(async () => {
  await db.delete(settings)
  await db.delete(accountEvents)
  globalThis.fetch = originalFetch
  mock.restore()
})

describe('runMasterScanner — per-chat API-key hard gate (integration)', () => {
  test('authorized chat with its own valid key receives the signal broadcast', async () => {
    const { runMasterScanner } = await import('~/server/clientScanner')
    await db.insert(settings).values({
      telegramChatId: 'chat_ok', quantourApiKey: 'K_GOOD', status: 'approved', mainStrategyAst: MINIMAL_AST,
    })

    await runMasterScanner({ isManual: false })

    const msgs = sendsTo('chat_ok')
    // Broadcast fired (not the "please link" notice).
    expect(msgs.length).toBeGreaterThan(0)
    expect(msgs.some(m => String(m).includes('Skipping signal scan'))).toBe(false)
    // Metrics were fetched with THIS chat's own key.
    const metricsCalls = mockFetch.mock.calls.filter(c => String(c[0]).includes('/api/v1/metrics'))
    expect(metricsCalls.length).toBe(1)
    const auth = (metricsCalls[0]?.[1]?.headers as Record<string, string> | undefined)?.Authorization
    expect(auth).toBe('Bearer K_GOOD')
  })

  test('unlinked chat is skipped even when a sibling chat has a valid key (cross-user leak fix)', async () => {
    const { runMasterScanner } = await import('~/server/clientScanner')
    // Both chats have a strategy AST — under the OLD code the unlinked chat
    // would have been evaluated + broadcast to, using the sibling's key.
    await db.insert(settings).values({
      telegramChatId: 'chat_unlinked', quantourApiKey: null, status: 'pending', mainStrategyAst: MINIMAL_AST,
    })
    await db.insert(settings).values({
      telegramChatId: 'chat_linked', quantourApiKey: 'K_GOOD', status: 'approved', mainStrategyAst: MINIMAL_AST,
    })

    await runMasterScanner({ isManual: false })

    // Unlinked chat: EXACTLY one message — the "please link" notice.
    const unlinkedMsgs = sendsTo('chat_unlinked')
    expect(unlinkedMsgs.length).toBe(1)
    expect(String(unlinkedMsgs[0])).toContain('Skipping signal scan')
    // Linked chat: got the broadcast, never the notice.
    const linkedMsgs = sendsTo('chat_linked')
    expect(linkedMsgs.some(m => String(m).includes('Skipping signal scan'))).toBe(false)
    // Metrics fetched with the AUTHORIZED chat's key (never a null key).
    const auth = (mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined)?.Authorization
    expect(auth).toBe('Bearer K_GOOD')
  })

  test('metrics 401 quarantines chats sharing the fetching key and records audit events', async () => {
    const { runMasterScanner } = await import('~/server/clientScanner')
    await db.insert(settings).values({
      telegramChatId: 'chat_a', quantourApiKey: 'K_REVOKED', status: 'approved', mainStrategyAst: MINIMAL_AST,
    })
    await db.insert(settings).values({
      telegramChatId: 'chat_b', quantourApiKey: 'K_REVOKED', status: 'approved', mainStrategyAst: MINIMAL_AST,
    })
    metricsStatus = 401

    await runMasterScanner({ isManual: false })

    // Both chats flipped approved → pending.
    const rows = await db.select().from(settings)
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.status === 'pending')).toBe(true)
    // One "key expired" notice per chat.
    expect(sendsTo('chat_a')).toHaveLength(1)
    expect(sendsTo('chat_b')).toHaveLength(1)
    // Audit trail records the approved→pending transition once per chat,
    // with a key hash (never the full key).
    const events = await db.select().from(accountEvents)
    const quarantines = events.filter(e => e.eventType === 'key_quarantined')
    expect(quarantines).toHaveLength(2)
    expect(quarantines.every(e => e.keyHash === 'EVOKED')).toBe(true)
  })

  test('notice throttle persists across scanner runs via account_events (no repeat after restart)', async () => {
    const { runMasterScanner } = await import('~/server/clientScanner')
    await db.insert(settings).values({
      telegramChatId: 'chat_unlinked', quantourApiKey: null, status: 'pending', mainStrategyAst: MINIMAL_AST,
    })

    // Two cron cycles back-to-back: the second must be suppressed by the
    // DB-backed throttle (previously the in-memory Map survived between
    // runs in one process but NOT across restarts — the table survives both).
    await runMasterScanner({ isManual: false })
    await runMasterScanner({ isManual: false })

    expect(sendsTo('chat_unlinked')).toHaveLength(1)
    // The notice event was persisted for the audit trail.
    const events = await db.select().from(accountEvents)
    expect(events.filter(e => e.eventType === 'notice:no_key')).toHaveLength(1)
  })
})
