/**
 * US Equity Market Hours & Holiday Engine (NYSE / NASDAQ)
 * Timezone: America/New_York (Eastern Time - ET)
 * Regular trading hours: Mon–Fri, 9:30 AM to 4:00 PM ET.
 * Early close trading hours: Mon–Fri, 9:30 AM to 1:00 PM ET.
 */

export interface NewYorkParts {
  year: number
  month: number // 1-12
  day: number // 1-31
  weekday: number // 0 = Sun, 1 = Mon, ..., 6 = Sat
  hour: number // 0-23
  minute: number // 0-59
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

/**
 * Extracts exact components in US Eastern Time (America/New_York) without string parsing ambiguity.
 */
export function getNewYorkParts(date: Date = new Date()): NewYorkParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  })

  const parts = formatter.formatToParts(date)
  const partMap: Record<string, string> = {}
  for (const p of parts) {
    if (p.type !== 'literal') {
      partMap[p.type] = p.value
    }
  }

  const hour = (parseInt(partMap.hour || '0', 10)) % 24
  const minute = parseInt(partMap.minute || '0', 10)
  const month = parseInt(partMap.month || '1', 10)
  const day = parseInt(partMap.day || '1', 10)
  const year = parseInt(partMap.year || '2026', 10)
  const weekday = WEEKDAY_MAP[partMap.weekday || 'Sun'] ?? 0

  return {
    year,
    month,
    day,
    weekday,
    hour,
    minute,
  }
}

/**
 * Anonymous Gregorian algorithm for Good Friday (Easter Sunday minus 2 days).
 */
function getGoodFriday(year: number): { month: number; day: number } {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1

  const easter = new Date(Date.UTC(year, month - 1, day))
  const gf = new Date(easter)
  gf.setUTCDate(easter.getUTCDate() - 2)

  return { month: gf.getUTCMonth() + 1, day: gf.getUTCDate() }
}

function getNthWeekdayOfMonth(
  year: number, month: number, targetWeekday: number, n: number,
): number {
  let count = 0
  for (let day = 1; day <= 31; day++) {
    const d = new Date(Date.UTC(year, month - 1, day))
    if (d.getUTCMonth() !== month - 1) break
    if (d.getUTCDay() === targetWeekday) {
      count++
      if (count === n) return day
    }
  }
  return 0
}

function getLastWeekdayOfMonth(year: number, month: number, targetWeekday: number): number {
  let lastDay = 0
  for (let day = 1; day <= 31; day++) {
    const d = new Date(Date.UTC(year, month - 1, day))
    if (d.getUTCMonth() !== month - 1) break
    if (d.getUTCDay() === targetWeekday) {
      lastDay = day
    }
  }
  return lastDay
}

function getObservedFixedHoliday(year: number, month: number, fixedDay: number): { month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, fixedDay))
  const w = d.getUTCDay()
  if (w === 6) return { month, day: fixedDay - 1 } // Saturday -> Observed Friday
  if (w === 0) return { month, day: fixedDay + 1 } // Sunday -> Observed Monday
  return { month, day: fixedDay }
}

/**
 * Checks if a given date is an official US Stock Market Holiday (NYSE/NASDAQ).
 */
