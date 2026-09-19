import {
  defaultForwardTestName, isDuplicatePortfolioName, 
} from '@quantour/shared-algo/src/core/forwardTestNaming'
import type { CustomStrategyAST } from '@quantour/shared-algo/src/finance-algo/ast'
import { Surface } from 'app/components/Surface'
import { getSessionFromServer } from 'app/lib/auth-helpers'
import {
  getBacktestState, startBacktestJob, 
} from 'app/lib/backtestStore'
import { fetchFromPublicApi } from 'app/utils/apiClient'
import { requireEnv } from 'app/utils/env.server'
import {
  useCallback, useEffect, useMemo, useState,
} from 'react'
import {
  redirect, useFetcher, useRevalidator, useSearchParams, 
} from 'react-router'

import { StrategyAst } from './StrategyAst.client'
import { StrategyChart } from './StrategyChart.client'
import type { Route } from './+types/strategy-builder'

type LedgerEntry = {
  id: number
  ticker: string
  action: string
  price: number
  shares: number
  reason: string
  executedAt: string | null
}

type ClosedTrade = {
  id: number
  ticker: string
  entryPrice: number
  shares: number
  profitUsd: number
  profitPercent: number
  openedAt: string | null
  closedAt: string | null
  firedBranchName: string | null
}

type ForwardTestLedgerResponse = {
  success: boolean
  data: {
    accountTitle: string
    ledger: LedgerEntry[]
    closedTrades: ClosedTrade[]
  }
}

const STANDARD_STRATEGY = [
  {
    'strategyName': 'Standard Momentum (Pre-AI)',
    'holdingPeriod': '3-6 weeks',
    'entryLogic': {
      'and': [
        { 'indicator': 'currentPrice', 'operator': '>', 'target': 'sma50' },
        { 'indicator': 'sma50', 'operator': '>', 'target': 'sma200' },
        { 'indicator': 'relativeStrength', 'operator': '>', 'value': 0.05 },
        { 'indicator': 'newsScore', 'operator': '>', 'value': 7 },
        { 'indicator': 'insiderScore', 'operator': '>', 'value': 5 },
      ],
    },
    'riskManagement': {
      'stopLossAtrMultiplier': 2.5,
      'targetRiskMultiplier': 3.0,
    },
  },
]

const AI_COMBINED_TEMPLATE = [
  {
    'strategyName': 'AI_COMBINED',
    'universe': {
      'minMarketCap': 1000000000,
      'minAvgVolume': 500000,
      'allowedSectors': [
        'Technology',
        'Healthcare',
        'Financials',
        'Industrials',
      ],
    },
    'positionSizing': {
      'minCapitalPerTrade': 250,
      'maxCapitalPerTrade': 10000,
      'maxPortfolioAllocationPercent': 15.0,
      'riskRewardRatio': 3.0,
    },
    'entryLogic': {
      'or': [
        {
          'and': [
            { 'indicator': 'currentPrice', 'operator': '>', 'target': 'sma50' },
            { 'indicator': 'newsScore', 'operator': '>', 'value': 5 },
          ],
        },
        {
          'and': [
            { 'indicator': 'currentPrice', 'operator': '<', 'target': 'sma20' },
            { 'indicator': 'sma50', 'operator': '>', 'target': 'sma200' },
            { 'indicator': 'insiderScore', 'operator': '>', 'value': 5 },
          ],
        },
        {
          'and': [
            { 'indicator': 'relativeStrength', 'operator': '>', 'value': 0.05 },
            { 'indicator': 'newsScore', 'operator': '>', 'value': 7 },
          ],
        },
      ],
    },
    'dynamicScoring': [
      {
        'condition': { 'indicator': 'newsScore', 'operator': '>', 'value': 8 },
        'boost': 0.5,
        'reason': 'Massive positive news sentiment',
      },
      {
        'condition': { 'indicator': 'insiderScore', 'operator': '>', 'value': 5 },
        'boost': 0.3,
        'reason': 'Strong insider buying',
      },
      {
        'condition': { 'indicator': 'macroNarrativeHype', 'operator': '>', 'value': 70 },
        'boost': 0.4,
        'reason': 'High macro narrative hype',
      },
    ],
    'riskManagement': {
      'stopLossAtrMultiplier': 2.5,
      'targetRiskMultiplier': 3.0,
      'regimeAdjustments': {
        'RISK_OFF': {
          'stopMultiplier': 0.5,
          'targetMultiplier': 0.5,
        },
        'RISK_ON': {
          'stopMultiplier': 1.5,
          'targetMultiplier': 1.5,
        },
      },
    },
  },
]

const LONG_HORIZON_TEMPLATE = [
  {
    'strategyName': 'Long Horizon Strategy',
    'entryLogic': {
      'and': [
        { 'indicator': 'macro.global_liquidity.trend', 'operator': '==', 'value': 'EXPANDING' },
        { 'indicator': 'stock.macro_exposure.type', 'operator': '==', 'value': 'BENEFICIARY' },
        { 'indicator': 'stock.macro_exposure.hype_velocity', 'operator': '>', 'value': 5 },
        { 'indicator': 'currentPrice', 'operator': '>', 'target': 'sma200' },
      ],
    },
    'riskManagement': {
      'stopLossAtrMultiplier': 2.0,
      'targetRiskMultiplier': 5.0,
    },
  },
]

