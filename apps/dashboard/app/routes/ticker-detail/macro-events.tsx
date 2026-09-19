 
import { fetchFromPublicApi } from 'app/utils/apiClient'
import { useState } from 'react'
import {
  Link, useLoaderData, 
} from 'react-router'

export async function loader({ request, params }: { request: Request; params: { symbol?: string } }) {
  const symbol = params.symbol?.toUpperCase()
  if (!symbol) throw new Response('Not Found', { status: 404 })

  try {
    const res = await fetchFromPublicApi(`/ticker/${symbol}/full-profile`, request)
    const profileData = res?.data && !Array.isArray(res.data) ? res.data : res

    return {
      symbol,
      ticker: profileData?.ticker || { ticker: symbol, name: symbol, sector: 'Technology' },
      matchedEvents: profileData?.matchedEvents || [],
      sectorScore: profileData?.sectorScore ?? 0,
      regionScore: profileData?.regionScore ?? 0,
    }
  } catch {
    return {
      symbol,
      ticker: { ticker: symbol, name: symbol, sector: 'Technology' },
      matchedEvents: [],
      sectorScore: 0,
      regionScore: 0,
    }
  }
}

export default function TickerMacroEvents() {
  const {
    symbol, ticker, matchedEvents, sectorScore, regionScore, 
  } = useLoaderData<typeof loader>()
  const [
    filter,
    setFilter,
  ] = useState<'ALL' | 'POSITIVE' | 'NEGATIVE'>('ALL')
  const [
    searchTerm,
    setSearchTerm,
  ] = useState('')

  const filteredEvents = matchedEvents.filter((e: { event?: string; description?: string; impact?: string }) => {
    const matchesImpact = filter === 'ALL' || e.impact === filter
    const matchesSearch = !searchTerm.trim() || 
      (e.event && e.event.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (e.description && e.description.toLowerCase().includes(searchTerm.toLowerCase()))
    return matchesImpact && matchesSearch
  })

  return (
    <div className="p-6 md:p-8 max-w-7xl mx-auto space-y-8 bg-surface-base min-h-screen text-foreground">
      {/* Top Navigation & Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <Link 
            to={`/tickers/${symbol}`}
            className="inline-flex items-center gap-1 text-xs font-bold text-info hover:underline mb-2 transition"
          >
            ← Back to {symbol} Details
          </Link>
          <h1 className="text-2xl md:text-3xl font-black flex items-center gap-2">
            🌍 Macro Trends & Geopolitical Risk — <span className="text-info">{symbol}</span>
          </h1>
          <p className="text-xs text-foreground/60 mt-1">
            Complete list of active geopolitical events, macro structural shifts, and regional supply chain impacts for {ticker.name || symbol}.
          </p>
        </div>
      </div>

      {/* Summary Score Badges */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="p-4 bg-surface-elevated rounded-xl border border-surface-elevated-border-border">
          <div className="text-xs font-bold text-foreground/40 uppercase mb-1">Sector Trend Score</div>
          <div className="flex items-center gap-2">
            <span className={`text-lg font-black ${sectorScore > 0 ? 'text-up' : sectorScore < 0 ? 'text-down' : 'text-foreground/50'}`}>
              {sectorScore > 0 ? `🟢 Bullish (+${sectorScore})` : sectorScore < 0 ? `🔴 Bearish (${sectorScore})` : '🟡 Neutral (0)'}
            </span>
          </div>
          <p className="text-micro text-foreground/50 mt-1">Impact of macro trends on the active sector/industry.</p>
        </div>

        <div className="p-4 bg-surface-elevated rounded-xl border border-surface-elevated-border-border">
          <div className="text-xs font-bold text-foreground/40 uppercase mb-1">Geopolitical Exposure Score</div>
          <div className="flex items-center gap-2">
            <span className={`text-lg font-black ${regionScore > 0 ? 'text-up' : regionScore < 0 ? 'text-down' : 'text-foreground/50'}`}>
              {regionScore > 0 ? `🟢 Safe (+${regionScore})` : regionScore < 0 ? `🔴 Exposed (${regionScore})` : '🟡 Neutral (0)'}
            </span>
          </div>
          <p className="text-micro text-foreground/50 mt-1">Reflects active news event impacts on R&D, supply chain, or target market regions.</p>
        </div>
      </div>

      {/* Search & Filter Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 bg-surface-elevated rounded-xl border border-surface-elevated-border-border">
        <div className="relative flex-1 max-w-md">
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search macro events or descriptions..."
            className="w-full px-3 py-2 text-xs rounded-lg border border-surface-elevated-border-border bg-surface-base text-foreground focus:outline-none focus:ring-2 focus:ring-info"
          />
        </div>

        <div className="flex items-center gap-1.5 self-start sm:self-auto">
          {([
            'ALL',
            'POSITIVE',
            'NEGATIVE',
          ] as const).map((impactOption) => (
            <button
              key={impactOption}
              onClick={() => setFilter(impactOption)}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg transition ${
                filter === impactOption
                  ? 'bg-info text-on-surface-sink shadow-sm'
                  : 'bg-surface-sink text-foreground/70 hover:bg-surface-sink/80'
              }`}
            >
              {impactOption === 'ALL' ? 'All Events' : impactOption === 'POSITIVE' ? '🟢 Positive' : '🔴 Negative'}
            </button>
          ))}
        </div>
      </div>

      {/* Events List */}
      {filteredEvents.length > 0 ? (
        <div className="space-y-4">
          <div className="text-xs font-bold text-foreground/40 uppercase tracking-widest">
            Showing {filteredEvents.length} of {matchedEvents.length} Matched Events
          </div>
          <div className="space-y-4">
            {filteredEvents.map((e: {
              id: string | number
              event: string
              severity: string
              impact: string
              description?: string
              rationale?: string
            }) => {
              const isPos = e.impact === 'POSITIVE'
              const isNeg = e.impact === 'NEGATIVE'
              const badgeClass = isPos 
                ? 'bg-up/15 text-up' 
                : isNeg 
                  ? 'bg-down/15 text-down' 
                  : 'bg-surface-elevated text-foreground'

              return (
                <div key={e.id} className="p-5 bg-surface-elevated rounded-xl border border-surface-elevated-border-border hover:border-info transition-colors">
                  <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 mb-3">
                    <h3 className="font-black text-base text-foreground dark:text-on-surface-sink">{e.event}</h3>
                    <div className="flex items-center gap-2 self-start sm:self-auto">
                      <span className="text-micro font-bold px-2.5 py-1 bg-surface-sink rounded-full text-foreground/70">
                        Severity: {e.severity}
                      </span>
                      <span className={`text-micro font-black px-2.5 py-1 rounded-full ${badgeClass}`}>
                        {e.impact}
                      </span>
                    </div>
                  </div>

                  {e.description && (
                    <p className="text-xs leading-relaxed text-foreground/80 mb-3">{e.description}</p>
                  )}

                  {e.rationale && (
                    <div className="text-xs text-foreground/70 bg-surface-base p-3 rounded-lg border border-surface-elevated-border-border font-medium italic leading-relaxed">
                      <span className="font-bold not-italic text-foreground/40 block text-micro uppercase tracking-wider mb-1">
                        Exposure Rationale
                      </span>
                      "{e.rationale}"
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <div className="text-center py-12 text-foreground/50 italic text-sm border border-dashed border-surface-elevated-border-border rounded-xl">
          No macro events matched your current search or filter criteria.
        </div>
      )}
    </div>
  )
}
