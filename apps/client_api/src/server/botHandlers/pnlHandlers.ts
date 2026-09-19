import {
  Language, local, t, 
} from '@quantour/shared-algo/src/core/i18n'
import { eq } from 'drizzle-orm'
import {
  desc, 
} from 'drizzle-orm'

import { db as localDb } from '~/db'
import {
  settings, tradeAuditLog,
} from '~/db/clientSchema'
import { sendGenericMessage } from '~/services/telegramService'

import {
  getAccountScopeByKey, scopeConditions, 
} from '../dashboardIdentity'
import {
  formatDateCompact, getTimeframeWindow, type Timeframe, 
  TIMEFRAME_LABELS, 
} from '../timeframes'

/**
 * /pnl [wtd|mtd|ytd|all] — PnL report for a calendar timeframe.
 *
 * Account-scoped (per userId): resolves the chat's API key, then queries the
 * user's tradeAuditLog across all their chats/devices (same key → one account).
 * Shows overall PnL, win/loss count, best + worst trade, and a compact list.
 * Default timeframe: MTD.
 */
export async function handlePnl(chatId: string, lang: Language = 'en', timeframe: Timeframe = 'mtd'): Promise<void> {
  const chat = (await localDb.select().from(settings).where(eq(settings.telegramChatId, chatId)).limit(1))[0]
  const accountScope = await getAccountScopeByKey(localDb, chat?.quantourApiKey)

  const conds = scopeConditions(accountScope, tradeAuditLog)
  if (conds.length === 0) {
    await sendGenericMessage(t('PNL_NO_ACCOUNT', lang), undefined, chatId)
    return
  }

  const windowStart = getTimeframeWindow(timeframe)
  const {
    and: drizzleAnd, gte, or: drizzleOr, 
  } = await import('drizzle-orm')
  const scopeWhere = conds.length > 0 ? drizzleOr(...conds) : undefined
  // AND the scope (account) with the timeframe window — NOT OR, which would
  // match either condition independently and leak other users' old trades.
  const where = scopeWhere && windowStart
    ? drizzleAnd(scopeWhere, gte(tradeAuditLog.exitDate, windowStart))
    : scopeWhere ?? (windowStart ? gte(tradeAuditLog.exitDate, windowStart) : undefined)

  const rows = await localDb.select({
    ticker: tradeAuditLog.ticker,
    pnlUsd: tradeAuditLog.pnlUsd,
    pnlPercent: tradeAuditLog.pnlPercent,
    exitReason: tradeAuditLog.exitReason,
    exitDate: tradeAuditLog.exitDate,
  })
    .from(tradeAuditLog)
    .where(where)
    .orderBy(desc(tradeAuditLog.exitDate))

  if (rows.length === 0) {
    const label = TIMEFRAME_LABELS[timeframe]
    await sendGenericMessage(t('PNL_NO_TRADES', lang, { timeframe: label }), undefined, chatId)
    return
  }

  const pnlValues = rows.map(r => parseFloat(r.pnlUsd || '0'))
  const overallPnl = pnlValues.reduce((a, b) => a + b, 0)
  const wins = pnlValues.filter(v => v > 0).length
  const losses = pnlValues.filter(v => v < 0).length

  const best = rows.reduce((a, b) => parseFloat(b.pnlUsd || '0') > parseFloat(a.pnlUsd || '0') ? b : a)
  const worst = rows.reduce((a, b) => parseFloat(b.pnlUsd || '0') < parseFloat(a.pnlUsd || '0') ? b : a)

  const bestPnl = parseFloat(best.pnlUsd || '0')
  const worstPnl = parseFloat(worst.pnlUsd || '0')
  const bestPct = parseFloat(best.pnlPercent || '0')
  const worstPct = parseFloat(worst.pnlPercent || '0')

  const label = TIMEFRAME_LABELS[timeframe]
  const periodStr = windowStart
    ? `${formatDateCompact(windowStart)} - ${formatDateCompact(new Date())}`
    : t('PNL_ALL_TIME', lang)

  let msg = `${t('PNL_TITLE', lang, { timeframe: label })}\n`
  msg += `${t('PNL_PERIOD', lang)}: ${periodStr}\n\n`
  msg += `${t('PNL_OVERALL', lang)}: ${overallPnl >= 0 ? '+' : ''}$${overallPnl.toFixed(2)}\n`
  msg += `${t('PNL_TRADES', lang)}: ${rows.length} (${wins} ${t('PNL_WINS', lang)} / ${losses} ${t('PNL_LOSSES', lang)})\n\n`

  msg += `${t('PNL_BEST', lang)}: ${best.ticker} ${bestPnl >= 0 ? '+' : ''}$${bestPnl.toFixed(2)} (${bestPct >= 0 ? '+' : ''}${bestPct.toFixed(1)}%)\n`
  msg += `${t('PNL_WORST', lang)}: ${worst.ticker} ${worstPnl >= 0 ? '+' : ''}$${worstPnl.toFixed(2)} (${worstPct >= 0 ? '+' : ''}${worstPct.toFixed(1)}%)`

  // Compact trade list (last 10)
  const listRows = rows.slice(0, 10)
  if (listRows.length > 0) {
    msg += `\n\n<b>${t('PNL_TRADE_LIST', lang)}:</b>\n`
    for (const r of listRows) {
      const pnl = parseFloat(r.pnlUsd || '0')
      const d = r.exitDate ? formatDateCompact(r.exitDate) : '--'
      const sign = pnl >= 0 ? '+' : ''
      msg += `  ${d} ${r.ticker} ${sign}$${pnl.toFixed(2)} (${r.exitReason})\n`
    }
    if (rows.length > 10) {
      msg += `  ${t('PNL_MORE', lang, { n: rows.length - 10 })}\n`
    }
  }

  await sendGenericMessage(local(msg), undefined, chatId)
}
