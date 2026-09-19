import { fetchFromPublicApi } from 'app/utils/apiClient'
import { useState } from 'react'
import { Link } from 'react-router'

import type { Route } from './+types/emerging-leaders'

export async function loader({ request }: Route.LoaderArgs) {
  try {
    const res = await fetchFromPublicApi('/market/emerging-leaders', request)
    let leadersList = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []

    const filteredLeaders = leadersList.filter((l: EmergingLeader) => l.inflectionType !== 'CLOSEST_CANDIDATE' || Number(l.fcfGrowth ?? 0) >= 100)
    const byFcfInflection = (a: EmergingLeader, b: EmergingLeader) => Number(b.fcfGrowth ?? 0) - Number(a.fcfGrowth ?? 0)
    const qualifying = filteredLeaders
      .filter((l: EmergingLeader) => l.inflectionType !== 'CLOSEST_CANDIDATE')
      .sort(byFcfInflection)
      .slice(0, 10)
    const closest = qualifying.length === 0
      ? filteredLeaders
        .filter((l: EmergingLeader) => l.inflectionType === 'CLOSEST_CANDIDATE')
        .sort(byFcfInflection)
        .slice(0, 5)
      : []
    leadersList = [
      ...qualifying,
      ...closest,
    ]

    return { leaders: leadersList, error: null }
  } catch (error) {
    if (error instanceof Response) throw error
    console.error('[EMERGING LEADERS LOADER ERROR]', error)
    return { leaders: [], error: (error as Error).message }
  }
}

interface EmergingLeader {
  ticker: string
  name?: string
  sector?: string
  marketCap?: number | string
  inflectionType?: string
  score?: number | string
  isStructuralPivot?: boolean
  fcfGrowth?: number | string
  analysis?: string
  updatedAt?: string
}

