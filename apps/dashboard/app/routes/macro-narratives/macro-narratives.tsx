import { Surface } from 'app/components/Surface'
import { WorldMap } from 'app/components/WorldMap'
import { fetchFromPublicApi } from 'app/utils/apiClient'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Link } from 'react-router'

import type { Route } from './+types/macro-narratives'
import { MacroHypeChart } from './components/MacroHypeChart'

export interface Narrative {
  id: number
  name: string
  description: string
  status: string
  impactedRegions: string | null
  impactedSectors: string | null
  priceActionStatus?: 'CONFIRMED' | 'UNCONFIRMED' | 'DIVERGENT' | 'INSIDER_ACCUMULATION_DETECTED' | string
  isInsiderAccumulation?: boolean
  createdAt: string
  /**
   * Server-computed narrative-update count over the trailing 14 days
   * (same window as the scanner's narrativeHypeMap). Absent on old API
   * responses — fall back to the client-side update count.
   */
  hypeVelocity?: number
}

export interface ExposureWithMetadata {
  id: number
  narrativeId: number
  ticker: string
  exposureType: string
  derivativeTier: number
  reversalImpact: string
  rationale: string
  verification?: string
  rdRegion?: string
  supplyRegion?: string
  marketRegion?: string
  sector?: string
  fcfStatus?: {
    isValid: boolean
    reason: string
  }
}

export interface NarrativeUpdate {
  id: number
  narrativeId: number
  statement: string
  createdAt: string
}

export const REGION_COUNTRIES: Record<string, string[]> = {
  'USA': [
    'US',
  ],
  'China': [
    'CN',
  ],
  'Taiwan': [
    'TW',
  ],
  'Japan': [
    'JP',
  ],
  'India': [
    'IN',
  ],
  'Europe': [
    'DE',
    'FR',
    'GB',
    'IT',
    'ES',
    'NL',
    'BE',
    'CH',
    'SE',
    'PL',
    'IE',
    'FI',
    'DK',
    'NO',
    'AT',
    'UA',
    'RO',
    'GR',
  ],
  'Middle East': [
    'AE',
    'SA',
    'IL',
    'TR',
    'QA',
    'OM',
    'KW',
    'JO',
    'LB',
  ],
  'Latin America': [
    'BR',
    'MX',
    'AR',
    'CO',
    'CL',
    'PE',
    'VE',
    'EC',
    'GT',
    'CR',
  ],
  'Africa': [
    'ZA',
    'EG',
    'NG',
    'KE',
    'MA',
    'GH',
    'AO',
    'DZ',
    'ET',
    'TZ',
  ],
  'Asia': [
    'CN',
    'JP',
    'IN',
    'TW',
    'KR',
    'SG',
    'MY',
    'TH',
    'ID',
    'VN',
    'PH',
  ],
}

// Region normalization: raw DB values (ISO codes, aliases, named regions) →
// friendly display labels. Used by the Impacted Regions panels.
export const REGION_ALIASES: Record<string, string> = {
  'US': 'USA',
  'USA': 'USA',
  'UNITED STATES': 'USA',
  'U.S.': 'USA',
  'U.S.A.': 'USA',
  'GB': 'United Kingdom',
  'UK': 'United Kingdom',
  'UNITED KINGDOM': 'United Kingdom',
  'AE': 'UAE',
  'UAE': 'UAE',
  'UNITED ARAB EMIRATES': 'UAE',
  'CN': 'China',
  'CHINA': 'China',
  'TW': 'Taiwan',
  'TAIWAN': 'Taiwan',
  'JP': 'Japan',
  'JAPAN': 'Japan',
  'IN': 'India',
  'INDIA': 'India',
  'KR': 'South Korea',
  'SOUTH KOREA': 'South Korea',
  'SG': 'Singapore',
  'SINGAPORE': 'Singapore',
  'CA': 'Canada',
  'CANADA': 'Canada',
  'DE': 'Germany',
  'FR': 'France',
  'IT': 'Italy',
  'ES': 'Spain',
  'NL': 'Netherlands',
  'BE': 'Belgium',
  'CH': 'Switzerland',
  'SE': 'Sweden',
  'DK': 'Denmark',
  'FI': 'Finland',
  'IE': 'Ireland',
  'AT': 'Austria',
  'PL': 'Poland',
  'PT': 'Portugal',
  'GR': 'Greece',
  'RO': 'Romania',
  'UA': 'Ukraine',
  'NO': 'Norway',
  'RUSSIA': 'Russia',
  'BR': 'Brazil',
  'MX': 'Mexico',
  'AR': 'Argentina',
  'CO': 'Colombia',
  'CL': 'Chile',
  'PE': 'Peru',
  'VE': 'Venezuela',
  'EC': 'Ecuador',
  'ZA': 'South Africa',
  'EG': 'Egypt',
  'NG': 'Nigeria',
  'KE': 'Kenya',
  'MA': 'Morocco',
  'GH': 'Ghana',
  'SA': 'Saudi Arabia',
  'IL': 'Israel',
  'TR': 'Turkey',
  'QA': 'Qatar',
  'OM': 'Oman',
  'KW': 'Kuwait',
  'JO': 'Jordan',
  'LB': 'Lebanon',
  'GLOBAL': 'Global',
  'WORLDWIDE': 'Global',
  'EX-US MARKETS': 'Global',
  'NORTH AMERICA': 'North America',
  'SOUTH AMERICA': 'South America',
  'EUROPE': 'Europe',
  'MIDDLE EAST': 'Middle East',
  'LATIN AMERICA': 'Latin America',
  'AFRICA': 'Africa',
  'ASIA': 'Asia',
}

