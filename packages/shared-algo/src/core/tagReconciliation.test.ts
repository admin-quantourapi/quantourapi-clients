import {
  describe, expect, test,
} from 'bun:test'

import {
  applyTagPrune, cosineSimilarity, mapBySimilarity, MAX_TAGS_PER_TICKER, normalizeCappedTags, partitionTags, planTagPrune,
  reconcileTags, TAG_SIMILARITY_THRESHOLD, tagFrequencies, topTagsByFrequency,
} from './tagReconciliation'
import type { TickerTag } from './tickerTags'

const VOCAB = [
  'SEMICONDUCTORS',
  'AI_BENEFICIARY',
  'FERTILIZER',
  'HIGH_DEBT',
]

describe('partitionTags', () => {
  test('splits exact hits from unknowns, uppercase-normalized, deduped', () => {
    const result = partitionTags([
      'chips',
      'AI_BENEFICIARY',
      'ai_beneficiary',
      ' FERTILIZER ',
      'RARE_EARTHS',
      '',
    ],
    VOCAB)
    expect(result.known).toEqual([
      'AI_BENEFICIARY',
      'FERTILIZER',
    ])
    expect(result.unknown).toEqual([
      'CHIPS',
      'RARE_EARTHS',
    ])
  })

  test('empty inputs → empty partitions', () => {
    expect(partitionTags([], VOCAB)).toEqual({ known: [], unknown: [] })
    expect(partitionTags([
      'CHIPS',
    ], [])).toEqual({
      known: [],
      unknown: [
        'CHIPS',
      ], 
    })
  })
})

describe('mapBySimilarity', () => {
  // Synthetic 2-d vectors: SEMICONDUCTORS ∝ CHIPS direction, FERTILIZER orthogonal.
  const embeddings = new Map<string, readonly number[]>([
    [
      'CHIPS',
      [
        0.99,
        0.14,
      ],
    ],
    [
      'SEMICONDUCTORS',
      [
        1,
        0.1,
      ],
    ],
    [
      'FERTILIZER',
      [
        0,
        1,
      ],
    ],
    [
      'HIGH_DEBT',
      [
        -1,
        0.05,
      ],
    ],
  ])

  test('maps an unknown to its best-scoring vocabulary tag at ≥ threshold', () => {
    const { mapped, unresolved } = mapBySimilarity(
      [
        'CHIPS',
      ], VOCAB, embeddings, 0.5,
    )
    expect(mapped.get('CHIPS')).toBe('SEMICONDUCTORS')
    expect(unresolved).toEqual([])
  })

  test('below threshold → unresolved (dropped, never mis-mapped)', () => {
    // ORTHOGONAL sits between vocab directions: best score ≈0.77 < 0.99.
    const embeddingsOrtho = new Map(embeddings)
    embeddingsOrtho.set('ORTHOGONAL', [
      0.5,
      0.5,
    ])
    const { mapped, unresolved } = mapBySimilarity(
      [
        'ORTHOGONAL',
      ], VOCAB, embeddingsOrtho, 0.99,
    )
    expect(mapped.size).toBe(0)
    expect(unresolved).toEqual([
      'ORTHOGONAL',
    ])
  })

  test('missing embedding for the incoming tag → unresolved', () => {
    const { unresolved } = mapBySimilarity([
      'NOT_EMBEDDED',
    ], VOCAB, embeddings)
    expect(unresolved).toEqual([
      'NOT_EMBEDDED',
    ])
  })

  test('vocabulary entries without embeddings are not candidates', () => {
    const partial = new Map<string, readonly number[]>([
      [
        'CHIPS',
        [
          1,
          0,
        ],
      ],
    ])
    const { unresolved } = mapBySimilarity([
      'CHIPS',
    ], VOCAB, partial)
    // No candidate has an embedding → cannot map.
    expect(unresolved).toEqual([
      'CHIPS',
    ])
  })
})

describe('reconcileTags', () => {
  const embeddings = new Map<string, readonly number[]>([
    [
      'CHIPS',
      [
        1,
        0.05,
      ],
    ],
    [
      'SEMICONDUCTORS',
      [
        1,
        0.1,
      ],
    ],
    [
      'AI_BENEFICIARY',
      [
        1,
        0.1,
      ],
    ],
  ])

  test('resolved = exact hits + mapped unknowns; dropped excludes mapped', () => {
    const result = reconcileTags(
      [
        'CHIPS',
        'HIGH_DEBT',
        'GARBAGE_TAG',
      ], VOCAB, embeddings, 0.5,
    )
    expect(result.resolved).toContain('SEMICONDUCTORS') // mapped from CHIPS
    expect(result.resolved).toContain('HIGH_DEBT') // exact
    expect(result.resolved).not.toContain('GARBAGE_TAG')
    expect(result.dropped).toEqual([
      'GARBAGE_TAG',
    ])
    expect(result.mapping.get('CHIPS')).toBe('SEMICONDUCTORS')
  })

  test('mapping colliding with an exact hit collapses to one entry', () => {
    const result = reconcileTags(
      [
        'CHIPS',
        'SEMICONDUCTORS',
      ], VOCAB, embeddings, 0.5,
    )
    expect(result.resolved.filter((t) => t === 'SEMICONDUCTORS')).toHaveLength(1)
  })
})

