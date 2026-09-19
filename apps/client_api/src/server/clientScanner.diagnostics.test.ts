import {
  describe, expect, it, mock, 
} from 'bun:test'

// ---------------------------------------------------------------------------
// Module mocks — same discipline as clientScanner.gate.test.ts: only
// ~/services/telegramService is mocked (established convention; every scanner
// test file registers its own, so leaks are overwritten). The screener and
// diagnostics themselves run REAL — diagnoseZeroSignalScan is pure.
// ---------------------------------------------------------------------------

// Order-proofing: capture the CURRENT module surface and spread it below —
// mock.module is process-global and never restored between bun test files,
// so a partial export set starves later importers in shuffled orders.
const realTelegramService = await import('~/services/telegramService')
mock.module('~/services/telegramService', () => ({
  ...realTelegramService,
  sendGenericMessage: mock((...args: unknown[]) => {
    void args
    return Promise.resolve(1)
  }),
  sendRawTelegram: mock(() => Promise.resolve({ ok: true })),
  getChatLanguage: mock(() => Promise.resolve('en')),
}))

const { diagnoseZeroSignalScan } = await import('~/server/clientScanner')

/**
 * AST whose universe gates mirror the shipped AI_COMBINED defaults
 * (minMarketCap $1B, minAvgVolume 500k). The single branch never matches
 * these records (rsi > 90), so branch-side near-misses stay out of the way
 * and the universe-gate tallies are the only signal under test.
 */
const GATED_AST = {
  strategyName: 'TEST_GATED',
  minScoreToEmit: 1.5,
  universe: { minMarketCap: 1_000_000_000, minAvgVolume: 500_000 },
  entryLogic: {
    or: [
      {
        name: 'Never Branch',
        and: [
          { indicator: 'rsi', operator: '>', value: 90 },
        ],
        weight: 1.0,
      },
    ],
  },
}

const baseRecord = {
  price: 200,
  rsi: 55,
  sma20: 190,
  sma50: 180,
  sma200: 150,
  volumePace: 1.0,
  newsScore: 6.0,
  insiderScore: 6.0,
  macro: { regime: 'RISK_ON', vix: 18, putCallRatio: 0.95 },
}

describe('diagnoseZeroSignalScan — universe-gate rejection tallies', () => {
  it('counts avgVolume-missing rejections that branch near-misses cannot see', () => {
    const metrics = [
      {
        ...baseRecord, ticker: 'AAA', avgVolume: 0, marketCap: 5_000_000_000, 
      },
      {
        ...baseRecord, ticker: 'BBB', avgVolume: 0, marketCap: 3_000_000_000, 
      },
      {
        ...baseRecord, ticker: 'SPY', avgVolume: 0, marketCap: 5_000_000_000, 
      },
    ]
    const diag = diagnoseZeroSignalScan(
      metrics as never, GATED_AST as never, 300, 'BALANCED',
    )
    expect(diag.evaluated).toBe(2) // SPY is a macro-index ETF — skipped
    expect(diag.universeGateRejects.avgVolumeMissing).toBe(2)
    expect(diag.nearMissBranchCounts).toEqual({})
    expect(diag.topNearMisses).toEqual([])
  })

  it('counts avgVolume-below-floor rejections separately from missing', () => {
    const metrics = [
      {
        ...baseRecord, ticker: 'LOWVOL', avgVolume: 100_000, marketCap: 5_000_000_000, 
      },
    ]
    const diag = diagnoseZeroSignalScan(
      metrics as never, GATED_AST as never, 300, 'BALANCED',
    )
    expect(diag.universeGateRejects.avgVolumeBelowFloor).toBe(1)
    expect(diag.universeGateRejects.avgVolumeMissing).toBeUndefined()
  })

  it('counts marketCap-missing rejections', () => {
    const metrics = [
      {
        ...baseRecord, ticker: 'NOCAP', avgVolume: 5_000_000, marketCap: 0, 
      },
    ]
    const diag = diagnoseZeroSignalScan(
      metrics as never, GATED_AST as never, 300, 'BALANCED',
    )
    expect(diag.universeGateRejects.marketCapMissing).toBe(1)
  })

  it('counts marketCap-below-floor rejections', () => {
    const metrics = [
      {
        ...baseRecord, ticker: 'SMALLCAP', avgVolume: 5_000_000, marketCap: 500_000_000, 
      },
    ]
    const diag = diagnoseZeroSignalScan(
      metrics as never, GATED_AST as never, 300, 'BALANCED',
    )
    expect(diag.universeGateRejects.marketCapBelowFloor).toBe(1)
  })

  it('gate-passing tickers with no branch match produce no gate rejects', () => {
    const metrics = [
      {
        ...baseRecord, ticker: 'HEALTHY', avgVolume: 5_000_000, marketCap: 5_000_000_000, 
      },
    ]
    const diag = diagnoseZeroSignalScan(
      metrics as never, GATED_AST as never, 300, 'BALANCED',
    )
    expect(diag.universeGateRejects).toEqual({})
    expect(diag.evaluated).toBe(1)
  })

  it('still reports branch near-misses for gate-passing suppressed matches', () => {
    const ast = {
      ...GATED_AST,
      minScoreToEmit: 1.5,
      entryLogic: {
        or: [
          {
            name: 'Half Weight Branch',
            and: [
              { indicator: 'rsi', operator: '>', value: 50 },
            ],
            weight: 0.5,
          },
        ],
      },
    }
    const metrics = [
      {
        ...baseRecord, ticker: 'NEARMISS', avgVolume: 5_000_000, marketCap: 5_000_000_000, 
      },
    ]
    const diag = diagnoseZeroSignalScan(
      metrics as never, ast as never, 300, 'BALANCED',
    )
    expect(diag.universeGateRejects).toEqual({})
    expect(diag.nearMissBranchCounts['Half Weight Branch']).toBe(1)
    expect(diag.topNearMisses[0]!.ticker).toBe('NEARMISS')
  })
})
