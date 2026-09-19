import { GlobalLiquidityTrend, MacroExposureType } from '@quantour/shared-algo/src/core/types'
import type { ChartDataset } from 'chart.js'
import Chart from 'chart.js/auto'
import zoomPlugin from 'chartjs-plugin-zoom'
import {
  useEffect, useMemo, useRef, useState, 
} from 'react'
import { z } from 'zod'

const StreamPointSchema = z.object({
  date: z.string(),
  balance: z.number(),
  spy: z.number(),
  iwm: z.number(),
})

const StreamTradeSchema = z.object({
  entryDate: z.string(),
  ticker: z.string(),
  entryPrice: z.number(),
  stopLoss: z.number(),
  strategyName: z.string().optional(),
})

const StreamMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('meta'),
    evidenceTier: z.string(),
    provisionalStamp: z.string(),
    initialBalance: z.number(),
    aiAccuracy: z.number(),
    startDate: z.string(),
    endDate: z.string(),
  }),
  z.object({
    type: z.literal('quarter'),
    points: z.array(StreamPointSchema),
    progress: z.number(),
  }),
  z.object({
    type: z.literal('done'),
    metrics: z.object({
      initialBalance: z.number().optional(),
      finalBalance: z.number().optional(),
      totalReturnPercent: z.number().optional(),
      benchmarkSpyReturnPercent: z.number().optional(),
      winRate: z.number().optional(),
      totalTrades: z.number().optional(),
      sharpeRatio: z.number().optional(),
      maxDrawdownPercent: z.number().optional(),
      evidenceTier: z.string(),
      evidenceStamp: z.string(),
    }),
    trades: z.array(StreamTradeSchema),
    evidence: z.looseObject({ evidenceTier: z.string(), stamp: z.string() }),
    remainingDailyExecutions: z.number(),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
])

type StreamPoint = z.infer<typeof StreamPointSchema>
type StreamTrade = z.infer<typeof StreamTradeSchema>
type StreamMessage = z.infer<typeof StreamMessageSchema>

interface EngineChartPoint {
  date: string
  balance: number
  spy: number
}

const MIN_WINDOW_POINTS = 10

const TIMEFRAME_PRESETS: Array<{ label: string; months: number | null }> = [
  { label: '3M', months: 3 },
  { label: '6M', months: 6 },
  { label: '1Y', months: 12 },
  { label: '2Y', months: 24 },
  { label: 'ALL', months: null },
]

function DualRangeSlider({
  from, to, max, onFrom, onTo, 
}: { from: number; to: number; max: number; onFrom: (v: number) => void; onTo: (v: number) => void }) {
  const pct = (v: number) => (max > 0 ? (v / max) * 100 : 0)
  const thumbClass = [
    '[&::-webkit-slider-thumb]:pointer-events-auto',
    '[&::-webkit-slider-thumb]:appearance-none',
    '[&::-webkit-slider-thumb]:w-4',
    '[&::-webkit-slider-thumb]:h-4',
    '[&::-webkit-slider-thumb]:rounded-full',
    '[&::-webkit-slider-thumb]:bg-primary',
    '[&::-webkit-slider-thumb]:border',
    '[&::-webkit-slider-thumb]:border-border/40',
    '[&::-webkit-slider-thumb]:cursor-grab',
    '[&::-moz-range-thumb]:pointer-events-auto',
    '[&::-moz-range-thumb]:appearance-none',
    '[&::-moz-range-thumb]:w-4',
    '[&::-moz-range-thumb]:h-4',
    '[&::-moz-range-thumb]:rounded-full',
    '[&::-moz-range-thumb]:bg-primary',
    '[&::-moz-range-thumb]:border-0',
    '[&::-moz-range-thumb]:cursor-grab',
  ].join(' ')
  return (
    <div data-testid="backtest-timeframe-slider" className="relative h-6 w-full flex items-center">
      <div className="absolute inset-x-0 h-1.5 rounded-full bg-surface-base border border-border/20" />
      <div className="absolute h-1.5 rounded-full bg-primary/50" style={{ left: `${pct(from)}%`, right: `${100 - pct(to)}%` }} />
      <input
        type="range"
        aria-label="Timeframe start"
        min={0}
        max={max}
        value={from}
        onChange={(e) => onFrom(Number(e.target.value))}
        className={`absolute w-full h-6 appearance-none bg-transparent pointer-events-none ${thumbClass}`}
      />
      <input
        type="range"
        aria-label="Timeframe end"
        min={0}
        max={max}
        value={to}
        onChange={(e) => onTo(Number(e.target.value))}
        className={`absolute w-full h-6 appearance-none bg-transparent pointer-events-none ${thumbClass}`}
      />
    </div>
  )
}

export interface ChartDataPoint {
  day: number
  date: string
  currentPrice: number
  volume: number
  smaVolume20: number
  atr: number
  sma8: number
  sma10: number
  sma20: number
  sma21: number
  ema8: number
  ema21: number
  sma50: number
  sma200: number
  rsi: number
  relativeStrength: number
  newsScore: number
  insiderScore: number
  winRate: number
  macroNarrativeHype: number
  // biome-ignore lint/suspicious/noExplicitAny: legacy `any` (migrated from eslint-disable) — typed cleanup pending
  macro: any
  // biome-ignore lint/suspicious/noExplicitAny: legacy `any` (migrated from eslint-disable) — typed cleanup pending
  stock: any
  marketRegime: { isSafe: boolean }
  maxRisk: number
  symbol?: string
}

