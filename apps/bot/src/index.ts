import { html } from '@elysiajs/html'
import { 
  TelegramUpdate,
  WS_PROTOCOL_VERSION,
  WsAuthResultMessage,
  WsClientMessageSchema, 
  WsMessageType, 
  WsServerMessage, 
} from '@quantour/telegram'
import {
  Elysia,
} from 'elysia'

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const TELEGRAM_API = process.env.TELEGRAM_API_URL || 'https://api.telegram.org'

interface ClientSocket {
  send: (msg: WsServerMessage | string) => void
  close?: () => void
  data: { chatId?: string; lastSeenAt?: number; socketId?: string }
}

/**
 * chatId -> (socketId -> socket). Registered by socketId, NOT object
 * identity: the runtime re-wraps the WebSocket context per event callback
 * (message/close/open each get a different wrapper object), so a Set keyed
 * by the wrapper can never remove anything in close() — every cleanly
 * disconnected client leaked in the map forever (found by the idle-sweep
 * test 2026-09-16). `socket.data` IS stable across wraps, so the id rides
 * there and close() deregisters by id.
 */
const connectedClients = new Map<string, Map<string, ClientSocket>>()

/**
 * Idle-connection sweep: a client that dies silently (half-open TCP never
 * fires the close handler server-side) would otherwise stay registered in
 * connectedClients forever — leaking memory and making every webhook fan
 * out to a dead socket. Every INBOUND message refreshes lastSeenAt; a
 * socket silent past the idle timeout is closed and deregistered. Healthy
 * client_api instances ping every 30s, so the 90s default tolerates two
 * lost probes. Env-tunable (BOT_CLIENT_IDLE_TIMEOUT_MS), read lazily at
 * sweep start so tests can tighten it without re-importing the module.
 */
function clientIdleTimeoutMs(): number {
  const raw = process.env.BOT_CLIENT_IDLE_TIMEOUT_MS
  if (!raw) return 90_000
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 90_000
}

let idleSweepTimer: ReturnType<typeof setInterval> | null = null

function sweepIdleClients(): void {
  const timeoutMs = clientIdleTimeoutMs()
  const now = Date.now()
  for (const [chatId, clients] of connectedClients) {
    for (const [socketId, socket] of clients) {
      const idleFor = now - (socket.data.lastSeenAt ?? 0)
      if (idleFor <= timeoutMs) continue
      console.warn(`[BOT] Sweeping idle client for chat ID ${chatId} (no traffic for ${Math.round(idleFor / 1000)}s)`)
      // Deregister directly (idempotent with the close handler) AND close —
      // for a truly dead socket the close handshake may never complete, so
      // the map must not depend on the handler firing.
      clients.delete(socketId)
      try {
        socket.close?.()
      } catch {
        // Already dead — that is what the sweep is for.
      }
    }
    if (clients.size === 0) connectedClients.delete(chatId)
  }
}

export function startIdleSweep(): void {
  if (idleSweepTimer) return
  const sweepEveryMs = Math.max(50, Math.floor(clientIdleTimeoutMs() / 3))
  idleSweepTimer = setInterval(sweepIdleClients, sweepEveryMs)
}

export function stopIdleSweep(): void {
  if (idleSweepTimer) {
    clearInterval(idleSweepTimer)
    idleSweepTimer = null
  }
}

/** Total registered client sockets (health checks + tests). */
export function connectedClientCount(): number {
  let total = 0
  for (const clients of connectedClients.values()) total += clients.size
  return total
}

