---
title: Troubleshooting
nav_order: 6
---

# Troubleshooting

The failure classes you will actually hit, in rough likelihood order.

## "Invalid or inactive API key"

The linked key no longer resolves on the Central API (expired, revoked, or
cancelled subscription).

- **Fix:** re-link with `/link <new-key>` or the dashboard Settings → API
  Keys. If the key *should* work, verify it on the portal
  ([quantourapi.com](https://quantourapi.com)) before debugging locally.

## Telegram 409 Conflict

Two pollers are fighting over one bot token — you started a second instance
against the same `TELEGRAM_BOT_TOKEN`.

- **Fix:** exactly one gateway per token. Give every additional install its
  own BotFather bot.

## Bot silent / dashboard fine

The dashboard renders but Telegram never responds: the bot gateway link is
down.

- Check the gateway is listening on `BOT_PORT` (default `3010`).
- Check `BOT_WS_URL` on the Client API points at it.
- A **version mismatch** closes the socket immediately after AUTH — the
  Client API logs both versions and suppresses reconnect. That means one
  component is older than the other: rerun `bun install && bun run build`
  so both sides come from the same checkout.
- Running the Client API **standalone** (without the repo's `start.ts`
  supervisor): its built-in `BOT_WS_URL` default points at a legacy port —
  set `BOT_WS_URL=ws://127.0.0.1:3010/ws` explicitly to match the gateway's
  default port.

## Commands land but nothing answers

During market-hours scans the bot may be mid-scan; outside the configured
scan windows a `/scan` request triggers a fresh one (tens of seconds). If
`/ping` answers but `/scan` never does, check the logs for Central API
errors — the client fails loud, never fabricates signals.

## Port already in use

`3000` / `3006` / `3010` are the defaults; move them via `PORT` /
`BOT_PORT` when something else owns them. The dashboard talks to the Client
API by port, so change them as a pair.

## Reset to factory

Stop the suite, delete (or move) the SQLite store at `SQLITE_DB_PATH`,
start again: you'll get the first-run owner setup, then `/link` your key.
The old file *is* your backup — don't delete it if you might want the
portfolio history.
