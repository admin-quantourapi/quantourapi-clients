import {
  Language, t,
} from '@quantour/shared-algo/src/core/i18n'
import { eq } from 'drizzle-orm'

import { db as localDb } from '~/db'
import {
  portfolioStats, settings,
} from '~/db/clientSchema'
import {
  sendGenericMessage, sendRawTelegram,
} from '~/services/telegramService'

import {
  getUserBudget, setUserBudget,
} from '../budgetService'

export async function handleSetName(chatId: string, name: string, lang: Language = 'en') {
  await localDb.update(settings).set({ userName: name }).where(eq(settings.telegramChatId, chatId))
  await sendGenericMessage(t('NAME_UPDATED', lang, { name }), undefined, chatId)
}

export async function handleSetCapital(chatId: string, amount: number, lang: Language = 'en') {
  if (isNaN(amount) || amount <= 0) {
    await sendGenericMessage(t('INVALID_AMOUNT', lang), undefined, chatId)
    return
  }

  const userSettingsRow = (await localDb.select().from(settings).where(eq(settings.telegramChatId, chatId)).limit(1))[0]
  await setUserBudget(localDb, userSettingsRow?.userId, {
    totalCapital: amount.toString(),
  })

  const existingStats = await localDb.select().from(portfolioStats).where(eq(portfolioStats.chatId, chatId)).limit(1)
  if (existingStats.length > 0) {
    await localDb.update(portfolioStats).set({ currentCapital: amount.toString() }).where(eq(portfolioStats.chatId, chatId))
  } else {
    await localDb.insert(portfolioStats).values({
      chatId,
      initialCapital: amount.toString(),
      currentCapital: amount.toString(),
      dailyStartingCapital: amount.toString(),
      weeklyStartingCapital: amount.toString(),
      monthlyStartingCapital: amount.toString(),
    })
  }

  await sendGenericMessage(t('CAPITAL_UPDATED', lang, { amount: amount.toLocaleString() }), undefined, chatId)
}

export async function handleSetRisk(chatId: string, amount: string | number, lang: Language = 'en') {
  const isPercent = typeof amount === 'string' && amount.endsWith('%')
  const numAmount = isPercent ? parseFloat(amount.replace('%', '')) : parseFloat(amount.toString())

  if (isNaN(numAmount) || numAmount < 0) {
    await sendGenericMessage(t('INVALID_AMOUNT', lang), undefined, chatId)
    return
  }
  
  const savedValue = isPercent ? `${numAmount}%` : numAmount.toString()
  const userSettings = (await localDb.select().from(settings).where(eq(settings.telegramChatId, chatId)).limit(1))[0]
  await setUserBudget(localDb, userSettings?.userId, { maxRiskPerTrade: savedValue })
  const budget = await getUserBudget(localDb, userSettings?.userId)
  const totalBudget = parseFloat(budget.totalCapital)

  const displayMsg = numAmount === 0
    ? t('RISK_SET_AUTO', lang)
    : (isPercent
      ? t('RISK_UPDATED_PERCENT', lang, {
        percent: numAmount.toString(),
        riskUsd: Math.round((totalBudget * numAmount) / 100).toLocaleString(),
        budget: totalBudget.toLocaleString(),
      })
      : t('RISK_UPDATED_USD', lang, {
        riskUsd: numAmount.toLocaleString(),
        percent: totalBudget > 0 ? ((numAmount / totalBudget) * 100).toFixed(2) : '0',
        budget: totalBudget.toLocaleString(),
      }))
    
  await sendGenericMessage(displayMsg, undefined, chatId)
  await sendGenericMessage(t('PROMPT_CHOOSE_MODE', lang), undefined, chatId)
}

