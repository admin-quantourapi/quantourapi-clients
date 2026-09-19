---
title: Configuration
nav_order: 2
---

# Configuration reference

The suite is configured by environment variables with sensible defaults —
a stock install needs **zero** configuration beyond linking your API key.
Variables can live in the process environment or your service manager.

## The API key is not an env var

The one thing every install needs — your Quantour API key — is linked at
**runtime** and stored in the local SQLite database:

- Dashboard: `http://localhost:3000` → Settings → API Keys
- Telegram: `/link <your-key>` in any chat the bot owns
- HTTP: `POST /api/settings {"quantourApiKey": "..."}` on the Client API

Storing it in SQLite (not env) is deliberate: one key, one portfolio, shared
across every device and chat that talks to the same Client API.

## Client API (`apps/client_api`)

| Variable | Default | Purpose |
|----------|---------|---------|
| `PUBLIC_API_URL` | `https://api.quantourapi.com` | Central API base URL for public/B2D endpoints |
| `API_URL` | same as `PUBLIC_API_URL` | Central API base URL (override both together if you point at a mirror) |
| `SQLITE_DB_PATH` | local `local.db` | Path to the local SQLite store (your portfolio, settings, cache) |
| `PORT` | `3006` | Client API listen port |
| `TELEGRAM_BOT_TOKEN` | *(unset)* | The BotFather token for your bot — required for the Telegram features |
| `BOT_WS_URL` | *(derived)* | WebSocket URL of the bot gateway; only needed for exotic topologies |

## Bot gateway (`apps/bot`)

| Variable | Default | Purpose |
|----------|---------|---------|
| `BOT_PORT` | `3010` | Gateway HTTP listen port |
| `BOT_GATEWAY_PORT` | same as `BOT_PORT` | Explicit gateway port when the process serves more than the gateway |
| `TELEGRAM_BOT_TOKEN` | *(unset)* | BotFather token — **one token, one gateway** (see [Troubleshooting](troubleshooting.md)) |
| `TELEGRAM_API_URL` | official Telegram API | Override for proxied/self-hosted Telegram API access |
| `BOT_CLIENT_IDLE_TIMEOUT_MS` | `90000` | Idle sweep: silently-dead client connections are closed after this window |
| `WS_KEEPALIVE_INTERVAL_MS` | `30000` | WebSocket keepalive ping interval |
| `WS_KEEPALIVE_TIMEOUT_MS` | `90000` | Keepalive pong window (clamped to ≥ one interval) |

Keepalive tuning only matters on lossy networks — the defaults detect
half-open connections within ~90 s without false positives.

## Dashboard (`apps/dashboard`)

Served by the Client API's neighborhood; no dedicated variables beyond the
Client API set. Production runs require `bun run build` before start (the
README quick start shows the exact sequence).
