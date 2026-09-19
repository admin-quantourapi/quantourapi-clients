import {
  describe, expect, test,
} from 'bun:test'

import {
  defaultForwardTestName, isDuplicatePortfolioName, nameComparisonKey, normalizePortfolioName, PORTFOLIO_NAME_MAX_LENGTH,
} from './forwardTestNaming'

describe('normalizePortfolioName', () => {
  test('trims and collapses internal whitespace', () => {
    expect(normalizePortfolioName('  AI_COMBINED    Conservative   8/19 ')).toBe('AI_COMBINED Conservative 8/19')
  })

  test('caps at the column length', () => {
    const long = 'A'.repeat(PORTFOLIO_NAME_MAX_LENGTH + 10)
    expect(normalizePortfolioName(long)).toHaveLength(PORTFOLIO_NAME_MAX_LENGTH)
  })

  test('empty input stays empty', () => {
    expect(normalizePortfolioName('   ')).toBe('')
  })
})

describe('defaultForwardTestName', () => {
  const aug19 = new Date(2026, 7, 19) // month is 0-indexed: 7 = August

  test('formats as Strategy Risk M/D', () => {
    expect(defaultForwardTestName('AI_COMBINED', 'CONSERVATIVE', aug19)).toBe('AI_COMBINED Conservative 8/19')
    expect(defaultForwardTestName('MY_STRATEGY', 'AGGRESSIVE', new Date(2026, 0, 5)))
      .toBe('MY_STRATEGY Aggressive 1/5')
  })

  test('unknown aggressiveness falls back to its raw string', () => {
    expect(defaultForwardTestName('X', 'TURBO', aug19)).toBe('X TURBO 8/19')
  })

  test('empty strategy name falls back to Custom', () => {
    expect(defaultForwardTestName('', 'BALANCED', aug19)).toBe('Custom Balanced 8/19')
  })
})

describe('duplicate detection', () => {
  const existing = [
    'AI_COMBINED Conservative 8/19',
    'Custom Balanced 8/18',
  ]

  test('exact match collides', () => {
    expect(isDuplicatePortfolioName('AI_COMBINED Conservative 8/19', existing)).toBe(true)
  })

  test('case-insensitive and whitespace-tolerant collision', () => {
    expect(isDuplicatePortfolioName('ai_combined  conservative 8/19', existing)).toBe(true)
  })

  test('different date or risk does not collide', () => {
    expect(isDuplicatePortfolioName('AI_COMBINED Conservative 8/20', existing)).toBe(false)
    expect(isDuplicatePortfolioName('AI_COMBINED Aggressive 8/19', existing)).toBe(false)
  })

  test('empty candidate never collides', () => {
    expect(isDuplicatePortfolioName('', existing)).toBe(false)
  })

  test('nameComparisonKey is the lowercase normalized form', () => {
    expect(nameComparisonKey('  Foo  BAR ')).toBe('foo bar')
  })
})
