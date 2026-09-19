import { describe, expect, it } from 'bun:test'

import type { CustomStrategyAST } from './ast'
import type { MarketData } from './screener'
import {
  detectRotationVetoBlocks,
} from './rotationGateDiagnostics'
import { AI_COMBINED_AST } from '../../../strategies/src/index'

/**
 * Minimal 🔮-shaped fixture: technical arms pass (price > sma20, RSI > 62,
 * volumePace > 1.2, vix/pcr calm), score present and fresh. Whether 🔮 fires
 * is then entirely a function of the rotation gates — the ideal attribution
 * playground.
 */
function predictionFixture(overrides: Partial<MarketData> = {}): MarketData {
  const base: MarketData = {
    ticker: 'AVGO',
    currentPrice: 370,
    marketCap: 1_200_000_000_000,
    avgVolume: 2_000_000,
    currentVolume: 3_000_000,
    atr: 8,
    avgAtr: 7,
    atrMultiplier: 2,
    maxRisk: 1000,
    sma20: 360,
    sma50: 345,
    sma200: 300,
    rsi: 64,
    volumePace: 1.4,
    relativeStrength: 0.12,
    newsScore: 5.7,
    newsScoreAgeDays: 1,
    sectorNewsScore: 5.5,
    sectorName: 'Technology',
    newsScoreRank: 0.8,
    newsScoreTrend: 0.5,
    macro: { vix: 15, putCallRatio: 0.9, regime: 'RISK_ON' },
  }
  return { ...base, ...overrides }
}

describe('detectRotationVetoBlocks — attribution', () => {
  it('no events when nothing is gated (all gates pass)', () => {
    const events = detectRotationVetoBlocks(AI_COMBINED_AST, predictionFixture({ newsScore: 7.5 }))
    expect(events.find(e => e.vetoType)).toBeUndefined()
  })

  it('attributes RANK when rank 0.4 with no hot-sector rescue', () => {
    const events = detectRotationVetoBlocks(AI_COMBINED_AST, predictionFixture({ newsScoreRank: 0.4 }))
    const rank = events.find(e => e.vetoType === 'RANK')
    expect(rank).toBeDefined()
    expect(rank!.ticker).toBe('AVGO')
    expect(rank!.rank).toBe(0.4)
    expect(rank!.priceAtSignal).toBe(370)
    expect(rank!.strategyName).toBe('AI_COMBINED')
    expect(rank!.kind).toBe('VETO_BLOCK')
  })

  it('attributes TREND when the window decay crosses −1.5 (the AVGO series)', () => {
    const events = detectRotationVetoBlocks(
      AI_COMBINED_AST,
      predictionFixture({ newsScoreTrend: -1.8 }),
    )
    expect(events.some(e => e.vetoType === 'TREND' && e.trend === -1.8)).toBe(true)
  })

  it('rescued=true flags the borderline-hot sector (>= 6.0 but < 6.5)', () => {
    const events = detectRotationVetoBlocks(
      AI_COMBINED_AST,
      predictionFixture({ newsScoreRank: 0.4, sectorNewsScore: 6.2 }),
    )
    const rank = events.find(e => e.vetoType === 'RANK')
    // rescued = borderline-hot evidence present (>= 6.0) though below the
    // 6.5 rescue threshold — the analyst signal for "sector ALMOST rescued it".
    expect(rank?.rescued).toBe(true)
    const hotEvents = detectRotationVetoBlocks(
      AI_COMBINED_AST,
      predictionFixture({ newsScoreRank: 0.4, sectorNewsScore: 6.8 }),
    )
    // 6.8 clears the rescue arm → the rank group passes → no RANK event.
    expect(hotEvents.find(e => e.vetoType === 'RANK')).toBeUndefined()
  })

  it('attributes AGE when freshness gates block despite passing vetoes', () => {
    // Coasting-leader shape: high score, stale age (21d), vetoes pass.
    const events = detectRotationVetoBlocks(
      AI_COMBINED_AST,
      predictionFixture({ newsScore: 7.5, newsScoreAgeDays: 21 }),
    )
    expect(events.some(e => e.vetoType === 'AGE' && e.ageDays === 21)).toBe(true)
  })

  it('ignores non-momentum branches (dips are exempt by design)', () => {
    // A 💎-shaped fixture: deep dip that fires 💎 — must NOT produce gate events.
    const dipFixture = predictionFixture({
      currentPrice: 340, // below sma20
      rsi: 30,
      newsScore: 6.5,
      newsScoreRank: 0.4,
      newsScoreTrend: -2,
    })
    const events = detectRotationVetoBlocks(AI_COMBINED_AST, dipFixture)
    // 🔮/🔥 require price > sma20 → stripped projection fails → no events.
    expect(events.filter(e => e.branchName?.includes('High AI Conviction'))).toHaveLength(0)
    expect(events.filter(e => e.branchName?.includes('Bullish AI News Trend'))).toHaveLength(0)
  })

  it('returns [] for ASTs without veto groups', () => {
    const bareAst = {
      strategyName: 'BARE',
      entryLogic: { or: [{ name: 'X', and: [{ indicator: 'rsi', operator: '>', value: 50 }] }] },
    } as unknown as CustomStrategyAST
    expect(detectRotationVetoBlocks(bareAst, predictionFixture())).toHaveLength(0)
  })
})
