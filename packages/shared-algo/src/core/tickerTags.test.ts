import {
  describe, expect, test, 
} from 'bun:test'

import {
  computeMoatConfluence,
  computeWindScore,
  mergeTags,
  moatAlignmentFromExposures,
  normalizeTags,
  parseTagInput,
  tagNames,
  weightToReversalImpact,
  windLabel,
} from './tickerTags'

describe('tickerTags', () => {
  test('normalizeTags upgrades legacy string[]', () => {
    const tags = normalizeTags([
      'AI',
      'CLOUD',
    ])
    expect(tags).toHaveLength(2)
    expect(tags[0]).toEqual({
      tag: 'AI', weight: 1, polarity: 'neutral', source: 'default', 
    })
  })

  test('normalizeTags accepts weighted objects', () => {
    const tags = normalizeTags([
      {
        tag: 'cuda_lockin', weight: 0.9, polarity: 'tailwind', source: 'moat', 
      },
    ])
    expect(tags[0]!.tag).toBe('CUDA_LOCKIN')
    expect(tags[0]!.weight).toBe(0.9)
  })

  test('mergeTags prefers higher source rank', () => {
    const merged = mergeTags([
      {
        tag: 'AI', weight: 0.5, polarity: 'neutral', source: 'news', 
      },
    ],
    [
      {
        tag: 'AI', weight: 0.9, polarity: 'tailwind', source: 'moat', 
      },
    ])
    expect(merged[0]!.source).toBe('moat')
    expect(merged[0]!.weight).toBe(0.9)
  })

  test('parseTagInput supports weight suffix', () => {
    const tags = parseTagInput('FOO, BAR:0.7')
    expect(tagNames(tags)).toEqual([
      'FOO',
      'BAR',
    ])
    expect(tags[1]!.weight).toBe(0.7)
  })

  test('wind score + label', () => {
    const score = computeWindScore(-0.2, [
      {
        tag: 'REGULATORY', weight: 0.8, polarity: 'headwind', source: 'moat', 
      },
    ])
    expect(score).toBeLessThan(0)
    expect(windLabel(score)).toBe('HEADWIND')
    expect(weightToReversalImpact(0.85)).toBe('CRITICAL')
  })

  test('mergeTags prefers manual over moat', () => {
    const merged = mergeTags([
      {
        tag: 'AI', weight: 0.4, polarity: 'neutral', source: 'manual',
      },
    ],
    [
      {
        tag: 'AI', weight: 0.99, polarity: 'tailwind', source: 'moat',
      },
    ])
    expect(merged[0]!.source).toBe('manual')
    expect(merged[0]!.weight).toBe(0.4)
  })

  test('normalizeTags ignores garbage objects', () => {
    expect(normalizeTags([
      null,
      42,
      { weight: 0.5 },
      {
        tag: 'OK', weight: 2, polarity: 'tailwind', source: 'news',
      },
    ])).toEqual([
      {
        tag: 'OK', weight: 1, polarity: 'tailwind', source: 'news',
      },
    ])
  })

  test('computeMoatConfluence is null without strength or wind', () => {
    expect(computeMoatConfluence({})).toBeNull()
  })

  test('computeMoatConfluence requires alignment + phase — strong wind muted without narrative', () => {
    const aligned = computeMoatConfluence({
      moatStrength: 0.85,
      moatWindScore: 0.4,
      macroRegime: 'RISK_ON',
      alignment: 'BENEFICIARY',
    })
    const unaligned = computeMoatConfluence({
      moatStrength: 0.85,
      moatWindScore: 0.4,
      macroRegime: 'RISK_ON',
      alignment: 'NONE',
    })
    expect(aligned).not.toBeNull()
    expect(unaligned).not.toBeNull()
    expect(aligned!).toBeGreaterThan(unaligned!)
    expect(aligned!).toBeGreaterThan(0.25)
  })

  test('computeMoatConfluence: RISK_OFF favors fortress strength over wind', () => {
    const fortress = computeMoatConfluence({
      moatStrength: 0.9,
      moatWindScore: 0,
      macroRegime: 'RISK_OFF',
      alignment: 'BENEFICIARY',
    })
    const weakGrowing = computeMoatConfluence({
      moatStrength: 0.3,
      moatWindScore: 0.5,
      macroRegime: 'RISK_OFF',
      alignment: 'BENEFICIARY',
    })
    expect(fortress!).toBeGreaterThan(weakGrowing!)
  })

  test('computeMoatConfluence: AT_RISK damps positive and keeps negative', () => {
    const posBen = computeMoatConfluence({
      moatStrength: 0.8,
      moatWindScore: 0.3,
      macroRegime: 'RISK_ON',
      alignment: 'BENEFICIARY',
    })
    const posRisk = computeMoatConfluence({
      moatStrength: 0.8,
      moatWindScore: 0.3,
      macroRegime: 'RISK_ON',
      alignment: 'AT_RISK',
    })
    const negRisk = computeMoatConfluence({
      moatStrength: 0.4,
      moatWindScore: -0.5,
      macroRegime: 'RISK_ON',
      alignment: 'AT_RISK',
    })
    expect(posBen!).toBeGreaterThan(posRisk!)
    expect(negRisk!).toBeLessThan(-0.15)
  })

  test('moatAlignmentFromExposures prefers BENEFICIARY', () => {
    expect(moatAlignmentFromExposures([
      { exposureType: 'AT_RISK' },
      { exposureType: 'BENEFICIARY' },
    ])).toBe('BENEFICIARY')
    expect(moatAlignmentFromExposures([])).toBe('NONE')
  })
})
