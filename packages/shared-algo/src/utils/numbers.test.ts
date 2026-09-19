import {
  describe, expect, it, 
} from 'bun:test'

import { isFiniteNumber } from './numbers'

describe('isFiniteNumber', () => {
  it('accepts finite numbers including 0', () => {
    expect(isFiniteNumber(0)).toBe(true)
    expect(isFiniteNumber(-1.5)).toBe(true)
  })

  it('rejects non-finite numbers and non-numbers', () => {
    expect(isFiniteNumber(Number.NaN)).toBe(false)
    expect(isFiniteNumber(Number.POSITIVE_INFINITY)).toBe(false)
    expect(isFiniteNumber(null)).toBe(false)
    expect(isFiniteNumber(undefined)).toBe(false)
    expect(isFiniteNumber('1')).toBe(false)
  })
})
