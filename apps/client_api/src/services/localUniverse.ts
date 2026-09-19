import { readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

/**
 * Local universe fallback (outage insurance for self-hosted installs).
 *
 * A `local.universe.json` file next to the SQLite DB — written by the
 * installer agent (QUANTOUR_AGENT.md STEP 4b) from REAL central-API rows,
 * never invented — is served by the `/proxy` passthrough ONLY when the
 * central `/v1/market/tickers` call fails. When central is healthy it stays
 * the source of truth; when the file is absent the endpoint fails closed
 * (no fabricated data, no hardcoded house list).
 *
 * Row shape mirrors the central tickers payload so the dashboard renders
 * local rows unchanged; optional fields get the same safe defaults the
 * central payload guarantees.
 */

const UniverseTickerSchema = z.object({
  ticker: z.string().trim().min(1).max(10),
  name: z.string().trim().min(1),
  sector: z.string().trim().min(1),
  industry: z.string().trim().min(1),
  isActive: z.boolean().default(true),
  isDefensive: z.boolean().default(false),
  isEmergingLeader: z.boolean().default(false),
  isUndervalued: z.boolean().default(false),
  fundingAmount: z.string().default('0'),
  trend: z.enum(['BULLISH', 'BEARISH']).default('BULLISH'),
})

const LocalUniverseFileSchema = z.object({
  tickers: z.array(UniverseTickerSchema).min(1),
})

export type LocalUniverseTicker = z.infer<typeof UniverseTickerSchema>

/** `local.universe.json` lives next to the SQLite DB — no extra env needed. */
export function universeFilePath(sqliteDbPath: string): string {
  return path.join(path.dirname(sqliteDbPath), 'local.universe.json')
}

/**
 * Pure parser: valid file content → tickers (defaults applied); anything
 * else (malformed JSON, schema violation, empty list) → null. The null
 * collapse is deliberate — an invalid universe file must never surface as
 * partial data, it degrades to "no fallback configured".
 */
export function parseLocalUniverse(raw: string): LocalUniverseTicker[] | null {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const parsed = LocalUniverseFileSchema.safeParse(json)
  return parsed.success ? parsed.data.tickers : null
}

/** IO wrapper: missing/unreadable/invalid file → null. Caller logs. */
export function loadLocalUniverse(sqliteDbPath: string): LocalUniverseTicker[] | null {
  let raw: string
  try {
    raw = readFileSync(universeFilePath(sqliteDbPath), 'utf8')
  } catch {
    return null
  }
  return parseLocalUniverse(raw)
}

export type TickersFallback =
  | { source: 'upstream' }
  | { source: 'local'; tickers: LocalUniverseTicker[] }
  | { source: 'fail' }

/**
 * Policy for the `/proxy/v1/market/tickers` failure path: central stays the
 * source of truth whenever it responds OK; a valid local universe fills
 * outage/mislink gaps; with neither, the endpoint fails closed.
 */
export function resolveTickersFallback(opts: {
  upstreamOk: boolean
  localUniverse: LocalUniverseTicker[] | null
}): TickersFallback {
  if (opts.upstreamOk) return { source: 'upstream' }
  if (opts.localUniverse && opts.localUniverse.length > 0) {
    return { source: 'local', tickers: opts.localUniverse }
  }
  return { source: 'fail' }
}