export function isMarketHoliday(date: Date = new Date()): boolean {
  const { year, month, day } = getNewYorkParts(date)

  // New Year's Day (Jan 1)
  const ny = getObservedFixedHoliday(year, 1, 1)
  if (month === ny.month && day === ny.day) return true

  // Check if Dec 31 of current year is New Year's Day observed for next year
  const nextNy = getObservedFixedHoliday(year + 1, 1, 1)
  if (nextNy.month === 12 && month === 12 && day === nextNy.day) return true

  // MLK Day (3rd Mon Jan)
  if (month === 1 && day === getNthWeekdayOfMonth(
    year, 1, 1, 3,
  )) return true

  // Presidents' Day / Washington's Birthday (3rd Mon Feb)
  if (month === 2 && day === getNthWeekdayOfMonth(
    year, 2, 1, 3,
  )) return true

  // Good Friday
  const gf = getGoodFriday(year)
  if (month === gf.month && day === gf.day) return true

  // Memorial Day (Last Mon May)
  if (month === 5 && day === getLastWeekdayOfMonth(year, 5, 1)) return true

  // Juneteenth (June 19)
  const jt = getObservedFixedHoliday(year, 6, 19)
  if (month === jt.month && day === jt.day) return true

  // Independence Day (July 4)
  const id = getObservedFixedHoliday(year, 7, 4)
  if (month === id.month && day === id.day) return true

  // Labor Day (1st Mon Sep)
  if (month === 9 && day === getNthWeekdayOfMonth(
    year, 9, 1, 1,
  )) return true

  // Thanksgiving Day (4th Thu Nov)
  if (month === 11 && day === getNthWeekdayOfMonth(
    year, 11, 4, 4,
  )) return true

  // Christmas Day (Dec 25)
  const xm = getObservedFixedHoliday(year, 12, 25)
  if (month === xm.month && day === xm.day) return true

  return false
}

/**
 * Checks if a given date is an early close day (1:00 PM ET close).
 */
export function isEarlyCloseDay(date: Date = new Date()): boolean {
  const { year, month, day } = getNewYorkParts(date)

  // July 3rd (if July 4th is a weekday Mon-Fri)
  if (month === 7 && day === 3) {
    const jul4Weekday = new Date(Date.UTC(year, 6, 4)).getUTCDay()
    if (jul4Weekday >= 1 && jul4Weekday <= 5) return true
  }

  // Black Friday (Day after Thanksgiving = 4th Friday in Nov)
  if (month === 11 && day === getNthWeekdayOfMonth(
    year, 11, 5, 4,
  )) return true

  // Christmas Eve (Dec 24 if weekday)
  if (month === 12 && day === 24) {
    const dec24Weekday = new Date(Date.UTC(year, 11, 24)).getUTCDay()
    if (dec24Weekday >= 1 && dec24Weekday <= 5) return true
  }

  return false
}

/**
 * Checks if the given date is a valid market trading day (Mon-Fri and NOT a market holiday).
 */
export function isMarketDay(date: Date = new Date()): boolean {
  const { weekday } = getNewYorkParts(date)
  if (weekday === 0 || weekday === 6) return false
  return !isMarketHoliday(date)
}

/**
 * Checks if regular stock trading is currently open in New York (9:30 AM to 4:00 PM ET, or 1:00 PM on early close).
 */
export function isMarketOpen(date: Date = new Date()): boolean {
  if (!isMarketDay(date)) return false

  const { hour, minute } = getNewYorkParts(date)
  const currentMinuteOfDay = hour * 60 + minute

  const marketOpenMinute = 9 * 60 + 30 // 9:30 AM (570)
  const marketCloseMinute = isEarlyCloseDay(date) ? 13 * 60 : 16 * 60 // 1:00 PM (780) or 4:00 PM (960)

  return currentMinuteOfDay >= marketOpenMinute && currentMinuteOfDay < marketCloseMinute
}

/**
 * Alias for isMarketOpen.
 */
export function isMarketHours(date: Date = new Date()): boolean {
  return isMarketOpen(date)
}

/**
 * Calculates the number of valid market trading days between two dates (excluding weekends AND holidays).
 */
export function getTradingDaysBetween(startDate: Date, endDate: Date): number {
  let count = 0
  const cur = new Date(startDate)
  cur.setUTCHours(
    12, 0, 0, 0,
  )

  const target = new Date(endDate)
  target.setUTCHours(
    12, 0, 0, 0,
  )

  if (cur >= target) return 0

  while (cur < target) {
    cur.setUTCDate(cur.getUTCDate() + 1)
    if (isMarketDay(cur)) {
      count++
    }
  }
  return count
}
