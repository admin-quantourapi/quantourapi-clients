import {
  describe, expect, it,
} from 'bun:test'

import { AstEvaluator } from './AstEvaluator'

describe('AstEvaluator - exists / missing operators', () => {
  it('exists returns true for a present number (incl. 0) and false for null/undefined', () => {
    expect(AstEvaluator.evaluate({ indicator: 'x', operator: 'exists' }, { x: 6.5 })).toBe(true)
    expect(AstEvaluator.evaluate({ indicator: 'x', operator: 'exists' }, { x: 0 })).toBe(true)
    expect(AstEvaluator.evaluate({ indicator: 'x', operator: 'exists' }, { x: null })).toBe(false)
    expect(AstEvaluator.evaluate({ indicator: 'x', operator: 'exists' }, {})).toBe(false)
  })

  it('missing is the exact inverse of exists', () => {
    expect(AstEvaluator.evaluate({ indicator: 'x', operator: 'missing' }, { x: 6.5 })).toBe(false)
    expect(AstEvaluator.evaluate({ indicator: 'x', operator: 'missing' }, { x: 0 })).toBe(false)
    expect(AstEvaluator.evaluate({ indicator: 'x', operator: 'missing' }, { x: null })).toBe(true)
    expect(AstEvaluator.evaluate({ indicator: 'x', operator: 'missing' }, {})).toBe(true)
  })

  it('exists/missing resolve nested dotted paths', () => {
    expect(AstEvaluator.evaluate({ indicator: 'macro.vix', operator: 'exists' }, { macro: { vix: 18 } })).toBe(true)
    expect(AstEvaluator.evaluate({ indicator: 'macro.vix', operator: 'exists' }, { macro: {} })).toBe(false)
    expect(AstEvaluator.evaluate({ indicator: 'macro.vix', operator: 'missing' }, { macro: { vix: null } })).toBe(true)
  })

  it('empty and/or groups are invalid syntax (fail closed)', () => {
    expect(AstEvaluator.evaluate({ and: [] }, {})).toBe(false)
    expect(AstEvaluator.evaluate({ or: [] }, {})).toBe(false)
    expect(AstEvaluator.evaluate({
      and: [],
      or: [
        { indicator: 'x', operator: '>', value: 0 },
      ], 
    }, { x: 1 })).toBe(false)
  })

  it('exists/missing ignore value/target operands', () => {
    // No value/target supplied — should still evaluate purely on presence
    expect(AstEvaluator.evaluate({ indicator: 'x', operator: 'exists' }, { x: 1 })).toBe(true)
    expect(AstEvaluator.evaluate({ indicator: 'x', operator: 'missing', value: 99 }, { x: 1 })).toBe(false)
  })
})

describe('AstEvaluator - conditional AI fallback (relaxed-if-exists, tight-if-missing)', () => {
  // Mirrors AI_COMBINED Branch 4 structure: [AI-arm, relaxed-if-exists, tight-if-missing]
  const branch = {
    name: '🏛️ Insider Buying Dip Reversal',
    and: [
      { indicator: 'currentPrice', operator: '<', target: 'sma20' },
      {
        or: [
          { indicator: 'insiderScore', operator: '>=', value: 6.0 },
          {
            and: [
              { indicator: 'insiderScore', operator: 'exists' },
              { indicator: 'volumePace', operator: '>', value: 2.0 },
            ],
          },
          {
            and: [
              { indicator: 'insiderScore', operator: 'missing' },
              { indicator: 'rsi', operator: '<', value: 35 },
              { indicator: 'volumePace', operator: '>', value: 2.0 },
            ],
          },
        ],
      },
    ],
  }

  const base = {
    currentPrice: 120,
    sma20: 125,
    sma50: 115,
    sma200: 100,
    rsi: 30,
    volumePace: 2.5,
  }

  it('fires the AI arm when insiderScore >= 6.0', () => {
    expect(AstEvaluator.evaluate(branch, { ...base, insiderScore: 7.0 })).toBe(true)
  })

  it('fires the RELAXED arm when AI data exists but is below threshold (insiderScore present, < 6.0, volume confirms)', () => {
    // insiderScore = 4 (exists, fails AI arm) → relaxed arm: exists AND volumePace>2 → true
    expect(AstEvaluator.evaluate(branch, { ...base, insiderScore: 4.0 })).toBe(true)
  })

  it('fires the TIGHT arm when AI data is MISSING and rsi<35 + volumePace>2.0 corroborate', () => {
    // No insiderScore key at all → missing arm: rsi<35 AND volumePace>2 → true
    expect(AstEvaluator.evaluate(branch, { ...base })).toBe(true)
  })

  it('does NOT fire when AI data is missing AND the tight corroboration is absent (rsi too high)', () => {
    // No insiderScore; rsi=40 fails rsi<35 → tight arm fails; no other arm can fire
    expect(AstEvaluator.evaluate(branch, { ...base, rsi: 40 })).toBe(false)
  })

  it('does NOT fire when AI data is missing AND volume is too low (no accumulation proof)', () => {
    expect(AstEvaluator.evaluate(branch, { ...base, volumePace: 1.2 })).toBe(false)
  })

  it('relaxed arm requires AI data to EXIST — a null score falls through to the tight arm', () => {
    // insiderScore explicitly null → exists=false, missing=true → must satisfy the tight arm
    expect(AstEvaluator.evaluate(branch, { ...base, insiderScore: null, rsi: 40 })).toBe(false)
    expect(AstEvaluator.evaluate(branch, { ...base, insiderScore: null, rsi: 30 })).toBe(true)
  })
})
