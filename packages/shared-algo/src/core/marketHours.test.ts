import {
  describe, expect, it, 
} from 'bun:test'

import {
  getTradingDaysBetween,
  isEarlyCloseDay,
  isMarketDay,
  isMarketHoliday,
  isMarketOpen,
} from './marketHours'

describe('isMarketOpen', () => {
  it('returns true during regular market hours (e.g. Wednesday 10:30 AM NY time)', () => {
    // 2026-07-22 is Wednesday 10:30 AM EDT (UTC-4) -> 14:30 UTC
    const wednesdayMarketHours = new Date('2026-07-22T14:30:00Z')
    expect(isMarketOpen(wednesdayMarketHours)).toBe(true)
  })

  it('returns false before market open (e.g. Wednesday 8:00 AM NY time)', () => {
    // 8:00 AM EDT -> 12:00 UTC
    const wednesdayPreMarket = new Date('2026-07-22T12:00:00Z')
    expect(isMarketOpen(wednesdayPreMarket)).toBe(false)
  })

  it('returns false after market close (e.g. Wednesday 5:00 PM NY time)', () => {
    // 5:00 PM EDT -> 21:00 UTC
    const wednesdayAfterHours = new Date('2026-07-22T21:00:00Z')
    expect(isMarketOpen(wednesdayAfterHours)).toBe(false)
  })

  it('returns false on Saturday (weekend)', () => {
    const saturday = new Date('2026-07-25T14:30:00Z')
    expect(isMarketOpen(saturday)).toBe(false)
  })

  it('returns false on Sunday (weekend)', () => {
    const sunday = new Date('2026-07-26T14:30:00Z')
    expect(isMarketOpen(sunday)).toBe(false)
  })

  it('returns false on official stock market holidays', () => {
    // 2026 Good Friday: April 3, 2026
    const goodFriday = new Date('2026-04-03T14:30:00Z')
    expect(isMarketHoliday(goodFriday)).toBe(true)
    expect(isMarketDay(goodFriday)).toBe(false)
    expect(isMarketOpen(goodFriday)).toBe(false)

    // 2026 Christmas Day: Dec 25, 2026
    const christmas = new Date('2026-12-25T14:30:00Z')
    expect(isMarketHoliday(christmas)).toBe(true)
    expect(isMarketOpen(christmas)).toBe(false)

    // 2026 Thanksgiving: Nov 26, 2026
    const thanksgiving = new Date('2026-11-26T14:30:00Z')
    expect(isMarketHoliday(thanksgiving)).toBe(true)
    expect(isMarketOpen(thanksgiving)).toBe(false)
  })

  it('handles early close days (1:00 PM ET close)', () => {
    // 2026 Black Friday: Nov 27, 2026
    const blackFriday11am = new Date('2026-11-27T16:00:00Z') // 11:00 AM EST -> 16:00 UTC
    const blackFriday2pm = new Date('2026-11-27T19:00:00Z') // 2:00 PM EST -> 19:00 UTC

    expect(isEarlyCloseDay(blackFriday11am)).toBe(true)
    expect(isMarketOpen(blackFriday11am)).toBe(true) // Open at 11:00 AM
    expect(isMarketOpen(blackFriday2pm)).toBe(false) // Closed after 1:00 PM
  })
})

describe('getTradingDaysBetween', () => {
  it('correctly calculates 1 trading day between Friday and Monday', () => {
    const friday = new Date('2026-07-24T16:00:00Z')
    const monday = new Date('2026-07-27T09:30:00Z')
    expect(getTradingDaysBetween(friday, monday)).toBe(1)
  })

  it('skips market holidays when calculating trading days', () => {
    // Good Friday is April 3, 2026 (Friday). Thursday April 2 to Monday April 6
    const thursday = new Date('2026-04-02T16:00:00Z')
    const monday = new Date('2026-04-06T09:30:00Z')
    // Without Good Friday, Thursday -> Monday would be 2 trading days (Fri + Mon). With Good Friday, it is 1 trading day (Mon only).
    expect(getTradingDaysBetween(thursday, monday)).toBe(1)
  })
})
