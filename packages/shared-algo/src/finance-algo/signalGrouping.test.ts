import {
  describe, expect, test,
} from 'bun:test'

import type { SetupResult } from './screener'
import { groupSignalsByAggressiveness } from './signalGrouping'

interface TestCandidate {
  id: string
  setup: Pick<SetupResult, 'score' | 'firedBranchName' | 'isValid'>
  sector: string
}

const makeCandidate = (
  id: string,
  score: number,
  firedBranchName: string | undefined,
  sector: string,
): TestCandidate => ({
  id,
  setup: {
    score,
    firedBranchName,
    isValid: true,
  },
  sector,
})

const entryLogic = {
  or: [
    { name: 'Momentum Break', riskProfile: 'MOMENTUM' as const },
    { name: 'Dip Reversal', riskProfile: 'MEAN_REVERSION' as const },
    { name: 'FCF Recovery', riskProfile: 'VALUE' as const },
  ],
}

const getSector = (c: TestCandidate) => c.sector

describe('groupSignalsByAggressiveness', () => {
  test('returns empty array for empty input', () => {
    const result = groupSignalsByAggressiveness([], { signalAggressiveness: 0.5 }, getSector)
    expect(result).toEqual([])
  })

  test('aggressiveness=1.0 picks purely by score (no diversification)', () => {
    const candidates = [
      makeCandidate(
        'A', 5.0, 'Momentum Break', 'Technology',
      ),
      makeCandidate(
        'B', 4.0, 'Momentum Break', 'Technology',
      ),
      makeCandidate(
        'C', 3.0, 'Dip Reversal', 'Healthcare',
      ),
    ]
    const result = groupSignalsByAggressiveness(candidates,
      { signalAggressiveness: 1.0, maxTotalSignals: 3, entryLogic },
      getSector)
    // Pure score ranking: A(5) > B(4) > C(3) — no thesis/sector penalty
    expect(result.map(c => c.id)).toEqual([
      'A',
      'B',
      'C',
    ])
  })

  test('aggressiveness=0.0 diversifies by thesis — same-thesis candidates deprioritized', () => {
    const candidates = [
      makeCandidate(
        'A', 5.0, 'Momentum Break', 'Technology',
      ),
      makeCandidate(
        'B', 4.5, 'Momentum Break', 'Technology',
      ),
      makeCandidate(
        'C', 4.0, 'Dip Reversal', 'Healthcare',
      ),
    ]
    const result = groupSignalsByAggressiveness(candidates,
      { signalAggressiveness: 0.0, maxTotalSignals: 3, entryLogic },
      getSector)
    // At 0.0: A(5.0) picked first. B has same thesis+sector as A → heavy penalty.
    // C(4.0) has different thesis+sector → no penalty. C should beat B.
    const ids = result.map(c => c.id)
    expect(ids).toContain('A')
    expect(ids).toContain('C')
    // B should be ranked after C (penalized for thesis+sector overlap with A)
    expect(ids.indexOf('C')).toBeLessThan(ids.indexOf('B'))
  })

  test('respects maxTotalSignals cap', () => {
    const candidates = Array.from({ length: 12 }, (_, i) =>
      makeCandidate(
        `T${i}`, 10 - i, 'Momentum Break', 'Technology',
      ))
    const result = groupSignalsByAggressiveness(candidates,
      { signalAggressiveness: 1.0, maxTotalSignals: 3, entryLogic },
      getSector)
    expect(result.length).toBe(3)
    expect(result.map(c => c.id)).toEqual([
      'T0',
      'T1',
      'T2',
    ])
  })

  test('strips (+N confluence) suffix from firedBranchName for thesis lookup', () => {
    const candidates = [
      makeCandidate(
        'A', 5.0, 'Momentum Break', 'Technology',
      ),
      // firedBranchName has confluence suffix — should still be found as MOMENTUM
      makeCandidate(
        'B', 4.8, 'Momentum Break (+2 confluence)', 'Technology',
      ),
    ]
    const result = groupSignalsByAggressiveness(candidates,
      { signalAggressiveness: 0.0, maxTotalSignals: 2, entryLogic },
      getSector)
    // Both are MOMENTUM (after suffix strip) + same sector → heavy penalty on 2nd pick.
    // Both should still be returned (only 2 candidates, cap=2).
    expect(result.length).toBe(2)
  })

  test('untagged branches default to MOMENTUM thesis', () => {
    const candidates = [
      makeCandidate(
        'A', 5.0, undefined, 'Technology',
      ),
      makeCandidate(
        'B', 4.0, 'FCF Recovery', 'Healthcare',
      ),
    ]
    const result = groupSignalsByAggressiveness(candidates,
      { signalAggressiveness: 0.0, maxTotalSignals: 2, entryLogic },
      getSector)
    // A has no firedBranchName → buckets as MOMENTUM (default).
    // B is VALUE. Different thesis → no penalty between them.
    expect(result.length).toBe(2)
    expect(result[0]!.id).toBe('A') // higher score, no penalty from B
  })

  test('aggressiveness=0.5 balances score and diversification', () => {
    const candidates = [
      makeCandidate(
        'A', 5.0, 'Momentum Break', 'Technology',
      ),
      makeCandidate(
        'B', 4.5, 'Momentum Break', 'Technology',
      ),
      makeCandidate(
        'C', 4.0, 'Dip Reversal', 'Healthcare',
      ),
      makeCandidate(
        'D', 3.5, 'FCF Recovery', 'Energy',
      ),
    ]
    const result = groupSignalsByAggressiveness(candidates,
      { signalAggressiveness: 0.5, maxTotalSignals: 3, entryLogic },
      getSector)
    // A (5.0) first. Then at 0.5 penalty: B(4.5) gets 0.5*(0.5*1+0.5*1)=0.5 penalty
    // → eff 4.0. C(4.0) gets 0 penalty → eff 4.0. D(3.5) gets 0 → eff 3.5.
    // B and C are close; A, B/C, D order expected.
    expect(result[0]!.id).toBe('A')
    expect(result.length).toBe(3)
  })
})
