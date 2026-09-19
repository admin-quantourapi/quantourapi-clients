/**
 * Quantour Clients — open-source self-hosting entrypoint.
 *
 * Starts the three client apps: client_api (local proxy + SQLite), the web
 * dashboard, and the Telegram bot gateway. They connect to the Quantour
 * Central API (https://api.quantourapi.com) under the owner's API key, set
 * via the dashboard or Telegram /link.
 *
 * Requires (optional, defaulted): PUBLIC_API_URL / API_URL (default
 * https://api.quantourapi.com), TELEGRAM_BOT_TOKEN for the bot, and a
 * Quantour API key linked via the dashboard or Telegram /link. See README.md.
 */
import { $ } from 'bun'
import path from 'path'

// Anchor all child cwd paths to THIS file's directory — the entrypoint must
// work regardless of where it's launched from (repo root in the Docker
// image, or a nested checkout via `bun run start`). Relative 'apps/...'
// paths resolved against the process cwd and posix_spawn failed with a
// misleading 'bun ENOENT' when the two differed.
const ROOT = path.dirname(new URL(import.meta.url).pathname)

const PORT = (n: string | undefined, dflt: string) => n || dflt

// Standalone defaults: a fresh self-hosted install talks to the public
// Quantour API with ZERO env config. (Hosted deployments may override
// PUBLIC_API_URL/API_URL to point at their own engine.)
const PUBLIC_API = process.env.PUBLIC_API_URL || 'https://api.quantourapi.com'
const CENTRAL_API = process.env.API_URL || PUBLIC_API
// Bot gateway port (apps/bot listens on 3010 by default). client_api's own
// config default (:3004) predates the standalone layout — a standalone
// install without this override silently never connects to the gateway
// (no Telegram).
const BOT_GATEWAY_PORT = PORT(process.env.BOT_GATEWAY_PORT, '3010')

console.log('🚀 Starting Quantour clients...')

const clientApi = Bun.spawn([
  'bun',
  'run',
  'src/index.ts',
], {
  cwd: path.join(ROOT, 'apps/client_api'),
  stdout: 'inherit',
  stderr: 'inherit',
  env: {
    ...process.env,
    PORT: PORT(process.env.CLIENT_API_PORT, '3006'),
    PUBLIC_API_URL: PUBLIC_API,
    API_URL: CENTRAL_API,
    BOT_WS_URL: process.env.BOT_WS_URL || `ws://localhost:${BOT_GATEWAY_PORT}/ws`,
  },
})

const dashboard = Bun.spawn([
  'bun',
  'run',
  'start',
], {
  cwd: path.join(ROOT, 'apps/dashboard'),
  stdout: 'inherit',
  stderr: 'inherit',
  env: {
    ...process.env,
    HOST: '0.0.0.0',
    PORT: PORT(process.env.DASHBOARD_PORT, '3000'),
    PUBLIC_API_URL: PUBLIC_API,
    API_URL: CENTRAL_API,
  },
})

const bot = Bun.spawn([
  'bun',
  'run',
  'src/index.ts',
], {
  cwd: path.join(ROOT, 'apps/bot'),
  stdout: 'inherit',
  stderr: 'inherit',
  env: { ...process.env, IS_API: 'false', BOT_PORT: BOT_GATEWAY_PORT },
})

const shutdown = async () => {
  clientApi.kill()
  dashboard.kill()
  bot.kill()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

await Promise.all([
  clientApi.exited,
  dashboard.exited,
  bot.exited,
]).catch(() => {})
await $`true`
