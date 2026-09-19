import {
  describe, expect, test, 
} from 'bun:test'

import {
  isNewsShockExit,
  parseStructuralThesis,
  type StructuralThesisSnapshot,
  structuralThesisVerdict,
} from './structuralThesis'

const thesis: StructuralThesisSnapshot = {
  branch: '🌱 FCF Spring & Sector Tailwind',
  structural: true,
  capturedAt: '2026-08-21T12:00:00Z',
  horizonDays: 120,
  fcfInflection: 'POSITIVE',
  fcfSpringFactor: 2.4,
  sectorNewsScore: 6.2,
  newsScore: 6.0,
  newsAlignment: 'NEUTRAL',
  sector: 'Technology',
}

describe('structuralThesisVerdict', () => {
  test('INTACT when pillars unchanged', () => {
    expect(structuralThesisVerdict(thesis, {
      fcfInflection: 'POSITIVE', newsAlignment: 'NEUTRAL', sectorNewsScore: 6.0, newsScore: 6.5,
    })).toBe('INTACT')
  })

  test('BROKEN on FCF reversal (exit arm parity)', () => {
    expect(structuralThesisVerdict(thesis, { fcfInflection: 'NEGATIVE' })).toBe('BROKEN')
  })

  test('BROKEN on weakness flip (exit arm parity)', () => {
    expect(structuralThesisVerdict(thesis, { newsAlignment: 'IDIOSYNCRATIC_WEAKNESS' })).toBe('BROKEN')
  })

  test('WEAKENING when sector goes cold', () => {
    expect(structuralThesisVerdict(thesis, { sectorNewsScore: 4.0 })).toBe('WEAKENING')
  })

  test('WEAKENING when company news collapses', () => {
    expect(structuralThesisVerdict(thesis, { newsScore: 3.2 })).toBe('WEAKENING')
  })

  test('missing current data does NOT break the thesis (fail-open, no spam)', () => {
    expect(structuralThesisVerdict(thesis, {})).toBe('INTACT')
    expect(structuralThesisVerdict(thesis, { fcfInflection: undefined, newsAlignment: undefined })).toBe('INTACT')
  })
})

describe('isNewsShockExit', () => {
  test('fires on news < 4 or insider < 3.5', () => {
    expect(isNewsShockExit({ newsScore: 3.5 })).toBe(true)
    expect(isNewsShockExit({ insiderScore: 3.0 })).toBe(true)
    expect(isNewsShockExit({ newsScore: 6, insiderScore: 6 })).toBe(false)
  })

  test('FCF NEGATIVE alone is NOT a velocity shock (sleeve-only)', () => {
    expect(isNewsShockExit({ fcfInflection: 'NEGATIVE' })).toBe(false)
    expect(isNewsShockExit({ newsAlignment: 'IDIOSYNCRATIC_WEAKNESS' })).toBe(false)
  })

  test('fragile + major down-delta IS a velocity shock', () => {
    expect(isNewsShockExit({ newsScoreDelta: -2.5, peRatio: 60 })).toBe(true)
    expect(isNewsShockExit({ newsScoreDelta: -2.5, fcfInflection: 'NEGATIVE' })).toBe(true)
  })
})

describe('parseStructuralThesis', () => {
  test('round-trips a stored snapshot', () => {
    const parsed = parseStructuralThesis(JSON.stringify(thesis))
    expect(parsed?.branch).toBe(thesis.branch)
    expect(parsed?.structural).toBe(true)
    expect(parsed?.fcfSpringFactor).toBe(2.4)
  })

  test('null on absent/malformed/non-structural payloads', () => {
    expect(parseStructuralThesis(null)).toBeNull()
    expect(parseStructuralThesis('')).toBeNull()
    expect(parseStructuralThesis('not json')).toBeNull()
    expect(parseStructuralThesis(JSON.stringify({ branch: '🔮', structural: false }))).toBeNull()
    expect(parseStructuralThesis(JSON.stringify({ structural: true }))).toBeNull()
  })
})
