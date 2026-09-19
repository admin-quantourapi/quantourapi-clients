import { requireWriteAccess } from 'app/lib/auth-helpers'
import { logger } from 'app/lib/logger'
import { fetchFromPublicApi } from 'app/utils/apiClient'
import {
  useEffect, useMemo, useState, 
} from 'react'
import {
  Link,
  useFetcher,
  useSearchParams, 
} from 'react-router'

import type { Route } from './+types/catalysts'

export interface BriefData {
  id: number
  date: string
  summary: string
  shortTermCount: number | null
  longTermCount: number | null
  highImpactCount: number | null
  criticalCount: number | null
  affectingPortfolioCount: number | null
  positiveCount: number | null
  negativeCount: number | null
  data: string | null
}

export interface GlobalEvent {
  id: number
  event: string
  description: string | null
  impactedRegions: string | null
  impactedIndustries: string | null
  severity: string
  status: string
  createdAt: string
  expiresAt?: string
}

export interface TickerCatalyst {
  id: number
  ticker: string
  eventName: string
  eventDate: string
  description: string | null
  severity: string
  impactType: string
  status: string
  createdAt: string
}

export interface EventImpact {
  region?: string
  industry?: string
  impact: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL'
  rationale: string
}

export async function loader({ request }: Route.LoaderArgs) {
  try {
    const url = new URL(request.url)
    const tab = url.searchParams.get('tab') || 'active'
    
    const [
      catalystsResponse,
      tickersRes,
      tradesRes,
      briefRes,
    ] = await Promise.all([
      fetchFromPublicApi(`/market/catalysts?tab=${tab}`, request).catch(() => ({ data: {} })),
      fetchFromPublicApi('/market/tickers', request).catch(() => ({ data: [] })),
      fetchFromPublicApi('/market/trades', request).catch(() => ({ data: [] })),
      fetchFromPublicApi('/market/latest-brief', request).catch(() => ({ data: null })),
    ])

    const cData = (catalystsResponse?.data || catalystsResponse || {}) as {
      globalEvents?: GlobalEvent[]
      tickerCatalysts?: TickerCatalyst[]
      calendarEvents?: { economicEvents?: unknown[]; corporateCatalysts?: unknown[] }
    }
    const globalEvents = cData.globalEvents || []
    const tickerCatalysts = cData.tickerCatalysts || []
    const calendarEvents = cData.calendarEvents || { economicEvents: [], corporateCatalysts: [] }

    const tickersList = Array.isArray(tickersRes?.data) ? tickersRes.data : Array.isArray(tickersRes) ? tickersRes : []
    const activeTrades = Array.isArray(tradesRes?.data) ? tradesRes.data : Array.isArray(tradesRes) ? tradesRes : []
    const latestBrief = briefRes?.data !== undefined ? briefRes.data : briefRes || undefined

    return {
      globalEvents,
      tickerCatalysts,
      tickers: tickersList,
      activeTrades,
      latestBrief,
      calendarEvents,
      error: undefined,
    }
  } catch (error: unknown) {
    if (error instanceof Response) throw error
    const errMsg = error instanceof Error ? error.message : 'Failed to load catalysts'
    logger.error({ error }, '[CATALYSTS LOADER ERROR] Failed to load data')
    return {
      globalEvents: [],
      tickerCatalysts: [],
      tickers: [],
      activeTrades: [],
      latestBrief: undefined,
      calendarEvents: { economicEvents: [], corporateCatalysts: [] },
      error: errMsg,
    }
  }
}

export async function action({ request }: Route.ActionArgs) {
  await requireWriteAccess(request)
  const formData = await request.formData()
  const intent = formData.get('intent')

  const apiFetch = async (endpoint: string, payload: Record<string, unknown>, method = 'POST') => {
    return fetchFromPublicApi(endpoint, request, {
      method,
      body: JSON.stringify(payload),
    })
  }

  try {
    if (intent === 'create-global') {
      const event = formData.get('event') as string
      const description = formData.get('description') as string
      const severity = formData.get('severity') as string

      await apiFetch('/market/global-events', { event, description, severity })
      return { success: true, message: 'Global event created successfully' }
    }

    if (intent === 'add_ticker_catalyst') {
      const eventName = formData.get('eventName') as string
      const eventDateStr = formData.get('eventDate') as string
      const severity = formData.get('severity') as string
      const tickerImpactsRaw = formData.get('tickerImpacts') as string

      if (!eventName || !eventDateStr) return { success: false, error: 'Event Name and Event Date are required' }

      const tickerImpacts = JSON.parse(tickerImpactsRaw || '[]') as {
        ticker: string
        impactType: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL'
        rationale: string
      }[]

      if (tickerImpacts.length === 0) return { success: false, error: 'At least one impacted ticker must be specified' }

      for (const impact of tickerImpacts) {
        await apiFetch(`/ticker/${impact.ticker}/catalysts`, {
          eventName,
          eventDate: eventDateStr,
          description: impact.rationale,
          severity,
          impactType: impact.impactType,
          isConfirmed: true,
        })
      }
      logger.info({ eventName, count: tickerImpacts.length }, '[CATALYSTS ACTION] Added ticker catalysts')
      return { success: true, message: 'Corporate catalyst created' }
    }

    if (intent === 'delete_ticker_catalyst') {
      const id = Number(formData.get('id'))
      await apiFetch(`/market/catalysts/${id}`, {}, 'DELETE')
      logger.info({ id }, '[CATALYSTS ACTION] Deleted individual ticker catalyst')
      return { success: true, message: 'Ticker impact deleted' }
    }

    return { success: false, error: 'Unknown intent' }
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : 'Action failed'
    logger.error({ error }, '[CATALYSTS ACTION] Failed to perform action')
    return { success: false, error: errMsg }
  }
}

