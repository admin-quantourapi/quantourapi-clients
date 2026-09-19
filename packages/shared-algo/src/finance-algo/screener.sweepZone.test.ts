import {
  describe, expect, test, 
} from 'bun:test'

import type { CustomStrategyAST } from './ast'
import {
  evaluateSetup, type MarketData, 
} from './screener'

// Minimal AST that always fires; stop comes from riskManagement defaults.
const ast = (stopPlacement?: 'formula' | 'sweep_zone'): CustomStrategyAST => ({
  strategyName: 'SWEEP_ZONE_TEST',
  minScoreToEmit: 1,
  riskManagement: { stopLossAtrMultiplier: 2.0, ...(stopPlacement ? { stopPlacement } : {}) },
  entryLogic: {
    or: [
      {
        name: 'Always',
        weight: 1,
        and: [
          { indicator: 'currentPrice', operator: '>', value: 0 },
        ], 
      },
    ],
  },
})

const md = (structuralFloor?: number): MarketData => {
  const base: MarketData = {
    ticker: 'TEST',
    currentPrice: 100,
    maxRisk: 300,
    atr: 2.0, // formula stop = 100 − 2×2 = 96
  }
  return structuralFloor !== undefined ? { ...base, structuralFloor } : base
}

describe('sweep-zone stop placement (2026-08-21)', () => {
  test('formula (default): stop = entry − mult×ATR regardless of floor', () => {
    const r = evaluateSetup(md(99), { custom: ast() })
    expect(r[0]?.stopLoss).toBeCloseTo(96, 6)
  })

  test('sweep_zone: floor ABOVE formula stop → formula unchanged (never tightened)', () => {
    // floor 99, sweep stop = 99 − 1.5 = 97.5 > formula 96 → keep 96
    const r = evaluateSetup(md(99), { custom: ast('sweep_zone') })
    expect(r[0]?.stopLoss).toBeCloseTo(96, 6)
  })

  test('sweep_zone: floor just above formula stop → stop anchored below floor − 0.75×ATR', () => {
    // floor 97 → sweep stop = 97 − 1.5 = 95.5 < 96 → take 95.5 (bounded: min 96−1.5×4=90 … 95.5 fine)
    const r = evaluateSetup(md(97), { custom: ast('sweep_zone') })
    expect(r[0]?.stopLoss).toBeCloseTo(95.5, 6)
  })

  test('sweep_zone: widening bounded to 1.5× formula distance', () => {
    // floor 80 → sweep stop = 78.5; widest allowed = 100 − 1.5×4 = 94 → stop 94
    const r = evaluateSetup(md(80), { custom: ast('sweep_zone') })
    expect(r[0]?.stopLoss).toBeCloseTo(94, 6)
  })

  test('sweep_zone: missing structuralFloor → formula stop (fail-closed)', () => {
    const r = evaluateSetup(md(undefined), { custom: ast('sweep_zone') })
    expect(r[0]?.stopLoss).toBeCloseTo(96, 6)
  })
})
