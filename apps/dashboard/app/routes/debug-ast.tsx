import {
  type ASTNode,
  type CustomStrategyAST,
} from '@quantour/shared-algo/src/finance-algo/ast'
import {
  evaluateSetup,
  type MarketData,
} from '@quantour/shared-algo/src/finance-algo/screener'
import { fetchFromPublicApi } from 'app/utils/apiClient'
import {
  useEffect,
  useState, 
} from 'react'
import { Link } from 'react-router'

import type { Route } from './+types/debug-ast'

interface EvaluationResult {
  strategyName?: string
  score?: number
  riskPerShare?: number
  targetPrice?: number
  reason?: string
  isValid?: boolean
}

interface ItemData {
  ticker: string
  price: number
  results: EvaluationResult[]
}

const fallbackAST: ASTNode = {
  and: [
    { indicator: 'rsi', operator: '<', value: 70 },
  ],
}

export async function loader({ request }: Route.LoaderArgs) {
  try {
    const [
      tickersRes,
      settingsRes,
      budgetRes,
    ] = await Promise.all([
      fetchFromPublicApi('/market/tickers', request).catch(() => null),
      fetchFromPublicApi('/api/settings', request).catch(() => null),
      fetchFromPublicApi('/api/portfolio/budget', request).catch(() => null),
    ])

    const tickers = Array.isArray(tickersRes?.data)
      ? tickersRes.data
      : Array.isArray(tickersRes)
        ? tickersRes
        : []

    let astNode: ASTNode = fallbackAST
    const settings = settingsRes?.data || settingsRes || {}
    if (settings.mainStrategyAst && typeof settings.mainStrategyAst === 'string' && settings.mainStrategyAst.startsWith('{')) {
      try {
        astNode = JSON.parse(settings.mainStrategyAst) as ASTNode
      } catch (_err) {
        astNode = fallbackAST
      }
    }

    // Budget lives in user_budgets (the settings budget columns were dropped);
    // the budget endpoint is the canonical source for risk/capital.
    const budget = budgetRes?.data || budgetRes || {}

    return {
      tickers,
      astNode,
      maxRiskPerTrade: (budget.maxRiskPerTrade as string) || '300',
      totalCapital: (budget.totalCapital as string) || '10000',
      error: null,
    }
  } catch (err) {
    console.error('[DEBUG AST LOADER ERROR]', err)
    return {
      tickers: [],
      astNode: fallbackAST,
      maxRiskPerTrade: '300',
      totalCapital: '10000',
      error: 'Failed to load market metrics from API',
    }
  }
}

export default function DebugAstPage({ loaderData }: Route.ComponentProps) {
  const {
    tickers,
    astNode,
    maxRiskPerTrade,
    totalCapital,
    error: loaderError,
  } = loaderData || {}

  const [
    data,
    setData,
  ] = useState<ItemData[] | null>(null)
  const [
    error,
    setError,
  ] = useState<string | null>(loaderError || null)
  const [
    loading,
    setLoading,
  ] = useState(true)

  useEffect(() => {
    if (!tickers || tickers.length === 0) {
      if (!loaderError) setError('No market tickers returned from API')
      setLoading(false)
      return
    }

    try {
      let userMaxRiskUsd = 300
      if (maxRiskPerTrade?.endsWith('%')) {
        const percent = parseFloat(maxRiskPerTrade.replace('%', ''))
        userMaxRiskUsd = (parseFloat(totalCapital || '10000') * percent) / 100
      } else if (maxRiskPerTrade) {
        userMaxRiskUsd = parseFloat(maxRiskPerTrade)
      }

      const evaluated = tickers.map((t: Record<string, unknown> & { ticker: string; currentPrice?: number; price?: number; lastPrice?: number; volume?: number }) => {
        const p = Number(t.currentPrice || t.price || t.lastPrice || 100)
        const v = t.volume || 1000000
        const evaluationData = {
          ...t,
          currentPrice: p,
          currentVolume: v,
          fiftyTwoWeekHigh: p,
          maxRisk: userMaxRiskUsd,
        }

        const results = evaluateSetup(evaluationData as unknown as MarketData, { custom: (astNode as unknown as CustomStrategyAST) || undefined })
        return {
          ticker: t.ticker,
          price: p,
          results,
        }
      })

      setData(evaluated)
      setLoading(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AST Evaluation error')
      setLoading(false)
    }
  }, [
    tickers,
    astNode,
    maxRiskPerTrade,
    totalCapital,
    loaderError,
  ])

  if (loading) {
    return <div className="p-8 text-foreground">Evaluating all setups against AST... Please wait.</div>
  }

  if (error) {
    return <div className="p-8 text-danger font-bold">Error: {error}</div>
  }

  return (
    <div className="p-8 text-foreground max-w-7xl mx-auto">
      <h1 className="text-3xl font-bold mb-4">AST Evaluation Debug</h1>
      <p className="text-foreground/70 mb-8">
        This page fetches live metrics from the database and evaluates your AST exactly how the bot does.
      </p>

      {astNode && (
        <div className="mb-8 p-4 bg-surface-elevated border border-surface-elevated-border rounded">
          <h2 className="text-xl font-bold mb-2">Active AST</h2>
          <pre className="text-xs text-primary overflow-x-auto">{JSON.stringify(astNode, null, 2)}</pre>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {data && data.map((item) => {
          const hasValidSetup = item.results.some((r) => r.isValid || (r.score && r.score >= 0.3))
          return (
            <div key={item.ticker} className={`p-4 border rounded ${hasValidSetup ? 'bg-primary/10 border-primary/50' : 'bg-surface-elevated border-surface-elevated-border'}`}>
              <div className="flex justify-between items-start mb-4">
                <h3 className="text-xl font-bold">
                  <Link to={`/?ticker=${item.ticker}`} className="hover:underline hover:text-primary transition-colors cursor-pointer">
                    {item.ticker}
                  </Link> <span className="text-sm font-normal text-foreground/70">${item.price?.toFixed(2)}</span>
                </h3>
                {hasValidSetup ? (
                  <span className="bg-primary text-foreground text-xs px-2 py-1 rounded font-bold">SETUP TRIGGERED</span>
                ) : (
                  <span className="bg-surface-border text-foreground/50 text-xs px-2 py-1 rounded font-bold">REJECTED</span>
                )}
              </div>
              
              {item.results.length === 0 ? (
                <div className="text-sm text-foreground/50">No result returned from AST.</div>
              ) : (
                <div className="space-y-2">
                  {item.results.map((r, idx: number) => (
                    <div key={idx} className="text-sm text-foreground/90 bg-background/50 p-3 rounded border border-surface-border">
                      <div className="grid grid-cols-2 gap-1 mb-2">
                        <div><span className="text-foreground/50">Strategy:</span> {r.strategyName}</div>
                        <div><span className="text-foreground/50">Score:</span> {((r.score ?? 0) * 100).toFixed(0)}%</div>
                        <div><span className="text-foreground/50">Risk:</span> ${r.riskPerShare?.toFixed(2)}</div>
                        <div><span className="text-foreground/50">Target:</span> ${r.targetPrice?.toFixed(2)}</div>
                      </div>
                      <div className="text-foreground/70">
                        <span className="text-foreground/50">Reason:</span> {r.reason}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
