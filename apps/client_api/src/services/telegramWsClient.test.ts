/**
 * Client-side WS behavior — locks the protocol version-mismatch suppression
 * contract AND the keepalive half-open detection against a REAL socket pair:
 * a Bun.serve fake gateway (mirroring the bot's AUTH accept/reject, with a
 * silent mode that swallows PINGs) plus the real telegramWsClient lifecycle.
 *
 * Proves the WIRING, not just the flags: after a version rejection the client
 * must close and must NOT schedule the 5s reconnect (asserted via
 * wsDiagnostics().reconnectScheduled, so the test needs no long waits);
 * reconnectBotWebSocket() must clear the latch and re-authenticate; and with
 * no server traffic for the keepalive timeout the client must force-close
 * the hung socket and arm the reconnect (PONG traffic resets the window).
 * Keepalive timings are env-tunable (WS_KEEPALIVE_*) so these run in ~1s
 * instead of 90s.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'

import { WS_PROTOCOL_VERSION, WsMessageType } from '@quantour/telegram'

const TIMEOUT_MS = 15_000

/**
 * Fake bot gateway. `rejectVersions` flips the AUTH decision: while the
 * client's protocolVersion is in the set, every AUTH gets auth_result
 * ok:false + server-initiated close (exactly what the real bot does).
 * `silent` simulates a hung gateway: AUTH is acked but PINGs get no PONG.
 */
function startFakeGateway(): {
  url: Promise<string>
  connections: () => number
  rejectVersions: Set<number>
  silent: boolean
  pings: () => number
  stop: () => void
} {
  const seen: number[] = []
  let pingCount = 0
  const gateway = {
    silent: false,
    connections: () => seen.length,
    rejectVersions: new Set<number>(),
    pings: () => pingCount,
  }
  const urlPromise = Promise.withResolvers<string>()
  const server = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (req.url.endsWith('/ws')) {
        if (server.upgrade(req)) return
        return new Response('upgrade failed', { status: 500 })
      }
      return new Response('not found', { status: 404 })
    },
    websocket: {
      open(ws) {
        seen.push(0)
      },
      message(ws, raw) {
        const msg = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as {
          type: string
          chatId?: string
          protocolVersion?: number
        }
        if (msg.type === WsMessageType.AUTH) {
          const clientVersion = msg.protocolVersion ?? 0
          if (gateway.rejectVersions.has(clientVersion)) {
            ws.send(
              JSON.stringify({
                type: WsMessageType.AUTH_RESULT,
                ok: false,
                protocolVersion: WS_PROTOCOL_VERSION,
                reason: `protocol version mismatch: gateway speaks ${WS_PROTOCOL_VERSION}, client sent ${clientVersion}`,
              }),
            )
            ws.close()
          } else {
            ws.send(
              JSON.stringify({
                type: WsMessageType.AUTH_RESULT,
                ok: true,
                protocolVersion: WS_PROTOCOL_VERSION,
              }),
            )
          }
          return
        }
        if (msg.type === WsMessageType.PING) {
          pingCount++
          if (!gateway.silent) {
            ws.send(JSON.stringify({ type: WsMessageType.PONG }))
          }
        }
        // Other client messages (SET_MY_COMMANDS on open etc.): ignore.
      },
    },
  })
  // 127.0.0.1, NOT localhost: name resolution is container-environment
  // dependent (IPv6-first resolution against an IPv4-only Bun.serve bind
  // refuses deterministically in some CI networks — observed on the runner
  // while passing in identical local containers). Explicit IPv4 loopback
  // removes the entire resolution class.
  urlPromise.resolve(`ws://127.0.0.1:${server.port}/ws`)
  return {
    url: urlPromise.promise,
    connections: gateway.connections,
    rejectVersions: gateway.rejectVersions,
    get silent() {
      return gateway.silent
    },
    set silent(value: boolean) {
      gateway.silent = value
    },
    pings: gateway.pings,
    stop: () => server.stop(true),
  }
}

const gateway = startFakeGateway()

// BOT_WS_URL is read lazily at connect time (see botWsUrl) — pin it to the
// fake gateway before the first initBotWebSocket, regardless of which test
// file happened to import the module first in this process.
const gwUrl = await gateway.url
process.env.BOT_WS_URL = gwUrl
const wsClient = await import('./telegramWsClient')

// Order-poisoning tripwire: bun's mock.module is process-global and never
// restored between test files — if ANY other file mocked this module and ran
// first (file order is filesystem-dependent), our import receives the mock's
// export set and every test below degrades into opaque timeouts. Fail loudly
// instead.
for (const exportName of ['initBotWebSocket', 'reconnectBotWebSocket', 'stopBotWebSocket', 'wsDiagnostics'] as const) {
  if (typeof wsClient[exportName] !== 'function') {
    throw new Error(
      `telegramWsClient.test.ts: import of ./telegramWsClient is missing export "${exportName}" — ` +
      'a process-global mock.module interception from another test file ran first. ' +
      'Remove that mock.module (use fail-soft real calls or dependency injection instead).',
    )
  }
}

function waitFor(predicate: () => boolean, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const check = () => {
      if (predicate()) return resolve()
      if (Date.now() - started > TIMEOUT_MS) return reject(new Error(`timeout waiting for ${what}`))
      setTimeout(check, 25)
    }
    check()
  })
}

