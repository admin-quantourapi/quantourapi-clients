import { Surface } from 'app/components/Surface'
import { getSessionFromServer } from 'app/lib/auth-helpers'
import { requireEnv } from 'app/utils/env.server'
import {
  Link, useLoaderData, 
} from 'react-router'
import { z } from 'zod'

import type { Route } from './+types/positions'

// Runtime validation schema for the /api/portfolio/optimize response shape.
// Mirrors the RotationResult / PortfolioAction / TargetPosition interfaces
// in packages/shared-algo/src/finance-algo/screener.ts. We parse the JSON
// from client_api with this — never trust it via `as` — runtime type safety.
const PortfolioActionSchema = z.object({
  type: z.enum([
    'SELL',
    'TRIM',
    'BUY',
  ]),
  ticker: z.string(),
  shares: z.number(),
  price: z.number(),
  amountUsd: z.number(),
  reasonKey: z.string().optional(),
  reasonData: z.record(z.string(), z.union([
    z.string(),
    z.number(),
  ])).optional(),
})

const TargetPositionSchema = z.object({
  ticker: z.string(),
  shares: z.number(),
  price: z.number(),
  allocatedUsd: z.number(),
  pctAllocation: z.number(),
})

const RotationResultSchema = z.object({
  rotations: z.array(z.object({
    sell: z.string(),
    buy: z.string(),
    shares: z.number().optional(),
    price: z.number().optional(),
    allocatedUsd: z.number().optional(),
    riskUsd: z.number().optional(),
    reasonKey: z.string(),
    reasonData: z.record(z.string(), z.union([
      z.string(),
      z.number(),
    ])),
  }).passthrough()),
  targetPortfolio: z.array(TargetPositionSchema.passthrough()),
  actions: z.array(PortfolioActionSchema.passthrough()),
  rationale: z.enum([
    'INITIAL_ALLOCATION',
    'RECOMMENDATIONS',
    'ALREADY_OPTIMIZED',
    'NO_SETUPS',
  ]),
})

type OptimizeAction = z.infer<typeof PortfolioActionSchema>
type OptimizeTarget = z.infer<typeof TargetPositionSchema>
type OptimizeResult = z.infer<typeof RotationResultSchema>

type OptimizeActionData =
  | { intent: 'optimize'; ok: true; rotationResult: OptimizeResult; scoreGainMultiplier: number }
  | { intent: 'optimize'; ok: false; error: string }
  | { intent: 'apply_optimization'; ok: true; applied: number }
  | { intent: 'apply_optimization'; ok: false; error: string }

