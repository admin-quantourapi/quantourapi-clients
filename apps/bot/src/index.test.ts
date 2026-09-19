/**
 * WS handshake integration test — locks the AUTH protocol-version contract
 * against the REAL gateway (Elysia app on an ephemeral port, real WebSocket
 * client, real wire JSON). Guards the regression class where the gateway
 * and @quantour/telegram schema drift apart silently (bot is not
 * covered by the dashboard/client_api typecheck surface).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'

import { WS_PROTOCOL_VERSION, WsMessageType } from '@quantour/telegram'

import { app, connectedClientCount, startIdleSweep, stopIdleSweep } from './index'

const TIMEOUT_MS = 15_000

beforeAll(() => {
  app.listen(0)
})

afterAll(() => {
  stopIdleSweep()
  app.stop()
})

// Real-socket tests on a slow CI container (measured 10x slower than local)
// can exceed bun's DEFAULT 5s per-test budget; these wait on real timers
// (keepalive windows, idle sweep). Same headroom as the client_api
// telegramWsClient socket tests.
const REAL_SOCKET_TEST_TIMEOUT_MS = 30_000

function waitFor(predicate: () => boolean, what: string, timeoutMs = TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const check = () => {
      if (predicate()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${what}`))
      setTimeout(check, 25)
    }
    check()
  })
}

function wsUrl(): string {
  const port = app.server?.port
  if (!port) throw new Error('bot test server failed to listen on an ephemeral port')
  // 127.0.0.1, NOT localhost — see the client_api WS test's comment: name
  // resolution is container-dependent and IPv6-first resolution against the
  // IPv4 bind refuses deterministically in some CI networks.
  return `ws://127.0.0.1:${port}/ws`
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => reject(new Error('WS open timeout')), TIMEOUT_MS)
    ws.onopen = () => {
      clearTimeout(timer)
      resolve(ws)
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error('WS error before open'))
    }
  })
}

interface RawEnvelope {
  message?: unknown
  closed?: boolean
}

/** Collect the next wire event (message OR close) as a promise. */
function nextEvent(ws: WebSocket, timeoutMs = TIMEOUT_MS): Promise<RawEnvelope> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ closed: false }), timeoutMs)
    const onMessage = (event: MessageEvent) => {
      clearTimeout(timer)
      resolve({ message: JSON.parse(String(event.data)) })
    }
    const onClose = () => {
      clearTimeout(timer)
      resolve({ closed: true })
    }
    ws.addEventListener('message', onMessage, { once: true })
    ws.addEventListener('close', onClose, { once: true })
  })
}

test('AUTH with the current protocol version is accepted and acked', async () => {
  const ws = await openSocket(wsUrl())
  try {
    ws.send(JSON.stringify({ type: WsMessageType.AUTH, chatId: '424242', protocolVersion: WS_PROTOCOL_VERSION }))
    const evt = await nextEvent(ws)
    expect(evt.message).toEqual({
      type: WsMessageType.AUTH_RESULT,
      ok: true,
      protocolVersion: WS_PROTOCOL_VERSION,
    })
  } finally {
    ws.close()
    // Deterministic dereg BEFORE later tests assert on connectedClientCount —
    // the server-side close handler fires asynchronously after ws.close().
    await waitFor(() => connectedClientCount() === 0, 'socket deregistration after close')
  }
}, REAL_SOCKET_TEST_TIMEOUT_MS)

test('AUTH with a future protocol version is rejected, carries both versions, and closes the socket', async () => {
  const ws = await openSocket(wsUrl())
  const future = WS_PROTOCOL_VERSION + 1
  ws.send(JSON.stringify({ type: WsMessageType.AUTH, chatId: '424242', protocolVersion: future }))

  // First event: explicit rejection with diagnosable payload...
  const reject = await nextEvent(ws)
  expect(reject.message).toMatchObject({
    type: WsMessageType.AUTH_RESULT,
    ok: false,
    protocolVersion: WS_PROTOCOL_VERSION,
  })
  const reason = String((reject.message as { reason?: string }).reason ?? '')
  expect(reason).toContain(String(WS_PROTOCOL_VERSION))
  expect(reason).toContain(String(future))

  // ...second event: the gateway closes (client must not linger unauthed).
  const close = await nextEvent(ws)
  expect(close.closed).toBe(true)
}, REAL_SOCKET_TEST_TIMEOUT_MS)