export interface ChartAsset {
  name: string
  data: ChartDataPoint[]
  inPosition: boolean
  highest: number
  stop: number
  dataMap: Map<string, ChartDataPoint>
}

let cachedFlatData: ChartDataPoint[] | null = null
let cachedAssets: ChartAsset[] | null = null
let fetchPromise: Promise<void> | null = null


Chart.register(zoomPlugin)

// Removed local evaluateNode and evaluateStrategy, using backend API instead

export function StrategyChart({
  astJson, runTrigger, enableDefensiveRotation = true, onMetrics, 
// biome-ignore lint/suspicious/noExplicitAny: legacy `any` (migrated from eslint-disable) — typed cleanup pending
}: { astJson: string; runTrigger: number; enableDefensiveRotation?: boolean; onMetrics?: (metrics: any) => void }) {
  const equityChartRef = useRef<HTMLCanvasElement>(null)
  const equityInstance = useRef<Chart | null>(null)
  const curvePointsRef = useRef<EngineChartPoint[]>([])
  const tradesRef = useRef<StreamTrade[]>([])
  const provisionalStampRef = useRef('[LOOKAHEAD_CEILING | streaming…]')

  const [
    view,
    setView,
  ] = useState<{ from: number; to: number } | null>(null)
  const [
    dataLen,
    setDataLen,
  ] = useState(0)
  const [
    activePreset,
    setActivePreset,
  ] = useState<string | null>(null)

  const syncViewFromChart = () => {
    const chart = equityInstance.current
    const scale = chart?.scales?.x
    if (!scale || curvePointsRef.current.length === 0) return
    const from = Math.max(0, Math.round(Number(scale.min)))
    const to = Math.min(curvePointsRef.current.length - 1, Math.round(Number(scale.max)))
    if (to - from < MIN_WINDOW_POINTS) return
    setView({ from, to })
    setActivePreset(null)
  }

  const applyTimeframe = (from: number, to: number) => {
    const chart = equityInstance.current
    const curve = curvePointsRef.current
    if (!chart || curve.length === 0) return
    const lastIdx = curve.length - 1
    const clampedTo = Math.min(lastIdx, Math.max(to, MIN_WINDOW_POINTS))
    const clampedFrom = Math.max(0, Math.min(from, clampedTo - MIN_WINDOW_POINTS))
    const xScale = chart.options.scales?.x
    if (xScale) {
      xScale.min = clampedFrom
      xScale.max = clampedTo
    }
    chart.update('none')
    setView({ from: clampedFrom, to: clampedTo })
    setActivePreset(null)
  }

  // Preset windows as a fraction of the loaded curve (3y default => months/36
  // of total length) — works for both ISO-date labels and the fallback
  // "Day N" labels without date parsing.
  const applyPreset = (preset: { label: string; months: number | null }) => {
    const curve = curvePointsRef.current
    if (curve.length === 0) return
    const toIdx = curve.length - 1
    const fromIdx = preset.months === null
      ? 0
      : Math.max(0, toIdx - Math.round((preset.months / 36) * curve.length))
    applyTimeframe(fromIdx, toIdx)
    setActivePreset(preset.label)
  }

  const windowStats = useMemo(() => {
    const curve = curvePointsRef.current
    if (!view || curve.length === 0) return null
    const fromPoint = curve[view.from]
    const toPoint = curve[view.to]
    if (!fromPoint || !toPoint) return null
    const startBalance = fromPoint.balance
    const windowReturnPct = startBalance > 0 ? ((toPoint.balance - startBalance) / startBalance) * 100 : 0
    return {
      fromDate: fromPoint.date,
      toDate: toPoint.date,
      windowReturnPct,
      isFull: view.from === 0 && view.to === curve.length - 1,
    }
  }, [
    view,
    dataLen,
  ])

  const buildEngineChart = (stamp: string) => {
    if (!equityChartRef.current) return
    let gradient: CanvasGradient | null = null
    const ctx = equityChartRef.current.getContext('2d')
    if (ctx) {
      gradient = ctx.createLinearGradient(
        0, 0, 0, 400,
      )
      gradient.addColorStop(0, 'rgba(34, 197, 94, 0.4)')
      gradient.addColorStop(1, 'rgba(34, 197, 94, 0.0)')
    }

    equityInstance.current = new Chart(equityChartRef.current, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: `Portfolio (${stamp})`,
            data: [],
            borderColor: '#22c55e',
            backgroundColor: gradient || 'rgba(34, 197, 94, 0.2)',
            borderWidth: 2,
            pointRadius: 0,
            pointBackgroundColor: '#22c55e',
            pointBorderColor: '#000000',
            pointBorderWidth: 1.5,
            pointHoverRadius: 4,
            tension: 0.4,
            fill: true,
          },
          {
            label: 'SPY Benchmark',
            data: [],
            borderColor: 'rgba(255,255,255,0.3)',
            borderWidth: 2,
            pointRadius: 0,
            borderDash: [
              5,
              5,
            ],
            tension: 0.4,
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          title: {
            display: true,
            text: stamp,
            color: '#fbbf24',
            font: { family: 'ui-monospace, monospace', size: 11 },
          },
          zoom: {
            zoom: {
              wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x', onZoomComplete: () => syncViewFromChart(), 
            },
            pan: { enabled: true, mode: 'x', onPanComplete: () => syncViewFromChart() },
            limits: { x: { min: 'original', max: 'original', minRange: MIN_WINDOW_POINTS } },
          },
          tooltip: {
            callbacks: {
              label: (context) => `${context.dataset.label}: $${Number(context.raw).toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
              afterBody: (tooltipItems) => {
                const dataIdx = tooltipItems[0]?.dataIndex
                const curve = curvePointsRef.current
                if (dataIdx === undefined || !curve[dataIdx]) return []
                const pointDate = curve[dataIdx].date
                const firedTrades = tradesRef.current.filter((t) => t.entryDate === pointDate)
                if (firedTrades.length === 0) return []

                const lines: string[] = [
                  '\n🚀 EXECUTED TRADES:',
                ]
                firedTrades.forEach((t) => {
                  lines.push(`• ${t.ticker}: Entry $${t.entryPrice?.toFixed(2)} | Stop $${t.stopLoss?.toFixed(2)} | Strategy: ${t.strategyName || 'AST'}`)
                })
                return lines
              },
            },
          },
        },
        scales: {
          y: { grid: { color: 'rgba(255,255,255,0.05)' } },
          x: { grid: { display: false } },
        },
      },
    })
  }

  const appendEnginePoints = (points: StreamPoint[]) => {
    const curve = curvePointsRef.current
    points.forEach((pt) => curve.push({ date: pt.date, balance: pt.balance, spy: pt.spy }))
    if (!equityInstance.current) {
      buildEngineChart(provisionalStampRef.current)
      if (!equityInstance.current) return
    }
    const chart = equityInstance.current
    chart.data.labels = curve.map((c) => c.date)
    chart.data.datasets[0]!.data = curve.map((c) => c.balance)
    chart.data.datasets[1]!.data = curve.map((c) => c.spy)
    chart.update('none')
  }

  const finalizeEngineChart = (stamp: string, trades: StreamTrade[]) => {
    const chart = equityInstance.current
    const curve = curvePointsRef.current
    tradesRef.current = trades
    if (!chart || curve.length === 0) return
    const tradeDates = new Set(trades.map((t) => t.entryDate))
    const ds = chart.data.datasets[0] as ChartDataset<'line', number[]>
    ds.pointRadius = curve.map((c) => (tradeDates.has(c.date) ? 5 : 0))
    ds.pointBackgroundColor = curve.map((c) => (tradeDates.has(c.date) ? '#eab308' : '#22c55e'))
    ds.pointHoverRadius = curve.map((c) => (tradeDates.has(c.date) ? 8 : 4))
    ds.label = `Portfolio (${stamp})`
    if (chart.options.plugins?.title) chart.options.plugins.title.text = stamp
    chart.update('none')
    setDataLen(curve.length)
    setView({ from: 0, to: curve.length - 1 })
  }

  useEffect(() => {
    // Immediately destroy previous chart canvas renderings while loading new backtest calculation
    if (equityInstance.current) {
      equityInstance.current.destroy()
      equityInstance.current = null
    }

    // biome-ignore lint/suspicious/noExplicitAny: legacy `any` (migrated from eslint-disable) — typed cleanup pending
    let parsed: any
    try {
      parsed = JSON.parse(astJson)
      // Wrap bare entryLogic objects in an array so evaluateSetup can parse them
      if (parsed && !Array.isArray(parsed)) {
        if (parsed.and || parsed.or || parsed.indicator) {
          parsed = [
            { strategyName: 'Custom Strategy', entryLogic: parsed },
          ]
        } else {
          parsed = [
            parsed,
          ]
        }
      }
    } catch (_e) {
      alert('Invalid JSON AST')
      return
    }

    const WARMUP_PERIOD = 200
    const BACKTEST_DAYS = 504 // 2 years max (504 trading days)
    const TOTAL_DAYS = WARMUP_PERIOD + BACKTEST_DAYS
    let isMounted = true

    // Reset timeframe controls — indices from a previous run are meaningless
    curvePointsRef.current = []
    tradesRef.current = []
    setView(null)
    setDataLen(0)
    setActivePreset(null)

    const runStreamedBackend = async (): Promise<boolean> => {
      let res: Response
      try {
        res = await fetch('/api/v1/backtest/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ast: Array.isArray(parsed) ? parsed[0] : parsed,
            years: 3,
            aiAccuracy: 0.65,
          }),
        })
      } catch {
        return false
      }
      if (!res.ok || !res.body) return false

      curvePointsRef.current = []
      tradesRef.current = []
      provisionalStampRef.current = '[LOOKAHEAD_CEILING | streaming…]'
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let completed = false

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          if (!line.trim()) continue
          let rawMsg: unknown
          try {
            rawMsg = JSON.parse(line)
          } catch {
            continue
          }
          const parsedMsg = StreamMessageSchema.safeParse(rawMsg)
          if (!parsedMsg.success) continue
          const msg: StreamMessage = parsedMsg.data
          if (msg.type === 'meta') {
            provisionalStampRef.current = msg.provisionalStamp
          } else if (msg.type === 'quarter') {
            if (!isMounted) return false
            appendEnginePoints(msg.points)
          } else if (msg.type === 'done') {
            if (!isMounted) return false
            finalizeEngineChart(msg.metrics.evidenceStamp || msg.evidence.stamp, msg.trades)
            if (onMetrics) {
              onMetrics({
                ...msg.metrics,
                remainingDailyExecutions: msg.remainingDailyExecutions,
                evidence: msg.evidence,
              })
            }
            completed = true
          } else if (msg.type === 'error') {
            console.error('[BACKTEST-STREAM] engine error:', msg.message)
            return false
          }
        }
        if (completed) break
      }
      return completed
    }

    const runLegacyBackend = async (): Promise<boolean> => {
      try {
        const apiRes = await fetch('/api/v1/backtest/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ast: Array.isArray(parsed) ? parsed[0] : parsed,
            years: 3,
            aiAccuracy: 0.65,
          }),
        })
        if (!isMounted) return true
        if (!apiRes.ok) return false
        const apiData = await apiRes.json()
        if (!apiData.success || !apiData.result) return false
        const res = apiData.result

        curvePointsRef.current = []
        tradesRef.current = []
        const stamp = res.evidenceStamp ?? res.evidence?.stamp ?? '[HONEST]'
        const curve = ((res.equityCurve || []) as EngineChartPoint[])
        const trades = ((res.trades || []) as StreamTrade[])
        buildEngineChart(stamp)
        appendEnginePoints(curve.map((c) => ({ ...c, iwm: 0 })))
        finalizeEngineChart(stamp, trades)

        if (onMetrics) {
          onMetrics({
            initialBalance: res.initialBalance,
            finalBalance: res.finalBalance,
            totalReturnPercent: res.totalReturnPercent,
            benchmarkSpyReturnPercent: res.benchmarkSpyReturnPercent,
            winRate: res.winRate,
            totalTrades: res.totalTrades,
            sharpeRatio: res.sharpeRatio,
            maxDrawdownPercent: res.maxDrawdownPercent,
            remainingDailyExecutions: apiData.remainingDailyExecutions,
            evidenceTier: res.evidenceTier ?? res.evidence?.evidenceTier ?? 'HONEST',
            evidenceStamp: res.evidenceStamp ?? res.evidence?.stamp ?? '[HONEST]',
            evidence: res.evidence,
          })
        }
        return true
      } catch {
        // Fall back to client simulation if backend endpoint fails or is rate limited
        return false
      }
    }

    async function loadData() {
      try {
        // 1. Preferred: NDJSON quarter-by-quarter streaming from the backend
        //    PortfolioBacktestEngine (first paint after ~1 quarter).
        if (await runStreamedBackend()) return
        if (!isMounted) return

        // 2. Fallback: single-shot backend engine (rate limited / stream failed)
        if (await runLegacyBackend()) return
        if (!isMounted) return

        let flatData = cachedFlatData
        let assets = cachedAssets

        if (!flatData || !assets) {
          if (!fetchPromise) {
            fetchPromise = (async () => {
              const symbols = [
                'SPY',
                'QQQ',
                'IWM',
                'TLT',
                'AAPL',
                'MSFT',
                'NVDA',
                'GOOGL',
                'AMZN',
                'META',
                'TSLA',
                'PLTR',
                'DE',
                'ZIM',
                'POWL',
                'NTR',
                'CF',
                'MOS',
                'JPM',
                'V',
                'PG',
                'AMD',
                'ORCL',
                'CRWD',
                'SOFI',
              ]
              // biome-ignore lint/suspicious/noExplicitAny: legacy `any` (migrated from eslint-disable) — typed cleanup pending
              let resData: any = { success: false }
              try {
                const res = await fetch(`/public-api/proxy/market/historical?symbols=${symbols.join(',')}&days=${TOTAL_DAYS}`)
                if (res.ok) {
                  resData = await res.json()
                }
              } catch {
                resData = { success: false }
              }

              const hasData = resData?.success && resData?.data && Object.keys(resData.data).length > 0
              // biome-ignore lint/suspicious/noExplicitAny: legacy `any` (migrated from eslint-disable) — typed cleanup pending
              const candlesMap: Record<string, any[]> = hasData ? resData.data : {}

              if (!hasData) {
                const startDate = new Date()
                startDate.setDate(startDate.getDate() - TOTAL_DAYS)
                
                symbols.forEach((sym, sIdx) => {
                  const basePrice = 50 + (sIdx * 15) % 250
                  // biome-ignore lint/suspicious/noExplicitAny: legacy `any` (migrated from eslint-disable) — typed cleanup pending
                  const candles: any[] = []
                  let curPrice = basePrice

                  for (let d = 0; d < TOTAL_DAYS; d++) {
                    const dt = new Date(startDate)
                    dt.setDate(dt.getDate() + d)
                    const dateStr = dt.toISOString().split('T')[0]
                    
                    const trend = Math.sin(d / 120) * 0.008 + (Math.random() - 0.48) * 0.02
                    curPrice = Math.max(10, curPrice * (1 + trend))
                    const high = curPrice * (1 + Math.random() * 0.015)
                    const low = curPrice * (1 - Math.random() * 0.015)
                    const volume = Math.round(500000 + Math.random() * 2000000)

                    candles.push({
                      close: Math.round(curPrice * 100) / 100,
                      high: Math.round(high * 100) / 100,
                      low: Math.round(low * 100) / 100,
                      volume,
                      date: dateStr,
                    })
                  }
                  candlesMap[sym] = candles
                })
              }

              assets = symbols.map((symbol) => {
                const rawCandles = candlesMap[symbol] || []
                const sorted = [
                  ...rawCandles,
                ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
                const data: ChartDataPoint[] = sorted.map((c: { close: number; high: number; low: number; volume: number; date: string }, i: number) => {
                  const price = c.close
                  const getSma = (period: number) => {
                    if (i < period - 1) return price
                    let sum = 0
                    for(let j = 0; j < period; j++) sum += sorted[i - j].close
                    return sum / period
                  }
                  
                  let atr = price * 0.015
                  if (i > 0) {
                    const prev = sorted[i - 1].close
                    atr = Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev))
                  }
                  const getSmaVolume = (period: number) => {
                    if (i < period - 1) return c.volume || 1
                    let sum = 0
                    for(let j = 0; j < period; j++) sum += sorted[i - j].volume || 1
                    return sum / period
                  }
                  
                  // AI Simulation - 65% Accuracy Look-ahead (matches engine default)
                  let finalScore: number
                  const AI_ACCURACY = 0.65
                  const futureIdx = Math.min(i + 10, sorted.length - 1)
                  const futurePrice = sorted[futureIdx]?.close || price
                  const return10d = (futurePrice - price) / price
                  
                  let trueScore = 5.5 + (return10d * 45)
                  if (trueScore > 10) trueScore = 10
                  if (trueScore < 1) trueScore = 1
                  
                  const edge = Math.max(0, (AI_ACCURACY - 0.5) * 2)
                  const randomScore = Math.random() * 9 + 1
                  finalScore = (trueScore * edge) + (randomScore * (1 - edge))
                  if (finalScore > 10) finalScore = 10
                  if (finalScore < 1) finalScore = 1

                  return {
                    day: i,
                    date: c.date,
                    currentPrice: price,
                    volume: c.volume || 1,
                    smaVolume20: getSmaVolume(20),
                    atr,
                    sma8: getSma(8),
                    sma10: getSma(10),
                    sma20: getSma(20),
                    sma21: getSma(21),
                    ema8: getSma(8),
                    ema21: getSma(21),
                    sma50: getSma(50),
                    sma200: getSma(200),
                    rsi: 50,
                    relativeStrength: 1.0,
                    newsScore: finalScore,
                    insiderScore: finalScore,
                    winRate: 0.65,
                    macroNarrativeHype: finalScore >= 5.0 ? 5.0 : 2.0,
                    macro: {
                      global_liquidity: { trend: finalScore >= 5.0 ? GlobalLiquidityTrend.expanding : GlobalLiquidityTrend.shrinking },
                      vix: Math.max(11, Math.min(38, Math.round((atr / price) * 100 * 4 + (getSma(20) > getSma(50) ? 12 : 20)))),
                      putCallRatio: getSma(20) > getSma(50) ? 0.85 : 1.2,
                    },
                    stock: { macro_exposure: { type: finalScore >= 5.0 ? MacroExposureType.beneficiary : MacroExposureType.atRisk, hype_velocity: finalScore >= 5.0 ? 6 : 2 } },
                    marketRegime: { isSafe: getSma(20) > getSma(50) },
                    maxRisk: 1000,
                  }
                })
                return {
                  name: symbol, data, inPosition: false, highest: 0, stop: 0, dataMap: new Map<string, ChartDataPoint>(),
                }
              })

              flatData = []
              assets.forEach(asset => {
                // biome-ignore lint/suspicious/noExplicitAny: legacy `any` (migrated from eslint-disable) — typed cleanup pending
                asset.data.forEach((dp: any) => {
                  dp.symbol = asset.name
                  flatData!.push(dp)
                })
              })
              
              cachedFlatData = flatData
              cachedAssets = assets
            })()
          }
          await fetchPromise
          flatData = cachedFlatData
          assets = cachedAssets
        }

        if (!flatData || !assets) return
        
        // Filter out assets that returned no data
        assets = assets.filter(a => a.data && a.data.length > 0)

        // Reset asset state before running backtest
        assets.forEach(a => {
          a.inPosition = false
          a.highest = 0
          a.stop = 0
        })

        // Chunk flatData to prevent large payload connection resets
        const chunkSize = 2000
        // biome-ignore lint/suspicious/noExplicitAny: legacy `any` (migrated from eslint-disable) — typed cleanup pending
        const backendSignals: any[] = []
        
        const ETF_SYMBOLS = [
          'SPY',
          'QQQ',
          'IWM',
          'TLT',
          'GLD',
          'SGOV',
          'VIXY',
        ]

        for (let i = 0; i < flatData.length; i += chunkSize) {
          const chunk = flatData.slice(i, i + chunkSize)
          try {
            const simRes = await fetch('/public-api/api/strategies/simulate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                ast: Array.isArray(parsed) ? parsed[0] : parsed,
                marketDataArray: chunk,
              }),
            })
            if (!isMounted) return
            if (simRes.ok) {
              const simData = await simRes.json()
              if (simData.signals && simData.signals.length > 0) {
                // biome-ignore lint/suspicious/noExplicitAny: legacy `any` (migrated from eslint-disable) — typed cleanup pending
                const equitySignals = simData.signals.filter((s: any) => !ETF_SYMBOLS.includes(s.symbol || ''))
                backendSignals.push(...equitySignals)
              }
            }
          } catch {
            // Ignore backend fetch error
          }
        }

        const MACRO_ETFS = new Set([
          'SPY',
          'QQQ',
          'IWM',
          'TLT',
        ])
        const signalMap = new Map<string, number>()
        // biome-ignore lint/suspicious/noExplicitAny: legacy `any` (migrated from eslint-disable) — typed cleanup pending
        backendSignals.forEach((sig: any) => {
          // sig has symbol and day from our injected properties
          if (sig.symbol && sig.day !== undefined) {
            signalMap.set(`${sig.symbol}_${sig.day}`, Number(sig.score ?? 5.0))
          }
        })

        // 1. Collect and sort all unique dates
        const allDatesSet = new Set<string>()
        assets.forEach(a => {
          // biome-ignore lint/suspicious/noExplicitAny: legacy `any` (migrated from eslint-disable) — typed cleanup pending
          a.data.forEach((d: any) => allDatesSet.add(d.date))
        })
        const allDates = Array.from(allDatesSet).sort((a, b) => new Date(a).getTime() - new Date(b).getTime())

        // 2. Build map for O(1) lookup
        assets.forEach(a => {
          a.dataMap = new Map()
          a.data.forEach((d: ChartDataPoint) => a.dataMap.set(d.date, d))
        })

        // biome-ignore lint/suspicious/noExplicitAny: legacy `any` (migrated from eslint-disable) — typed cleanup pending
        const portfolioHistory: any[] = []
        let totalEquity = 1000000
        let availableCash = 1000000
        let benchmarkEquity = 1000000
        const MAX_POSITIONS = 20
        const TRANSACTION_COST = 0.0005 // 5 bps

        // Track active positions
        const positions = new Map<string, { shares: number; highest: number; stop: number; entryPrice: number }>()
        // Track pending buys generated today to be executed tomorrow (sorted by AST setup score)
        let pendingBuys: Array<{ symbol: string; score: number }> = []
        
        // biome-ignore lint/suspicious/noExplicitAny: legacy `any` (migrated from eslint-disable) — typed cleanup pending
        const prevDpMap = new Map<string, any>()

        // Start backtest simulation from Day 20 so technical indicators are populated and strategy executes trades immediately
        const startDay = Math.min(20, Math.max(0, allDates.length - 1))
        for (let day = startDay; day < allDates.length; day++) {
          const currentDate = allDates[day] as string
          
          let dailyBenchmarkReturn = 0
          let benchmarkAssetsCount = 0
          const dayAllocations: number[] = Array(57).fill(0) as number[]
          
          // Collect fired signals for today
          const firedSignals: Array<{ symbol: string; currentPrice: number; sma50: number; sma200: number; newsScore: number; insiderScore: number }> = []

          // Step 1: Execute pending buys from yesterday (T+1 Entry, ordered by highest AST setup score)
          for (const candidate of pendingBuys) {
            if (positions.has(candidate.symbol)) continue
            if (positions.size >= MAX_POSITIONS) break

            const asset = assets.find(a => a.name === candidate.symbol)
            if (!asset) continue
            const dp = asset.dataMap.get(currentDate)
            if (!dp) continue

            // Dynamic ATR Account Risk Position Sizing (sourced from AST rules with fallback defaults):
            const astStrategy = Array.isArray(parsed) ? parsed[0] : parsed
            const stopMultiplier = astStrategy?.riskManagement?.stopLossAtrMultiplier ?? 2.5
            const rawRisk = astStrategy?.positionSizing?.overrideRiskPerTrade ?? astStrategy?.riskManagement?.overrideRiskPerTrade ?? 0.02
            const riskPercent = rawRisk > 1 ? rawRisk / 100 : rawRisk
            const maxAllocPercent = (astStrategy?.positionSizing?.maxPortfolioAllocationPercent ?? 10) / 100

            const stopDistance = dp.atr * stopMultiplier
            const stopPercent = Math.max(0.01, stopDistance / dp.currentPrice)
            const riskAmount = totalEquity * riskPercent
            const maxAllocation = totalEquity * maxAllocPercent
            const targetSize = Math.min(riskAmount / stopPercent, maxAllocation)

            const cost = targetSize * (1 + TRANSACTION_COST)
            if (availableCash >= cost) {
              const shares = targetSize / dp.currentPrice
              availableCash -= cost
              positions.set(asset.name, {
                shares,
                entryPrice: dp.currentPrice,
                highest: dp.currentPrice,
                stop: dp.currentPrice - stopDistance,
              })
            }
          }
          pendingBuys = []
          
          // Step 2: Manage existing positions & record new signals
          const todayNewSignals: Array<{ symbol: string; score: number }> = []

          const astStrategy = Array.isArray(parsed) ? parsed[0] : parsed
          const rotationRules = astStrategy?.rotationRules
          const isDefensiveRotationActive = astStrategy?.enableDefensiveRotation !== false && enableDefensiveRotation !== false
          const minCandidateScore = rotationRules?.minCandidateScore ?? 2.0
          const protectWinnerProfitPercent = rotationRules?.protectWinnerProfitPercent ?? 5.0

          assets.forEach((asset, idx) => {
            const dp = asset.dataMap.get(currentDate)
            if (!dp) return

            const prevDp = prevDpMap.get(asset.name) || dp
            const dailyRet = (dp.currentPrice - prevDp.currentPrice) / prevDp.currentPrice
            
            dailyBenchmarkReturn += dailyRet
            benchmarkAssetsCount++
            
            if (positions.has(asset.name)) {
              const pos = positions.get(asset.name)!
              
              // Update highest price for trailing stop (3.5x ATR)
              if (dp.currentPrice > pos.highest) {
                pos.highest = dp.currentPrice
                pos.stop = pos.highest - (dp.atr * 3.5)
              }
              
              // Protect winning positions > protectWinnerProfitPercent from panic defensive exit (stop loss still applies)
              const profitPercent = ((dp.currentPrice - pos.entryPrice) / pos.entryPrice) * 100
              const isWinnerProtected = profitPercent >= protectWinnerProfitPercent
              const isStopHit = dp.currentPrice < pos.stop
              const isDefensiveExit = isDefensiveRotationActive && dp.marketRegime?.isSafe === false && !isWinnerProtected

              // Check stop loss or defensive rotation exit
              if (isStopHit || isDefensiveExit) {
                // Exit position at today's close
                const sellValue = pos.shares * dp.currentPrice
                const netValue = sellValue * (1 - TRANSACTION_COST)
                availableCash += netValue
                positions.delete(asset.name)
              } else {
                // Still in position, record raw value for allocation tracking
                dayAllocations[idx] = pos.shares * dp.currentPrice
              }
            }
            
            // Check for NEW signals to buy tomorrow (Signal generated at T, entered at T+1)
            // Exclude Index/Macro ETFs (SPY, QQQ, IWM, TLT) and require minCandidateScore from AST rotation rules
            const setupScore = signalMap.get(`${asset.name}_${dp.day}`)
            if (
              setupScore !== undefined &&
              setupScore >= minCandidateScore &&
              !MACRO_ETFS.has(asset.name) &&
              !positions.has(asset.name) &&
              (!isDefensiveRotationActive || dp.marketRegime?.isSafe !== false)
            ) {
              todayNewSignals.push({ symbol: asset.name, score: setupScore })
              firedSignals.push({
                symbol: asset.name,
                currentPrice: Math.round(dp.currentPrice * 100) / 100,
                sma50: Math.round(dp.sma50 * 100) / 100,
                sma200: Math.round(dp.sma200 * 100) / 100,
                newsScore: Math.round(dp.newsScore * 10) / 10,
                insiderScore: Math.round(dp.insiderScore * 10) / 10,
              })
            }

            prevDpMap.set(asset.name, dp)
          })

          // Sort today's candidate signals by AST setup score descending (highest quality setups get priority)
          todayNewSignals.sort((a, b) => b.score - a.score)
          pendingBuys = todayNewSignals

          if (benchmarkAssetsCount > 0) {
            dailyBenchmarkReturn /= benchmarkAssetsCount
          }
          benchmarkEquity = benchmarkEquity * (1 + dailyBenchmarkReturn)

          // Step 3: Calculate total equity at end of day
          let currentPositionsValue = 0
          positions.forEach((pos, assetName) => {
            const dp = assets!.find(a => a.name === assetName)?.dataMap.get(currentDate)
            if (dp) {
              currentPositionsValue += pos.shares * dp.currentPrice
            }
          })
          
          totalEquity = availableCash + currentPositionsValue

          // Normalize allocations to percentages
          for (let i = 0; i < dayAllocations.length; i++) {
            dayAllocations[i] = totalEquity > 0 ? ((dayAllocations[i] || 0) / totalEquity) * 100 : 0
          }

          portfolioHistory.push({
            day,
            equity: totalEquity,
            benchmark: benchmarkEquity,
            allocations: dayAllocations,
            firedSignals,
          })
        }
        
        let maxDrawdown = 0
        let peakEquity = 1000000
        let sumReturns = 0
        let sumSquaredReturns = 0
        let numDays = 0

        for (let i = 1; i < portfolioHistory.length; i++) {
          const prev = portfolioHistory[i - 1].equity
          const curr = portfolioHistory[i].equity
          if (curr > peakEquity) peakEquity = curr
          const drawdown = (peakEquity - curr) / peakEquity
          if (drawdown > maxDrawdown) maxDrawdown = drawdown

          const dailyRet = (curr - prev) / prev
          sumReturns += dailyRet
          sumSquaredReturns += dailyRet * dailyRet
          numDays++
        }

        let sharpeRatio = 0
        if (numDays > 0) {
          const avgReturn = sumReturns / numDays
          const variance = (sumSquaredReturns / numDays) - (avgReturn * avgReturn)
          const dailyVolatility = Math.sqrt(Math.max(0, variance))
          const riskFreeRateAnnual = 0.04
          const riskFreeRateDaily = Math.pow(1 + riskFreeRateAnnual, 1 / 252) - 1
          if (dailyVolatility > 0) {
            sharpeRatio = ((avgReturn - riskFreeRateDaily) / dailyVolatility) * Math.sqrt(252)
          }
        }
        
        const finalEquity = portfolioHistory[portfolioHistory.length - 1]?.equity || 1000000
        const totalReturn = ((finalEquity - 1000000) / 1000000) * 100

        if (onMetrics) {
          onMetrics({
            totalReturn,
            sharpeRatio,
            maxDrawdown: maxDrawdown * 100,
            finalEquity,
            evidenceTier: 'LOOKAHEAD_CEILING',
            evidenceStamp: '[LOOKAHEAD_CEILING | client-side fallback @65% AI | prefer API engine]',
          })
        }

        // Render equity chart
        if (equityInstance.current) equityInstance.current.destroy()

        if (equityChartRef.current) {
          const ctx = equityChartRef.current.getContext('2d')
          let gradient = undefined
          if (ctx) {
            gradient = ctx.createLinearGradient(
              0, 0, 0, 400,
            )
            gradient.addColorStop(0, 'rgba(34, 197, 94, 0.4)') // green-500
            gradient.addColorStop(1, 'rgba(34, 197, 94, 0.0)')
          }

          const pointRadii = portfolioHistory.map(d => (d.firedSignals && d.firedSignals.length > 0 ? 5 : 0))
          const pointColors = portfolioHistory.map(d => (d.firedSignals && d.firedSignals.length > 0 ? '#eab308' : '#22c55e'))
          const pointHoverRadii = portfolioHistory.map(d => (d.firedSignals && d.firedSignals.length > 0 ? 8 : 4))

          equityInstance.current = new Chart(equityChartRef.current, {
            type: 'line',
            data: {
              labels: portfolioHistory.map((_d, idx) => `Day ${idx + 1}`),
              datasets: [
                {
                  label: 'Portfolio Equity',
                  data: portfolioHistory.map(d => d.equity),
                  borderColor: '#22c55e',
                  backgroundColor: gradient || 'rgba(34, 197, 94, 0.2)',
                  borderWidth: 2,
                  pointRadius: pointRadii,
                  pointBackgroundColor: pointColors,
                  pointBorderColor: '#000000',
                  pointBorderWidth: 1.5,
                  pointHoverRadius: pointHoverRadii,
                  tension: 0.4,
                  fill: true,
                },
                {
                  label: 'Benchmark (Equal Weight)',
                  data: portfolioHistory.map(d => d.benchmark),
                  borderColor: 'rgba(255,255,255,0.2)',
                  borderWidth: 2,
                  pointRadius: 0,
                  borderDash: [
                    5,
                    5,
                  ],
                  tension: 0.4,
                  fill: false,
                },
              ],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              interaction: { mode: 'index', intersect: false },
              plugins: {
                zoom: {
                  zoom: {
                    wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x', onZoomComplete: () => syncViewFromChart(), 
                  },
                  pan: { enabled: true, mode: 'x', onPanComplete: () => syncViewFromChart() },
                  limits: { x: { min: 'original', max: 'original', minRange: MIN_WINDOW_POINTS } },
                },
                tooltip: {
                  callbacks: {
                    label: (context) => `${context.dataset.label}: $${Number(context.raw).toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
                    afterBody: (tooltipItems) => {
                      const dataIdx = tooltipItems[0]?.dataIndex
                      if (dataIdx === undefined) return []
                      const dayItem = portfolioHistory[dataIdx]
                      if (!dayItem || !dayItem.firedSignals || dayItem.firedSignals.length === 0) return []

                      const lines: string[] = [
                        '\n🚀 FIRED SIGNALS:',
                      ]
                      dayItem.firedSignals.forEach((sig: { symbol: string; currentPrice: number; sma50: number; sma200: number; newsScore: number; insiderScore: number }) => {
                        lines.push(`• ${sig.symbol}: Price $${sig.currentPrice} | SMA50 $${sig.sma50} | SMA200 $${sig.sma200} | News ${sig.newsScore}/10 | Insider ${sig.insiderScore}/10`)
                      })
                      return lines
                    },
                  },
                },
              },
              scales: {
                y: { grid: { color: 'rgba(255,255,255,0.05)' } },
                x: { grid: { display: false } },
              },
            },
          })

          // Populate the shared timeframe-control refs (fallback labels are
          // "Day N" — presets use length fractions, not date math)
          curvePointsRef.current = portfolioHistory.map((h, idx) => ({
            date: `Day ${idx + 1}`,
            balance: h.equity,
            spy: h.benchmark,
          }))
          setDataLen(curvePointsRef.current.length)
          setView({ from: 0, to: curvePointsRef.current.length - 1 })
        }
    
      } catch (err) {
        console.error('Error running backtest:', err)
      }
    }

    loadData()

    return () => {
      isMounted = false
      if (equityInstance.current) equityInstance.current.destroy()
    }
  }, [
    runTrigger,
    astJson,
    enableDefensiveRotation,
  ])

  return (
    <div className="flex flex-col w-full h-full gap-2">
      <div className="bg-surface-sink/80 border border-primary/20 rounded-lg p-2.5 flex items-center justify-between text-xs font-mono">
        <div className="flex items-center gap-2 text-foreground/80">
          <span className="text-primary text-sm">ℹ️</span>
          <span><strong>Model Assumption:</strong> Forward-looking AI sensitivity simulation at <strong>65% Gemini classification accuracy</strong> (LOOKAHEAD_CEILING). Conditional upper bound — not realised strategy performance.</span>
        </div>
        <span className="text-micro font-bold text-warning uppercase tracking-wider shrink-0 ml-4">65% AI Ceiling</span>
      </div>
      <div className="flex-1 relative min-h-0">
        <canvas ref={equityChartRef}></canvas>
      </div>
      {view && dataLen > 1 && (
        <div data-testid="backtest-timeframe-controls" className="bg-surface-sink/80 border border-border/20 rounded-lg p-3 flex flex-col gap-2 shrink-0">
          <div className="flex items-center justify-between gap-4 text-micro font-mono">
            <span className="text-foreground/70 truncate" data-testid="backtest-window-caption">
              Showing <span className="text-foreground font-bold">{windowStats?.fromDate}</span> → <span className="text-foreground font-bold">{windowStats?.toDate}</span>
              {!windowStats?.isFull && windowStats && (
                <span className={windowStats.windowReturnPct >= 0 ? 'text-up font-bold' : 'text-down font-bold'}>
                  {' '}· window {windowStats.windowReturnPct >= 0 ? '+' : ''}{windowStats.windowReturnPct.toFixed(2)}%
                </span>
              )}
            </span>
            <span className="text-foreground/40 uppercase tracking-wider shrink-0">scroll = zoom · drag = pan</span>
          </div>
          <div className="flex gap-1 flex-wrap">
            {TIMEFRAME_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                data-testid={`backtest-preset-${preset.label.toLowerCase()}`}
                onClick={() => applyPreset(preset)}
                className={`px-3 py-1 rounded-md text-micro font-bold uppercase tracking-wider transition-all active:scale-95 ${
                  activePreset === preset.label
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-surface-base border border-border/20 text-foreground/60 hover:text-foreground hover:border-border/40'
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <DualRangeSlider
            from={view.from}
            to={view.to}
            max={dataLen - 1}
            onFrom={(v) => applyTimeframe(v, view.to)}
            onTo={(v) => applyTimeframe(view.from, v)}
          />
        </div>
      )}
    </div>
  )
}
