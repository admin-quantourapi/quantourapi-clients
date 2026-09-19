import {
  TelegramUpdate,
  WS_PROTOCOL_VERSION,
  WsAuthMessage,
  WsClientMessage,
  WsMessageType,
  WsServerMessageSchema,
} from '@quantour/telegram'

import { db } from '../db'
import { settings } from '../db/clientSchema'
import * as handlers from '../server/botHandlers'

import { processUpdate } from './telegramService'

/**
 * Read lazily at connect time (NOT module scope): test files that transitively
 * import this module can pin the URL via BOT_WS_URL before driving
 * initBotWebSocket, regardless of import order — and reconnects pick up env
 * changes instead of caching the first value forever.
 */
function botWsUrl(): string {
  // 127.0.0.1, not localhost: container name resolution can prefer IPv6
  // while the gateway binds IPv4 — a same-host default must not depend on
  // resolver ordering.
  return process.env.BOT_WS_URL || 'ws://127.0.0.1:3004/ws'
}

/**
 * Application-level keepalive. The gateway echoes a PONG for every PING we
 * send, so a healthy connection produces server traffic at least every
 * keepalive interval. If nothing arrives for the keepalive timeout the
 * socket is hung (half-open TCP never fires onclose on its own) and we force
 * a close so the normal reconnect path takes over — otherwise /link and all
 * commands silently stop working while the gateway still holds the socket.
 *
 * Timings are env-tunable (WS_KEEPALIVE_INTERVAL_MS / WS_KEEPALIVE_TIMEOUT_MS,
 * defaults 30s / 90s) — read per startKeepalive so tests and operators can
 * tighten them without re-importing the module. The timeout is clamped to at
 * least one interval so a misconfigured timeout can never close the socket
 * before a single probe has been sent and awaited.
 */
function keepaliveIntervalMs(): number {
  return positiveIntEnv('WS_KEEPALIVE_INTERVAL_MS', 30_000)
}

function keepaliveTimeoutMs(intervalMs: number): number {
  return Math.max(positiveIntEnv('WS_KEEPALIVE_TIMEOUT_MS', 90_000), intervalMs)
}

function positiveIntEnv(name: string, dflt: number): number {
  const raw = process.env[name]
  if (!raw) return dflt
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : dflt
}

let ws: WebSocket | null = null
let reconnectTimer: Timer | null = null
let keepaliveTimer: Timer | null = null
let lastServerMessageAt = Date.now()
/**
 * Set when the gateway rejected our AUTH with a protocol version mismatch.
 * Suppresses the automatic reconnect loop — retrying an incompatible peer
 * every 5s forever is noise, not recovery. Cleared only by an explicit
 * reconnectBotWebSocket() (operator action after upgrading).
 */
let versionMismatch = false

function stopKeepalive() {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer)
    keepaliveTimer = null
  }
}

function startKeepalive() {
  stopKeepalive()
  lastServerMessageAt = Date.now()
  const intervalMs = keepaliveIntervalMs()
  const timeoutMs = keepaliveTimeoutMs(intervalMs)
  keepaliveTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const sinceLast = Date.now() - lastServerMessageAt
    if (sinceLast > timeoutMs) {
      console.warn(`[WS] No server traffic for ${Math.round(sinceLast / 1000)}s — closing hung connection to reconnect`)
      ws.close()
      return
    }
    const ping: WsClientMessage = { type: WsMessageType.PING }
    try {
      ws.send(JSON.stringify(ping))
    } catch {
      // Ignore — the close path will handle a dead socket.
    }
  }, intervalMs)
}

