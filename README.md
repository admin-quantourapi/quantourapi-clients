# Quantour Clients

Open-source self-hosting suite for the [Quantour](https://quantourapi.com) quantitative signal platform — a web dashboard, Telegram bot, and local API proxy unified under a single Quantour API key.

## What's included

- **Dashboard** — visual FCF screener, signal alerts, snowflake market-thesis radar, portfolio tracking, and an AST strategy builder.
- **Telegram Bot** — conversational signal alerts, portfolio management, and `/report` daily wraps.
- **Client API** — a local proxy (SQLite-backed) that unifies every device and chat under one Quantour API key and runs the client-side scanner.

## Repository layout

- **`apps/`** — the deployable pieces: `dashboard` (visual UI), `client_api` (local SQLite-backed proxy that unifies devices and runs the client-side scanner), `bot` (the Telegram bot gateway), and `quantour-axi` (the agent CLI).
- **`packages/telegram`** — the shared WebSocket protocol contract between the client API and the Telegram bot gateway: Zod-validated message schemas and Telegram update types, so both sides speak the same verified wire format.
- **`packages/shared-algo`** — the strategy engine you can script against: AST evaluator, indicator registry, FCF screener views, and signal grouping.
- **`packages/ui`** — shared theme tokens used by the dashboard.

## Architecture

Each deployment has a single owner, set up at first run (WordPress-style). The clients talk to the **Quantour Central API** (`https://api.quantourapi.com`), which requires an API key purchased separately at [quantourapi.com](https://quantourapi.com). The clients never access the Central API's database directly — only via its REST endpoints.

```
[ Dashboard ] ─┐
[ Telegram  ] ─┼─▶ [ Client API (local SQLite) ] ─▶ [ Quantour Central API ]
[ Your code ] ─┘                                       (B2D, requires API key)
```

## Quick start

```bash
git clone https://github.com/admin-quantourapi/quantourapi-clients.git && cd quantourapi-clients
bun install
bun run build          # production dashboard build (required before start)
bun run start          # dashboard :3000 · client API :3006 · bot gateway :3010
```

Then link your Quantour API key: open `http://localhost:3000` → Settings → API Keys,
or `POST /api/settings {"quantourApiKey": "..."}` on the client API (or Telegram `/link <key>`).

Environment (all optional, sensibly defaulted): `PUBLIC_API_URL` + `API_URL`
(default `https://api.quantourapi.com`), `TELEGRAM_BOT_TOKEN`, `SQLITE_DB_PATH`.
The API key is NOT an env var — it is linked at runtime and stored in local SQLite.

## Strategy configuration (bring your own)

The suite ships Quantour's **generic strategy tooling** — an AST (strategy script) evaluator, the indicator registry, the FCF screener views, and signal-grouping — so you can define, evaluate, and manage your own strategies against the data the Quantour API serves. Paste an AST into the dashboard's strategy builder or set `mainStrategyAst`. The clients evaluate whatever AST you configure; proprietary tuned strategies are not included.

## Documentation

The [operator's manual lives in `docs/`](./docs/index.md) — configuration
reference, architecture internals, the Telegram bot guide, operations, and
troubleshooting. (It also renders as a GitHub Pages site when enabled for
this repo.) For marketing, pricing, and the API product itself see
[quantourapi.com](https://quantourapi.com); for agent-driven installs see
[QUANTOUR_AGENT.md](https://quantourapi.com/QUANTOUR_AGENT.md).

## Releases

Releases are published automatically from the Quantour development tree as a
single verified snapshot per release (`chore: publish release YYYY-MM-DD.N`).
What changed in each release is described by hand in [CHANGELOG.md](./CHANGELOG.md)
— newest section first.

This repository is written to by the publish pipeline only. Pull requests are
reviewed here but ported into the development tree by the maintainers, and
ship with the next release snapshot.

## About this repository

This repository is the official distribution of the Quantour client suite (dashboard, Telegram bot, client API). It is assembled and verified automatically from the Quantour development tree; internal tooling and configuration are intentionally not part of the distribution.

- **Issues & discussions**: file GitHub issues for bugs and feature requests.
- **Pull requests**: small, focused PRs are welcome and are reviewed by the maintainers.

Quantour Clients is released under the Apache 2.0 license.

