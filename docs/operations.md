---
title: Operations
nav_order: 5
---

# Operations

Day-2 guide for keeping an install healthy.

## Start order & build

```bash
bun install
bun run build     # production dashboard build — required before start
bun run start     # dashboard :3000 · Client API :3006 · bot gateway :3010
```

`bun run start` supervises the processes; for service-manager deploys, run
`start.ts` under your init system and give it a working directory at the
repo root.

## Upgrades

```bash
git pull
bun install
bun run build
# restart the service
```

The local SQLite store is forward-migrating: on boot the Client API
introspects its schema and applies pending `ALTER`s itself — no manual
migration step. Your data (portfolio, settings, trades) survives upgrades.

## Backups

Everything local lives in **one file** — the SQLite store at `SQLITE_DB_PATH`
(default `local.db` at the repo root):

```bash
sqlite3 local.db '.backup /path/to/backup.db'
```

Back that file up and you can reconstruct the install anywhere: link the
same Quantour key, restore the file, restart. The Central API holds nothing
that a restore needs beyond the key itself.

## Health checks

- `GET /ping` on the Client API answers when the process and its store are
  up.
- The bot gateway logs its WebSocket client roster — a dashboard that
  renders but never updates usually means the gateway link (see
  [Troubleshooting](troubleshooting.md)).
- Watch the logs, not just the process: the suite fails loud (and logs the
  reason) rather than serving stale silence.

## Resource shape

A stock install is light: the scanner is scheduled work (BullMQ-backed when
Redis is available), the SQLite store stays small (portfolio + cache), and
the dashboard is a static production build. A 1 vCPU / 1 GB box runs the
full suite comfortably.
