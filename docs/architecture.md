---
title: Architecture
nav_order: 3
---

# Architecture

## Components and ports

| Component | Default port | Role |
|-----------|--------------|------|
| Dashboard | `3000` | React Router web UI (served from the production build) |
| Client API | `3006` | Local proxy + SQLite store + client-side scanner — **the hub** |
| Bot gateway | `3010` | Telegram bot: long-polls Telegram, serves clients over WebSocket |

Every deployment has a **single owner**, set up at first run
(WordPress-style). The clients never touch the Central API's database — only
its REST endpoints, always with your API key.

## Data flow

```
Telegram ⇄ [ Bot gateway :3010 ]
                 │  WebSocket (versioned protocol)
                 ▼
[ Client API :3006 ] ── REST, keyed ──▶ api.quantourapi.com
   │  ▲
   │  └── Dashboard :3000 (HTTP)
   ▼
 local SQLite (portfolio, settings, scan cache)
```

The client-side scanner runs inside the Client API: raw setups arrive from
the Central API, and **your** strategy AST (parsed from your settings)
decides which signals surface, how they're grouped, and how alerts fan out to
chats. Signal grouping is deliberately a consumer-layer concern — the Central
API emits raw setups; your install shapes them.

## The WebSocket protocol

The Bot gateway ↔ Client API link is a **versioned** protocol:

1. The client opens the socket and sends `AUTH` carrying a required
   `protocolVersion`.
2. The gateway answers every AUTH with `AUTH_RESULT { ok, protocolVersion,
   reason? }` — and **rejects version mismatches by closing the socket**.
3. On a version rejection the client suppresses auto-reconnect (check your
   versions — one side is stale).
4. Keepalives (`WS_KEEPALIVE_*`) detect half-open connections on both sides;
   the gateway also sweeps idle clients (`BOT_CLIENT_IDLE_TIMEOUT_MS`).

The wire schemas are Zod-validated and live in `packages/telegram` — both
sides import the same contract, so a message that doesn't validate is a bug,
not a mystery. The protocol evolves **additively only**: new message types
and optional fields, never mutations of existing shapes, with a version bump
on any wire change.

## Identity model

- Your **Quantour API key** resolves to a single Central API user; every
  device/chat sharing one Client API shares one portfolio.
- The **dashboard's account** is the chat-less settings row created by the
  settings UI — not "the most recently updated row."
- Telegram chats are gated per chat (pending/approved), by the Client API —
  never by the Central API.
