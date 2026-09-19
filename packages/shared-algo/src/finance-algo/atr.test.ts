import {
  describe, expect, it, 
} from 'bun:test'

import {
  type AtrCandle, calculateATR, computeOvernightGapAtr, computeOvernightGapPct, computeSma20ExtensionAtr, computeStopsFromAtr, 
} from './atr'

function candle(high: number, low: number, close: number): AtrCandle {
  return { high, low, close }
}

describe('calculateATR', () => {
  it('returns 0 when fewer than 2 candles', () => {
    expect(calculateATR([
      candle(10, 8, 9),
    ])).toBe(0)
    expect(calculateATR([])).toBe(0)
  })

  it('matches manual Wilder smoothing on a constant-range series', () => {
    const candles: AtrCandle[] = []
    for (let i = 0; i < 30; i++) candles.push(candle(11, 9, 10))
    const atr = calculateATR(candles, 14)
    expect(atr).toBeCloseTo(2, 10)
  })

  it('uses simple average when fewer true ranges than period', () => {
    const candles = [
      candle(10, 8, 9),
      candle(12, 9, 11),
      candle(13, 10, 12),
    ]
    const atr = calculateATR(candles, 14)
    const tr1 = Math.max(12 - 9, Math.abs(12 - 9), Math.abs(9 - 9))
    const tr2 = Math.max(13 - 10, Math.abs(13 - 11), Math.abs(10 - 11))
    expect(atr).toBeCloseTo((tr1 + tr2) / 2, 10)
  })

  it('includes overnight gaps in the true range', () => {
    const candles = [
      candle(10, 8, 9),
      candle(20, 18, 19),
    ]
    const atr = calculateATR(candles, 14)
    expect(atr).toBeCloseTo(11, 10)
  })

  it('produces a non-zero positive ATR for a realistic noisy series', () => {
    const candles: AtrCandle[] = [
      candle(104, 99, 101),
      candle(106, 101, 103),
      candle(108, 102, 105),
      candle(107, 103, 104),
      candle(110, 105, 108),
      candle(112, 107, 110),
      candle(113, 108, 109),
      candle(111, 106, 108),
      candle(114, 109, 112),
      candle(116, 111, 114),
      candle(115, 110, 113),
      candle(118, 113, 116),
      candle(119, 114, 117),
      candle(120, 115, 118),
      candle(122, 117, 120),
      candle(121, 116, 119),
    ]
    const atr = calculateATR(candles, 14)
    expect(atr).toBeGreaterThan(0)
    expect(atr).toBeLessThan(10)
  })
})

describe('computeSma20ExtensionAtr', () => {
  it('returns (price - sma20) / atr', () => {
    expect(computeSma20ExtensionAtr(130, 125, 5)).toBeCloseTo(1.0, 10)
  })

  it('returns undefined when atr is zero or non-finite', () => {
    expect(computeSma20ExtensionAtr(130, 125, 0)).toBeUndefined()
    expect(computeSma20ExtensionAtr(130, 125, Number.NaN)).toBeUndefined()
  })
})

describe('computeOvernightGapPct', () => {
  it('returns signed (open - prevClose) / prevClose', () => {
    expect(computeOvernightGapPct(97, 100)).toBeCloseTo(-0.03, 10)
    expect(computeOvernightGapPct(103, 100)).toBeCloseTo(0.03, 10)
  })

  it('returns undefined when prevClose is non-positive', () => {
    expect(computeOvernightGapPct(97, 0)).toBeUndefined()
  })
})

describe('computeOvernightGapAtr', () => {
  it('returns signed (open - prevClose) / atr', () => {
    expect(computeOvernightGapAtr(96, 100, 2)).toBeCloseTo(-2, 10)
  })

  it('returns undefined when atr is non-positive', () => {
    expect(computeOvernightGapAtr(96, 100, 0)).toBeUndefined()
  })
})

describe('computeStopsFromAtr', () => {
  it('derives 1:3 R stops at 2.5x ATR', () => {
    const stops = computeStopsFromAtr(
      100, 4, 2.5, 3,
    )
    expect(stops.risk).toBeCloseTo(10, 10)
    expect(stops.stopLoss).toBeCloseTo(90, 10)
    expect(stops.target).toBeCloseTo(130, 10)
    expect(stops.partialTarget).toBeCloseTo(120, 10)
    expect(stops.atr).toBe(4)
  })

  it('collapses to no-risk stops when ATR is 0', () => {
    const stops = computeStopsFromAtr(100, 0)
    expect(stops.risk).toBe(0)
    expect(stops.stopLoss).toBe(100)
    expect(stops.target).toBe(100)
  })
})