export default function Catalysts({ loaderData }: Route.ComponentProps) {
  const {
    globalEvents: initialGlobalEvents = [],
    tickerCatalysts: initialTickerCatalysts = [],
    tickers = [],
    activeTrades = [],
    latestBrief,
    calendarEvents = { economicEvents: [], corporateCatalysts: [] },
    error,
  } = (loaderData || {}) as {
    globalEvents?: GlobalEvent[]
    tickerCatalysts?: TickerCatalyst[]
    tickers?: Array<{ ticker: string; sector?: string; industry?: string; rdRegion?: string; supplyRegion?: string; marketRegion?: string }>
    activeTrades?: Array<{ ticker: string }>
    latestBrief?: BriefData
    calendarEvents?: {
      economicEvents?: Array<{ country?: string; event?: string; date?: string; estimate?: unknown; previous?: unknown }>
      corporateCatalysts?: Array<{ ticker?: string; eventName?: string; eventDate?: string }>
    }
    error?: string
  }
  const fetcher = useFetcher<{ success: boolean; message?: string; error?: string }>()
  const [
    searchParams,
  ] = useSearchParams()
  const activeTab = searchParams.get('tab') || 'active'

  // Local optimistic data states
  const [
    globalEventsList,
    setGlobalEventsList,
  ] = useState(initialGlobalEvents)
  const [
    tickerCatalystsList,
    setTickerCatalystsList,
  ] = useState(initialTickerCatalysts)

  useEffect(() => {
    setGlobalEventsList(initialGlobalEvents)
  }, [
    initialGlobalEvents,
  ])

  useEffect(() => {
    setTickerCatalystsList(initialTickerCatalysts)
  }, [
    initialTickerCatalysts,
  ])

  // UI state
  const [
    selectedCatalyst,
    setSelectedCatalyst,
  ] = useState<{ id: string; type: 'GLOBAL' | 'CORPORATE' } | null>(null)
  const [
    isAddingTicker,
    setIsAddingTicker,
  ] = useState(false)

  // Creation forms states
  const [
    newTicker,
    setNewTicker,
  ] = useState({ eventName: '', eventDate: '', severity: 'HIGH' })
  const [
    tickerImpacts,
    setTickerImpacts,
  ] = useState<{ ticker: string; impactType: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL'; rationale: string }[]>([])

  // Segment pending vs active events
  // Global events are sourced from Quantour API and are implicitly approved.
  // In the future, Quantour API might return status for them, but for this client they are all active.
  const approvedGlobalEvents = useMemo(() => globalEventsList, [
    globalEventsList,
  ])

  const formatHeading = (text?: string) => {
    if (!text) return ''
    return text.replace(/_/g, ' ').replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
  }

  // Group corporate catalysts by name and date to show them as single unified events on the timeline
  const groupedCorporateEvents = useMemo(() => {
    const map = new Map<string, (typeof tickerCatalystsList)[number][]>()
    for (const c of tickerCatalystsList) {
      const key = `${c.eventName}::${new Date(c.eventDate).toISOString().split('T')[0]}`
      if (!map.has(key)) {
        map.set(key, [])
      }
      map.get(key)!.push(c)
    }
 
    return Array.from(map.entries()).map(([
      key,
      list,
    ]) => {
      const [
        name,
        date,
      ] = key.split('::')
      return {
        key,
        eventName: name!,
        eventDate: new Date(date!),
        severity: list[0]?.severity || 'HIGH',
        impacts: list,
      }
    }).sort((a, b) => a.eventDate.getTime() - b.eventDate.getTime())
  }, [
    tickerCatalystsList,
  ])

  // Construct a single unified timeline list of events
  const timelineEvents = useMemo(() => {
    const timeline: {
      id: string
      name: string
      date: Date
      type: 'GLOBAL' | 'CORPORATE'
      severity: string
      description: string
      rawObject: unknown
    }[] = []

    for (const ge of approvedGlobalEvents) {
      timeline.push({
        id: `global-${ge.id}`,
        name: formatHeading(ge.event),
        date: ge.expiresAt ? new Date(ge.expiresAt) : new Date(ge.createdAt),
        type: 'GLOBAL',
        severity: ge.severity,
        description: ge.description || '',
        rawObject: ge,
      })
    }

    for (const ce of groupedCorporateEvents) {
      timeline.push({
        id: `corp-${ce.key}`,
        name: ce.eventName,
        date: ce.eventDate,
        type: 'CORPORATE',
        severity: ce.severity,
        description: `Impacts ${ce.impacts.length} stock(s).`,
        rawObject: ce,
      })
    }

    // Sort by date descending
    return timeline.sort((a, b) => b.date.getTime() - a.date.getTime())
  }, [
    approvedGlobalEvents,
    groupedCorporateEvents,
  ])

  // Find currently selected catalyst details
  const activeDetail = useMemo(() => {
    if (!selectedCatalyst) return null
    if (selectedCatalyst.type === 'GLOBAL') {
      const idNum = Number(selectedCatalyst.id.replace('global-', ''))
      return timelineEvents.find(e => e.type === 'GLOBAL' && (e.rawObject as { id: number }).id === idNum) || null
    } else {
      const key = selectedCatalyst.id.replace('corp-', '')
      return timelineEvents.find(e => e.type === 'CORPORATE' && (e.rawObject as { key: string }).key === key) || null
    }
  }, [
    selectedCatalyst,
    timelineEvents,
  ])

  // Warning Alerts: Find if any of our active positions has a catalyst in the next 30 days
  const activePositionWarnings = useMemo(() => {
    const warnings: {
      ticker: string
      eventName: string
      eventDate: Date
      severity: string
      impactType: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL'
      description: string
    }[] = []

    const today = new Date()
    const thirtyDaysFromNow = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000)

    for (const position of activeTrades) {
      // Check ticker-specific catalysts
      const positionCatalysts = tickerCatalystsList.filter((c: { ticker: string }) => c.ticker === position.ticker)
      for (const cat of positionCatalysts) {
        const catDate = new Date(cat.eventDate)
        if (catDate >= today && catDate <= thirtyDaysFromNow) {
          warnings.push({
            ticker: position.ticker,
            eventName: cat.eventName,
            eventDate: catDate,
            severity: cat.severity,
            impactType: cat.impactType as 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL',
            description: cat.description || '',
          })
        }
      }
      // Check global macro events matching sector/region
      const activeGlobal = approvedGlobalEvents
      for (const event of activeGlobal) {
        let regionsList: EventImpact[] = []
        let industriesList: EventImpact[] = []
        try {
          regionsList = JSON.parse(event.impactedRegions || '[]') as EventImpact[]
        } catch (e) {
          console.warn('Failed to parse regions:', e)
        }
        try {
          industriesList = JSON.parse(event.impactedIndustries || '[]') as EventImpact[]
        } catch (e) {
          console.warn('Failed to parse industries:', e)
        }

        // Match Industry
        const tickerMeta = tickers.find((t: { ticker: string; sector?: string }) => t.ticker === position.ticker)
        if (tickerMeta) {
          const industryMatch = industriesList.find(i => tickerMeta.sector && tickerMeta.sector.toLowerCase().includes(i.industry?.toLowerCase() || ''))
          if (industryMatch) {
            warnings.push({
              ticker: position.ticker,
              eventName: `${event.event} (Sector Impact)`,
              eventDate: event.expiresAt ? new Date(event.expiresAt) : new Date(event.createdAt),
              severity: event.severity,
              impactType: industryMatch.impact,
              description: industryMatch.rationale,
            })
          }

          // Match Region
          const regions = [
            tickerMeta.rdRegion,
            tickerMeta.supplyRegion,
            tickerMeta.marketRegion,
          ].filter(Boolean) as string[]
 
          const regionalMatch = regionsList.find(r => regions.some(sr => r.region && sr.toLowerCase().includes(r.region.toLowerCase())))
          if (regionalMatch) {
            warnings.push({
              ticker: position.ticker,
              eventName: `${event.event} (Regional Impact: ${regionalMatch.region})`,
              eventDate: event.expiresAt ? new Date(event.expiresAt) : new Date(event.createdAt),
              severity: event.severity,
              impactType: regionalMatch.impact,
              description: regionalMatch.rationale,
            })
          }
        }
      }
    }
    return warnings
  }, [
    activeTrades,
    tickerCatalystsList,
    approvedGlobalEvents,
    tickers,
  ])

  // Select the first timeline event automatically if none selected or if selected is not in current tab's timeline
  useEffect(() => {
    const exists = timelineEvents.some(e => e.id === selectedCatalyst?.id)
    if ((!selectedCatalyst || !exists) && timelineEvents.length > 0) {
      setSelectedCatalyst({ id: timelineEvents[0]!.id, type: timelineEvents[0]!.type })
    } else if (timelineEvents.length === 0) {
      setSelectedCatalyst(null)
    }
  }, [
    timelineEvents,
    selectedCatalyst,
  ])

  // Scroll timeline to today's event, or nearest future event on load

  useEffect(() => {
    if (activeTab !== 'active' || timelineEvents.length === 0) return
    const now = new Date()
    const todayStr = now.toISOString().split('T')[0]

    let targetIdx = timelineEvents.findLastIndex(e => {
      const d = e.date instanceof Date ? e.date : new Date(e.date)
      return d.toISOString().split('T')[0] === todayStr
    })

    if (targetIdx === -1) {
      let nearestDiff = Infinity
      for (let i = timelineEvents.length - 1; i >= 0; i--) {
        const diff = timelineEvents[i]!.date.getTime() - now.getTime()
        if (diff >= 0 && diff < nearestDiff) {
          nearestDiff = diff
          targetIdx = i
        }
      }
    }

    if (targetIdx === -1) return
    setTimeout(() => {
      const el = document.getElementById(`timeline-event-${timelineEvents[targetIdx]!.id}`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 100)
  }, [
    timelineEvents,
    activeTab,
  ])

  // Countdown Helper
  const getDaysRemaining = (d: Date) => {
    const diffTime = d.getTime() - new Date().getTime()
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24))
    if (diffDays < 0) return 'Passed'
    if (diffDays === 0) return 'Today'
    if (diffDays === 1) return 'Tomorrow'
    return `${diffDays} days left`
  }

  // Sentiment color helpers
  const getSeverityBadgeClass = (sev: string) => {
    switch (sev.toUpperCase()) {
      case 'CRITICAL':
        return 'bg-danger/20 text-danger border border-danger/30'
      case 'HIGH':
        return 'bg-primary/20 text-primary border border-primary/30'
      case 'MEDIUM':
        return 'bg-warning/20 text-warning border border-warning/30'
      default:
        return 'bg-info/20 text-info border border-info/30'
    }
  }

  const getImpactBadgeClass = (impact: string) => {
    switch (impact.toUpperCase()) {
      case 'POSITIVE':
        return 'bg-up/20 text-up border border-up/30'
      case 'NEGATIVE':
        return 'bg-danger/20 text-danger border border-danger/30'
      default:
        return 'bg-surface-base/20 text-foreground/50 border border-surface-base-border/30'
    }
  }

  return (
    <div className="p-4 md:p-8">
      <div className="w-full space-y-6">
 
        {/* Error alert */}
        {(error || fetcher.data?.success === false) && (
          <div className="p-4 rounded-xl bg-danger/10 border border-danger/20 text-danger text-sm">
            ⚠️ Error: {error || fetcher.data?.error}
          </div>
        )}

        {/* Action Success Alert */}
        {fetcher.data?.success && fetcher.data?.message && (
          <div className="p-4 rounded-xl bg-success/10 border border-success/20 text-success text-sm">
            ✨ Success: {fetcher.data?.message}
          </div>
        )}

        {/* Daily Catalyst Brief Summary Cards */}
        {latestBrief && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-foreground/50">📋 Daily Brief</span>
              <span className="text-micro text-foreground/30">{new Date(latestBrief.date).toLocaleDateString()}</span>
            </div>
            <p className="text-sm text-foreground/80 leading-relaxed">{latestBrief.summary}</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
              <div className="p-3 rounded-xl bg-info/10 border border-info/20">
                <div className="text-lg font-black text-info">{latestBrief.shortTermCount ?? '-'}</div>
                <div className="text-micro uppercase font-bold tracking-wider text-foreground/50">Short-term</div>
              </div>
              <div className="p-3 rounded-xl bg-special/10 border border-special/20">
                <div className="text-lg font-black text-special">{latestBrief.longTermCount ?? '-'}</div>
                <div className="text-micro uppercase font-bold tracking-wider text-foreground/50">Long-term</div>
              </div>
              <div className="p-3 rounded-xl bg-primary/10 border border-primary/20">
                <div className="text-lg font-black text-primary">{latestBrief.highImpactCount ?? '-'}</div>
                <div className="text-micro uppercase font-bold tracking-wider text-foreground/50">High Impact</div>
              </div>
              <div className="p-3 rounded-xl bg-danger/10 border border-danger/20">
                <div className="text-lg font-black text-danger">{latestBrief.criticalCount ?? '-'}</div>
                <div className="text-micro uppercase font-bold tracking-wider text-foreground/50">Critical</div>
              </div>
              <div className="p-3 rounded-xl bg-up/10 border border-up/20">
                <div className="text-lg font-black text-up">{latestBrief.positiveCount ?? '-'}</div>
                <div className="text-micro uppercase font-bold tracking-wider text-foreground/50">Positive</div>
              </div>
              <div className="p-3 rounded-xl bg-danger/10 border border-danger/20">
                <div className="text-lg font-black text-down">{latestBrief.negativeCount ?? '-'}</div>
                <div className="text-micro uppercase font-bold tracking-wider text-foreground/50">Negative</div>
              </div>
            </div>
            {(latestBrief.affectingPortfolioCount ?? 0) > 0 && (
              <div className="p-3 rounded-xl bg-warning/10 border border-warning/20">
                <div className="text-sm font-bold text-warning">
                  ⚡ {latestBrief.affectingPortfolioCount} catalyst{latestBrief.affectingPortfolioCount !== 1 ? 's' : ''} affecting your portfolio
                </div>
              </div>
            )}
          </div>
        )}

        {/* Page Header */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <p className="text-xs text-foreground/60 mt-1">
              Point-in-time binary events that can dramatically impact the hoard's positions.
            </p>
          </div>
          <div className="flex w-full md:w-auto gap-2">
            <button
              onClick={() => {
                setIsAddingTicker(!isAddingTicker)
              }}
              className="flex-1 md:flex-none px-4 py-2 text-xs font-black uppercase tracking-wider rounded-xl bg-surface-elevated hover:bg-surface-elevated-hover transition-all border border-surface-elevated-border text-foreground cursor-pointer"
            >
              {isAddingTicker ? 'Cancel' : '➕ Ticker Catalyst'}
            </button>
          </div>
        </div>







        {isAddingTicker && (
          <div className="p-5 bg-surface-elevated rounded-2xl border border-up/30 space-y-4 shadow-xl">
            <h2 className="text-sm font-black text-up uppercase tracking-wider">
              ➕ Add New Corporate / Ticker Catalyst (e.g. SpaceX IPO)
            </h2>
            <fetcher.Form method="post" onSubmit={() => setIsAddingTicker(false)} className="space-y-4">
              <input type="hidden" name="intent" value="add_ticker_catalyst" />
              <input type="hidden" name="tickerImpacts" value={JSON.stringify(tickerImpacts)} />

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="md:col-span-2 space-y-1">
                  <label className="text-micro uppercase font-bold text-foreground/50">Event Name</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. SpaceX IPO or NVDA Earnings"
                    value={newTicker.eventName}
                    onChange={(e) => setNewTicker({ ...newTicker, eventName: e.target.value })}
                    className="w-full px-3 py-2 text-sm bg-surface-sink rounded-xl border border-surface-sink-border text-on-surface-sink focus:outline-none focus:border-up"
                    name="eventName"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-micro uppercase font-bold text-foreground/50">Event Date</label>
                  <input
                    type="date"
                    required
                    value={newTicker.eventDate}
                    onChange={(e) => setNewTicker({ ...newTicker, eventDate: e.target.value })}
                    className="w-full px-3 py-2 text-sm bg-surface-sink rounded-xl border border-surface-sink-border text-on-surface-sink focus:outline-none focus:border-up"
                    name="eventDate"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-1">
                  <label className="text-micro uppercase font-bold text-foreground/50">Severity</label>
                  <select
                    value={newTicker.severity}
                    onChange={(e) => setNewTicker({ ...newTicker, severity: e.target.value })}
                    className="w-full px-3 py-2 text-sm bg-surface-sink rounded-xl border border-surface-sink-border text-on-surface-sink focus:outline-none focus:border-up"
                    name="severity"
                  >
                    <option value="LOW">LOW</option>
                    <option value="MEDIUM">MEDIUM</option>
                    <option value="HIGH">HIGH</option>
                    <option value="CRITICAL">CRITICAL</option>
                  </select>
                </div>
              </div>

              {/* Ticker Impacts Builder */}
              <div className="space-y-2 pt-2 border-t border-surface-sink-border">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-bold text-foreground/70">Impacted Stocks</span>
                  <button
                    type="button"
                    onClick={() => {
                      if (tickers.length > 0) {
                        setTickerImpacts([
                          ...tickerImpacts,
                          { ticker: tickers[0]!.ticker, impactType: 'POSITIVE', rationale: '' },
                        ])
                      }
                    }}
                    className="px-2 py-1 text-micro bg-surface-sink hover:bg-surface-elevated rounded text-foreground/70 cursor-pointer"
                  >
                    ➕ Add Stock Row
                  </button>
                </div>
                {tickerImpacts.map((ti, idx) => (
                  <div key={idx} className="grid grid-cols-1 md:grid-cols-4 gap-2 items-center bg-surface-sink p-2 rounded-xl border border-surface-sink-border">
                    <select
                      value={ti.ticker}
                      onChange={(e) => {
                        const copy = [
                          ...tickerImpacts,
                        ]
                        copy[idx]!.ticker = e.target.value
                        setTickerImpacts(copy)
                      }}
                      className="px-2 py-1.5 bg-surface-elevated text-xs rounded border border-surface-sink-border text-on-surface-sink"
                    >
                      {tickers.map((t: { ticker: string; name?: string }) => (
                        <option key={t.ticker} value={t.ticker}>{t.ticker} - {t.name?.slice(0, 25)}</option>
                      ))}
                    </select>
                    <select
                      value={ti.impactType}
                      onChange={(e) => {
                        const copy = [
                          ...tickerImpacts,
                        ]
                        copy[idx]!.impactType = e.target.value as 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL'
                        setTickerImpacts(copy)
                      }}
                      className="px-2 py-1.5 bg-surface-elevated text-xs rounded border border-surface-sink-border text-on-surface-sink"
                    >
                      <option value="POSITIVE">🟢 BENEFICIARY (Bullish)</option>
                      <option value="NEGATIVE">🔴 VICTIM (Bearish)</option>
                      <option value="NEUTRAL">⚪ NEUTRAL</option>
                    </select>
                    <input
                      type="text"
                      placeholder="Rationale (e.g. Valuation boost or competition risk)..."
                      value={ti.rationale}
                      required
                      onChange={(e) => {
                        const copy = [
                          ...tickerImpacts,
                        ]
                        copy[idx]!.rationale = e.target.value
                        setTickerImpacts(copy)
                      }}
                      className="px-2 py-1 bg-surface-elevated text-xs rounded border border-surface-sink-border text-on-surface-sink md:col-span-2 flex-grow"
                    />
                    <button
                      type="button"
                      onClick={() => setTickerImpacts(tickerImpacts.filter((_, i) => i !== idx))}
                      className="text-xs text-danger text-left hover:underline md:col-span-4 mt-1"
                    >
                      Remove row
                    </button>
                  </div>
                ))}
              </div>

              <div className="flex justify-end gap-2 pt-4 border-t border-surface-sink-border">
                <button
                  type="button"
                  onClick={() => setIsAddingTicker(false)}
                  className="px-4 py-2 bg-surface-sink text-xs font-bold uppercase tracking-wider rounded-xl hover:bg-surface-elevated text-on-surface-sink cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-up text-xs font-bold uppercase tracking-wider rounded-xl hover:bg-up text-on-surface-sink cursor-pointer"
                >
                  Save Corporate Event
                </button>
              </div>
            </fetcher.Form>
          </div>
        )}

        {/* 3. Main Dashboard: Timeline on Left, Details on Right */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
 
          {/* Timeline Column */}
          <div className="lg:col-span-5 space-y-4 bg-surface-elevated/60 p-5 rounded-2xl border border-surface-sink-border sticky top-6 max-h-[calc(100vh-7.5rem)] flex flex-col">
            <h2 className="text-xs font-black text-foreground/50 uppercase tracking-widest px-1 shrink-0">
              📅 {activeTab === 'past' ? 'PAST EVENTS TIMELINE' : 'ACTIVE EVENTS TIMELINE'}
            </h2>

            {/* Tab Bar */}
            <div className="flex border-b border-surface-sink-border shrink-0 gap-1 mt-1">
              <Link
                to="/catalysts?tab=active"
                className={`px-3 py-1.5 text-micro font-black uppercase tracking-wider border-b-2 transition-all ${
                  activeTab === 'active'
                    ? 'border-info text-on-surface-sink font-bold'
                    : 'border-transparent text-foreground/50 hover:text-foreground/80'
                }`}
              >
                🟢 Active
              </Link>
              <Link
                to="/catalysts?tab=past"
                className={`px-3 py-1.5 text-micro font-black uppercase tracking-wider border-b-2 transition-all ${
                  activeTab === 'past'
                    ? 'border-danger text-on-surface-sink font-bold'
                    : 'border-transparent text-foreground/50 hover:text-foreground/80'
                }`}
              >
                ⏳ Past
              </Link>
              <Link
                to="/catalysts?tab=risks"
                className={`px-3 py-1.5 text-micro font-black uppercase tracking-wider border-b-2 transition-all flex items-center gap-1 ${
                  activeTab === 'risks'
                    ? 'border-warning text-warning font-bold'
                    : 'border-transparent text-foreground/50 hover:text-foreground/80'
                }`}
              >
                ⚠️ Risks <span className="bg-warning/20 text-warning px-1.5 py-0.5 rounded-full text-micro">{activePositionWarnings.length}</span>
              </Link>
              <Link
                to="/catalysts?tab=economic"
                className={`px-3 py-1.5 text-micro font-black uppercase tracking-wider border-b-2 transition-all flex items-center gap-1 ${
                  activeTab === 'economic'
                    ? 'border-info text-info font-bold'
                    : 'border-transparent text-foreground/50 hover:text-foreground/80'
                }`}
              >
                📅 Economic
              </Link>
              <Link
                to="/catalysts?tab=earnings"
                className={`px-3 py-1.5 text-micro font-black uppercase tracking-wider border-b-2 transition-all flex items-center gap-1 ${
                  activeTab === 'earnings'
                    ? 'border-up text-up font-bold'
                    : 'border-transparent text-foreground/50 hover:text-foreground/80'
                }`}
              >
                💰 Earnings
              </Link>
            </div>

            {activeTab === 'economic' ? (
              <div className="flex-1 overflow-y-auto custom-scrollbar pr-2 mt-3 space-y-3">
                {(!calendarEvents?.economicEvents || calendarEvents.economicEvents.length === 0) ? (
                  <div className="text-center py-10 text-foreground/50 text-xs">No upcoming economic events found</div>
                ) : (
                  calendarEvents.economicEvents.slice(0, 30).map((event: Record<string, unknown>, idx: number) => (
                    <div key={idx} className="p-3 bg-surface-elevated/60 rounded-xl border border-surface-sink-border flex items-start gap-3 hover:border-info/30 transition-all">
                      <div className="px-2 py-0.5 rounded font-black text-micro uppercase shrink-0 bg-info/10 text-info border border-info/20 text-center">
                        {formatHeading(String(event.country || '')) || '🌍'}
                      </div>
                      <div>
                        <div className="font-bold text-foreground text-xs">{String(event.event || '')}</div>
                        <div className="text-micro text-foreground/50 mt-0.5">
                          {new Date(String(event.date || '')).toLocaleDateString(undefined, {
                            weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', 
                          })}
                        </div>
                        {(event.estimate !== null || event.previous !== null) && (
                          <div className="flex gap-4 mt-2 text-micro">
                            <span className="text-foreground/50">Est: <strong className="text-foreground">{String(event.estimate ?? 'N/A')}</strong></span>
                            <span className="text-foreground/50">Prev: <strong className="text-foreground">{String(event.previous ?? 'N/A')}</strong></span>
                          </div>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            ) : activeTab === 'earnings' ? (
              <div className="flex-1 overflow-y-auto custom-scrollbar pr-2 mt-3 space-y-3">
                {(!calendarEvents?.corporateCatalysts || calendarEvents.corporateCatalysts.length === 0) ? (
                  <div className="text-center py-10 text-foreground/50 text-xs">No upcoming earnings events found</div>
                ) : (
                  calendarEvents.corporateCatalysts.slice(0, 30).map((eventItem: Record<string, unknown>, idx: number) => {
                    const event = eventItem as { ticker?: string; eventName?: string; eventDate?: string }
                    return (
                      <div key={idx} className="p-3 bg-surface-elevated/60 rounded-xl border border-surface-sink-border flex items-start gap-3 hover:border-up/30 transition-all">
                        <div className="px-2 py-0.5 rounded font-black text-micro uppercase shrink-0 bg-up/10 text-up border border-up/20">
                          {event.ticker || ''}
                        </div>
                        <div>
                          <div className="font-bold text-foreground text-xs">{event.eventName || ''}</div>
                          <div className="text-micro text-foreground/50 mt-0.5">
                            {event.eventDate ? new Date(event.eventDate).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : ''}
                          </div>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            ) : activeTab === 'risks' ? (
              <div className="flex-1 overflow-y-auto custom-scrollbar pr-2 mt-3 space-y-3">
                {activePositionWarnings.length === 0 ? (
                  <div className="text-center py-10 text-foreground/50 text-xs">No active portfolio risks</div>
                ) : (
                  activePositionWarnings.map((warning, idx) => (
                    <div key={idx} className="p-3 bg-surface-elevated/60 rounded-xl border border-surface-sink-border flex items-start gap-3 hover:border-warning/30 transition-all cursor-pointer">
                      <div className={`px-2 py-0.5 rounded font-black text-micro uppercase shrink-0 ${getImpactBadgeClass(warning.impactType)}`}>
                        {warning.ticker}
                      </div>
                      <div>
                        <div className="font-bold text-foreground text-xs">{warning.eventName}</div>
                        <div className="text-micro text-foreground/50 mt-0.5">
                          Date: {new Date(warning.eventDate).toLocaleDateString()} ({getDaysRemaining(new Date(warning.eventDate))})
                        </div>
                        <p className="text-foreground/50 mt-1 leading-relaxed text-micro">{warning.description}</p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            ) : timelineEvents.length === 0 ? (
              <div className="text-center py-10 text-foreground/50 text-xs">
                {activeTab === 'past'
                  ? 'No past macro or corporate catalysts recorded.'
                  : 'No active macro or corporate catalysts scheduled.'}
              </div>
            ) : (
              <div className="relative border-l border-surface-sink-border ml-3 pl-6 space-y-5 py-2 overflow-y-auto pr-2 custom-scrollbar">
                {timelineEvents.map((event) => {
                  const isSelected = selectedCatalyst?.id === event.id
                  return (
                    <div id={`timeline-event-${event.id}`} key={event.id} className="relative group">
                      {/* Timeline Dot Indicator */}
                      <span className={`absolute left-[-1.9375rem] top-1.5 flex h-4 w-4 rounded-full border-2 bg-surface-sink items-center justify-center transition-all ${
                        isSelected 
                          ? 'border-info scale-125 ring-4 ring-info/20' 
                          : 'border-surface-sink-border group-hover:border-surface-elevated-border'
                      }`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${event.type === 'GLOBAL' ? 'bg-special/60' : 'bg-success/40'}`}></span>
                      </span>

                      {/* Event Card Link */}
                      <button
                        onClick={() => setSelectedCatalyst({ id: event.id, type: event.type })}
                        className={`w-full text-left p-3.5 rounded-xl border transition-all cursor-pointer flex flex-col gap-2 ${
                          isSelected
                            ? 'bg-surface-sink border-surface-elevated-border shadow-md shadow-indigo-500/5'
                            : 'bg-surface-sink/40 border-surface-sink-border hover:bg-surface-sink hover:border-surface-sink-border'
                        }`}
                      >
                        <div className="flex justify-between items-start gap-2">
                          <h3 className={`font-bold text-xs leading-tight transition-colors ${isSelected ? 'text-on-surface-sink' : 'text-foreground/70 group-hover:text-on-surface-sink'}`}>
                            {event.name}
                          </h3>
                          <span className={`text-micro font-black uppercase px-1.5 py-0.5 rounded shrink-0 ${getSeverityBadgeClass(event.severity)}`}>
                            {event.severity}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-micro text-foreground/50">
                          <div className="flex items-center gap-1.5 font-bold uppercase tracking-wider">
                            <span>{event.type === 'GLOBAL' ? '🌍 Macro' : '🏢 Corp'}</span>
                            <span className="text-foreground/70">•</span>
                            <span>{new Date(event.date).toLocaleDateString()}</span>
                          </div>
                          <span className="text-foreground/50 font-bold">{getDaysRemaining(event.date)}</span>
                        </div>
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Details Deep Dive Column */}
          <div className="lg:col-span-7 sticky top-6 max-h-[calc(100vh-7.5rem)] overflow-y-auto custom-scrollbar">
            {activeDetail ? (
              <div className="bg-surface-elevated/90 rounded-2xl border border-surface-sink-border p-6 space-y-6 shadow-xl relative overflow-hidden">
 
                {/* Visual Accent Bar */}
                <div className={`absolute left-0 top-0 right-0 h-1.5 ${activeDetail.type === 'GLOBAL' ? 'bg-special/70' : 'bg-success'}`} />

                {/* Card Title & Info */}
                <div className="space-y-3 pt-1">
                  <div className="flex flex-wrap justify-between items-start gap-2">
                    <div>
                      <span className="text-micro font-black uppercase tracking-widest text-info px-2.5 py-1 bg-info/10 rounded-full border border-info/20">
                        {activeDetail.type === 'GLOBAL' ? '🌍 Global Macro Event' : '🏢 Corporate Event'}
                      </span>
                      <h2 className="text-xl font-black text-on-surface-sink tracking-tight mt-2.5 leading-snug">
                        {activeDetail.name}
                      </h2>
                    </div>

                    <div className="flex gap-2">
                      <span className={`text-micro font-black uppercase px-2.5 py-1 rounded-full ${getSeverityBadgeClass(activeDetail.severity)}`}>
                        {activeDetail.severity}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 text-xs text-foreground/50 font-bold border-b border-surface-sink-border pb-3">
                    <div>
                      Target Date: <span className="text-foreground font-semibold">{new Date(activeDetail.date).toLocaleDateString()}</span>
                    </div>
                    <div className="text-foreground/70">•</div>
                    <div>
                      Status:{' '}
                      <span className={getDaysRemaining(activeDetail.date) === 'Passed' ? 'text-foreground/50' : 'text-success'}>
                        {getDaysRemaining(activeDetail.date) === 'Passed' ? 'EXPIRED / PASSED' : 'APPROVED & ACTIVE'}
                      </span>
                    </div>
                    <div className="text-foreground/70">•</div>
                    <div className="text-foreground/90 font-black">{getDaysRemaining(activeDetail.date)}</div>
                  </div>
                </div>

                {/* Event Description */}
                <div className="space-y-1.5">
                  <h3 className="text-micro font-black text-foreground/50 uppercase tracking-widest">Description</h3>
                  <p className="text-xs text-foreground/70 leading-relaxed bg-surface-sink p-4 rounded-xl border border-surface-sink-border">
                    {activeDetail.description || 'No description provided.'}
                  </p>
                </div>

                {/* Beneficiaries vs Victims Grid */}
                <div className="space-y-4">
                  <h3 className="text-micro font-black text-foreground/50 uppercase tracking-widest">Impact Mapping</h3>
 
                  {activeDetail.type === 'GLOBAL' ? (
                    // Rendering global impact maps (regions / sectors)
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
 
                      {/* Beneficiaries Column */}
                      <div className="space-y-3">
                        <div className="flex items-center gap-2 text-up font-black text-xs uppercase tracking-wider bg-up/5 px-3 py-1.5 rounded-lg border border-up/10">
                          <span>🟢</span> Beneficiaries / Positives
                        </div>
 
                        {(() => {
                          const rawObj = activeDetail.rawObject as { impactedRegions?: string; impactedIndustries?: string }
                          let regions: EventImpact[] = []
                          let industries: EventImpact[] = []
                          try {
                            // biome-ignore lint/suspicious/noTsIgnore: legacy @ts-ignore kept for tsc (migrated from eslint-disable)
                            // @ts-ignore - TS strict fix
                            regions = JSON.parse(rawObj.impactedRegions || '[]')
                          } catch (e) {
                            console.warn(e)
                          }
                          try {
                            // biome-ignore lint/suspicious/noTsIgnore: legacy @ts-ignore kept for tsc (migrated from eslint-disable)
                            // @ts-ignore - TS strict fix
                            industries = JSON.parse(rawObj.impactedIndustries || '[]')
                          } catch (e) {
                            console.warn(e)
                          }

                          const positiveRegions = regions.filter(r => r.impact === 'POSITIVE')
                          const positiveIndustries = industries.filter(i => i.impact === 'POSITIVE')

                          if (positiveRegions.length === 0 && positiveIndustries.length === 0) {
                            return <div className="text-center py-6 text-foreground/70 text-xs border border-dashed border-surface-sink-border rounded-xl">No positive impacts defined.</div>
                          }

                          return (
                            <div className="space-y-2">
                              {positiveIndustries.map((ind, idx) => (
                                <div key={`ind-${idx}`} className="p-3 bg-surface-sink/60 rounded-xl border border-surface-sink-border/80">
                                  <div className="text-micro font-black text-up uppercase">Sector: {ind.industry}</div>
                                  <p className="text-xs text-foreground/50 mt-1 leading-relaxed">{ind.rationale}</p>
                                </div>
                              ))}
                              {positiveRegions.map((reg, idx) => (
                                <div key={`reg-${idx}`} className="p-3 bg-surface-sink/60 rounded-xl border border-surface-sink-border/80">
                                  <div className="text-micro font-black text-up uppercase">Region: {reg.region}</div>
                                  <p className="text-xs text-foreground/50 mt-1 leading-relaxed">{reg.rationale}</p>
                                </div>
                              ))}
                            </div>
                          )
                        })()}
                      </div>

                      {/* Victims Column */}
                      <div className="space-y-3">
                        <div className="flex items-center gap-2 text-danger font-black text-xs uppercase tracking-wider bg-danger/5 px-3 py-1.5 rounded-lg border border-danger/10">
                          <span>🔴</span> Victims / Negatives
                        </div>

                        {(() => {
                          const rawObj = activeDetail.rawObject as { impactedRegions?: string; impactedIndustries?: string }
                          let regions: EventImpact[] = []
                          let industries: EventImpact[] = []
                          try {
                            // biome-ignore lint/suspicious/noTsIgnore: legacy @ts-ignore kept for tsc (migrated from eslint-disable)
                            // @ts-ignore - TS strict fix
                            regions = JSON.parse(rawObj.impactedRegions || '[]')
                          } catch (e) {
                            console.warn(e)
                          }
                          try {
                            // biome-ignore lint/suspicious/noTsIgnore: legacy @ts-ignore kept for tsc (migrated from eslint-disable)
                            // @ts-ignore - TS strict fix
                            industries = JSON.parse(rawObj.impactedIndustries || '[]')
                          } catch (e) {
                            console.warn(e)
                          }

                          const negativeRegions = regions.filter(r => r.impact === 'NEGATIVE')
                          const negativeIndustries = industries.filter(i => i.impact === 'NEGATIVE')

                          if (negativeRegions.length === 0 && negativeIndustries.length === 0) {
                            return <div className="text-center py-6 text-foreground/70 text-xs border border-dashed border-surface-sink-border rounded-xl">No negative impacts defined.</div>
                          }

                          return (
                            <div className="space-y-2">
                              {negativeIndustries.map((ind, idx) => (
                                <div key={`ind-${idx}`} className="p-3 bg-surface-sink/60 rounded-xl border border-surface-sink-border/80">
                                  <div className="text-micro font-black text-danger uppercase">Sector: {ind.industry}</div>
                                  <p className="text-xs text-foreground/50 mt-1 leading-relaxed">{ind.rationale}</p>
                                </div>
                              ))}
                              {negativeRegions.map((reg, idx) => (
                                <div key={`reg-${idx}`} className="p-3 bg-surface-sink/60 rounded-xl border border-surface-sink-border/80">
                                  <div className="text-micro font-black text-danger uppercase">Region: {reg.region}</div>
                                  <p className="text-xs text-foreground/50 mt-1 leading-relaxed">{reg.rationale}</p>
                                </div>
                              ))}
                            </div>
                          )
                        })()}
                      </div>
                    </div>
                  ) : (
                    // Rendering corporate impact map (tickers)
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
 
                      {/* Beneficiary Tickers */}
                      <div className="space-y-3">
                        <div className="flex items-center gap-2 text-up font-black text-xs uppercase tracking-wider bg-up/5 px-3 py-1.5 rounded-lg border border-up/10">
                          <span>🟢</span> Bullish Beneficiaries
                        </div>

                        {(() => {
                          const corpEventObj = activeDetail.rawObject as { impacts: typeof initialTickerCatalysts }
                          const impacts = corpEventObj.impacts
                          // biome-ignore lint/suspicious/noTsIgnore: legacy @ts-ignore kept for tsc (migrated from eslint-disable)
                          // @ts-ignore - TS strict fix
                          const beneficiaries = impacts.filter(i => i.impactType === 'POSITIVE')

                          if (beneficiaries.length === 0) {
                            return <div className="text-center py-6 text-foreground/70 text-xs border border-dashed border-surface-sink-border rounded-xl">No beneficiaries specified.</div>
                          }

                          return (
                            <div className="space-y-2">
                              { }
                              {beneficiaries.map((b: TickerCatalyst) => (
                                <div key={b.id} className="p-3.5 bg-surface-sink/60 rounded-xl border border-surface-sink-border/80 space-y-2">
                                  <div className="flex justify-between items-center">
                                    <span className="px-2 py-0.5 text-micro font-black bg-up/10 text-up border border-up/20 rounded">
                                      {b.ticker}
                                    </span>
                                    <fetcher.Form method="post">
                                      <input type="hidden" name="intent" value="delete_ticker_catalyst" />
                                      <input type="hidden" name="id" value={b.id} />
                                      <button type="submit" disabled={fetcher.state === 'submitting'} className="text-micro text-foreground/50 hover:text-danger cursor-pointer">
                                        Remove impact
                                      </button>
                                    </fetcher.Form>
                                  </div>
                                  <p className="text-xs text-foreground/50 leading-relaxed">{b.description}</p>
                                </div>
                              ))}
                            </div>
                          )
                        })()}
                      </div>

                      {/* Victim Tickers */}
                      <div className="space-y-3">
                        <div className="flex items-center gap-2 text-danger font-black text-xs uppercase tracking-wider bg-danger/5 px-3 py-1.5 rounded-lg border border-danger/10">
                          <span>🔴</span> Bearish Victims
                        </div>

                        {(() => {
                          const corpEventObj = activeDetail.rawObject as { impacts: typeof initialTickerCatalysts }
                          const impacts = corpEventObj.impacts
                          const victims = (impacts || []).filter(i => i.impactType === 'NEGATIVE')

                          if (victims.length === 0) {
                            return <div className="text-center py-6 text-foreground/70 text-xs border border-dashed border-surface-sink-border rounded-xl">No victims specified.</div>
                          }

                          return (
                            <div className="space-y-2">
                              { }
                              {victims.map((v: TickerCatalyst) => (
                                <div key={v.id} className="p-3.5 bg-surface-sink/60 rounded-xl border border-surface-sink-border/80 space-y-2">
                                  <div className="flex justify-between items-center">
                                    <span className="px-2 py-0.5 text-micro font-black bg-danger/10 text-danger border border-danger/20 rounded">
                                      {v.ticker}
                                    </span>
                                    <fetcher.Form method="post">
                                      <input type="hidden" name="intent" value="delete_ticker_catalyst" />
                                      <input type="hidden" name="id" value={v.id} />
                                      <button type="submit" disabled={fetcher.state === 'submitting'} className="text-micro text-foreground/50 hover:text-danger cursor-pointer">
                                        Remove impact
                                      </button>
                                    </fetcher.Form>
                                  </div>
                                  <p className="text-xs text-foreground/50 leading-relaxed">{v.description}</p>
                                </div>
                              ))}
                            </div>
                          )
                        })()}
                      </div>
                    </div>
                  )}
                </div>

                {/* Event Deletion Actions */}
                <div className="border-t border-surface-sink-border pt-5 flex justify-between items-center">
                  <span className="text-micro text-foreground/50">
                    Created at: {new Date((activeDetail.rawObject as { createdAt?: Date }).createdAt || new Date()).toLocaleDateString()}
                  </span>
 
                  {activeDetail.type === 'GLOBAL' ? (
                    <fetcher.Form method="post" onSubmit={() => setSelectedCatalyst(null)}>
                      <input type="hidden" name="intent" value="delete_global" />
                      <input type="hidden" name="id" value={(activeDetail.rawObject as { id: number }).id} />
                      <button
                        type="submit"
                        disabled={fetcher.state === 'submitting'}
                        className="px-3.5 py-1.5 text-xs font-bold bg-danger/10 hover:bg-danger/20 border border-danger/20 text-danger rounded-xl transition-all cursor-pointer"
                      >
                        Delete Macro Event
                      </button>
                    </fetcher.Form>
                  ) : (
                    // For corporate event, delete all impacts at once
                    <fetcher.Form method="post" onSubmit={() => setSelectedCatalyst(null)}>
                      <input type="hidden" name="intent" value="add_ticker_catalyst" />
                      <button
                        type="button"
                        onClick={() => {
                          const corpEventObj = activeDetail.rawObject as { impacts: typeof initialTickerCatalysts }
                          const impacts = corpEventObj.impacts
                          if (confirm(`Are you sure you want to delete the corporate catalyst "${activeDetail.name}" and all associated ticker impacts?`)) {
                            for (const imp of impacts) {
                              fetcher.submit({ intent: 'delete_ticker_catalyst', id: String(imp.id) }, { method: 'post' })
                            }
                            setSelectedCatalyst(null)
                          }
                        }}
                        className="px-3.5 py-1.5 text-xs font-bold bg-danger/10 hover:bg-danger/20 border border-danger/20 text-danger rounded-xl transition-all cursor-pointer"
                      >
                        Delete Catalyst Event
                      </button>
                    </fetcher.Form>
                  )}
                </div>

              </div>
            ) : (
              <div className="h-64 flex items-center justify-center border border-dashed border-surface-sink-border rounded-2xl text-foreground/50 text-xs">
                Select an event from the timeline to view details and impacts.
              </div>
            )}
          </div>

        </div>

      </div>
    </div>
  )
}
