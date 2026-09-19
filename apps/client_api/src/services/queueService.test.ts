import {
  describe,
  expect,
  test,
} from 'bun:test'

import { executeScheduledJobPayload } from './queueService'

describe('QueueService — Non-Trading Day Worker Protection', () => {
  test('skips execution on Sunday (closed market day)', async () => {
    // Sunday August 9, 2026
    const sundayDate = new Date('2026-08-09T14:00:00Z')
    const executed = await executeScheduledJobPayload('OPTIMIZE_JOB', '10:00', sundayDate)
    expect(executed).toBe(false)
  })

  test('skips execution on Saturday (closed market day)', async () => {
    // Saturday August 8, 2026
    const saturdayDate = new Date('2026-08-08T14:00:00Z')
    const executed = await executeScheduledJobPayload('OPTIMIZE_JOB', '15:15', saturdayDate)
    expect(executed).toBe(false)
  })

  test('skips execution on US Stock Market Holiday (Christmas Day)', async () => {
    // Friday December 25, 2026 (Christmas)
    const christmasDate = new Date('2026-12-25T14:00:00Z')
    const executed = await executeScheduledJobPayload('OPTIMIZE_JOB', '10:00', christmasDate)
    expect(executed).toBe(false)
  })
})