export async function loader({ request }: Route.LoaderArgs) {
  const session = await getSessionFromServer(request)
  if (!session?.user?.id) return {
    savedAstJson: null, savedDefensiveRotation: true, customStrategies: [], forwardTests: [], 
  }
  
  const clientApiUrl = requireEnv('CLIENT_API_URL')
  try {
    let ast: CustomStrategyAST | null = null
    const settingsReq = await fetch(`${clientApiUrl}/api/settings`, {
      headers: { 'Connection': 'close' },
      cache: 'no-store',
    }).catch(() => null)
    if (settingsReq && settingsReq.ok) {
      const active = await settingsReq.json().catch(() => null) as { mainStrategyAst?: string } | null
      const raw = active?.mainStrategyAst
      if (raw && raw.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(raw) as unknown
          if (parsed && typeof parsed === 'object' && 'strategyName' in parsed) {
            ast = parsed as CustomStrategyAST
          }
        } catch {
          ast = null
        }
      }
    }

    const strategiesReq = await fetch(`${clientApiUrl}/api/strategies`).catch(() => null)
    const customStrategies = strategiesReq ? await strategiesReq.json().catch(() => []) : []

    let savedAstJson = null
    let savedDefensiveRotation = true
    if (ast) {
      savedAstJson = JSON.stringify([
        ast,
      ], null, 2)
      savedDefensiveRotation = ast.enableDefensiveRotation ?? true
    }
    
    // Sync the "AI Quant Optimized" library template with the ACTUAL active
    // canonical AST (settings.mainStrategyAst is the real deployed AI_COMBINED
    // via migrateStrategyAst) — the embedded AI_COMBINED_TEMPLATE below is a
    // stale simplified snapshot and would silently regress the user's config
    // if they clicked it and applied. Falls back to the embedded template only
    // when the active strategy is not AI_COMBINED.
    const aiOptimizedTemplate = ast && ast.strategyName === 'AI_COMBINED' && savedAstJson
      ? savedAstJson
      : JSON.stringify(AI_COMBINED_TEMPLATE, null, 2)

    const defaultStrategies = [
      {
        id: 'default-1', name: 'Standard Momentum (Pre-AI)', astJson: JSON.stringify(STANDARD_STRATEGY, null, 2), createdAt: new Date().toISOString(), 
      },
      {
        id: 'default-2', name: 'AI Quant Optimized', astJson: aiOptimizedTemplate, createdAt: new Date().toISOString(), 
      },
      {
        id: 'default-3', name: 'Long Horizon Strategy', astJson: JSON.stringify(LONG_HORIZON_TEMPLATE, null, 2), createdAt: new Date().toISOString(),
      },
    ]

    // Fetch live B2D forward testing portfolios with a race timeout for snappy
    // navigation — 3s to match the ledger race below; a shorter race rendered
    // an empty tab whenever upstream quotes were slow.
    const forwardTestsData = await Promise.race([
      fetchFromPublicApi('/forward-test', request),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
    ]).catch(() => null)
    const forwardTests = forwardTestsData?.data || []

    const url = new URL(request.url)
    // Transaction-log detail: when a specific portfolio is selected, fetch its
    // BUY/SELL ledger + closed trades (cheap single-portfolio query — longer
    // race than the heavy list endpoint).
    const testId = url.searchParams.get('testId')
    const ledgerData = testId
      ? await Promise.race([
        fetchFromPublicApi(`/forward-test/${testId}/ledger`, request) as Promise<ForwardTestLedgerResponse | null>,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
      ]).catch(() => null)
      : null
    const backtestId = url.searchParams.get('backtestId')
    const backtestState = getBacktestState(backtestId ?? undefined)

    return {
      savedAstJson,
      savedDefensiveRotation,
      customStrategies: [
        ...defaultStrategies,
        ...customStrategies,
      ],
      forwardTests,
      ledgerData,
      backtestState,
    }
  } catch (err) {
    console.error('Failed to load user AST & Forward Tests:', err)
  }

  const url = new URL(request.url)
  const backtestId = url.searchParams.get('backtestId')
  const backtestState = getBacktestState(backtestId ?? undefined)

  return {
    savedAstJson: null, savedDefensiveRotation: true, customStrategies: [], forwardTests: [], ledgerData: null, backtestState,
  }
}

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData()
  const intent = formData.get('intent')

  if (intent === 'run_backtest') {
    const astJson = (formData.get('astJson') as string) || ''
    const enableDefensiveRotation = formData.get('enableDefensiveRotation') === 'true'
    const backtestId = startBacktestJob(astJson, enableDefensiveRotation)
    return redirect(`/strategy-builder?tab=backtest&backtestId=${backtestId}`)
  }

  if (intent === 'save_custom') {
    const name = formData.get('name') as string
    const astJson = formData.get('astJson') as string
    
    if (!name || !astJson) return { error: 'Name and AST are required' }

    try {
      const clientApiUrl = requireEnv('CLIENT_API_URL')
      const res = await fetch(`${clientApiUrl}/api/strategies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, astJson }),
      })
      if (!res.ok) throw new Error('Failed')
      return { success: true, message: 'Saved to your strategy library.' }
    } catch {
      return { error: 'Failed to save custom strategy' }
    }
  }

  if (intent === 'apply_main') {
    const astJson = formData.get('astJson') as string
    if (!astJson) return { error: 'AST is required' }

    try {
      const parsed = JSON.parse(astJson) as unknown
      const finalObj = (Array.isArray(parsed) ? (parsed as unknown[])[0] : parsed) as Record<string, unknown>
      const storeJson = JSON.stringify(finalObj)

      const clientApiUrl = requireEnv('CLIENT_API_URL')
      const res = await fetch(`${clientApiUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mainStrategyAst: storeJson }),
      })
      if (!res.ok) {
        // Surface the structured validation issues (path + message) so both
        // humans and AI agents get an actionable fix loop.
        const body = await res.json().catch(() => null) as { issues?: { path: string; message: string }[] } | null
        const first = body?.issues?.[0]
        throw new Error(first ? `Invalid AST — ${first.path || 'root'}: ${first.message}` : 'Failed')
      }
      return { success: true, message: 'Applied as your main strategy — the scanner & exit-manager will use it.' }
    } catch (e) {
      return { error: e instanceof Error && e.message !== 'Failed' ? e.message : 'Failed to apply strategy as main' }
    }
  }

  if (intent === 'delete_custom') {
    const id = formData.get('id') as string
    if (!id) return { error: 'Strategy ID is required' }
    try {
      const clientApiUrl = requireEnv('CLIENT_API_URL')
      const res = await fetch(`${clientApiUrl}/api/strategies/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed')
      return { success: true, message: 'Strategy deleted from your library.' }
    } catch {
      return { error: 'Failed to delete strategy' }
    }
  }

  if (intent === 'create_forward_test') {
    const capital = formData.get('capital') || '10000'
    const strategy = formData.get('strategy') || 'custom'
    const astJson = formData.get('astJson') as string
    const checkFrequency = formData.get('checkFrequency') || '15m'
    const activeHoursStart = formData.get('activeHoursStart') || '09:30'
    const activeHoursEnd = formData.get('activeHoursEnd') || '16:00'
    const rotationAggressiveness = formData.get('rotationAggressiveness') || 'CONSERVATIVE'
    const name = formData.get('name') as string

    try {
      const res = await fetchFromPublicApi('/forward-test', request, {
        method: 'POST',
        body: JSON.stringify({
          capital: Number(capital),
          strategy,
          customAstJson: astJson,
          checkFrequency,
          activeHoursStart,
          activeHoursEnd,
          rotationAggressiveness,
          ...(name ? { name } : {}),
        }),
      })
      if (!res?.success) throw new Error(res?.error || 'Failed to start forward test')
      return { success: true, message: `Live B2D Forward Test "${(res?.data as { name?: string } | undefined)?.name ?? ''}" provisioned! (5 credits charged for weekly strategy run)` }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { error: `Failed to launch forward test: ${msg}` }
    }
  }

  if (intent === 'delete_forward_test') {
    const chatId = formData.get('chatId') as string
    if (!chatId) return { error: 'Chat ID required' }
    try {
      const res = await fetchFromPublicApi(`/forward-test/${chatId}`, request, { method: 'DELETE' })
      if (!res?.success) throw new Error(res?.error || 'Failed to delete')
      return { success: true, message: 'Forward test strategy deleted.' }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { error: msg }
    }
  }

  if (intent === 'update_checkpoint') {
    const chatId = formData.get('chatId') as string
    const newBalance = formData.get('newBalance') as string
    try {
      await fetchFromPublicApi(`/forward-test/${chatId}/checkpoint`, request, {
        method: 'POST',
        body: JSON.stringify({ checkpointBalance: Number(newBalance) }),
      })
      return { success: true, message: 'Risk checkpoint baseline updated.' }
    } catch (err: unknown) {
      return { error: String(err) }
    }
  }

  return { success: false }
}

export default function StrategyStudio({ loaderData }: Route.ComponentProps) {
  const [
    searchParams,
    setSearchParams,
  ] = useSearchParams()
  const currentTab = searchParams.get('tab') || 'builder'

  const [
    isMounted,
    setIsMounted,
  ] = useState(false)
  const [
    runTrigger,
    setRunTrigger,
  ] = useState(0)
  const {
    savedAstJson, customStrategies, forwardTests, backtestState, ledgerData, 
  } = loaderData
  const revalidator = useRevalidator()

  const [
    astJson,
    setAstJson,
  ] = useState(savedAstJson || JSON.stringify(AI_COMBINED_TEMPLATE, null, 2))

  const enableDefensiveRotation = useMemo(() => {
    try {
      const parsed = JSON.parse(astJson) as unknown
      const obj = (Array.isArray(parsed) ? (parsed as unknown[])[0] : parsed) as { enableDefensiveRotation?: boolean } | undefined
      return obj?.enableDefensiveRotation ?? true
    } catch {
      return true
    }
  }, [
    astJson,
  ])

  // Stop-trigger mode of the EDITOR AST ('close' when undeclared — the
  // A/B-justified default everywhere: scenario > AST > 'close').
  const currentStopFillMode = useMemo<'wick' | 'close'>(() => {
    try {
      const parsed = JSON.parse(astJson) as unknown
      const obj = (Array.isArray(parsed) ? (parsed as unknown[])[0] : parsed) as { riskManagement?: { stopFillMode?: 'wick' | 'close' } } | undefined
      return obj?.riskManagement?.stopFillMode === 'wick' ? 'wick' : 'close'
    } catch {
      return 'close'
    }
  }, [
    astJson,
  ])

  /** Toggle stopFillMode in the editor AST (write-through; Apply persists it). */
  const setStopFillMode = useCallback((mode: 'wick' | 'close') => {
    setAstJson((prev) => {
      try {
        const parsed = JSON.parse(prev) as unknown
        const isArray = Array.isArray(parsed)
        const root = (isArray ? (parsed as unknown[])[0] : parsed) as Record<string, unknown> | undefined
        if (!root || typeof root !== 'object') return prev
        const rm = { ...((root.riskManagement as Record<string, unknown> | undefined) ?? {}) }
        rm.stopFillMode = mode
        const updated = { ...root, riskManagement: rm }
        return JSON.stringify(isArray ? [
          updated,
          ...(parsed as unknown[]).slice(1),
        ] : updated, null, 2)
      } catch {
        return prev
      }
    })
  }, [
    setAstJson,
  ])

  // Summary of the ACTIVE strategy (settings.mainStrategyAst — the one the
  // scanner & exit-manager actually use). Parsed from savedAstJson, NOT the
  // editor (astJson), so it always reflects what is firing signals even while
  // the user edits variants.
  const activeStrategySummary = useMemo(() => {
    if (!savedAstJson) return null
    try {
      const parsed = JSON.parse(savedAstJson) as unknown
      const obj = (Array.isArray(parsed) ? (parsed as unknown[])[0] : parsed) as {
        strategyName?: string
        minScoreToEmit?: number
        maxTotalSignals?: number
        entryLogic?: { or?: unknown[] }
        riskManagement?: {
          chandelierAtrMultiplier?: number
          enableStrategyHandoff?: boolean
          enableSignalStopRefresh?: boolean
          handoffMinProfitR?: number
          stopFillMode?: string
        }
      } | undefined
      if (!obj) return null
      const parts: string[] = []
      if (obj.strategyName) parts.push(obj.strategyName)
      const branchCount = obj.entryLogic?.or?.length
      if (branchCount) parts.push(`${branchCount} branches`)
      if (obj.riskManagement?.chandelierAtrMultiplier) {
        parts.push(`Chandelier ${obj.riskManagement.chandelierAtrMultiplier}×ATR`)
      }
      if (obj.riskManagement?.enableStrategyHandoff) {
        parts.push(`Handoff ≥${obj.riskManagement.handoffMinProfitR ?? 1}R`)
      }
      if (obj.riskManagement?.enableSignalStopRefresh) parts.push('Signal Refresh ON')
      // Stop trigger mode — surfaces the sweep-hardening knob in the banner
      // (default 'close' when undeclared, matching engine precedence).
      parts.push(obj.riskManagement?.stopFillMode === 'wick' ? 'Stops: Wick' : 'Stops: Close')
      return parts.join(' · ')
    } catch {
      return null
    }
  }, [
    savedAstJson,
  ])

  // Editor vs active-strategy sync state — makes the edit → deploy flow explicit.
  const isEditorSynced = (astJson || '').trim() === (savedAstJson || '').trim()
  
  useEffect(() => {
    setIsMounted(true)
    setRunTrigger(t => t + 1)
  }, [])

  useEffect(() => {
    if (currentTab === 'backtest' && backtestState?.status === 'running') {
      const interval = setInterval(() => {
        revalidator.revalidate()
      }, 500)
      return () => clearInterval(interval)
    }
  }, [
    currentTab,
    backtestState?.status,
    revalidator,
  ])

  // Forward-test detail (transaction log): ?tab=tests&testId=<portfolioId>
  const selectedTestId = searchParams.get('testId')
  const ledger = ledgerData?.success ? ledgerData.data : null

  const safeForwardTests = useMemo(() => (Array.isArray(forwardTests) ? forwardTests : []), [
    forwardTests,
  ])
  const fetcher = useFetcher()

  const handleRunBacktest = () => {
    fetcher.submit({
      intent: 'run_backtest',
      astJson,
      enableDefensiveRotation: String(enableDefensiveRotation),
    }, { method: 'post' })
  }

  const handleSaveCustom = () => {
    const name = prompt('Enter a name for this custom strategy:')
    if (!name) return
    fetcher.submit({ intent: 'save_custom', name, astJson }, { method: 'post' })
  }

  const handleApplyMain = () => {
    fetcher.submit({ intent: 'apply_main', astJson }, { method: 'post' })
  }

  const handleLaunchForwardTest = () => {
    // Opens the deploy modal (state below) — the form carries name, capital,
    // check frequency, active hours, and aggressiveness through the existing
    // create_forward_test action. Replaces the old prompt()-for-capital-only
    // flow that hardcoded 15m / 09:30-16:00 / CONSERVATIVE.
    openDeployModal()
  }

  // Deploy-modal form state — defaults mirror the previously hardcoded values.
  const [
    showDeployModal,
    setShowDeployModal,
  ] = useState(false)
  const [
    deployCapital,
    setDeployCapital,
  ] = useState('10000')
  const [
    deployFrequency,
    setDeployFrequency,
  ] = useState('15m')
  const [
    deployActiveStart,
    setDeployActiveStart,
  ] = useState('09:30')
  const [
    deployActiveEnd,
    setDeployActiveEnd,
  ] = useState('16:00')
  const [
    deployAggressiveness,
    setDeployAggressiveness,
  ] = useState('CONSERVATIVE')
  const [
    deployName,
    setDeployName,
  ] = useState('')
  // Tracks whether the user customized the name — while false, the prefill
  // recomputes when aggressiveness (or the AST) changes.
  const [
    deployNameTouched,
    setDeployNameTouched,
  ] = useState(false)

  // Strategy name from the editor AST for the "Strategy Risk M/D" prefill.
  const editorStrategyName = useMemo(() => {
    try {
      const parsed = JSON.parse(astJson) as unknown
      const obj = (Array.isArray(parsed) ? parsed[0] : parsed) as { strategyName?: unknown } | undefined
      return typeof obj?.strategyName === 'string' ? obj.strategyName : 'Custom'
    } catch {
      return 'Custom'
    }
  }, [
    astJson,
  ])

  const defaultName = useMemo(() => defaultForwardTestName(editorStrategyName, deployAggressiveness),
    [
      editorStrategyName,
      deployAggressiveness, 
    ])
  const effectiveName = deployNameTouched ? deployName : defaultName

  // Existing names for the live duplicate check (case-insensitive). Nulls
  // (legacy portfolios) fall back to their display title.
  const existingPortfolioNames = useMemo(() => safeForwardTests.map((p) => String((p as { accountTitle?: unknown }).accountTitle ?? '')),
    [
      safeForwardTests, 
    ])
  const isDuplicateName = isDuplicatePortfolioName(effectiveName, existingPortfolioNames)

  const openDeployModal = () => {
    // Reset customization tracking each open so the prefill tracks the
    // current AST/aggressiveness until the user types their own name.
    setDeployNameTouched(false)
    setDeployName('')
    setShowDeployModal(true)
  }

  const submitDeployModal = () => {
    if (isDuplicateName) return
    fetcher.submit({
      intent: 'create_forward_test',
      capital: deployCapital,
      strategy: 'custom',
      astJson,
      name: effectiveName,
      checkFrequency: deployFrequency,
      activeHoursStart: deployActiveStart,
      activeHoursEnd: deployActiveEnd,
      rotationAggressiveness: deployAggressiveness,
    }, { method: 'post' })
    setShowDeployModal(false)
  }

  useEffect(() => {
    if (fetcher.data?.success) {
      alert(fetcher.data?.message ?? 'Action completed successfully.')
    } else if (fetcher.data?.error) {
      alert('Error: ' + fetcher.data.error)
    }
  }, [
    fetcher.data,
  ])

  return (
    <div className="p-6 flex flex-col gap-6 h-[calc(100vh-64px)] w-full overflow-hidden font-mono">
      {/* Active Strategy Banner — what the scanner/exit-manager ACTUALLY uses */}
      {activeStrategySummary && (
        <div data-testid="active-strategy-banner" className="flex items-center justify-between gap-4 border border-primary/30 bg-primary/5 rounded-xl px-4 py-2 shrink-0">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider">
            <span className="text-primary">🎯</span>
            <span className="text-foreground/40">Active Strategy (firing signals):</span>
            <span className="text-foreground">{activeStrategySummary}</span>
          </div>
          <div className={`text-micro font-bold uppercase tracking-wider px-2 py-0.5 rounded ${isEditorSynced ? 'bg-up/10 text-up' : 'bg-warning/10 text-warning'}`} data-testid="editor-sync-badge">
            {isEditorSynced ? '✓ In sync with active strategy' : '⚠ Modified — Apply to deploy'}
          </div>
        </div>
      )}
      {/* Top Header & Main Navigation Tabs */}
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-border/10 pb-4 shrink-0">
        <div>
          <h1 data-testid="strategy-builder-heading" className="text-3xl font-black tracking-tight text-foreground flex items-center gap-3">
            <span className="text-primary">⚡</span> STRATEGY STUDIO & DEVELOPER WORKBENCH
          </h1>
          <p className="text-micro font-bold text-foreground/40 uppercase tracking-widest mt-1">
            Build, Backtest, Forward-Test & Deploy AST Quant Strategies via B2D REST API
          </p>
        </div>

        {/* Tab Selection Navigation */}
        <div data-testid="strategy-tabs-nav" className="flex bg-surface-sink p-1 rounded-xl border border-border/20 gap-1">
          <button
            type="button"
            data-testid="tab-builder"
            onClick={() => setSearchParams({ tab: 'builder' })}
            className={`px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all flex items-center gap-2 ${currentTab === 'builder' ? 'bg-primary text-primary-foreground shadow-md' : 'text-foreground/60 hover:text-foreground'}`}
          >
            <span>🎨</span> Strategy Builder & AST
          </button>          <button
            type="button"
            data-testid="tab-backtest"
            onClick={() => setSearchParams({ tab: 'backtest' })}
            className={`px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all flex items-center gap-2 ${currentTab === 'backtest' ? 'bg-primary text-primary-foreground shadow-md' : 'text-foreground/60 hover:text-foreground'}`}
          >
            <span>📈</span> Historical Backtest
          </button>
          <button
            type="button"
            data-testid="tab-tests"
            onClick={() => setSearchParams({ tab: 'tests' })}
            className={`px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all flex items-center gap-2 ${currentTab === 'tests' ? 'bg-primary text-primary-foreground shadow-md' : 'text-foreground/60 hover:text-foreground'}`}
          >
            <span>⚡</span> Live Forward Tests ({(forwardTests || []).length})
            <span className="bg-accent/20 text-accent px-1.5 py-0.5 text-micro rounded pointer-events-none">5 Cr/Wk</span>
          </button>
        </div>
      </header>

      {/* TAB 1: STRATEGY BUILDER & AST EDITOR */}
      {currentTab === 'builder' && (
        <div data-testid="tab-panel-builder" className="flex gap-6 h-full overflow-hidden">
          {/* Strategy Library Sidebar */}
          <div className="w-64 md:w-80 flex flex-col shrink-0 h-full border-r border-surface-base-border pr-6">
            <div className="flex justify-between items-center mb-4">
              <h2 data-testid="strategy-library-title" className="text-xs font-black uppercase tracking-widest text-foreground/40">Strategy Library</h2>
              <button
                onClick={handleSaveCustom}
                className="text-micro font-bold uppercase tracking-wider text-primary hover:underline bg-primary/10 px-2 py-1 rounded"
              >
                + New Strategy
              </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-2 pr-1">
              {customStrategies?.map((s: { id: string; name: string; astJson: string }) => (
                <div
                  key={s.id}
                  onClick={() => setAstJson(s.astJson)}
                  className={`p-3 rounded-xl border transition-all cursor-pointer group flex justify-between items-center ${astJson === s.astJson ? 'bg-primary/10 border-primary text-primary font-bold' : 'bg-surface-sink border-border/10 hover:border-border/30 text-foreground/70'}`}
                >
                  <span className="text-xs font-mono truncate">{s.name}</span>
                  {s.id && !String(s.id).startsWith('default-') && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        if (confirm(`Delete ${s.name}?`)) {
                          fetcher.submit({ intent: 'delete_custom', id: s.id }, { method: 'post' })
                        }
                      }}
                      className="opacity-0 group-hover:opacity-100 text-danger hover:text-danger/80 text-micro font-bold uppercase px-1.5 py-0.5 rounded transition-opacity"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Main AST Code & Action Controls */}
          <div className="flex-1 flex flex-col h-full overflow-hidden gap-4">
            <div className="flex justify-between items-center bg-surface-sink p-4 rounded-xl border border-border/20">
              <div>
                <h3 className="text-sm font-bold text-foreground uppercase tracking-wider">Active Strategy AST Definition</h3>
                <p className="text-micro text-foreground/40">Edit conditions, risk parameters, and regime multipliers in AST JSON format</p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleApplyMain}
                  className="bg-primary hover:bg-primary/90 text-primary-foreground px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all"
                >
                  Apply Main Scanner Strategy
                </button>
                <button
                  onClick={handleLaunchForwardTest}
                  className="bg-accent hover:bg-accent/90 text-black font-bold px-4 py-2 rounded-lg text-xs uppercase tracking-wider transition-all"
                >
                  Launch Live Forward Test 🚀
                </button>
              </div>
            </div>

            <div className="flex-1 border border-border/20 rounded-xl overflow-hidden bg-surface-sink/50 flex flex-col">
              {/* Stop Trigger quick-control (2026-08-21): stopFillMode is an
                  AST-expressible field honored by live exitManager + backtest
                  (scenario > AST > 'close'). Kept visible here because a JSON
                  key is undiscoverable; the toggle edits the editor AST only —
                  Apply-to-scanner persists it like any other edit. */}
              <div className="flex items-center justify-between gap-3 px-4 py-2 bg-surface-elevated/40 border-b border-border/10 shrink-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-foreground/50 uppercase tracking-wider font-bold">Stop Trigger</span>
                  <span
                    title="Wick: any intrabar touch of the stop exits (pessimistic — models a resting stop order). Close: exit only when the price CLOSES through the stop — ignores stop-hunt wicks. A/B: close returned more with LOWER drawdown; gap-through exits still fire in both modes."
                    className="text-foreground/30 cursor-help"
                  >
                    ⓘ
                  </span>
                </div>
                <div className="flex gap-1 bg-surface-sink p-1 rounded-lg border border-border/10">
                  <button
                    type="button"
                    data-testid="stop-mode-close"
                    className={`px-3 py-1 text-xs font-bold uppercase tracking-wider rounded-md transition-colors ${
                      currentStopFillMode !== 'wick' ? 'bg-primary text-primary-content shadow-sm' : 'text-foreground/60 hover:text-foreground'
                    }`}
                    onClick={() => setStopFillMode('close')}
                  >
                    Close-through
                  </button>
                  <button
                    type="button"
                    data-testid="stop-mode-wick"
                    className={`px-3 py-1 text-xs font-bold uppercase tracking-wider rounded-md transition-colors ${
                      currentStopFillMode === 'wick' ? 'bg-primary text-primary-content shadow-sm' : 'text-foreground/60 hover:text-foreground'
                    }`}
                    onClick={() => setStopFillMode('wick')}
                  >
                    Wick (any touch)
                  </button>
                </div>
              </div>
              <div className="flex-1 min-h-0">
                {isMounted && <StrategyAst astJson={astJson} setAstJson={setAstJson} />}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: HISTORICAL BACKTEST ENGINE */}
      {currentTab === 'backtest' && (
        <div data-testid="tab-panel-backtest" className="flex-1 flex flex-col h-full overflow-hidden gap-4">
          <div className="flex justify-between items-center bg-surface-sink p-4 rounded-xl border border-border/20">
            <div>
              <h3 data-testid="backtest-title" className="text-sm font-bold text-foreground uppercase tracking-wider flex items-center gap-2 flex-wrap">
                <span>Multi-Year Historical Backtester</span>
                <span className="text-micro font-mono px-2 py-0.5 rounded bg-warning/10 border border-warning/30 text-warning uppercase font-bold">
                  LOOKAHEAD · AI 65%
                </span>
              </h3>
              <p className="text-micro text-foreground/40">
                Engine path stamps every chart: HONEST (AI undefined + FRED macro as-of) · LIVE_FT · LOOKAHEAD_CEILING.
                Dashboard default runs the 65% AI accuracy sensitivity ceiling — a conditional bound, not realised strategy performance.
                PCR remains PROXY_SPY_SMA50 historically. Do not read ceiling returns as live Gemini skill.
              </p>
            </div>
            <button
              onClick={handleRunBacktest}
              disabled={backtestState?.status === 'running' || fetcher.state !== 'idle'}
              className="bg-success hover:bg-success/90 disabled:opacity-50 text-success-foreground px-6 py-2 rounded-lg text-xs font-black uppercase tracking-wider transition-all shadow-md flex items-center gap-2"
            >
              {backtestState?.status === 'running' ? (
                <>
                  <svg className="animate-spin h-3.5 w-3.5 text-success-foreground" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Running Simulation...
                </>
              ) : 'Run Backtest 🚀'}
            </button>
          </div>

          {backtestState?.status === 'running' || fetcher.state === 'submitting' ? (
            <div className="flex-1 flex flex-col items-center justify-center p-8 bg-surface-sink/60 border border-primary/20 rounded-2xl gap-6 shadow-2xl relative overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-r from-primary/5 via-accent/5 to-primary/5 animate-pulse pointer-events-none" />
              
              <div className="relative z-10 flex flex-col items-center max-w-md text-center gap-4">
                <div className="relative flex items-center justify-center">
                  <div className="w-20 h-20 rounded-full border-4 border-primary/20 border-t-primary animate-spin" />
                  <span className="absolute text-2xl">⚡</span>
                </div>

                <div>
                  <h3 className="text-xl font-black text-foreground tracking-tight flex items-center justify-center gap-2">
                    Simulating Multi-Year Market Regimes
                  </h3>
                  <p className="text-xs font-medium text-foreground/60 mt-1 font-mono">
                    {backtestState?.stageMessage || 'Initiating multi-year backtest engine & historical data cache...'}
                  </p>
                </div>

                <div className="w-full bg-surface-base rounded-full h-3 p-0.5 border border-border/20 overflow-hidden shadow-inner">
                  <div 
                    className="bg-gradient-to-r from-primary to-accent h-full rounded-full transition-all duration-300 ease-out"
                    style={{ width: `${backtestState?.progress || 10}%` }}
                  />
                </div>

                <div className="flex items-center justify-between w-full text-micro font-mono text-foreground/50 px-1">
                  <span>Progress: {backtestState?.progress || 10}%</span>
                  <span>25 Tickers • 504 Candles (2-Year Max)</span>
                </div>

                <div className="grid grid-cols-2 gap-2 w-full mt-2 text-micro font-mono">
                  <div className="p-2 bg-surface-base rounded-lg border border-border/10 flex items-center gap-1.5 text-foreground/70">
                    <span className="animate-ping w-2 h-2 rounded-full bg-success shrink-0" />
                    <span>Regime Evaluation</span>
                  </div>
                  <div className="p-2 bg-surface-base rounded-lg border border-border/10 flex items-center gap-1.5 text-foreground/70">
                    <span className="w-2 h-2 rounded-full bg-info shrink-0" />
                    <span>AST Logic Checks</span>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto">
              {isMounted && (
                <StrategyChart
                  astJson={astJson}
                  enableDefensiveRotation={enableDefensiveRotation}
                  runTrigger={runTrigger}
                />
              )}
            </div>
          )}
        </div>
      )}

      {/* TAB 3: LIVE B2D FORWARD TESTS (5 CREDITS/WEEK) */}
      {currentTab === 'tests' && (
        <div data-testid="tab-panel-tests" className="flex-1 flex flex-col h-full overflow-y-auto gap-6">
          <div className="bg-surface-sink p-4 rounded-xl border border-border/20 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <div>
              <h3 data-testid="forward-tests-title" className="text-sm font-bold text-foreground uppercase tracking-wider">Active B2D Forward Testing Portfolios</h3>
              <p className="text-micro text-foreground/40">Evaluates live 15-minute streaming market ticks. Each active strategy charges 5 credits/week.</p>
            </div>
            <button
              onClick={handleLaunchForwardTest}
              className="bg-accent hover:bg-accent/90 text-black px-6 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all shadow-md"
            >
              + Deploy New B2D Strategy Test
            </button>
          </div>

          {selectedTestId && ledger ? (
            <div data-testid="forward-test-detail" className="flex flex-col gap-6">
              <div className="flex justify-between items-center border-b border-border/10 pb-4">
                <div>
                  <h2 className="text-lg font-black uppercase tracking-wider text-primary">{ledger.accountTitle}</h2>
                  <p className="text-micro font-bold text-foreground/40 uppercase tracking-widest mt-1">Transaction Log • Forward Test #{selectedTestId}</p>
                </div>
                <button
                  onClick={() => setSearchParams({ tab: 'tests' })}
                  className="border border-border/30 hover:border-border/50 text-foreground/70 px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all"
                >
                  ← All Tests
                </button>
              </div>

              <div>
                <h3 className="text-micro font-black uppercase tracking-widest text-foreground/40 mb-2">Transaction Log ({ledger.ledger.length})</h3>
                <div className="border border-border/10 rounded-xl overflow-hidden">
                  <table className="w-full text-xs font-mono">
                    <thead>
                      <tr className="bg-surface-elevated/60 text-foreground/40 uppercase tracking-wider text-micro">
                        <th className="text-left px-3 py-2 font-bold">Executed</th>
                        <th className="text-left px-3 py-2 font-bold">Action</th>
                        <th className="text-left px-3 py-2 font-bold">Ticker</th>
                        <th className="text-right px-3 py-2 font-bold">Shares</th>
                        <th className="text-right px-3 py-2 font-bold">Price</th>
                        <th className="text-right px-3 py-2 font-bold">Notional</th>
                        <th className="text-left px-3 py-2 font-bold">Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ledger.ledger.length === 0 ? (
                        <tr><td colSpan={7} className="px-3 py-4 text-center text-foreground/40 italic">No transactions recorded yet.</td></tr>
                      ) : ledger.ledger.map((tx) => {
                        const isBuy = tx.action === 'BUY'
                        return (
                          <tr key={tx.id} className="border-t border-border/5">
                            <td className="px-3 py-1.5 text-foreground/60">{tx.executedAt ? new Date(tx.executedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                            <td className={`px-3 py-1.5 font-black ${isBuy ? 'text-info' : 'text-warning'}`}>{tx.action}</td>
                            <td className="px-3 py-1.5 font-bold text-primary">{tx.ticker}</td>
                            <td className="px-3 py-1.5 text-right">{tx.shares.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                            <td className="px-3 py-1.5 text-right">${tx.price.toFixed(2)}</td>
                            <td className="px-3 py-1.5 text-right">${(tx.shares * tx.price).toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                            <td className="px-3 py-1.5 text-foreground/50 truncate max-w-48" title={tx.reason}>{tx.reason}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              <div>
                <h3 className="text-micro font-black uppercase tracking-widest text-foreground/40 mb-2">Closed Trades ({ledger.closedTrades.length})</h3>
                <div className="border border-border/10 rounded-xl overflow-hidden">
                  <table className="w-full text-xs font-mono">
                    <thead>
                      <tr className="bg-surface-elevated/60 text-foreground/40 uppercase tracking-wider text-micro">
                        <th className="text-left px-3 py-2 font-bold">Ticker</th>
                        <th className="text-left px-3 py-2 font-bold">Opened</th>
                        <th className="text-left px-3 py-2 font-bold">Closed</th>
                        <th className="text-right px-3 py-2 font-bold">Entry</th>
                        <th className="text-right px-3 py-2 font-bold">Shares</th>
                        <th className="text-right px-3 py-2 font-bold">P&L $</th>
                        <th className="text-right px-3 py-2 font-bold">P&L %</th>
                        <th className="text-left px-3 py-2 font-bold">Branch</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ledger.closedTrades.length === 0 ? (
                        <tr><td colSpan={8} className="px-3 py-4 text-center text-foreground/40 italic">No closed trades yet.</td></tr>
                      ) : ledger.closedTrades.map((t) => {
                        const win = t.profitUsd >= 0
                        return (
                          <tr key={t.id} className="border-t border-border/5">
                            <td className="px-3 py-1.5 font-bold text-primary">{t.ticker}</td>
                            <td className="px-3 py-1.5 text-foreground/60">{t.openedAt ? new Date(t.openedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}</td>
                            <td className="px-3 py-1.5 text-foreground/60">{t.closedAt ? new Date(t.closedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}</td>
                            <td className="px-3 py-1.5 text-right">${t.entryPrice.toFixed(2)}</td>
                            <td className="px-3 py-1.5 text-right">{t.shares.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                            <td className={`px-3 py-1.5 text-right font-black ${win ? 'text-up' : 'text-down'}`}>{win ? '+' : ''}${t.profitUsd.toFixed(2)}</td>
                            <td className={`px-3 py-1.5 text-right font-bold ${win ? 'text-up' : 'text-down'}`}>{win ? '+' : ''}{t.profitPercent.toFixed(2)}%</td>
                            <td className="px-3 py-1.5 text-foreground/40 truncate max-w-48" title={t.firedBranchName ?? undefined}>{t.firedBranchName ?? '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : safeForwardTests.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center p-12 text-center text-foreground/40 bg-surface-sink/30 border border-border/10 rounded-2xl">
              <span className="text-6xl mb-4 opacity-50">🧪</span>
              <h3 className="text-xl font-bold uppercase tracking-wider mb-2 text-foreground">No B2D Forward Tests Running</h3>
              <p className="max-w-md text-xs font-medium text-foreground/60 mb-4">Deploy a live forward-testing portfolio using your active AST strategy parameters or provision one via REST API.</p>
              <div className="bg-primary/10 border border-primary/20 text-primary p-4 rounded-xl text-xs font-mono max-w-md">
                💳 Billing: 5 Credits / Week per active strategy. Automated 15-min tick evaluation on server.
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              {safeForwardTests.map((item: unknown) => {
                const p = item as Record<string, unknown>
                const stats = p.stats as Record<string, number> | undefined
                const activePositions = (p.activePositions as Record<string, number>[]) || []
                return (
                  <Surface
                    key={String(p.chatId)}
                    surface="base"
                    className="p-6 rounded-2xl border border-border/20 flex flex-col gap-4 bg-surface-sink/40 cursor-pointer hover:border-primary/40 transition-all"
                    onClick={() => setSearchParams({ tab: 'tests', testId: String(p.chatId) })}
                  >
                    <div className="flex justify-between items-start border-b border-border/10 pb-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-base font-bold uppercase tracking-wider text-primary">{String(p.accountTitle)}</h3>
                          <span className="bg-primary/10 border border-primary/30 text-primary px-2.5 py-0.5 rounded-full text-micro font-bold uppercase tracking-wider">
                            💳 5 Credits/Wk
                          </span>
                        </div>
                        <p className="text-micro font-bold text-foreground/40 uppercase tracking-widest mt-1">
                          Strategy: {String(p.strategy)} • Aggressiveness: {String(p.rotationAggressiveness)}
                        </p>
                        <p className="text-micro font-medium text-foreground/60 tracking-wider mt-0.5 font-mono">
                          ⏱️ Check: {String(p.checkFrequency || '15m')} • Active: {String(p.activeHoursStart || '09:30')}-{String(p.activeHoursEnd || '16:00')} EST
                        </p>
                      </div>
                      <fetcher.Form method="post" onSubmit={(e) => !confirm('Delete this forward test?') && e.preventDefault()}>
                        <input type="hidden" name="intent" value="delete_forward_test" />
                        <input type="hidden" name="chatId" value={String(p.chatId)} />
                        <button
                          type="submit"
                          onClick={(e) => e.stopPropagation()}
                          className="bg-danger/10 hover:bg-danger/20 text-danger px-3 py-1 rounded text-micro font-bold uppercase"
                        >
                          Delete
                        </button>
                      </fetcher.Form>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="bg-surface-sink p-3 rounded-xl border border-border/10">
                        <div className="text-micro font-bold text-foreground/40 uppercase tracking-wider">Portfolio Total Value</div>
                        <div className="flex items-baseline gap-2 mt-1 flex-wrap">
                          <span className="text-lg font-bold text-primary font-mono">
                            ${(stats?.estimatedTotalValue ?? stats?.totalCapital ?? 10000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </span>
                          {(() => {
                            const initial = stats?.initialCapital ?? 0
                            const current = stats?.estimatedTotalValue ?? stats?.totalCapital ?? initial
                            if (!initial || initial <= 0) return null
                            // Prefer the API's canonical return (realized +
                            // unrealized P&L) — estimatedTotalValue vs initial
                            // underestimates rotated books with floored cash.
                            const canonical = typeof (p as { totalReturnPct?: number }).totalReturnPct === 'number'
                              ? (p as { totalReturnPct: number }).totalReturnPct
                              : null
                            const diffPct = canonical ?? ((current - initial) / initial) * 100
                            const isPositive = diffPct >= 0
                            return (
                              <span className={`text-xs font-bold font-mono ${isPositive ? 'text-up' : 'text-down'}`}>
                                {isPositive ? '+' : ''}{diffPct.toFixed(2)}%
                              </span>
                            )
                          })()}
                        </div>
                      </div>
                      <div className="bg-surface-sink p-3 rounded-xl border border-border/10">
                        <div className="text-micro font-bold text-foreground/40 uppercase tracking-wider">Cash / Deployed</div>
                        <div className="text-xs font-bold text-foreground font-mono mt-2">
                          💵 <span className="text-up">${(stats?.availableCash ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                          <span className="text-foreground/20"> / </span>
                          🔵 <span className="text-info">${(stats?.deployedCapital ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                        </div>
                      </div>
                    </div>

                    {/* Active Positions */}
                    <div>
                      <h4 className="text-micro font-bold uppercase tracking-wider text-foreground/60 mb-2">Open Positions ({activePositions.length})</h4>
                      {activePositions.length === 0 ? (
                        <div className="text-micro text-foreground/40 italic p-2 bg-surface-sink rounded border border-border/5">No open positions. Monitoring market signals...</div>
                      ) : (
                        <div className="space-y-1.5">
                          {activePositions.map((pos) => {
                            const pnl = pos.profitUsd ?? 0
                            const pnlPct = pos.profitPercent ?? 0
                            return (
                              <div key={pos.id} className="flex justify-between items-center text-xs font-mono p-2 bg-surface-sink rounded border border-border/10">
                                <span className="font-bold text-primary">{String(pos.ticker)}</span>
                                <span>Entry: ${pos.entry?.toFixed(2)}</span>
                                <span>Cur: ${pos.currentPrice?.toFixed(2)}</span>
                                <span className={pnl >= 0 ? 'text-up font-bold' : 'text-down font-bold'}>
                                  {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} ({pnlPct.toFixed(2)}%)
                                </span>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  </Surface>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Deploy Forward-Test Modal — full configuration for the B2D portfolio
          (capital, tick frequency, active hours, aggressiveness). Follows the
          dashboard's overlay convention (fixed inset-0 z-50 bg-black/70). */}
      {showDeployModal && (
        <div
          data-testid="deploy-forward-test-modal"
          className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setShowDeployModal(false)}
        >
          <div
            className="bg-surface-elevated border border-border/30 rounded-2xl p-6 w-full max-w-md flex flex-col gap-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center border-b border-border/10 pb-3">
              <h3 className="text-sm font-black uppercase tracking-widest text-foreground">🚀 Deploy Forward Test</h3>
              <button
                type="button"
                onClick={() => setShowDeployModal(false)}
                className="text-foreground/50 hover:text-foreground text-lg leading-none"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <label className="flex flex-col gap-1 text-xs">
              <span className="font-bold uppercase tracking-wider text-foreground/60">Portfolio Name</span>
              <input
                type="text"
                maxLength={120}
                value={effectiveName}
                onChange={(e) => {
                  setDeployName(e.target.value)
                  setDeployNameTouched(true)
                }}
                data-testid="deploy-name-input"
                className={`bg-surface-sink border rounded-lg px-3 py-2 text-foreground font-mono focus:outline-none ${isDuplicateName ? 'border-danger focus:border-danger' : 'border-border/30 focus:border-primary'}`}
              />
              {isDuplicateName ? (
                <span data-testid="deploy-name-duplicate-warning" className="text-danger font-bold">
                  A forward test with this name already exists — choose a different name.
                </span>
              ) : (
                <span className="text-foreground/40">
                  Prefilled as Strategy · Risk · M/D — edit freely. Names must be unique per account.
                </span>
              )}
            </label>

            <label className="flex flex-col gap-1 text-xs">
              <span className="font-bold uppercase tracking-wider text-foreground/60">Starting Budget ($USD)</span>
              <input
                type="number"
                min="100"
                value={deployCapital}
                onChange={(e) => setDeployCapital(e.target.value)}
                data-testid="deploy-capital-input"
                className="bg-surface-sink border border-border/30 rounded-lg px-3 py-2 text-foreground font-mono focus:outline-none focus:border-primary"
              />
            </label>

            <label className="flex flex-col gap-1 text-xs">
              <span className="font-bold uppercase tracking-wider text-foreground/60">Check Frequency (tick interval)</span>
              <select
                value={deployFrequency}
                onChange={(e) => setDeployFrequency(e.target.value)}
                data-testid="deploy-frequency-select"
                className="bg-surface-sink border border-border/30 rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary"
              >
                <option value="15m">Every 15 minutes</option>
                <option value="1h">Every hour</option>
                <option value="1d">Once a day</option>
              </select>
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1 text-xs">
                <span className="font-bold uppercase tracking-wider text-foreground/60">Active From (ET)</span>
                <input
                  type="time"
                  value={deployActiveStart}
                  onChange={(e) => setDeployActiveStart(e.target.value)}
                  data-testid="deploy-active-start-input"
                  className="bg-surface-sink border border-border/30 rounded-lg px-3 py-2 text-foreground font-mono focus:outline-none focus:border-primary"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="font-bold uppercase tracking-wider text-foreground/60">Active To (ET)</span>
                <input
                  type="time"
                  value={deployActiveEnd}
                  onChange={(e) => setDeployActiveEnd(e.target.value)}
                  data-testid="deploy-active-end-input"
                  className="bg-surface-sink border border-border/30 rounded-lg px-3 py-2 text-foreground font-mono focus:outline-none focus:border-primary"
                />
              </label>
            </div>

            <label className="flex flex-col gap-1 text-xs">
              <span className="font-bold uppercase tracking-wider text-foreground/60">Aggressiveness (position sizing)</span>
              <select
                value={deployAggressiveness}
                onChange={(e) => setDeployAggressiveness(e.target.value)}
                data-testid="deploy-aggressiveness-select"
                className="bg-surface-sink border border-border/30 rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary"
              >
                <option value="CONSERVATIVE">Conservative — 10% equity / trade</option>
                <option value="BALANCED">Balanced — 12% equity / trade</option>
                <option value="AGGRESSIVE">Aggressive — 15% equity / trade</option>
              </select>
            </label>

            <div className="bg-primary/10 border border-primary/20 text-primary p-3 rounded-xl text-micro font-mono">
              💳 Billing: 5 credits / week. Strategy: your current editor AST (custom).
            </div>

            <button
              type="button"
              onClick={submitDeployModal}
              disabled={isDuplicateName}
              data-testid="deploy-submit-button"
              className="bg-primary hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed text-primary-foreground font-bold uppercase tracking-wider text-xs px-4 py-3 rounded-xl transition-colors active:scale-[0.98]"
            >
              Deploy — {Number(deployCapital || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} USD budget
            </button>
          </div>
        </div>
      )}

    </div>
  )
}
