import {
  afterAll, beforeEach, describe, expect, mock, test,
} from 'bun:test'
import { randomUUID } from 'crypto'
import { eq } from 'drizzle-orm'

import { db } from '~/db'
import {
  portfolioStats, settings, userBudgets,
} from '~/db/clientSchema'

import {
  handleMode,
  handleRiskGuide,
  handleRiskProfileMenu,
  handleSetBudget,
  handleSetCapital,
  handleSetName,
  handleSetRisk,
  handleSetRiskProfile,
  handleSetSilent,
  handleStrategyMenu,
} from './settingsHandlers'

const mockSendGenericMessage = mock()
const mockSendRawTelegram = mock()

// Order-proofing: capture the CURRENT module surface and spread it below —
// mock.module is process-global and never restored between bun test files,
// so a partial export set starves later importers in shuffled orders.
const realTelegramService = await import('~/services/telegramService')
mock.module('~/services/telegramService', () => ({
  ...realTelegramService,
  sendGenericMessage: mockSendGenericMessage,
  sendRawTelegram: mockSendRawTelegram,
}))

describe('settingsHandlers', () => {
  beforeEach(async () => {
    mockSendGenericMessage.mockClear()
    mockSendRawTelegram.mockClear()
  })

  test('handleSetName updates name and sends localized message', async () => {
    const chatId = randomUUID()
    await db.insert(settings).values({ telegramChatId: chatId })

    await handleSetName(chatId, 'Alex', 'en')
    expect(mockSendGenericMessage).toHaveBeenCalledWith('✅ Nice to meet you, <b>Alex</b>! Your name has been registered.',
      undefined,
      chatId)

    await handleSetName(chatId, 'Олексій', 'ua')
    expect(mockSendGenericMessage).toHaveBeenCalledWith('✅ Приємно познайомитися, <b>Олексій</b>! Ваше ім’я зареєстровано.',
      undefined,
      chatId)
  })

  test('handleSetCapital validates amount and updates capital', async () => {
    const chatId = randomUUID()

    await handleSetCapital(chatId, -100, 'en')
    expect(mockSendGenericMessage).toHaveBeenCalledWith('⚠️ Please provide a valid positive number.', undefined, chatId)

    mockSendGenericMessage.mockClear()
    await handleSetCapital(chatId, 50000, 'en')
    expect(mockSendGenericMessage).toHaveBeenCalledWith('✅ Your total trading capital has been updated to <b>$50,000</b>.',
      undefined,
      chatId)
  })

  test('handleSetRisk handles auto, fixed USD, percentage, and invalid inputs', async () => {
    const chatId = randomUUID()
    await db.insert(settings).values({ telegramChatId: chatId })

    await handleSetRisk(chatId, 'invalid', 'en')
    expect(mockSendGenericMessage).toHaveBeenCalledWith('⚠️ Please provide a valid positive number.', undefined, chatId)

    mockSendGenericMessage.mockClear()
    await handleSetRisk(chatId, 0, 'en')
    expect(mockSendGenericMessage).toHaveBeenNthCalledWith(
      1, 'Risk set to <b>Auto (1% of capital)</b>.', undefined, chatId,
    )

    mockSendGenericMessage.mockClear()
    await handleSetRisk(chatId, '3%', 'en')
    expect(mockSendGenericMessage).toHaveBeenNthCalledWith(
      1,
      '✅ Risk per trade set to <b>3%</b> ($900 USD with your current budget of $30,000 USD).',
      undefined,
      chatId,
    )

    mockSendGenericMessage.mockClear()
    await handleSetRisk(chatId, '500', 'ua')
    expect(mockSendGenericMessage).toHaveBeenNthCalledWith(
      1,
      '✅ Ризик на угоду встановлено на <b>$500</b> USD (~1.67% від вашого поточного бюджету $30,000 USD).',
      undefined,
      chatId,
    )
  })

  test('handleSetBudget toggles budget filtering mode', async () => {
    const chatId = randomUUID()

    await handleSetBudget(chatId, true, 'en')
    expect(mockSendGenericMessage).toHaveBeenCalledWith('✅ <b>Budget-Aware mode ON</b>. You will only see signals you can afford or high-conviction replacements.',
      undefined,
      chatId)

    mockSendGenericMessage.mockClear()
    await handleSetBudget(chatId, false, 'ua')
    expect(mockSendGenericMessage).toHaveBeenCalledWith('ℹ️ <b>Режим врахування бюджету ВИМКНЕНО</b>. Ви отримуватимете всі ринкові сигнали.',
      undefined,
      chatId)
  })

  test('handleMode toggles signal mode', async () => {
    const chatId = randomUUID()
    await db.insert(settings).values({ telegramChatId: chatId, signalMode: 'all' })

    await handleMode(chatId, 'en')
    expect(mockSendGenericMessage).toHaveBeenCalledWith('✅ Signal mode updated to <b>SILENT</b>.', undefined, chatId)

    const updated = (await db.select().from(settings).where(eq(settings.telegramChatId, chatId)))[0]
    expect(updated.signalMode).toBe('silent')
  })

  test('handleSetSilent updates silent mode on/off with explanation', async () => {
    const chatId = randomUUID()
    await db.insert(settings).values({ telegramChatId: chatId, signalMode: 'all' })

    await handleSetSilent(chatId, 'on', 'en')
    expect(mockSendGenericMessage).toHaveBeenCalledWith('🔕 <b>Silent Mode ENABLED</b>. New setup signals are muted. We will only message you when action is required (e.g. Stop Loss alerts, Portfolio Rotations / Optimize).',
      undefined,
      chatId)

    mockSendGenericMessage.mockClear()
    await handleSetSilent(chatId, 'off', 'ua')
    expect(mockSendGenericMessage).toHaveBeenCalledWith('🔔 <b>Тихий режим ВИМКНЕНО</b>. Ви отримуватимете всі ринкові сигнали в реальному часі.',
      undefined,
      chatId)
  })

  test('handleStrategyMenu sends strategy builder notice', async () => {
    const chatId = randomUUID()
    await handleStrategyMenu(chatId, 'en')
    expect(mockSendGenericMessage).toHaveBeenCalledWith(expect.stringContaining('PORTFOLIO STRATEGY SETTINGS'),
      undefined,
      chatId)
  })

  test('handleRiskProfileMenu formats localized menu text', async () => {
    const chatId = randomUUID()
    await db.insert(settings).values({ telegramChatId: chatId, riskProfile: 'BALANCED' })

    await handleRiskProfileMenu(chatId, 'ua')
    expect(mockSendRawTelegram).toHaveBeenCalledWith('sendMessage', expect.objectContaining({
      chat_id: chatId,
      text: expect.stringContaining('Налаштування Ризику'),
    }))

    mockSendRawTelegram.mockClear()
    await handleRiskProfileMenu(chatId, 'en')
    expect(mockSendRawTelegram).toHaveBeenCalledWith('sendMessage', expect.objectContaining({
      chat_id: chatId,
      text: expect.stringContaining('Risk Settings'),
    }))
  })

  test('handleSetRiskProfile updates profile in DB', async () => {
    const chatId = randomUUID()
    await db.insert(settings).values({ telegramChatId: chatId, riskProfile: 'BALANCED' })

    await handleSetRiskProfile(chatId, 'AGGRESSIVE', 'en')
    expect(mockSendGenericMessage).toHaveBeenCalledWith('✅ <b>Risk Profile updated to AGGRESSIVE!</b>', undefined, chatId)

    const updated = (await db.select().from(settings).where(eq(settings.telegramChatId, chatId)))[0]
    expect(updated.riskProfile).toBe('AGGRESSIVE')
  })

  test('handleRiskGuide sends localized guide', async () => {
    const chatId = randomUUID()
    await handleRiskGuide(chatId, 'ua')
    expect(mockSendGenericMessage).toHaveBeenCalledWith(expect.stringContaining('ГАЙД З УПРАВЛІННЯ РИЗИКАМИ ТА РОЗПОДІЛУ'),
      undefined,
      chatId)
  })

  // -- Budget canonical storage (user_budgets is the source of truth) --------
  test('handleSetCapital writes user_budgets + portfolioStats (settings has no budget columns)', async () => {
    const chatId = randomUUID()
    const userId = randomUUID()
    await db.insert(settings).values({ telegramChatId: chatId, userId })

    await handleSetCapital(chatId, 50000, 'en')

    const budget = (await db.select().from(userBudgets).where(eq(userBudgets.userId, userId)))[0]
    expect(budget?.totalCapital).toBe('50000')

    const stats = (await db.select().from(portfolioStats).where(eq(portfolioStats.chatId, chatId)))[0]
    expect(stats?.currentCapital).toBe('50000')

    // The settings row exists but carries NO budget columns (dropped in
    // Cleanup B) — nothing stale to write.
    const row = (await db.select().from(settings).where(eq(settings.telegramChatId, chatId)))[0]
    expect(row).toBeDefined()
    expect('totalCapital' in row).toBe(false)
  })

  test('handleSetRisk persists raw percent to user_budgets (settings has no budget columns)', async () => {
    const chatId = randomUUID()
    const userId = randomUUID()
    await db.insert(settings).values({ telegramChatId: chatId, userId })

    await handleSetRisk(chatId, '3%', 'en')

    const budget = (await db.select().from(userBudgets).where(eq(userBudgets.userId, userId)))[0]
    expect(budget?.maxRiskPerTrade).toBe('3%')

    const row = (await db.select().from(settings).where(eq(settings.telegramChatId, chatId)))[0]
    expect(row).toBeDefined()
    expect('maxRiskPerTrade' in row).toBe(false)
  })

  test('handleRiskProfileMenu surfaces the risk value from user_budgets (percent and fixed $)', async () => {
    const chatId = randomUUID()
    const userId = randomUUID()
    await db.insert(settings).values({ telegramChatId: chatId, userId, riskProfile: 'BALANCED' })
    await db.insert(userBudgets).values({ userId, totalCapital: '60000', maxRiskPerTrade: '2%' })

    await handleRiskProfileMenu(chatId, 'en')
    expect(mockSendRawTelegram).toHaveBeenCalledWith('sendMessage', expect.objectContaining({
      chat_id: chatId,
      text: expect.stringContaining('2%'),
    }))

    mockSendRawTelegram.mockClear()
    await db.update(userBudgets).set({ maxRiskPerTrade: '750' }).where(eq(userBudgets.userId, userId))
    await handleRiskProfileMenu(chatId, 'en')
    expect(mockSendRawTelegram).toHaveBeenCalledWith('sendMessage', expect.objectContaining({
      chat_id: chatId,
      text: expect.stringContaining('$750'),
    }))
  })
})

// Restore module mocks so the telegramService mock does not leak into later files.
afterAll(() => {
  mock.restore()
})
