---
title: Telegram bot
nav_order: 4
---

# Telegram bot

The bot is the conversational front-end: signal alerts, portfolio
management, and the daily market wrap — all backed by the Client API.

## Getting a bot

1. Talk to `@BotFather` on Telegram → `/newbot` → copy the token.
2. Put `TELEGRAM_BOT_TOKEN` in the Client API environment.
3. Restart, then `/start` your bot from Telegram and follow the approval
   flow.

**One token, one gateway.** Two pollers on one token fight over updates
(Telegram answers `409`) — if you run a second instance, give it its own
BotFather bot.

## Linking your Quantour key

```
/link quantour_XXXX
```

The key is validated against the Central API, stored in local SQLite, and
from then on every chat and device sharing this Client API sees **one
portfolio**. Re-linking with a different key switches the account.

## Command surface

`/help` inside the bot is the canonical, always-current list — it matches
the shipped code exactly. The highlights:

- **Signals**: `/scan` (fresh scan), `/top` (ROI-sorted actionable setups
  and positions), `/analyze <TICKER>` (technical + sentiment deep dive)
- **Portfolio**: `/status`, `/budget <total> <risk>` (the money identity:
  deployed + free cash = budget), `/risk`, `/freecash`
- **Daily**: `/report` — the market wrap with next-day outlook
- **Position care**: `/exit <TICKER>` — exit-strategy suggestion; stop-loss
  maintenance is automatic (tighten-only) while a position holds a fresh
  signal

## Multi-chat behavior

Each Telegram chat is approved individually (pending → approved), and all
approved chats share the same portfolio and budget. Access control lives in
the Client API — revoking a chat never touches the Central API.

## Stop-refresh notifications

When an open position receives a fresh signal, the bot tightens its
protective levels and notifies you — moves are **tighten-only** (a stop or
target never loosens), and each notification carries a
**Why did they move?** button explaining the signal branch and levels
behind the change.
