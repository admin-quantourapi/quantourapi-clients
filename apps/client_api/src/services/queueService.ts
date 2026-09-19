import { isMarketDay } from '@quantour/shared-algo/src/core/marketHours'
import {
  Queue,
  Worker,
} from 'bullmq'
import Redis from 'ioredis'

import { runMasterScanner } from '~/server/clientScanner'
import { logger } from '~/services/logger'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

let queue: Queue | null = null

export async function executeScheduledJobPayload(type: string, timeSlot: string, overrideDate?: Date): Promise<boolean> {
  const checkDate = overrideDate || new Date()
  if (!isMarketDay(checkDate)) {
    logger.info({ type, timeSlot }, '[QueueService] Market is closed today (weekend or holiday). Skipping scheduled job execution.')
    return false
  }

  logger.info({ type, timeSlot }, '[QueueService] Executing scheduled master scan')
  await runMasterScanner({ isManual: false })

  if (type === 'OPTIMIZE_JOB') {
    try {
      const { db } = await import('~/db')
      const { settings } = await import('~/db/clientSchema')
      const { isNotNull } = await import('drizzle-orm')
      const { handlePortfolioRotations } = await import('~/server/botHandlers/portfolioHandlers')

      const users = await db.select().from(settings).where(isNotNull(settings.telegramChatId))
      logger.info({ count: users.length, timeSlot }, '[QueueService] Dispatching automated portfolio optimization to users')

      for (const user of users) {
        if (user.telegramChatId) {
          try {
            await handlePortfolioRotations(user.telegramChatId)
          } catch (err) {
            logger.error({ chatId: user.telegramChatId, error: err }, '[QueueService] Failed to dispatch portfolio optimization')
          }
        }
      }
    } catch (err) {
      logger.error({ error: err }, '[QueueService] Scheduled portfolio optimization dispatch error')
    }
  }

  return true
}

try {
  const redisConnection = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 100, 3000),
  })

  redisConnection.on('error', (err) => {
    logger.warn({ err: err.message }, '[QueueService] Redis connection error, queue operates in fallback mode')
  })

  queue = new Queue('client_scheduler_queue', {
    connection: redisConnection,
    defaultJobOptions: {
      removeOnComplete: { age: 86400, count: 100 },
      removeOnFail: { age: 86400, count: 50 },
    },
  })
  queue.on('error', (err) => {
    logger.debug({ err: err.message }, '[QueueService] Client queue connection error')
  })

  const worker = new Worker('client_scheduler_queue', async (job) => {
    const { type, timeSlot, timestamp } = job.data as { type: string; timeSlot: string; timestamp: number }

    // Coalescing: Skip job if it's older than 30 minutes (prevent backlog storm)
    const ageMs = Date.now() - timestamp
    if (ageMs > 30 * 60 * 1000) {
      logger.warn({ type, timeSlot, ageMinutes: Math.round(ageMs / 60000) }, '[QueueService] Skipping obsolete missed job')
      return
    }

    logger.info({ jobId: job.id, type, timeSlot }, '[QueueService] Executing scheduled job')
    await executeScheduledJobPayload(type, timeSlot)
  }, {
    connection: redisConnection,
    concurrency: 1, // Ensure only 1 scan/optimization runs at a time
  })
  worker.on('error', (err) => {
    logger.debug({ err: err.message }, '[QueueService] Client worker connection error')
  })

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, error: err.message }, '[QueueService] Scheduled job failed')
  })
} catch (e) {
  logger.warn({ error: e }, '[QueueService] Failed to initialize Redis / BullMQ, using inline execution fallback')
}

export async function enqueueScheduledJob(type: 'SCAN_JOB' | 'OPTIMIZE_JOB', timeSlot: string): Promise<boolean> {
  const dateStr = new Date().toISOString().split('T')[0]
  const jobId = `${type}_${dateStr}_${timeSlot.replace(':', '')}`

  if (queue) {
    try {
      const existing = await queue.getJob(jobId)
      if (existing) {
        logger.info({ jobId }, '[QueueService] Job already queued or completed, skipping duplicate')
        return false
      }

      await queue.add(type, { type, timeSlot, timestamp: Date.now() }, { jobId })
      logger.info({ jobId, type, timeSlot }, '[QueueService] Successfully queued scheduled job')
      return true
    } catch (e) {
      logger.error({ error: e, jobId }, '[QueueService] Error adding job to BullMQ queue, falling back to direct execution')
    }
  }

  // Direct execution fallback if Redis is unavailable
  try {
    await executeScheduledJobPayload(type, timeSlot)
    return true
  } catch (e) {
    logger.error({ error: e }, '[QueueService] Fallback execution failed')
    return false
  }
}