export async function action({ request }: Route.ActionArgs) {
  const session = await getSessionFromServer(request)
  if (!session) {
    throw new Response('Unauthorized', { status: 403 })
  }

  const clientApiUrl = requireEnv('CLIENT_API_URL')
  const formData = await request.formData()
  const intent = formData.get('intent')

  try {
    if (intent === 'buy') {
      const ticker = String(formData.get('ticker') || '').trim()
      const shares = parseInt(String(formData.get('shares') || '1'), 10)
      if (!ticker) return { error: 'Ticker is required' }

      const res = await fetch(`${clientApiUrl}/api/trades/buy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker, shares }),
      })
      if (!res.ok) return { error: 'Failed to buy position' }
      return { success: true, message: `Successfully bought ${shares} ${ticker.toUpperCase()}` }
    }

    if (intent === 'sell') {
      const ticker = String(formData.get('ticker') || '').trim()
      if (!ticker) return { error: 'Ticker is required' }

      const res = await fetch(`${clientApiUrl}/api/trades/sell`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker }),
      })
      if (!res.ok) return { error: 'Failed to sell position' }
      return { success: true, message: `Successfully sold position ${ticker.toUpperCase()}` }
    }

    if (intent === 'update_budget') {
      const totalCapital = parseFloat(String(formData.get('totalCapital') || '0'))
      const maxRiskPerTrade = parseFloat(String(formData.get('maxRiskPerTrade') || '0'))
      if (totalCapital <= 0) return { error: 'Invalid total capital' }

      const res = await fetch(`${clientApiUrl}/api/portfolio/budget`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ totalCapital, maxRiskPerTrade }),
      })
      if (!res.ok) return { error: 'Failed to update budget' }
      return { success: true, message: 'Budget updated successfully' }
    }

    if (intent === 'optimize') {
      // Mirror Telegram /optimize: compute target portfolio + action plan.
      // Returns the structured RotationResult so the dashboard renders it
      // natively (no Telegram HTML strings). The ~10-15s estimate matches
      // the Telegram ACK message.
      try {
        const res = await fetch(`${clientApiUrl}/api/portfolio/optimize`, {
          headers: { 'Connection': 'close' },
          cache: 'no-store',
          signal: AbortSignal.timeout(20000),
        })
        if (!res.ok) {
          return { intent: 'optimize' as const, ok: false, error: `Optimize failed (${res.status})` }
        }
        const json = await res.json() as {
          success: boolean
          error?: string
          rotationResult?: unknown
          scoreGainMultiplier?: number
        }
        if (!json.success) {
          const err = json.error || 'UNKNOWN'
          const friendly = err === 'NO_ACCOUNT'
            ? 'No Quantour API key configured. Link a key in Instance Settings first.'
            : err === 'CONFIG_MISSING_SCOREGAINMULTIPLIER'
              ? 'Strategy AST missing required rotationRules.scoreGainMultiplier. Configure it in Strategy Builder.'
              : `Optimize failed: ${err}`
          return { intent: 'optimize' as const, ok: false, error: friendly }
        }
        // Validate the rotationResult shape with Zod before trusting it
        // parse dynamic JSON, never blind `as` casts.
        const parsed = RotationResultSchema.safeParse(json.rotationResult)
        if (!parsed.success) {
          return { intent: 'optimize' as const, ok: false, error: 'Optimize returned an unexpected result shape.' }
        }
        return {
          intent: 'optimize' as const,
          ok: true,
          rotationResult: parsed.data,
          scoreGainMultiplier: typeof json.scoreGainMultiplier === 'number' ? json.scoreGainMultiplier : 2.5,
        }
      } catch (e) {
        return { intent: 'optimize' as const, ok: false, error: e instanceof Error ? e.message : 'Optimize request failed' }
      }
    }

    if (intent === 'apply_optimization') {
      try {
        const res = await fetch(`${clientApiUrl}/api/portfolio/apply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
          cache: 'no-store',
          signal: AbortSignal.timeout(15000),
        })
        if (!res.ok) {
          return { intent: 'apply_optimization' as const, ok: false, error: `Apply failed (${res.status})` }
        }
        const json = await res.json() as { success: boolean; applied?: number; error?: string }
        if (!json.success) {
          const err = json.error || 'UNKNOWN'
          const friendly = err === 'NO_CACHED_RESULT'
            ? 'No pending optimization to apply. Click Optimize first.'
            : err === 'NO_ACCOUNT'
              ? 'No Quantour API key configured.'
              : `Apply failed: ${err}`
          return { intent: 'apply_optimization' as const, ok: false, error: friendly }
        }
        return { intent: 'apply_optimization' as const, ok: true, applied: json.applied ?? 0 }
      } catch (e) {
        return { intent: 'apply_optimization' as const, ok: false, error: e instanceof Error ? e.message : 'Apply request failed' }
      }
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Action failed' }
  }

  return null
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = await getSessionFromServer(request)
  if (!session) {
    throw new Response('Unauthorized', { status: 403 })
  }

  const clientApiUrl = requireEnv('CLIENT_API_URL')
  let settings: Record<string, unknown> = {}
  let trades: Record<string, unknown>[] = []
  let historyData: { auditLogs?: Record<string, unknown>[]; pnlSeries?: Record<string, unknown>[]; pnlHistory?: Record<string, unknown>[]; stats?: Record<string, unknown>; totalAuditLogs?: number; page?: number; pageSize?: number } = {}
  let budget: { totalCapital?: string; maxRiskPerTrade?: string; maxRiskPerTradeUsd?: number; availableCash?: number; deployedUsd?: number } = {}

  const error: string | null = null
  const url = new URL(request.url)
  const page = url.searchParams.get('page') || '1'
  const timeframe = url.searchParams.get('timeframe') || 'mtd'

  // News-divergence badges for held positions (company vs sector news).
  // Degrades to an empty map — no badge rather than a fabricated one.
  const newsAlignment: Record<string, { newsScore: number | null; sectorNewsScore: number | null; newsDivergence: number | null; newsAlignment: string | null; structural: boolean; thesisVerdict: string | null; thesisDaysHeld: number | null; thesisHorizonDays: number | null }> = {}
  try {
    const res = await fetch(`${clientApiUrl}/api/positions/news-alignment`, { headers: { 'Connection': 'close' }, cache: 'no-store' })
    if (res.ok) {
      const parsed = await res.json() as { items?: Array<{ ticker: string; newsScore: number | null; sectorNewsScore: number | null; newsDivergence: number | null; newsAlignment: string | null; structural: boolean; thesisVerdict: string | null; thesisDaysHeld: number | null; thesisHorizonDays: number | null }> }
      for (const item of parsed.items ?? []) {
        newsAlignment[item.ticker.toUpperCase()] = {
          newsScore: item.newsScore,
          sectorNewsScore: item.sectorNewsScore,
          newsDivergence: item.newsDivergence,
          newsAlignment: item.newsAlignment,
          structural: item.structural,
          thesisVerdict: item.thesisVerdict,
          thesisDaysHeld: item.thesisDaysHeld,
          thesisHorizonDays: item.thesisHorizonDays,
        }
      }
    }
  } catch {
    // no badges — fine
  }

  try {
    const res = await fetch(`${clientApiUrl}/api/settings`, {
      headers: { 'Connection': 'close' },
      cache: 'no-store',
    })
    if (res.ok) {
      settings = await res.json()
    }
  } catch (e) {
    console.error('Failed to fetch settings from client_api', e)
  }

  try {
    const [
      tradesRes,
      historyRes,
      budgetRes,
    ] = await Promise.all([
      fetch(`${clientApiUrl}/api/trades`, { headers: { 'Connection': 'close' }, cache: 'no-store' }),
      fetch(`${clientApiUrl}/api/trades/history?page=${page}&pageSize=20&timeframe=${timeframe}`, { headers: { 'Connection': 'close' }, cache: 'no-store' }),
      fetch(`${clientApiUrl}/api/portfolio/budget`, { headers: { 'Connection': 'close' }, cache: 'no-store' }),
    ])
    if (tradesRes.ok) {
      trades = await tradesRes.json()
    }
    if (historyRes.ok) {
      historyData = await historyRes.json()
    }
    if (budgetRes.ok) {
      budget = await budgetRes.json()
    }
  } catch (e) {
    console.error('Failed to fetch trades or history from client_api', e)
  }

  return {
    settings, trades, historyData, budget, newsAlignment, error,
  }
}