const app = new Elysia()
  .use(html())
  .get('/', () => {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Quantour Bot Microservice</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #090d16; color: #f3f4f6; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #111827; border: 1px solid #1f2937; padding: 2rem; border-radius: 12px; max-width: 480px; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5); text-align: center; }
    .badge { display: inline-block; background: rgba(34, 197, 94, 0.15); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.3); padding: 4px 12px; border-radius: 9999px; font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 1rem; }
    h1 { font-size: 1.5rem; margin: 0 0 0.5rem 0; font-weight: 800; }
    p { color: #9ca3af; font-size: 0.875rem; line-height: 1.5; margin: 0 0 1.5rem 0; }
    .endpoint { background: #030712; padding: 0.75rem 1rem; border-radius: 8px; border: 1px solid #1f2937; font-family: monospace; font-size: 0.825rem; color: #60a5fa; word-break: break-all; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">● Online &amp; Listening</div>
    <h1>Quantour Telegram Bot Gateway</h1>
    <p>This service manages real-time WebSocket connections and routes incoming Telegram updates &amp; trading alerts.</p>
    <div class="endpoint">WebSocket: ws://bot.localhost/ws</div>
  </div>
</body>
</html>`
  })
  .ws('/ws', {
    message(ws, rawMessage) {
      try {
        const msg = WsClientMessageSchema.parse(typeof rawMessage === 'string' ? JSON.parse(rawMessage) : rawMessage)
        const socket = ws as unknown as ClientSocket
        // Any inbound traffic proves the connection is alive — feeds the
        // idle sweep (a silent client is swept, a pinging one never is).
        socket.data.lastSeenAt = Date.now()

        if (msg.type === WsMessageType.AUTH) {
          if (msg.protocolVersion !== WS_PROTOCOL_VERSION) {
            console.error(
              `[BOT] AUTH rejected: protocol version mismatch (server=${WS_PROTOCOL_VERSION} client=${msg.protocolVersion}, chatId=${msg.chatId})`,
            )
            socket.send(
              JSON.stringify({
                type: WsMessageType.AUTH_RESULT,
                ok: false,
                protocolVersion: WS_PROTOCOL_VERSION,
                reason: `protocol version mismatch: server speaks ${WS_PROTOCOL_VERSION}, client sent ${msg.protocolVersion} — upgrade client_api`,
              } satisfies WsAuthResultMessage),
            )
            ws.close()
            return
          }
          socket.data.chatId = msg.chatId
          socket.data.socketId = crypto.randomUUID()
          let clients = connectedClients.get(msg.chatId)
          if (!clients) {
            clients = new Map()
            connectedClients.set(msg.chatId, clients)
          }
          clients.set(socket.data.socketId, socket)
          console.log(`[BOT] Client authenticated for chat ID: ${msg.chatId} (protocol v${msg.protocolVersion})`)
          socket.send(
            JSON.stringify({
              type: WsMessageType.AUTH_RESULT,
              ok: true,
              protocolVersion: WS_PROTOCOL_VERSION,
            } satisfies WsAuthResultMessage),
          )
          return
        }

        if (msg.type === WsMessageType.PING) {
          // Keepalive echo — lets client_api detect half-open connections.
          ws.send(JSON.stringify({ type: WsMessageType.PONG } satisfies WsServerMessage))
          return
        }

        // Must be authenticated to send messages
        const chatId = socket.data.chatId
        if (!chatId) {
          console.warn('[BOT] Unauthenticated client tried to send message')
          return
        }

        if (msg.type === WsMessageType.SEND_MESSAGE) {
          fetch(`${TELEGRAM_API}/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: msg.chatId,
              text: msg.text,
              parse_mode: msg.parseMode,
              reply_markup: msg.replyMarkup,
              reply_to_message_id: msg.replyToMessageId,
            }),
          }).catch(err => console.error('[BOT] Failed to send message:', err))
        } else if (msg.type === WsMessageType.EDIT_MESSAGE) {
          fetch(`${TELEGRAM_API}/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: msg.chatId,
              message_id: msg.messageId,
              text: msg.text,
              parse_mode: msg.parseMode,
              reply_markup: msg.replyMarkup,
            }),
          }).catch(err => console.error('[BOT] Failed to edit message:', err))
        } else if (msg.type === WsMessageType.DELETE_MESSAGE) {
          fetch(`${TELEGRAM_API}/bot${TELEGRAM_BOT_TOKEN}/deleteMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: msg.chatId,
              message_id: msg.messageId,
            }),
          }).catch(err => console.error('[BOT] Failed to delete message:', err))
        } else if (msg.type === WsMessageType.ANSWER_CALLBACK_QUERY) {
          fetch(`${TELEGRAM_API}/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              callback_query_id: msg.callbackQueryId,
              text: msg.text,
              show_alert: msg.showAlert,
            }),
          }).catch(err => console.error('[BOT] Failed to answer callback query:', err))
        } else if (msg.type === WsMessageType.SEND_PHOTO) {
          fetch(`${TELEGRAM_API}/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: msg.chatId,
              photo: msg.photo,
              caption: msg.caption,
              parse_mode: msg.parseMode,
              reply_markup: msg.replyMarkup,
            }),
          }).catch(err => console.error('[BOT] Failed to send photo:', err))
        } else if (msg.type === WsMessageType.SEND_DOCUMENT) {
          fetch(`${TELEGRAM_API}/bot${TELEGRAM_BOT_TOKEN}/sendDocument`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: msg.chatId,
              document: msg.document,
              caption: msg.caption,
              parse_mode: msg.parseMode,
            }),
          }).catch(err => console.error('[BOT] Failed to send document:', err))
        } else if (msg.type === WsMessageType.SEND_CHAT_ACTION) {
          fetch(`${TELEGRAM_API}/bot${TELEGRAM_BOT_TOKEN}/sendChatAction`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: msg.chatId,
              action: msg.action,
            }),
          }).catch(err => console.error('[BOT] Failed to send chat action:', err))
        } else if (msg.type === WsMessageType.SET_MY_COMMANDS) {
          const payload: { commands: { command: string; description: string }[]; language_code?: string } = { commands: msg.commands }
          if (msg.languageCode) payload.language_code = msg.languageCode
          
          fetch(`${TELEGRAM_API}/bot${TELEGRAM_BOT_TOKEN}/setMyCommands`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }).catch(err => console.error('[BOT] Failed to set commands:', err))
        }
      } catch (err) {
        console.error('[BOT] WebSocket message error:', err)
      }
    },
    close(ws) {
      const socket = ws as unknown as ClientSocket
      const chatId = socket.data.chatId
      const socketId = socket.data.socketId
      if (chatId && socketId) {
        const clients = connectedClients.get(chatId)
        if (clients) {
          // Delete by id — the wrapper object differs from the one message()
          // registered (see connectedClients comment).
          clients.delete(socketId)
          if (clients.size === 0) {
            connectedClients.delete(chatId)
          }
        }
        console.log(`[BOT] Client disconnected for chat ID: ${chatId}`)
      }
    },
  })
  .post('/webhook/telegram', async ({ body }) => {
    // Receive Telegram Update
    const update = body as TelegramUpdate
    let targetChatId: string | null = null

    if (update.message?.chat?.id) {
      targetChatId = String(update.message.chat.id)
    } else if (update.callback_query?.message?.chat?.id) {
      targetChatId = String(update.callback_query.message.chat.id)
    }

    if (targetChatId) {
      const clients = connectedClients.get(targetChatId)
      const wildcardClients = connectedClients.get('*')
      if ((clients && clients.size > 0) || (wildcardClients && wildcardClients.size > 0)) {
        const wsMessage: WsServerMessage = {
          type: WsMessageType.TELEGRAM_UPDATE,
          update: update,
        }
        if (clients) {
          for (const client of clients.values()) {
            // ALWAYS send as string: client_api does JSON.parse(event.data).
            client.send(JSON.stringify(wsMessage))
          }
        }
        if (wildcardClients) {
          for (const client of wildcardClients.values()) {
            client.send(JSON.stringify(wsMessage))
          }
        }
      } else {
        console.warn(`[BOT] No connected client_api found for chat ID: ${targetChatId}`)
      }
    }

    // Always respond 200 to Telegram
    return new Response('OK')
  })

