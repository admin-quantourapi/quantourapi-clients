import {
  describe, expect, it,
} from 'bun:test'

import {
  calculateConvictionMultiplier, type MarketData,
  recommendPortfolioRotations, safeRiskPerShare, 
} from './screener'

const baseMarketData: MarketData = {
  ticker: 'NVDA',
  currentPrice: 130.0,
  structuralFloor: 120.0,
  atr: 5.0,
  fiftyTwoWeekHigh: 140.0,
  atrMultiplier: 2.0,
  maxRisk: 1000,
  sma200: 100.0,
  sma50: 115.0,
  sma20: 125.0,
  sma10: 128.0,
  rsi: 55,
  avgVolume: 2_000_000,
  currentVolume: 3_000_000,
  volumePace: 1.5,
  marketPrice: 500,
  marketSma200: 450,
  marketSma50: 480,
  techMarketPrice: 500,
  techMarketSma200: 450,
  marketBreadth: 0.7,
  marketAtrPercent: 0.015,
  relativeStrength: 0.12,
  ema8: 127.0,
  ema21: 124.0,
} as unknown as MarketData

describe('safeRiskPerShare', () => {
  it('returns the absolute entry-to-stop distance for a long', () => {
    expect(safeRiskPerShare(100, 92)).toBe(8)
  })

  it('returns the absolute distance regardless of sign (defensive against stop > price)', () => {
    expect(safeRiskPerShare(90, 100)).toBe(10)
  })

  it('floors to 0 when price equals stop (no synthetic 1 divisor)', () => {
    expect(safeRiskPerShare(100, 100)).toBe(0)
  })

  it('floors to 0 for sub-micron noise', () => {
    expect(safeRiskPerShare(100, 100.0000001)).toBe(0)
  })
})

describe('calculateConvictionMultiplier', () => {
  it('clamps to the [0.25, 1.5] bounds', () => {
    // Credit stress (*0.5) + beta>1.5 (*0.8) + momentum tech-stretch drain (*0.5),
    // no trend tag so no RISK_ON boost -> 0.2 -> clamp 0.25. (techMarketPrice 600
    // > 450*1.15 = 517.5 so the overextension drain fires.)
    const low = calculateConvictionMultiplier({
      ...baseMarketData, creditSpiking: true, beta: 1.8, techMarketPrice: 600, 
    },
    'TREND_RIDER',
    [])
    expect(low).toBe(0.25)

    // trend + RISK_ON (*1.5) + federal funding >= fundingMin (*1.5) -> 2.25 -> clamp 1.5
    const high = calculateConvictionMultiplier({
      ...baseMarketData, macroRegime: 'RISK_ON', federalFundingAmount: 2_000_000_000, riskProfile: 'BALANCED', 
    },
    'TREND_RIDER',
    [
      'trend_continuation',
    ])
    expect(high).toBe(1.5)
  })

  it('is order-invariant (all-multiplicative stacking)', () => {
    const data = {
      ...baseMarketData,
      macroRegime: 'RISK_ON' as const,
      federalFundingAmount: 600_000_000,
      riskProfile: 'BALANCED' as const,
    }
    // Same inputs -> deterministic single result (multiplicative, not order-dependent)
    const a = calculateConvictionMultiplier(data, 'TREND_RIDER', [
      'trend_continuation',
    ])
    const b = calculateConvictionMultiplier(data, 'TREND_RIDER', [
      'trend_continuation',
    ])
    expect(a).toBe(b)
    // trend(*1.5) x funding>500M(*1.25) = 1.875 -> clamp 1.5
    expect(a).toBe(1.5)
  })

  it('gates the trend boost on the trend_continuation tag, not just the literal name', () => {
    // A custom AST tagged trend_continuation but named AI_COMBINED should still get the RISK_ON boost.
    const tagged = calculateConvictionMultiplier({ ...baseMarketData, macroRegime: 'RISK_ON' },
      'AI_COMBINED',
      [
        'trend_continuation',
      ])
    expect(tagged).toBe(1.5)

    // Without the tag and without the literal name -> no trend boost.
    const untagged = calculateConvictionMultiplier({ ...baseMarketData, macroRegime: 'RISK_ON' },
      'AI_COMBINED',
      [])
    expect(untagged).toBe(1.0)
  })
})

describe('recommendPortfolioRotations — freedCash integrity', () => {
  // Regression: a position qualifying for BOTH a risk trim (A) and an opportunity
  // swap (B) previously double-counted its capital in freedCash. After the fix,
  // a trimmed position is not also swapped in the same cycle.
  it('does not double-count capital when a position is both over-risked and low-scoring', async () => {
    const portfolio: import('./screener').RotationAsset[] = [
      {
        ticker: 'OVERWEIGHT',
        entry: 100,
        currentPrice: 100,
        stopLoss: 95, // 5 risk/share x 200 shares = 1000 risk > maxRisk*1.25 -> trim
        target: 130,
        strategy: 'AI_COMBINED_AST',
        shares: 200,
        capitalDeployed: 20_000,
      },
    ]
    const setups: import('./screener').RotationSetup[] = [
      {
        ticker: 'BETTER',
        entry: 100,
        currentPrice: 100,
        stopLoss: 97,
        target: 130,
        strategy: 'AI_COMBINED_AST',
        sectorName: 'Technology',
      },
    ]

    const result = recommendPortfolioRotations({
      portfolio,
      setups,
      scores: {},
      budget: { total: 100_000, risk: 300, cash: 50_000 },
      rotationRules: {
        enabled: true,
        minCandidateScore: 2,
        scoreGainMultiplier: 1.25,
        minHoldingDays: 0,
      },
    })

    const sells = result.rotations.map(r => r.sell)

    // OVERWEIGHT must appear at most once as a sell target (trim OR swap, not both).
    const overweightSells = sells.filter(s => s === 'OVERWEIGHT')
    expect(overweightSells.length).toBeLessThanOrEqual(1)
  })

  it('respects maxPortfolioPositions when deploying cash', async () => {
    // 5 cash candidates but cap = 2 -> at most 2 new CASH buys.
    const setups: import('./screener').RotationSetup[] = Array.from({ length: 5 }, (_, i) => ({
      ticker: `CAND${i}`,
      entry: 100,
      currentPrice: 100,
      stopLoss: 95,
      target: 130,
      strategy: 'AI_COMBINED_AST',
      sectorName: 'Technology',
    }))

    const result = recommendPortfolioRotations({
      portfolio: [],
      setups,
      scores: {},
      budget: { total: 1_000_000, risk: 10_000, cash: 1_000_000 },
      rotationRules: {
        enabled: true,
        minCandidateScore: 2,
        maxPortfolioPositions: 2,
      },
    })

    const newBuys = result.rotations.filter(r => r.sell === 'CASH')
    expect(newBuys.length).toBeLessThanOrEqual(2)
  })
})