export function normalizeRegion(raw?: string): string {
  if (!raw) return ''
  const key = raw.trim().toUpperCase()
  return REGION_ALIASES[key] ?? raw.trim()
}

// Canonical region → REGION_COUNTRIES bucket key for WorldMap coloring.
// Unknown regions fall back to nothing (not colored).
export function regionToMapBucket(region: string): string | null {
  const key = region.trim().toUpperCase()
  if (key === 'GLOBAL') return 'Global'
  const normalized = REGION_ALIASES[key]
  if (!normalized) return null
  const bucket = REGION_MAP_BUCKETS[normalized]
  return bucket ?? null
}

// Friendly region label → REGION_COUNTRIES key used for coloring.
const REGION_MAP_BUCKETS: Record<string, string> = {
  'USA': 'USA',
  'China': 'China',
  'Taiwan': 'Taiwan',
  'Japan': 'Japan',
  'India': 'India',
  'United Kingdom': 'Europe',
  'UAE': 'Middle East',
  'South Korea': 'Asia',
  'Singapore': 'Asia',
  'Canada': 'USA',
  'Germany': 'Europe',
  'France': 'Europe',
  'Italy': 'Europe',
  'Spain': 'Europe',
  'Netherlands': 'Europe',
  'Belgium': 'Europe',
  'Switzerland': 'Europe',
  'Sweden': 'Europe',
  'Denmark': 'Europe',
  'Finland': 'Europe',
  'Ireland': 'Europe',
  'Austria': 'Europe',
  'Poland': 'Europe',
  'Portugal': 'Europe',
  'Greece': 'Europe',
  'Romania': 'Europe',
  'Ukraine': 'Europe',
  'Norway': 'Europe',
  'Russia': 'Europe',
  'Brazil': 'Latin America',
  'Mexico': 'Latin America',
  'Argentina': 'Latin America',
  'Colombia': 'Latin America',
  'Chile': 'Latin America',
  'Peru': 'Latin America',
  'Venezuela': 'Latin America',
  'Ecuador': 'Latin America',
  'South Africa': 'Africa',
  'Egypt': 'Africa',
  'Nigeria': 'Africa',
  'Kenya': 'Africa',
  'Morocco': 'Africa',
  'Ghana': 'Africa',
  'Saudi Arabia': 'Middle East',
  'Israel': 'Middle East',
  'Turkey': 'Middle East',
  'Qatar': 'Middle East',
  'Oman': 'Middle East',
  'Kuwait': 'Middle East',
  'Jordan': 'Middle East',
  'Lebanon': 'Middle East',
  'Europe': 'Europe',
  'Middle East': 'Middle East',
  'Latin America': 'Latin America',
  'Africa': 'Africa',
  'Asia': 'Asia',
  'North America': 'USA',
}

export interface LoaderData {
  narratives: Narrative[]
  exposures: ExposureWithMetadata[]
  updates: NarrativeUpdate[]
  /**
   * Pending-review TTL in hours, sourced from the server's configurable
   * `PENDING_TTL_HOURS` setting — NOT a hardcoded client constant.
   */
  pendingTtlHours: number
  error?: string
}

export async function loader({ request }: Route.LoaderArgs): Promise<LoaderData> {
  try {
    const narrativesRes = await fetchFromPublicApi('/market/macro-narratives', request)

    return {
      narratives: Array.isArray(narrativesRes.data?.narratives) ? narrativesRes.data.narratives as Narrative[] : [],
      exposures: Array.isArray(narrativesRes.data?.exposures) ? narrativesRes.data.exposures as ExposureWithMetadata[] : [],
      updates: Array.isArray(narrativesRes.data?.updates) ? narrativesRes.data.updates as NarrativeUpdate[] : [],
      pendingTtlHours: typeof narrativesRes.data?.pendingTtlHours === 'number' ? narrativesRes.data.pendingTtlHours : 48,
    }
  } catch (err) {
    if (err instanceof Response) throw err
    console.error('Failed to fetch macro narratives:', err)
    return {
      narratives: [] as Narrative[],
      exposures: [] as ExposureWithMetadata[],
      updates: [] as NarrativeUpdate[],
      pendingTtlHours: 48,
      error: 'Could not connect to the Quantour API. Please verify your connection and API key.',
    }
  }
}

