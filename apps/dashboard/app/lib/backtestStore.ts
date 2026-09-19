 

export interface BacktestMetrics {
  totalReturnPct: number
  spyBenchmarkPct: number
  excessAlphaPct: number
  maxDrawdownPct: number
  winRatePct: number
  totalTrades: number
  sharpeRatio: number
  /**
   * Canonical: HONEST | LIVE_FT | LOOKAHEAD_CEILING.
   * UI_MOCK = progress-shell placeholders only — never market as alpha.
   */
  evidenceTier: 'HONEST' | 'LIVE_FT' | 'LOOKAHEAD_CEILING' | 'UI_MOCK'
  evidenceStamp: string
  regimePerformance: Array<{
    regime: string
    returnPct: number
    tradesCount: number
  }>
  equityCurve: Array<{
    day: number
    date: string
    portfolioReturnPct: number
    spyReturnPct: number
  }>
}

export interface BacktestState {
  id: string
  status: 'idle' | 'running' | 'completed' | 'failed'
  progress: number
  stageMessage: string
  startedAt: number | null
  completedAt: number | null
  astJson: string
  enableDefensiveRotation: boolean
  metrics: BacktestMetrics | null
  error: string | null
}

const backtestStore = new Map<string, BacktestState>()
let latestBacktestId: string | null = null

export function getBacktestState(id?: string): BacktestState | null {
  if (!id || id === 'latest') {
    return latestBacktestId ? backtestStore.get(latestBacktestId) || null : null
  }
  return backtestStore.get(id) || null
}

export function startBacktestJob(astJson: string, enableDefensiveRotation: boolean): string {
  const id = `bt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  const state: BacktestState = {
    id,
    status: 'running',
    progress: 5,
    stageMessage: 'Initiating multi-year backtest engine & historical data cache...',
    startedAt: Date.now(),
    completedAt: null,
    astJson,
    enableDefensiveRotation,
    metrics: null,
    error: null,
  }

  backtestStore.set(id, state)
  latestBacktestId = id

  // Process asynchronously on the server
  executeBacktestAsync(id, astJson, enableDefensiveRotation).catch((err) => {
    const currentState = backtestStore.get(id)
    if (currentState) {
      currentState.status = 'failed'
      currentState.error = err instanceof Error ? err.message : String(err)
    }
  })

  return id
}

async function executeBacktestAsync(id: string, astJson: string, enableDefensiveRotation: boolean) {
  const state = backtestStore.get(id)
  if (!state) return

  // Stage 1: Loading historical market candles
  state.progress = 20
  state.stageMessage = 'Loading 504 trading days (2-year max) across 25-stock universe...'
  await new Promise((resolve) => setTimeout(resolve, 600))

  // Stage 2: Parsing AST rules
  state.progress = 45
  state.stageMessage = 'Parsing AST entry & exit conditions and dynamic scoring rules...'
  await new Promise((resolve) => setTimeout(resolve, 800))

  // Stage 3: Evaluating market regimes & risk multipliers
  state.progress = 70
  state.stageMessage = enableDefensiveRotation 
    ? 'Evaluating Risk-On / Risk-Off regimes & applying defensive rotation guardrails...'
    : 'Evaluating Risk-On / Risk-Off regimes with standard allocation...'
  await new Promise((resolve) => setTimeout(resolve, 800))

  // Stage 4: Calculating equity curve and drawdown metrics
  state.progress = 90
  state.stageMessage = 'Calculating equity curve, drawdown metrics, and win-rate statistics...'
  await new Promise((resolve) => setTimeout(resolve, 600))

  // Calculate deterministic results based on AST complexity
  const isComplex = (() => {
    try {
      const parsed = JSON.parse(astJson) as unknown
      return Boolean(parsed && (Array.isArray(parsed) ? parsed.length > 1 : true))
    } catch {
      return false
    }
  })()
  const isDefensive = enableDefensiveRotation

  const totalReturnPct = isComplex ? (isDefensive ? 66.95 : 63.52) : 48.20
  const spyBenchmarkPct = 52.93
  const excessAlphaPct = Number((totalReturnPct - spyBenchmarkPct).toFixed(2))
  const maxDrawdownPct = isDefensive ? 0.75 : 1.25
  const winRatePct = isComplex ? 71.2 : 64.5
  const totalTrades = isComplex ? 226 : 142
  const sharpeRatio = isDefensive ? 2.45 : 1.85

  // Generate 100 equity curve datapoints over 504 days
  const equityCurve = []
  const step = 504 / 100
  for (let i = 0; i <= 100; i++) {
    const day = Math.round(i * step)
    const progressFactor = i / 100
    const noise = (Math.sin(i * 0.4) * 1.5) + (Math.cos(i * 0.2) * 1.0)
    const portfolioReturnPct = Number((totalReturnPct * Math.pow(progressFactor, 0.9) + noise).toFixed(2))
    const spyReturnPct = Number((spyBenchmarkPct * progressFactor + (noise * 0.5)).toFixed(2))

    equityCurve.push({
      day,
      date: `Day ${day}`,
      portfolioReturnPct: Math.max(-2, portfolioReturnPct),
      spyReturnPct: Math.max(-2, spyReturnPct),
    })
  }

  state.progress = 100
  state.stageMessage = 'Backtest complete!'
  state.status = 'completed'
  state.completedAt = Date.now()
  state.metrics = {
    totalReturnPct,
    spyBenchmarkPct,
    excessAlphaPct,
    maxDrawdownPct,
    winRatePct,
    totalTrades,
    sharpeRatio,
    // Progress shell only — real stamps come from PortfolioBacktestEngine / StrategyChart
    evidenceTier: 'UI_MOCK',
    evidenceStamp: '[UI_MOCK | not engine | do not cite as alpha]',
    regimePerformance: [
      { regime: 'RISK_ON (Bullish Liquidity)', returnPct: Number((totalReturnPct * 0.65).toFixed(2)), tradesCount: Math.round(totalTrades * 0.6) },
      { regime: 'RISK_OFF (Defensive Shakeouts)', returnPct: Number((totalReturnPct * 0.35).toFixed(2)), tradesCount: Math.round(totalTrades * 0.4) },
    ],
    equityCurve,
  }
}
