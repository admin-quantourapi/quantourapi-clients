import {
  connectionRoleFromPerspective, relatedTicker as relatedOf, 
} from '@quantour/shared-algo/src/finance-algo/connectionEdges'
import { FcfDataPointSchema } from '@quantour/shared-algo/src/fcf/types'
import { requireWriteAccess } from 'app/lib/auth-helpers'
import { fetchFromPublicApi } from 'app/utils/apiClient'
import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react'
import {
  Link,
  useFetcher,
} from 'react-router'

import { FCFChartWidget } from '../tickers/components/TickerDetailPanel/FCFChartWidget'

import type { Route } from './+types/ticker-detail'
import { CheckThesisWidget } from './components/CheckThesisWidget/CheckThesisWidget'
import { ProfitTakingLevelsWidget } from './components/ProfitTakingLevelsWidget/ProfitTakingLevelsWidget'
import { SnowflakeRadarChart } from './components/SnowflakeRadarChart/SnowflakeRadarChart'
import { TickerDescription } from './components/TickerDescription/TickerDescription'
import { TickerHeader } from './components/TickerHeader/TickerHeader'

export interface Catalyst {
  id: number
  ticker?: string
  eventName: string
  eventDate: string
  description: string | null
  severity: string
  isConfirmed: boolean
}

function parseFcfArray(value: unknown) {
  const result = FcfDataPointSchema.array().safeParse(value)
  return result.success ? result.data : []
}

export async function loader({ request, params }: Route.LoaderArgs) {
  

  try {
    const symbol = params.symbol?.toUpperCase()
    if (!symbol) {
      throw new Error('Ticker symbol is required')
    }

    const res = await fetchFromPublicApi(`/ticker/${symbol}/full-profile`, request)
    if (!res) {
      return {
        ticker: null,
        theses: [],
        clusters: [],
        connections: [],
        earnings: [],
        dividends: [],
        analystTargets: null,
        recentSignals: [],
        matchedEvents: [],
        sectorScore: 0,
        regionScore: 0,
        catalysts: [],
        fcfQuarterly: [],
        fcfAnnual: [],
        currentPrice: undefined,
        previousClose: undefined,
        change: 0,
        changesPercentage: 0,
        vwap: undefined,
        sma20: undefined,
        sma10: undefined,
        rsi: undefined,
        vwapDev: undefined,
        shortTermStatus: 'Unknown',
        shortTermColor: 'text-foreground/40',
        quote: null,
        error: '⚠️ Backend unreachable — client_api (:3006) / public-api (:3002) is down or rejected the request. Start the stack, then retry.',
      }
    }
    const profileData = res?.data && !Array.isArray(res.data) ? res.data : res
    return {
      ticker: profileData.ticker || { ticker: symbol, name: symbol, sector: 'Technology' },
      theses: profileData.theses || [],
      clusters: profileData.clusters || [],
      connections: profileData.connections || [],
      earnings: profileData.earnings || [],
      dividends: profileData.dividends || [],
      analystTargets: profileData.analystTargets || null,
      recentSignals: profileData.recentSignals || [],
      matchedEvents: profileData.matchedEvents || [],
      sectorScore: profileData.sectorScore ?? 0,
      regionScore: profileData.regionScore ?? 0,
      catalysts: profileData.catalysts || [],
      fcfQuarterly: parseFcfArray(profileData.fcfQuarterly),
      fcfAnnual: parseFcfArray(profileData.fcfAnnual),
      currentPrice: profileData.currentPrice || undefined,
      previousClose: profileData.previousClose || undefined,
      change: profileData.change || 0,
      changesPercentage: profileData.changesPercentage || 0,
      vwap: profileData.vwap || undefined,
      sma20: profileData.sma20 || undefined,
      sma10: profileData.sma10 || undefined,
      rsi: profileData.rsi || undefined,
      vwapDev: profileData.vwapDev || undefined,
      atr: profileData.atr || undefined,
      shortTermStatus: profileData.shortTermStatus || '⚖️ Balanced Range',
      shortTermColor: profileData.shortTermColor || 'text-warning-400',
      quote: profileData.quote || null,
      moatAnalysis: profileData.moatAnalysis || null,
      error: undefined,
    }
  } catch (error) {
    if (error instanceof Response) throw error
    if (error instanceof Error && error.message.includes('Not Found')) {
      // Gracefully handle 404 without error logging
      return {
        ticker: null,
        theses: [],
        clusters: [],
        connections: [],
        earnings: [],
        dividends: [],
        analystTargets: null,
        recentSignals: [],
        matchedEvents: [],
        sectorScore: 0,
        regionScore: 0,
        catalysts: [],
        fcfQuarterly: [],
        fcfAnnual: [],
        currentPrice: undefined,
        previousClose: undefined,
        change: 0,
        changesPercentage: 0,
        vwap: undefined,
        sma20: undefined,
        sma10: undefined,
        rsi: undefined,
        vwapDev: undefined,
        atr: undefined,
        shortTermStatus: 'Unknown',
        shortTermColor: 'text-foreground/40',
        quote: null,
        error: 'Ticker not found',
      }
    }
    console.error('[TICKER DETAIL LOADER ERROR]', error)
    return {
      ticker: null,
      theses: [],
      clusters: [],
      connections: [],
      earnings: [],
      dividends: [],
      analystTargets: null,
      recentSignals: [],
      matchedEvents: [],
      sectorScore: 0,
      regionScore: 0,
      catalysts: [],
      fcfQuarterly: [],
      fcfAnnual: [],
      currentPrice: undefined,
      previousClose: undefined,
      change: 0,
      changesPercentage: 0,
      vwap: undefined,
      sma20: undefined,
      sma10: undefined,
      rsi: undefined,
      vwapDev: undefined,
      atr: undefined,
      shortTermStatus: 'Unknown',
      shortTermColor: 'text-foreground/40',
      quote: null,
      error: 'Error loading ticker details: ' + (error as Error).message,
    }
  }
}