export default function MacroNarratives({ loaderData }: Route.ComponentProps) {
  const {
    narratives = [], exposures = [], updates = [], pendingTtlHours = 48, error, 
  } = loaderData as LoaderData
  
  const [
    selectedNarrativeId,
    setSelectedNarrativeId,
  ] = useState<number | null>(narratives[0]?.id || null)
  const [
    selectedTicker,
    setSelectedTicker,
  ] = useState<string | null>(null)
  const [
    showMobileDetail,
    setShowMobileDetail,
  ] = useState(false)
  const [
    searchFilter,
    setSearchFilter,
  ] = useState('')
  const [
    sectorFilter,
    setSectorFilter,
  ] = useState('ALL')
  const [
    hoveredCountry,
    setHoveredCountry,
  ] = useState<string | null>(null)

  const timelineScrollRef = useRef<HTMLDivElement>(null)

  // Re-render every minute so pending-TTL countdowns tick without a reload.
  const [
    now,
    setNow,
  ] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60 * 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (timelineScrollRef.current) {
      timelineScrollRef.current.scrollTop = 0
    }
  }, [
    selectedNarrativeId,
  ])

  const GICS_SECTORS = [
    'Technology',
    'Healthcare',
    'Financials',
    'Consumer Discretionary', 
    'Communication Services',
    'Industrials',
    'Consumer Staples', 
    'Energy',
    'Utilities',
    'Real Estate',
    'Materials',
  ]

  const allSectors = useMemo(() => {
    const activeSectors = new Set(exposures.map(e => e.sector).filter((s): s is string => !!s))
    
    const combinedSectors = Array.from(new Set([
      ...GICS_SECTORS,
      ...activeSectors,
    ]))
    
    return combinedSectors.sort((a, b) => {
      const aActive = activeSectors.has(a)
      const bActive = activeSectors.has(b)
      if (aActive && !bActive) return -1
      if (!aActive && bActive) return 1
      return (a || '').localeCompare(b || '')
    })
  }, [
    exposures,
  ])

  const filteredNarratives = useMemo(() => {
    return narratives.filter(n => {
      if (n.status === 'ARCHIVED' || n.status === 'INACTIVE') {
        return false
      }
      const relatedExposures = exposures.filter(e => e.narrativeId === n.id)
      const matchesSearch = n.name.toLowerCase().includes(searchFilter.toLowerCase()) ||
        n.description.toLowerCase().includes(searchFilter.toLowerCase()) ||
        relatedExposures.some(e => e.ticker.toLowerCase().includes(searchFilter.toLowerCase()))
      
      const matchesSector = sectorFilter === 'ALL' || relatedExposures.some(e => e.sector === sectorFilter)

      return matchesSearch && matchesSector
    })
  }, [
    narratives,
    exposures,
    searchFilter,
    sectorFilter,
  ])

  const statusPriority: Record<string, number> = {
    'PENDING': 0,
    'ACTIVE': 1,
    'REVERSING': 2,
    'ARCHIVED': 3,
    'INACTIVE': 4,
  }

  const sortedNarratives = useMemo(() => {
    return [
      ...filteredNarratives,
    ].sort((a, b) => {
      const pA = statusPriority[a.status] ?? 99
      const pB = statusPriority[b.status] ?? 99
      if (pA !== pB) return pA - pB
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    })
  }, [
    filteredNarratives,
  ])

  const activeNarrative: Narrative | null = (narratives || []).find(n => n.id === selectedNarrativeId) || sortedNarratives?.[0] || null
  const activeExposures: ExposureWithMetadata[] = activeNarrative ? (exposures || []).filter(e => e.narrativeId === activeNarrative.id) : []
  const activeUpdates: NarrativeUpdate[] = activeNarrative ? (updates || []).filter(u => u.narrativeId === activeNarrative.id) : []

  const canonicalRegions = useMemo(() => {
    if (!activeNarrative) return []
    let regions: string[]
    try {
      regions = JSON.parse(activeNarrative.impactedRegions || '[]') as string[]
    } catch {
      regions = []
    }

    const parts = activeNarrative.name.split('_')
    const type = parts[parts.length - 1]
    const target = parts.slice(0, parts.length - 1).join(' ').toUpperCase()

    if (type === 'REGION') {
      if (target === 'GLOBAL' || target === 'EX-US MARKETS') regions.push('Global')
      else regions.push(target)
    }

    const normalized = regions.filter(Boolean).map(r => normalizeRegion(String(r)))
    return Array.from(new Set(normalized))
  }, [
    activeNarrative,
  ])

  const canonicalSectors = useMemo(() => {
    if (!activeNarrative) return []
    let sectors: string[]
    try {
      sectors = JSON.parse(activeNarrative.impactedSectors || '[]') as string[]
    } catch {
      sectors = []
    }

    const parts = activeNarrative.name.split('_')
    const type = parts[parts.length - 1]
    const target = parts.slice(0, parts.length - 1).join(' ').toUpperCase()

    if (type === 'SECTOR') {
      sectors.push(target)
    }

    return Array.from(new Set(sectors.filter(Boolean)))
  }, [
    activeNarrative,
  ])

  // Regions/sectors derived from the mapped tickers themselves — secondary
  // context, NOT part of the narrative's canonical impact footprint.
  const derivedRegions = useMemo(() => {
    if (!activeNarrative) return []
    const regions: string[] = []
    activeExposures.forEach((exp: { rdRegion?: string; supplyRegion?: string; marketRegion?: string }) => {
      if (exp.rdRegion) regions.push(exp.rdRegion)
      if (exp.supplyRegion) regions.push(exp.supplyRegion)
      if (exp.marketRegion) regions.push(exp.marketRegion)
    })
    const normalized = regions.filter(Boolean).map(r => normalizeRegion(String(r)))
    return Array.from(new Set(normalized))
  }, [
    activeNarrative,
    activeExposures,
  ])

  const derivedSectors = useMemo(() => {
    if (!activeNarrative) return []
    const sectors: string[] = []
    activeExposures.forEach((exp: { sector?: string }) => {
      if (exp.sector) sectors.push(exp.sector)
    })
    return Array.from(new Set(sectors.filter(Boolean)))
  }, [
    activeNarrative,
    activeExposures,
  ])

  // The World Map highlight uses both canonical + derived regions
  const impactedRegions = useMemo(() => Array.from(new Set([
    ...canonicalRegions,
    ...derivedRegions,
  ])), [
    canonicalRegions,
    derivedRegions,
  ])

  const selectedExposure = activeExposures.find((e: { ticker: string }) => e.ticker === selectedTicker)

  const secondDerivativeExposures = useMemo(() => {
    return selectedExposure && selectedExposure.derivativeTier === 1
      ? activeExposures.filter((e: { derivativeTier: number }) => e.derivativeTier === 2)
      : []
  }, [
    selectedExposure,
    activeExposures,
  ])

  const TIER_LABELS: Record<number, string> = {
    1: 'Tier 1 · Direct',
    2: 'Tier 2 · Secondary',
    3: 'Tier 3 · Consumer / App',
  }
  const tierLabel = (tier: number) => TIER_LABELS[tier] ?? `Tier ${tier}`

  // Impact chain grouped by derivative tier — Direct → Secondary → Consumer.
  const tierGroups = useMemo(() => {
    const groups = new Map<number, ExposureWithMetadata[]>()
    for (const exp of activeExposures) {
      const tier = exp.derivativeTier || 1
      if (!groups.has(tier)) groups.set(tier, [])
      groups.get(tier)!.push(exp)
    }
    return Array.from(groups.entries()).sort((a, b) => a[0] - b[0])
  }, [
    activeExposures,
  ])

  const getCountryFillColor = (countryCode: string) => {
    const colorForRegion = (rawRegion: string | undefined, color: string): string | null => {
      if (!rawRegion) return null
      const bucket = regionToMapBucket(rawRegion)
      if (bucket === 'Global') return color
      if (bucket) {
        const countries = REGION_COUNTRIES[bucket]
        if (countries && countries.includes(countryCode)) return color
      }
      return null
    }

    if (selectedExposure) {
      const rdColor = colorForRegion(selectedExposure.rdRegion, 'rgba(59, 130, 246, 0.75)')
      if (rdColor) return rdColor
      const supplyColor = colorForRegion(selectedExposure.supplyRegion, 'rgba(245, 158, 11, 0.75)')
      if (supplyColor) return supplyColor
      const marketColor = colorForRegion(selectedExposure.marketRegion, 'rgba(16, 185, 129, 0.65)')
      if (marketColor) return marketColor
    }

    for (const exp of secondDerivativeExposures) {
      const color = colorForRegion(exp.rdRegion, 'rgba(168, 85, 247, 0.7)')
      if (color) return color
    }

    if (impactedRegions.includes('Global')) return 'rgba(239, 68, 68, 0.25)'
    for (const r of impactedRegions) {
      const bucket = regionToMapBucket(r)
      if (bucket) {
        const list = REGION_COUNTRIES[bucket]
        if (list && list.includes(countryCode)) return 'rgba(239, 68, 68, 0.5)'
      }
    }
    return 'transparent'
  }

  const formatHeading = (text?: string) => {
    if (!text) return ''
    return text.replace(/_/g, ' ').replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
  }

  /**
   * Remaining hours before a PENDING narrative auto-expires. TTL comes from
   * the server's configurable `PENDING_TTL_HOURS`; returns null when the
   * creation time is missing so the caller can render a plain "Pending" pill
   * instead of inventing a countdown.
   */
  const getRemainingTTLHours = (createdAtStr?: string) => {
    if (!createdAtStr) return null
    const created = new Date(createdAtStr).getTime()
    const ttlMs = pendingTtlHours * 60 * 60 * 1000
    const remainingMs = created + ttlMs - now
    return Math.max(0, Math.ceil(remainingMs / (1000 * 60 * 60)))
  }

  const pendingLabel = (status: string, createdAt?: string) => {
    if (status !== 'PENDING') return status
    const remaining = getRemainingTTLHours(createdAt)
    return remaining !== null ? `⏳ Pending (${remaining}h)` : '⏳ Pending'
  }

  const pendingTitle = (status: string, createdAt?: string) => {
    if (status !== 'PENDING') return status
    const remaining = getRemainingTTLHours(createdAt)
    return remaining !== null ? `Pending AI Review (${remaining}h left)` : 'Pending AI Review'
  }

  const renderPriceActionBadge = (status?: string, isInsiderAccumulation?: boolean) => {
    if (status === 'INSIDER_ACCUMULATION_DETECTED' || isInsiderAccumulation === true) {
      return (
        <span
          title="Suspicious pre-event insider accumulation detected: Tagged tickers experienced unusual volume & price surges prior to public news."
          className="px-2 py-0.5 rounded-full text-micro font-black tracking-wider uppercase bg-purple-500/20 text-purple-400 border border-purple-500/30 flex items-center gap-1 shadow-sm cursor-help whitespace-nowrap"
        >
          🦊 Sneaky Fox
        </span>
      )
    }
    if (status === 'CONFIRMED') {
      return (
        <span
          title="Price action confirmed the narrative thesis"
          className="px-2 py-0.5 rounded-full text-micro font-black tracking-wider uppercase bg-success/20 text-success border border-success/30 flex items-center gap-1 shadow-sm cursor-help whitespace-nowrap"
        >
          🟢 Confirmed
        </span>
      )
    }
    if (status === 'DIVERGENT') {
      return (
        <span
          title="Price action contradicts the narrative thesis"
          className="px-2 py-0.5 rounded-full text-micro font-black tracking-wider uppercase bg-danger/20 text-danger border border-danger/30 flex items-center gap-1 shadow-sm cursor-help whitespace-nowrap"
        >
          🔴 Contradiction
        </span>
      )
    }
    return (
      <span
        title="Waiting for price action confirmation"
        className="px-2 py-0.5 rounded-full text-micro font-black tracking-wider uppercase bg-warning/20 text-warning border border-warning/30 flex items-center gap-1 shadow-sm cursor-help whitespace-nowrap"
      >
        🟡 Awaiting
      </span>
    )
  }

  if (error) {
    return (
      <div className="flex-1 p-6 flex items-center justify-center min-h-screen">
        <Surface surface="elevated" className="p-8 border border-danger/20 rounded-2xl max-w-lg text-center shadow-2xl">
          <h2 className="text-xl font-black text-danger mb-4">API Connection Error</h2>
          <p className="text-sm text-foreground/70 mb-6">{error}</p>
          <a href="/settings/api-keys" className="bg-primary text-primary-foreground px-6 py-3 rounded-xl font-bold uppercase tracking-wider text-xs">
            Configure API Key
          </a>
        </Surface>
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1 h-svh bg-background text-foreground min-h-0 overflow-hidden">
      <div className="flex flex-col gap-1.5 p-6 border-b border-primary/10 shrink-0">
        <h2 className="text-2xl font-black via-warning tracking-wide uppercase m-0 leading-none">
          🌍 Macro Narratives
        </h2>
        <span className="text-micro font-bold text-foreground/40 uppercase tracking-widest block">
          Current global thematic clusters and their market impact paths
        </span>
      </div>

      <div className="flex flex-col lg:flex-row flex-1 min-h-0 overflow-hidden relative">
        <Surface as="aside" surface="sink" className={`w-full lg:w-96 border-b lg:border-b-0 lg:border-r border-primary/10 flex-col shrink-0 lg:h-auto z-20 relative ${showMobileDetail ? 'hidden lg:flex' : 'flex h-full'}`}>
          <div className="p-4 border-b border-primary/5 space-y-3 shrink-0">
            <input
              type="text"
              placeholder="🔍 Search narratives, tickers..."
              value={searchFilter}
              onChange={e => setSearchFilter(e.target.value)}
              className="w-full bg-surface-base border border-surface-base-border rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-primary/50 transition-all font-medium placeholder:text-foreground/30"
            />
            <div className="flex gap-2 overflow-x-auto pb-1 custom-scrollbar">
              <button
                onClick={() => setSectorFilter('ALL')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition-all ${sectorFilter === 'ALL' ? 'bg-primary text-on-primary shadow-sm' : 'bg-surface-base hover:bg-surface-elevated text-foreground/70'}`}
              >
                All Sectors
              </button>
              {allSectors.map(s => {
                if (!s) return null
                const isActive = exposures.some((e: { sector?: string }) => e.sector === s)
                return (
                  <button
                    key={s}
                    onClick={() => setSectorFilter(s)}
                    disabled={!isActive}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition-all ${!isActive ? 'opacity-30 cursor-not-allowed bg-surface-base text-foreground/50' : sectorFilter === s ? 'bg-primary text-on-primary shadow-sm' : 'bg-surface-base hover:bg-surface-elevated text-foreground/70 cursor-pointer'}`}
                  >
                    {s}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-3 custom-scrollbar">
            {sortedNarratives.map((n: Narrative) => {
              const nExposures = exposures.filter((e: { narrativeId: number }) => e.narrativeId === n.id)
              const nUpdates = updates.filter((u: { narrativeId: number }) => u.narrativeId === n.id)
              const hypeVelocity = n.hypeVelocity ?? nUpdates.length

              return (
                <div
                  key={n.id}
                  onClick={() => { setSelectedNarrativeId(n.id); setSelectedTicker(null); setShowMobileDetail(true) }}
                  className={`p-3 rounded-xl border cursor-pointer transition-all ${selectedNarrativeId === n.id ? 'bg-surface-base border-primary/40 shadow-xl' : 'bg-surface-elevated border-transparent hover:border-primary/20 opacity-70 hover:opacity-100'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-black text-sm tracking-tight min-w-0 line-clamp-1 flex-1">{formatHeading(n.name)}</h3>
                    <span
                      title={pendingTitle(n.status, n.createdAt)}
                      className={`shrink-0 px-2 py-0.5 rounded-full text-micro font-black tracking-wider uppercase shadow-sm whitespace-nowrap ${n.status === 'ACTIVE' ? 'bg-success/20 text-success border border-success/30' : n.status === 'REVERSING' ? 'bg-warning/20 text-warning border border-warning/30' : n.status === 'PENDING' ? 'bg-warning/20 text-warning border border-warning/30 animate-pulse' : 'bg-foreground/10 text-foreground/60 border border-foreground/10'}`}
                    >
                      {pendingLabel(n.status, n.createdAt)}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap mt-2">
                    {renderPriceActionBadge(n.priceActionStatus, n.isInsiderAccumulation)}
                    {hypeVelocity > 0 && (
                      <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-info/10 text-info border border-info/20 text-micro font-black tracking-widest shadow-sm whitespace-nowrap">
                        <span className="animate-pulse">🔥</span> {hypeVelocity}
                      </span>
                    )}
                    <span className={`text-micro font-bold px-1.5 py-0.5 rounded border ${nExposures.length > 0 ? 'bg-foreground/5 text-foreground/60 border-foreground/10' : 'bg-foreground/5 text-foreground/30 border-foreground/10'}`}>
                      {nExposures.length} exposure{nExposures.length === 1 ? '' : 's'}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </Surface>

        <div className={`flex-1 flex-col min-w-0 min-h-0 bg-background relative ${showMobileDetail ? 'flex' : 'hidden lg:flex'}`}>
          <div className="hidden lg:block absolute inset-0 z-0 opacity-40 pointer-events-none">
            <WorldMap 
              getFillColor={getCountryFillColor} 
              getStrokeColor={() => 'rgba(194, 65, 12, 0.2)'}
              hoveredCountry={hoveredCountry}
              setHoveredCountry={setHoveredCountry} 
            />
          </div>

          <div className="relative z-10 flex-1 flex flex-col min-h-0 h-full lg:overflow-hidden overflow-y-auto p-6 gap-6">
            {activeNarrative ? (
              <div className="flex flex-col lg:h-full lg:min-h-0 gap-6">
                <button 
                  onClick={() => setShowMobileDetail(false)} 
                  className="lg:hidden self-start text-xs font-bold uppercase tracking-widest text-primary flex items-center gap-1 bg-primary/10 px-3 py-1.5 rounded-lg"
                >
                  ← Back to Narratives
                </button>

                {/* Header strip: narrative summary (static, no scroll) */}
                <Surface surface="elevated" className="p-5 rounded-2xl border border-surface-elevated-border shadow-lg backdrop-blur-xl bg-surface-elevated/80 shrink-0">
                  <div className="flex justify-between items-start gap-3 mb-3">
                    <div className="flex flex-col gap-1 min-w-0">
                      <h2 className="text-xl font-black">{formatHeading(activeNarrative.name)}</h2>
                      <span className="text-xs text-foreground/50 uppercase font-bold tracking-widest">
                        {new Date(activeNarrative.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                    <div className="flex gap-2 items-center flex-wrap justify-end shrink-0">
                      {renderPriceActionBadge(activeNarrative.priceActionStatus, activeNarrative.isInsiderAccumulation)}
                      <span
                        title={pendingTitle(activeNarrative.status, activeNarrative.createdAt)}
                        className={`px-2 py-1 rounded-full text-micro font-black tracking-widest uppercase shadow-inner whitespace-nowrap ${activeNarrative.status === 'ACTIVE' ? 'bg-success/20 text-success border border-success/30' : activeNarrative.status === 'REVERSING' ? 'bg-warning/20 text-warning border border-warning/30' : activeNarrative.status === 'PENDING' ? 'bg-warning/20 text-warning border border-warning/30 animate-pulse' : 'bg-foreground/10 text-foreground/60 border border-foreground/10'}`}
                      >
                        {pendingLabel(activeNarrative.status, activeNarrative.createdAt)}
                      </span>
                    </div>
                  </div>
                  <p className="text-sm text-foreground/80 leading-relaxed mb-4">
                    {activeNarrative.description}
                  </p>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <h4 className="text-xs font-bold text-foreground/40 uppercase">Impacted Regions</h4>
                      <div className="flex flex-wrap gap-2">
                        {canonicalRegions.map(region => (
                          <span key={region} className="px-2 py-1 bg-surface-elevated border border-surface-elevated-border text-xs rounded-md font-bold text-foreground/80">
                            {region}
                          </span>
                        ))}
                        {canonicalRegions.length === 0 && <span className="text-xs text-foreground/40 italic">Global / Not Specified</span>}
                      </div>
                      {derivedRegions.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          <span className="text-micro text-foreground/40 uppercase tracking-wider self-center">Derived:</span>
                          {derivedRegions.map(region => (
                            <span key={region} className="px-1.5 py-0.5 bg-surface-base border border-surface-base-border text-micro rounded-md font-bold text-foreground/60">
                              {region}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  
                    <div className="space-y-2">
                      <h4 className="text-xs font-bold text-foreground/40 uppercase">Impacted Sectors</h4>
                      <div className="flex flex-wrap gap-2">
                        {canonicalSectors.map(sector => (
                          <span key={sector} className="px-2 py-1 bg-surface-elevated border border-surface-elevated-border text-xs rounded-md font-bold text-foreground/80">
                            {sector}
                          </span>
                        ))}
                        {canonicalSectors.length === 0 && <span className="text-xs text-foreground/40 italic">Broad Market</span>}
                      </div>
                      {derivedSectors.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          <span className="text-micro text-foreground/40 uppercase tracking-wider self-center">Derived:</span>
                          {derivedSectors.map(sector => (
                            <span key={sector} className="px-1.5 py-0.5 bg-surface-base border border-surface-base-border text-micro rounded-md font-bold text-foreground/60">
                              {sector}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </Surface>

                {/* Two independently-scrolling detail columns */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 flex-1 lg:min-h-0 lg:h-full overflow-y-auto lg:overflow-hidden">
                  {/* Column 1: Impact Chain (tier-grouped) */}
                  <div className="flex flex-col gap-3 min-h-0 h-auto lg:h-full">
                    <h3 className="text-xs font-black text-warning uppercase tracking-wider flex items-center gap-2 px-2 shrink-0">
                      <span>⛓️ Impact Chain</span>
                    </h3>
                  
                    <div className="flex-1 overflow-visible lg:overflow-y-auto custom-scrollbar pr-2 pb-2 space-y-5">
                      {activeExposures.length === 0 ? (
                        <p className="text-sm text-foreground/50 italic px-2">No specific exposures mapped yet.</p>
                      ) : (
                        tierGroups.map(([
                          tier,
                          exps,
                        ]) => (
                          <div key={tier} className="flex flex-col gap-2">
                            <div className="flex items-center gap-2 px-2">
                              <span className="text-micro font-black uppercase tracking-widest text-foreground/50">
                                {tierLabel(tier)}
                              </span>
                              <span className="text-micro font-bold text-foreground/30">{exps.length}</span>
                              <div className="flex-1 h-px bg-foreground/10"></div>
                            </div>
                            {exps.map((exp: ExposureWithMetadata) => (
                              <Surface
                                surface="base"
                                key={exp.id}
                                onClick={() => setSelectedTicker(exp.ticker === selectedTicker ? null : exp.ticker)}
                                className={`p-4 rounded-2xl border cursor-pointer transition-all relative overflow-hidden group ${selectedTicker === exp.ticker ? 'border-primary/50 shadow-lg shadow-primary/10' : 'border-surface-base-border hover:border-primary/30 shadow-sm'} ${exp.exposureType === 'BENEFICIARY' ? 'bg-success/5' : 'bg-danger/5'}`}
                              >
                                <div className="flex justify-between items-start mb-2">
                                  <div className="flex items-center gap-3">
                                    <Link
                                      to={`/?ticker=${exp.ticker}`}
                                      onClick={(e) => e.stopPropagation()}
                                      className={`text-base font-black tracking-tight hover:underline cursor-pointer ${exp.exposureType === 'BENEFICIARY' ? 'text-success' : 'text-danger'}`}
                                    >
                                      {exp.ticker}
                                    </Link>
                                    <span className={`text-micro font-bold px-2 py-0.5 rounded-full border uppercase tracking-widest ${exp.exposureType === 'BENEFICIARY' ? 'bg-success/10 text-success border-success/20' : 'bg-danger/10 text-danger border-danger/20'}`}>
                                      {exp.exposureType === 'BENEFICIARY' ? '↑ Beneficiary' : '↓ Victim'}
                                    </span>
                                    {exp.verification ? (
                                      <span
                                        title={exp.verification}
                                        className="text-micro font-black px-2 py-0.5 rounded-full bg-accent/15 text-accent border border-accent/30 uppercase tracking-widest cursor-help"
                                      >
                                        ✓ Curated
                                      </span>
                                    ) : (
                                      <span
                                        title="Mapped automatically from ticker tags / sector / regions"
                                        className="text-micro font-bold px-2 py-0.5 rounded-full bg-foreground/5 text-foreground/40 border border-foreground/10 uppercase tracking-widest cursor-help"
                                      >
                                        Auto
                                      </span>
                                    )}
                                  </div>
                                </div>

                                <p className="text-xs text-foreground/70 leading-relaxed mb-3 line-clamp-3">
                                  {exp.rationale}
                                </p>

                                {exp.fcfStatus && (
                                  <div className="text-xs bg-background/50 p-2 rounded-lg border border-primary/10">
                                    {exp.fcfStatus.reason}
                                  </div>
                                )}
                              </Surface>
                            ))}
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  {/* Column 2: Timeline Updates */}
                  <div className="flex flex-col gap-3 min-h-0 h-auto lg:h-full">
                    <h3 className="text-xs font-black text-info uppercase tracking-wider px-2 shrink-0">
                      <span>⏱️ Timeline Updates</span>
                    </h3>

                    {/* Docked Hype Chart Row (top of the timeline column) */}
                    {activeUpdates.length > 0 && (
                      <div className="flex flex-col gap-2 shrink-0 h-40 border-b border-surface-base-border pb-3">
                        <h3 className="text-xs font-black text-info uppercase tracking-wider flex items-center gap-2 px-2 shrink-0">
                          <span>📈 Narrative Hype Lifecycle</span>
                        </h3>
                        <div className="flex-1 bg-surface-base/30 rounded-xl p-2 border border-surface-base-border/50 min-h-0">
                          <MacroHypeChart updates={activeUpdates} />
                        </div>
                      </div>
                    )}

                    <div ref={timelineScrollRef} className="flex-1 overflow-visible lg:overflow-y-auto custom-scrollbar pr-2 pb-2 space-y-3">
                      {activeUpdates.length === 0 ? (
                        <p className="text-sm text-foreground/50 italic px-2">No timeline updates tracked yet.</p>
                      ) : (
                        activeUpdates.map((u: { id: number; createdAt: string; statement?: string }) => (
                          <Surface surface="elevated" key={u.id} className="p-4 rounded-2xl border border-surface-elevated-border shadow-sm backdrop-blur-xl bg-surface-elevated/90 relative">
                            <div className="flex items-center gap-2 mb-2">
                              <div className="w-2 h-2 rounded-full bg-info shadow-[0_0_8px_rgba(96,165,250,0.8)]"></div>
                              <span className="text-micro font-bold text-foreground/50 uppercase tracking-widest">
                                {new Date(u.createdAt).toLocaleDateString()}
                              </span>
                            </div>
                            <p className="text-sm text-foreground/80 leading-relaxed font-medium">
                              {u.statement}
                            </p>
                          </Surface>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <p className="text-foreground/40 font-bold uppercase tracking-widest">Select a narrative to view details</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
