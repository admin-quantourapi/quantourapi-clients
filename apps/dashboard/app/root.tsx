
import type { ForwardTestPortfolioItem } from '@quantour/shared-algo/src/finance-algo/ast'
import { Surface } from 'app/components/Surface'
import { authClient } from 'app/lib/auth-client'
import { getSessionFromServer } from 'app/lib/auth-helpers'
import { fetchFromPublicApi } from 'app/utils/apiClient'
import {
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  isRouteErrorResponse,
  Link,
  Links,
  Meta,
  Outlet,
  redirect,
  Scripts,
  ScrollRestoration,
  useLocation,
  useRouteLoaderData,
} from 'react-router'

import appCss from './app.css?url'
import type { Route } from './+types/root'

export const links: Route.LinksFunction = () => [
  { rel: 'stylesheet', href: appCss },
  { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
  { rel: 'alternate icon', type: 'image/x-icon', href: '/favicon.ico' },
  {
    rel: 'apple-touch-icon',
    sizes: '180x180',
    href: '/icon-192x192.png',
  },
  {
    rel: 'icon',
    type: 'image/png',
    sizes: '192x192',
    href: '/icon-192x192.png',
  },
  {
    rel: 'icon',
    type: 'image/png',
    sizes: '512x512',
    href: '/icon-512x512.png',
  },
]


export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url)
  const isLoginPage = url.pathname === '/login'

  const cookieHeader = request.headers.get('Cookie') || ''
  const themeCookie = cookieHeader.match(/theme=(light|dark)/)?.[1]
  const initialTheme: 'light' | 'dark' = themeCookie === 'light' ? 'light' : 'dark'

  const session = await getSessionFromServer(request)

  if (!session && !isLoginPage) {
    return redirect('/login')
  }

  if (session && isLoginPage) {
    return redirect('/')
  }



  const defaultData = {
    session,
    hasPending: false,
    hasPendingCatalysts: false,
    isMacroSafe: true,
    liquidationThreat: null,
    macroData: {
      vix: null, vixy: null, tlt: null, gld: null, spy: null, riskFreeRate: null, inflationRate: null, marketPcr: null, spyChangePercent: null,
    },
    plan: 'Starter',
    credits: 0,
    unlimited: false,
    forwardTests: [] as ForwardTestPortfolioItem[],
    initialTheme: initialTheme as 'light' | 'dark',
  }

  if (isLoginPage || url.pathname.startsWith('/settings/api-keys')) {
    return defaultData
  }

  try {
    const data = (await fetchFromPublicApi('/market/macro', request)) as {
      data?: {
        isSafe?: boolean
        liquidationThreat?: {
          isThreat: boolean
          spyChange: number
          vixPrice: number
          reason: string
        }
        macroData?: {
          vix?: number
          vixy?: number
          tlt?: number
          gld?: number
          spy?: number
          riskFreeRate?: number
          inflationRate?: number
          marketPcr?: number
          spyChangePercent?: number
        }
      }
    }
    const pingData = (await fetchFromPublicApi('/ping', request)) as {
      plan?: string
      credits?: number
      unlimited?: boolean
    }

    const forwardTestsRes = (await fetchFromPublicApi('/forward-test', request).catch(() => null)) as {
      data?: ForwardTestPortfolioItem[]
    } | ForwardTestPortfolioItem[] | null

    const forwardTests: ForwardTestPortfolioItem[] = Array.isArray(forwardTestsRes)
      ? forwardTestsRes
      : Array.isArray(forwardTestsRes?.data)
        ? forwardTestsRes.data
        : []
    
    return {
      session,
      hasPending: false,
      hasPendingCatalysts: false,
      isMacroSafe: data?.data?.isSafe ?? true,
      liquidationThreat: data?.data?.liquidationThreat,
      macroData: data?.data?.macroData || {
        vix: null, vixy: null, tlt: null, gld: null, spy: null, riskFreeRate: null, inflationRate: null, marketPcr: null, spyChangePercent: null,
      },
      plan: pingData?.plan || 'Starter',
      credits: pingData?.credits || 0,
      unlimited: pingData?.unlimited ?? false,
      forwardTests,
      initialTheme,
    }
  } catch (error) {
    if (error instanceof Response) {
      throw error
    }
    console.error('Failed to load root layout data:', error)
    return defaultData
  }
}



