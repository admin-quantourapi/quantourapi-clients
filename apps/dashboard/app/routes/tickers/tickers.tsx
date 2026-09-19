import { Surface } from 'app/components/Surface'
import { fetchFromPublicApi } from 'app/utils/apiClient'
import {
  useEffect,
  useState, 
} from 'react'
import { useSearchParams } from 'react-router'

import type { Route } from './+types/tickers'
import { TickerCard } from './components/TickerCard/TickerCard'
import { TickerDetailPanel } from './components/TickerDetailPanel/TickerDetailPanel'

export async function loader({ request }: Route.LoaderArgs) {
  try {
    const res = await fetchFromPublicApi('/market/tickers', request)
    const tickersList = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
    const categories = res?.categories || null
    return { tickers: tickersList, categories }
  } catch (error) {
    if (error instanceof Response) throw error
    console.error('[TICKERS LOADER ERROR]', error)
    return { tickers: [], categories: null }
  }
}

export default function Tickers({ loaderData }: Route.ComponentProps) {
  // biome-ignore lint/suspicious/noTsIgnore: legacy @ts-ignore kept for tsc (migrated from eslint-disable)
  // @ts-ignore - TS strict fix
  const { tickers } = loaderData || {}
  const tickerArray = Array.isArray(tickers) ? tickers : []

  const [
    searchParams,
    setSearchParams,
  ] = useSearchParams()
  const tickerParam = searchParams.get('ticker') || searchParams.get('selected')

  const [
    filter,
    setFilter,
  ] = useState('')
  const [
    undervaluedOnly,
    setUndervaluedOnly,
  ] = useState(false)
  const [
    trendFilter,
    setTrendFilter,
  ] = useState<'all' | 'bullish' | 'bearish'>('all')
  const [
    shortTermFilter,
    setShortTermFilter,
  ] = useState<'all' | 'oversold' | 'balanced' | 'overextended'>('all')
  const [
    highFundingOnly,
    setHighFundingOnly,
  ] = useState(false)
  const [
    defensiveOnly,
    setDefensiveOnly,
  ] = useState(false)
  const [
    inflectionOnly,
    setInflectionOnly,
  ] = useState(false)
  const [
    selectedTicker,
    setSelectedTickerState,
  ] = useState<string | null>(tickerParam ? tickerParam.toUpperCase() : null)

  useEffect(() => {
    const param = searchParams.get('ticker') || searchParams.get('selected')
    if (param) {
      setSelectedTickerState(param.toUpperCase())
    }
  }, [
    searchParams,
  ])

  const setSelectedTicker = (t: string | null) => {
    setSelectedTickerState(t)
    if (t) {
      setSearchParams({ ticker: t }, { replace: true, preventScrollReset: true })
    } else {
      setSearchParams({}, { replace: true, preventScrollReset: true })
    }
  }

  const uniqueTickerMap = new Map<string, typeof tickerArray[0]>()
  tickerArray.forEach((t: { ticker?: string }) => {
    if (t && t.ticker && !uniqueTickerMap.has(t.ticker.toUpperCase())) {
      uniqueTickerMap.set(t.ticker.toUpperCase(), t)
    }
  })
  const uniqueTickers = Array.from(uniqueTickerMap.values())

  const sortedTickers = [
    ...uniqueTickers,
  ].sort((a, b) => (a.ticker || '').localeCompare(b.ticker || ''))

  const filteredTickers = sortedTickers.filter((t) => {
    const matchesSearch = t.ticker.toLowerCase().includes(filter.toLowerCase()) || 
 t.name?.toLowerCase().includes(filter.toLowerCase())
 
    if (!matchesSearch) return false

    // Exclude Indexes and ETFs
    if (t.ticker.startsWith('^')) return false
    const sectorLower = (t.sector || '').toLowerCase()
    const nameLower = (t.name || '').toLowerCase()
    if (sectorLower === 'fund' || sectorLower === 'etf' || sectorLower.includes('index') || nameLower.includes('index') || nameLower.includes('etf')) return false

    // Trend Filter
    if (trendFilter === 'bullish' && t.trend !== 'BULLISH') return false
    if (trendFilter === 'bearish' && t.trend !== 'BEARISH') return false

    // Short-Term Behavior Filter (Oversold / Balanced / Overextended)
    if (shortTermFilter === 'oversold' && t.shortTermStatus !== 'OVERSOLD') return false
    if (shortTermFilter === 'balanced' && t.shortTermStatus !== 'BALANCED') return false
    if (shortTermFilter === 'overextended' && t.shortTermStatus !== 'OVEREXTENDED') return false

    // Undervalued Filter (Fair Price > Current Price)
    if (undervaluedOnly && !t.isUndervalued) return false

    // High Funding Filter (> 100M)
    if (highFundingOnly && (t.fundingAmount || 0) < 100_000_000) return false

    // Defensive Only Filter
    if (defensiveOnly && !t.isDefensive) return false

    // FCF Inflection Filter
    if (inflectionOnly && !t.isEmergingLeader) return false
 
    return true
  })

  return (
    <div className="flex h-screen overflow-hidden relative">
      {/* Main Grid View - Left Side */}
      <div 
        className="flex-1 overflow-y-auto p-4 md:p-8 transition-all duration-300"
      >
        <div className="w-full">
          {/* Unified Container Card for Header & Controls */}
          <div className="mb-6 p-4 bg-surface-base flex flex-col gap-3">
            {/* Row 1: Page Title */}
            <div className="flex items-center justify-between">
              <h1 className="text-xl md:text-2xl font-mono font-bold uppercase tracking-wider text-on-surface-base border-l-4 border-accent pl-3">
                SCANNING POOL
              </h1>
            </div>

            {/* Row 2: Sub-header Filter Toolbar (Search + Filters + Stock Count) */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-border-surface-elevated/40">
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <input
                  type="text"
                  className="w-[14rem] h-filter-md shrink-0 px-3 text-xs font-mono border border-border-surface-elevated rounded-none focus:border-accent outline-none uppercase transition-all bg-surface-sink text-on-surface-base placeholder:text-muted"
                  placeholder="SEARCH TICKER..."
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => setUndervaluedOnly(!undervaluedOnly)}
                  className={`h-filter-md px-3 text-xs font-mono font-bold rounded-none transition-all border flex items-center justify-center gap-1 cursor-pointer uppercase ${
                    undervaluedOnly 
                      ? 'bg-accent text-on-accent border-accent shadow-md ring-1 ring-accent' 
                      : 'bg-surface-sink text-on-surface-base border-border-surface-elevated hover:border-accent'
                  }`}
                >
                  <span>💸</span> Valuation
                </button>

                <button
                  onClick={() => setHighFundingOnly(!highFundingOnly)}
                  className={`h-filter-md px-3 text-xs font-mono font-bold rounded-none transition-all border flex items-center justify-center gap-1 cursor-pointer uppercase ${
                    highFundingOnly 
                      ? 'bg-warning text-on-warning border-warning shadow-md ring-1 ring-warning' 
                      : 'bg-surface-sink text-on-surface-base border-border-surface-elevated hover:border-warning'
                  }`}
                >
                  <span>🏛</span> Gov Funding
                </button>

                <button
                  onClick={() => setDefensiveOnly(!defensiveOnly)}
                  className={`h-filter-md px-3 text-xs font-mono font-bold rounded-none transition-all border flex items-center justify-center gap-1 cursor-pointer uppercase ${
                    defensiveOnly 
                      ? 'bg-success text-on-success border-success shadow-md ring-1 ring-success' 
                      : 'bg-surface-sink text-on-surface-base border-border-surface-elevated hover:border-success'
                  }`}
                >
                  <span>🛡</span> Rotation
                </button>

                <button
                  onClick={() => setInflectionOnly(!inflectionOnly)}
                  className={`h-filter-md px-3 text-xs font-mono font-bold rounded-none transition-all border flex items-center justify-center gap-1 cursor-pointer uppercase ${
                    inflectionOnly 
                      ? 'bg-danger text-on-danger border-danger shadow-md ring-1 ring-danger' 
                      : 'bg-surface-sink text-on-surface-base border-border-surface-elevated hover:border-danger'
                  }`}
                >
                  <span>💎</span> Fundamental
                </button>

                <div className="h-filter-md flex bg-surface-sink border border-border-surface-elevated rounded-none overflow-hidden font-mono" title="Filter by Trend (Bullish / Bearish)">
                  <button 
                    onClick={() => setTrendFilter(trendFilter === 'bullish' ? 'all' : 'bullish')}
                    className={`h-full px-3 text-xs font-bold transition-all cursor-pointer uppercase flex items-center justify-center ${trendFilter === 'bullish' ? 'bg-success text-on-success font-extrabold' : 'text-on-surface-base hover:bg-surface-elevated'}`}
                  >
                    BULL
                  </button>
                  <button 
                    onClick={() => setTrendFilter(trendFilter === 'bearish' ? 'all' : 'bearish')}
                    className={`h-full px-3 text-xs font-bold transition-all border-l border-border-surface-elevated cursor-pointer uppercase flex items-center justify-center ${trendFilter === 'bearish' ? 'bg-danger text-on-danger font-extrabold' : 'text-on-surface-base hover:bg-surface-elevated'}`}
                  >
                    BEAR
                  </button>
                </div>

                <div className="h-filter-md flex bg-surface-sink border border-border-surface-elevated rounded-none overflow-hidden font-mono" title="Filter by Short-Term Behavior (RSI & VWAP)">
                  <button 
                    onClick={() => setShortTermFilter(shortTermFilter === 'oversold' ? 'all' : 'oversold')}
                    className={`h-full px-3 text-xs font-bold transition-all cursor-pointer uppercase flex items-center justify-center ${shortTermFilter === 'oversold' ? 'bg-success text-on-success font-extrabold' : 'text-on-surface-base hover:bg-surface-elevated'}`}
                  >
                    🟢 OVERSOLD
                  </button>
                  <button 
                    onClick={() => setShortTermFilter(shortTermFilter === 'balanced' ? 'all' : 'balanced')}
                    className={`h-full px-3 text-xs font-bold transition-all border-l border-border-surface-elevated cursor-pointer uppercase flex items-center justify-center ${shortTermFilter === 'balanced' ? 'bg-info text-on-info font-extrabold' : 'text-on-surface-base hover:bg-surface-elevated'}`}
                  >
                    ⚖️ BALANCED
                  </button>
                  <button 
                    onClick={() => setShortTermFilter(shortTermFilter === 'overextended' ? 'all' : 'overextended')}
                    className={`h-full px-3 text-xs font-bold transition-all border-l border-border-surface-elevated cursor-pointer uppercase flex items-center justify-center ${shortTermFilter === 'overextended' ? 'bg-danger text-on-danger font-extrabold' : 'text-on-surface-base hover:bg-surface-elevated'}`}
                  >
                    ⚡ OVEREXTENDED
                  </button>
                </div>

                <span className="h-filter-md w-[9.5rem] shrink-0 px-3 text-xs font-mono font-bold tabular-nums text-muted bg-surface-sink/60 border border-border-surface-elevated uppercase flex items-center justify-end tracking-tight">
                  {filteredTickers.length} / {sortedTickers.length} STOCKS
                </span>
              </div>
            </div>
          </div>

          <div className="bg-surface-base">
            <div 
              data-testid="tickers-grid"
              className={`p-3 md:p-4 grid gap-2.5 md:gap-3 transition-all duration-300 ${
                selectedTicker 
                  ? 'grid-cols-2 lg:grid-cols-3' 
                  : 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6'
              }`}>
              {filteredTickers.map((t) => (
                <TickerCard 
                  key={t.ticker}
                  t={t}
                  isSelected={selectedTicker === t.ticker}
                  onSelect={() => {
                    setSelectedTicker(selectedTicker === t.ticker ? null : t.ticker)
                  }}
                />
              ))}
 
              {filteredTickers.length === 0 && filter && (
                <div className="col-span-full py-12 md:py-16 text-center text-on-surface-base font-mono text-xs uppercase tracking-widest opacity-50">
                  No tickers match "{filter}"
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Detail Panel - Mobile: Fixed Full Screen | Desktop: 40% Side Panel */}
      <Surface 
        surface="elevated"
        className={`fixed lg:relative inset-0 lg:inset-auto h-full transition-all duration-300 ease-in-out border-l z-50 lg:z-30 shadow-2xl ${
          selectedTicker ? 'w-full lg:w-2/5' : 'w-0 opacity-0 pointer-events-none'
        }`}
      >
        {selectedTicker && (
          <TickerDetailPanel 
            ticker={selectedTicker} 
            onClose={() => setSelectedTicker(null)} 
          />
        )}
      </Surface>
    </div>
  )
}