export async function initBotWebSocket() {
  const defaultSettings = await db.select().from(settings).limit(1)
  const CHAT_ID = defaultSettings[0]?.telegramChatId

  if (!CHAT_ID) {
    console.warn('[WS] telegramChatId not set in db, connecting as wildcard to receive /link commands')
  }
  
  const authChatId = CHAT_ID || '*'

  function connect() {
    console.log(`[WS] Connecting to bot proxy at ${botWsUrl()}...`)
    ws = new WebSocket(botWsUrl())

    ws.onopen = () => {
      console.log('[WS] Connected to bot proxy')
      // Local capture + readyState guard: a socket closed between connect and
      // this late-firing callback (gateway rejects fast; tests stop the
      // client) must not throw InvalidStateError into unrelated handlers.
      const socket = ws
      if (!socket || socket.readyState !== WebSocket.OPEN) return
      // Authenticate with our chatId + protocol version (handshake: the
      // gateway rejects mismatches with AUTH_RESULT ok:false and closes).
      const auth: WsAuthMessage = { type: WsMessageType.AUTH, chatId: authChatId, protocolVersion: WS_PROTOCOL_VERSION }
      socket.send(JSON.stringify(auth))
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      startKeepalive()

      // Synchronize bot commands with Telegram
      import('./telegramService').then(mod => {
        mod.setBotCommands().catch(err => console.error('[WS] Failed to set bot commands', err))
      }).catch(console.error)
    }

    ws.onmessage = (event) => {
      try {
        lastServerMessageAt = Date.now()
        const msg = WsServerMessageSchema.parse(JSON.parse(event.data))
        if (msg.type === WsMessageType.AUTH_RESULT) {
          if (msg.ok) {
            console.log(`[WS] Authenticated with bot proxy (protocol v${msg.protocolVersion})`)
          } else {
            versionMismatch = true
            console.error(
              `[WS] Bot proxy rejected AUTH: ${msg.reason ?? 'unknown reason'} ` +
                `(server protocol v${msg.protocolVersion}, client protocol v${WS_PROTOCOL_VERSION}) ` +
                '— not reconnecting. Upgrade client_api (or the gateway) to a matching release.',
            )
            ws?.close()
          }
          return
        }
        if (msg.type === WsMessageType.TELEGRAM_UPDATE) {
          // Process the update locally using existing handlers
          processUpdate(msg.update as TelegramUpdate, handlers).catch(console.error)
        }
      } catch (err) {
        console.error('[WS] Failed to parse server message', err)
      }
    }

    ws.onclose = () => {
      if (versionMismatch) {
        console.error('[WS] Connection closed after protocol version rejection — auto-reconnect suppressed')
        ws = null
        stopKeepalive()
        return
      }
      console.log('[WS] Disconnected from bot proxy, scheduling reconnect...')
      ws = null
      stopKeepalive()
      scheduleReconnect()
    }

    ws.onerror = (err) => {
      console.error('[WS] Error:', err)
    }
  }

  function scheduleReconnect() {
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        connect()
      }, 5000)
    }
  }

  connect()
}

export function sendWsMessageToBot(msg: WsClientMessage) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
    return true
  } else {
    console.warn('[WS] Cannot send message, WebSocket not connected')
    return false
  }
}

/** Read-only snapshot of the connection lifecycle state (tests + health checks). */
export function wsDiagnostics(): { connected: boolean; versionMismatch: boolean; reconnectScheduled: boolean } {
  return {
    connected: ws !== null && ws.readyState === WebSocket.OPEN,
    versionMismatch,
    reconnectScheduled: reconnectTimer !== null,
  }
}

/**
 * Full teardown: closes the socket, stops keepalive, cancels any pending
 * reconnect, and clears the version-mismatch latch. Called on process
 * shutdown (SIGTERM/SIGINT) so the bot gateway learns of the disconnect
 * immediately instead of holding a half-open socket until its own keepalive
 * notices — and used by tests to avoid leaking timers across suites.
 */
export function stopBotWebSocket(): void {
  if (ws) {
    ws.onclose = null // teardown, not disconnect: no auto-reconnect
    ws.onmessage = null
    ws.onerror = null
    try {
      ws.close()
    } catch {
      // Already closed/closing — nothing to do.
    }
    ws = null
  }
  stopKeepalive()
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  versionMismatch = false
}

export async function reconnectBotWebSocket(): Promise<void> {
  versionMismatch = false // explicit reconnect re-evaluates the handshake
  if (ws) {
    ws.onclose = null // prevent auto-reconnect
    ws.close()
    ws = null
  }
  stopKeepalive()
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  await initBotWebSocket()
  
  // Wait for connection to be OPEN
  return new Promise((resolve) => {
    let attempts = 0
    const checkInterval = setInterval(() => {
      attempts++
      if (ws && ws.readyState === WebSocket.OPEN) {
        clearInterval(checkInterval)
        resolve()
      } else if (attempts > 50) { // Timeout after 5s
        clearInterval(checkInterval)
        resolve()
      }
    }, 100)
  })
}
