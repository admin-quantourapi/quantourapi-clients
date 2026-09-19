import {
  useEffect,
  useRef,
} from 'react'

const SECTOR_STYLES: Record<string, { gradient: string; accentBorder: string }> = {
  'Technology': {
    gradient: 'from-cyan-950/30 via-slate-900/80 to-slate-900',
    accentBorder: 'border-l-cyan-500/70',
  },
  'Information Technology': {
    gradient: 'from-cyan-950/30 via-slate-900/80 to-slate-900',
    accentBorder: 'border-l-cyan-500/70',
  },
  'Financial Services': {
    gradient: 'from-amber-950/30 via-slate-900/80 to-slate-900',
    accentBorder: 'border-l-amber-500/70',
  },
  'Financials': {
    gradient: 'from-amber-950/30 via-slate-900/80 to-slate-900',
    accentBorder: 'border-l-amber-500/70',
  },
  'Healthcare': {
    gradient: 'from-indigo-950/30 via-slate-900/80 to-slate-900',
    accentBorder: 'border-l-indigo-500/70',
  },
  'Energy': {
    gradient: 'from-emerald-950/30 via-slate-900/80 to-slate-900',
    accentBorder: 'border-l-emerald-500/70',
  },
  'Consumer Cyclical': {
    gradient: 'from-rose-950/30 via-slate-900/80 to-slate-900',
    accentBorder: 'border-l-rose-500/70',
  },
  'Consumer Discretionary': {
    gradient: 'from-rose-950/30 via-slate-900/80 to-slate-900',
    accentBorder: 'border-l-rose-500/70',
  },
  'Consumer Defensive': {
    gradient: 'from-lime-950/30 via-slate-900/80 to-slate-900',
    accentBorder: 'border-l-lime-500/70',
  },
  'Consumer Staples': {
    gradient: 'from-lime-950/30 via-slate-900/80 to-slate-900',
    accentBorder: 'border-l-lime-500/70',
  },
  'Industrials': {
    gradient: 'from-blue-950/30 via-slate-900/80 to-slate-900',
    accentBorder: 'border-l-blue-500/70',
  },
  'Communication Services': {
    gradient: 'from-fuchsia-950/30 via-slate-900/80 to-slate-900',
    accentBorder: 'border-l-fuchsia-500/70',
  },
  'Utilities': {
    gradient: 'from-yellow-950/30 via-slate-900/80 to-slate-900',
    accentBorder: 'border-l-yellow-500/70',
  },
  'Real Estate': {
    gradient: 'from-orange-950/30 via-slate-900/80 to-slate-900',
    accentBorder: 'border-l-orange-500/70',
  },
  'Basic Materials': {
    gradient: 'from-teal-950/30 via-slate-900/80 to-slate-900',
    accentBorder: 'border-l-teal-500/70',
  },
}

const DEFAULT_SECTOR_STYLE = {
  gradient: 'from-slate-950/30 via-slate-900/80 to-slate-900',
  accentBorder: 'border-l-slate-600/70',
}

export function TickerCard({ 
  t, 
  isSelected, 
  onSelect,
}: { 
  t: { ticker: string; name?: string; sector?: string; industry?: string; isEmergingLeader?: boolean; isActive?: boolean; shortTermStatus?: string; rsi?: number }
  isSelected: boolean
  onSelect: () => void
}) {
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isSelected && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [
    isSelected,
  ])

  const style = (t.sector && SECTOR_STYLES[t.sector]) || DEFAULT_SECTOR_STYLE

  return (
    <div 
      ref={cardRef}
      data-testid="ticker-card"
      data-ticker={t.ticker}
      className={`metro-tile relative p-3 border border-l-4 cursor-pointer transition-all duration-200 rounded-none bg-gradient-to-br ${style.gradient} ${style.accentBorder} ${
        isSelected 
          ? 'border-2 border-l-4 border-accent ring-1 ring-accent/40 shadow-lg z-10 brightness-110' 
          : 'border-border-surface-base hover:border-accent/60 hover:brightness-105'
      }`}
      onClick={(e: React.MouseEvent) => {
        e.stopPropagation()
        onSelect()
      }}
    >
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center justify-between">
          <span className={`text-lg font-mono font-bold tracking-tight ${isSelected ? 'text-accent' : 'text-on-surface-base'}`}>
            {t.ticker}
            {t.isEmergingLeader && <span title="FCF Inflection / Emerging Leader" className="ml-1 text-sm">💎</span>}
          </span>
          <div className="flex items-center gap-1">
            {t.shortTermStatus === 'OVEREXTENDED' ? (
              <span className="text-micro font-mono uppercase font-bold text-danger border border-danger/40 px-1 py-0.5" title="Overextended - Short-Term Profit-Taking Risk">⚡ OVEREXTENDED</span>
            ) : t.shortTermStatus === 'OVERSOLD' ? (
              <span className="text-micro font-mono uppercase font-bold text-success border border-success/40 px-1 py-0.5" title="Oversold - Rebound Potential">🟢 OVERSOLD</span>
            ) : null}
          </div>
        </div>
        <span className="text-micro font-mono truncate text-muted uppercase tracking-wider" title={t.name || t.sector || t.ticker}>
          {t.name && t.name !== t.ticker
            ? t.name 
            : (t.sector ? `${t.sector}${t.industry ? ` • ${t.industry}` : ''}` : (t.name || t.ticker))}
        </span>
      </div>
    </div>
  )
}