export default function EmergingLeaders({ loaderData }: Route.ComponentProps) {
  const { leaders, error } = loaderData
  const [
    search,
    setSearch,
  ] = useState('')

  const filtered = (leaders as EmergingLeader[]).filter(l => 
    l.ticker.toLowerCase().includes(search.toLowerCase()) ||
 (l.name || '').toLowerCase().includes(search.toLowerCase()))

  const isFallbackMode = (leaders as EmergingLeader[]).some(l => l.inflectionType === 'CLOSEST_CANDIDATE')

  return (
    <div className="p-6 w-full space-y-6 font-mono">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-6 border-b border-border/10 pb-6">
        <div>
          <h1 className="text-4xl font-bold text-foreground tracking-tight flex items-center gap-3">
            <span className="text-accent">💎</span> EMERGING LEADERS
          </h1>
          <p className="text-foreground/40 font-bold mt-2 uppercase tracking-wider text-xs">
            FCF Inflection & Structural Pivot Analysis
          </p>
        </div>
        <div className="relative group">
          <input
            type="text"
            placeholder="SEARCH GEMS..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full md:w-80 bg-surface-sink border border-border/20 px-4 py-2.5 text-foreground font-mono text-xs placeholder-foreground/40 focus:outline-none focus:border-primary uppercase tracking-wider"
          />
        </div>
      </header>

      {error && (
        <div className="bg-down-500/10 border border-down-500/30 p-4 text-down font-bold flex items-center gap-3 text-xs">
          <span>🚨</span> {error}
        </div>
      )}

      {isFallbackMode && (
        <div className="bg-warning-500/10 border border-warning-500/30 p-4 text-warning font-bold flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-3">
            <span className="text-xl">⚠️</span>
            <div>
              <span className="uppercase tracking-wider font-bold text-foreground">NO EMERGING LEADERS YET</span>
              <p className="text-foreground/60 font-normal text-micro mt-0.5">
                No tickers currently meet strict FCF turnaround criteria. Displaying top 5 closest watch candidates based on FCF performance & sector P/E valuation.
              </p>
            </div>
          </div>
          <span className="bg-warning-500/20 px-3 py-1 border border-warning-500/40 text-warning text-micro uppercase tracking-wider font-bold whitespace-nowrap self-start md:self-auto">
            CLOSEST CANDIDATES (TOP 5)
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6">
        {filtered.map((leader: EmergingLeader) => (
          <div key={leader.ticker} className="bg-surface-sink/40 border border-border/10 hover:border-accent/40 transition-all group">
            <div className="p-6">
              <div className="flex flex-col md:flex-row justify-between gap-6 items-start">
                <div className="flex items-start gap-5">
                  <div className="w-16 h-16 bg-accent/10 border border-accent/30 flex items-center justify-center text-xl font-bold text-accent group-hover:bg-accent group-hover:text-black transition-all">
                    {leader.ticker}
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-foreground group-hover:text-primary transition-colors">{leader.name || leader.ticker}</h2>
                    <div className="flex flex-wrap items-center gap-2 mt-2">
                      <span className="bg-white/5 border border-border/10 text-foreground/50 px-2.5 py-0.5 text-micro font-bold uppercase tracking-wider">{leader.sector || 'US EQUITIES'}</span>
                      <span className="bg-accent/10 border border-accent/20 text-accent px-2.5 py-0.5 text-micro font-bold uppercase tracking-wider">
                        Cap: ${(Number(leader.marketCap) / 1e9).toFixed(1)}B
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex flex-col items-end gap-2">
                  <div className={`px-3 py-1 border text-micro font-bold uppercase tracking-wider ${
                    leader.inflectionType === 'CLOSEST_CANDIDATE'
                      ? 'bg-warning-500/20 border-warning-500/40 text-warning'
                      : Number(leader.score) < 0
                        ? 'bg-white/5 border-border/10 text-foreground/40'
                        : leader.isStructuralPivot
                          ? 'bg-up-500/20 border-up-500/40 text-up'
                          : 'bg-warning-500/20 border-warning-500/40 text-warning'
                  }`}>
                    {leader.inflectionType === 'CLOSEST_CANDIDATE'
                      ? '⌛ NO EMERGING LEADERS YET (CLOSEST CANDIDATE)'
                      : Number(leader.score) < 0
                        ? '⏳ AI Pending'
                        : leader.isStructuralPivot
                          ? '✅ Structural Pivot'
                          : '⚠️ Potential Fluke'}
                  </div>
                  <div className="text-3xl font-bold text-foreground tracking-tight">
                    {Number(leader.score) < 0 ? 'N/A' : Math.round(Number(leader.score) * 100)}
                    {Number(leader.score) >= 0 && <span className="text-accent text-lg">/100</span>}
                  </div>
                </div>
              </div>

              <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
                <div className="space-y-4">
                  <div className="bg-surface-sink/30 p-4 border border-border/10">
                    <h3 className="text-micro font-bold text-foreground/50 uppercase tracking-widest mb-3">FCF Momentum</h3>
                    <div className="flex items-baseline gap-3">
                      <span className={`text-3xl font-bold ${Number(leader.fcfGrowth) > 0 ? 'text-up' : 'text-down'}`}>
                        {Number(leader.fcfGrowth) > 0 ? '+' : ''}{Number(leader.fcfGrowth).toFixed(0)}%
                      </span>
                      <span className="text-foreground/70 font-bold uppercase text-micro tracking-wider">
                        {leader.inflectionType === 'CLOSEST_CANDIDATE' ? 'CLOSEST WATCH CANDIDATE' : leader.inflectionType}
                      </span>
                    </div>
                  </div>
 
                  <Link 
                    to={`/tickers/${leader.ticker}`}
                    className="flex items-center justify-center gap-2 w-full py-3 bg-white/5 hover:bg-white/10 border border-border/10 text-foreground font-bold transition-all uppercase tracking-wider text-xs"
                  >
                    🔍 View Technical Detail
                  </Link>
                </div>

                <div className="bg-accent/5 p-4 border border-accent/20">
                  <h3 className="text-micro font-bold text-accent uppercase tracking-widest mb-3">AI Analysis Reasoning</h3>
                  <p className="text-foreground/60 leading-relaxed font-medium italic text-xs">
                    "{leader.analysis}"
                  </p>
                </div>
              </div>
            </div>
 
            <div className="bg-surface-sink/40 px-6 py-3 border-t border-border/10 flex justify-between items-center text-micro">
              <span className="font-bold text-foreground/50 uppercase tracking-wider">
                Last Evaluated: {new Date(leader.updatedAt!).toLocaleDateString()}
              </span>
              <div className="flex gap-1.5">
                <div className="w-1.5 h-1.5 bg-accent animate-pulse"></div>
                <div className="w-1.5 h-1.5 bg-accent/50"></div>
                <div className="w-1.5 h-1.5 bg-accent/20"></div>
              </div>
            </div>
          </div>
        ))}

        {filtered.length === 0 && (
          <div className="py-16 text-center space-y-3 border border-dashed border-border/10 bg-surface-sink/20">
            <div className="text-4xl opacity-40">🔍</div>
            <p className="text-foreground/50 font-bold uppercase tracking-wider text-xs">No emerging leaders found in the current watchlist.</p>
          </div>
        )}
      </div>
    </div>
  )
}
