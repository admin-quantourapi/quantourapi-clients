import {
  connectionRoleFromPerspective, relatedTicker as relatedOf, 
} from '@quantour/shared-algo/src/finance-algo/connectionEdges'
import {
  useEffect,
  useState,
} from 'react'
import {
  Link,
  useFetcher, 
} from 'react-router'

import { FCFChartWidget } from './FCFChartWidget'
import { ScenarioChartOverlay } from './../ScenarioChartOverlay/ScenarioChartOverlay'

interface CatalystCardProps {
  c: { id: number; ticker: string; eventName: string; eventDate: string; description: string | null; severity: string; isConfirmed: boolean }
  onDelete: (id: number) => void
}

function CatalystCard({
  c,
  onDelete,
}: CatalystCardProps) {
  const eventDate = new Date(c.eventDate)
  const isUpcoming = (eventDate.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24) <= 30
  return (
    <div
      className={`p-3 rounded-lg border flex justify-between items-start gap-3 text-xs ${
        isUpcoming
          ? 'bg-danger/25 border-danger/60 shadow-sm'
          : 'bg-surface-elevated border-border-surface-elevated'
      }`}
    >
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="font-extrabold text-on-surface-elevated text-xs truncate">{c.eventName}</span>
          <span className={`text-micro font-black px-1.5 py-0.5 rounded uppercase tracking-wider ${
            c.severity === 'CRITICAL' ? 'bg-danger text-on-surface-elevated' :
              c.severity === 'HIGH' ? 'bg-primary text-on-surface-elevated' :
                c.severity === 'MEDIUM' ? 'bg-warning text-black' :
                  'bg-info text-black'
          }`}>
            {c.severity}
          </span>
        </div>
        <div className="text-micro font-bold text-accent">
          📅 {eventDate.toLocaleDateString()} {!c.isConfirmed && <span className="text-warning">(UNCONFIRMED)</span>}
        </div>
        {c.description && (
          <p className="text-micro text-on-surface-base/90 font-medium leading-normal italic">
            {c.description}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={() => {
          if (confirm('Delete this event?')) onDelete(c.id)
        }}
        className="text-danger hover:text-danger text-xs shrink-0"
      >
        🗑️
      </button>
    </div>
  )
}

export function TickerDetailPanel({
  ticker,
  onClose,
}: {
  ticker: string
  onClose: () => void
}) {
  const detailsFetcher = useFetcher()
  const actionFetcher = useFetcher()
  const catalystFetcher = useFetcher()

  const [
    isAddingCatalyst,
    setIsAddingCatalyst,
  ] = useState<boolean>(false)
  const [
    showScenarioOverlay,
    setShowScenarioOverlay,
  ] = useState<boolean>(false)
  const [
    showAllCatalysts,
    setShowAllCatalysts,
  ] = useState<boolean>(false)
  const [
    descExpanded,
    setDescExpanded,
  ] = useState<boolean>(false)

  useEffect(() => {
    detailsFetcher.load(`/tickers/${ticker}`)
  }, [
    ticker,
  ])

  useEffect(() => {
    if (actionFetcher.state === 'idle' && actionFetcher.data) {
      detailsFetcher.load(`/tickers/${ticker}`)
    }
  }, [
    actionFetcher.state,
    actionFetcher.data,
    ticker,
  ])

  useEffect(() => {
    if (catalystFetcher.state === 'idle' && catalystFetcher.data?.success) {
      setIsAddingCatalyst(false)
      detailsFetcher.load(`/tickers/${ticker}`)
    }
  }, [
    catalystFetcher.state,
    catalystFetcher.data,
    ticker,
  ])

  const data = detailsFetcher.data as {
    ticker: { ticker?: string; name: string; sector: string; industry?: string; description: string; rdRegion?: string; supplyRegion?: string; marketRegion?: string; growthDriverProfile?: string; tag?: string }
    clusters: Array<{ clusterName: string; sentiment: string | null; rationale: string | null; isHighConviction: boolean | null }>
    analystTargets: { targetMean?: number; targetHigh?: number; targetLow?: number; targetMedian?: number } | null
    connections: Array<{ id: number; fromTicker: string; toTicker: string; connectionType: string; reason: string }>
    matchedEvents: Array<{ id: number; event: string; severity: string; impact: string; rationale: string; description: string | null }>
    sectorScore: number
    regionScore: number
    catalysts?: Array<{ id: number; ticker: string; eventName: string; eventDate: string; description: string | null; severity: string; isConfirmed: boolean }>
    fcfQuarterly?: import('@quantour/shared-algo/src/fcf/types').FcfDataPoint[]
    fcfAnnual?: import('@quantour/shared-algo/src/fcf/types').FcfDataPoint[]
    recentSignals?: Array<{ id: number; action: string; createdAt: string; score: string }>
    currentPrice?: number
    previousClose?: number
    change?: number
    changesPercentage?: number
    vwap?: number
    sma20?: number
    sma10?: number
    rsi?: number
    vwapDev?: number
    shortTermStatus?: string
    shortTermColor?: string
    error?: string
  } | null
  const isLoading = detailsFetcher.state !== 'idle'
 
  const isScanning = (actionFetcher.state !== 'idle') && (actionFetcher.formData?.get('intent') === 'scan')
  const isDeepScanning = (actionFetcher.state !== 'idle') && (actionFetcher.formData?.get('intent') === 'deep_scan')
 
  return (
    <div className="h-full flex flex-col bg-surface-elevated text-on-surface-elevated border-l border-surface-sink-border shadow-2xl overflow-y-auto relative animate-in fade-in slide-in-from-right duration-300 font-mono">
      {isLoading && (
        <div className="absolute inset-0 bg-black/70 backdrop-blur-xs z-30 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent"></div>
            <span className="text-xs font-mono text-primary uppercase tracking-widest animate-pulse">Loading {ticker}...</span>
          </div>
        </div>
      )}
      <div className="sticky top-0 bg-surface-elevated/95 backdrop-blur-md text-on-surface-elevated p-4 border-b border-surface-sink-border flex justify-between items-center z-20">
        <div className="flex items-center gap-2.5 flex-wrap">
          <h2 className="text-2xl font-mono font-bold text-primary tracking-tight">{ticker}</h2>
          {data?.ticker?.sector && (
            <span className="text-micro font-mono font-bold px-2 py-0.5 rounded bg-surface-sink text-primary border border-surface-sink-border uppercase tracking-wider">
              {data.ticker.sector}
            </span>
          )}
          {data?.ticker?.tag && (
            <span className="text-micro font-mono font-bold px-2 py-0.5 rounded bg-surface-sink text-on-surface-elevated/70 border border-surface-sink-border uppercase tracking-wider">
              {data.ticker.tag}
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          className="h-8 w-8 rounded-full bg-surface-sink hover:bg-rose-500/20 text-on-surface-elevated/80 hover:text-rose-400 border border-surface-sink-border hover:border-rose-500/40 transition-all flex items-center justify-center font-mono font-bold text-base cursor-pointer shadow-sm"
          title="Close details sidebar"
          aria-label="Close details sidebar"
        >
          ✕
        </button>
      </div>

      {isLoading && !data ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="animate-spin h-10 w-10 border-2 border-primary border-t-transparent"></div>
        </div>
      ) : (data && data.ticker) ? (
        <div className="p-5 space-y-5 pb-24">
          {/* Company Title & Quick Badges Block */}
          <div className="space-y-2.5">
            <div className="flex justify-between items-start gap-3 flex-wrap">
              <div>
                <h3 className="text-xl font-bold text-on-surface-elevated leading-tight">
                  {data.ticker?.name || data.ticker?.ticker || ticker || 'Unknown Ticker'}
                </h3>
                {data.ticker?.industry && (
                  <p className="text-xs font-mono text-on-surface-elevated/60 tracking-wide mt-0.5">
                    {data.ticker.industry}
                  </p>
                )}
              </div>
              <Link
                to={`/tickers/${ticker}`}
                className="h-filter-md px-3 text-xs font-mono font-bold uppercase tracking-wider bg-accent text-on-accent hover:brightness-110 transition-all flex items-center gap-1.5 shadow-md border border-accent rounded-lg"
                title={`Open Full Deep Analytics Page for ${ticker}`}
              >
                <span>📊</span> MORE DETAILS →
              </Link>
            </div>

            {/* Sub-header Badges: Regions & Growth Profiles */}
            <div className="flex items-center gap-2 flex-wrap text-micro font-mono">
              {data.ticker.rdRegion && (
                <span className="px-2 py-0.5 rounded bg-surface-sink/80 text-on-surface-elevated/70 border border-surface-sink-border">
                  📍 R&D: <strong className="text-on-surface-elevated">{data.ticker.rdRegion}</strong>
                </span>
              )}
              {data.ticker.supplyRegion && (
                <span className="px-2 py-0.5 rounded bg-surface-sink/80 text-on-surface-elevated/70 border border-surface-sink-border">
                  📦 Supply: <strong className="text-on-surface-elevated">{data.ticker.supplyRegion}</strong>
                </span>
              )}
              {data.ticker.marketRegion && (
                <span className="px-2 py-0.5 rounded bg-surface-sink/80 text-on-surface-elevated/70 border border-surface-sink-border">
                  🌐 Market: <strong className="text-on-surface-elevated">{data.ticker.marketRegion}</strong>
                </span>
              )}
            </div>

            {/* Business Description snippet */}
            {data.ticker.description && (
              <p className="text-xs font-mono text-on-surface-elevated/70 leading-relaxed line-clamp-2 bg-surface-sink/30 p-2.5 rounded border border-surface-sink-border/50">
                {data.ticker.description}
              </p>
            )}
          </div>

          {/* Price & Previous Close Banner */}
          <div className="grid grid-cols-2 gap-3 bg-surface-sink/50 p-3.5 border border-surface-sink-border">
            <div>
              <div className="text-micro font-mono text-on-surface-elevated/40 uppercase tracking-wider mb-0.5">Current Price</div>
              <div className="text-xl font-mono font-black text-on-surface-elevated">
                {data.currentPrice != null ? `$${Number(data.currentPrice).toFixed(2)}` : 'N/A'}
              </div>
            </div>
            <div>
              <div className="text-micro font-mono text-on-surface-elevated/40 uppercase tracking-wider mb-0.5">Previous Close</div>
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-xl font-mono font-bold text-on-surface-elevated/80">
                  {data.previousClose != null ? `$${Number(data.previousClose).toFixed(2)}` : 'N/A'}
                </span>
                {data.change != null && data.change !== 0 ? (
                  <span className={`text-xs font-mono font-bold ${data.change >= 0 ? 'text-up' : 'text-down'}`}>
                    {data.change >= 0 ? '+' : ''}${Number(data.change).toFixed(2)} ({data.changesPercentage != null ? (data.changesPercentage >= 0 ? '+' : '') + Number(data.changesPercentage).toFixed(2) : 0}%)
                  </span>
                ) : null}
              </div>
            </div>
          </div>

          {/* Short-Term Technicals & Profit-Taking Assessment */}
          <div className="bg-surface-sink/50 p-3.5 border border-surface-sink-border space-y-3">
            <div className="flex justify-between items-center border-b border-surface-sink-border pb-2">
              <span className="text-micro font-mono text-on-surface-elevated/50 uppercase tracking-widest">Short-Term Behavior</span>
              <span className={`text-xs font-mono ${data.shortTermColor || 'text-warning'}`}>
                {data.shortTermStatus || '⚖️ Balanced Range'}
              </span>
            </div>

            <div className="grid grid-cols-4 gap-2 text-center pt-1">
              <div className="p-2 bg-surface-elevated/40 border border-white/5">
                <div className="text-micro font-mono text-on-surface-elevated/40 uppercase tracking-wider mb-0.5">VWAP</div>
                <div className="text-xs font-mono font-bold text-on-surface-elevated">
                  {data.vwap != null ? `$${Number(data.vwap).toFixed(2)}` : 'N/A'}
                </div>
              </div>
              <div className="p-2 bg-surface-elevated/40 border border-white/5">
                <div className="text-micro font-mono text-on-surface-elevated/40 uppercase tracking-wider mb-0.5">SMA20</div>
                <div className="text-xs font-mono font-bold text-on-surface-elevated">
                  {data.sma20 != null ? `$${Number(data.sma20).toFixed(2)}` : 'N/A'}
                </div>
              </div>
              <div className="p-2 bg-surface-elevated/40 border border-white/5">
                <div className="text-micro font-mono text-on-surface-elevated/40 uppercase tracking-wider mb-0.5">RSI</div>
                <div className={`text-xs font-mono font-bold ${data.rsi != null && data.rsi > 68 ? 'text-down' : data.rsi != null && data.rsi < 32 ? 'text-up' : 'text-on-surface-elevated'}`}>
                  {data.rsi != null ? Number(data.rsi).toFixed(0) : 'N/A'}
                </div>
              </div>
              <div className="p-2 bg-surface-elevated/40 border border-white/5">
                <div className="text-micro font-mono text-on-surface-elevated/40 uppercase tracking-wider mb-0.5">VWAP Dev</div>
                <div className={`text-xs font-mono font-bold ${data.vwapDev != null && data.vwapDev > 2 ? 'text-down' : data.vwapDev != null && data.vwapDev < -2 ? 'text-up' : 'text-on-surface-elevated/80'}`}>
                  {data.vwapDev != null ? `${data.vwapDev >= 0 ? '+' : ''}${Number(data.vwapDev).toFixed(1)}%` : 'N/A'}
                </div>
              </div>
            </div>
          </div>

          {/* Valuation Tag Selector */}
          <div className="flex justify-between items-center bg-surface-sink/40 p-3 border border-surface-sink-border">
            <div className="space-y-0.5">
              <span className="text-micro font-mono text-on-surface-elevated/50 uppercase tracking-wider block">Valuation Tag</span>
              <span className="text-xs font-mono font-bold text-on-surface-elevated capitalize flex items-center gap-1.5">
                {data.ticker.tag ? (
                  <span className={`w-2 h-2 ${
                    data.ticker.tag === 'safe'
                      ? 'bg-cyan-400'
                      : data.ticker.tag === 'growth'
                        ? 'bg-up'
                        : 'bg-down'
                  }`} />
                ) : null}
                {data.ticker.tag || 'No Tag'}
              </span>
            </div>
            <actionFetcher.Form method="post" action={`/tickers/${ticker}`}>
              <input type="hidden" name="intent" value="update_tag" />
              <select
                name="tag"
                value={data.ticker.tag || ''}
                onChange={(e) => {
                  const form = e.target.form
                  if (form) actionFetcher.submit(form)
                }}
                className="text-xs font-mono font-bold px-2 py-1 bg-surface-elevated border border-surface-sink-border text-on-surface-elevated focus:outline-none focus:border-primary cursor-pointer"
              >
                <option value="">None (Avg Mult)</option>
                <option value="safe">Safe (16x P/FCF)</option>
                <option value="growth">Growth (32x P/FCF)</option>
                <option value="hyped">Hyped (50x P/FCF)</option>
              </select>
            </actionFetcher.Form>
          </div>
 
          {/* Regional Footprint */}
          <div className="grid grid-cols-3 gap-2">
            <div className="p-2 bg-surface-sink/40 border border-surface-sink-border text-center">
              <div className="text-micro font-mono font-bold text-on-surface-elevated/50 uppercase mb-0.5 tracking-wider">R&D</div>
              <div className="text-xs font-mono font-bold text-on-surface-elevated truncate">{data.ticker.rdRegion || 'USA'}</div>
            </div>
            <div className="p-2 bg-surface-sink/40 border border-surface-sink-border text-center">
              <div className="text-micro font-mono font-bold text-on-surface-elevated/50 uppercase mb-0.5 tracking-wider">Supply</div>
              <div className="text-xs font-mono font-bold text-on-surface-elevated truncate">{data.ticker.supplyRegion || 'Global'}</div>
            </div>
            <div className="p-2 bg-surface-sink/40 border border-surface-sink-border text-center">
              <div className="text-micro font-mono font-bold text-on-surface-elevated/50 uppercase mb-0.5 tracking-wider">Markets</div>
              <div className="text-xs font-mono font-bold text-on-surface-elevated truncate">{data.ticker.marketRegion || 'Global'}</div>
            </div>
          </div>

          {/* Trends & Regional Risk Scores */}
          <div className="space-y-3 bg-surface-sink/40 p-4 border border-surface-sink-border">
            <h4 className="text-micro font-mono font-bold text-on-surface-elevated/50 uppercase tracking-widest">Trends & Exposure Risk</h4>
            <div className="flex gap-4 justify-between items-center text-xs font-mono">
              <div className="flex items-center gap-1.5 font-bold">
                <span className="text-on-surface-elevated/50">Sector:</span>
                <span className={data.sectorScore > 0 ? 'text-up' : data.sectorScore < 0 ? 'text-down' : 'text-on-surface-elevated/60'}>
                  {data.sectorScore > 0 ? `🟢 Bullish (+${data.sectorScore})` : data.sectorScore < 0 ? `🔴 Bearish (${data.sectorScore})` : '🟡 Neutral'}
                </span>
              </div>
              <div className="flex items-center gap-1.5 font-bold">
                <span className="text-on-surface-elevated/50">Geo Exposure:</span>
                <span className={data.regionScore > 0 ? 'text-up' : data.regionScore < 0 ? 'text-down' : 'text-on-surface-elevated/60'}>
                  {data.regionScore > 0 ? `🟢 Safe (+${data.regionScore})` : data.regionScore < 0 ? `🔴 Exposed (${data.regionScore})` : '🟡 Neutral'}
                </span>
              </div>
            </div>

            {/* Matched active news trends list */}
            {data.matchedEvents && data.matchedEvents.length > 0 && (
              <div className="mt-3 pt-3 border-t border-surface-sink-border space-y-2">
                <div className="text-micro font-mono font-bold text-on-surface-elevated/50 uppercase tracking-wider">Active Geopolitical & Industry Impacts:</div>
                <div className="max-h-36 overflow-y-auto space-y-2 pr-1">
                  {data.matchedEvents.map((e) => {
                    const isPos = e.impact === 'POSITIVE'
                    const isNeg = e.impact === 'NEGATIVE'
                    const textClass = isPos ? 'text-up' : isNeg ? 'text-down' : 'text-on-surface-elevated/50'
                    return (
                      <div key={e.id} className="text-xs font-mono leading-relaxed bg-surface-sink/40 border border-surface-sink-border p-2">
                        <div className="flex justify-between font-bold gap-2">
                          <span className="text-on-surface-elevated truncate">{e.event}</span>
                          <span className={textClass}>{e.impact}</span>
                        </div>
                        <p className="text-on-surface-elevated/60 italic mt-0.5">{e.rationale}</p>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div className="grid grid-cols-2 gap-2">
            <actionFetcher.Form method="post" action="/ticker-search">
              <input type="hidden" name="intent" value="scan" />
              <input type="hidden" name="ticker" value={ticker} />
              <button
                type="submit"
                className="w-full py-2.5 px-3 bg-primary/20 hover:bg-primary/30 border border-primary/50 text-primary font-mono font-bold text-xs uppercase tracking-wider transition-all cursor-pointer flex items-center justify-center gap-1.5"
              >
                📡 {isScanning ? 'SCANNING...' : 'SCAN NOW'}
              </button>
            </actionFetcher.Form>

            <actionFetcher.Form method="post" action="/ticker-search">
              <input type="hidden" name="intent" value="deep_scan" />
              <input type="hidden" name="ticker" value={ticker} />
              <button
                type="submit"
                className="w-full py-2.5 px-3 bg-purple-500/20 hover:bg-purple-500/30 border border-purple-500/50 text-purple-300 font-mono font-bold text-xs uppercase tracking-wider transition-all cursor-pointer flex items-center justify-center gap-1.5"
              >
                🧠 {isDeepScanning ? 'ANALYZING...' : 'DEEP SCAN'}
              </button>
            </actionFetcher.Form>

            <actionFetcher.Form
              method="post"
              action="/ticker-search"
              className="col-span-2 md:col-span-1"
              onSubmit={(e) => {
                if (!confirm(`Delete ${ticker} from pool?`)) e.preventDefault()
              }}
            >
              <input type="hidden" name="intent" value="delete" />
              <input type="hidden" name="ticker" value={ticker} />
              <button
                type="submit"
                className="w-full py-2.5 px-3 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/40 text-down font-mono font-bold text-xs uppercase tracking-wider transition-all cursor-pointer flex items-center justify-center gap-1.5"
              >
                🗑️ DELETE
              </button>
            </actionFetcher.Form>

            <button
              data-testid="backtest-button"
              onClick={() => setShowScenarioOverlay(true)}
              className="col-span-2 md:col-span-1 w-full py-2.5 px-3 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/40 text-cyan-400 font-mono font-bold text-xs uppercase tracking-wider transition-all cursor-pointer flex items-center justify-center gap-1.5"
            >
              📈 BACKTEST
            </button>
          </div>

          <hr className="border-surface-base-border-border" />

          {/* FCF Divergence Chart */}
          {((data.fcfQuarterly && data.fcfQuarterly.length > 0) || (data.fcfAnnual && data.fcfAnnual.length > 0)) && (
            <>
              <FCFChartWidget 
                fcfQuarterly={data.fcfQuarterly || []} 
                fcfAnnual={data.fcfAnnual || []} 
                currentPrice={data.currentPrice}
                analystTargets={data.analystTargets}
                growthDriverProfile={data.ticker?.growthDriverProfile}
              />
              <hr className="border-surface-base-border-border mt-4" />
            </>
          )}

          {/* Clusters & Sector Audit */}
          {data.clusters && data.clusters.length > 0 && (
            <div className="space-y-4">
              <h4 className="text-micro font-black text-foreground/50 uppercase tracking-widest mb-2">Sector & Thematic Audit</h4>
              <div className="space-y-3">
                {data.clusters.map((c) => (
                  <div key={c.clusterName} className="p-4 bg-surface-sink rounded-2xl border border-surface-sink-border">
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-sm font-black text-foreground uppercase tracking-tighter">{c.clusterName}</span>
                      {c.sentiment && (
                        <span className={`text-micro font-black px-2 py-0.5 rounded-full ${
                          c.sentiment === 'BULLISH' ? 'bg-up/15 text-up' :
                            c.sentiment === 'BEARISH' ? 'bg-down/15 text-down' :
                              'bg-surface-elevated text-foreground'
                        }`}>
                          {c.sentiment}
                        </span>
                      )}
                    </div>
                    {c.rationale && (
                      <p className="text-micro text-foreground/60 leading-relaxed italic">"{c.rationale}"</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Analyst Targets Grid */}
          {data.analystTargets && (
            <div className="space-y-3">
              <h4 className="text-micro font-black text-foreground/50 uppercase tracking-widest">Analyst Price Estimates</h4>
              <div className="p-4 bg-info/5 rounded-2xl border border-info/15">
                <div className="grid grid-cols-2 gap-4">
                  <div className="text-center p-2">
                    <div className="text-micro font-black text-foreground/50 uppercase tracking-tighter mb-1">Mean Consensus</div>
                    <div className="text-xl font-black text-info">
                      {data.analystTargets.targetMean && parseFloat(String(data.analystTargets.targetMean)) > 0
                        ? `$${parseFloat(String(data.analystTargets.targetMean)).toFixed(2)}`
                        : 'N/A'}
                    </div>
                  </div>
                  <div className="text-center p-2 border-l border-info/15">
                    <div className="text-micro font-black text-foreground/50 uppercase tracking-tighter mb-1">High Target</div>
                    <div className="text-xl font-black text-up">
                      {data.analystTargets.targetHigh && parseFloat(String(data.analystTargets.targetHigh)) > 0
                        ? `$${parseFloat(String(data.analystTargets.targetHigh)).toFixed(2)}`
                        : 'N/A'}
                    </div>
                  </div>
                  <div className="text-center p-2 border-t border-info/15">
                    <div className="text-micro font-black text-foreground/50 uppercase tracking-tighter mb-1">Low Floor</div>
                    <div className="text-xl font-black text-danger">
                      {data.analystTargets.targetLow && parseFloat(String(data.analystTargets.targetLow)) > 0
                        ? `$${parseFloat(String(data.analystTargets.targetLow)).toFixed(2)}`
                        : 'N/A'}
                    </div>
                  </div>
                  <div className="text-center p-2 border-l border-t border-info/15">
                    <div className="text-micro font-black text-foreground/50 uppercase tracking-tighter mb-1">Median</div>
                    <div className="text-xl font-black text-foreground">
                      {data.analystTargets.targetMedian && parseFloat(String(data.analystTargets.targetMedian)) > 0
                        ? `$${parseFloat(String(data.analystTargets.targetMedian)).toFixed(2)}`
                        : 'N/A'}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}


          {/* Supply Chain */}
          {data.connections && data.connections.length > 0 && (
            <div>
              <h4 className="text-micro font-black text-foreground/50 uppercase tracking-widest mb-3">Supply Chain Highlights</h4>
              <div className="space-y-3">
                {data.connections.slice(0, 3).map((c) => {
                  const relatedTicker = relatedOf(ticker, c)
                  const role = connectionRoleFromPerspective(ticker, c)
                  return (
                    <div key={c.id} className="p-4 bg-surface-elevated rounded-xl border border-surface-elevated-border hover:border-info/30 transition-colors">
                      <div className="flex justify-between items-center mb-1">
                        <span className="text-sm font-black text-info">{relatedTicker}</span>
                        <span className="text-micro font-black px-2 py-0.5 bg-surface-sink text-on-surface-sink border border-surface-sink-border rounded-full uppercase">{role}</span>
                      </div>
                      <p className="text-micro text-foreground/60 leading-relaxed italic">"{c.reason.substring(0, 85)}..."</p>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Catalysts & Releases Timeline */}
          <div className="space-y-3">
            <div className="flex justify-between items-center mb-1">
              <h4 className="text-micro font-black text-foreground/50 uppercase tracking-widest">Catalyst Timeline</h4>
              <button
                type="button"
                onClick={() => setIsAddingCatalyst(!isAddingCatalyst)}
                className="text-micro font-bold text-info hover:underline"
              >
                {isAddingCatalyst ? 'Cancel' : '➕ Add Catalyst'}
              </button>
            </div>

            {isAddingCatalyst && (
              <catalystFetcher.Form
                method="post"
                action={`/tickers/${ticker}`}
                className="mb-4 p-3 bg-surface-sink rounded-xl border border-surface-sink-border space-y-2"
              >
                <input type="hidden" name="intent" value="add_catalyst" />
 
                <div>
                  <label className="block text-micro font-black text-foreground/50 uppercase mb-0.5">Event Name *</label>
                  <input
                    type="text"
                    name="eventName"
                    required
                    placeholder="e.g. GTA 6 Release"
                    className="w-full p-1.5 text-xs rounded border border-surface-sink-border bg-surface-elevated text-on-surface-elevated text-foreground"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-micro font-black text-foreground/50 uppercase mb-0.5">Event Date *</label>
                    <input
                      type="date"
                      name="eventDate"
                      required
                      className="w-full p-1.5 text-xs rounded border border-surface-sink-border bg-surface-elevated text-on-surface-elevated text-foreground"
                    />
                  </div>
                  <div>
                    <label className="block text-micro font-black text-foreground/50 uppercase mb-0.5">Severity</label>
                    <select
                      name="severity"
                      className="w-full p-1.5 text-xs rounded border border-surface-sink-border bg-surface-elevated text-on-surface-elevated text-foreground"
                    >
                      <option value="LOW">LOW</option>
                      <option value="MEDIUM">MEDIUM</option>
                      <option value="HIGH">HIGH</option>
                      <option value="CRITICAL">CRITICAL</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-micro font-black text-foreground/50 uppercase mb-0.5">Description</label>
                  <textarea
                    name="description"
                    rows={2}
                    placeholder="e.g., launch date or clinical trial date..."
                    className="w-full p-1.5 text-xs rounded border border-surface-sink-border bg-surface-elevated text-on-surface-elevated text-foreground"
                  />
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    name="isConfirmed"
                    id="panelIsConfirmed"
                    value="true"
                    defaultChecked
                    className="rounded text-info focus:ring-info"
                  />
                  <label htmlFor="panelIsConfirmed" className="text-micro text-foreground/80">Confirmed</label>
                </div>

                <div className="flex justify-end pt-1">
                  <button
                    type="submit"
                    disabled={catalystFetcher.state === 'submitting'}
                    className="px-3 py-1 text-micro font-black bg-info hover:bg-info text-on-surface-sink rounded transition disabled:opacity-50"
                  >
                    {catalystFetcher.state === 'submitting' ? 'Saving...' : 'Save Event'}
                  </button>
                </div>
              </catalystFetcher.Form>
            )}

            {data.catalysts && data.catalysts.length > 0 ? (() => {
              const now = Date.now()
              const sorted = data.catalysts!.slice().sort((a, b) => Math.abs(new Date(a.eventDate).getTime() - now) - Math.abs(new Date(b.eventDate).getTime() - now))
              const visible = sorted.slice(0, 3)
              const deleteCatalyst = (id: number) => catalystFetcher.submit({
                intent: 'delete_catalyst',
                id: String(id),
              }, {
                action: `/tickers/${ticker}`,
                method: 'post',
              })
              return (
                <>
                  <div className="space-y-2 pr-1">
                    {visible.map((c) => <CatalystCard key={c.id} c={c} onDelete={deleteCatalyst} />)}
                  </div>
                  {sorted.length > 3 && (
                    <button
                      type="button"
                      onClick={() => setShowAllCatalysts(true)}
                      className="mt-2 w-full text-micro font-black uppercase tracking-wider py-1.5 rounded border border-surface-sink-border text-info hover:bg-info/10 transition-colors"
                    >
                      View all {sorted.length} catalysts
                    </button>
                  )}
                </>
              )
            })() : (
              <p className="text-micro text-foreground/50 italic">
                No upcoming catalyst events scheduled.
              </p>
            )}
          </div>

          <hr className="border-surface-base-border-border" />

          {/* Description */}
          <div>
            <h4 className="text-micro font-black text-foreground/50 uppercase tracking-widest mb-3">Company Description</h4>
            {(() => {
              const desc = data.ticker.description || ''
              const limit = 180
              const clamped = desc.length > limit
              const shown = descExpanded || !clamped ? desc : `${desc.slice(0, limit).trimEnd()}…`
              return (
                <p className="text-xs text-foreground/80 leading-relaxed font-medium">
                  {shown}{' '}
                  {clamped && (
                    <button
                      type="button"
                      onClick={() => setDescExpanded(v => !v)}
                      className="text-accent hover:underline font-bold whitespace-nowrap"
                    >
                      {descExpanded ? 'show less' : 'show more'}
                    </button>
                  )}
                </p>
              )
            })()}
          </div>
        </div>
      ) : data?.error ? (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center gap-4">
          <div className="text-4xl">⚠️</div>
          <p className="text-sm font-mono font-bold text-danger uppercase tracking-wider max-w-xs leading-relaxed">{data.error}</p>
          <button
            type="button"
            onClick={() => detailsFetcher.load(`/tickers/${ticker}`)}
            className="mt-2 px-4 py-2 text-xs font-mono font-bold uppercase tracking-wider bg-primary/20 hover:bg-primary/30 border border-primary/50 text-primary transition cursor-pointer"
          >
            ↻ Retry
          </button>
        </div>
      ) : (
        <div className="p-12 text-center text-foreground/50 font-black uppercase tracking-widest text-xs opacity-50">
          Select a stock to view details
        </div>
      )}

      {showScenarioOverlay && (
        <ScenarioChartOverlay
          ticker={ticker}
          fcfData={data?.fcfQuarterly || data?.fcfAnnual || []}
          recentSignals={data?.recentSignals || []}
          onClose={() => setShowScenarioOverlay(false)}
        />
      )}

      {showAllCatalysts && data?.catalysts && data.catalysts.length > 0 && (() => {
        const now = Date.now()
        const sorted = data.catalysts.slice().sort((a, b) => Math.abs(new Date(a.eventDate).getTime() - now) - Math.abs(new Date(b.eventDate).getTime() - now))
        const deleteCatalyst = (id: number) => catalystFetcher.submit({
          intent: 'delete_catalyst',
          id: String(id),
        }, {
          action: `/tickers/${ticker}`,
          method: 'post',
        })
        return (
          <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setShowAllCatalysts(false)}>
            <div className="bg-surface-elevated border border-surface-elevated-border rounded-2xl w-full max-w-lg max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between p-4 border-b border-surface-elevated-border shrink-0">
                <h3 className="text-sm font-black uppercase tracking-widest text-accent">All Catalysts ({sorted.length})</h3>
                <button type="button" onClick={() => setShowAllCatalysts(false)} className="text-foreground/50 hover:text-foreground text-sm cursor-pointer">✕</button>
              </div>
              <div className="p-4 space-y-2 overflow-y-auto">
                {sorted.map((c) => <CatalystCard key={c.id} c={c} onDelete={deleteCatalyst} />)}
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
