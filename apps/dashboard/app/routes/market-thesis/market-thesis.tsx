import { Surface } from 'app/components/Surface'
import { fetchFromPublicApi } from 'app/utils/apiClient'

import type { Route } from './+types/market-thesis'
import { ThesisRadarChart } from './components/ThesisRadarChart'

export interface ThesisAxis {
  key: string
  label: string
  score: number
  raw: string | number
}

export interface MarketThesis {
  overall: number
  axes: ThesisAxis[]
  generatedAt: string
  regime: string
}

export async function loader({ request }: Route.LoaderArgs): Promise<{ thesis: MarketThesis | null; error: string | null }> {
  const res = await fetchFromPublicApi('/market/thesis', request)
  if (!res) {
    return { thesis: null, error: 'Market thesis unavailable. It is generated during market scans — try again shortly.' }
  }
  const thesis = (res.data ?? null) as MarketThesis | null
  return { thesis, error: thesis ? null : 'No market snapshot found yet.' }
}

const REGIME_BADGE: Record<string, string> = {
  RISK_ON: 'text-up',
  RISK_NEUTRAL: 'text-warning',
  RISK_OFF: 'text-down',
}

function scoreTone(score: number): string {
  if (score >= 0.66) return 'text-up'
  if (score >= 0.4) return 'text-warning'
  return 'text-down'
}

export default function MarketThesisRoute({ loaderData }: Route.ComponentProps) {
  const { thesis, error } = loaderData

  return (
    <div className="p-6 w-full space-y-6 font-mono">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-6 border-b border-border/10 pb-6">
        <div>
          <h1 className="text-4xl font-bold text-foreground tracking-tight flex items-center gap-3">
            <span className="text-accent">❄️</span> MARKET THESIS
          </h1>
          <p className="text-foreground/40 font-bold mt-2 uppercase tracking-wider text-xs">
            Daily 6-Axis Regime Snowflake &mdash; Liquidity / Volatility / Sentiment / Rates / Inflation / Breadth
          </p>
        </div>
        {thesis && (
          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className="text-foreground/40 uppercase tracking-wider text-xs">Overall</div>
              <div className={`text-3xl font-bold ${scoreTone(thesis.overall)}`}>{Math.round(thesis.overall * 100)}</div>
            </div>
            <div className="text-right">
              <div className="text-foreground/40 uppercase tracking-wider text-xs">Regime</div>
              <div className={`text-lg font-bold ${REGIME_BADGE[thesis.regime] ?? 'text-foreground'}`}>{thesis.regime}</div>
            </div>
          </div>
        )}
      </header>

      {error && (
        <div className="bg-down/10 border border-down/30 p-4 text-down font-bold flex items-center gap-3 text-xs">
          <span>🚨</span> {error}
        </div>
      )}

      {thesis && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Surface surface="base" className="p-6">
            <div className="text-foreground/40 uppercase tracking-wider text-xs mb-4">[ 01 // SNOWFLAKE ]</div>
            <ThesisRadarChart thesis={thesis} />
          </Surface>

          <Surface surface="base" className="p-6">
            <div className="text-foreground/40 uppercase tracking-wider text-xs mb-4">[ 02 // AXIS BREAKDOWN ]</div>
            <div className="space-y-3">
              {thesis.axes.map(axis => (
                <div key={axis.key} className="flex items-center gap-4">
                  <div className="w-28 text-xs uppercase tracking-wider text-foreground/60">{axis.label}</div>
                  <div className="flex-1 h-2 bg-surface-sink rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${axis.score >= 0.66 ? 'bg-up' : axis.score >= 0.4 ? 'bg-warning' : 'bg-down'}`}
                      style={{ width: `${Math.round(axis.score * 100)}%` }}
                    />
                  </div>
                  <div className={`w-10 text-right text-sm font-bold ${scoreTone(axis.score)}`}>
                    {Math.round(axis.score * 100)}
                  </div>
                  <div className="w-20 text-right text-xs text-foreground/40">{String(axis.raw)}</div>
                </div>
              ))}
            </div>
            {thesis.generatedAt && (
              <div className="mt-6 pt-4 border-t border-border/10 text-xs text-foreground/30 uppercase tracking-wider">
                Generated {new Date(thesis.generatedAt).toLocaleString()}
              </div>
            )}
          </Surface>
        </div>
      )}
    </div>
  )
}
