import {
  describe, expect, it, 
} from 'bun:test'

import {
  connectionRoleFromPerspective, normalizeConnectionEdge, relatedTicker, suppliersOfWinners, 
} from './connectionEdges'

describe('normalizeConnectionEdge', () => {
  it('swaps endpoints for SUPPLIER (Gemini: they supply the analyzed ticker)', () => {
    expect(normalizeConnectionEdge({
      fromTicker: 'AAPL', toTicker: 'MU', connectionType: 'SUPPLIER', 
    })).toEqual({
      fromTicker: 'MU', toTicker: 'AAPL', connectionType: 'SUPPLIER', 
    })
  })

  it('swaps endpoints for CUSTOMER (Gemini: analyzed ticker sells to them)', () => {
    expect(normalizeConnectionEdge({
      fromTicker: 'AAPL', toTicker: 'T', connectionType: 'CUSTOMER', 
    })).toEqual({
      fromTicker: 'T', toTicker: 'AAPL', connectionType: 'CUSTOMER', 
    })
  })

  it('passes COMPETITOR / SYNERGY / SYMPATHY_PLAY through', () => {
    for (const connectionType of [
      'COMPETITOR',
      'SYNERGY',
      'SYMPATHY_PLAY',
    ]) {
      const edge = {
        fromTicker: 'AAPL', toTicker: 'MSFT', connectionType, 
      }
      expect(normalizeConnectionEdge(edge)).toEqual(edge)
    }
  })

  it('does not swap a self-edge', () => {
    expect(normalizeConnectionEdge({
      fromTicker: 'AAPL', toTicker: 'AAPL', connectionType: 'SUPPLIER', 
    })).toEqual({
      fromTicker: 'AAPL', toTicker: 'AAPL', connectionType: 'SUPPLIER', 
    })
  })

  it('feeds suppliersOfWinners the right supplier after Gemini-shaped input', () => {
    const stored = normalizeConnectionEdge({
      fromTicker: 'AAPL', toTicker: 'MU', connectionType: 'SUPPLIER', 
    })
    const rows = suppliersOfWinners(
      [{ ticker: 'AAPL', yearReturnPct: 250 }],
      [stored],
      200,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.ticker).toBe('MU')
    expect(rows[0]!.winners[0]!.ticker).toBe('AAPL')
  })
})

describe('connectionRoleFromPerspective', () => {
  const muSuppliesAapl = {
    fromTicker: 'MU', toTicker: 'AAPL', connectionType: 'SUPPLIER', 
  }
  const tBuysFromAapl = {
    fromTicker: 'T', toTicker: 'AAPL', connectionType: 'CUSTOMER', 
  }

  it('labels SUPPLIER from each side', () => {
    expect(connectionRoleFromPerspective('MU', muSuppliesAapl)).toBe('Supplies')
    expect(connectionRoleFromPerspective('AAPL', muSuppliesAapl)).toBe('Supplied by')
  })

  it('labels CUSTOMER from each side', () => {
    expect(connectionRoleFromPerspective('T', tBuysFromAapl)).toBe('Buys from')
    expect(connectionRoleFromPerspective('AAPL', tBuysFromAapl)).toBe('Sells to')
  })

  it('returns the raw type for symmetric edges', () => {
    expect(connectionRoleFromPerspective('AAPL', {
      fromTicker: 'AAPL', toTicker: 'MSFT', connectionType: 'COMPETITOR', 
    })).toBe('COMPETITOR')
  })

  it('picks the other ticker', () => {
    expect(relatedTicker('AAPL', muSuppliesAapl)).toBe('MU')
    expect(relatedTicker('MU', muSuppliesAapl)).toBe('AAPL')
  })
})
