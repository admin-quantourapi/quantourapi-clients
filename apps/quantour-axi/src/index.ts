import { Command } from 'commander'

import { QuantourApiClient } from './utils/apiClient'

const program = new Command()

program
  .name('quantour-axi')
  .description('Agent-eXecutable Interface (AXI) CLI for Quantour Quantitative Intelligence API (https://axi.md)')
  .version('1.0.0')
  .option('-k, --api-key <key>', 'Quantour API Key (or set QUANTOUR_API_KEY env var)')
  .option('-u, --url <url>', 'Base API URL (default: https://api.quantourapi.com or QUANTOUR_API_URL env var)')
  .option('--json', 'Format output as pure machine-readable JSON (default for agent execution)', true)
  .option('--pretty', 'Format output as formatted human-readable JSON', false)

// --- COMMAND: SCAN ---
program
  .command('scan')
  .description('Scan market equities against quantitative setups (AST, Trend Rider, Reclaim, Mean Reversion)')
  .option('-s, --sector <sector>', 'Filter by market sector (e.g. Technology, Healthcare)')
  .option('-e, --days-to-earnings <days>', 'Exclude stocks reporting earnings within X days')
  .option('-l, --limit <limit>', 'Maximum number of results to return', '20')
  .action(async (options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals()
      const client = new QuantourApiClient({ baseUrl: globalOpts.url, apiKey: globalOpts.apiKey })
      const data = await client.post('/api/v1/scan', {
        sector: options.sector,
        daysToEarnings: options.daysToEarnings ? parseInt(options.daysToEarnings, 10) : undefined,
        limit: parseInt(options.limit, 10),
      })

      outputResult(data, globalOpts.pretty)
    } catch (err: unknown) {
      handleError(err)
    }
  })

// --- COMMAND: SCORE ---
program
  .command('score')
  .description('Get institutional Free Cash Flow (FCF) anomaly and quantitative risk score for a ticker')
  .argument('<ticker>', 'Stock ticker symbol (e.g. NVDA, AAPL)')
  .action(async (ticker: string, _options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals()
      const client = new QuantourApiClient({ baseUrl: globalOpts.url, apiKey: globalOpts.apiKey })
      const data = await client.get(`/ticker/${ticker.toUpperCase()}/full-profile`)

      outputResult(data, globalOpts.pretty)
    } catch (err: unknown) {
      handleError(err)
    }
  })

// --- COMMAND: MACRO ---
program
  .command('macro')
  .description('Query current macro risk regime indicators, VIX thresholds, and narrative threat graph')
  .option('--graph', 'Include node and edge graph of active macroeconomic narratives', false)
  .action(async (options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals()
      const client = new QuantourApiClient({ baseUrl: globalOpts.url, apiKey: globalOpts.apiKey })
      const endpoint = options.graph ? '/api/v1/macro/graph' : '/api/v1/macro/status'
      const data = await client.get(endpoint)

      outputResult(data, globalOpts.pretty)
    } catch (err: unknown) {
      handleError(err)
    }
  })

// --- COMMAND: CATALYSTS ---
program
  .command('catalysts')
  .description('Get corporate catalyst calendar (upcoming earnings, SEC litigation events, macro releases)')
  .option('-t, --tab <tab>', 'Filter by catalyst tab (earnings, sec, litigation, macro)', 'earnings')
  .action(async (options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals()
      const client = new QuantourApiClient({ baseUrl: globalOpts.url, apiKey: globalOpts.apiKey })
      const data = await client.get('/api/v1/calendar', { tab: options.tab })

      outputResult(data, globalOpts.pretty)
    } catch (err: unknown) {
      handleError(err)
    }
  })

function outputResult(data: unknown, pretty?: boolean) {
  if (pretty) {
    console.log(JSON.stringify(data, null, 2))
  } else {
    console.log(JSON.stringify(data))
  }
}

function handleError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  console.error(JSON.stringify({ error: true, message }))
  process.exit(1)
}

program.parse(process.argv)
