import type { FcfDataPoint } from '@quantour/shared-algo/src/fcf/types'
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  type ChartDataset,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  ScatterController,
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
  ScatterController,
  LinearScale,
  CategoryScale,
  Title,
  Tooltip,
  Legend,
)

type MarketScenario = {
  id: string
  name: string
  description: string
  curve: number[]
}

export function ScenarioChartOverlay({
  ticker,
  fcfData,
  recentSignals,
  onClose,
}: {
  ticker: string
  fcfData: FcfDataPoint[]
  recentSignals: { id: number; action: string; createdAt: string; score: string }[]
  onClose: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const chartRef = useRef<Chart | null>(null)

  const [
    activeScenario,
    setActiveScenario,
  ] = useState<string>('none')

  const [
    scenariosData,
    setScenariosData,
  ] = useState<MarketScenario[]>([])

  useEffect(() => {
    fetch('/public-api/api/scenarios')
      .then((r) => r.json())
      .then((data) => {
        if (data.success && data.scenarios) {
          setScenariosData(data.scenarios)
        }
      })
      .catch((err) => console.error('Failed to fetch scenarios', err))
  }, [])

  const scenario = useMemo(() => scenariosData.find((s) => s.id === activeScenario), [
    activeScenario,
    scenariosData,
  ])

  const displayedData = useMemo(() => {
    if (!fcfData || fcfData.length === 0) return []
    return [
      ...fcfData,
    ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
  }, [
    fcfData,
  ])

  useEffect(() => {
    if (!canvasRef.current || displayedData.length === 0) return

    if (chartRef.current) {
      chartRef.current.destroy()
    }
    
    // Also destroy from global registry in case it wasn't caught by ref
    const existingChart = Chart.getChart(canvasRef.current)
    if (existingChart) {
      existingChart.destroy()
    }

    const ctx = canvasRef.current.getContext('2d')
    if (!ctx) return

    const labels = displayedData.map((d) => `${d.fiscalYear} ${d.period}`)
    const prices = displayedData.map((d) => d.impliedPrice)

    const datasets: ChartDataset[] = [
      {
        type: 'line' as const,
        label: 'Stock Price ($)',
        data: prices,
        borderColor: '#10B981',
        backgroundColor: '#10B981',
        borderWidth: 2.5,
        pointRadius: 4,
        pointHoverRadius: 6,
        yAxisID: 'yPrice',
      },
    ]

    // Overlay Signals if we can map them (for simplicity we'll just plot some mock points on the timeline if dates match)
    // A proper implementation would map signal dates to the nearest quarter
    const buySignals = prices.map(() => null) as (number | null)[]
    const sellSignals = prices.map(() => null) as (number | null)[]
    
    recentSignals?.forEach((signal) => {
      const sigDate = new Date(signal.createdAt).getTime()
      let closestIdx = 0
      let minDiff = Infinity
      displayedData.forEach((d, idx) => {
        const diff = Math.abs(new Date(d.date).getTime() - sigDate)
        if (diff < minDiff) {
          minDiff = diff
          closestIdx = idx
        }
      })
      if (signal.action === 'BUY') buySignals[closestIdx] = prices[closestIdx] ?? null
      if (signal.action === 'SELL') sellSignals[closestIdx] = prices[closestIdx] ?? null
    })

    if (recentSignals && recentSignals.length > 0) {
      datasets.push({
        type: 'scatter' as const,
        label: 'Buy Signal',
        data: buySignals,
        backgroundColor: '#3b82f6',
        borderColor: '#3b82f6',
        pointStyle: 'triangle',
        pointRotation: 0,
        pointRadius: 8,
        pointHoverRadius: 10,
        yAxisID: 'yPrice',
      })
      datasets.push({
        type: 'scatter' as const,
        label: 'Sell Signal',
        data: sellSignals,
        backgroundColor: '#ef4444',
        borderColor: '#ef4444',
        pointStyle: 'triangle',
        pointRotation: 180,
        pointRadius: 8,
        pointHoverRadius: 10,
        yAxisID: 'yPrice',
      })
    }

    // Add scenario curve scaled to the first price point
    if (scenario && scenario.id !== 'none' && scenario.curve.length > 0) {
      const basePrice = prices[0] || 100
      const scenarioData = scenario.curve.map((val) => (val / 100) * basePrice)
      
      // Pad or truncate to match data length
      const alignedScenarioData: (number | null)[] = displayedData.map((_, i) => 
        i < scenarioData.length ? (scenarioData[i] ?? null) : null)

      datasets.push({
        type: 'line' as const,
        label: scenario.name,
        data: alignedScenarioData,
        borderColor: '#A855F7',
        backgroundColor: 'transparent',
        borderWidth: 2,
        borderDash: [
          5,
          5,
        ],
        pointRadius: 0,
        yAxisID: 'yPrice',
      })
    }

    chartRef.current = new Chart(ctx, {
      type: 'line',
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
                size: 11,
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
            grid: { color: 'rgba(75, 85, 99, 0.1)' },
            ticks: {
              color: '#10B981',
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
    activeScenario,
    scenario,
    recentSignals,
  ])

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-8 animate-in fade-in zoom-in-95 duration-200">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-background/80 backdrop-blur-md" 
        onClick={onClose}
      />
      
      {/* Modal Content */}
      <div className="relative w-full max-w-6xl max-h-full flex flex-col bg-surface-elevated border border-surface-elevated-border rounded-2xl shadow-2xl overflow-hidden">
        
        {/* Header */}
        <div className="flex justify-between items-center p-4 border-b border-surface-elevated-border bg-surface-sink/50">
          <div>
            <h2 className="text-xl font-black text-primary tracking-tighter">
              {ticker} - Backtest & Scenario Analysis
            </h2>
            <p className="text-xs text-foreground/50 uppercase tracking-widest font-bold mt-1">
              Interactive Overlay
            </p>
          </div>
          <button 
            onClick={onClose}
            className="p-2 bg-surface-base hover:bg-surface-sink rounded-full transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Content Body */}
        <div className="flex flex-col lg:flex-row flex-1 overflow-hidden min-h-[31.25rem]">
          
          {/* Main Chart Area */}
          <div className="flex-1 p-6 flex flex-col min-h-[25rem]">
            {displayedData.length > 0 ? (
              <div className="flex-1 relative w-full h-full">
                <canvas ref={canvasRef} />
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center text-foreground/50 font-black uppercase tracking-widest">
                Insufficient Data
              </div>
            )}
          </div>

          {/* Sidebar / Controls */}
          <div className="w-full lg:w-80 border-t lg:border-t-0 lg:border-l border-surface-elevated-border bg-surface-sink/30 p-6 flex flex-col gap-6 overflow-y-auto">
            
            <div>
              <h3 className="text-sm font-black text-foreground uppercase tracking-widest mb-3">Market Scenarios</h3>
              <div className="flex flex-col gap-2">
                {scenariosData.map((sc) => (
                  <button
                    key={sc.id}
                    onClick={() => setActiveScenario(sc.id)}
                    className={`text-left p-3 rounded-xl border transition-all ${
                      activeScenario === sc.id 
                        ? 'bg-primary/10 border-primary shadow-sm' 
                        : 'bg-surface-base border-surface-base-border hover:border-primary/50'
                    }`}
                  >
                    <div className="text-xs font-black uppercase tracking-tight text-foreground">
                      {sc.name}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {scenario && scenario.id !== 'none' && (
              <div className="p-4 bg-surface-base border border-surface-base-border rounded-xl animate-in fade-in slide-in-from-bottom-2">
                <div className="text-micro font-black text-special uppercase tracking-widest mb-2">
                  Scenario Details
                </div>
                <p className="text-xs text-foreground/70 leading-relaxed font-medium">
                  {scenario.description}
                </p>
              </div>
            )}

            <div>
              <h3 className="text-sm font-black text-foreground uppercase tracking-widest mb-3">Signals</h3>
              <div className="p-4 bg-surface-base border border-surface-base-border rounded-xl">
                <p className="text-xs text-foreground/70 leading-relaxed font-medium mb-3">
                  Raw entry and exit signals generated by the algorithm based on Fundamental and Technical factors.
                </p>
                <div className="flex items-center gap-4 text-xs font-bold uppercase tracking-tight">
                  <div className="flex items-center gap-1.5">
                    <span className="w-3 h-3 text-[#3b82f6]">▲</span> Buy
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-3 h-3 text-[#ef4444]">▼</span> Sell
                  </div>
                </div>
              </div>
            </div>

          </div>
        </div>

      </div>
    </div>
  )
}
