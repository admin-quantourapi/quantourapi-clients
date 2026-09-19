import { Surface } from 'app/components/Surface'
import { fetchFromPublicApi } from 'app/utils/apiClient'
import { useState } from 'react'
import { Link } from 'react-router'

import type { Route } from './+types/signals'



interface MacroExposureConnection {
  ticker: string
  exposureType: string
  derivativeTier: number
  reversalImpact: string
  rationale: string
  verification: string | null
  narrativeName: string
  narrativeStatus: string
}

export interface SignalConnection {
  ticker?: string
  toTicker?: string
  connectionType?: string
  reason?: string
  [key: string]: unknown
}

export interface SignalMoatContext {
  moatStrength: number | null
  moatWindScore: number | null
  windLabel: 'TAILWIND' | 'HEADWIND' | 'NEUTRAL' | null
  moatConfluence: number | null
  moatConfluenceLabel: 'TAILWIND' | 'HEADWIND' | 'NEUTRAL' | null
  economicMoat: string | null
}

export interface Signal {
  id: number
  ticker: string
  sectorName?: string
  action: string
  createdAt: string
  score?: number | string
  entry?: number | string
  stopLoss?: number | string
  target?: number | string
  rsi?: string
  volumeChange?: string
  fcfInflection?: string
  catalystStatus?: string
  macroExposures?: MacroExposureConnection[]
  connections?: SignalConnection[]
  /** Display-only research context — not part of setup validity. */
  moat?: SignalMoatContext
  [key: string]: unknown
}

export async function loader({ request }: Route.LoaderArgs) {
  

  try {
    const url = new URL(request.url)
    const isDebug = url.searchParams.get('debug') === '1'
    const res = await fetchFromPublicApi(`/market/signals${isDebug ? '?debug=1' : ''}`, request)
    if (!res) {
      console.error('[SIGNALS LOADER ERROR] API returned no data (non-2xx or upstream failure)')
      return {
        signals: [],
        error: 'Error reading signals from API: upstream unavailable. Verify the linked API key in Instance Settings or via /link.',
        isDebug,
      }
    }
    return { signals: Array.isArray(res.data) ? res.data : [], error: null, isDebug }
  } catch (error) {
    if (error instanceof Response) throw error
    console.error('[SIGNALS LOADER ERROR]', error)
    return {
      signals: [],
      error: 'Error reading signals from API: ' + (error as Error).message,
    }
  }
}