export async function action({ request, params }: Route.ActionArgs) {
  await requireWriteAccess(request)
  const { symbol } = params
  const tickerSym = symbol?.toUpperCase() || ''

  const formData = await request.formData()
  const intent = formData.get('intent')

  const apiFetch = async (endpoint: string, payload: Record<string, unknown>, method = 'POST') => {
    return fetchFromPublicApi(endpoint, request, {
      method,
      body: JSON.stringify(payload),
    })
  }

  try {
    if (intent === 'update_tag') {
      const tag = formData.get('tag')?.toString() || null
      await apiFetch(`/ticker/${tickerSym}/tag`, { tag })
      return { success: true, intent: 'update_tag' }
    }

    if (intent === 'check_thesis') {
      const thesis = formData.get('thesis') as string
      // In phase 3 we'll move the geminiService validateCompanyThesis to the backend API.
      // For now we mock the call to the future API endpoint
      const result = await apiFetch(`/ticker/${tickerSym}/thesis/validate`, { thesis })
      return {
        success: true,
        intent: 'check_thesis',
        originalThesis: thesis,
        ...result,
      }
    }

    if (intent === 'save_thesis') {
      const thesis = formData.get('thesis') as string
      await apiFetch(`/ticker/${tickerSym}/thesis`, { thesis })
      return { success: true, intent: 'save_thesis' }
    }

    if (intent === 'add_catalyst') {
      const eventName = formData.get('eventName') as string
      const eventDateStr = formData.get('eventDate') as string
      const description = formData.get('description') as string || ''
      const severity = formData.get('severity') as string || 'HIGH'
      const isConfirmed = formData.get('isConfirmed') === 'true'

      if (!eventName || !eventDateStr) return { success: false, error: 'Event Name and Date are required' }

      await apiFetch(`/ticker/${tickerSym}/catalysts`, {
        eventName,
        eventDate: eventDateStr,
        description,
        severity,
        isConfirmed,
      })
      return { success: true, intent: 'add_catalyst' }
    }

    if (intent === 'delete_catalyst') {
      const idStr = formData.get('id') as string
      const id = parseInt(idStr)
      if (isNaN(id)) return { success: false, error: 'Invalid Catalyst ID' }

      await apiFetch(`/market/catalysts/${id}`, {}, 'DELETE')
      return { success: true, intent: 'delete_catalyst' }
    }

    return { success: false, error: 'Unknown intent' }
  } catch (e: unknown) {
    return { success: false, error: (e as Error).message || 'Action failed' }
  }
}

type ActionData =
 | { success: true; intent: 'check_thesis'; originalThesis: string; isAccurate: boolean; analysis: string; editedThesis: string }
 | { success: true; intent: 'save_thesis' }
 | { success: true; intent: 'add_catalyst' }
 | { success: true; intent: 'delete_catalyst' }
 | { success: false; error: string; intent?: undefined }

