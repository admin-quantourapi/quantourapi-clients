# Changelog

Public change history for the Quantour open-source client suite
(self-hostable dashboard, Telegram signal bot, client API proxy, and the
`quantour-axi` CLI). Newest section first.

Each release adds one section at the top, titled `## YYYY-MM-DD.N` (UTC date,
dot, same-day counter). The section is written by hand when the change is
made — the publish pipeline refuses to ship code changes without a
corresponding entry here, and refuses a changelog-only change with nothing
shipped.

## 2026-09-19.2

- Docs: **feature showcase front page** — real dashboard screenshots
  (stock install on the demo environment) for home/signals/screener/
  strategy-builder/market-thesis/macro-narratives/catalysts, each with the
  feature it demonstrates; the operator's manual pages remain as depth
  beneath. Assets under `docs/assets/`.

## 2026-09-19.1

- Docs: **operator's manual added (`docs/`)** — configuration reference
  (every environment variable, per app, with defaults), architecture
  internals (components, ports, the versioned WebSocket gateway protocol,
  identity model), Telegram bot guide (key flow, command surface,
  multi-chat model), day-2 operations (upgrades, SQLite backups, health
  checks), and a troubleshooting page for the real failure classes
  (invalid key, 409 token conflicts, silent bot, WS version mismatch,
  standalone-gateway port trap). Jekyll + just-the-docs via GitHub Pages;
  `docs/llms.txt` indexes the pages for LLM consumption.

## 2026-09-16.4

- Fix (client_api): **default bot-gateway URL is now `ws://127.0.0.1:3004`
  (was `ws://localhost:3004`).** Container name resolution can prefer IPv6
  while the gateway binds IPv4, making the same-host default connection
  refuse deterministically on some container networks. Explicit IPv4 loopback
  removes the resolver-ordering dependency (explicit `BOT_WS_URL` always
  wins, as before). Real-socket tests in the bot and client_api suites use
  the same explicit form and gained CI-container headroom budgets.

## 2026-09-16.3

- Improvement (types): **MarketData domain enums are now exported constants
  with Zod companions** (`MacroExposureType`, `GlobalLiquidityTrend`,
  `LiquidityPhase`, `FedRateTrajectory`, `CohortRole`, `RecentOutcomeType` in
  `@…/core/types`). Wire values are unchanged (pure migration off string
  unions); includes a fix where the FRED liquidity *phase* vocabulary was
  assigned to the `global_liquidity.trend` field, making
  `trend == 'EXPANDING'` AST conditions unmatchable on that path.
- Improvement (resilience): Gemini rotation analysis now validates array
  entries individually — one drifted entry no longer discards the whole
  day's rotation set (partial credit with a warning).
- Improvement (ops): data-freshness sentinels derive WARN thresholds from the
  scheduler's actual task table (schedule-aware, incl. market-day/holiday
  handling) instead of static hour guesses; the morning narrative/sector DAG
  gained a midday refresh pass.

## 2026-09-16.2

- Fix (client_api): **AI translation no longer calls the decommissioned
  `gemini-2.5-flash-lite` default.** `GEMINI_TRANSLATION_MODEL` unset (or the
  `UNCONFIGURED` sentinel) now skips translation gracefully (English text
  returned, debug log) instead of silently POSTing to a retired model and
  failing. Self-hosters who previously relied on the default should set
  `GEMINI_TRANSLATION_MODEL=gemini-3.5-flash-lite` (or any current model) to
  re-enable Ukrainian translation of AI analyses.

## 2026-09-16.1

