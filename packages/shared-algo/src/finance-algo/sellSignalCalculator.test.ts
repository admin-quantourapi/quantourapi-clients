import {
  describe, expect, test, 
} from 'bun:test'

import { calculateSellSignal } from './sellSignalCalculator'

const base = {
  highestHigh: 110,
  stopLoss: 95,
  entry: 100,
  risk: 5,
  isPartialTaken: false,
  daysHeld: 3,
  stage: 0,
  strategyName: 'T',
  target: 115,
  direction: 'LONG' as const,
}

describe('calculateSellSignal — stop trigger semantics (2026-08-21)', () => {
  test('wick mode (default): low touching the stop triggers', () => {
    const r = calculateSellSignal(
      { ...base }, 101, 94.5, 100, false, false, 100, 100,
    )
    expect(r.exitReason).toBe('STOP_LOSS_HIT')
  })

  test('wick mode via explicit param matches default', () => {
    const r = calculateSellSignal(
      { ...base }, 101, 94.5, 100, false, false, 100, 100, 'wick',
    )
    expect(r.exitReason).toBe('STOP_LOSS_HIT')
  })

  test('close mode: wick through stop but close recovered → HOLD (sweep ignored)', () => {
    const r = calculateSellSignal(
      { ...base }, 101, 94.5, 99, false, false, 100, 100, 'close',
    )
    expect(r.exitReason).toBeNull()
  })

  test('close mode: close THROUGH the stop triggers', () => {
    const r = calculateSellSignal(
      { ...base }, 101, 94.5, 94, false, false, 100, 100, 'close',
    )
    expect(r.exitReason).toBe('STOP_LOSS_HIT')
  })

  test('close mode: close exactly at the stop triggers (<=)', () => {
    const r = calculateSellSignal(
      { ...base }, 101, 94, 95, false, false, 100, 100, 'close',
    )
    expect(r.exitReason).toBe('STOP_LOSS_HIT')
  })

  test('gap-through logic unaffected by mode: open beyond stop exits in close mode too', () => {
    const r = calculateSellSignal(
      { ...base }, 96, 92, 94, false, false, 93, 100, 'close',
    )
    expect(r.exitReason?.startsWith('GAP_BEYOND_STOP')).toBe(true)
  })
})
