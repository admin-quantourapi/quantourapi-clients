import {
  Chart,
  Filler,
  LineElement,
  PointElement,
  RadialLinearScale,
  Tooltip,
} from 'chart.js'
import {
  useEffect, useRef,
} from 'react'

import type { MarketThesis } from '../market-thesis'

Chart.register(
  RadialLinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
)

export function ThesisRadarChart({ thesis }: { thesis: MarketThesis }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<Chart | null>(null)

  useEffect(() => {
    if (!canvasRef.current) return
    if (chartRef.current) chartRef.current.destroy()

    chartRef.current = new Chart(canvasRef.current, {
      type: 'radar',
      data: {
        labels: thesis.axes.map(a => a.label),
        datasets: [
          {
            label: 'Market Thesis',
            data: thesis.axes.map(a => Math.round(a.score * 100)),
            backgroundColor: 'rgba(34, 211, 238, 0.18)',
            borderColor: '#22D3EE',
            borderWidth: 2,
            pointBackgroundColor: '#22D3EE',
            pointRadius: 3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          r: {
            min: 0,
            max: 100,
            ticks: {
              color: 'rgba(255,255,255,0.35)',
              backdropColor: 'transparent',
              stepSize: 25,
            },
            grid: { color: 'rgba(255,255,255,0.08)' },
            angleLines: { color: 'rgba(255,255,255,0.08)' },
            pointLabels: { color: 'rgba(255,255,255,0.7)', font: { size: 11 } },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(0,0,0,0.8)',
            titleColor: 'rgba(255,255,255,0.85)',
            bodyColor: 'rgba(255,255,255,0.85)',
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
    thesis,
  ])

  return (
    <div className="w-full h-full min-h-80 relative">
      <canvas ref={canvasRef} />
    </div>
  )
}