beforeAll(async () => {
  // No shared sequential scenario state: `bun test --randomize` shuffles
  // tests WITHIN a file, so every scenario below resets the client singleton
  // (stopBotWebSocket clears socket + timers + latch) and configures the
  // gateway ITSELF instead of inheriting from a predecessor.
})

afterAll(() => {
  wsClient.stopBotWebSocket()
  gateway.stop()
})

/** Deterministic starting point: idle client, accepting non-silent gateway. */
async function resetToIdle(): Promise<void> {
  wsClient.stopBotWebSocket()
  gateway.rejectVersions.clear()
  gateway.silent = false
}

// Real-socket tests on a slow CI container (measured 10x slower than local:
// 20.8s vs 2.0s for this suite) can exceed bun's DEFAULT 5s per-test budget —
// the chained waitFors + real sleeps need headroom. bun KILLS a timed-out
// test but its async continuations keep running, leaving a zombie client
// that can then fail UNRELATED tests in the same process (observed as socket
// tests timing out and cascading into assertion failures elsewhere). 30s
// matches the bot suite's socket tests.
const REAL_SOCKET_TEST_TIMEOUT_MS = 30_000

test('version rejection: client latches mismatch, closes, and does NOT schedule reconnect', async () => {
  await resetToIdle()
  gateway.rejectVersions.add(WS_PROTOCOL_VERSION)
  const connectionsBefore = gateway.connections()
  await wsClient.initBotWebSocket()
  await waitFor(() => wsClient.wsDiagnostics().versionMismatch === true, 'versionMismatch latch')
  await waitFor(() => !wsClient.wsDiagnostics().connected, 'socket closed')
  // THE suppression contract: no 5s reconnect timer armed after the reject.
  expect(wsClient.wsDiagnostics().reconnectScheduled).toBe(false)
  // Give a would-be reconnect ample time to (wrongly) fire — none may appear.
  await new Promise(r => setTimeout(r, 300))
  expect(gateway.connections()).toBe(connectionsBefore + 1)
}, REAL_SOCKET_TEST_TIMEOUT_MS)

test('reconnectBotWebSocket clears the latch and re-authenticates against an accepting gateway', async () => {
  await resetToIdle()
  // Self-contained latch setup: get rejected once, then flip the gateway.
  gateway.rejectVersions.add(WS_PROTOCOL_VERSION)
  await wsClient.initBotWebSocket()
  await waitFor(() => wsClient.wsDiagnostics().versionMismatch === true, 'versionMismatch latch')
  const connectionsBefore = gateway.connections()
  gateway.rejectVersions.delete(WS_PROTOCOL_VERSION)
  await wsClient.reconnectBotWebSocket()
  await waitFor(() => wsClient.wsDiagnostics().connected, 're-authenticated connection')
  const diag = wsClient.wsDiagnostics()
  expect(diag.versionMismatch).toBe(false)
  expect(diag.reconnectScheduled).toBe(false)
  expect(gateway.connections()).toBe(connectionsBefore + 1)
}, REAL_SOCKET_TEST_TIMEOUT_MS)

test('silent gateway (no PONG): client force-closes the hung socket and arms the reconnect', async () => {
  await resetToIdle()
  process.env.WS_KEEPALIVE_INTERVAL_MS = '100'
  process.env.WS_KEEPALIVE_TIMEOUT_MS = '400'
  gateway.silent = true
  const pingsBefore = gateway.pings()
  try {
    await wsClient.initBotWebSocket()
    await waitFor(() => wsClient.wsDiagnostics().connected, 'initial authed connection')
    // The probe must actually be SENT before the verdict — a close without
    // pings would mean the timer path fired, not the no-traffic detection.
    await waitFor(() => wsClient.wsDiagnostics().reconnectScheduled === true, 'half-open close + reconnect armed')
    expect(gateway.pings()).toBeGreaterThan(pingsBefore)
  } finally {
    delete process.env.WS_KEEPALIVE_INTERVAL_MS
    delete process.env.WS_KEEPALIVE_TIMEOUT_MS
    wsClient.stopBotWebSocket()
  }
}, REAL_SOCKET_TEST_TIMEOUT_MS)

test('PONG traffic resets the no-traffic window: connection survives past the silent-mode timeout', async () => {
  await resetToIdle()
  process.env.WS_KEEPALIVE_INTERVAL_MS = '100'
  process.env.WS_KEEPALIVE_TIMEOUT_MS = '300'
  const pingsBefore = gateway.pings()
  try {
    await wsClient.initBotWebSocket()
    await waitFor(() => wsClient.wsDiagnostics().connected, 'initial authed connection')
    // > 2x the timeout the previous test proved fatal without PONGs.
    await new Promise(r => setTimeout(r, 700))
    const diag = wsClient.wsDiagnostics()
    expect(diag.connected).toBe(true)
    expect(diag.reconnectScheduled).toBe(false)
    expect(gateway.pings()).toBeGreaterThanOrEqual(pingsBefore + 2)
  } finally {
    delete process.env.WS_KEEPALIVE_INTERVAL_MS
    delete process.env.WS_KEEPALIVE_TIMEOUT_MS
    wsClient.stopBotWebSocket()
  }
}, REAL_SOCKET_TEST_TIMEOUT_MS)
