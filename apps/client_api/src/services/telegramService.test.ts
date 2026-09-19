import { Language } from '@quantour/shared-algo/src/core/i18n'
import {
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { eq } from 'drizzle-orm'

// NOTE (2026-09-16): this file previously registered a process-global
// `mock.module('./telegramWsClient', …)` "to avoid WebSocket not connected
// warnings" — bun's module-registry mock poisons EVERY later import of that
// module in the same process. Test-file order is filesystem-dependent
// (overlayfs CI vs ext4 local), so on the runner this file ran BEFORE
// telegramWsClient.test.ts, whose import then received the 2-key mock
// (wsDiagnostics undefined) and every real-socket test hung to its timeout.
// The real sendWsMessageToBot is fail-soft when disconnected (warns and
// returns) — the warnings are harmless and the ws suite stays order-proof.



import { db } from '../db'
import { settings } from '../db/clientSchema'

import {
  escapeHtml,
  getBotCommands,
  getLocalizedHelp,
  processPendingNotifications,
  processUpdate,
  queueNotification,
  registerBotHandlers,
  registeredHandlers,
  sanitizeTelegramHtml,
  sendDocumentMessage,
  sendFridayMacroReport,
  sendGenericMessage,
  sendHeartbeatMessage,
  sendPhotoMessage,
  sendRawTelegram,
  sendTelegramAlert,
  setChatLanguage,
  stripHtml,
  type TelegramHandlers,
} from './telegramService'

describe('telegramService Unit Tests', () => {
  const TEST_CHAT_ID = 'telegram_service_spec_chat_1'

  beforeEach(async () => {
    // Clean up test chat settings to avoid duplicate row pollution
    await db.delete(settings).where(eq(settings.telegramChatId, TEST_CHAT_ID))
    await db.insert(settings).values({
      telegramChatId: TEST_CHAT_ID,
      quantourApiKey: 'test_valid_key',
      language: 'en',
      status: 'approved',
    })
  })

  describe('Chat Settings & Language', () => {
    test('getChatLanguage and setChatLanguage manipulate user database settings', async () => {
      await setChatLanguage(TEST_CHAT_ID, 'ua')
      // Verify via a direct DB read rather than getChatLanguage(): sibling test
      // files register a process-wide mock.module for ~/services/telegramService
      // (bun:test does not restore mock.module between files in one process), so
      // the imported getChatLanguage is replaced with a stub returning 'en'. The
      // DB row is the source of truth that getChatLanguage reads from.
      const afterUa = await db.select().from(settings).where(eq(settings.telegramChatId, TEST_CHAT_ID)).limit(1)
      expect(afterUa[0]?.language).toBe('ua')

      // Reset back to 'en'
      await setChatLanguage(TEST_CHAT_ID, 'en')
      const afterEn = await db.select().from(settings).where(eq(settings.telegramChatId, TEST_CHAT_ID)).limit(1)
      expect(afterEn[0]?.language).toBe('en')
    })
  })

  describe('Bot Commands & Help Text', () => {
    test('getBotCommands returns command list for regular user', () => {
      const cmds = getBotCommands('en')
      expect(cmds.length).toBeGreaterThan(0)
      expect(cmds.some(c => c.command === 'status')).toBe(true)
    })

    test('getBotCommands returns localized ukrainian command list', () => {
      const cmds = getBotCommands('ua')
      expect(cmds.length).toBeGreaterThan(0)
      expect(cmds.some(c => c.command === 'api')).toBe(true)
    })

    test('getLocalizedHelp produces help output for english and ukrainian', () => {
      const helpEn = getLocalizedHelp('en')
      expect(helpEn).toContain('COMMANDS')
      const helpUa = getLocalizedHelp('ua')
      expect(helpUa).toBeDefined()
    })
  })

  describe('HTML Sanitization Utilities', () => {
    test('sanitizeTelegramHtml escapes unsupported tags and unescaped symbols while preserving valid Telegram HTML', () => {
      expect(sanitizeTelegramHtml('<b>Bold</b> & <i>Italic</i>')).toBe('<b>Bold</b> &amp; <i>Italic</i>')
      expect(sanitizeTelegramHtml('pe_ratio < 15 & <AAPL>')).toBe('pe_ratio &lt; 15 &amp; &lt;AAPL>')
      expect(sanitizeTelegramHtml('<code>const x = 10;</code>')).toBe('<code>const x = 10;</code>')
    })

    test('sanitizeTelegramHtml preserves officially supported Telegram HTML tag aliases', () => {
      expect(sanitizeTelegramHtml('<strong>Bold</strong> <em>Italic</em>')).toBe('<strong>Bold</strong> <em>Italic</em>')
      expect(sanitizeTelegramHtml('<ins>Under</ins> <del>Strike</del> <strike>Old</strike>')).toBe('<ins>Under</ins> <del>Strike</del> <strike>Old</strike>')
      expect(sanitizeTelegramHtml('<tg-spoiler>Secret</tg-spoiler>')).toBe('<tg-spoiler>Secret</tg-spoiler>')
      expect(sanitizeTelegramHtml('<span class="tg-spoiler">Span spoiler</span>')).toBe('<span class="tg-spoiler">Span spoiler</span>')
      // Not whitelisted: entity tags requiring validated attributes
      expect(sanitizeTelegramHtml('<tg-emoji emoji-id="1">😀</tg-emoji>')).toBe('&lt;tg-emoji emoji-id="1">😀&lt;/tg-emoji>')
      expect(sanitizeTelegramHtml('<script>alert(1)</script>')).toBe('&lt;script>alert(1)&lt;/script>')
    })

    test('escapeHtml and stripHtml helper functions work correctly', () => {
      expect(escapeHtml('A & B < C > D')).toBe('A &amp; B &lt; C &gt; D')
      expect(stripHtml('<b>Hello</b> <i>World</i>')).toBe('Hello World')
    })
  })

  describe('Telegram API Dispatchers', () => {
    test('sendRawTelegram executes dispatch via WebSocket schema handler', async () => {
      const res = await sendRawTelegram('sendMessage', { chat_id: TEST_CHAT_ID, text: 'Hello' })
      expect(res.ok).not.toBe(false)
    })

    test('sendGenericMessage dispatches text message correctly', async () => {
      const res = await sendGenericMessage('Test message content', undefined, TEST_CHAT_ID)
      expect(res).not.toBeNull()
    })

    test('sendPhotoMessage dispatches photo payload correctly', async () => {
      await sendPhotoMessage(
        'https://example.com/chart.png', 'Chart Caption', undefined, TEST_CHAT_ID,
      )
    })

    test('sendDocumentMessage dispatches document payload correctly', async () => {
      await sendDocumentMessage(
        'https://example.com/doc.pdf', 'Doc Caption', undefined, TEST_CHAT_ID,
      )
    })

    test('sendTelegramAlert dispatches formatted signal alert', async () => {
      await sendTelegramAlert({
        ticker: 'NVDA',
        type: 'BUY',
        price: 130.5,
        entry: 130.0,
        target: 145.0,
        stopLoss: 120.0,
        rsi: 50,
      }, TEST_CHAT_ID)
    })
  })

  describe('Command Processing & Bot Handlers (/buy, /sell, /status, /info, /scan, /help)', () => {
    const mockHandleSell = mock((): Promise<void> => Promise.resolve())
    const mockHandleInfo = mock((): Promise<void> => Promise.resolve())
    const mockHandleSetRisk = mock((): Promise<void> => Promise.resolve())
    const mockHandleRiskProfileMenu = mock((): Promise<void> => Promise.resolve())
    const mockHandleSetSilent = mock((): Promise<void> => Promise.resolve())
    const mockHandlers = {
      handleManualAdd: mock((): Promise<void> => Promise.resolve()),
      handleSell: mockHandleSell,
      handlePortfolioStatus: mock((): Promise<void> => Promise.resolve()),
      handleInfo: mockHandleInfo,
      handleSetRisk: mockHandleSetRisk,
      handleSetSilent: mockHandleSetSilent,
      handleRiskProfileMenu: mockHandleRiskProfileMenu,
      runMasterScanner: mock((): Promise<void> => Promise.resolve()),
      runDeepScan: mock((): Promise<void> => Promise.resolve()),
      handleOptimize: mock((): Promise<void> => Promise.resolve()),
    } as unknown as TelegramHandlers

    beforeEach(() => {
      for (const key of Object.keys(registeredHandlers)) {
        (registeredHandlers as Record<string, unknown>)[key] = null
      }
      registerBotHandlers({
        handlePortfolioSell: mockHandleSell as unknown as (ticker: string, chatId: string, lang: Language) => Promise<void>,
        handleInfo: mockHandleInfo as unknown as (ticker: string, chatId: string, lang?: Language) => Promise<void>,
      })
    })

    test('/status command dispatches portfolio status handler (Example: /status)', async () => {
      const update = {
        update_id: 1,
        message: {
          message_id: 10,
          chat: { id: TEST_CHAT_ID },
          text: '/status',
        },
      }

      await processUpdate(update, mockHandlers)
      expect(mockHandlers.handlePortfolioStatus).toHaveBeenCalledWith(TEST_CHAT_ID, 'en')
    })

    test('/buy command dispatches handleManualAdd handler (Example: /buy AAPL 10)', async () => {
      const update = {
        update_id: 2,
        message: {
          message_id: 11,
          chat: { id: TEST_CHAT_ID },
          text: '/buy AAPL 10',
        },
      }

      await processUpdate(update, mockHandlers)
      expect(mockHandlers.handleManualAdd).toHaveBeenCalledWith(
        'AAPL', 10, TEST_CHAT_ID, 'en',
      )
    })

    test('/buy command with custom ticker and quantity (Example: /buy avgo 23)', async () => {
      const update = {
        update_id: 20,
        message: {
          message_id: 110,
          chat: { id: TEST_CHAT_ID },
          text: '/buy avgo 23',
        },
      }

      await processUpdate(update, mockHandlers)
      expect(mockHandlers.handleManualAdd).toHaveBeenCalledWith(
        'AVGO', 23, TEST_CHAT_ID, 'en',
      )
    })

    test('/buy command with fractional shares (Example: /buy nvda 2.75)', async () => {
      const update = {
        update_id: 21,
        message: {
          message_id: 111,
          chat: { id: TEST_CHAT_ID },
          text: '/buy nvda 2.75',
        },
      }

      await processUpdate(update, mockHandlers)
      expect(mockHandlers.handleManualAdd).toHaveBeenCalledWith(
        'NVDA', 2.75, TEST_CHAT_ID, 'en',
      )
    })

    test('/sell command dispatches handleSell handler (Example: /sell AAPL)', async () => {
      const update = {
        update_id: 3,
        message: {
          message_id: 12,
          chat: { id: TEST_CHAT_ID },
          text: '/sell_AAPL',
        },
      }

      await processUpdate(update, mockHandlers)
      expect(mockHandlers.handleSell).toHaveBeenCalledWith('AAPL', TEST_CHAT_ID, 'en')
    })

    test('/sell command with quantity parameter (Example: /sell avgo 1)', async () => {
      const update = {
        update_id: 30,
        message: {
          message_id: 120,
          chat: { id: TEST_CHAT_ID },
          text: '/sell avgo 1',
        },
      }

      await processUpdate(update, mockHandlers)
      expect(mockHandlers.handleSell).toHaveBeenCalledWith('AVGO', TEST_CHAT_ID, 'en')
    })

    test('/silent command dispatches handleSetSilent handler', async () => {
      const update = {
        update_id: 31,
        message: {
          message_id: 121,
          chat: { id: TEST_CHAT_ID },
          text: '/silent on',
        },
      }

      await processUpdate(update, mockHandlers)
      expect(mockHandlers.handleSetSilent).toHaveBeenCalledWith(TEST_CHAT_ID, 'on', 'en')
    })

    test('/info command dispatches registered handleInfoHandler (Example: /info TSLA)', async () => {
      const update = {
        update_id: 4,
        message: {
          message_id: 13,
          chat: { id: TEST_CHAT_ID },
          text: '/info_TSLA',
        },
      }

      await processUpdate(update, mockHandlers)
      expect(mockHandleInfo).toHaveBeenCalledWith('TSLA', TEST_CHAT_ID, 'en')
    })

    test('/scan command triggers master scanner (Example: /scan)', async () => {
      const update = {
        update_id: 5,
        message: {
          message_id: 14,
          chat: { id: TEST_CHAT_ID },
          text: '/scan',
        },
      }

      await processUpdate(update, mockHandlers)
      expect(mockHandlers.runMasterScanner).toHaveBeenCalledWith({ isManual: true, chatId: TEST_CHAT_ID })
    })

    test('/deep_portfolio command dispatches runDeepPortfolio handler', async () => {
      const mockRunDeepPortfolio = mock((): Promise<string> => Promise.resolve('Deep Analysis Report'))
      const handlersWithDeepPortfolio: TelegramHandlers = {
        ...mockHandlers,
        runDeepPortfolio: mockRunDeepPortfolio,
      }
      const update = {
        update_id: 99,
        message: {
          message_id: 200,
          chat: { id: TEST_CHAT_ID },
          text: '/deep_portfolio',
        },
      }

      await processUpdate(update, handlersWithDeepPortfolio)
      expect(mockRunDeepPortfolio).toHaveBeenCalledWith(TEST_CHAT_ID, expect.any(Function as unknown as (...args: unknown[]) => unknown))
    })

    test('apply_optimization callback query dispatches handleApplyOptimization handler', async () => {
      const mockHandleApplyOptimization = mock((): Promise<void> => Promise.resolve())
      const handlersWithApply: TelegramHandlers = {
        ...mockHandlers,
        handleApplyOptimization: mockHandleApplyOptimization,
      }
      const update = {
        update_id: 100,
        callback_query: {
          id: 'cb_opt_1',
          chat_id: TEST_CHAT_ID,
          data: 'apply_optimization',
          message: {
            message_id: 201,
            chat: { id: TEST_CHAT_ID },
          },
        },
      }

      await processUpdate(update, handlersWithApply)
      expect(mockHandleApplyOptimization).toHaveBeenCalledWith(TEST_CHAT_ID)
    })

    test('/risk command with numeric amount dispatches handleSetRisk (Example: /risk 500)', async () => {
      const update = {
        update_id: 60,
        message: {
          message_id: 300,
          chat: { id: TEST_CHAT_ID },
          text: '/risk 500',
        },
      }

      await processUpdate(update, mockHandlers)
      expect(mockHandleSetRisk).toHaveBeenCalledWith(TEST_CHAT_ID, '500', 'en')
    })

    test('/risk command with percentage dispatches handleSetRisk (Example: /risk 1.5%)', async () => {
      const update = {
        update_id: 61,
        message: {
          message_id: 301,
          chat: { id: TEST_CHAT_ID },
          text: '/risk 1.5%',
        },
      }

      await processUpdate(update, mockHandlers)
      expect(mockHandleSetRisk).toHaveBeenCalledWith(TEST_CHAT_ID, '1.5%', 'en')
    })

    test('/risk command without arguments dispatches handleRiskProfileMenu', async () => {
      const update = {
        update_id: 62,
        message: {
          message_id: 302,
          chat: { id: TEST_CHAT_ID },
          text: '/risk',
        },
      }

      await processUpdate(update, mockHandlers)
      expect(mockHandleRiskProfileMenu).toHaveBeenCalledWith(TEST_CHAT_ID, 'en')
    })
  })

  describe('No-op & Notification Utilities', () => {
    test('no-op & helper functions resolve cleanly', async () => {
      await queueNotification()
      await processPendingNotifications()
      await sendFridayMacroReport('low')
      await sendHeartbeatMessage(true, true)
    })

    test('sendHeartbeatMessage renders per-chat API key status line', async () => {
      await sendHeartbeatMessage(true, true, new Map([
        [
          TEST_CHAT_ID,
          true,
        ],
      ]))
      await sendHeartbeatMessage(true, false, new Map([
        [
          TEST_CHAT_ID,
          false,
        ],
      ]))
      await sendHeartbeatMessage(true, true)
    })
  })
})
