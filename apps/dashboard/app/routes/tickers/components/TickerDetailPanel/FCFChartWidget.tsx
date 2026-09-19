import type { FcfDataPoint } from '@quantour/shared-algo/src/fcf/types'
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  ScriptableContext,
  Title,
  Tooltip,
} from 'chart.js'
import {
  useEffect,
  useMemo,
  useRef,
  useState, 
} from 'react'

Chart.register(
  LineController,
  BarController,
  LineElement,
  BarElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Title,
  Tooltip,
  Legend,
)

export function formatFcfPerShare(val: number): string {
  if (val === 0) return '0.00'
  const abs = Math.abs(val)
  const rounded2 = Number(val.toFixed(2))
  const rounded3 = Number(val.toFixed(3))
  if (rounded2 !== rounded3 || abs < 0.01) {
    return val.toFixed(3)
  }
  return val.toFixed(2)
}

export function FCFChartWidget({ 
  fcfQuarterly, 
  fcfAnnual, 
  currentPrice,
  analystTargets,
  growthDriverProfile,
}: { 
  fcfQuarterly: FcfDataPoint[]
  fcfAnnual: FcfDataPoint[] 
  currentPrice?: number
  analystTargets?: {
    targetMean?: number
    targetHigh?: number
    targetLow?: number
    targetMedian?: number
  } | null
  growthDriverProfile?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const chartRef = useRef<Chart | null>(null)

  const [
    viewType,
    setViewType,
  ] = useState<'quarterly' | 'annual'>(() => {
    if (fcfQuarterly && fcfQuarterly.length > 0) return 'quarterly'
    if (fcfAnnual && fcfAnnual.length > 0) return 'annual'
    return 'quarterly'
  })

  const [
    fairValueMultiple,
    setFairValueMultiple,
  ] = useState<number | null>(null)

  // Timeframe limit state
  const [
    limitPeriods,
    setLimitPeriods,
  ] = useState<number>(0)

  // Reset limitPeriods on viewType change
  useEffect(() => {
    setLimitPeriods(0)
  }, [
    viewType,
  ])

  // Dataset visibility states
  const [
    showPrice,
    setShowPrice,
  ] = useState(true)
  const [
    showFairValue,
    setShowFairValue,
  ] = useState(true)
  const [
    showFcf,
    setShowFcf,
  ] = useState(true)

  const [
    expectedPriceSource,
    setExpectedPriceSource,
  ] = useState<'current' | 'mean' | 'high' | 'low'>('current')

  const activeData = useMemo(() => {
    return viewType === 'quarterly' ? fcfQuarterly : fcfAnnual
  }, [
    viewType,
    fcfQuarterly,
    fcfAnnual,
  ])

  const summary = useMemo(() => {
    if (!activeData || activeData.length === 0) return null

    const latest = activeData[activeData.length - 1]!
    const rawRatios = activeData
      .map(d => viewType === 'quarterly' ? d.ratio / 4 : d.ratio)
      .filter(r => r > 0)
      .sort((a, b) => a - b)

    // Winsorize ratios (clamp between 5x and 100x) to prevent single-outlier distortion
    const validMultiples = rawRatios.map(r => Math.min(100, Math.max(5, r)))

    let averageMultiple = 15
    if (validMultiples.length > 0) {
      // Outlier trimming: Remove 1 lowest and 1 highest ratio if we have at least 3 points
      const trimmed = validMultiples.length >= 3 ? validMultiples.slice(1, validMultiples.length - 1) : validMultiples
      const sum = trimmed.reduce((acc, v) => acc + v, 0)
      averageMultiple = Math.round((sum / trimmed.length) * 10) / 10
    } else if (growthDriverProfile === 'INTELLECTUAL') {
      averageMultiple = 25
    } else if (growthDriverProfile === 'CAPITAL_INFRASTRUCTURE') {
      averageMultiple = 20
    }

    const latestRatio = viewType === 'quarterly' ? latest.ratio / 4 : latest.ratio
    const ratioDeltaPercent = averageMultiple > 0 && latestRatio > 0 ? (((latestRatio) - averageMultiple) / averageMultiple) * 100 : 0
    const isUndervalued = latestRatio > 0 && latestRatio < averageMultiple

    return {
      latestFcfPerShare: latest.fcfPerShare,
      latestPrice: latest.impliedPrice,
      latestMultiple: latest.ratio,
      averageMultiple,
      ratioDeltaPercent,
      isUndervalued,
      positiveQuarterCount: validMultiples.length,
      totalQuarterCount: activeData.length,
    }
  }, [
    activeData,
    viewType,
    growthDriverProfile,
  ])

  const resolvedExpectedPrice = useMemo(() => {
    if (expectedPriceSource === 'mean' && analystTargets?.targetMean) {
      return Number(analystTargets.targetMean)
    }
    if (expectedPriceSource === 'high' && analystTargets?.targetHigh) {
      return Number(analystTargets.targetHigh)
    }
    if (expectedPriceSource === 'low' && analystTargets?.targetLow) {
      return Number(analystTargets.targetLow)
    }
    return currentPrice !== undefined && currentPrice !== null ? currentPrice : (summary?.latestPrice || 0)
  }, [
    expectedPriceSource,
    analystTargets,
    currentPrice,
    summary,
  ])

  const hasMean = analystTargets?.targetMean !== undefined && analystTargets?.targetMean !== null && Number(analystTargets.targetMean) > 0
  const hasHigh = analystTargets?.targetHigh !== undefined && analystTargets?.targetHigh !== null && Number(analystTargets.targetHigh) > 0
  const hasLow = analystTargets?.targetLow !== undefined && analystTargets?.targetLow !== null && Number(analystTargets.targetLow) > 0
  const hasTargets = hasMean || hasHigh || hasLow


  const displayedData = useMemo(() => {
    if (limitPeriods > 0 && activeData.length > limitPeriods) {
      return activeData.slice(-limitPeriods)
    }
    return activeData
  }, [
    activeData,
    limitPeriods,
  ])

  useEffect(() => {
    if (!canvasRef.current || !displayedData || displayedData.length === 0) return

    if (chartRef.current) {
      chartRef.current.destroy()
    }

    const ctx = canvasRef.current.getContext('2d')
    if (!ctx) return

    const currentFairValueMultiple = fairValueMultiple !== null
      ? fairValueMultiple
      : (summary ? summary.averageMultiple : 15)

    const labels = displayedData.map(d => `${d.fiscalYear} (${d.period})`)
    const prices = displayedData.map(d => d.impliedPrice)
    const fcfs = displayedData.map(d => d.fcfPerShare)
    // Clamp fair price to non-negative so fair value line doesn't plunge below $0
    const fairPrices = displayedData.map(d => Math.max(0, d.fcfPerShare * currentFairValueMultiple))

    // Append "EXPECTED" data point
    labels.push('EXPECTED')
    const expectedPrice = resolvedExpectedPrice
    prices.push(expectedPrice)
    let requiredFcf = currentFairValueMultiple > 0 ? expectedPrice / currentFairValueMultiple : 0
    if (viewType === 'quarterly') requiredFcf /= 4
    fcfs.push(requiredFcf)
    fairPrices.push(expectedPrice)

    const lastPrice = displayedData[displayedData.length - 1]!.impliedPrice
    const priceChange = lastPrice > 0 ? ((expectedPrice - lastPrice) / lastPrice) * 100 : 0
    const lastFcf = displayedData[displayedData.length - 1]!.fcfPerShare
    const fcfGrowthNeeded = lastFcf > 0 ? ((requiredFcf - lastFcf) / lastFcf) * 100 : 0

    const datasets = []
    if (showPrice) {
      datasets.push({
        type: 'line' as const,
        label: 'Stock Price ($)',
        data: prices,
        borderColor: '#10B981',
        backgroundColor: '#10B981',
        borderWidth: 2.5,
        pointRadius: 4,
        pointHoverRadius: 6,
        yAxisID: 'yPrice',
      })
    }
    if (showFairValue) {
      datasets.push({
        type: 'line' as const,
        label: `Fair Value ($) @ ${currentFairValueMultiple}x`,
        data: fairPrices,
        borderColor: '#A855F7',
        backgroundColor: '#A855F7',
        borderWidth: 1.8,
        borderDash: [
          5,
          5,
        ],
        pointRadius: 0,
        pointHoverRadius: 4,
        yAxisID: 'yPrice',
      })
    }
    if (showFcf) {
      datasets.push({
        type: 'bar' as const,
        label: 'FCF Per Share ($)',
        data: fcfs,
        backgroundColor: (chartContext: ScriptableContext<'bar'>) => {
          const idx = chartContext.dataIndex
          if (idx === fcfs.length - 1) return 'rgba(168, 85, 247, 0.45)'
          const val = fcfs[idx] || 0
          return val >= 0 ? 'rgba(245, 158, 11, 0.45)' : 'rgba(239, 68, 68, 0.45)'
        },
        borderColor: (chartContext: ScriptableContext<'bar'>) => {
          return chartContext.dataIndex === fcfs.length - 1 ? '#A855F7' : '#F59E0B'
        },
        borderWidth: 1.5,
        borderRadius: 6,
        yAxisID: 'yFcf',
      })
    }

    chartRef.current = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets,
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false,
        },
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              color: '#9CA3AF',
              usePointStyle: true,
              font: {
                family: 'system-ui, -apple-system, sans-serif',
                size: 10,
                weight: 'bold',
              },
            },
          },
          tooltip: {
            backgroundColor: 'rgba(17, 24, 39, 0.95)',
            titleColor: '#fff',
            bodyColor: '#D1D5DB',
            borderColor: 'rgba(75, 85, 99, 0.4)',
            borderWidth: 1,
            padding: 12,
            boxPadding: 6,
            titleFont: { size: 12, weight: 'bold' },
            callbacks: {
              label: (ctx) => {
                const val = Number(ctx.raw)
                const isFcfDataset = ctx.dataset.label === 'FCF Per Share ($)'
                const formattedVal = isFcfDataset ? formatFcfPerShare(val) : val.toFixed(2)
                let label = `${ctx.dataset.label}: $${formattedVal}`
                if (ctx.label === 'EXPECTED' && isFcfDataset) {
                  label += ` (${fcfGrowthNeeded >= 0 ? '+' : ''}${fcfGrowthNeeded.toFixed(1)}% Growth Needed)`
                }
                if (ctx.label === 'EXPECTED' && ctx.dataset.label === 'Stock Price ($)') {
                  let sourceStr = 'Current Price'
                  if (expectedPriceSource === 'mean') sourceStr = 'Mean Target'
                  if (expectedPriceSource === 'high') sourceStr = 'High Target'
                  if (expectedPriceSource === 'low') sourceStr = 'Low Target'
                  label += ` (${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(1)}% vs Last Report, ${sourceStr})`
                }
                return label
              },
            },
          },
        },
        scales: {
          x: {
            grid: { color: 'rgba(75, 85, 99, 0.1)', display: false },
            ticks: {
              color: '#9CA3AF', maxRotation: 45, minRotation: 45, font: { size: 9 }, 
            },
          },
          yPrice: {
            type: 'linear',
            position: 'left',
            display: showPrice || showFairValue,
            beginAtZero: false,
            grid: { color: 'rgba(75, 85, 99, 0.1)' },
            ticks: {
              color: '#10B981',
              font: { weight: 'bold', size: 10 },
              callback: (val) => `$${val}`,
            },
          },
          yFcf: {
            type: 'linear',
            position: 'right',
            display: showFcf,
            grid: { display: false },
            ticks: {
              color: '#F59E0B',
              font: { weight: 'bold', size: 10 },
              callback: (val) => `$${val}`,
            },
          },
        },
      },
    })

    return () => {
      if (chartRef.current) {
        chartRef.current.destroy()
        chartRef.current = null
      }
    }
  }, [
    displayedData,
    fairValueMultiple,
    summary,
    showPrice,
    showFairValue,
    showFcf,
    resolvedExpectedPrice,
    expectedPriceSource,
  ])

  if (!activeData || activeData.length === 0) return null

  const currentMultiple = fairValueMultiple !== null ? fairValueMultiple : (summary ? Math.round(summary.averageMultiple) : 15)
  const latestPriceVal = resolvedExpectedPrice
  const requiredFcf = currentMultiple > 0 ? latestPriceVal / currentMultiple : 0
  const lastFcf = activeData[activeData.length - 1]!.fcfPerShare
  const growthNeeded = lastFcf > 0 ? ((requiredFcf - lastFcf) / lastFcf) * 100 : 0
  const lastPrice = activeData[activeData.length - 1]!.impliedPrice
  const priceChange = lastPrice > 0 ? ((latestPriceVal - lastPrice) / lastPrice) * 100 : 0
  const priceLabelText = expectedPriceSource === 'current' ? 'Price changed' : 'Target changed'

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2.5">
        <div className="flex justify-between items-center">
          <h4 className="text-micro font-black text-foreground/50 uppercase tracking-widest">FCF Divergence ({viewType})</h4>
 
          <div className="flex bg-surface-sink p-0.5 rounded-lg border border-surface-sink-border text-micro">
            <button
              onClick={() => setViewType('quarterly')}
              className={`px-2 py-0.5 font-black rounded-md uppercase tracking-tight transition-all cursor-pointer ${
                viewType === 'quarterly'
                  ? 'bg-surface-elevated text-on-surface-elevated text-primary shadow-sm'
                  : 'text-foreground/60 hover:text-primary'
              }`}
            >
              Quarterly
            </button>
            <button
              onClick={() => setViewType('annual')}
              className={`px-2 py-0.5 font-black rounded-md uppercase tracking-tight transition-all cursor-pointer ${
                viewType === 'annual'
                  ? 'bg-surface-elevated text-on-surface-elevated text-primary shadow-sm'
                  : 'text-foreground/60 hover:text-primary'
              }`}
            >
              Annual
            </button>
          </div>
        </div>

        <div className="flex flex-wrap justify-between items-center gap-2">
          {/* Timeframe Selector */}
          <div className="flex bg-surface-sink p-0.5 rounded-lg border border-surface-sink-border text-micro font-black uppercase">
            {viewType === 'annual' ? (
              <>
                <button
                  type="button"
                  onClick={() => setLimitPeriods(0)}
                  className={`px-1.5 py-0.5 rounded cursor-pointer transition-all ${limitPeriods === 0 ? 'bg-surface-elevated text-on-surface-elevated text-primary shadow-sm' : 'text-foreground/60 hover:text-primary'}`}
                >
                  All
                </button>
                <button
                  type="button"
                  onClick={() => setLimitPeriods(10)}
                  className={`px-1.5 py-0.5 rounded cursor-pointer transition-all ${limitPeriods === 10 ? 'bg-surface-elevated text-on-surface-elevated text-primary shadow-sm' : 'text-foreground/60 hover:text-primary'}`}
                >
                  10Y
                </button>
                <button
                  type="button"
                  onClick={() => setLimitPeriods(5)}
                  className={`px-1.5 py-0.5 rounded cursor-pointer transition-all ${limitPeriods === 5 ? 'bg-surface-elevated text-on-surface-elevated text-primary shadow-sm' : 'text-foreground/60 hover:text-primary'}`}
                >
                  5Y
                </button>
                <button
                  type="button"
                  onClick={() => setLimitPeriods(3)}
                  className={`px-1.5 py-0.5 rounded cursor-pointer transition-all ${limitPeriods === 3 ? 'bg-surface-elevated text-on-surface-elevated text-primary shadow-sm' : 'text-foreground/60 hover:text-primary'}`}
                >
                  3Y
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setLimitPeriods(0)}
                  className={`px-1.5 py-0.5 rounded cursor-pointer transition-all ${limitPeriods === 0 ? 'bg-surface-elevated text-on-surface-elevated text-primary shadow-sm' : 'text-foreground/60 hover:text-primary'}`}
                >
                  All
                </button>
                <button
                  type="button"
                  onClick={() => setLimitPeriods(12)}
                  className={`px-1.5 py-0.5 rounded cursor-pointer transition-all ${limitPeriods === 12 ? 'bg-surface-elevated text-on-surface-elevated text-primary shadow-sm' : 'text-foreground/60 hover:text-primary'}`}
                >
                  12Q
                </button>
                <button
                  type="button"
                  onClick={() => setLimitPeriods(8)}
                  className={`px-1.5 py-0.5 rounded cursor-pointer transition-all ${limitPeriods === 8 ? 'bg-surface-elevated text-on-surface-elevated text-primary shadow-sm' : 'text-foreground/60 hover:text-primary'}`}
                >
                  8Q
                </button>
                <button
                  type="button"
                  onClick={() => setLimitPeriods(4)}
                  className={`px-1.5 py-0.5 rounded cursor-pointer transition-all ${limitPeriods === 4 ? 'bg-surface-elevated text-on-surface-elevated text-primary shadow-sm' : 'text-foreground/60 hover:text-primary'}`}
                >
                  4Q
                </button>
              </>
            )}
          </div>

          {/* Dataset Toggles */}
          <div className="flex bg-surface-sink p-0.5 rounded-lg border border-surface-sink-border text-micro font-black uppercase">
            <button
              type="button"
              onClick={() => setShowPrice(!showPrice)}
              className={`px-1.5 py-0.5 rounded cursor-pointer transition-all flex items-center gap-0.5 ${showPrice ? 'bg-surface-elevated text-on-surface-elevated text-up shadow-sm' : 'text-foreground/60 hover:text-primary'}`}
            >
              <span className="w-1 h-1 rounded-full bg-[#10B981]" />
              Price
            </button>
            <button
              type="button"
              onClick={() => setShowFairValue(!showFairValue)}
              className={`px-1.5 py-0.5 rounded cursor-pointer transition-all flex items-center gap-0.5 ${showFairValue ? 'bg-surface-elevated text-on-surface-elevated text-special dark:text-special shadow-sm' : 'text-foreground/60 hover:text-primary'}`}
            >
              <span className="w-1 h-1 rounded-full bg-[#A855F7]" />
              Value
            </button>
            <button
              type="button"
              onClick={() => setShowFcf(!showFcf)}
              className={`px-1.5 py-0.5 rounded cursor-pointer transition-all flex items-center gap-0.5 ${showFcf ? 'bg-surface-elevated text-on-surface-elevated text-warning shadow-sm' : 'text-foreground/60 hover:text-primary'}`}
            >
              <span className="w-1 h-1 rounded-full bg-[#F59E0B]" />
              FCF
            </button>
          </div>
        </div>

        {hasTargets && (
          <div className="flex flex-wrap justify-between items-center gap-2 pt-2 border-t border-surface-sink-border/50">
            <span className="text-micro font-black text-foreground/50 uppercase tracking-wider">
              Expected Price Basis
            </span>
            <div className="flex bg-surface-sink p-0.5 rounded-lg border border-surface-sink-border text-micro font-black uppercase">
              <button
                type="button"
                onClick={() => setExpectedPriceSource('current')}
                className={`px-1.5 py-0.5 rounded cursor-pointer transition-all ${
                  expectedPriceSource === 'current'
                    ? 'bg-surface-elevated text-on-surface-elevated text-primary shadow-sm'
                    : 'text-foreground/60 hover:text-primary'
                }`}
              >
                Current (${(currentPrice !== undefined && currentPrice !== null ? currentPrice : (summary?.latestPrice || 0)).toFixed(2)})
              </button>
              {hasMean && (
                <button
                  type="button"
                  onClick={() => setExpectedPriceSource('mean')}
                  className={`px-1.5 py-0.5 rounded cursor-pointer transition-all ${
                    expectedPriceSource === 'mean'
                      ? 'bg-surface-elevated text-on-surface-elevated text-primary shadow-sm'
                      : 'text-foreground/60 hover:text-primary'
                  }`}
                >
                  Mean (${Number(analystTargets.targetMean).toFixed(2)})
                </button>
              )}
              {hasHigh && (
                <button
                  type="button"
                  onClick={() => setExpectedPriceSource('high')}
                  className={`px-1.5 py-0.5 rounded cursor-pointer transition-all ${
                    expectedPriceSource === 'high'
                      ? 'bg-surface-elevated text-on-surface-elevated text-primary shadow-sm'
                      : 'text-foreground/60 hover:text-primary'
                  }`}
                >
                  High (${Number(analystTargets.targetHigh).toFixed(2)})
                </button>
              )}
              {hasLow && (
                <button
                  type="button"
                  onClick={() => setExpectedPriceSource('low')}
                  className={`px-1.5 py-0.5 rounded cursor-pointer transition-all ${
                    expectedPriceSource === 'low'
                      ? 'bg-surface-elevated text-on-surface-elevated text-primary shadow-sm'
                      : 'text-foreground/60 hover:text-primary'
                  }`}
                >
                  Low (${Number(analystTargets.targetLow).toFixed(2)})
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="bg-surface-sink border border-surface-sink-border p-4 rounded-2xl relative overflow-hidden">
        <div className="h-[15.625rem] w-full">
          <canvas ref={canvasRef}></canvas>
        </div>

        {summary && (
          <div className="mt-4 pt-3 border-t border-surface-sink-border/80">
            <div className="flex flex-col gap-4">
 
              {/* Custom Multiple Slider */}
              <div className="flex justify-between items-center gap-4">
                <label className="text-micro font-black text-foreground/50 uppercase tracking-wider flex-shrink-0">
                  Custom P/FCF Multiple
                </label>
                <div className="flex items-center gap-3 w-full max-w-[12.5rem]">
                  <input
                    type="range"
                    min="5"
                    max="50"
                    step="1"
                    value={currentMultiple}
                    onChange={(e) => setFairValueMultiple(Number(e.target.value))}
                    className="w-full h-1.5 bg-surface-sink rounded-lg appearance-none cursor-pointer accent-purple-500"
                  />
                  <span className="text-xs font-black text-special dark:text-special w-8 text-right">
                    {currentMultiple}x
                  </span>
                </div>
              </div>

              {/* Required FCF Insight */}
              <div className="flex items-center justify-between bg-primary/5 border border-primary/10 rounded-lg p-3">
                <div className="flex flex-col gap-0.5">
                  <span className="text-micro font-black uppercase tracking-wider text-foreground/60">Required FCF Growth</span>
                  <span className="text-xs text-foreground/50">{priceLabelText} {priceChange.toFixed(1)}% vs last report</span>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <div className="text-lg font-black text-primary">
                    ${formatFcfPerShare(requiredFcf)}
                  </div>
                  <div className={`text-micro font-black px-1.5 py-0.5 rounded ${growthNeeded > 0 ? 'bg-primary/15 text-primary' : 'bg-up/15 text-up'}`}>
                    {growthNeeded > 0 ? '+' : ''}{growthNeeded.toFixed(1)}% Growth Needed
                  </div>
                </div>
              </div>

              {/* Reinvestment & Intensity History */}
              <div className="mt-4 pt-4 border-t border-surface-sink-border">
                <h5 className="text-micro font-black text-foreground/50 uppercase tracking-widest mb-3">Reinvestment & Intensity History</h5>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-micro">
                    <thead>
                      <tr className="border-b border-surface-elevated-border text-foreground/50 font-bold uppercase tracking-wider">
                        <th className="pb-1.5">Period</th>
                        <th className="pb-1.5 text-right">FCF/Share</th>
                        <th className="pb-1.5 text-right">FCF Change</th>
                        <th className="pb-1.5 text-right">R&D Intensity</th>
                        <th className="pb-1.5 text-right">Capex/D&A</th>
                        <th className="pb-1.5 text-center group relative cursor-help">
                          <span className="border-b border-dashed border-foreground/30">Scanner Status</span>
                          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden w-48 p-2 bg-surface-elevated text-foreground text-micro rounded shadow-lg group-hover:block z-10 whitespace-normal normal-case font-medium border border-surface-elevated-border text-left">
                            Indicates the maximum FCF drop the algorithm will tolerate before triggering a sell signal. Adjusted dynamically based on reinvestment intensity.
                          </div>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-surface-sink-border">
                      {activeData.slice().reverse().map((d, idx, arr) => {
                        const prior = arr[idx + 1]
                        let fcfChange = 'N/A'
                        let isNegativeInflection = false
                        let isDeterioration = false
                        let changePct = 0

                        if (prior) {
                          const f0 = prior.fcfPerShare
                          const f1 = d.fcfPerShare
                          if (f0 > 0) {
                            changePct = ((f1 - f0) / f0) * 100
                            fcfChange = `${changePct > 0 ? '+' : ''}${changePct.toFixed(1)}%`
                            if (f1 <= 0) {
                              isNegativeInflection = true
                            } else if (changePct < 0) {
                              isDeterioration = true
                            }
                          } else if (f0 <= 0 && f1 > 0) {
                            fcfChange = 'Inflection +'
                          }
                        }

                        const rdIntensity = d.revenue && d.revenue > 0 ? ((d.researchAndDevelopmentExpenses || 0) / d.revenue) * 100 : 0
                        const capexDa = d.depreciationAndAmortization && d.depreciationAndAmortization > 0 ? (d.capitalExpenditure || 0) / d.depreciationAndAmortization : 0
 
                        let badgeColor = 'bg-surface-base text-on-surface-base border border-surface-base-border'
                        let badgeText = 'Standard 15%'
                        let badgeTitle = 'Tolerates up to 15% FCF drawdown.'
                        let limitPct = 15

                        const p = growthDriverProfile?.toUpperCase()
                        if (p === 'INTELLECTUAL') {
                          if (rdIntensity >= 12) {
                            badgeColor = 'bg-up/10 text-up border border-up/10'
                            badgeText = 'Reinvesting (20%)'
                            badgeTitle = 'High R&D intensity grants leniency. Tolerates up to 20% FCF drawdown.'
                            limitPct = 20
                          } else {
                            badgeColor = 'bg-warning/10 text-warning border border-warning/10'
                            badgeText = 'Strict (10%)'
                            badgeTitle = 'Low R&D intensity triggers stricter limits. Tolerates up to 10% FCF drawdown.'
                            limitPct = 10
                          }
                        } else if (p === 'CAPITAL_INFRASTRUCTURE') {
                          const ocfStable = d.operatingCashFlow! > 0 && (!prior || d.operatingCashFlow! >= (prior.operatingCashFlow || 0) * 0.9)
                          if (capexDa >= 1.5 && ocfStable) {
                            badgeColor = 'bg-info/10 text-info border border-info/10'
                            badgeText = 'Expansion (25%)'
                            badgeTitle = 'High infrastructure expansion grants leniency. Tolerates up to 25% FCF drawdown.'
                            limitPct = 25
                          } else {
                            badgeColor = 'bg-warning/10 text-warning border border-warning/10'
                            badgeText = 'Strict (10%)'
                            badgeTitle = 'Low CapEx expansion triggers stricter limits. Tolerates up to 10% FCF drawdown.'
                            limitPct = 10
                          }
                        } else if (p === 'INVENTORY_LOGISTICS') {
                          badgeColor = 'bg-primary/10 text-primary border border-primary/10'
                          badgeText = 'Retail Cap (10%)'
                          badgeTitle = 'Retail/Logistics is capped at 10% drawdown tolerance due to tight margins.'
                          limitPct = 10
                        }

                        const isHalted = prior && prior.fcfPerShare > 0 && changePct < -limitPct

                        return (
                          <tr key={`${d.date}-${idx}`} className="hover:bg-surface-sink/30 transition-all">
                            <td className="py-2 font-bold text-foreground/90">{d.fiscalYear} ({d.period})</td>
                            <td className="py-2 text-right font-semibold">${formatFcfPerShare(d.fcfPerShare)}</td>
                            <td className="py-2 text-right">
                              {isNegativeInflection ? (
                                <span className="text-danger font-bold">Inflection 🚨</span>
                              ) : isHalted ? (
                                <span className="text-danger font-bold">Halted ({fcfChange}) 🚨</span>
                              ) : isDeterioration ? (
                                <span className="text-primary font-semibold">{fcfChange}</span>
                              ) : prior ? (
                                <span className="text-up font-semibold">{fcfChange}</span>
                              ) : (
                                <span className="text-foreground/50">-</span>
                              )}
                            </td>
                            <td className="py-2 text-right text-foreground/50">
                              {d.researchAndDevelopmentExpenses ? `${rdIntensity.toFixed(1)}%` : '-'}
                            </td>
                            <td className="py-2 text-right text-foreground/50">
                              {d.capitalExpenditure ? `${capexDa.toFixed(2)}x` : '-'}
                            </td>
                            <td className="py-2 text-center">
                              <span 
                                title={badgeTitle}
                                className={`px-2 py-0.5 rounded text-micro font-black uppercase tracking-wide cursor-help ${badgeColor}`}
                              >
                                {badgeText}
                              </span>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

            </div>
          </div>
        )}
      </div>
    </div>
  )
}
