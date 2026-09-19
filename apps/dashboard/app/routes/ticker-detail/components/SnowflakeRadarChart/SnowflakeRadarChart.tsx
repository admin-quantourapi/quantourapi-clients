import { useMemo } from 'react'

export interface SnowflakeScores {
  valuation: number // 0 - 100
  growth: number // 0 - 100
  momentum: number // 0 - 100
  health: number // 0 - 100
  narrative: number // 0 - 100
}

export function SnowflakeRadarChart({
  scores,
  ticker,
}: {
  scores: SnowflakeScores
  ticker: string
}) {
  const axes = useMemo(() => [
    { key: 'valuation', label: 'Valuation', score: Math.min(100, Math.max(0, scores.valuation)) },
    { key: 'growth', label: 'Growth & FCF', score: Math.min(100, Math.max(0, scores.growth)) },
    { key: 'momentum', label: 'Tech Momentum', score: Math.min(100, Math.max(0, scores.momentum)) },
    { key: 'health', label: 'Balance & Risk', score: Math.min(100, Math.max(0, scores.health)) },
    { key: 'narrative', label: 'AI & Narrative', score: Math.min(100, Math.max(0, scores.narrative)) },
  ],
  [
    scores,
  ])

  const center = { x: 180, y: 150 }
  const maxRadius = 95
  const totalAxes = axes.length

  // Calculate coordinates for polygon
  const getCoordinates = (index: number, scorePercent: number) => {
    const angle = (Math.PI * 2 / totalAxes) * index - Math.PI / 2
    const radius = (scorePercent / 100) * maxRadius
    return {
      x: center.x + radius * Math.cos(angle),
      y: center.y + radius * Math.sin(angle),
    }
  }

  // Grid concentric pentagons (20%, 40%, 60%, 80%, 100%)
  const gridLevels = [
    20,
    40,
    60,
    80,
    100,
  ]

  // Data points & polygon path
  const dataPoints = axes.map((axis, i) => getCoordinates(i, axis.score))
  const polygonPath = dataPoints.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ') + ' Z'

  const overallScore = Math.round(axes.reduce((sum, a) => sum + a.score, 0) / totalAxes)

  return (
    <div className="metro-tile p-5 border-2 border-accent bg-surface-base shadow-xl flex flex-col items-center relative overflow-hidden">
      {/* Background glow effect */}
      <div className="absolute -right-10 -bottom-10 w-40 h-40 bg-accent/10 rounded-full blur-3xl pointer-events-none" />

      <div className="w-full flex items-center justify-between border-b border-border-surface-elevated/40 pb-3 mb-2">
        <div className="flex items-center gap-2">
          <span className="text-xl">❄️</span>
          <h2 className="text-sm font-mono font-bold uppercase tracking-wider text-on-surface-base">
            QUANT SNOWFLAKE DIAGRAM ({ticker})
          </h2>
        </div>
        <div className="flex items-center gap-1.5 font-mono">
          <span className="text-micro text-muted uppercase">Overall Rating:</span>
          <span className={`px-2 py-0.5 text-xs font-bold ${overallScore >= 70 ? 'bg-success/20 text-success border border-success/40' : overallScore >= 45 ? 'bg-warning/20 text-warning border border-warning/40' : 'bg-danger/20 text-danger border border-danger/40'}`}>
            {overallScore} / 100
          </span>
        </div>
      </div>

      <div className="relative w-full flex justify-center py-2">
        <svg width="360" height="300" viewBox="0 0 360 300" className="overflow-visible select-none">
          {/* Concentric Grid Pentagons */}
          {gridLevels.map((level) => {
            const levelPoints = axes.map((_, i) => getCoordinates(i, level))
            const levelPath = levelPoints.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ') + ' Z'
            return (
              <path
                key={level}
                d={levelPath}
                fill="none"
                stroke="currentColor"
                strokeWidth={level === 100 ? '1.5' : '1'}
                className={level === 100 ? 'text-border-surface-elevated' : 'text-border-surface-base/30'}
                strokeDasharray={level === 100 ? 'none' : '3 3'}
              />
            )
          })}

          {/* Axis Spokes */}
          {axes.map((_, i) => {
            const outerPoint = getCoordinates(i, 100)
            return (
              <line
                key={i}
                x1={center.x}
                y1={center.y}
                x2={outerPoint.x}
                y2={outerPoint.y}
                stroke="currentColor"
                strokeWidth="1"
                className="text-border-surface-elevated/40"
              />
            )
          })}

          {/* Data Filled Polygon */}
          <path
            d={polygonPath}
            fill="#10b981"
            fillOpacity="0.30"
            stroke="#10b981"
            strokeWidth="2.5"
            strokeLinejoin="round"
          />

          {/* Vertex Dots */}
          {dataPoints.map((p, i) => (
            <circle
              key={i}
              cx={p.x}
              cy={p.y}
              r="4.5"
              fill="#10b981"
              stroke="#042f2e"
              strokeWidth="2"
            />
          ))}

          {/* Labels & Score Badges around Pentagon */}
          {axes.map((axis, i) => {
            const labelPoint = getCoordinates(i, 118)
            return (
              <g key={axis.key} transform={`translate(${labelPoint.x}, ${labelPoint.y})`}>
                <text
                  textAnchor="middle"
                  dominantBaseline="central"
                  className="font-mono text-micro font-bold fill-on-surface-base uppercase tracking-wider"
                >
                  {axis.label}
                </text>
                <text
                  y="12"
                  textAnchor="middle"
                  dominantBaseline="central"
                  className="font-mono text-micro font-bold fill-accent"
                >
                  {axis.score} pt
                </text>
              </g>
            )
          })}
        </svg>
      </div>

      <div className="w-full grid grid-cols-5 gap-1.5 pt-3 border-t border-border-surface-elevated/40 font-mono text-micro">
        {axes.map((axis) => (
          <div key={axis.key} className="flex flex-col items-center justify-center p-1.5 bg-surface-sink/50 border border-border-surface-elevated/40">
            <span className="text-muted truncate uppercase tracking-tighter" title={axis.label}>{axis.label.split(' ')[0]}</span>
            <span className="font-bold text-on-surface-base">{axis.score}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
