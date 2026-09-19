import { isFiniteNumber } from '../utils/numbers'

export interface AtrCandle {
  high: number
  low: number
  close: number
}

export const DEFAULT_ATR_PERIOD = 14

export const DEFAULT_STOP_LOSS_ATR_MULTIPLIER = 2.5

function trueRange(current: AtrCandle, prevClose: number): number {
  const hl = current.high - current.low
  const hcpc = Math.abs(current.high - prevClose)
  const lcpc = Math.abs(current.low - prevClose)
  return Math.max(hl, hcpc, lcpc)
}

export function calculateATR(candles: AtrCandle[], period: number = DEFAULT_ATR_PERIOD): number {
  if (candles.length < 2) return 0
  const trueRanges: number[] = []
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1]
    const curr = candles[i]
    if (!prev || !curr) continue
    trueRanges.push(trueRange(curr, prev.close))
  }
  if (trueRanges.length === 0) return 0
  if (trueRanges.length < period) {
    return trueRanges.reduce((acc, val) => acc + val, 0) / trueRanges.length
  }
  let atr = trueRanges.slice(0, period).reduce((acc, val) => acc + val, 0) / period
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + (trueRanges[i] ?? 0)) / period
  }
  return atr
}

export interface PositionStops {
  stopLoss: number
  target: number
  partialTarget: number
  risk: number
  atr: number
}

export function computeSma20ExtensionAtr(price: number, sma20: number, atr: number): number | undefined {
  if (!isFiniteNumber(price) || !isFiniteNumber(sma20) || !isFiniteNumber(atr) || atr <= 0) return undefined
  return (price - sma20) / atr
}

export function computeOvernightGapPct(open: number, prevClose: number): number | undefined {
  if (!isFiniteNumber(open) || !isFiniteNumber(prevClose) || prevClose <= 0) return undefined
  return (open - prevClose) / prevClose
}

export function computeOvernightGapAtr(open: number, prevClose: number, atr: number): number | undefined {
  if (!isFiniteNumber(open) || !isFiniteNumber(prevClose) || !isFiniteNumber(atr) || atr <= 0) return undefined
  return (open - prevClose) / atr
}

export function computeStopsFromAtr(
  fillPrice: number,
  atr: number,
  stopLossAtrMultiplier: number = DEFAULT_STOP_LOSS_ATR_MULTIPLIER,
  rewardRiskRatio: number = 3,
): PositionStops {
  const safeAtr = atr > 0 ? atr : 0
  const risk = safeAtr * stopLossAtrMultiplier
  const stopLoss = fillPrice - risk
  const target = fillPrice + risk * rewardRiskRatio
  const partialTarget = fillPrice + risk * 2
  return {
    stopLoss, target, partialTarget, risk, atr: safeAtr, 
  }
}
