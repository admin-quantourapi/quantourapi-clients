import { getEffectiveRisk } from '@quantour/shared-algo/src/finance-algo/screener'
import { eq } from 'drizzle-orm'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'

import * as schema from '../db/clientSchema'
import { userBudgets } from '../db/clientSchema'

export const DEFAULT_TOTAL_CAPITAL = '30000'
export const DEFAULT_MAX_RISK = '300'
const PLACEHOLDER_USER_ID = 'dashboard_user'

export interface UserBudget {
  userId: string
  totalCapital: string
  maxRiskPerTrade: string
  /** max_risk_per_trade resolved to an effective $ amount (percent-of-capital → $). */
  maxRiskPerTradeUsd: number
}

function resolveMoney(row: { totalCapital: string | null; maxRiskPerTrade: string | null }): {
  totalCapital: string
  maxRiskPerTrade: string
  maxRiskPerTradeUsd: number
} {
  const totalCapital = row.totalCapital || DEFAULT_TOTAL_CAPITAL
  const maxRiskPerTrade = row.maxRiskPerTrade || DEFAULT_MAX_RISK
  const cap = parseFloat(totalCapital) || parseFloat(DEFAULT_TOTAL_CAPITAL)
  const maxRiskPerTradeUsd = getEffectiveRisk(maxRiskPerTrade, cap) || parseFloat(DEFAULT_MAX_RISK)
  return {
    totalCapital, maxRiskPerTrade, maxRiskPerTradeUsd, 
  }
}

export function defaultBudget(userId = ''): UserBudget {
  return {
    userId,
    ...resolveMoney({
      totalCapital: DEFAULT_TOTAL_CAPITAL, maxRiskPerTrade: DEFAULT_MAX_RISK, 
    }),
  }
}

/**
 * Read the canonical per-user budget. Lazy-creates the user_budgets row with
 * schema defaults on first access (the settings budget columns are gone — the
 * configured values were backfilled into user_budgets before Cleanup B; a
 * brand-new account starts at the defaults until /budget is set). Returns a
 * safe default when the userId is missing or the 'dashboard_user' placeholder.
 */
export async function getUserBudget(db: BunSQLiteDatabase<typeof schema>, userId?: string | null): Promise<UserBudget> {
  if (!userId || userId === PLACEHOLDER_USER_ID) return defaultBudget(userId || '')

  const existing = await db.select().from(userBudgets).where(eq(userBudgets.userId, userId)).limit(1)
  if (existing.length > 0) {
    const r = existing[0]!
    return {
      userId,
      ...resolveMoney(r),
    }
  }

  await lazyCreateBudget(db, userId)
  const created = await db.select().from(userBudgets).where(eq(userBudgets.userId, userId)).limit(1)
  if (created.length > 0) {
    const r = created[0]!
    return {
      userId,
      ...resolveMoney(r),
    }
  }
  return defaultBudget(userId)
}

async function lazyCreateBudget(db: BunSQLiteDatabase<typeof schema>, userId: string) {
  try {
    await db.insert(userBudgets).values({
      userId,
      totalCapital: DEFAULT_TOTAL_CAPITAL,
      maxRiskPerTrade: DEFAULT_MAX_RISK,
      updatedAt: new Date(),
    })
  } catch {
    // Race with another caller — row now exists; ignore.
  }
}

/**
 * Upsert the canonical per-user budget. All budget write paths (Telegram
 * /budget, /risk, /freecash, dashboard POST) MUST go through here.
 */
export async function setUserBudget(db: BunSQLiteDatabase<typeof schema>,
  userId: string | null | undefined,
  fields: { totalCapital?: string; maxRiskPerTrade?: string }): Promise<void> {
  if (!userId || userId === PLACEHOLDER_USER_ID) return
  const uid = userId
  const existing = await db.select().from(userBudgets).where(eq(userBudgets.userId, uid)).limit(1)
  const now = new Date()
  if (existing.length > 0) {
    await db.update(userBudgets).set({
      ...fields, updatedAt: now, 
    }).where(eq(userBudgets.userId, uid))
    return
  }
  await db.insert(userBudgets).values({
    userId: uid,
    totalCapital: fields.totalCapital ?? DEFAULT_TOTAL_CAPITAL,
    maxRiskPerTrade: fields.maxRiskPerTrade ?? DEFAULT_MAX_RISK,
    updatedAt: now,
  }).catch(() => {
    // Race — another caller inserted; fall back to update.
  })
  // Re-read+update in case of a race that won the insert.
  await db.update(userBudgets).set({
    ...fields, updatedAt: now, 
  }).where(eq(userBudgets.userId, uid)).catch(() => {})
}
