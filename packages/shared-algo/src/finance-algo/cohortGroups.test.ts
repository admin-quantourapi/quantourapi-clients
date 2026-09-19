import {
  describe, expect, it, 
} from 'bun:test'

import type { CohortGroupRule } from './ast'
import {
  buildLeaderExcessMap,
  cohortCapitalAction,
  cohortEntryRejectReason,
  excess20dAt,
  assignMembersByCorr,
  mapMacroToCohortGroups,
  memberPolicyFromCorr,
  parseExplicitTickers,
  parseTickerList,
  resolveCohortMembership,
  weakestLeaderExcess,
} from './cohortGroups'

const infra: CohortGroupRule = {
  name: 'AI_INFRA',
  leaders: [
    'NVDA',
  ],
  members: [
    'ASML',
    'TSM',
  ],
  memberPolicy: 'FOLLOW',
}

const robots: CohortGroupRule = {
  name: 'AI_ROBOTICS',
  leaders: [
    'NVDA',
  ],
  members: [
    'CAT',
  ],
  memberPolicy: 'REVERSE',
  capitalFlip: 'ROTATE_TO_MEMBERS',
  leaderPolicy: 'SIGNAL_ONLY',
}

const groups = [
  infra,
  robots,
]

describe('resolveCohortMembership', () => {
  it('NVDA is LEADER of the first group that lists it as leader (infra before robotics)', () => {
    expect(resolveCohortMembership('nvda', groups)).toEqual({
      group: infra, role: 'LEADER',
    })
  })

  it('ASML follows infra; CAT reverses vs the same NVDA leader', () => {
    expect(resolveCohortMembership('ASML', groups)?.group.name).toBe('AI_INFRA')
    expect(resolveCohortMembership('ASML', groups)?.role).toBe('MEMBER')
    expect(resolveCohortMembership('CAT', groups)?.group.name).toBe('AI_ROBOTICS')
    expect(resolveCohortMembership('CAT', groups)?.role).toBe('MEMBER')
  })

  it('unknown ticker is not gated', () => {
    expect(resolveCohortMembership('XOM', groups)).toBeUndefined()
    expect(resolveCohortMembership('AMD', undefined)).toBeUndefined()
  })
})

describe('cohortEntryRejectReason — NVDA / ASML FOLLOW vs CAT REVERSE', () => {
  it('FOLLOW ASML emits only while NVDA beats SPY', () => {
    expect(cohortEntryRejectReason('ASML', groups, {
      NVDA: 0.04,
    })).toBeUndefined()
    expect(cohortEntryRejectReason('ASML', groups, {
      NVDA: -0.02,
    })).toContain('FOLLOW AI_INFRA')
  })

  it('REVERSE CAT emits only while NVDA lags SPY', () => {
    expect(cohortEntryRejectReason('CAT', groups, {
      NVDA: -0.03,
    })).toBeUndefined()
    expect(cohortEntryRejectReason('CAT', groups, {
      NVDA: 0.04,
    })).toContain('REVERSE AI_ROBOTICS')
  })

  it('fail-closed when NVDA excess is missing', () => {
    expect(cohortEntryRejectReason('ASML', groups, {})).toContain('leader excess missing')
    expect(cohortEntryRejectReason('CAT', groups, undefined)).toContain('leader excess missing')
  })

  it('SIGNAL_ONLY blocks new NVDA entries', () => {
    expect(cohortEntryRejectReason('NVDA', groups, {
      NVDA: 0.1,
    })).toContain('SIGNAL_ONLY')
  })
})

describe('weakestLeaderExcess / capitalFlip', () => {
  it('uses the weakest of several leaders', () => {
    const g: CohortGroupRule = {
      ...infra, leaders: [
        'NVDA',
        'AVGO',
      ],
    }
    expect(weakestLeaderExcess(g, {
      NVDA: 0.08, AVGO: -0.01,
    })).toBeCloseTo(-0.01)
  })

  it('ROTATE_TO_MEMBERS trims NVDA when it is slowing', () => {
    expect(cohortCapitalAction('NVDA', groups, {
      NVDA: -0.05,
    })).toBe('FLIP_TO_MEMBERS')
    expect(cohortCapitalAction('NVDA', groups, {
      NVDA: 0.05,
    })).toBe('KEEP')
    expect(cohortCapitalAction('CAT', groups, {
      NVDA: -0.05,
    })).toBe('KEEP')
  })
})

describe('memberPolicyFromCorr', () => {
  it('high corr vs NVDA → FOLLOW (ASML-shaped); negative → REVERSE (CAT-shaped)', () => {
    expect(memberPolicyFromCorr(0.7)).toBe('FOLLOW')
    expect(memberPolicyFromCorr(-0.35)).toBe('REVERSE')
    expect(memberPolicyFromCorr(0.1)).toBeUndefined()
    expect(memberPolicyFromCorr(undefined)).toBeUndefined()
  })
})

