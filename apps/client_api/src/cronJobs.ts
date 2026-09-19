import { local } from '@quantour/shared-algo/src/core/i18n'
import { isMarketOpen } from '@quantour/shared-algo/src/core/marketHours'

import { checkTrackedExits } from '~/server/exitManager'
import {
  drainLogBuffer, logger, 
} from '~/services/logger'

import { db } from './db'
import { clientLogs } from './db/clientSchema'
import { runMasterScanner } from './server/clientScanner'
import {
  sendGenericMessage, sendHeartbeatMessage, 
} from './services/telegramService'

/**
 * Drain the logger ring buffer into the persistent client_logs table.
 * Non-critical: failures are logged to console and dropped (logs are
 * best-effort — the console output still has them).
 */
async function flushClientLogs() {
  try {
    const logs = drainLogBuffer()
    if (logs.length === 0) return
    await db.insert(clientLogs).values(logs.map(l => ({
      level: l.level,
      message: l.message,
      chatId: l.chatId ?? null,
      meta: l.meta !== undefined ? JSON.stringify(l.meta) : null,
      createdAt: l.timestamp,
    })))
  } catch (e) {
    console.error('[LOG_FLUSH] Failed to persist client logs:', e)
  }
}

export function startCronJobs() {
  
  let lastRoutineMinute = -1

  void flushClientLogs()
  
  setInterval(async () => {
    const now = new Date()
    const minute = now.getMinutes()

    void flushClientLogs()

    
    // Master Scanner - every 15 minutes
    if (minute % 15 === 0 && minute !== lastRoutineMinute) {
      lastRoutineMinute = minute
      
      // Daily check at 9:00 AM NY Time
      const nyDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
      
      // System health heartbeat check at 8:00 AM & 8:00 PM NY Time
      const nyHour = nyDate.getHours()
      if ((nyHour === 8 || nyHour === 20) && minute === 0) {
        try {
          const { db } = await import('./db')
          const { settings } = await import('./db/clientSchema')
          // Check DB and API status (basic proxy check)
          let dbStatus = false
          try {
            await db.select().from(settings).limit(1)
            dbStatus = true
          } catch { /* ignore */ }
          
          // Per-chat API-key validation: every linked chat's key is pinged
          // individually so a single dead key is visible in the heartbeat
          // (a first-key-only check can be masked by the instance row's
          // always-valid key).
          let apiStatus = false
          const keyStatusByChat = new Map<string, boolean>()
          try {
            const {
              isNotNull, 
            } = await import('drizzle-orm')
            const { db: localDb } = await import('./db')
            const { settings: settingsTable } = await import('./db/clientSchema')
            const { pingKey } = await import('./services/keyValidator')
            const rows = await localDb.select().from(settingsTable).where(isNotNull(settingsTable.quantourApiKey))
            const distinctKeys = Array.from(new Set(rows.map(r => r.quantourApiKey).filter((k): k is string => Boolean(k))))
            const keyOk = new Map<string, boolean>()
            for (const key of distinctKeys) {
              const result = await pingKey(key, { bypassCache: true })
              keyOk.set(key, result.ok)
              if (result.ok) apiStatus = true
              // Avoid a burst of parallel pings hitting the central API's
              // rate limiter (same courtesy as the daily key sweep).
              await new Promise(r => setTimeout(r, 200))
            }
            for (const row of rows) {
              if (!row.telegramChatId || !row.quantourApiKey) continue
              keyStatusByChat.set(row.telegramChatId, keyOk.get(row.quantourApiKey) ?? false)
            }
          } catch { /* ignore */ }
          
          await sendHeartbeatMessage(dbStatus, apiStatus, keyStatusByChat).catch(() => {})
        } catch (e) {
          logger.error({ error: e }, '[SCHEDULED] Heartbeat failed')
        }
      }

      if (nyDate.getHours() === 9 && nyDate.getMinutes() === 0) {
        try {
          const { db } = await import('./db')
          const { settings } = await import('./db/clientSchema')
          const {
            isNull, and, isNotNull, eq, 
          } = await import('drizzle-orm')
          const {
            AccountEventType, lastNoticeWithin, NOTICE_THROTTLE_MS, recordEvent, 
          } = await import('./services/accountEvents')
          const missingKeyUsers = await db.select().from(settings).where(and(isNotNull(settings.telegramChatId),
            isNull(settings.quantourApiKey)))
          for (const user of missingKeyUsers) {
            if (!user.telegramChatId) continue
            // Persistently-throttled reminder (24h): record the notice event
            // so the reminder does not re-fire after a bot restart.
            const suppressed = await lastNoticeWithin(user.telegramChatId, 'no_key', NOTICE_THROTTLE_MS)
            if (suppressed) continue
            await sendGenericMessage(local('⚠️ Your account is not linked to Quantour. Please send `/link <YOUR_API_KEY>` to sync your account and receive signals.'), undefined, user.telegramChatId)
            await recordEvent(user.telegramChatId, AccountEventType.NOTICE_NO_KEY, { detail: 'daily_reminder' })
          }

          // Daily re-validation sweep: ping every distinct stored key and
          // quarantine chats whose key has been revoked/expired at the
          // central API since the last sweep. Catches revocations that the
          // mid-scan 401 path would otherwise only discover when the
          // fetching chat happens to use that key. BypassCache forces a
          // fresh /v1/ping per key (the 5-min TTL would otherwise mask
          // same-day revocations for up to 24h+5m).
          try {
            const { t } = await import('@quantour/shared-algo/src/core/i18n')
            const { getChatLanguage } = await import('./services/telegramService')
            const { pingKey } = await import('./services/keyValidator')
            const linkedRows = await db.select().from(settings).where(and(isNotNull(settings.telegramChatId),
              isNotNull(settings.quantourApiKey)))
            const distinctKeys = Array.from(new Set(linkedRows.map(r => r.quantourApiKey).filter((k): k is string => Boolean(k))))
            for (const key of distinctKeys) {
              const result = await pingKey(key, { bypassCache: true })
              const chatsWithKey = linkedRows.filter(r => r.quantourApiKey === key && r.telegramChatId)
              if (!result.ok) {
                // Only flip rows that were previously approved — already-
                // pending rows (quarantined earlier by the scanner) stay
                // pending silently, avoiding duplicate quarantine events.
                const toQuarantine = chatsWithKey.filter(r => r.status === 'approved')
                if (toQuarantine.length > 0) {
                  logger.warn({ keyHash: key.slice(-6) }, '[SCHEDULED] Daily key sweep: key no longer valid, quarantining chats')
                  try {
                    await db.update(settings).set({ status: 'pending' }).where(and(eq(settings.quantourApiKey, key), eq(settings.status, 'approved')))
                  } catch (dbErr) {
                    logger.error({ error: dbErr }, '[SCHEDULED] Failed to quarantine expired key')
                  }
                }
                for (const row of chatsWithKey) {
                  if (!row.telegramChatId) continue
                  if (row.status === 'approved') {
                    // Record the approved→pending transition (audit).
                    await recordEvent(row.telegramChatId, AccountEventType.KEY_QUARANTINED, { key, detail: 'daily_sweep' })
                  }
                  // Throttled re-link notice (24h) — persists its own event.
                  const suppressed = await lastNoticeWithin(row.telegramChatId, 'expired', NOTICE_THROTTLE_MS)
                  if (suppressed) continue
                  const lang = await getChatLanguage(row.telegramChatId)
                  await sendGenericMessage(t('KEY_EXPIRED_RELINK_NOTICE', lang), undefined, row.telegramChatId).catch(() => {})
                  await recordEvent(row.telegramChatId, AccountEventType.NOTICE_EXPIRED, { detail: 'daily_sweep' })
                }
              } else {
                // Restore rows left pending by a prior transient failure;
                // record the transition per chat when it actually happens.
                const toRestore = chatsWithKey.filter(r => r.status === 'pending')
                if (toRestore.length > 0) {
                  try {
                    await db.update(settings).set({ status: 'approved' }).where(and(eq(settings.quantourApiKey, key), eq(settings.status, 'pending')))
                  } catch (dbErr) {
                    logger.error({ error: dbErr }, '[SCHEDULED] Failed to restore approved status')
                  }
                  for (const row of toRestore) {
                    if (!row.telegramChatId) continue
                    await recordEvent(row.telegramChatId, AccountEventType.KEY_RESTORED, { key, detail: 'daily_sweep' })
                  }
                }
              }
              // Avoid a burst of parallel pings hitting the central API's
              // rate limiter on multi-tenant instances.
              await new Promise(r => setTimeout(r, 200))
            }
          } catch (sweepErr) {
            logger.error({ error: sweepErr }, '[SCHEDULED] Daily key re-validation sweep failed')
          }
        } catch(e) {
          logger.error({ error: e }, '[SCHEDULED] Daily API key reminder failed')
        }
      }

      // Catalyst check at 12:00 PM NY Time — notify users of upcoming catalysts for held positions
      if (nyHour === 12 && minute === 0) {
        try {
          const { checkPositionCatalysts } = await import('./server/catalystChecker')
          await checkPositionCatalysts()
        } catch (e) {
          logger.error({ error: e }, '[SCHEDULED] Catalyst check failed')
        }
      }

      // Scheduled Scans & Portfolio Optimizations at specific NY market times
      const nyMin = nyDate.getMinutes()
      const timeSlot = `${String(nyHour).padStart(2, '0')}:${String(nyMin).padStart(2, '0')}`

      // 1. Scheduled Portfolio Optimization Jobs: 10:00 AM ET & 3:15 PM (15:15) ET
      if ((nyHour === 10 && nyMin === 0) || (nyHour === 15 && nyMin === 15)) {
        try {
          const { enqueueScheduledJob } = await import('./services/queueService')
          await enqueueScheduledJob('OPTIMIZE_JOB', timeSlot)
        } catch (e) {
          logger.error({ error: e, timeSlot }, '[SCHEDULED] Daily portfolio optimization dispatch failed')
        }
      }

      // 2. Scheduled Market Scans: 10:00 AM ET, 12:00 PM ET, 3:15 PM (15:15) ET
      if ((nyHour === 10 && nyMin === 0) || (nyHour === 12 && nyMin === 0) || (nyHour === 15 && nyMin === 15)) {
        try {
          const { enqueueScheduledJob } = await import('./services/queueService')
          await enqueueScheduledJob('SCAN_JOB', timeSlot)
        } catch (e) {
          logger.error({ error: e, timeSlot }, '[SCHEDULED] Scheduled market scan dispatch failed')
        }
      }

      try {
        const exitNotes = await checkTrackedExits()
        if (isMarketOpen()) {
          await runMasterScanner({ isManual: false })
        } else {
          logger.info('[SCHEDULED] Market is closed. Skipping 15-min automated scan.')
        }
        if (exitNotes && exitNotes.length > 0) {
          for (const note of exitNotes) {
            if (note.messages && note.messages.length > 0) {
              const fullText = note.messages.join('\n\n')
              await sendGenericMessage(local(fullText), note.buttons ? { inline_keyboard: note.buttons } : undefined, note.chatId)
            }
          }
        }
      } catch (e) {
        logger.error({ error: e }, '[SCHEDULED] Routine scan failed')
      }
    }
  }, 60000)
}
