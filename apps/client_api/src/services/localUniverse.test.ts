import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  loadLocalUniverse,
  parseLocalUniverse,
  resolveTickersFallback,
  universeFilePath,
} from './localUniverse'

const VALID_ROW = {
  ticker: 'AAPL',
  name: 'Apple Inc.',
  sector: 'Technology',
  industry: 'Consumer Electronics',
}

const VALID_FILE = JSON.stringify({ tickers: [VALID_ROW] })

describe('parseLocalUniverse', () => {
  test('valid file → tickers with safe defaults applied', () => {
    const tickers = parseLocalUniverse(VALID_FILE)
    expect(tickers).not.toBeNull()
    expect(tickers![0]).toEqual({
      ticker: 'AAPL',
      name: 'Apple Inc.',
      sector: 'Technology',
      industry: 'Consumer Electronics',
      isActive: true,
      isDefensive: false,
      isEmergingLeader: false,
      isUndervalued: false,
      fundingAmount: '0',
      trend: 'BULLISH',
    })
  })

  test('malformed JSON → null', () => {
    expect(parseLocalUniverse('{not json')).toBeNull()
  })

  test('schema violation (missing sector) → null', () => {
    const bad = JSON.stringify({ tickers: [{ ticker: 'AAPL', name: 'Apple Inc.' }] })
    expect(parseLocalUniverse(bad)).toBeNull()
  })

  test('empty tickers list → null (degrades to no fallback)', () => {
    expect(parseLocalUniverse(JSON.stringify({ tickers: [] }))).toBeNull()
  })

  test('non-object payload → null', () => {
    expect(parseLocalUniverse(JSON.stringify(['AAPL']))).toBeNull()
  })

  test('explicit trend/isDefensive survive the defaults', () => {
    const tickers = parseLocalUniverse(JSON.stringify({
      tickers: [{ ...VALID_ROW, trend: 'BEARISH', isDefensive: true }],
    }))
    expect(tickers![0]!.trend).toBe('BEARISH')
    expect(tickers![0]!.isDefensive).toBe(true)
  })
})

describe('loadLocalUniverse', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'universe-'))
  const dbPath = path.join(dir, 'local.db')

  // Order-proofing: `bun test --randomize` shuffles tests WITHIN a file, and
  // these cases share one dbPath — the "writes the file" cases must never run
  // before "missing file → null". Each test starts from a clean sidecar.
  beforeEach(() => {
    rmSync(universeFilePath(dbPath), { force: true })
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('file path sits next to the SQLite DB', () => {
    expect(universeFilePath('/data/quantour/local.db')).toBe('/data/quantour/local.universe.json')
  })

  test('missing file → null', () => {
    expect(loadLocalUniverse(dbPath)).toBeNull()
  })

  test('valid file → tickers', () => {
    writeFileSync(universeFilePath(dbPath), VALID_FILE)
    const tickers = loadLocalUniverse(dbPath)
    expect(tickers).not.toBeNull()
    expect(tickers![0]!.ticker).toBe('AAPL')
  })

  test('invalid file → null (never partial data)', () => {
    writeFileSync(universeFilePath(dbPath), '{"tickers": "all-of-them"}')
    expect(loadLocalUniverse(dbPath)).toBeNull()
  })
})

describe('resolveTickersFallback', () => {
  const local = [{ ...VALID_ROW, isActive: true }] as NonNullable<ReturnType<typeof parseLocalUniverse>>

  test('healthy central wins even when a local universe exists (no shadowing)', () => {
    expect(resolveTickersFallback({ upstreamOk: true, localUniverse: local })).toEqual({ source: 'upstream' })
  })

  test('central failure + local file → local fallback', () => {
    const result = resolveTickersFallback({ upstreamOk: false, localUniverse: local })
    expect(result.source).toBe('local')
  })

  test('central failure + no file → fail closed', () => {
    expect(resolveTickersFallback({ upstreamOk: false, localUniverse: null })).toEqual({ source: 'fail' })
    expect(resolveTickersFallback({ upstreamOk: false, localUniverse: [] })).toEqual({ source: 'fail' })
  })
})