export default function TickerDetail({ loaderData }: Route.ComponentProps) {
  const { 
    ticker, 
    theses, 
    clusters, 
    connections, 
    earnings: tickerEarnings, 
    dividends: tickerDividends,
    analystTargets,
    recentSignals,
    matchedEvents,
    sectorScore,
    regionScore,
    catalysts,
    fcfQuarterly,
    fcfAnnual,
    currentPrice,
    moatAnalysis,
  } = loaderData || {}

  if (!ticker) {
    return (
      <div className="p-8 text-center bg-surface-base min-h-screen text-foreground">
        <h2 className="text-2xl font-bold text-danger mb-4">Ticker Not Found</h2>
        <p className="text-foreground/70 mb-6">
          The requested ticker could not be found or you do not have permission to view it.
        </p>
      </div>
    )
  }
  const [
    activeFilter,
    setActiveFilter,
  ] = useState<string>('ALL')

  useEffect(() => {
    const saved = localStorage.getItem('connectionsGraphFilter')
    if (saved) {
      setActiveFilter(saved)
    }
  }, [])

  const handleSetFilter = (type: string) => {
    setActiveFilter(type)
    localStorage.setItem('connectionsGraphFilter', type)
  }
  const fetcher = useFetcher<typeof action>()
  const [
    isEditing,
    setIsEditing,
  ] = useState<boolean>(false)
  const [
    editContent,
    setEditContent,
  ] = useState<string>('')
  const [
    checkResult,
    setCheckResult,
  ] = useState<ActionData | null>(null)

  const [
    isAddingCatalyst,
    setIsAddingCatalyst,
  ] = useState<boolean>(false)

  const [
    showAllCatalysts,
    setShowAllCatalysts,
  ] = useState<boolean>(false)

  // --- Economic moat — lazy on-demand (cached per earnings cycle) ---
  // Moat is generated only when this detail page is opened; stale/missing moat
  // is hidden, never displayed as if current. Auto-fires once on mount.
  const [
    moatOverride,
    setMoatOverride,
  ] = useState<typeof moatAnalysis>(null)
  const [
    moatLoading,
    setMoatLoading,
  ] = useState<boolean>(false)
  const [
    moatError,
    setMoatError,
  ] = useState<string | null>(null)
  const moatGenStartedRef = useRef<boolean>(false)
  const effectiveMoat = moatOverride ?? moatAnalysis
  const hasFreshMoat = !!effectiveMoat?.economicMoat && !effectiveMoat?.isStale

  const generateMoat = useCallback(async (force: boolean) => {
    setMoatLoading(true)
    setMoatError(null)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)
    try {
      const res = await fetch(`/public-api/proxy/ticker/${ticker.ticker}/moat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force }),
        signal: controller.signal,
      })
      if (res.status === 202) {
        // Another request is generating upstream — keep the spinner and retry.
        setTimeout(() => { void generateMoat(false) }, 2500)
        return
      }
      const data = await res.json().catch(() => null) as { moat?: typeof moatAnalysis; error?: string } | null
      if (res.ok && data?.moat) {
        setMoatOverride(data.moat)
        setMoatLoading(false)
        return
      }
      throw new Error(data?.error || 'Moat generation failed')
    } catch (e) {
      setMoatError(e instanceof Error ? e.message : String(e))
      setMoatLoading(false)
    } finally {
      clearTimeout(timeout)
    }
  }, [
    ticker.ticker,
  ])

  useEffect(() => {
    if (moatGenStartedRef.current) return
    if (!hasFreshMoat) {
      moatGenStartedRef.current = true
      void generateMoat(false)
    }
  }, [
    hasFreshMoat,
    generateMoat,
  ])

  const sortedCatalysts = useMemo<Catalyst[]>(() => ([
    ...(catalysts as Catalyst[]),
  ].sort((a, b) => {
    const now = Date.now()
    return Math.abs(new Date(a.eventDate).getTime() - now) - Math.abs(new Date(b.eventDate).getTime() - now)
  })), [
    catalysts,
  ])
  const displayedCatalysts = showAllCatalysts ? sortedCatalysts : sortedCatalysts.slice(0, 3)

  const upcomingCatalyst = useMemo<Catalyst | undefined>(() => {
    const today = new Date()
    return (catalysts as Catalyst[]).find((c) => {
      const eventTime = new Date(c.eventDate).getTime()
      const diffDays = (eventTime - today.getTime()) / (1000 * 60 * 60 * 24)
      return diffDays >= 0 && diffDays <= 30
    })
  }, [
    catalysts,
  ])

  const companyThesis = useMemo(() => {
    // biome-ignore lint/suspicious/noTsIgnore: legacy @ts-ignore kept for tsc (migrated from eslint-disable)
    // @ts-ignore - TS strict fix
    return theses.find(t => t.scope === 'TICKER' && t.target.toUpperCase() === ticker.ticker.toUpperCase())
  }, [
    theses,
    ticker.ticker,
  ])

  const otherTheses = useMemo(() => {
    // biome-ignore lint/suspicious/noTsIgnore: legacy @ts-ignore kept for tsc (migrated from eslint-disable)
    // @ts-ignore - TS strict fix
    return theses.filter(t => !(t.scope === 'TICKER' && t.target.toUpperCase() === ticker.ticker.toUpperCase()))
  }, [
    theses,
    ticker.ticker,
  ])

  const handleStartEdit = () => {
    setEditContent(companyThesis?.content || '')
    setIsEditing(true)
    setCheckResult(null)
  }

  const handleDiscard = () => {
    setIsEditing(false)
    setCheckResult(null)
  }

  useEffect(() => {
    // biome-ignore lint/suspicious/noTsIgnore: legacy @ts-ignore kept for tsc (migrated from eslint-disable)
    // @ts-ignore - TS strict fix
    if (fetcher.data?.success && fetcher.data?.intent === 'check_thesis') {
      setCheckResult(fetcher.data as ActionData)
    }
  }, [
    fetcher.data,
  ])

  useEffect(() => {
    // biome-ignore lint/suspicious/noTsIgnore: legacy @ts-ignore kept for tsc (migrated from eslint-disable)
    // @ts-ignore - TS strict fix
    if (fetcher.data?.success && fetcher.data?.intent === 'save_thesis') {
      setIsEditing(false)
      setCheckResult(null)
    }
  }, [
    fetcher.data,
  ])

  useEffect(() => {
    // biome-ignore lint/suspicious/noTsIgnore: legacy @ts-ignore kept for tsc (migrated from eslint-disable)
    // @ts-ignore - TS strict fix
    if (fetcher.data?.success && fetcher.data?.intent === 'add_catalyst') {
      setIsAddingCatalyst(false)
    }
  }, [
    fetcher.data,
  ])

  const filteredConnections = useMemo(() => {
    if (activeFilter === 'ALL') return connections
    // biome-ignore lint/suspicious/noExplicitAny: legacy `any` (migrated from eslint-disable) — typed cleanup pending
    return connections.filter((c: any) => c.connectionType === activeFilter)
  }, [
    connections,
    activeFilter,
  ])

  const filterTypes = [
    'ALL',
    'SUPPLIER',
    'CUSTOMER',
    'COMPETITOR',
    'SYNERGY',
  ]

  return (
    <div className="p-8 mx-auto space-y-8">
      <div className="mb-6">
        <Link to="/" className="text-info hover:underline font-medium">← Back to Scanning Pool</Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left Column: Core Info & Description */}
        <div className="lg:col-span-2 space-y-8">
          <div className="bg-surface-elevated p-8 rounded-2xl shadow-xl border border-surface-elevated-border-border">
            {upcomingCatalyst && (
              <div className="mb-6 p-4 bg-danger/10 border-2 border-danger rounded-xl flex items-center justify-between">
                <div>
                  <div className="text-micro font-black text-danger uppercase tracking-widest">⚠️ Upcoming Binary Event Warning</div>
                  <div className="text-sm font-bold text-foreground dark:text-on-surface-sink mt-0.5">
                    "{upcomingCatalyst.eventName}" scheduled for {new Date(upcomingCatalyst.eventDate).toLocaleDateString()}
                  </div>
                  {upcomingCatalyst.description && (
                    <div className="text-xs text-foreground/50 mt-1">
                      {upcomingCatalyst.description}
                    </div>
                  )}
                </div>
                <span className="text-micro font-black px-2 py-0.5 bg-danger text-on-surface-sink rounded uppercase">
                  {upcomingCatalyst.severity}
                </span>
              </div>
            )}
            <TickerHeader ticker={ticker.ticker} name={ticker.name} />
            <div className="mt-4 flex flex-wrap gap-2">
              <span className="px-3 py-1 bg-info/15 text-info text-xs font-bold rounded-full uppercase tracking-wider">
                {ticker.sector}
              </span>
              {ticker.beta && (
                <span className="px-3 py-1 bg-special dark:bg-special/40 text-special dark:text-special text-xs font-bold rounded-full">
                  Beta: {parseFloat(ticker.beta).toFixed(2)}
                </span>
              )}
              {ticker.isDefensive && (
                <span className="px-3 py-1 bg-up/15 text-up text-xs font-bold rounded-full">
                  🛡️ Defensive
                </span>
              )}
              {hasFreshMoat && effectiveMoat?.windLabel && effectiveMoat.windLabel !== 'NEUTRAL' && (
                <span
                  className={`px-3 py-1 text-xs font-bold rounded-full border ${
                    effectiveMoat.windLabel === 'TAILWIND'
                      ? 'bg-up/15 text-up border-up/20'
                      : 'bg-warning/15 text-warning border-warning/20'
                  }`}
                  title="Research context only — does not validate trade setups"
                >
                  {effectiveMoat.windLabel === 'TAILWIND' ? '🏰 Moat ↑' : '🏰 Moat ↓'}
                </span>
              )}
            </div>

            {/* Economic moat — lazy on-demand; stale/missing moat is hidden */}
            {moatLoading ? (
              <div className="mt-6 pt-6 border-t border-surface-elevated-border-border">
                <div className="flex items-center gap-2 text-sm text-foreground/60">
                  <svg className="animate-spin h-4 w-4 text-accent" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <span className="font-mono uppercase tracking-wider">Generating economic moat…</span>
                </div>
              </div>
            ) : hasFreshMoat ? (
              <div className="mt-6 pt-6 border-t border-surface-elevated-border-border space-y-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <h3 className="text-sm font-bold text-foreground/40 uppercase tracking-widest">
                    Economic moat
                    <span className="ml-2 font-medium normal-case tracking-normal text-foreground/30">(context only)</span>
                  </h3>
                  {effectiveMoat?.windLabel && (
                    <span className={`text-micro font-mono font-bold px-2 py-0.5 rounded border ${
                      effectiveMoat.windLabel === 'TAILWIND'
                        ? 'text-up border-up/30 bg-up/10'
                        : effectiveMoat.windLabel === 'HEADWIND'
                          ? 'text-warning border-warning/30 bg-warning/10'
                          : 'text-foreground/50 border-border'
                    }`}>
                      {effectiveMoat.windLabel}
                      {typeof effectiveMoat.moatWindScore === 'number' ? ` ${effectiveMoat.moatWindScore.toFixed(2)}` : ''}
                      {typeof effectiveMoat.moatStrength === 'number' ? ` · str ${effectiveMoat.moatStrength.toFixed(2)}` : ''}
                    </span>
                  )}
                </div>
                <p className="text-sm text-foreground/75 leading-relaxed font-sans">
                  {effectiveMoat?.economicMoat}
                </p>
                {effectiveMoat?.moatThreats && (
                  <p className="text-xs text-warning/90 leading-relaxed font-sans">
                    <span className="font-bold uppercase tracking-wider">Threats: </span>
                    {effectiveMoat.moatThreats}
                  </p>
                )}
                <button
                  onClick={() => void generateMoat(true)}
                  className="mt-1 px-2.5 py-1 text-xs font-bold text-foreground/60 bg-surface-elevated border border-border rounded hover:text-foreground hover:border-accent transition-colors"
                >
                  ↻ Refresh moat
                </button>
              </div>
            ) : (
              <div className="mt-6 pt-6 border-t border-surface-elevated-border-border">
                {moatError ? (
                  <p className="text-xs text-danger/90 leading-relaxed font-sans">
                    <span className="font-bold uppercase tracking-wider">Moat generation failed: </span>
                    {moatError}
                  </p>
                ) : (
                  <p className="text-xs text-foreground/40 leading-relaxed font-sans">
                    No economic moat analysis cached yet — cached per earnings cycle once generated.
                  </p>
                )}
                <button
                  onClick={() => void generateMoat(true)}
                  className="mt-2 px-3 py-1.5 text-xs font-mono font-bold uppercase tracking-wider bg-accent text-on-accent border border-accent rounded hover:brightness-110 transition"
                >
                  ⚡ Generate moat
                </button>
              </div>
            )}

            {/* Regional Footprint */}
            <div className="mt-6 pt-6 border-t border-surface-elevated-border-border">
              <h3 className="text-sm font-bold text-foreground/40 uppercase tracking-widest mb-4">Regional Footprint</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="p-3 bg-surface-elevated rounded-lg border border-surface-elevated-border-border">
                  <div className="text-micro font-bold text-foreground/50 uppercase mb-1">R&D / Innovation</div>
                  <div className="text-sm font-semibold text-foreground">{ticker.rdRegion || 'Pending Analysis...'}</div>
                </div>
                <div className="p-3 bg-surface-elevated rounded-lg border border-surface-elevated-border-border">
                  <div className="text-micro font-bold text-foreground/50 uppercase mb-1">Supply / Mfg</div>
                  <div className="text-sm font-semibold text-foreground">{ticker.supplyRegion || 'Pending Analysis...'}</div>
                </div>
                <div className="p-3 bg-surface-elevated rounded-lg border border-surface-elevated-border-border">
                  <div className="text-micro font-bold text-foreground/50 uppercase mb-1">Target Markets</div>
                  <div className="text-sm font-semibold text-foreground">{ticker.marketRegion || 'Pending Analysis...'}</div>
                </div>
              </div>
            </div>

            {((fcfQuarterly && fcfQuarterly.length > 0) || (fcfAnnual && fcfAnnual.length > 0)) && (
              <div className="mt-6 pt-6 border-t border-surface-elevated-border-border">
                <FCFChartWidget 
                  fcfQuarterly={fcfQuarterly} 
                  fcfAnnual={fcfAnnual} 
                  currentPrice={currentPrice}
                  analystTargets={analystTargets}
                  growthDriverProfile={ticker.growthDriverProfile}
                />
              </div>
            )}

            <TickerDescription description={ticker.description} />
          </div>

          {/* Macro Trends & Geopolitical Risk */}
          <div className="bg-surface-elevated p-6 rounded-2xl shadow-lg border border-surface-elevated-border-border">
            <h2 className="text-lg font-black text-foreground dark:text-on-surface-sink mb-4 flex items-center gap-2">
              🌍 Macro Trends & Geopolitical Risk
            </h2>
 
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
              <div className="p-4 bg-surface-elevated rounded-xl border border-surface-elevated-border-border">
                <div className="text-xs font-bold text-foreground/40 uppercase mb-1">Sector Trend Score</div>
                <div className="flex items-center gap-2">
                  <span className={`text-lg font-black ${sectorScore > 0 ? 'text-up' : sectorScore < 0 ? 'text-down' : 'text-foreground/50'}`}>
                    {sectorScore > 0 ? `🟢 Bullish (+${sectorScore})` : sectorScore < 0 ? `🔴 Bearish (${sectorScore})` : '🟡 Neutral (0)'}
                  </span>
                </div>
                <p className="text-micro text-foreground/50 mt-1">Based on current active news events impacting this sector/industry.</p>
              </div>

              <div className="p-4 bg-surface-elevated rounded-xl border border-surface-elevated-border-border">
                <div className="text-xs font-bold text-foreground/40 uppercase mb-1">Geopolitical Exposure Score</div>
                <div className="flex items-center gap-2">
                  <span className={`text-lg font-black ${regionScore > 0 ? 'text-up' : regionScore < 0 ? 'text-down' : 'text-foreground/50'}`}>
                    {regionScore > 0 ? `🟢 Safe (+${regionScore})` : regionScore < 0 ? `🔴 Exposed (${regionScore})` : '🟡 Neutral (0)'}
                  </span>
                </div>
                <p className="text-micro text-foreground/50 mt-1">Reflects active news event impacts on R&D, supply, or target regions.</p>
              </div>
            </div>

            {matchedEvents && matchedEvents.length > 0 ? (
              <div className="space-y-3">
                <div className="flex justify-between items-center mb-2">
                  <h3 className="text-xs font-bold text-foreground/40 uppercase tracking-widest">Active Regional & Sector Impacts</h3>
                  {matchedEvents.length > 3 && (
                    <span className="text-micro font-bold text-foreground/50">Showing 3 of {matchedEvents.length}</span>
                  )}
                </div>
                <div className="space-y-3">
                  {/* biome-ignore lint/suspicious/noExplicitAny: legacy `any` (migrated from eslint-disable) — typed cleanup pending */}
                  {matchedEvents.slice(0, 3).map((e: any) => {
                    const isPos = e.impact === 'POSITIVE'
                    const isNeg = e.impact === 'NEGATIVE'
                    const badgeClass = isPos 
                      ? 'bg-up/15 text-up' 
                      : isNeg 
                        ? 'bg-down/15 text-down' 
                        : 'bg-surface-elevated text-foreground'
                    return (
                      <div key={e.id} className="p-4 bg-surface-elevated rounded-xl border border-surface-elevated-border-border hover:border-surface-elevated-border-border transition-colors">
                        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 mb-2">
                          <h4 className="font-bold text-sm text-foreground dark:text-on-surface-sink">{e.event}</h4>
                          <div className="flex items-center gap-2 self-start sm:self-auto">
                            <span className="text-micro font-bold px-2 py-0.5 bg-surface-sink rounded-full text-foreground/70">
                              Severity: {e.severity}
                            </span>
                            <span className={`text-micro font-black px-2 py-0.5 rounded-full ${badgeClass}`}>
                              {e.impact}
                            </span>
                          </div>
                        </div>
                        {e.description && (
                          <p className="text-xs text-foreground/70 mb-2">{e.description}</p>
                        )}
                        <div className="text-micro text-foreground/50 bg-surface-elevated p-2.5 rounded-lg border border-surface-elevated-border-border font-medium italic leading-relaxed">
                          <span className="font-bold not-italic text-foreground/40 block text-micro uppercase tracking-wider mb-1">Exposure Rationale</span>
                          "{e.rationale}"
                        </div>
                      </div>
                    )
                  })}
                </div>
                {matchedEvents.length > 3 && (
                  <div className="pt-2 text-center">
                    <Link
                      to={`/tickers/${ticker.ticker}/macro-events`}
                      className="inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-black text-info bg-info/10 hover:bg-info/20 rounded-xl border border-info/30 transition-all duration-200"
                    >
                      Show All {matchedEvents.length} Macro Events →
                    </Link>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center py-6 text-foreground/50 italic text-sm border border-dashed border-surface-elevated-border-border rounded-xl">
                No active geopolitical or sector trend impacts matched for this ticker.
              </div>
            )}
          </div>

          {/* Supply Chain Graph */}
          {connections.length > 0 && (
            <div className="bg-surface-elevated p-6 rounded-2xl shadow-lg border border-surface-elevated-border-border">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6">
                <div className="flex items-center gap-3">
                  <h2 className="text-lg font-black text-foreground dark:text-on-surface-sink flex items-center gap-2">
                    🕸 Supply Chain Connections
                  </h2>
                  {filteredConnections.length > 3 && (
                    <span className="text-micro font-bold text-foreground/50">Showing 3 of {filteredConnections.length}</span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5 p-1 bg-surface-elevated rounded-lg">
                  {filterTypes.map((type) => (
                    <button
                      key={type}
                      onClick={() => handleSetFilter(type)}
                      className={`px-3 py-1 text-micro font-black rounded-md transition-all ${
                        activeFilter === type
                          ? 'bg-info text-on-surface-sink shadow-sm'
                          : 'text-foreground/50 hover:text-foreground dark:hover:text-foreground'
                      }`}
                    >
                      {type}
                    </button>
                  ))}
                </div>
              </div>
 
              {filteredConnections.length > 0 ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* biome-ignore lint/suspicious/noExplicitAny: legacy `any` (migrated from eslint-disable) — typed cleanup pending */}
                    {filteredConnections.slice(0, 3).map((c: any) => {
                      const relatedTicker = relatedOf(ticker.ticker, c)
                      const role = connectionRoleFromPerspective(ticker.ticker, c)
                      return (
                        <div key={c.id} className="p-4 bg-surface-elevated rounded-xl border border-surface-elevated-border-border hover:border-info transition-colors group">
                          <div className="flex justify-between items-start mb-2">
                            <Link to={`/tickers/${relatedTicker}`} className="text-lg font-black text-info hover:underline">{relatedTicker}</Link>
                            <span className="text-micro font-bold px-2 py-0.5 bg-surface-sink rounded uppercase">
                              {role}
                            </span>
                          </div>
                          <p className="text-xs text-foreground/70 italic leading-relaxed">"{c.reason}"</p>
                        </div>
                      )
                    })}
                  </div>
                  {filteredConnections.length > 3 && (
                    <div className="pt-2 text-center">
                      <Link
                        to={`/tickers/${ticker.ticker}/connections`}
                        className="inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-black text-info bg-info/10 hover:bg-info/20 rounded-xl border border-info/30 transition-all duration-200"
                      >
                        Show All {filteredConnections.length} Supply Chain Connections →
                      </Link>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-center py-8 text-foreground/50 italic text-sm">
                  No {activeFilter.toLowerCase()} connections found.
                </div>
              )}
            </div>
          )}

          {/* Recent Trading Signals */}
          {recentSignals.length > 0 && (
            <div className="bg-surface-elevated p-6 rounded-2xl shadow-lg border border-surface-elevated-border-border">
              <h2 className="text-lg font-black text-foreground dark:text-on-surface-sink mb-4 flex items-center gap-2">
                🚨 Recent Signals
              </h2>
              <div className="space-y-3">
                {/* biome-ignore lint/suspicious/noExplicitAny: legacy `any` (migrated from eslint-disable) — typed cleanup pending */}
                {recentSignals.map((s: any) => (
                  <div key={s.id} className="flex justify-between items-center p-3 bg-danger/50 rounded-lg border border-danger/50">
                    <div>
                      <div className="text-sm font-black text-danger">Quantitative Signal</div>
                      <div className="text-micro text-foreground/50 uppercase">{new Date(s.createdAt).toLocaleDateString()}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-bold text-foreground dark:text-on-surface-sink">${parseFloat(s.entry.toString()).toFixed(2)}</div>
                      <div className="text-micro text-up font-bold">Target: ${parseFloat(s.target.toString()).toFixed(2)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right Column: Theses, Stats, Targets */}
        <div className="space-y-8">
          {/* Institutional Entry VWAP & Profit Taking Levels */}
          <ProfitTakingLevelsWidget
            ticker={ticker.ticker}
            currentPrice={currentPrice}
            vwap={loaderData?.vwap}
            atr={loaderData?.atr}
            recentSignals={recentSignals}
          />

          {/* Quantour Snowflake Radar Diagram */}
          <SnowflakeRadarChart
            ticker={ticker.ticker}
            scores={{
              valuation: (analystTargets?.targetMean && currentPrice) ? Math.min(100, Math.max(15, Math.round((parseFloat(analystTargets.targetMean.toString()) / currentPrice) * 50))) : 65,
              growth: ticker.isEmergingLeader ? 88 : ((fcfQuarterly && fcfQuarterly.length > 0) ? 75 : 55),
              momentum: loaderData?.rsi ? Math.min(100, Math.round(loaderData.rsi * 1.35)) : 70,
              health: (matchedEvents && matchedEvents.length > 0) ? 45 : 82,
              narrative: sectorScore ? Math.min(100, Math.max(25, 55 + sectorScore * 5)) : 75,
            }}
          />

          {/* AI Thesis Checker Widget */}
          <CheckThesisWidget ticker={ticker.ticker} currentPrice={currentPrice} />

          {/* Company Thesis Card */}
          <div className="bg-surface-elevated p-6 rounded-2xl shadow-lg border border-surface-elevated-border-border">
            <div className="flex justify-between items-start mb-4">
              <h2 className="text-md font-black text-foreground dark:text-on-surface-sink flex items-center gap-2">
                🧠 Company Thesis ({ticker.ticker})
              </h2>
              {!isEditing && (
                <button
                  onClick={handleStartEdit}
                  className="px-2.5 py-1 text-xs font-bold text-info bg-info/10 rounded-lg hover:bg-info/15 hover:bg-info/40 transition"
                >
                  {companyThesis ? '✏️ Edit' : '➕ Add Thesis'}
                </button>
              )}
            </div>

            {!isEditing ? (
              companyThesis ? (
                <p className="text-sm text-foreground/70 leading-relaxed font-medium italic">
                  "{companyThesis.content}"
                </p>
              ) : (
                <p className="text-xs text-foreground/40 italic">
                  No company-specific thesis recorded yet. Add one to track assumptions.
                </p>
              )
            ) : (
              <div className="space-y-4">
                {!checkResult || checkResult.intent !== 'check_thesis' ? (
                  <>
                    <textarea
                      className="w-full p-3 text-sm rounded-lg border border-surface-elevated-border-border bg-surface-elevated text-foreground dark:text-on-surface-sink focus:outline-none focus:ring-2 focus:ring-info"
                      rows={4}
                      value={editContent}
                      onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setEditContent(e.target.value)}
                      placeholder={`Enter the investment thesis/assumption for ${ticker.ticker}...`}
                    />
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={handleDiscard}
                        className="px-3 py-1.5 text-xs font-bold text-foreground/70 hover:bg-surface-elevated rounded-lg transition"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={fetcher.state === 'submitting' || !editContent.trim()}
                        onClick={() => {
                          fetcher.submit({ intent: 'check_thesis', thesis: editContent }, { method: 'post' })
                        }}
                        className="px-4 py-1.5 text-xs font-black rounded-lg bg-info hover:bg-info text-on-surface-sink transition disabled:opacity-50 flex items-center gap-1.5"
                      >
                        {fetcher.state === 'submitting' ? (
                          <>
                            <svg className="animate-spin h-3 w-3 text-on-surface-sink" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                            </svg>
                            Analyzing...
                          </>
                        ) : 'Check with Gemini'}
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="p-4 bg-surface-elevated rounded-xl border border-surface-elevated-border-border space-y-4">
                    <h3 className="text-xs font-black flex items-center gap-1.5 text-info">
                      ✨ Gemini AI Analysis & Refinement
                    </h3>
 
                    <div className={`p-2.5 rounded-lg text-xs font-bold flex items-center gap-1.5 ${
                      checkResult.isAccurate 
                        ? 'bg-up/10 text-up' 
                        : 'bg-warning/10 text-warning'
                    }`}>
                      <span>{checkResult.isAccurate ? '✅ Accurate Assumption' : '⚠️ Potential Inaccuracies/Risks'}</span>
                    </div>
 
                    <p className="text-xs leading-relaxed text-foreground/70 italic">
                      {checkResult.analysis}
                    </p>

                    <div className="grid grid-cols-1 gap-4 mt-2">
                      {/* Option 1: Original */}
                      <div className="p-3 bg-surface-elevated rounded-lg border border-surface-elevated-border-border flex flex-col justify-between">
                        <div className="mb-2">
                          <span className="text-micro font-black uppercase text-foreground/50">Your Original Version</span>
                          <p className="text-xs mt-1 text-foreground italic">"{checkResult.originalThesis}"</p>
                        </div>
                        <button
                          type="button"
                          disabled={fetcher.state === 'submitting'}
                          onClick={() => {
                            fetcher.submit({ intent: 'save_thesis', thesis: checkResult.originalThesis }, { method: 'post' })
                          }}
                          className="w-full py-1.5 text-xs font-bold bg-surface-elevated hover:bg-surface-sink text-foreground dark:text-on-surface-sink rounded transition disabled:opacity-50"
                        >
                          {fetcher.state === 'submitting' ? 'Saving...' : 'Apply Original Thesis'}
                        </button>
                      </div>

                      {/* Option 2: Gemini Edited */}
                      <div className="p-3 bg-info/50 rounded-lg border border-info flex flex-col justify-between">
                        <div className="mb-2">
                          <span className="text-micro font-black uppercase text-info flex items-center gap-1">
                            ✨ Gemini Refined Version
                          </span>
                          <p className="text-xs mt-1 text-foreground italic">"{checkResult.editedThesis}"</p>
                        </div>
                        <button
                          type="button"
                          disabled={fetcher.state === 'submitting'}
                          onClick={() => {
                            fetcher.submit({ intent: 'save_thesis', thesis: checkResult.editedThesis }, { method: 'post' })
                          }}
                          className="w-full py-1.5 text-xs font-bold bg-info hover:bg-info text-on-surface-sink rounded transition disabled:opacity-50"
                        >
                          {fetcher.state === 'submitting' ? 'Saving...' : 'Accept Gemini Version'}
                        </button>
                      </div>
                    </div>

                    <div className="flex justify-end pt-2 border-t border-surface-elevated-border-border">
                      <button
                        type="button"
                        onClick={handleDiscard}
                        className="px-3 py-1.5 text-xs font-bold text-danger hover:text-danger transition"
                      >
                        Discard Everything
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Other Conviction Theses */}
          {otherTheses.length > 0 && (
            <div className="bg-info p-6 rounded-2xl shadow-xl text-on-surface-sink">
              <h2 className="text-lg font-black mb-4 flex items-center gap-2">
                🧠 Other Conviction Theses
              </h2>
              <div className="space-y-4">
                {/* biome-ignore lint/suspicious/noExplicitAny: legacy `any` (migrated from eslint-disable) — typed cleanup pending */}
                {otherTheses.map((t: any) => (
                  <div key={t.id} className="bg-surface-elevated/10 p-4 rounded-xl backdrop-blur-sm">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-micro font-black px-1.5 py-0.5 bg-surface-elevated text-info rounded uppercase">
                        {t.scope}
                      </span>
                      <span className="text-xs font-bold opacity-80">{t.target}</span>
                    </div>
                    <p className="text-sm leading-relaxed font-medium italic">"{t.content}"</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Clusters */}
          {clusters.length > 0 && (
            <div className="bg-surface-elevated p-6 rounded-2xl shadow-lg border border-surface-elevated-border-border">
              <h2 className="text-md font-black text-foreground dark:text-on-surface-sink mb-3">🏷️ Thematic Clusters</h2>
              <div className="flex flex-wrap gap-2">
                {/* biome-ignore lint/suspicious/noExplicitAny: legacy `any` (migrated from eslint-disable) — typed cleanup pending */}
                {clusters.map((c: any) => (
                  <div key={c.clusterName} className="group relative">
                    <span className="px-3 py-1.5 bg-surface-elevated text-foreground text-xs font-bold rounded-lg border border-surface-elevated-border-border">
                      {c.clusterName}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Catalyst Timeline & Releases */}
          <div className="bg-surface-elevated p-6 rounded-2xl shadow-lg border border-surface-elevated-border-border">
            <div className="flex justify-between items-start mb-4">
              <h2 className="text-md font-black text-foreground dark:text-on-surface-sink flex items-center gap-2">
                📅 Catalyst Timeline
              </h2>
              <button
                type="button"
                onClick={() => setIsAddingCatalyst(!isAddingCatalyst)}
                className="px-2.5 py-1 text-xs font-bold text-info bg-info/10 rounded-lg hover:bg-info/15 hover:bg-info/40 transition"
              >
                {isAddingCatalyst ? 'Cancel' : '➕ Add Catalyst'}
              </button>
            </div>

            {isAddingCatalyst && (
              <fetcher.Form method="post" className="mb-4 p-4 bg-surface-elevated rounded-xl border border-surface-elevated-border-border space-y-3">
                <input type="hidden" name="intent" value="add_catalyst" />
 
                <div>
                  <label className="block text-micro font-black text-foreground/40 uppercase mb-1">Event Name *</label>
                  <input
                    type="text"
                    name="eventName"
                    required
                    placeholder="e.g. GTA 6 Game Release"
                    className="w-full p-2 text-xs rounded-lg border border-surface-elevated-border-border bg-surface-elevated text-foreground dark:text-on-surface-sink"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-micro font-black text-foreground/40 uppercase mb-1">Event Date *</label>
                    <input
                      type="date"
                      name="eventDate"
                      required
                      className="w-full p-2 text-xs rounded-lg border border-surface-elevated-border-border bg-surface-elevated text-foreground dark:text-on-surface-sink"
                    />
                  </div>
                  <div>
                    <label className="block text-micro font-black text-foreground/40 uppercase mb-1">Severity</label>
                    <select
                      name="severity"
                      className="w-full p-2 text-xs rounded-lg border border-surface-elevated-border-border bg-surface-elevated text-foreground dark:text-on-surface-sink"
                    >
                      <option value="LOW">LOW</option>
                      <option value="MEDIUM">MEDIUM</option>
                      <option value="HIGH">HIGH</option>
                      <option value="CRITICAL">CRITICAL</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-micro font-black text-foreground/40 uppercase mb-1">Description</label>
                  <textarea
                    name="description"
                    rows={2}
                    placeholder="Provide details about expected impact..."
                    className="w-full p-2 text-xs rounded-lg border border-surface-elevated-border-border bg-surface-elevated text-foreground dark:text-on-surface-sink"
                  />
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    name="isConfirmed"
                    id="isConfirmed"
                    value="true"
                    defaultChecked
                    className="rounded text-info focus:ring-info"
                  />
                  <label htmlFor="isConfirmed" className="text-xs text-foreground/70">Event is Confirmed</label>
                </div>

                <div className="flex justify-end pt-2">
                  <button
                    type="submit"
                    disabled={fetcher.state === 'submitting'}
                    className="px-4 py-1.5 text-xs font-black bg-info hover:bg-info text-on-surface-sink rounded-lg transition disabled:opacity-50"
                  >
                    {fetcher.state === 'submitting' && fetcher.formData?.get('intent') === 'add_catalyst' ? 'Saving...' : 'Save Event'}
                  </button>
                </div>
              </fetcher.Form>
            )}

            {catalysts.length > 0 ? (
              <>
                <div className="space-y-3">
                  {displayedCatalysts.map((c) => {
                    const eventDate = new Date(c.eventDate)
                    const isUpcoming = (eventDate.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24) <= 30
                    return (
                      <div
                        key={c.id}
                        className={`p-3.5 rounded-xl border flex justify-between items-start gap-4 ${
                          isUpcoming
                            ? 'bg-danger/25 border-danger/60 shadow-md'
                            : 'bg-surface-elevated border-border-surface-elevated'
                        }`}
                      >
                        <div className="flex-1 space-y-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-black text-foreground">{c.eventName}</span>
                            <span className={`text-micro font-black px-1.5 py-0.5 rounded uppercase tracking-wider ${
                              c.severity === 'CRITICAL' ? 'bg-danger text-foreground' :
                                c.severity === 'HIGH' ? 'bg-primary text-foreground' :
                                  c.severity === 'MEDIUM' ? 'bg-warning text-black' :
                                    'bg-info text-black'
                            }`}>
                              {c.severity}
                            </span>
                          </div>
                          <div className="text-micro font-bold text-accent">
                            📅 {eventDate.toLocaleDateString()} {!c.isConfirmed && <span className="text-warning font-bold">(UNCONFIRMED)</span>}
                          </div>
                          {c.description && (
                            <p className="text-micro text-on-surface-base/90 font-medium leading-relaxed italic">
                              {c.description}
                            </p>
                          )}
                        </div>
 
                        <button
                          type="button"
                          onClick={() => {
                            if (confirm('Delete this event?')) {
                              fetcher.submit({ intent: 'delete_catalyst', id: String(c.id) }, { method: 'post' })
                            }
                          }}
                          className="text-danger hover:text-danger p-1 text-xs"
                        >
                          🗑️
                        </button>
                      </div>
                    )
                  })}
                </div>
                {sortedCatalysts.length > 3 && (
                  <button
                    type="button"
                    onClick={() => setShowAllCatalysts(v => !v)}
                    className="mt-3 text-xs font-bold uppercase tracking-wider text-info hover:underline"
                  >
                    {showAllCatalysts ? 'Show less' : `Show all ${sortedCatalysts.length} catalysts`}
                  </button>
                )}
              </>
            ) : (
              <p className="text-xs text-foreground/40 italic">
                No upcoming catalyst events scheduled.
              </p>
            )}
          </div>

          {/* Fundamentals Snapshot */}
          <div className="bg-surface-elevated p-6 rounded-2xl shadow-lg border border-surface-elevated-border-border">
            <h2 className="text-md font-black text-foreground dark:text-on-surface-sink mb-4">📊 Fundamentals Snapshot</h2>
            <div className="space-y-4">
              {/* Analyst Targets */}
              {analystTargets && (
                <div className="p-4 bg-info/50 rounded-xl">
                  <div className="text-micro font-black text-info uppercase mb-2">Analyst Consensus</div>
                  <div className="grid grid-cols-2 gap-2 text-center">
                    <div>
                      <div className="text-micro uppercase font-bold text-foreground/50">Mean</div>
                      <div className="text-sm font-black text-foreground dark:text-on-surface-sink">
                        {analystTargets.targetMean && Number(analystTargets.targetMean) > 0
                          ? `$${parseFloat(analystTargets.targetMean.toString()).toFixed(2)}`
                          : 'N/A'}
                      </div>
                    </div>
                    <div>
                      <div className="text-micro uppercase font-bold text-foreground/50">High</div>
                      <div className="text-sm font-black text-up">
                        {analystTargets.targetHigh && Number(analystTargets.targetHigh) > 0
                          ? `$${parseFloat(analystTargets.targetHigh.toString()).toFixed(2)}`
                          : 'N/A'}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Earnings */}
              {tickerEarnings && (
                <div className="flex justify-between items-center py-2 border-b border-surface-elevated-border-border">
                  <span className="text-xs font-bold text-foreground/50 uppercase">Days to Earnings</span>
                  <span className="text-sm font-black text-foreground dark:text-on-surface-sink">{tickerEarnings.next ?? 'N/A'}</span>
                </div>
              )}

              {/* Dividends */}
              {tickerDividends && tickerDividends.dividend && (
                <div className="flex justify-between items-center py-2 border-b border-surface-elevated-border-border">
                  <span className="text-xs font-bold text-foreground/50 uppercase">Latest Dividend</span>
                  <span className="text-sm font-black text-foreground dark:text-on-surface-sink">${parseFloat(tickerDividends.dividend.toString()).toFixed(2)}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