import {
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Title,
  Tooltip,
} from 'chart.js'
import {
  useEffect, useMemo, useState,
} from 'react'
import { Line } from 'react-chartjs-2'
import {
  Form, useActionData, useFetcher, useRevalidator, useSearchParams, 
} from 'react-router'

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
)

export default function Positions() {
  const {
    settings, trades, historyData, budget, newsAlignment, error, 
  } = useLoaderData<typeof loader>()
  const actionData = useActionData<typeof action>()
  const revalidator = useRevalidator()

  // Optimize panel state — independent fetchers so the trades table doesn't
  // reload until Apply succeeds. Mirrors Telegram /optimize parity: Optimize
  // computes the target portfolio + action plan; Apply executes it.
  const optimizeFetcher = useFetcher<typeof action>()
  const applyFetcher = useFetcher<typeof action>()
  const [
    dismissed,
    setDismissed,
  ] = useState(false)

  // Reset "dismissed" whenever a new optimize request starts so the panel
  // (and its loading skeleton) re-appears.
  useEffect(() => {
    if (optimizeFetcher.state === 'submitting') setDismissed(false)
  }, [
    optimizeFetcher.state,
  ])

  const optimizeData = optimizeFetcher.data as OptimizeActionData | undefined
  const optimizeLoading = optimizeFetcher.state !== 'idle'

  // On Apply success: dismiss the panel + revalidate the trades table so the
  // newly-bought/sold/trimmed positions render.
  const applyData = applyFetcher.data as Extract<OptimizeActionData, { intent: 'apply_optimization' }> | undefined
  const applyLoading = applyFetcher.state !== 'idle'
  useEffect(() => {
    if (applyData?.intent === 'apply_optimization' && applyData.ok) {
      setDismissed(true)
      revalidator.revalidate()
    }
  }, [
    applyData,
    revalidator,
  ])

  const showOptimizePanel = !dismissed && (optimizeLoading || optimizeData?.intent === 'optimize')

  // Real-time 5-second polling when tab is active
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        revalidator.revalidate()
      }
    }, 5000)
    return () => clearInterval(interval)
  }, [
    revalidator,
  ])

  const apiKey = (settings?.quantourApiKey as string) || 'Not Configured'
  // Budget is the canonical per-user value from user_budgets (resolved via
  // GET /api/portfolio/budget). maxRiskPerTrade is raw ('3%' allowed); the form
  // is a numeric $ input, so prefill the effective $ (maxRiskPerTradeUsd).
  const totalCapital = budget?.totalCapital || ''
  const maxRiskPerTradeRaw = budget?.maxRiskPerTrade || ''
  const maxRiskPerTradeUsd = budget?.maxRiskPerTradeUsd
  const isPercentRisk = maxRiskPerTradeRaw.endsWith('%')

  const [
    searchParams,
  ] = useSearchParams()
  const currentTimeframe = searchParams.get('timeframe') || 'mtd'
  const timeframeOptions: Array<{ key: string; label: string }> = [
    { key: 'wtd', label: 'WTD' },
    { key: 'mtd', label: 'MTD' },
    { key: 'ytd', label: 'YTD' },
    { key: 'all', label: 'All' },
  ]

  // @ts-expect-error stage typing
  const activeTrades = trades.filter((t) => t.stage < 4)
  const auditLogs = historyData?.auditLogs || []
  const pnlSeries = historyData?.pnlSeries || []
  const pnlHistory = historyData?.pnlHistory || []
  const totalAuditLogs = historyData?.totalAuditLogs || 0
  const currentPage = historyData?.page || 1
  const pageSize = historyData?.pageSize || 20
  const totalPages = Math.max(1, Math.ceil(totalAuditLogs / pageSize))

  // Compute account-level budget readouts. Deployed is the LIVE market value
  // of holdings and Available is budget − deployed (budget = deployed + free
  // cash identity), both computed server-side by GET /api/portfolio/budget.
  // Fall back to cost-basis from the loaded trades only if the endpoint failed.
  const deployedCapital = budget?.deployedUsd !== undefined
    ? budget.deployedUsd
    : activeTrades.reduce((sum, t) => sum + (parseFloat(String(t.capitalDeployed || '0'))), 0)
  const availableCash = budget?.availableCash !== undefined
    ? budget.availableCash
    : Math.max(0, (parseFloat(totalCapital) || 0) - deployedCapital)

  // Compute cumulative PnL chart data points from pnlSeries (timeframe-filtered, ordered ASC)
  let cumulativePnl = 0
  const chartLabels: string[] = [
    'Start',
  ]
  const chartPoints: number[] = [
    0,
  ]

  pnlSeries.forEach((point: Record<string, unknown>, idx: number) => {
    const pnl = parseFloat(String(point.pnlUsd || '0'))
    cumulativePnl += pnl
    const d = point.exitDate ? new Date(point.exitDate as string) : null
    chartLabels.push(d
      ? `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${(point.ticker as string) || ''}`
      : `${(point.ticker as string) || 'Trade'} ${idx + 1}`)
    chartPoints.push(cumulativePnl)
  })

  const pnlChartData = {
    labels: chartLabels,
    datasets: [
      {
        label: 'Cumulative PnL ($)',
        data: chartPoints,
        borderColor: cumulativePnl >= 0 ? '#10b981' : '#f43f5e',
        backgroundColor: cumulativePnl >= 0 ? 'rgba(16, 185, 129, 0.1)' : 'rgba(244, 63, 94, 0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 4,
        pointHoverRadius: 6,
      },
    ],
  }

  const pnlChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (context: { raw: unknown }) => `PnL: $${Number(context.raw).toFixed(2)}`,
        },
      },
    },
    scales: {
      x: {
        grid: { color: 'rgba(255, 255, 255, 0.05)' },
        ticks: { color: 'rgba(255, 255, 255, 0.5)', font: { size: 11 } },
      },
      y: {
        grid: { color: 'rgba(255, 255, 255, 0.05)' },
        ticks: {
          color: 'rgba(255, 255, 255, 0.5)',
          font: { size: 11 },
          callback: (value: number | string) => `$${Number(value).toFixed(0)}`,
        },
      },
    },
  }

  return (
    <div className="flex flex-col gap-6 w-full p-4 md:p-6 fade-in h-full overflow-y-auto">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-4xl font-black tracking-tight text-foreground/90">Portfolio Management</h1>
          <p className="text-foreground/50 text-sm mt-1">Real-time control over positions, buy/sell execution, budget, and trade audit history.</p>
        </div>
      </div>

      {actionData?.error && (
        <div className="p-4 rounded-lg bg-down/10 border border-down/30 text-down text-sm font-medium">
          ❌ {actionData.error}
        </div>
      )}

      {actionData?.message && (
        <div className="p-4 rounded-lg bg-up/10 border border-up/30 text-up text-sm font-medium">
          ✅ {actionData.message}
        </div>
      )}

      {/* Account Settings & Quick Buy */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 font-mono">
        {/* Budget Management */}
        <Surface surface="base" className="p-6 md:col-span-1 border border-border/10 bg-surface-sink/40">
          <h2 className="text-lg font-mono font-bold text-foreground/90 mb-4 flex items-center gap-2">
            Account Budget
          </h2>
          <div className="grid grid-cols-2 gap-2 mb-4 text-xs font-mono">
            <div className="bg-surface-sink p-2 border border-border/20 rounded">
              <div className="text-foreground/40 uppercase">Deployed</div>
              <div className="text-foreground font-bold">${deployedCapital.toFixed(0)}</div>
            </div>
            <div className="bg-surface-sink p-2 border border-border/20 rounded">
              <div className="text-foreground/40 uppercase">Available</div>
              <div className="text-up font-bold">${availableCash.toFixed(0)}</div>
            </div>
          </div>
          <Form method="post" className="space-y-4">
            <input type="hidden" name="intent" value="update_budget" />
            <div>
              <label className="block text-xs font-mono font-bold text-foreground/60 uppercase mb-1">Total Capital ($)</label>
              <input
                type="number"
                name="totalCapital"
                defaultValue={totalCapital}
                step="100"
                required
                className="w-full bg-surface-sink border border-border/20 px-3 py-2 text-foreground font-mono text-sm focus:outline-none focus:border-primary"
              />
            </div>
            <div>
              <label className="block text-xs font-mono font-bold text-foreground/60 uppercase mb-1">
                Max Risk / Trade ($){isPercentRisk ? <span className="text-foreground/40 normal-case ml-1">(configured as {maxRiskPerTradeRaw} of capital)</span> : null}
              </label>
              <input
                type="number"
                name="maxRiskPerTrade"
                defaultValue={maxRiskPerTradeUsd ?? (maxRiskPerTradeRaw || '')}
                step="10"
                required
                className="w-full bg-surface-sink border border-border/20 px-3 py-2 text-foreground font-mono text-sm focus:outline-none focus:border-primary"
              />
            </div>
            <button
              type="submit"
              className="w-full py-2.5 bg-primary/20 hover:bg-primary/30 border border-primary/50 text-primary font-mono font-bold text-xs uppercase tracking-wider transition-all cursor-pointer"
            >
              Update Budget
            </button>
          </Form>
        </Surface>

        {/* Buy Position Form */}
        <Surface surface="base" className="p-6 md:col-span-1 border border-border/10 bg-surface-sink/40">
          <h2 className="text-lg font-mono font-bold text-foreground/90 mb-4 flex items-center gap-2">
            🟢 Buy Position
          </h2>
          <Form method="post" className="space-y-4">
            <input type="hidden" name="intent" value="buy" />
            <div>
              <label className="block text-xs font-mono font-bold text-foreground/60 uppercase mb-1">Ticker Symbol</label>
              <input
                type="text"
                name="ticker"
                placeholder="e.g. AAPL, AVGO"
                required
                className="w-full bg-surface-sink border border-border/20 px-3 py-2 text-foreground font-mono text-sm uppercase focus:outline-none focus:border-primary"
              />
            </div>
            <div>
              <label className="block text-xs font-mono font-bold text-foreground/60 uppercase mb-1">Quantity (Shares)</label>
              <input
                type="number"
                name="shares"
                defaultValue={1}
                min={1}
                required
                className="w-full bg-surface-sink border border-border/20 px-3 py-2 text-foreground font-mono text-sm focus:outline-none focus:border-primary"
              />
            </div>
            <button
              type="submit"
              className="w-full py-2.5 bg-up/20 hover:bg-up/30 border border-up/50 text-up font-mono font-bold text-xs uppercase tracking-wider transition-all cursor-pointer"
            >
              Execute Buy Command
            </button>
          </Form>
        </Surface>

        {/* API Key Status */}
        <Surface surface="base" className="p-6 md:col-span-1 flex flex-col justify-between border border-border/10 bg-surface-sink/40">
          <div>
            <h2 className="text-lg font-mono font-bold text-foreground/90 mb-4 flex items-center gap-2">
              🔑 Configured Key
            </h2>
            <div className="bg-surface-sink p-3 border border-border/20 font-mono text-xs text-foreground/70 truncate mb-4">
              {apiKey.length > 20 ? `${apiKey.substring(0, 10)}...${apiKey.substring(apiKey.length - 4)}` : apiKey}
            </div>
          </div>
          <div className="text-xs font-mono text-foreground/40">
            Connected to client local execution engine.
          </div>
        </Surface>
      </div>

      {/* Active Trades */}
      <Surface surface="base" className="p-6 flex-1 flex flex-col min-h-0 border border-border/10 bg-surface-sink/40">
        <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
          <h2 className="text-lg font-mono font-bold text-foreground/90">Active Trades ({activeTrades.length})</h2>
          <button
            type="button"
            data-testid="optimize-button"
            onClick={() => optimizeFetcher.submit({ intent: 'optimize' }, { method: 'post' })}
            disabled={optimizeLoading || applyLoading}
            className="px-3 py-1 bg-primary/20 hover:bg-primary/30 border border-primary/50 text-primary text-xs font-mono font-bold uppercase tracking-wider transition-all cursor-pointer disabled:opacity-50 disabled:cursor-wait"
          >
            {optimizeLoading ? '⚙️ Optimizing…' : '⚙️ Optimize'}
          </button>
        </div>
        {showOptimizePanel && (
          <OptimizePanel
            loading={optimizeLoading}
            data={optimizeData?.intent === 'optimize' ? optimizeData : undefined}
            applyLoading={applyLoading}
            applyResult={applyData}
            onApply={() => applyFetcher.submit({ intent: 'apply_optimization' }, { method: 'post' })}
            onDismiss={() => setDismissed(true)}
          />
        )}
        {error ? (
          <div className="flex-1 flex flex-col items-center justify-center border border-dashed border-down/30 p-8 bg-down/5">
            <div className="w-12 h-12 bg-down/10 flex items-center justify-center mb-3 text-xl">
              ⚠️
            </div>
            <p className="text-down font-mono text-sm">
              {error === 'API_KEY_MISMATCH' && 'Unauthorized: The configured bot API key does not belong to your account.'}
              {error === 'API_KEY_INVALID' && 'Unauthorized: The configured bot API key is invalid.'}
              {error === 'API_KEY_VERIFICATION_FAILED' && 'Error: Failed to verify API key.'}
              {error === 'API_KEY_MISSING' && 'Warning: No Quantour API key configured.'}
            </p>
          </div>
        ) : activeTrades.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center border border-dashed border-border/10 p-8 bg-surface-sink/20">
            <div className="w-12 h-12 bg-white/5 flex items-center justify-center mb-3 text-xl">
              😴
            </div>
            <p className="text-foreground/50 font-mono text-sm uppercase tracking-wider">No active trades running</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse font-mono">
              <thead>
                <tr className="border-b border-border/20 text-foreground/50 text-xs uppercase tracking-wider">
                  <th className="pb-3 pr-4 font-bold">Ticker</th>
                  <th className="pb-3 pr-4 font-bold">Strategy</th>
                  <th className="pb-3 pr-4 font-bold">Entry</th>
                  <th className="pb-3 pr-4 font-bold">Target</th>
                  <th className="pb-3 pr-4 font-bold">Stop Loss</th>
                  <th className="pb-3 pr-4 font-bold">Risk USD</th>
                  <th className="pb-3 font-bold">Action</th>
                </tr>
              </thead>
              <tbody>
                {activeTrades.map((t: Record<string, unknown>) => {
                  const align = newsAlignment[String(t.ticker || '').toUpperCase()]
                  return (
                    <tr key={t.id as number} className="border-b border-border/10 hover:bg-white/[0.04] transition-colors">
                      <td className="py-3 pr-4">
                        <span className="font-bold text-foreground bg-white/10 px-2 py-1 text-xs border border-border/20">{t.ticker as string}</span>
                        {align?.newsAlignment === 'LAGGARD_IN_HOT_SECTOR' && (
                          <span
                            title={`News ${align.newsScore ?? '?'}/10 vs sector ${align.sectorNewsScore ?? '?'}/10 (divergence ${align.newsDivergence ?? '?'}) — weakest name in a rising group`}
                            className="ml-2 px-1.5 py-0.5 text-micro font-bold uppercase border border-warning/50 bg-warning/10 text-warning cursor-help"
                          >
                            Laggard
                          </span>
                        )}
                        {align?.newsAlignment === 'IDIOSYNCRATIC_STRENGTH' && (
                          <span
                            title={`News ${align.newsScore ?? '?'}/10 vs sector ${align.sectorNewsScore ?? '?'}/10 (divergence ${align.newsDivergence ?? '?'}) — isolated catalyst, not sector beta`}
                            className="ml-2 px-1.5 py-0.5 text-micro font-bold uppercase border border-up/50 bg-up/10 text-up cursor-help"
                          >
                            Outlier
                          </span>
                        )}
                        {align?.structural && (
                          <span
                            title={`Structural thesis (slow sleeve): day ${align.thesisDaysHeld ?? 0}/${align.thesisHorizonDays ?? 120} · verdict ${align.thesisVerdict ?? '?'} — managed by thesis, exempt from rotation/handoff churn`}
                            className={`ml-2 px-1.5 py-0.5 text-micro font-bold uppercase border cursor-help ${
                              align.thesisVerdict === 'BROKEN'
                                ? 'border-down/50 bg-down/10 text-down'
                                : align.thesisVerdict === 'WEAKENING'
                                  ? 'border-warning/50 bg-warning/10 text-warning'
                                  : 'border-primary/50 bg-primary/10 text-primary'
                            }`}
                          >
                            🌱 {align.thesisVerdict ?? 'STRUCTURAL'}
                          </span>
                        )}
                      </td>
                      <td className="py-3 pr-4 text-foreground/70 text-xs">{(t.strategyName as string) || 'Manual'}</td>
                      <td className="py-3 pr-4 text-foreground/80 text-xs">${Number(t.entry).toFixed(2)}</td>
                      <td className="py-3 pr-4 text-up text-xs">${Number(t.target).toFixed(2)}</td>
                      <td className="py-3 pr-4 text-down text-xs">${Number(t.stopLoss).toFixed(2)}</td>
                      <td className="py-3 pr-4 text-foreground/80 text-xs">${Number(t.riskAmountUsd).toFixed(2)}</td>
                      <td className="py-3">
                        <Form method="post">
                          <input type="hidden" name="intent" value="sell" />
                          <input type="hidden" name="ticker" value={t.ticker as string} />
                          <button
                            type="submit"
                            className="px-3 py-1 bg-down/20 hover:bg-down/30 border border-down/50 text-down text-xs font-mono font-bold uppercase transition-all cursor-pointer"
                          >
                            Sell
                          </button>
                        </Form>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Surface>

      {/* Timeframe switcher */}
      <div className="flex gap-2 items-center">
        <span className="text-xs font-mono text-foreground/40 uppercase">Period:</span>
        {timeframeOptions.map((opt) => (
          <Link
            key={opt.key}
            to={`?timeframe=${opt.key}&page=1`}
            className={`px-3 py-1 text-xs font-mono font-bold border transition-all cursor-pointer ${
              currentTimeframe === opt.key
                ? 'bg-primary/20 border-primary/50 text-primary'
                : 'bg-surface-sink border-border/20 text-foreground/50 hover:text-foreground'
            }`}
          >
            {opt.label}
          </Link>
        ))}
      </div>

      {/* PnL Performance Chart */}
      <Surface surface="base" className="p-6 border border-border/10 bg-surface-sink/40">
        <h2 className="text-lg font-mono font-bold text-foreground/90 mb-4 flex items-center justify-between">
          <span>📈 Cumulative PnL Performance</span>
          <span className={`text-sm font-mono font-bold ${cumulativePnl >= 0 ? 'text-up' : 'text-down'}`}>
            {cumulativePnl >= 0 ? '+' : ''}${cumulativePnl.toFixed(2)}
          </span>
        </h2>
        <div className="h-64 w-full">
          <Line data={pnlChartData} options={pnlChartOptions} />
        </div>
      </Surface>

      {/* Trade Audit Log (Last Month Operations) */}
      <Surface surface="base" className="p-6 border border-border/10 bg-surface-sink/40">
        <h2 className="text-lg font-mono font-bold text-foreground/90 mb-4">Trade Operations Audit Log</h2>
        {auditLogs.length === 0 ? (
          <p className="text-foreground/40 font-mono text-sm">No historical trade operations logged yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse font-mono">
              <thead>
                <tr className="border-b border-border/20 text-foreground/50 text-xs uppercase tracking-wider">
                  <th className="pb-3 pr-4 font-bold">Ticker</th>
                  <th className="pb-3 pr-4 font-bold">Exit Reason</th>
                  <th className="pb-3 pr-4 font-bold">Entry Price</th>
                  <th className="pb-3 pr-4 font-bold">Exit Price</th>
                  <th className="pb-3 pr-4 font-bold">PnL ($)</th>
                  <th className="pb-3 font-bold">PnL (%)</th>
                </tr>
              </thead>
              <tbody>
                {auditLogs.map((log: Record<string, unknown>, idx: number) => {
                  const pnl = parseFloat(String(log.pnlUsd || '0'))
                  const isPositive = pnl >= 0
                  return (
                    <tr key={idx} className="border-b border-border/5 hover:bg-white/[0.02]">
                      <td className="py-3 pr-4 font-bold text-foreground/90">{String(log.ticker)}</td>
                      <td className="py-3 pr-4 text-foreground/60 text-sm">{String(log.exitReason)}</td>
                      <td className="py-3 pr-4 font-mono text-foreground/70 text-sm">${Number(log.entryPrice).toFixed(2)}</td>
                      <td className="py-3 pr-4 font-mono text-foreground/70 text-sm">${Number(log.exitPrice).toFixed(2)}</td>
                      <td className={`py-3 pr-4 font-mono text-sm font-bold ${isPositive ? 'text-up' : 'text-down'}`}>
                        {isPositive ? '+' : ''}${pnl.toFixed(2)}
                      </td>
                      <td className={`py-3 font-mono text-sm font-bold ${isPositive ? 'text-up' : 'text-down'}`}>
                        {isPositive ? '+' : ''}{Number(log.pnlPercent).toFixed(2)}%
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4">
            <Link
              to={`?page=${Math.max(1, currentPage - 1)}&timeframe=${currentTimeframe}`}
              className={`px-3 py-1.5 text-xs font-mono font-bold border transition-all ${
                currentPage <= 1 ? 'opacity-30 pointer-events-none border-border/10' : 'bg-surface-sink border-border/20 text-foreground/70 hover:text-foreground cursor-pointer'
              }`}
            >
              ← Prev
            </Link>
            <span className="text-xs font-mono text-foreground/40">Page {currentPage} of {totalPages}</span>
            <Link
              to={`?page=${Math.min(totalPages, currentPage + 1)}&timeframe=${currentTimeframe}`}
              className={`px-3 py-1.5 text-xs font-mono font-bold border transition-all ${
                currentPage >= totalPages ? 'opacity-30 pointer-events-none border-border/10' : 'bg-surface-sink border-border/20 text-foreground/70 hover:text-foreground cursor-pointer'
              }`}
            >
              Next →
            </Link>
          </div>
        )}
      </Surface>

      {/* PnL History Overview */}
      {pnlHistory.length > 0 && (
        <Surface surface="base" className="p-6">
          <h2 className="text-xl font-bold text-foreground/90 mb-4">PnL Log Entries</h2>
          <div className="space-y-2">
            {pnlHistory.map((item: Record<string, unknown>, idx: number) => (
              <div key={idx} className="flex justify-between items-center bg-surface-sink/30 p-3 rounded border border-border/5 font-mono text-sm">
                <span className="text-foreground/60">{String(item.type)}</span>
                <span className={`font-bold ${parseFloat(String(item.pnlAmount)) >= 0 ? 'text-up' : 'text-down'}`}>
                  {parseFloat(String(item.pnlAmount)) >= 0 ? '+' : ''}${Number(item.pnlAmount).toFixed(2)} ({Number(item.pnlPercent).toFixed(2)}%)
                </span>
              </div>
            ))}
          </div>
        </Surface>
      )}
    </div>
  )
}

/**
 * Inline optimization panel — mirrors Telegram /optimize output. Renders the
 * recommended target portfolio, the action plan to reach it (SELL/TRIM/BUY),
 * and an Apply button. Matches Metro design tokens used elsewhere in this
 * route (font-mono, semantic colors text-up/text-down, surface-sink, etc.).
 */
function OptimizePanel({
  loading, data, applyLoading, applyResult, onApply, onDismiss,
}: {
  loading: boolean
  data?: Extract<OptimizeActionData, { intent: 'optimize' }>
  applyLoading: boolean
  applyResult?: Extract<OptimizeActionData, { intent: 'apply_optimization' }>
  onApply: () => void
  onDismiss: () => void
}) {
  // Loading state — show skeleton + the ~10-15s estimate (Telegram parity)
  if (loading) {
    return (
      <div data-testid="optimize-panel" className="mb-4 border border-primary/30 bg-primary/5 p-4">
        <div className="text-primary font-mono text-xs uppercase tracking-wider mb-2 flex items-center gap-2">
          <span className="inline-block w-2 h-2 bg-primary animate-pulse" />
          📊 Computing target portfolio…
        </div>
        <div className="text-foreground/50 font-mono text-xs">Estimated ~10-15s. Comparing your active positions against live market setups.</div>
      </div>
    )
  }

  // Error from optimize
  if (data && !data.ok) {
    return (
      <div data-testid="optimize-panel" className="mb-4 border border-down/40 bg-down/5 p-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-down font-mono text-xs uppercase tracking-wider mb-1">⚠️ Optimize failed</div>
          <div className="text-foreground/70 font-mono text-xs break-words">{data.error}</div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 px-2 py-1 bg-surface-sink border border-border/20 text-foreground/60 hover:text-foreground text-xs font-mono"
        >
          ✕
        </button>
      </div>
    )
  }

  // Apply error (transient — shown alongside the result)
  const applyErr = applyResult && !applyResult.ok ? applyResult.error : null
  // Apply success toast (transient)
  const applyOk = applyResult && applyResult.ok ? applyResult.applied : null

  if (!data || !data.ok) return null
  const { rotationResult, scoreGainMultiplier } = data
  const isAlreadyOptimal = rotationResult.rationale === 'ALREADY_OPTIMIZED'
    || (rotationResult.actions.length === 0 && rotationResult.rotations.length === 0 && rotationResult.rationale !== 'NO_SETUPS')
  const isNoSetups = rotationResult.rationale === 'NO_SETUPS'
  const requiredGainPct = Math.round((scoreGainMultiplier - 1) * 100)

  const sellActions = useMemo(() => rotationResult.actions.filter(a => a.type === 'SELL' || a.type === 'TRIM'),
    [
      rotationResult,
    ])
  const buyActions = useMemo(() => rotationResult.actions.filter(a => a.type === 'BUY'),
    [
      rotationResult,
    ])

  return (
    <div data-testid="optimize-panel" className="mb-4 border border-primary/30 bg-surface-sink/60 p-4">
      {/* Apply error / success banners (transient) */}
      {applyErr && (
        <div className="mb-3 border border-down/40 bg-down/10 p-2 text-down font-mono text-xs">
          ⚠️ {applyErr}
        </div>
      )}
      {applyOk !== null && (
        <div className="mb-3 border border-up/40 bg-up/10 p-2 text-up font-mono text-xs">
          ✅ Applied {applyOk} action{applyOk === 1 ? '' : 's'}. Positions updated.
        </div>
      )}

      {isNoSetups ? (
        <div className="text-warning font-mono text-sm">
          ⚠️ No current market setups available. The optimizer only compares real market setups — none are being produced right now (market closed, scan pending, or the signal engine is degraded). Try again after the next scan.
        </div>
      ) : isAlreadyOptimal ? (
        <div className="text-up font-mono text-sm">
          ✅ Your current portfolio is optimal. No setup offers a sufficient +{requiredGainPct}% score gain to justify rotation.
        </div>
      ) : (
        <>
          {/* Target Portfolio */}
          {rotationResult.targetPortfolio.length > 0 && (
            <div className="mb-4">
              <div className="text-primary font-mono text-xs uppercase tracking-wider mb-2">📊 Recommended Target Portfolio</div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse font-mono">
                  <thead>
                    <tr className="border-b border-border/20 text-foreground/50 text-xs uppercase tracking-wider">
                      <th className="pb-2 pr-3 font-bold">Ticker</th>
                      <th className="pb-2 pr-3 font-bold">Shares</th>
                      <th className="pb-2 pr-3 font-bold">Alloc $</th>
                      <th className="pb-2 font-bold">%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rotationResult.targetPortfolio.map((p: OptimizeTarget) => (
                      <tr key={p.ticker} className="border-b border-border/10">
                        <td className="py-2 pr-3">
                          <span className="font-bold text-foreground bg-white/10 px-2 py-0.5 text-xs border border-border/20">{p.ticker}</span>
                        </td>
                        <td className="py-2 pr-3 text-foreground/80 text-xs">{p.shares}</td>
                        <td className="py-2 pr-3 text-foreground/80 text-xs">${p.allocatedUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        <td className="py-2 text-foreground/60 text-xs">{p.pctAllocation.toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Action Plan */}
          {rotationResult.actions.length > 0 && (
            <div className="mb-4">
              <div className="text-primary font-mono text-xs uppercase tracking-wider mb-2">🎯 Action Plan to Reach Target</div>
              <div className="grid gap-2">
                {sellActions.length > 0 && (
                  <div className="border border-down/30 bg-down/5 p-2">
                    <div className="text-down font-mono text-xs uppercase mb-1">Sell / Trim</div>
                    <ul className="space-y-1">
                      {sellActions.map((a: OptimizeAction, i: number) => (
                        <li key={`${a.ticker}-${i}`} className="font-mono text-xs text-foreground/80">
                          <span className="text-down font-bold mr-2">{a.type === 'SELL' ? '🔴 SELL' : '✂️ TRIM'}</span>
                          <span className="font-bold text-foreground">{a.ticker}</span>
                          <span className="text-foreground/60 mx-1">·</span>
                          {a.shares} sh
                          <span className="text-foreground/60 mx-1">·</span>
                          ~${a.amountUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {buyActions.length > 0 && (
                  <div className="border border-up/30 bg-up/5 p-2">
                    <div className="text-up font-mono text-xs uppercase mb-1">Buy / Add</div>
                    <ul className="space-y-1">
                      {buyActions.map((a: OptimizeAction, i: number) => (
                        <li key={`${a.ticker}-${i}`} className="font-mono text-xs text-foreground/80">
                          <span className="text-up font-bold mr-2">🟢 BUY</span>
                          <span className="font-bold text-foreground">{a.ticker}</span>
                          <span className="text-foreground/60 mx-1">·</span>
                          {a.shares} sh @ ${a.price.toFixed(2)}
                          <span className="text-foreground/60 mx-1">·</span>
                          ~${a.amountUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 flex-wrap">
            {rotationResult.actions.length > 0 && (
              <button
                type="button"
                onClick={onApply}
                disabled={applyLoading}
                className="px-4 py-2 bg-up/20 hover:bg-up/30 border border-up/50 text-up font-mono font-bold text-xs uppercase tracking-wider transition-all cursor-pointer disabled:opacity-50 disabled:cursor-wait"
              >
                {applyLoading ? 'Applying…' : '✅ Apply Target Portfolio'}
              </button>
            )}
            <button
              type="button"
              onClick={onDismiss}
              disabled={applyLoading}
              className="px-3 py-2 bg-surface-sink border border-border/20 text-foreground/60 hover:text-foreground font-mono text-xs uppercase tracking-wider transition-all cursor-pointer disabled:opacity-50"
            >
              ✕ Dismiss
            </button>
          </div>
        </>
      )}
    </div>
  )
}
