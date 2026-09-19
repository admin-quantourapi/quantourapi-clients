import { z } from 'zod'

import { config } from '../config'

/**
 * Runtime-validated shape of the public-api /v1/ping payload we consume here
 * (kept deliberately narrower than the full response).
 */
const PingIdentitySchema = z.object({
  userId: z.string().nullable().optional(),
  readOnly: z.boolean().optional(),
})

export interface KeyIdentity {
  userId: string | null
  readOnly: boolean
}

/**
 * Resolve the central Quantour identity for a given API key: userId plus the
 * key's read-only scope. Calls public-api /v1/ping so the client_api can
 * scope the local portfolio by the real user identity (not chatId) and gate
 * local writes for view-layer keys (agents/advisors). Absent/malformed
 * readOnly degrades to false (full access) — scope enforcement then rests on
 * the central verifiers, which never depend on this parse.
 */
export async function resolveKeyIdentity(apiKey: string): Promise<KeyIdentity> {
  if (!apiKey || apiKey === 'admin') return { userId: null, readOnly: false }
  try {
    const res = await fetch(`${config.PUBLIC_API_URL}/v1/ping`, {
      headers: {
        'x-api-key': apiKey,
        'Authorization': `Bearer ${apiKey}`,
        'Connection': 'close',
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return { userId: null, readOnly: false }
    const parsed = PingIdentitySchema.safeParse(await res.json())
    if (!parsed.success) return { userId: null, readOnly: false }
    return {
      userId: parsed.data.userId || null,
      readOnly: parsed.data.readOnly ?? false,
    }
  } catch {
    return { userId: null, readOnly: false }
  }
}

/**
 * Back-compat shim: resolve ONLY the userId (existing callers).
 * Prefer resolveKeyIdentity where the read-only scope matters.
 */
export async function resolveUserIdFromKey(apiKey: string): Promise<string | null> {
  return (await resolveKeyIdentity(apiKey)).userId
}