const PORT = Number(process.env.BOT_PORT || process.env.BOT_GATEWAY_PORT) || 3010

async function startTelegramPolling() {
  let offset = 0
  console.log('[BOT] Starting polling fallback...')

  while (true) {
    if (connectedClients.size === 0) {
      await new Promise(r => setTimeout(r, 1000))
      continue
    }

    try {
      const res = await fetch(`${TELEGRAM_API}/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${offset}&timeout=30`, { signal: AbortSignal.timeout(45_000) })
      const data = await res.json() as { ok: boolean; result: TelegramUpdate[] }

      if (!data.ok) {
        console.error('[BOT] getUpdates not ok', data)
        await new Promise(r => setTimeout(r, 5000))
        continue
      }

      for (const update of data.result) {
        const text = update.message?.text
        console.log(`[BOT] Poll update_id=${update.update_id} text=${text ?? '(no text)'}`)
        const fwd = await fetch(`http://127.0.0.1:${PORT}/webhook/telegram`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(update),
          signal: AbortSignal.timeout(5_000),
        })
        if (!fwd.ok) {
          console.error(`[BOT] webhook forward failed: ${fwd.status} — not acking ${update.update_id}`)
          break
        }
        offset = update.update_id + 1
      }
    } catch (e) {
      console.error('[BOT] Polling error', e)
      await new Promise(r => setTimeout(r, 5000))
    }
  }
}

// Startup side effects (polling loop + fixed-port listen) run ONLY when this
// file is the process entry (`bun run apps/bot/src/index.ts`, start.ts spawn,
// Docker CMD). Test/programmatic importers get the bare app and drive it with
// app.listen(0) on an ephemeral port.
if (import.meta.main) {
  startTelegramPolling().catch(console.error)
  startIdleSweep()
  app.listen(PORT, () => {
    console.log(`[BOT] Telegram Gateway Microservice running on port ${PORT}`)
  })
}

export { app }
