export type Timeframe = 'wtd' | 'mtd' | 'ytd' | 'all'

export const TIMEFRAMES: Timeframe[] = [
  'wtd',
  'mtd',
  'ytd',
  'all',
]

export const TIMEFRAME_LABELS: Record<Timeframe, string> = {
  wtd: 'Week-to-Date',
  mtd: 'Month-to-Date',
  ytd: 'Year-to-Date',
  all: 'All-Time',
}

/**
 * Compute the inclusive start-of-window Date for a calendar timeframe.
 * Uses the server's local timezone (container TZ = America/New_York per
 * docker-compose). Monday is the week start (US market convention).
 * Returns null for 'all' (no lower bound).
 */
export function getTimeframeWindow(tf: Timeframe): Date | null {
  if (tf === 'all') return null
  const now = new Date()
  if (tf === 'wtd') {
    const d = new Date(now)
    const day = d.getDay()
    d.setDate(d.getDate() - ((day + 6) % 7))
    d.setHours(
      0, 0, 0, 0,
    )
    return d
  }
  if (tf === 'mtd') {
    return new Date(now.getFullYear(), now.getMonth(), 1)
  }
  if (tf === 'ytd') {
    return new Date(now.getFullYear(), 0, 1)
  }
  return null
}

/** Parse and validate a timeframe string, defaulting to 'mtd'. */
export function parseTimeframe(raw: string | undefined | null): Timeframe {
  const lower = (raw || '').toLowerCase().trim()
  if (TIMEFRAMES.includes(lower as Timeframe)) return lower as Timeframe
  return 'mtd'
}

/** Format a Date as MM-DD for compact display. */
export function formatDateCompact(d: Date): string {
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
