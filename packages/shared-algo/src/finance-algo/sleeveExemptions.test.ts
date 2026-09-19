import {
  describe, expect, test, 
} from 'bun:test'

import { isThesisManagedPosition } from './sleeveExemptions'

describe('isThesisManagedPosition', () => {
  const exempt = [
    '🌱 FCF Spring & Sector Tailwind',
  ]

  test('exempt branch is thesis-managed', () => {
    expect(isThesisManagedPosition('🌱 FCF Spring & Sector Tailwind', exempt)).toBe(true)
  })

  test('velocity branches are not', () => {
    expect(isThesisManagedPosition('🔮 High AI Conviction & Early Reclaim', exempt)).toBe(false)
  })

  test('fail-closed: missing branch name, missing list, or empty list', () => {
    expect(isThesisManagedPosition(undefined, exempt)).toBe(false)
    expect(isThesisManagedPosition(null, exempt)).toBe(false)
    expect(isThesisManagedPosition('🌱 FCF Spring & Sector Tailwind', undefined)).toBe(false)
    expect(isThesisManagedPosition('🌱 FCF Spring & Sector Tailwind', [])).toBe(false)
  })
})