export function Layout({ children }: { children: React.ReactNode }) {
  const data = useRouteLoaderData<typeof loader>('root')

  let initialTheme: 'light' | 'dark' = 'dark'
  if (data?.initialTheme) {
    initialTheme = data.initialTheme
  }

  const [
    isMobileMenuOpen,
    setIsMobileMenuOpen,
  ] = useState(false)
  const [
    sidebarOverride,
    setSidebarOverride,
  ] = useState<'collapsed' | 'expanded' | null>(null)
  const [
    theme,
    setTheme,
  ] = useState<'light' | 'dark'>(initialTheme)
  const [
    isInvestingCollapsed,
    setIsInvestingCollapsed,
  ] = useState(false)
  const [
    isActiveMonitoringCollapsed,
    setIsActiveMonitoringCollapsed,
  ] = useState(false)
  const [
    isSettingsCollapsed,
    setIsSettingsCollapsed,
  ] = useState(false)

  const location = useLocation()
  const pathname = location.pathname

  // On md+ the page content scrolls inside the main Surface (window never
  // scrolls there), so ScrollRestoration has no window scroll to restore and
  // navigating between routes would keep the previous page's inner scroll
  // position. Reset the content scroll container on every pathname change.
  const mainContentRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    mainContentRef.current?.scrollTo(0, 0)
  }, [
    pathname,
  ])

  useEffect(() => {
    const cookieHeader = document.cookie
    const themeCookie = cookieHeader.match(/theme=(light|dark)/)?.[1]
    
    if (!themeCookie) {
      const isSystemLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
      const detectedTheme = isSystemLight ? 'light' : 'dark'
      setTheme(detectedTheme)
      document.cookie = `theme=${detectedTheme}; path=/; max-age=31536000; SameSite=Lax`
    }

    const version = import.meta.env.VITE_COMMIT_HASH
    if (version) {
      console.log(`%c⛰️ Quantour Version: ${version}`, 'color: #ffd700; font-weight: bold; font-size: 1.2em;')
    }
  }, [])

  const toggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark'
    setTheme(nextTheme)
    document.cookie = `theme=${nextTheme}; path=/; max-age=31536000; SameSite=Lax`
  }

  const hasPending = false
  const hasPendingCatalysts = false
  const session = data?.session ?? null
  const isMacroSafe = data?.isMacroSafe ?? true
  const liquidationThreat = data?.liquidationThreat ?? null
  const macroData = data?.macroData ?? {
    vix: null, vixy: null, tlt: null, gld: null, spy: null, marketPcr: null, spyChangePercent: null,
  }
  const plan = data?.plan || 'Starter'
  const credits = data?.credits || 0

  const linkClass = (path: string) => {
    const isActive = pathname === path || (path !== '/' && pathname.startsWith(path))
    return `flex items-center gap-3 px-3 py-2 text-xs font-bold rounded-xl transition-all cursor-pointer ${
      isActive 
        ? 'bg-primary text-on-primary shadow-sm' 
        : 'text-foreground/70 hover:bg-primary/10 hover:text-primary'
    }`
  }



  if (!session || pathname.startsWith('/b2c')) {
    return (
      <html lang="en" className={theme}>
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="theme-color" content="#36A2EB" />
          <link rel="manifest" href="/manifest.json" />
          <link rel="apple-touch-icon" href="/icon.svg" />
          <Meta />
          <Links />
        </head>
        <body className="bg-background text-foreground min-h-screen">
          <div className="flex flex-col min-h-screen">
            {children}
          </div>
          <ScrollRestoration />
          <Scripts />
        </body>
      </html>
    )
  }

  return (
    <html lang="en" className={theme} suppressHydrationWarning>
      <head suppressHydrationWarning>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Quantour | Quantitative Financial Data &amp; Scoring Platform</title>
        <meta name="theme-color" content="#121212" />
        <link rel="manifest" href="/manifest.json" />
        <link rel="apple-touch-icon" href="/icon.svg" />
        <Meta />
        <Links />
        <script dangerouslySetInnerHTML={{
          __html: `
          if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
              navigator.serviceWorker.register('/sw.js').catch(err => {
                console.log('ServiceWorker registration failed: ', err);
              });
            });
          }
        `, 
        }} />
      </head>
      <body className="bg-background text-foreground min-h-screen" suppressHydrationWarning>
        <div className="flex flex-col md:flex-row min-h-screen max-w-[106.25rem] mx-auto w-full">
          {/* Sidebar */}
          <Surface id="sidebar-container" surface="sink" as="aside" className={`group/sidebar w-full border-b md:border-b-0 md:border-r border-primary/10 shrink-0 md:sticky md:top-0 h-screen z-40 flex flex-col transition-all duration-300 ${sidebarOverride === 'collapsed' ? 'md:w-[4.5rem] force-collapse' : sidebarOverride === 'expanded' ? 'md:w-64 force-expand' : 'md:w-[4.5rem] xl:w-64'}`}>
            <div className="p-4 border-b border-primary/10 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h1 data-testid="brand-heading" className="text-xs font-black bg-gradient-to-r from-warning via-primary to-danger bg-clip-text text-transparent tracking-widest uppercase m-0 leading-none">
                  Quantour
                </h1>
              </div>
              <div className="flex items-center gap-2">
                {/* Desktop Collapse Button */}
                <button 
                  onClick={() => {
                    if (sidebarOverride === null) {
                      if (window.innerWidth < 1280) setSidebarOverride('expanded')
                      else setSidebarOverride('collapsed')
                    } else if (sidebarOverride === 'expanded') {
                      setSidebarOverride('collapsed')
                    } else {
                      setSidebarOverride('expanded')
                    }
                  }}
                  className="hidden md:flex p-2 rounded-xl bg-background border border-primary/10 text-foreground/60 hover:text-primary hover:bg-primary/10 transition-all cursor-pointer"
                  title="Toggle Sidebar"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M11 19l-7-7 7-7M19 19l-7-7 7-7" className="block group-[.force-collapse]/sidebar:!hidden group-[.force-expand]/sidebar:!block group-[]/sidebar:max-xl:hidden" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 5l7 7-7 7M5 5l7 7-7 7" className="hidden group-[.force-collapse]/sidebar:!block group-[.force-expand]/sidebar:!hidden group-[]/sidebar:max-xl:block" />
                  </svg>
                </button>
                {/* Mobile Menu Button */}
                <button 
                  onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
                  aria-label={isMobileMenuOpen ? 'Close menu' : 'Open menu'}
                  className="md:hidden p-2 rounded-xl bg-background border border-primary/10 text-foreground/60 hover:text-primary hover:bg-primary/10 transition-all cursor-pointer"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    {isMobileMenuOpen ? (
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                    ) : (
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 6h16M4 12h16M4 18h16" />
                    )}
                  </svg>
                </button>
              </div>
            </div>

            {/* Sidebar Links */}
            <div className={`flex-1 overflow-y-auto p-4 space-y-6 ${isMobileMenuOpen ? 'block' : 'hidden md:block'}`}>
              {/* Trading Setup Section */}
              <div className="space-y-2">
                <div 
                  className="flex items-center justify-between px-3 cursor-pointer group"
                  onClick={() => setIsInvestingCollapsed(!isInvestingCollapsed)}
                >
                  <h2 className="text-micro font-black text-foreground/70 uppercase tracking-widest group-hover:text-primary transition-colors">
                    🤖 Trading Setup
                  </h2>
                  <svg className={`section-chevron w-3 h-3 text-foreground/40 transition-transform ${isInvestingCollapsed ? '-rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
                <div className={`space-y-1 transition-all duration-300 origin-top overflow-hidden ${isInvestingCollapsed ? 'max-h-0 opacity-0' : 'max-h-[93.75rem] opacity-100'}`}>
                  {!!session && (
                    <Link to="/strategy-builder" className={linkClass('/strategy-builder')}>
                      <span>🎨</span>
                      <span>Strategy Studio & Workbench</span>
                    </Link>
                  )}
                  {!!session && (
                    <Link to="/cohorts" className={linkClass('/cohorts')}>
                      <span>🧩</span>
                      <span>Cohorts</span>
                    </Link>
                  )}
                  {!!session && (
                    <Link to="/strategy-builder?tab=tests" className={linkClass('/strategy-builder?tab=tests') + ' justify-between'}>
                      <div className="flex items-center gap-3">
                        <span>⚡</span>
                        <span>Live Forward Tests</span>
                      </div>
                      <span className="bg-primary/20 text-primary text-[10px] font-black px-1.5 py-0.5 rounded-full">
                        {(data?.forwardTests || []).length}
                      </span>
                    </Link>
                  )}

                  {/* Active Forward Tests List */}
                  {!!session && (data?.forwardTests || []).length > 0 && (
                    <div className="pl-6 space-y-1 pt-1 border-l-2 border-primary/20 ml-4">
                      {(data?.forwardTests || []).map((ft) => {
                        const tid = (ft.chatId || ft.id || '1') as string | number
                        const testName = ft.name || ft.strategyName || `Forward Test #${tid}`
                        const ftStats = (ft as { stats?: { initialCapital?: number | string; estimatedTotalValue?: number | string } }).stats
                        const ftInitial = Number(ftStats?.initialCapital ?? 0)
                        const ftCurrent = Number(ftStats?.estimatedTotalValue ?? 0)
                        const fallbackPct = ftInitial > 0 ? ((ftCurrent - ftInitial) / ftInitial) * 100 : 0
                        const returnPct = Number((ft as { totalReturnPct?: number }).totalReturnPct ?? fallbackPct)
                        const isPositive = Number(returnPct) >= 0
                        const isTestActive = pathname.includes('/strategy-builder') && location.search.includes(`testId=${tid}`)

                        return (
                          <Link
                            key={String(tid)}
                            to={`/strategy-builder?tab=tests&testId=${tid}`}
                            className={`flex items-center justify-between px-2.5 py-1.5 text-[11px] font-mono rounded-lg transition-all ${
                              isTestActive
                                ? 'bg-surface-elevated text-primary font-bold shadow-sm border border-primary/30'
                                : 'text-foreground/70 hover:text-foreground hover:bg-surface-sink'
                            }`}
                          >
                            <div className="flex items-center gap-1.5 truncate">
                              <span className="text-[9px]">{ft.status === 'PAUSED' ? '🟡' : '🟢'}</span>
                              <span className="truncate">{testName}</span>
                            </div>
                            <span className={`text-[10px] font-black shrink-0 ml-1 ${isPositive ? 'text-success' : 'text-danger'}`}>
                              {isPositive ? '+' : ''}{Number(returnPct).toFixed(1)}%
                            </span>
                          </Link>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>

              {/* Active Monitoring Section */}
              <div className="space-y-2">
                <div 
                  className="flex items-center justify-between px-3 cursor-pointer group"
                  onClick={() => setIsActiveMonitoringCollapsed(!isActiveMonitoringCollapsed)}
                >
                  <h2 className="text-micro font-black text-foreground/70 uppercase tracking-widest group-hover:text-primary transition-colors">
                    📈 Active Monitoring
                  </h2>
                  <svg className={`section-chevron w-3 h-3 text-foreground/40 transition-transform ${isActiveMonitoringCollapsed ? '-rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
                <div className={`space-y-1 transition-all duration-300 origin-top overflow-hidden ${isActiveMonitoringCollapsed ? 'max-h-0 opacity-0' : 'max-h-[93.75rem] opacity-100'}`}>
                  {!!session && (
                    <Link to="/signals" className={linkClass('/signals')}>
                      <span>🚨</span>
                      <span>Signals</span>
                    </Link>
                  )}
                  {!!session && (
                    <Link to="/positions" className={linkClass('/positions')}>
                      <span>💼</span>
                      <span>Portfolio</span>
                    </Link>
                  )}
                </div>
              </div>

              {/* Research Section */}
              <div className="space-y-2">
                <div 
                  className="flex items-center justify-between px-3 cursor-pointer group"
                  onClick={() => setIsSettingsCollapsed(!isSettingsCollapsed)}
                >
                  <h2 className="text-micro font-black text-foreground/70 uppercase tracking-widest group-hover:text-primary transition-colors">
                    🔍 Research
                  </h2>
                  <svg className={`section-chevron w-3 h-3 text-foreground/40 transition-transform ${isSettingsCollapsed ? '-rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
                <div className={`space-y-1 transition-all duration-300 origin-top overflow-hidden ${isSettingsCollapsed ? 'max-h-0 opacity-0' : 'max-h-[93.75rem] opacity-100'}`}>
                  {!!session && (
                    <Link to="/" className={linkClass('/')}>
                      <span>📊</span>
                      <span>Tickers Pool</span>
                    </Link>
                  )}
                  {!!session && (
                    <Link to="/emerging-leaders" className={linkClass('/emerging-leaders')}>
                      <span>💎</span>
                      <span>Emerging Leaders</span>
                    </Link>
                  )}
                  {!!session && (
                    <Link to="/second-derivative" className={linkClass('/second-derivative')}>
                      <span>🔗</span>
                      <span>Second Derivative</span>
                    </Link>
                  )}
                  {!!session && (
                    <Link to="/macro-narratives" className={linkClass('/macro-narratives') + ' justify-between'}>
                      <div className="flex items-center gap-3">
                        <span>🌍</span>
                        <span>Macro Narratives</span>
                      </div>
                      {hasPending && (
                        <span className="relative flex h-2 w-2 shrink-0">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500"></span>
                        </span>
                      )}
                    </Link>
                  )}
                  {!!session && (
                    <Link to="/catalysts" className={linkClass('/catalysts') + ' justify-between'}>
                      <div className="flex items-center gap-3">
                        <span>📅</span>
                        <span>Catalysts</span>
                      </div>
                      {hasPendingCatalysts && (
                        <span className="relative flex h-2 w-2 shrink-0">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-warning/40 opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-warning"></span>
                        </span>
                      )}
                    </Link>
                  )}
                </div>
              </div>

              {session && (
                <div className="space-y-2 mb-6">
                  <div 
                    className="flex items-center justify-between px-3 cursor-pointer group"
                    onClick={() => setIsSettingsCollapsed(!isSettingsCollapsed)}
                  >
                    <h2 className="text-micro font-black text-foreground/70 uppercase tracking-widest group-hover:text-primary transition-colors">
                      ⚙️ Settings
                    </h2>
                    <svg className={`section-chevron w-3 h-3 text-foreground/40 transition-transform ${isSettingsCollapsed ? '-rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                  <div className={`transition-all duration-300 origin-top overflow-hidden ${isSettingsCollapsed ? 'max-h-0 opacity-0' : 'max-h-[62.5rem] opacity-100'}`}>
                    <div className="space-y-1 mt-2">
                      {session && (
                        <>
                          <Link to="/settings/api-keys" className={linkClass('/settings/api-keys')}>
                            <span>🔑</span>
                            <span>API Keys</span>
                          </Link>
                          <Link to="/debug-ast" className={linkClass('/debug-ast')}>
                            <span>🐛</span>
                            <span>Debug AST</span>
                          </Link>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Macro Environment Card */}
              <div className="w-full select-none mb-6 macro-container">
                <Surface surface="elevated" className="w-full h-full p-3 rounded-2xl border border-surface-elevated-border shadow-sm flex flex-col justify-between">
                  <div className="macro-collapsed flex flex-col items-center justify-center gap-4 py-2" title={`Macro Environment\nSafety: ${isMacroSafe ? 'Safe' : 'Halted'}\nLiquidation: ${liquidationThreat?.isThreat ? 'Threat' : 'Normal'}`}>
                    <div 
                      className={`w-3 h-3 rounded-full shadow-sm ${isMacroSafe ? 'bg-success shadow-[0_0_8px_rgba(var(--success-rgb),0.5)]' : 'bg-danger shadow-[0_0_8px_rgba(var(--danger-rgb),0.5)]'}`} 
                      title={`Safety Status: ${isMacroSafe ? 'Safe' : 'Halted'}`} 
                    />
                    <div 
                      className={`w-3 h-3 rounded-full shadow-sm ${liquidationThreat?.isThreat ? 'bg-danger shadow-[0_0_8px_rgba(var(--danger-rgb),0.5)] animate-pulse' : 'bg-success shadow-[0_0_8px_rgba(var(--success-rgb),0.5)]'}`} 
                      title={`Liquidation Threat: ${liquidationThreat?.isThreat ? 'Threat' : 'Normal'}`} 
                    />
                  </div>
                  <div className="macro-expanded flex flex-col space-y-2 h-[12.125rem] justify-between">
                    <div>
                      <div className="flex items-center justify-center">
                        <h2 className="text-micro font-black text-foreground/70 uppercase tracking-widest px-1 text-center" title="Macro Environment">
                          🛡️ <span className="ml-1">Macro Environment</span>
                        </h2>
                      </div>
                      <div className="space-y-2.5 mt-2">
                        {/* Environment Safety */}
                        <div className="flex text-xs px-1 items-center justify-between">
                          <span className="text-foreground/60">Safety Status:</span>
                          <span className={`font-bold flex items-center justify-center gap-1 ${isMacroSafe ? 'text-success' : 'text-danger'}`} title="Safety Status">
                            {isMacroSafe ? '● Safe' : '● Halted'}
                          </span>
                        </div>

                        {/* Liquidation Threat */}
                        <div className="flex text-xs px-1 items-center justify-between">
                          <span className="text-foreground/60">Liquidation:</span>
                          <span className={`font-bold flex items-center justify-center gap-1 ${liquidationThreat?.isThreat ? 'text-danger animate-pulse' : 'text-success'}`} title="Liquidation Threat">
                            {liquidationThreat?.isThreat ? '● Threat' : '● Normal'}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Indicator metrics */}
                    <div className="border-t border-surface-elevated-border pt-2 grid gap-2 text-micro grid-cols-2">
                      <Surface surface="sink" className="p-1.5 rounded-lg border border-surface-sink-border text-center" title="VIX">
                        <span className="text-foreground/60 block text-micro uppercase leading-none mb-0.5">VIX</span>
                        <span className="font-bold text-foreground/80 leading-none">
                          {/* Real CBOE VIX index when available; VIXY ETF only as a labeled fallback */}
                          {macroData.vix != null
                            ? macroData.vix.toFixed(2)
                            : macroData.vixy != null && macroData.vixy > 0
                              ? `${macroData.vixy.toFixed(2)}ᵥ`
                              : 'N/A'}
                        </span>
                      </Surface>
                      <Surface surface="sink" className="p-1.5 rounded-lg border border-surface-sink-border text-center" title="TLT">
                        <span className="text-foreground/60 block text-micro uppercase leading-none mb-0.5">TLT</span>
                        <span className="font-bold text-foreground/80 leading-none">
                          {macroData.tlt != null && macroData.tlt > 0 ? `${macroData.tlt.toFixed(2)}` : 'N/A'}
                        </span>
                      </Surface>
                      <Surface surface="sink" className="p-1.5 rounded-lg border border-surface-sink-border text-center" title="Put/Call">
                        <span className="text-foreground/60 block text-micro uppercase leading-none mb-0.5">PCR</span>
                        <span className="font-bold text-foreground/80 leading-none">
                          {macroData.marketPcr != null && macroData.marketPcr > 0 ? macroData.marketPcr.toFixed(2) : 'N/A'}
                        </span>
                      </Surface>
                      <Surface surface="sink" className="p-1.5 rounded-lg border border-surface-sink-border text-center" title="SPY Daily">
                        <span className="text-foreground/60 block text-micro uppercase leading-none mb-0.5">SPY</span>
                        <span className={`font-bold leading-none ${
                          macroData.spyChangePercent != null && macroData.spyChangePercent < 0
                            ? 'text-danger'
                            : macroData.spyChangePercent != null && macroData.spyChangePercent > 0
                              ? 'text-success'
                              : 'text-foreground/80'
                        }`}>
                          {macroData.spyChangePercent != null
                            ? `${macroData.spyChangePercent > 0 ? '+' : ''}${macroData.spyChangePercent.toFixed(1)}%`
                            : 'N/A'}
                        </span>
                      </Surface>
                    </div>
                  </div>
                </Surface>
              </div>
              
              {/* Account Status / Plan */}
              {session && (
                <div className="user-controls mt-4 px-3 py-3 border border-primary/10 rounded-xl bg-background/30 flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-foreground/60 uppercase tracking-wider">Plan</span>
                    <span className="bg-primary/20 text-primary px-2 py-0.5 rounded text-xs uppercase tracking-wider">{plan}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-foreground/60 uppercase tracking-wider">Credits</span>
                    <span className="bg-success/20 text-success px-2 py-0.5 rounded text-xs uppercase tracking-wider">
                      {data?.unlimited ? 'Unlimited' : `${credits} left`}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* User Profile / Sign Out Section */}
            {session && (
              <div className={`p-4 border-t border-primary/10 bg-background/50 ${isMobileMenuOpen ? 'block' : 'hidden md:block'}`}>
                <div className="flex flex-col gap-3">
                  {/* Status & Theme Controls */}
                  <div className="flex items-center justify-between border-b border-primary/5 pb-3">
                    <div className="flex items-center gap-1.5 user-controls">
                    </div>
                    <button
                      onClick={() => {
                        if (sidebarOverride === null) {
                          if (window.innerWidth < 1280) setSidebarOverride('expanded')
                          else setSidebarOverride('collapsed')
                        } else if (sidebarOverride === 'expanded') {
                          setSidebarOverride('collapsed')
                        } else {
                          setSidebarOverride('expanded')
                        }
                      }}
                      className="px-2 py-0.5 rounded-lg border border-primary/20 hover:bg-primary/10 hover:text-primary transition-all text-micro flex items-center gap-1 cursor-pointer font-black select-none bg-background text-foreground/80"
                    >
                    </button>
                    <button
                      onClick={toggleTheme}
                      className="px-2 py-0.5 rounded-lg border border-primary/20 hover:bg-primary/10 hover:text-primary transition-all text-micro flex items-center gap-1 cursor-pointer font-black select-none bg-background text-foreground/80"
                      title="Toggle Theme"
                    >
                      {theme === 'dark' ? '☀️ Light' : '🌙 Dark'}
                    </button>
                  </div>

                  <div className="flex items-center gap-3 user-controls">
                    <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-primary to-special flex items-center justify-center text-on-primary font-black shadow-inner shrink-0">
                      {session.user.email.substring(0, 1).toUpperCase()}
                    </div>
                    <div className={'flex flex-col overflow-hidden'}>
                      <span className="text-sm font-black truncate">{session.user.email}</span>
                    </div>
                  </div>
                  <button 
                    onClick={async () => {
                      await authClient.signOut()
                      window.location.href = '/login'
                    }}
                    className={'w-full py-2 px-3 rounded-xl bg-danger text-white border border-danger hover:bg-danger transition-all text-xs font-bold cursor-pointer select-none text-center shadow-sm hover:shadow user-controls'}
                  >
                    Sign Out
                  </button>
                </div>
              </div>
            )}
          </Surface>

          {/* Main Layout Area — bounded app frame on md+: content scrolls inside
              this Surface (window keeps the sticky sidebar). Mobile keeps
              normal window scroll. */}
          <Surface surface="base" ref={mainContentRef} className={'flex-1 flex flex-col min-h-screen md:h-screen md:overflow-y-auto min-w-0 transition-all duration-300'}>
            {/* Page Content */}
            <main className="flex-1 flex flex-col min-w-0">
              {children}
            </main>
          </Surface>

        </div>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  )
}

export default function App() {
  return <Outlet />
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = 'Oops!'
  let details = 'An unexpected error occurred.'

  if (isRouteErrorResponse(error)) {
    message = `${error.status} ${error.statusText}`
    details = typeof error.data === 'string' ? error.data : details
  } else if (error instanceof Error) {
    message = error.message
    details = error.stack || details
  }

  return (
    <div className="pt-16 p-4 container mx-auto">
      <h1 className="text-2xl font-bold text-danger mb-4">{message}</h1>
      <p>{details}</p>
    </div>
  )
}
