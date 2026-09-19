import {
  beforeEach, describe, expect, mock, test,
} from 'bun:test'
import { eq } from 'drizzle-orm'

import { handlePnl } from './pnlHandlers'

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

import { db } from '~/db'
import {
  settings, tradeAuditLog,
} from '~/db/clientSchema'

const PNL_TEST_CHAT = 'pnl-test-chat'
const PNL_TEST_KEY = 'pnl-test-key'

beforeEach(async () => {
  mockSendGenericMessage.mockClear()
  await db.delete(tradeAuditLog).where(eq(tradeAuditLog.chatId, PNL_TEST_CHAT))
  await db.delete(settings).where(eq(settings.telegramChatId, PNL_TEST_CHAT))
})

async function seedAuditRows(rows: Array<{ ticker: string; pnlUsd: string; pnlPercent: string; exitReason: string; exitDate: Date }>) {
  for (const r of rows) {
    await db.insert(tradeAuditLog).values({
      chatId: PNL_TEST_CHAT,
      userId: PNL_TEST_CHAT,
      ticker: r.ticker,
      entryPrice: '100',
      exitPrice: '110',
      pnlUsd: r.pnlUsd,
      pnlPercent: r.pnlPercent,
      exitReason: r.exitReason,
      strategyName: 'TEST',
      entryDate: new Date(Date.now() - 30 * 86400000),
      exitDate: r.exitDate,
    })
  }
}

describe('handlePnl', () => {
  test('shows overall PnL, best, worst, and trade count for MTD', async () => {
    await db.insert(settings).values({
      telegramChatId: PNL_TEST_CHAT,
      quantourApiKey: PNL_TEST_KEY,
      userId: PNL_TEST_CHAT,
    })

    const now = new Date()
    await seedAuditRows([
      {
        ticker: 'NVDA', pnlUsd: '500', pnlPercent: '10', exitReason: 'TARGET_HIT', exitDate: new Date(now.getFullYear(), now.getMonth(), 5), 
      },
      {
        ticker: 'TSLA', pnlUsd: '-200', pnlPercent: '-5', exitReason: 'STOP_LOSS_HIT', exitDate: new Date(now.getFullYear(), now.getMonth(), 8), 
      },
      {
        ticker: 'AAPL', pnlUsd: '300', pnlPercent: '6', exitReason: 'TIME_STOP', exitDate: new Date(now.getFullYear(), now.getMonth(), 10), 
      },
    ])

    await handlePnl(PNL_TEST_CHAT, 'en', 'mtd')

    expect(mockSendGenericMessage).toHaveBeenCalledTimes(1)
    const msg = String(mockSendGenericMessage.mock.calls[0][0])

    expect(msg).toContain('PnL Report')
    expect(msg).toContain('Month-to-Date')
    // Overall = 500 - 200 + 300 = 600
    expect(msg).toContain('+$600.00')
    // 3 trades, 2 wins, 1 loss
    expect(msg).toContain('3 (')
    expect(msg).toContain('2 ')
    expect(msg).toContain('1 ')
    // Best = NVDA +500
    expect(msg).toContain('NVDA')
    expect(msg).toContain('+$500.00')
    // Worst = TSLA -200
    expect(msg).toContain('TSLA')
    expect(msg).toContain('$-200.00')
  })

  test('WTD excludes trades from earlier in the month', async () => {
    await db.insert(settings).values({
      telegramChatId: PNL_TEST_CHAT,
      quantourApiKey: PNL_TEST_KEY,
      userId: PNL_TEST_CHAT,
    })

    const now = new Date()
    const day = now.getDay()
    const monday = new Date(now)
    monday.setDate(now.getDate() - ((day + 6) % 7))
    monday.setHours(
      0, 0, 0, 0,
    )

    // One trade BEFORE this week (should be excluded from WTD)
    const beforeWeek = new Date(monday.getTime() - 3 * 86400000)
    // One trade DURING this week (should be included)
    const duringWeek = new Date(monday.getTime() + 86400000)

    await seedAuditRows([
      {
        ticker: 'OLD', pnlUsd: '999', pnlPercent: '50', exitReason: 'TIME_STOP', exitDate: beforeWeek, 
      },
      {
        ticker: 'NEW', pnlUsd: '100', pnlPercent: '5', exitReason: 'TARGET_HIT', exitDate: duringWeek, 
      },
    ])

    await handlePnl(PNL_TEST_CHAT, 'en', 'wtd')

    const msg = String(mockSendGenericMessage.mock.calls[0][0])
    expect(msg).toContain('Week-to-Date')
    // Overall = 100 (OLD excluded)
    expect(msg).toContain('+$100.00')
    expect(msg).toContain('NEW')
    expect(msg).not.toContain('OLD')
    expect(msg).not.toContain('999')
  })

  test('empty state when no closed trades in period', async () => {
    await db.insert(settings).values({
      telegramChatId: PNL_TEST_CHAT,
      quantourApiKey: PNL_TEST_KEY,
      userId: PNL_TEST_CHAT,
    })

    await handlePnl(PNL_TEST_CHAT, 'en', 'mtd')

    expect(mockSendGenericMessage).toHaveBeenCalledTimes(1)
    const msg = String(mockSendGenericMessage.mock.calls[0][0])
    expect(msg).toContain('No closed trades')
  })

  test('default timeframe is MTD when none specified', async () => {
    await db.insert(settings).values({
      telegramChatId: PNL_TEST_CHAT,
      quantourApiKey: PNL_TEST_KEY,
      userId: PNL_TEST_CHAT,
    })

    await seedAuditRows([
      {
        ticker: 'MSFT', pnlUsd: '50', pnlPercent: '2', exitReason: 'MANUAL', exitDate: new Date(), 
      },
    ])

    await handlePnl(PNL_TEST_CHAT, 'en')

    const msg = String(mockSendGenericMessage.mock.calls[0][0])
    expect(msg).toContain('Month-to-Date')
  })
})