describe('cosineSimilarity', () => {
  test('identical vectors → 1, orthogonal → 0, opposite → −1', () => {
    expect(cosineSimilarity([
      1,
      2,
      3,
    ], [
      1,
      2,
      3,
    ])).toBeCloseTo(1)
    expect(cosineSimilarity([
      1,
      0,
    ], [
      0,
      1,
    ])).toBeCloseTo(0)
    expect(cosineSimilarity([
      1,
      0,
    ], [
      -1,
      0,
    ])).toBeCloseTo(-1)
  })

  test('zero vector and length mismatch are guarded', () => {
    expect(cosineSimilarity([
      0,
      0,
    ], [
      1,
      1,
    ])).toBe(0)
    expect(cosineSimilarity([
      1,
    ], [
      1,
      2,
    ])).toBe(0)
  })
})

const tag = (name: string, source: TickerTag['source'], weight = 1): TickerTag => ({
  tag: name,
  weight,
  polarity: 'neutral',
  source,
})

describe('normalizeCappedTags / capTags', () => {
  test('caps at MAX_TAGS_PER_TICKER keeping manual > moat > news > default, then weight', () => {
    const raw = [
      tag('NEWS_TAG', 'news', 1),
      tag('MANUAL_TAG', 'manual', 0.3),
      tag('MOAT_TAG', 'moat', 1),
      tag('DEFAULT_TAG', 'default', 1),
      tag('NEWS_STRONG', 'news', 0.9),
    ]
    const capped = normalizeCappedTags(raw, 3)
    // Same source rank → higher weight first: NEWS_TAG (1.0) beats NEWS_STRONG (0.9).
    expect(capped.map((t) => t.tag)).toEqual([
      'MANUAL_TAG',
      'MOAT_TAG',
      'NEWS_TAG',
    ])
  })

  test('lists at or under the cap pass through untouched', () => {
    const raw = [
      tag('A', 'news'),
      tag('B', 'news'),
    ]
    expect(normalizeCappedTags(raw)).toHaveLength(2)
    expect(MAX_TAGS_PER_TICKER).toBe(10)
  })

  test('deterministic on ties (name order)', () => {
    const raw = [
      tag('B', 'news'),
      tag('A', 'news'),
      tag('C', 'news'),
    ]
    expect(normalizeCappedTags(raw, 2).map((t) => t.tag)).toEqual([
      'A',
      'B',
    ])
  })
})

describe('tagFrequencies / topTagsByFrequency', () => {
  const tickers = [
    [
      tag('AI', 'news'),
      tag('CHIPS', 'news'),
    ],
    [
      tag('AI', 'news'),
      tag('AI', 'news'),
    ], // duplicate within one ticker counts once
    [
      tag('RARE', 'news'),
    ],
    'not-an-array', // malformed rows ignored
  ]

  test('document frequency counts each tag once per ticker, sorted desc', () => {
    const freq = tagFrequencies(tickers)
    expect(freq).toEqual([
      { tag: 'AI', count: 2 },
      { tag: 'CHIPS', count: 1 },
      { tag: 'RARE', count: 1 },
    ])
  })

  test('topTagsByFrequency truncates to the limit', () => {
    expect(topTagsByFrequency(tickers, 2)).toEqual([
      'AI',
      'CHIPS',
    ])
    expect(topTagsByFrequency(tickers, 300)).toHaveLength(3)
  })
})

describe('thresholds are the agreed constants', () => {
  test('TAG_SIMILARITY_THRESHOLD = 0.80', () => {
    expect(TAG_SIMILARITY_THRESHOLD).toBe(0.80)
  })
})

describe('planTagPrune / applyTagPrune', () => {
  const tickers = [
    [
      tag('COMMON', 'news'),
      tag('SINGLE', 'news'),
      tag('MANUAL_RARE', 'manual'),
    ],
    [
      tag('COMMON', 'news'),
    ],
    [
      tag('REFERENCED', 'news'),
    ],
  ]

  test('prunes news tags with DF<2 that no narrative references', () => {
    const plan = planTagPrune(tickers, [
      'REFERENCED',
    ])
    expect(plan.has('SINGLE')).toBe(true)
    expect(plan.has('REFERENCED')).toBe(false) // narrative reference protects it
    expect(plan.has('COMMON')).toBe(false) // DF=2
  })

  test('applyTagPrune removes only news-source pruned tags', () => {
    const plan = planTagPrune(tickers, [
      'REFERENCED',
    ])
    const row = [
      tag('SINGLE', 'news'),
      tag('MANUAL_RARE', 'manual'),
      tag('SINGLE', 'manual'), // same name, manual source — must survive
    ]
    const out = applyTagPrune(row, plan)
    expect(out.map((t) => `${t.tag}:${t.source}`)).toEqual([
      'MANUAL_RARE:manual',
      'SINGLE:manual',
    ])
  })

  test('applyTagPrune returns all tags unchanged (identity semantics) when nothing matches', () => {
    const plan = new Set([
      'NOT_PRESENT',
    ])
    const row = [
      tag('A', 'news'),
    ]
    expect(applyTagPrune(row, plan)).toEqual(row)
  })
})
