import { z } from 'zod'

import { config } from '../config'

/**
 * Runtime-validated shape of the central API `/v1/ping` response. Used by
 * `pingKey` to confirm a Quantour API key is currently active and to read
 * back the account tier / userId. The JSON body is parsed through this
 * schema instead of an `as` cast.
 */
const PingResponseSchema = z.object({
  plan: z.string().optional(),
  userId: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  readOnly: z.boolean().optional(),
})

export type PingResult = {
  ok: boolean
  plan?: string
  userId?: string
  email?: string
  /** True when the key carries the read-only scope (view-layer keys). */
  readOnly?: boolean
  /**
   * HTTP status when the API answered (401/402 = key rejected, 5xx =
   * server-side failure). `undefined` means the request never got a valid
   * response (network error / timeout), so the failure is NOT the key.
   */
  status?: number
}

/**
 * In-memory TTL cache for `/v1/ping` results, keyed by API key string.
 * Avoids re-pinging the central API for the same key within a short window
 * when the scanner, `/link`, and the daily sweep run close together.
 * Trades a small risk of serving a just-revoked key as valid for ~5 min
 * in exchange for far fewer ping calls. The daily re-validation sweep
 * bypasses this cache so revocations are caught within 24h.
 */
const CACHE_TTL_MS = 5 * 60 * 1000
const cache = new Map<string, { result: PingResult; expiresAt: number }>()

/**
 * Verify a Quantour API key against the central API `/v1/ping` endpoint.
 * Returns `{ ok: true, plan?, userId?, email? }` on 2xx + schema match, or
 * `{ ok: false }` on any non-2xx, timeout, network error, or parse failure.
 * Results are cached per-key for `CACHE_TTL_MS`; pass `{ bypassCache: true }`
 * for the daily sweep to force a fresh check.
 */
export async function pingKey(apiKey: string, opts: { bypassCache?: boolean } = {}): Promise<PingResult> {
  const now = Date.now()
  if (!opts.bypassCache) {
    const cached = cache.get(apiKey)
    if (cached && cached.expiresAt > now) return cached.result
  }

  let result: PingResult
  try {
    const res = await fetch(`${config.PUBLIC_API_URL}/v1/ping`, {
      headers: { 'x-api-key': apiKey, 'Connection': 'close' },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) {
      result = { ok: false, status: res.status }
    } else {
      const parsed = PingResponseSchema.safeParse(await res.json())
      result = parsed.success
        ? {
          ok: true, plan: parsed.data.plan, userId: parsed.data.userId ?? undefined,
          email: parsed.data.email ?? undefined, readOnly: parsed.data.readOnly ?? false,
        }
        : { ok: true }
    }
  } catch {
    result = { ok: false }
  }

  cache.set(apiKey, { result, expiresAt: now + CACHE_TTL_MS })
  return result
}

/** Drop a single key's cached result (call after a status change), or all keys when omitted. */
export function invalidateKeyCache(apiKey?: string): void {
  if (apiKey) cache.delete(apiKey)
  else cache.clear()
}