export async function handleSetBudget(chatId: string, isEnabled: boolean, lang: Language = 'en') {
  await localDb.update(settings).set({ isBudgetAware: isEnabled }).where(eq(settings.telegramChatId, chatId))
  await sendGenericMessage(t(isEnabled ? 'BUDGET_MODE_ON' : 'BUDGET_MODE_OFF', lang), undefined, chatId)
}

export async function handleMode(chatId: string, lang: Language = 'en') {
  const chat = (await localDb.select().from(settings).where(eq(settings.telegramChatId, chatId)).limit(1))[0]
  if (!chat) return

  const nextMode = chat.signalMode === 'all' ? 'silent' : 'all'
  await localDb.update(settings).set({ signalMode: nextMode }).where(eq(settings.telegramChatId, chatId))
  await sendGenericMessage(t('MODE_UPDATED', lang, { mode: nextMode.toUpperCase() }), undefined, chatId)
}

export async function handleSetSilent(chatId: string, arg?: string, lang: Language = 'en') {
  const chat = (await localDb.select().from(settings).where(eq(settings.telegramChatId, chatId)).limit(1))[0]
  let isSilent = chat ? chat.signalMode !== 'silent' : true

  if (arg) {
    const cleanArg = arg.trim().toLowerCase()
    if (cleanArg === 'on' || cleanArg === 'true' || cleanArg === '1') {
      isSilent = true
    } else if (cleanArg === 'off' || cleanArg === 'false' || cleanArg === '0') {
      isSilent = false
    }
  }

  const nextMode = isSilent ? 'silent' : 'all'
  await localDb.update(settings).set({ signalMode: nextMode }).where(eq(settings.telegramChatId, chatId))
  await sendGenericMessage(t(isSilent ? 'SILENT_MODE_ON' : 'SILENT_MODE_OFF', lang), undefined, chatId)
}

export async function handleStrategyMenu(chatId: string, lang: Language = 'en') {
  await sendGenericMessage(t('STRATEGY_MENU', lang), undefined, chatId)
}

export async function handleRiskProfileMenu(chatId: string, lang: Language = 'en') {
  const userSettings = (await localDb.select().from(settings).where(eq(settings.telegramChatId, chatId)).limit(1))[0]
  const budget = await getUserBudget(localDb, userSettings?.userId)
  const currentRisk = budget.maxRiskPerTrade || '300'
  const currentProfile = userSettings?.riskProfile || 'BALANCED'

  const currentRiskDisplay = currentRisk.endsWith('%')
    ? currentRisk
    : (parseFloat(currentRisk) > 0 ? `$${parseFloat(currentRisk).toLocaleString()}` : t('RISK_SETTING_AUTO', lang))

  const msg = t('RISK_PROFILE_MENU', lang, { currentRiskDisplay, currentProfile })

  await sendRawTelegram('sendMessage', {
    chat_id: chatId,
    text: msg,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          { text: `${currentProfile === 'AGGRESSIVE' ? '✅ ' : ''}🔴 AGGRESSIVE`, callback_data: 'set_risk:AGGRESSIVE' },
          { text: `${currentProfile === 'BALANCED' ? '✅ ' : ''}🟡 BALANCED`, callback_data: 'set_risk:BALANCED' },
        ],
        [
          { text: `${currentProfile === 'CONSERVATIVE' ? '✅ ' : ''}🟢 CONSERVATIVE`, callback_data: 'set_risk:CONSERVATIVE' },
        ],
      ],
    },
  })
}

export async function handleSetRiskProfile(chatId: string, profile: 'AGGRESSIVE' | 'BALANCED' | 'CONSERVATIVE', lang: Language = 'en') {
  await localDb.update(settings).set({ riskProfile: profile }).where(eq(settings.telegramChatId, chatId))
  await sendGenericMessage(t('RISK_PROFILE_CHANGED', lang, { profile }), undefined, chatId)
}

export async function handleRiskGuide(chatId: string, lang: Language = 'en') {
  await sendGenericMessage(t('RISK_GUIDE', lang), undefined, chatId)
}