export default function Signals({ loaderData }: Route.ComponentProps) {
  const { signals, error, isDebug } = loaderData

  const [
    searchQuery,
    setSearchQuery,
  ] = useState('')

  const [
    dateFilter,
    setDateFilter,
  ] = useState<'latest' | 'all'>('latest')

  // Find the latest trading session date in the signals
  const latestDateStr = signals.length > 0
    ? signals.reduce((latest: string, s: Signal) => {
      const d = s.createdAt ? String(s.createdAt).split(/[\sT]/)[0]! : ''
      return d > latest ? d : latest
    }, '')
    : ''

  const [
    sortOption,
    setSortOption,
  ] = useState('newest')
  const [
    expandedSignalId,
    setExpandedSignalId,
  ] = useState<number | null>(null)

  // Filter signals
  const filteredSignals = signals.filter((sig: Signal) => {
    if (dateFilter === 'latest' && latestDateStr) {
      const sigDate = sig.createdAt ? String(sig.createdAt).split(/[\sT]/)[0]! : ''
      if (sigDate !== latestDateStr) return false
    }

    const tickerMatch = sig.ticker.toLowerCase().includes(searchQuery.toLowerCase())
    const sectorMatch = (sig.sectorName || '').toLowerCase().includes(searchQuery.toLowerCase())
    return tickerMatch || sectorMatch
  })

  // Sort signals
  const sortedSignals = [
    ...filteredSignals,
  ].sort((a, b) => {
    if (sortOption === 'newest') {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    }
    if (sortOption === 'oldest') {
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    }
    if (sortOption === 'ticker') {
      return a.ticker.localeCompare(b.ticker)
    }
    if (sortOption === 'rsi-high') {
      const rsiA = a.rsi ? parseFloat(a.rsi) : 0
      const rsiB = b.rsi ? parseFloat(b.rsi) : 0
      return rsiB - rsiA
    }
    if (sortOption === 'rsi-low') {
      const rsiA = a.rsi ? parseFloat(a.rsi) : 100
      const rsiB = b.rsi ? parseFloat(b.rsi) : 100
      return rsiA - rsiB
    }
    if (sortOption === 'volume') {
      const volA = a.volumeChange ? parseFloat(a.volumeChange) : 0
      const volB = b.volumeChange ? parseFloat(b.volumeChange) : 0
      return volB - volA
    }
    return 0
  })

  // Helper to format date
  const formatTimeAgo = (dateStr: string) => {
    const date = new Date(dateStr)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMins / 60)
    const diffDays = Math.floor(diffHours / 24)

    if (diffMins < 1) return 'Just now'
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    return `${diffDays}d ago (${date.toLocaleDateString()})`
  }

  // Safe parseFloat that returns fallback instead of NaN
  const safeParseFloat = (val?: string, fallback = 0): number => {
    if (!val) return fallback
    const parsed = parseFloat(val)
    return isNaN(parsed) ? fallback : parsed
  }

  // Calculate Risk Reward
  const calculateRR = (entry: string, stop: string, target: string) => {
    const entryVal = parseFloat(entry)
    const stopVal = parseFloat(stop)
    const targetVal = parseFloat(target)
    if (isNaN(entryVal) || isNaN(stopVal) || isNaN(targetVal)) return '1:3'
    const risk = Math.abs(entryVal - stopVal)
    const reward = Math.abs(targetVal - entryVal)
    if (risk === 0) return '1:3'
    const ratio = (reward / risk).toFixed(1)
    return `1:${ratio}`
  }

  return (
    <div className="min-h-screen bg-background text-foreground transition-colors p-4 md:p-8">
      <div className="w-full space-y-8">
        
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-primary/10 pb-6">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <span className="text-3xl">📡</span>
              <h1 className="text-3xl font-black tracking-tight text-foreground m-0">Live Trading Signals</h1>
            </div>
            <p className="text-xs md:text-sm text-foreground/60 font-medium m-0">
              Real-time trend-following signals and asymmetrical entry points derived from multi-factor Quantitative &amp; Macro models.
            </p>
          </div>
        </div>

        {error && (
          <Surface surface="elevated" className="border-danger/30 bg-danger/10 text-danger p-4 rounded-2xl text-xs font-bold">
            {error}
          </Surface>
        )}

        {/* Filters and Controls */}
        <Surface surface="elevated" className="grid grid-cols-1 md:grid-cols-4 gap-4 p-4 rounded-2xl mb-8 shadow-lg border">
          {/* Search bar */}
          <div className="relative">
            <label className="block text-micro font-black text-foreground/60 uppercase tracking-wider mb-1.5">Search</label>
            <input
              type="text"
              placeholder="Search ticker, sector..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full px-3 py-2 bg-surface-sink border border-surface-sink-border rounded-xl text-xs focus:border-primary focus:outline-none transition-colors text-foreground placeholder-foreground/40 font-medium"
            />
          </div>

          {/* Session / Date Filter */}
          <div>
            <label className="block text-micro font-black text-foreground/60 uppercase tracking-wider mb-1.5">Session / Date</label>
            <select
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value as 'latest' | 'all')}
              className="w-full px-3 py-2 bg-surface-sink border border-surface-sink-border rounded-xl text-xs focus:border-primary focus:outline-none transition-colors text-foreground font-medium"
            >
              <option value="latest" className="bg-surface-sink text-foreground">
                Latest Session ({latestDateStr || 'Today'})
              </option>
              <option value="all" className="bg-surface-sink text-foreground">
                All Historical Signals
              </option>
            </select>
          </div>

          {/* Sorting options */}
          <div>
            <label className="block text-micro font-black text-foreground/60 uppercase tracking-wider mb-1.5">Sort By</label>
            <select
              value={sortOption}
              onChange={(e) => setSortOption(e.target.value)}
              className="w-full px-3 py-2 bg-surface-sink border border-surface-sink-border rounded-xl text-xs focus:border-primary focus:outline-none transition-colors text-foreground font-medium"
            >
              <option value="newest" className="bg-surface-sink text-foreground">Date (Newest)</option>
              <option value="oldest" className="bg-surface-sink text-foreground">Date (Oldest)</option>
              <option value="ticker" className="bg-surface-sink text-foreground">Ticker (A-Z)</option>
              <option value="rsi-high" className="bg-surface-sink text-foreground">RSI (Highest)</option>
              <option value="rsi-low" className="bg-surface-sink text-foreground">RSI (Lowest)</option>
              <option value="volume" className="bg-surface-sink text-foreground">Volume Change</option>
            </select>
          </div>

          {/* Stats indicator and Debug */}
          <div className="flex flex-col justify-end space-y-2">
            <div className="bg-surface-sink border border-surface-sink-border rounded-xl px-4 py-2 flex items-center justify-between text-xs">
              <span className="font-bold text-foreground/60">Total Found:</span>
              <span className="font-black text-primary text-sm">{sortedSignals.length}</span>
            </div>
            
            <Link
              to={isDebug ? '/signals' : '/signals?debug=1'}
              className="bg-surface-sink border border-surface-sink-border rounded-xl px-4 py-2 flex items-center justify-between text-xs cursor-pointer select-none transition-colors hover:bg-surface-base"
            >
              <span className="font-bold text-foreground/60">Debug (All signals):</span>
              <span className={`font-black text-sm px-2 py-0.5 rounded ${isDebug ? 'bg-purple-600 text-foreground' : 'text-foreground/45'}`}>{isDebug ? 'ON' : 'OFF'}</span>
            </Link>
          </div>
        </Surface>

        {/* Signals List */}
        <div className="space-y-4">
          {sortedSignals.length === 0 ? (
            <Surface surface="elevated" className="border p-12 text-center rounded-2xl text-foreground/45 font-black uppercase tracking-widest text-xs md:text-sm">
              No matching signals found.
            </Surface>
          ) : (
            sortedSignals.map((sig) => {
              const isExpanded = expandedSignalId === sig.id
              const rr = calculateRR(sig.entry, sig.stopLoss, sig.target)
              const rsiRaw = sig.rsi ? parseFloat(sig.rsi) : null
              const rsiVal = rsiRaw !== null && !isNaN(rsiRaw) ? rsiRaw : null
              const volChgRaw = sig.volumeChange ? parseFloat(sig.volumeChange) : null
              const volChg = volChgRaw !== null && !isNaN(volChgRaw) ? volChgRaw : null

              return (
                <Surface
                  key={sig.id}
                  surface="elevated"
                  className={`border transition-all duration-300 rounded-2xl overflow-hidden shadow-md hover:shadow-xl ${
                    isExpanded ? 'border-primary/50 shadow-primary/5' : ''
                  }`}
                >
                  {/* Summary Row */}
                  <div
                    onClick={() => setExpandedSignalId(isExpanded ? null : sig.id)}
                    className="p-4 md:p-6 cursor-pointer flex flex-col md:flex-row md:items-center justify-between gap-4 select-none"
                  >
                    <div className="flex items-center gap-4">
                      {/* Ticker Icon/Avatar */}
                      <Link
                        to={`/?ticker=${sig.ticker}`}
                        onClick={(e) => e.stopPropagation()}
                        className="w-12 h-12 rounded-none bg-surface-sink border border-surface-sink-border hover:border-primary flex items-center justify-center font-mono font-black text-lg text-primary hover:text-on-primary hover:bg-primary transition-all"
                      >
                        {sig.ticker}
                      </Link>

                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-black text-foreground text-sm md:text-base uppercase">
                            {sig.ticker}
                          </span>
                          {sig.fcfInflection && sig.fcfInflection !== 'NONE' && (
                            <Link
                              to={`/tickers/${sig.ticker}`}
                              onClick={(e) => e.stopPropagation()}
                              className={`text-micro px-2 py-0.5 rounded font-black border flex items-center gap-1 hover:opacity-80 transition-all ${
                                sig.fcfInflection === 'POSITIVE'
                                  ? 'bg-up/10 text-up border-up/20'
                                  : 'bg-danger/10 text-danger border-danger/20'
                              }`}
                              title="View Free Cash Flow Divergence"
                            >
                              {sig.fcfInflection === 'POSITIVE' ? '💎 FCF Inflection' : '⚠️ FCF Negative'}
                            </Link>
                          )}
                          {sig.catalystStatus && sig.catalystStatus !== 'NEUTRAL' && (
                            <span className={`text-micro px-2 py-0.5 rounded font-black border ${
                              sig.catalystStatus === 'LAGGING'
                                ? 'bg-primary/10 text-primary border-primary/20'
                                : 'bg-warning/10 text-warning border-warning/20'
                            }`}>
                              {sig.catalystStatus === 'LAGGING' ? '🚀 LAGGING' : 'PRICED IN'}
                              {sig.atrMove && (() => {
                                const val = parseFloat(sig.atrMove)
                                const formatted = (val === 0 || Math.abs(val) < 0.05) ? '0.0' : val.toFixed(1)
                                return ` (${formatted}x ATR)`
                              })()}
                            </span>
                          )}
                          {sig.marketStatus && (
                            <span className="text-micro px-1.5 py-0.5 rounded bg-surface-sink text-foreground/45 font-semibold uppercase border border-surface-sink-border">
                              {sig.marketStatus}
                            </span>
                          )}
                          {sig.macroExposures && sig.macroExposures.length > 0 && (
                            <span className="text-micro px-2 py-0.5 rounded bg-info/10 text-info font-bold border border-info/20">
                              🌍 {sig.macroExposures.length} Macro Narrative{sig.macroExposures.length > 1 ? 's' : ''}
                            </span>
                          )}
                          {sig.moat?.windLabel && sig.moat.windLabel !== 'NEUTRAL' && (
                            <span
                              className={`text-micro px-2 py-0.5 rounded font-bold border ${
                                sig.moat.windLabel === 'TAILWIND'
                                  ? 'bg-up/10 text-up border-up/20'
                                  : 'bg-warning/10 text-warning border-warning/20'
                              }`}
                              title={[
                                'Moat is research context only — does not validate this setup.',
                                sig.moat.moatStrength != null ? `Strength ${sig.moat.moatStrength.toFixed(2)}` : null,
                                sig.moat.moatWindScore != null ? `Wind ${sig.moat.moatWindScore.toFixed(2)}` : null,
                                sig.moat.economicMoat ? sig.moat.economicMoat.slice(0, 160) : null,
                              ].filter(Boolean).join(' · ')}
                            >
                              {sig.moat.windLabel === 'TAILWIND' ? '🏰 Moat ↑' : '🏰 Moat ↓'}
                            </span>
                          )}
                        </div>
                        <div className="text-micro text-foreground/60 mt-1 font-medium flex items-center gap-1.5 flex-wrap">
                          <span>{sig.sectorName || 'N/A Sector'}</span>
                          {sig.sectorPerformance && (
                            <span className={`text-micro font-bold ${
                              !isNaN(parseFloat(sig.sectorPerformance))
                                ? (parseFloat(sig.sectorPerformance) >= 0 ? 'text-up' : 'text-down')
                                : 'text-foreground/60'
                            }`}>
                              {!isNaN(parseFloat(sig.sectorPerformance)) ? (
                                <>
                                  ({parseFloat(sig.sectorPerformance) >= 0 ? '+' : ''}
                                  {parseFloat(sig.sectorPerformance).toFixed(2)}%)
                                </>
                              ) : (
                                `(${sig.sectorPerformance})`
                              )}
                            </span>
                          )}
                          <span className="text-foreground/30">•</span>
                          <span>{formatTimeAgo(sig.createdAt)}</span>
                        </div>
                      </div>
                    </div>

                    {/* Key Metrics Dashboard */}
                    <div className="grid grid-cols-3 md:grid-cols-4 gap-4 text-center border-t border-surface-elevated-border md:border-0 pt-3 md:pt-0">
                      <div>
                        <div className="text-micro font-black text-foreground/45 uppercase">Entry</div>
                        <div className="font-bold text-xs md:text-sm text-foreground/90">${safeParseFloat(sig.entry).toFixed(2)}</div>
                      </div>
                      <div>
                        <div className="text-micro font-black text-foreground/45 uppercase">Stop Loss</div>
                        <div className="font-bold text-xs md:text-sm text-down">${safeParseFloat(sig.stopLoss).toFixed(2)}</div>
                      </div>
                      <div>
                        <div className="text-micro font-black text-foreground/45 uppercase">Target</div>
                        <div className="font-bold text-xs md:text-sm text-up">${safeParseFloat(sig.target).toFixed(2)}</div>
                      </div>
                      <div className="col-span-3 md:col-span-1 border-t border-surface-elevated-border/50 md:border-0 pt-2 md:pt-0">
                        <div className="text-micro font-black text-foreground/45 uppercase">Target R:R</div>
                        <div className={`font-black text-xs md:text-sm px-2 py-0.5 rounded-full inline-block ${
                          parseFloat(rr) >= 3 ? 'bg-up/15 text-up border border-up' : 'bg-surface-sink text-foreground/80 border border-surface-sink-border'
                        }`}>
                          {rr}R
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Expanded Detail Panel */}
                  {isExpanded && (
                    <div className="border-t border-surface-elevated-border bg-surface-sink/40 p-4 md:p-6 space-y-6">
                      {sig.moat && (sig.moat.windLabel || sig.moat.economicMoat) && (
                        <Surface surface="sink" className="border rounded-xl p-3 space-y-1.5">
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <span className="text-micro font-black uppercase tracking-wider text-foreground/50">
                              Economic moat (context only — not a setup validator)
                            </span>
                            {sig.moat.windLabel && (
                              <span className={`text-micro font-mono font-bold px-2 py-0.5 rounded border ${
                                sig.moat.windLabel === 'TAILWIND'
                                  ? 'text-up border-up/30 bg-up/10'
                                  : sig.moat.windLabel === 'HEADWIND'
                                    ? 'text-warning border-warning/30 bg-warning/10'
                                    : 'text-foreground/50 border-border'
                              }`}>
                                {sig.moat.windLabel}
                                {sig.moat.moatWindScore != null ? ` ${sig.moat.moatWindScore.toFixed(2)}` : ''}
                                {sig.moat.moatStrength != null ? ` · str ${sig.moat.moatStrength.toFixed(2)}` : ''}
                              </span>
                            )}
                          </div>
                          {sig.moat.economicMoat && (
                            <p className="text-xs text-foreground/70 leading-relaxed font-sans">
                              {sig.moat.economicMoat.length > 280
                                ? `${sig.moat.economicMoat.slice(0, 280)}…`
                                : sig.moat.economicMoat}
                            </p>
                          )}
                        </Surface>
                      )}
                      {/* Secondary parameters / indicator badges */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-3">
                        {rsiVal !== null && (
                          <Surface surface="sink" className="border rounded-xl p-2.5">
                            <span className="block text-micro font-black text-foreground/45 uppercase mb-0.5">RSI (14)</span>
                            <div className="flex items-center gap-1.5">
                              <span className={`font-black text-sm ${
                                rsiVal >= 70 ? 'text-down' : rsiVal <= 30 ? 'text-up' : 'text-foreground/80'
                              }`}>
                                {rsiVal.toFixed(1)}
                              </span>
                              <div className="flex-1 h-1.5 bg-surface-base rounded-full overflow-hidden">
                                <div
                                  className={`h-full rounded-full ${
                                    rsiVal >= 70 ? 'bg-danger' : rsiVal <= 30 ? 'bg-up' : 'bg-primary'
                                  }`}
                                  style={{ width: `${Math.min(Math.max(rsiVal, 0), 100)}%` }}
                                />
                              </div>
                            </div>
                          </Surface>
                        )}

                        {volChg !== null && (
                          <Surface surface="sink" className="border rounded-xl p-2.5">
                            <span className="block text-micro font-black text-foreground/45 uppercase mb-0.5">Vol Change</span>
                            <span className={`font-black text-sm ${volChg >= 1.5 ? 'text-up' : 'text-foreground/80'}`}>
                              {volChg >= 1 ? '+' : ''}{(volChg * 100 - 100).toFixed(0)}%
                            </span>
                          </Surface>
                        )}

                        {sig.atr && (
                          <Surface surface="sink" className="border rounded-xl p-2.5">
                            <span className="block text-micro font-black text-foreground/45 uppercase mb-0.5">ATR</span>
                            <span className="font-bold text-sm text-foreground/80">
                              ${safeParseFloat(sig.atr).toFixed(2)}
                            </span>
                          </Surface>
                        )}

                        {sig.shares && (
                          <Surface surface="sink" className="border rounded-xl p-2.5">
                            <span className="block text-micro font-black text-foreground/45 uppercase mb-0.5">Suggested Shares</span>
                            <span className="font-bold text-sm text-secondary">
                              {parseInt(sig.shares).toLocaleString()}
                            </span>
                          </Surface>
                        )}

                        {sig.capitalRequired && (
                          <Surface surface="sink" className="border rounded-xl p-2.5">
                            <span className="block text-micro font-black text-foreground/45 uppercase mb-0.5">Required Capital</span>
                            <span className="font-bold text-sm text-foreground/80">
                              ${safeParseFloat(sig.capitalRequired).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                          </Surface>
                        )}

                        {sig.floor && (
                          <Surface surface="sink" className="border rounded-xl p-2.5">
                            <span className="block text-micro font-black text-foreground/45 uppercase mb-0.5">Floor Level</span>
                            <span className="font-bold text-sm text-foreground/80">
                              {sig.floor}
                            </span>
                          </Surface>
                        )}
                      </div>

                      {/* Technical Averages Overlay */}
                      <Surface surface="sink" className="bg-surface-sink/60 border rounded-2xl p-4">
                        <h4 className="text-micro font-black text-primary uppercase tracking-wider mb-2.5">Technical Moving Averages</h4>
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4 text-center">
                          {sig.ema8 && (
                            <div>
                              <div className="text-micro font-black text-foreground/45 uppercase">EMA(8)</div>
                              <div className="font-bold text-xs text-foreground/80">${safeParseFloat(sig.ema8).toFixed(2)}</div>
                            </div>
                          )}
                          {sig.ema21 && (
                            <div>
                              <div className="text-micro font-black text-foreground/45 uppercase">EMA(21)</div>
                              <div className="font-bold text-xs text-foreground/80">${safeParseFloat(sig.ema21).toFixed(2)}</div>
                            </div>
                          )}
                          {sig.sma20 && (
                            <div>
                              <div className="text-micro font-black text-foreground/45 uppercase">SMA(20)</div>
                              <div className="font-bold text-xs text-foreground/80">${safeParseFloat(sig.sma20).toFixed(2)}</div>
                            </div>
                          )}
                          {sig.sma50 && (
                            <div>
                              <div className="text-micro font-black text-foreground/45 uppercase">SMA(50)</div>
                              <div className="font-bold text-xs text-foreground/80">${safeParseFloat(sig.sma50).toFixed(2)}</div>
                            </div>
                          )}
                          {sig.sma200 && (
                            <div>
                              <div className="text-micro font-black text-foreground/45 uppercase">SMA(200)</div>
                              <div className="font-bold text-xs text-foreground/80">${safeParseFloat(sig.sma200).toFixed(2)}</div>
                            </div>
                          )}
                        </div>
                      </Surface>

                      {/* AI Thesis and Narratives */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        {sig.narrativeThesis && (
                          <div className="space-y-2">
                            <h4 className="text-micro font-black text-primary uppercase tracking-wider">Narrative Thesis</h4>
                            <div className="bg-surface-sink border border-surface-sink-border p-4 rounded-xl text-xs md:text-sm text-foreground/80 leading-relaxed font-medium">
                              {sig.narrativeThesis}
                            </div>
                          </div>
                        )}

                        {sig.newsSummary && (
                          <div className="space-y-2">
                            <h4 className="text-micro font-black text-primary uppercase tracking-wider">Recent Catalyst & News</h4>
                            <div className="bg-surface-sink border border-surface-sink-border p-4 rounded-xl text-xs md:text-sm text-foreground/80 leading-relaxed font-medium">
                              {sig.newsSummary}
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Macro Economic Thematic Alignments */}
                      {sig.macroExposures && sig.macroExposures.length > 0 && (
                        <div className="space-y-3 border-t border-surface-elevated-border/50 pt-4">
                          <h4 className="text-micro font-black text-primary uppercase tracking-wider flex items-center gap-1.5">
                            🌍 Macro Economic Thematic Alignments
                          </h4>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {sig.macroExposures.map((exp: MacroExposureConnection,
                              idx: number) => {
                              const isBeneficiary = exp.exposureType === 'BENEFICIARY'
                              const badgeBg = isBeneficiary
                                ? 'bg-up/10 text-up border-up/20'
                                : 'bg-danger/10 text-danger border-danger/20'
                              return (
                                <div key={idx} className="bg-surface-sink/30 border border-surface-sink-border rounded-xl p-4 space-y-2">
                                  <div className="flex justify-between items-start gap-2">
                                    <div>
                                      <span className="text-xs font-bold text-foreground/90 block">{exp.narrativeName}</span>
                                      <span className="text-micro text-foreground/45 font-bold uppercase block mt-0.5">Narrative Status: {exp.narrativeStatus}</span>
                                    </div>
                                    <span className={`text-micro font-black px-2 py-0.5 rounded border uppercase tracking-wider ${badgeBg}`}>
                                      {exp.exposureType} (Tier {exp.derivativeTier})
                                    </span>
                                  </div>
                                  <p className="text-micro text-foreground/80 leading-relaxed font-medium">
                                    <span className="text-foreground/45 font-bold mr-1.5 uppercase text-micro">Rationale:</span>
                                    {exp.rationale}
                                  </p>
                                  {exp.verification && (
                                    <div className="p-2 bg-warning/5 border border-warning/10 rounded text-micro text-warning font-medium leading-relaxed italic">
                                      <span className="font-black text-warning block mb-0.5 not-italic uppercase text-micro">🤖 AI Rationale Verification:</span>
                                      {exp.verification}
                                    </div>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      )}

                      {/* Connections & Related Tickers */}
                      {sig.connections && Array.isArray(sig.connections) && sig.connections.length > 0 && (
                        <div className="space-y-2 border-t border-surface-elevated-border/50 pt-4">
                          <h4 className="text-micro font-black text-primary uppercase tracking-wider">Related Connections</h4>
                          <div className="flex gap-2 flex-wrap">
                            {sig.connections.map((conn: SignalConnection, idx: number) => (
                              <div key={idx} className="bg-surface-sink/80 border border-surface-sink-border rounded-lg p-2 text-xs flex flex-col gap-0.5">
                                <div className="flex items-center gap-1">
                                  <span className="font-bold text-secondary">{conn.ticker || conn.toTicker}</span>
                                  <span className="text-micro text-foreground/45">({conn.connectionType || 'connection'})</span>
                                </div>
                                {conn.reason && (
                                  <span className="text-micro text-foreground/60 font-medium">{conn.reason}</span>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </Surface>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