test('unversioned AUTH (pre-handshake client) gets NO auth_result — it fails schema parse server-side', async () => {
  const ws = await openSocket(wsUrl())
  try {
    ws.send(JSON.stringify({ type: WsMessageType.AUTH, chatId: '424242' }))
    // Short window: on localhost a real ack would arrive in single-digit ms.
    const evt = await nextEvent(ws, 750)
    // No ack arrives within the window (server logged a parse error instead).
    expect(evt.message).toBeUndefined()
    expect(evt.closed).toBe(false)
  } finally {
    ws.close()
  }
}, REAL_SOCKET_TEST_TIMEOUT_MS)

test('PING/PONG keepalive routing still works after a successful auth', async () => {
  const ws = await openSocket(wsUrl())
  try {
    ws.send(JSON.stringify({ type: WsMessageType.AUTH, chatId: '777', protocolVersion: WS_PROTOCOL_VERSION }))
    await nextEvent(ws) // auth_result ok
    ws.send(JSON.stringify({ type: WsMessageType.PING }))
    const pong = await nextEvent(ws)
    expect(pong.message).toEqual({ type: WsMessageType.PONG })
  } finally {
    ws.close()
    await waitFor(() => connectedClientCount() === 0, 'socket deregistration after close')
  }
}, REAL_SOCKET_TEST_TIMEOUT_MS)

test('idle sweep: a silent authed client is closed AND deregistered from the fan-out map', async () => {
  process.env.BOT_CLIENT_IDLE_TIMEOUT_MS = '300'
  try {
    startIdleSweep()
    const ws = await openSocket(wsUrl())
    ws.send(JSON.stringify({ type: WsMessageType.AUTH, chatId: 'sweep-idle', protocolVersion: WS_PROTOCOL_VERSION }))
    const ack = await nextEvent(ws)
    expect((ack.message as { ok?: boolean }).ok).toBe(true)
    expect(connectedClientCount()).toBe(1)

    // Now go silent (no PINGs). The sweep must close the socket...
    const closeEvt = await nextEvent(ws)
    expect(closeEvt.closed).toBe(true)
    // ...AND remove it from connectedClients — the memory-leak part of the bug.
    await waitFor(() => connectedClientCount() === 0, 'idle socket deregistration')
  } finally {
    delete process.env.BOT_CLIENT_IDLE_TIMEOUT_MS
    stopIdleSweep()
  }
}, REAL_SOCKET_TEST_TIMEOUT_MS)

test('idle sweep: a pinging client is never swept', async () => {
  process.env.BOT_CLIENT_IDLE_TIMEOUT_MS = '300'
  try {
    startIdleSweep()
    const ws = await openSocket(wsUrl())
    ws.send(JSON.stringify({ type: WsMessageType.AUTH, chatId: 'sweep-alive', protocolVersion: WS_PROTOCOL_VERSION }))
    await nextEvent(ws) // auth_result ok
    // PING well past the 300ms idle timeout that swept the silent client.
    const pinger = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: WsMessageType.PING }))
    }, 80)
    try {
      await new Promise(r => setTimeout(r, 700))
      expect(ws.readyState).toBe(WebSocket.OPEN)
      expect(connectedClientCount()).toBe(1)
    } finally {
      clearInterval(pinger)
      ws.close()
    }
  } finally {
    delete process.env.BOT_CLIENT_IDLE_TIMEOUT_MS
    stopIdleSweep()
  }
}, REAL_SOCKET_TEST_TIMEOUT_MS)