describe('assignMembersByCorr', () => {
  it('tags clones FOLLOW, negated REVERSE, noise unclear', () => {
    const dates = Array.from({ length: 40 }, (_, i) => `2024-02-${String(i + 1).padStart(2, '0')}`)
    const leader = dates.map((date, i) => ({
      date, ret: ((i * 17) % 11) / 100 - 0.05,
    }))
    const follow = leader.map(r => ({
      date: r.date, ret: r.ret,
    }))
    const reverse = leader.map(r => ({
      date: r.date, ret: -r.ret,
    }))
    const noise = dates.map((date, i) => ({
      date, ret: ((i * 3) % 7) / 200,
    }))
    const out = assignMembersByCorr(leader, {
      ASML: follow, CAT: reverse, JPM: noise,
    }, 30)
    expect(out.follow).toContain('ASML')
    expect(out.reverse).toContain('CAT')
    expect(out.unclear).toContain('JPM')
  })
})

describe('mapMacroToCohortGroups', () => {
  it('parses explicitTickers and ignores junk', () => {
    expect(parseExplicitTickers('["NVDA","ASML"]')).toEqual([
      'NVDA',
      'ASML',
    ])
    expect(parseExplicitTickers('not-json')).toEqual([])
    expect(parseExplicitTickers(null)).toEqual([])
  })

  it('parseTickerList uppercases, splits, and dedupes', () => {
    expect(parseTickerList('nvda, asml; TSM  nvda')).toEqual([
      'NVDA',
      'ASML',
      'TSM',
    ])
  })

  it('splits one AI narrative into FOLLOW vs REVERSE from corr; drops GLUT and unclear', () => {
    const dates = Array.from({ length: 40 }, (_, i) => `2024-03-${String(i + 1).padStart(2, '0')}`)
    const nvda = dates.map((date, i) => ({
      date, ret: ((i * 17) % 11) / 100 - 0.05,
    }))
    const asml = nvda.map(r => ({
      date: r.date, ret: r.ret,
    }))
    const cat = nvda.map(r => ({
      date: r.date, ret: -r.ret,
    }))
    const jpm = dates.map((date, i) => ({
      date, ret: ((i * 3) % 7) / 200,
    }))
    const groups = mapMacroToCohortGroups([
      {
        narrativeName: 'AI Infra', status: 'ACTIVE', ticker: 'NVDA', exposureType: 'BENEFICIARY', derivativeTier: 1, explicitTickers: [
          'NVDA',
        ],
      },
      {
        narrativeName: 'AI Infra', status: 'ACTIVE', ticker: 'ASML', exposureType: 'BENEFICIARY', derivativeTier: 2,
      },
      {
        narrativeName: 'AI Infra', status: 'ACTIVE', ticker: 'CAT', exposureType: 'BENEFICIARY', derivativeTier: 2,
      },
      {
        narrativeName: 'AI Infra', status: 'ACTIVE', ticker: 'JPM', exposureType: 'BENEFICIARY', derivativeTier: 2,
      },
      {
        narrativeName: 'Dead GPU', status: 'GLUT', ticker: 'NVDA', exposureType: 'BENEFICIARY', derivativeTier: 1,
      },
    ], {
      NVDA: nvda, ASML: asml, CAT: cat, JPM: jpm,
    })
    const follow = groups.find(g => g.memberPolicy === 'FOLLOW')
    const reverse = groups.find(g => g.memberPolicy === 'REVERSE')
    expect(follow?.leaders).toEqual([
      'NVDA',
    ])
    expect(follow?.members).toContain('ASML')
    expect(reverse?.members).toContain('CAT')
    expect(groups.some(g => g.members.includes('JPM'))).toBe(false)
    expect(groups.some(g => g.name.startsWith('Dead GPU'))).toBe(false)
  })
})

describe('excess20dAt / buildLeaderExcessMap', () => {
  it('returns decimal excess vs SPY and skips thin history', () => {
    const leader = Array.from({ length: 25 }, (_, i) => ({
      date: `2024-01-${String(i + 1).padStart(2, '0')}`, close: 100 + i,
    }))
    const spy = Array.from({ length: 25 }, (_, i) => ({
      date: `2024-01-${String(i + 1).padStart(2, '0')}`, close: 100,
    }))
    const excess = excess20dAt(leader, spy, '2024-01-25')
    expect(excess).toBeGreaterThan(0.1)
    expect(buildLeaderExcessMap({
      NVDA: leader, SPY: spy,
    }, spy, '2024-01-25').NVDA).toBe(excess)
    expect(excess20dAt(leader.slice(0, 5), spy, '2024-01-05')).toBeUndefined()
  })
})
