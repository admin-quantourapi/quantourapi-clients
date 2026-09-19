/**
 * Read-only key scope — write-endpoint matcher for the client_api (PURE).
 * Local portfolio/config mutations blocked when the instance key is
 * read-only (view-layer keys for agents/advisors). GET/HEAD never blocked;
 * stateless POST /api/strategies/simulate and Telegram ingestion
 * (/v1/bot/update) stay reachable; /api/settings is field-gated inside its
 * handler (key linking must keep working — that is how a read-only key
 * arrives, and how the user upgrades back to a full key).
 */

interface WriteRoutePattern {
  method: string
  prefix: string
}

const WRITE_ROUTES: readonly WriteRoutePattern[] = [
  { method: 'POST', prefix: '/api/trades/buy' },
  { method: 'POST', prefix: '/api/trades/sell' },
  { method: 'POST', prefix: '/api/portfolio/budget' },
  { method: 'POST', prefix: '/api/portfolio/apply' },
  // Watchlist portfolios + items (POST/DELETE under /api/portfolios).
  { method: 'POST', prefix: '/api/portfolios' },
  { method: 'DELETE', prefix: '/api/portfolios' },
  // Custom signals.
  { method: 'POST', prefix: '/api/signals' },
  { method: 'DELETE', prefix: '/api/signals' },
  // Custom strategies — EXCLUDES /api/strategies/simulate via the explicit
  // allowlist check below (stateless).
  { method: 'POST', prefix: '/api/strategies' },
  { method: 'PUT', prefix: '/api/strategies' },
  { method: 'DELETE', prefix: '/api/strategies' },
]

/** Stateless exceptions that share a blocked prefix. */
const ALLOWED_SUFFIXES = ['/api/strategies/simulate']

/** True when method+path hits a local write a read-only key must not reach. */
export function isClientReadOnlyWrite(method: string, path: string): boolean {
  const m = method.toUpperCase()
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return false
  if (ALLOWED_SUFFIXES.some(sfx => path === sfx || path.startsWith(`${sfx}/`))) return false
  return WRITE_ROUTES.some(r => m === r.method && (path === r.prefix || path.startsWith(`${r.prefix}/`)))
}
