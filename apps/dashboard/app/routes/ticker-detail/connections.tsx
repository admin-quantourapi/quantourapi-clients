import {
  connectionRoleFromPerspective, relatedTicker as relatedOf, 
} from '@quantour/shared-algo/src/finance-algo/connectionEdges'
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
      connections: profileData?.connections || [],
    }
  } catch {
    return {
      symbol,
      ticker: { ticker: symbol, name: symbol, sector: 'Technology' },
      connections: [],
    }
  }
}

export default function TickerConnections() {
  const {
    symbol, ticker, connections, 
  } = useLoaderData<typeof loader>()
  const [
    activeFilter,
    setActiveFilter,
  ] = useState<string>('ALL')
  const [
    searchTerm,
    setSearchTerm,
  ] = useState('')

  const filterTypes = [
    'ALL',
    'SUPPLIER',
    'CUSTOMER',
    'COMPETITOR',
    'SYNERGY',
  ]

  // biome-ignore lint/suspicious/noExplicitAny: legacy `any` (migrated from eslint-disable) — typed cleanup pending
  const filtered = connections.filter((c: any) => {
    const matchesFilter = activeFilter === 'ALL' || c.connectionType === activeFilter
    const related = c.fromTicker === symbol ? c.toTicker : c.fromTicker
    const matchesSearch = !searchTerm.trim() ||
      (related && related.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (c.reason && c.reason.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (c.connectionType && c.connectionType.toLowerCase().includes(searchTerm.toLowerCase()))
    return matchesFilter && matchesSearch
  })

  // Statistics counts
  // biome-ignore lint/suspicious/noExplicitAny: legacy `any` (migrated from eslint-disable) — typed cleanup pending
  const countType = (type: string) => connections.filter((c: any) => c.connectionType === type).length

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
            🕸 Supply Chain & Ecosystem Network — <span className="text-info">{symbol}</span>
          </h1>
          <p className="text-xs text-foreground/60 mt-1">
            Complete structural topology of suppliers, enterprise customers, competitors, and strategic synergy partners for {ticker.name || symbol}.
          </p>
        </div>
      </div>

      {/* Summary Category Badges */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="p-4 bg-surface-elevated rounded-xl border border-surface-elevated-border-border">
          <div className="text-xs font-bold text-foreground/40 uppercase mb-1">Suppliers</div>
          <div className="text-xl font-black text-info">{countType('SUPPLIER')}</div>
          <p className="text-micro text-foreground/50 mt-1">Component & vendor providers</p>
        </div>

        <div className="p-4 bg-surface-elevated rounded-xl border border-surface-elevated-border-border">
          <div className="text-xs font-bold text-foreground/40 uppercase mb-1">Customers</div>
          <div className="text-xl font-black text-up">{countType('CUSTOMER')}</div>
          <p className="text-micro text-foreground/50 mt-1">Enterprise buyers & clients</p>
        </div>

        <div className="p-4 bg-surface-elevated rounded-xl border border-surface-elevated-border-border">
          <div className="text-xs font-bold text-foreground/40 uppercase mb-1">Competitors</div>
          <div className="text-xl font-black text-warning">{countType('COMPETITOR')}</div>
          <p className="text-micro text-foreground/50 mt-1">Market share rivals</p>
        </div>

        <div className="p-4 bg-surface-elevated rounded-xl border border-surface-elevated-border-border">
          <div className="text-xs font-bold text-foreground/40 uppercase mb-1">Synergies</div>
          <div className="text-xl font-black text-accent">{countType('SYNERGY')}</div>
          <p className="text-micro text-foreground/50 mt-1">Co-marketing & JV partners</p>
        </div>
      </div>

      {/* Search & Category Filter Controls */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 p-4 bg-surface-elevated rounded-xl border border-surface-elevated-border-border">
        <div className="relative flex-1 max-w-md w-full">
          <input
            type="text"
            placeholder="Search connections by ticker or rationale..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full px-4 py-2 bg-surface-base border border-border/20 rounded-lg text-xs focus:outline-none focus:border-info text-foreground"
          />
          {searchTerm && (
            <button 
              onClick={() => setSearchTerm('')}
              className="absolute right-3 top-2.5 text-xs text-foreground/40 hover:text-foreground"
            >
              ✕
            </button>
          )}
        </div>

        <div className="flex flex-wrap gap-1.5 p-1 bg-surface-sink rounded-lg w-full md:w-auto">
          {filterTypes.map((type) => (
            <button
              key={type}
              onClick={() => setActiveFilter(type)}
              className={`px-3 py-1.5 text-micro font-black rounded-md transition-all ${
                activeFilter === type
                  ? 'bg-info text-on-surface-sink shadow-sm'
                  : 'text-foreground/50 hover:text-foreground'
              }`}
            >
              {type} ({type === 'ALL' ? connections.length : countType(type)})
            </button>
          ))}
        </div>
      </div>

      {/* Connection Grid */}
      {filtered.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* biome-ignore lint/suspicious/noExplicitAny: legacy `any` (migrated from eslint-disable) — typed cleanup pending */}
          {filtered.map((c: any) => {
            const relatedTicker = relatedOf(symbol, c)
            const role = connectionRoleFromPerspective(symbol, c)
            const badgeColor = c.connectionType === 'SUPPLIER'
              ? 'bg-info/20 text-info border-info/30'
              : c.connectionType === 'CUSTOMER'
                ? 'bg-up/20 text-up border-up/30'
                : c.connectionType === 'COMPETITOR'
                  ? 'bg-warning/20 text-warning border-warning/30'
                  : 'bg-accent/20 text-accent border-accent/30'

            return (
              <div 
                key={c.id || `${c.fromTicker}-${c.toTicker}`} 
                className="p-5 bg-surface-elevated rounded-xl border border-surface-elevated-border-border hover:border-info/50 transition-all duration-200 shadow-sm flex flex-col justify-between"
              >
                <div>
                  <div className="flex justify-between items-start mb-3">
                    <div>
                      <span className="text-micro font-bold text-foreground/40 uppercase tracking-widest block mb-0.5">
                      {c.connectionType}
                      </span>
                      <Link 
                        to={`/tickers/${relatedTicker}`} 
                        className="text-xl font-black text-info hover:underline flex items-center gap-1.5"
                      >
                        {relatedTicker}
                      </Link>
                    </div>
                    <span className={`text-micro font-black px-2.5 py-1 rounded-md border uppercase tracking-wider ${badgeColor}`}>
                      {role}
                    </span>
                  </div>
                  <p className="text-xs text-foreground/80 italic leading-relaxed bg-surface-base p-3 rounded-lg border border-border/10">
                    "{c.reason}"
                  </p>
                </div>

                <div className="mt-4 pt-3 border-t border-border/10 flex justify-between items-center text-micro text-foreground/40 font-mono">
                  <span>Connection ID #{c.id}</span>
                  <Link to={`/tickers/${relatedTicker}`} className="text-info hover:underline font-bold">
                    View {relatedTicker} →
                  </Link>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="text-center py-16 bg-surface-elevated border border-dashed border-surface-elevated-border-border rounded-2xl">
          <div className="text-3xl mb-2">🕸</div>
          <h3 className="text-sm font-bold text-foreground mb-1">No Connections Found</h3>
          <p className="text-xs text-foreground/50 max-w-sm mx-auto">
            No supply chain or ecosystem connections matched your search term "{searchTerm}" and filter "{activeFilter}".
          </p>
        </div>
      )}
    </div>
  )
}