- Breaking (protocol): **WebSocket AUTH handshake now carries a protocol
  version.** `WsAuthMessage` gained a required `protocolVersion` integer
  (`WS_PROTOCOL_VERSION`, currently `1`) and the bot gateway replies with a
  new `auth_result` server message on BOTH success and failure. A gateway
  that receives a different `protocolVersion` rejects the AUTH with a
  diagnosable `auth_result { ok: false, reason, protocolVersion }` and closes
  the socket; client_api likewise stops auto-reconnecting after a version
  rejection (retrying an incompatible peer forever is noise — it logs both
  sides' versions instead). Bot and client_api shipped from the same release
  always match, so self-hosted stacks see only the new success ack in logs.
  Protocol evolution policy: additive-only (new message types / optional
  fields, never mutate existing shapes); bump `WS_PROTOCOL_VERSION` on any
  wire change. (Also fixed a latent type error in the bot's webhook fan-out —
  enum member instead of a bare string literal for `telegram_update`; no
  runtime change, the enum member is the same string.)
- Test infra: **the bot gateway now ships a WebSocket handshake integration
  test** (`apps/bot/src/index.test.ts`) — boots the real Elysia app on an
  ephemeral port and locks the AUTH accept/reject contract (matching version
  acked, future version rejected with both versions in the reason and the
  socket closed, unversioned clients dropped at schema parse, PING/PONG
  routing intact). Startup side effects (Telegram polling + fixed-port
  listen) are gated behind `import.meta.main`; `bun run apps/bot/src/index.ts`
  behavior is unchanged.
- Test infra: **client_api's version-mismatch suppression is now locked by a
  real-socket test** (`apps/client_api/src/services/telegramWsClient.test.ts`)
  — a fake gateway rejects the AUTH handshake and the client must close
  WITHOUT arming its 5s reconnect, then recover via an explicit reconnect
  against an accepting gateway. Supporting surface: `stopBotWebSocket()`
  (full teardown, also wired as the client_api SIGTERM/SIGINT handler so the
  gateway learns of shutdown immediately instead of holding a half-open
  socket) and `wsDiagnostics()` (read-only connection-state snapshot).
  `BOT_WS_URL` is now read at connect time rather than import time, so
  reconnects honor env changes.
- Ops: **keepalive timings are env-tunable** — `WS_KEEPALIVE_INTERVAL_MS` /
  `WS_KEEPALIVE_TIMEOUT_MS` (defaults unchanged: 30s probe / 90s no-traffic
  close; the timeout clamps to at least one interval so a misconfigured
  value can never close the socket before a probe was sent and awaited).
  The half-open detection itself is now locked by tests: a silent (non-PONG)
  gateway forces the client to close the hung socket and arm its reconnect,
  while PONG traffic provably resets the no-traffic window.
- Fix + Ops: **bot gateway no longer leaks disconnected clients**. The
  WebSocket context is re-wrapped per event callback, so the old
  `Set.delete(socket)` in the close handler was a silent no-op — every
  cleanly disconnected client_api stayed registered in the gateway's fan-out
  map forever (dead sockets accumulated; webhook updates were sent to them).
  Registration is now keyed by a stable per-socket id carried in
  `socket.data`. Additionally the gateway runs an **idle sweep**: a client
  silent past `BOT_CLIENT_IDLE_TIMEOUT_MS` (default 90s; healthy clients
  ping every 30s) is closed and deregistered even when the close handshake
  never arrives (half-open TCP). Both paths are covered by integration
  tests, including a pinging client never being swept.

## 2026-09-15.2

- Internal: **macro vocabulary enums in `shared-algo`**. The string-literal
  unions on `MarketData` macro fields (`stock.macro_exposure.type`,
  `macro.global_liquidity.trend`, `macro.fed_rate.trajectory`,
  `liquidityTrend`, `fedRateTrajectory`, `cohortRole`, `recentOutcomes[].type`)
  are now native string enums with Zod companions in
  `@quantour/shared-algo/src/core/types` (`MacroExposureType`,
  `GlobalLiquidityTrend`, `FedRateTrajectory`, `LiquidityPhase`, `CohortRole`,
  `RecentOutcomeType`). Wire values are unchanged (the enum members ARE the
  previous uppercase strings), so stored ASTs, cached snapshots, and API
  payloads stay compatible — this is a type-surface refactor for consumers of
  the package. The strategy-builder fallback chart now sources its mock macro
  fields from the same enums.

## 2026-09-15.1

- Fix: **strategy-builder "Live Forward Tests" tab could render empty** when
  the upstream forward-test listing was slow (per-position live quote fetches
  under rate-limit pressure). The dashboard loader now allows 3s for the list
  (matching the transaction-log race), and the API answers with batched,
  time-boxed quotes plus last-daily-close fallback, so the tab stays populated
  even while a market-data provider is degraded.

## 2026-09-10.1

- Security: **read-only API keys**. Create a key with the read-only flag
  (portal checkbox / admin console) for agents and advisors that only need to
  VIEW data — e.g. a personal AI agent you let analyze your portfolio. A
  read-only key authenticates all read surfaces (signals, metrics, budgets,
  positions) but is rejected with 403 on state-mutating and credit-consuming
  endpoints (forward tests, portfolio analyses, thesis/catalyst writes), and
  when linked into this client API it blocks local writes too: trades
  (buy/sell), optimize applies, budgets, watchlists, custom signals and
  strategies, and strategy/settings mutations. Linking a read-only key is how
  you grant an agent view access; linking a full key restores control.

## 2026-09-09.1

- Resilience + data honesty: the client API no longer ships a hardcoded
  fallback ticker list (which also fabricated sector/industry metadata).
  When the Central API is unreachable, `/market/tickers` now fails closed
  with an error — unless the installer/agent wrote a `local.universe.json`
  next to the SQLite DB (real central rows, agent-populated at setup; see
  the agent skill docs / wizard STEP 4b), which is then served as the
  outage fallback. A healthy Central API always remains the source of
  truth.
- IP hygiene: the branch performance registry (`BRANCH_STATS`) now ships
  **empty** — measured per-branch statistics (win rate, average R, holding
  period) are no longer part of the public tree. The engine mechanics are
  unchanged and the registry is now population-only via
  `registerBranchStats()` at boot. Self-hosters are unaffected by default:
  without registered data, EV scoring falls back to the pre-existing naive
  R/day path, and deployments with their own measurement data can register
  it explicitly.

## 2026-09-07.4

- i18n: strategy and branch names now go through the translation system —
  Telegram signals and `/me` render localized strategy/branch names for
  Ukrainian users (icons unchanged, still rendered per message).

## 2026-09-07.3

- Docs: repository layout guide — what each app and shared package
  (`telegram`, `shared-algo`, `ui`) is for.

## 2026-09-07.2

- Internal: client API data access consolidated onto Drizzle's typed query
  builder (boot-maintenance statements included). No behavior change.

## 2026-09-07.1 — Initial public release

- Initial public release of the client suite: visual valuation dashboard,
  Telegram signal bot with AST strategy execution, client API proxy, and the
  `quantour-axi` agent CLI.
- Generic strategy tooling ships open: AST evaluator, indicator registry, FCF
  screener views, and signal grouping — bring your own strategies.
- Self-host under one Quantour API key (dashboard :3000, client API :3006,
  bot gateway :3010).
