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
  Title,
  Tooltip,
} from 'chart.js'
import {
  useEffect,
  useMemo,
  useRef,
} from 'react'

import type { NarrativeUpdate } from '../macro-narratives'

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

export function MacroHypeChart({ updates }: { updates: NarrativeUpdate[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<Chart | null>(null)

  const chartData = useMemo(() => {
    // Group updates by date
    const countsByDate = new Map<string, number>()
    
    // Sort updates by date ascending
    const sorted = [
      ...updates,
    ].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    
    for (const u of sorted) {
      const dateStr = new Date(u.createdAt).toISOString().split('T')[0]!
      countsByDate.set(dateStr, (countsByDate.get(dateStr) || 0) + 1)
    }

    const labels = Array.from(countsByDate.keys())
    const data = Array.from(countsByDate.values())

    // Generate cumulative hype (moving average or running total) to show trend
    let runningTotal = 0
    const hypeLine = data.map(val => {
      runningTotal += val
      return runningTotal
    })

    return { labels, data, hypeLine }
  }, [
    updates,
  ])

  useEffect(() => {
    if (!canvasRef.current) return

    if (chartRef.current) {
      chartRef.current.destroy()
    }

    chartRef.current = new Chart(canvasRef.current, {
      type: 'bar',
      data: {
        labels: chartData.labels,
        datasets: [
          {
            type: 'line',
            label: 'Narrative Hype (Cumulative)',
            data: chartData.hypeLine,
            borderColor: '#60A5FA', // info color
            borderWidth: 2,
            tension: 0.4,
            pointRadius: 0,
            yAxisID: 'y1',
          },
          {
            type: 'bar',
            label: 'Daily Updates Volume',
            data: chartData.data,
            backgroundColor: 'rgba(96, 165, 250, 0.2)',
            borderColor: 'rgba(96, 165, 250, 0.5)',
            borderWidth: 1,
            yAxisID: 'y',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false,
        },
        scales: {
          x: {
            grid: { display: false, color: 'rgba(255,255,255,0.05)' },
            ticks: { color: 'rgba(255,255,255,0.5)', maxTicksLimit: 7 },
          },
          y: {
            type: 'linear',
            display: true,
            position: 'left',
            grid: { color: 'rgba(255,255,255,0.05)' },
            ticks: { color: 'rgba(255,255,255,0.5)', stepSize: 1 },
          },
          y1: {
            type: 'linear',
            display: true,
            position: 'right',
            grid: { drawOnChartArea: false },
            ticks: { display: false },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(0,0,0,0.8)',
            titleColor: 'rgba(255,255,255,0.8)',
            bodyColor: 'rgba(255,255,255,0.8)',
            padding: 12,
            cornerRadius: 8,
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
    chartData,
  ])

  return (
    <div className="w-full h-full min-h-[9.375rem] relative">
      {chartData.labels.length === 0 ? (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-foreground/40 italic">
          Not enough data to chart hype
        </div>
      ) : (
        <canvas ref={canvasRef} />
      )}
    </div>
  )
}
