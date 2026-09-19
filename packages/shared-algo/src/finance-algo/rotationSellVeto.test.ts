import { describe, expect, it } from 'bun:test'

import { isNewsScoreFeedPresent, rotationSellVeto } from './rotationSellVeto'

describe('rotationSellVeto', () => {
  it('is off by default and when gate is off', () => {
    expect(rotationSellVeto({ gate: undefined, scoreFeedPresent: true })).toBeNull()
    expect(rotationSellVeto({ gate: 'off', scoreFeedPresent: true })).toBeNull()
  })

  it('fail-opens when no score feed exists (honest backtest)', () => {
    expect(rotationSellVeto({
      gate: 'require_score', newsScore: undefined, scoreFeedPresent: false,
    })).toBeNull()
  })

  it('vetoes unscored sells when a feed is present', () => {
    expect(rotationSellVeto({
      gate: 'require_score', newsScore: undefined, scoreFeedPresent: true,
    })).toBe('UNSCORED')
  })

  it('allows scored sells', () => {
    expect(rotationSellVeto({
      gate: 'require_score', newsScore: 5, scoreFeedPresent: true,
    })).toBeNull()
  })

  it('holds a scored leader dip', () => {
    expect(rotationSellVeto({
      gate: 'require_score_hold_dip',
      newsScore: 7,
      insiderScore: 10,
      price: 125,
      sma20: 175,
      scoreFeedPresent: true,
    })).toBe('LEADER_DIP')
  })

  it('does not hold when price is above sma20', () => {
    expect(rotationSellVeto({
      gate: 'require_score_hold_dip',
      newsScore: 7,
      insiderScore: 10,
      price: 180,
      sma20: 175,
      scoreFeedPresent: true,
    })).toBeNull()
  })

  it('does not hold when sma20 is missing', () => {
    expect(rotationSellVeto({
      gate: 'require_score_hold_dip',
      newsScore: 7,
      insiderScore: 10,
      price: 125,
      scoreFeedPresent: true,
    })).toBeNull()
  })
})

describe('isNewsScoreFeedPresent', () => {
  it('is false on empty scores', () => {
    expect(isNewsScoreFeedPresent({})).toBe(false)
  })

  it('is true when any ticker has a finite newsScore', () => {
    expect(isNewsScoreFeedPresent({ NVDA: { newsScore: 8 } })).toBe(true)
    expect(isNewsScoreFeedPresent({ CRM: {} })).toBe(false)
  })
})
