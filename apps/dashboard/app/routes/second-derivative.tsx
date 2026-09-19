import { fetchFromPublicApi } from 'app/utils/apiClient'
import { useState } from 'react'
import { Link } from 'react-router'
import { z } from 'zod'

import type { Route } from './+types/second-derivative'

const WinnerSchema = z.object({
  ticker: z.string(),
  yearReturnPct: z.number(),
  edgeType: z.string(),
})

const SupplierSchema = z.object({
  ticker: z.string(),
  name: z.string().nullable().optional(),
  sector: z.string().nullable().optional(),
  winners: z.array(WinnerSchema).optional(),
  maxWinnerReturn: z.union([
    z.number(),
    z.string(),
  ]).nullable().optional(),
  supplierYearReturn: z.union([
    z.number(),
    z.string(),
  ]).nullable().optional(),
  isEarningsPlay: z.boolean().optional(),
  isBuyPlay: z.boolean().optional(),
  daysUntilWinnerEarnings: z.number().nullable().optional(),
  analysis: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
})
type SupplierRow = z.infer<typeof SupplierSchema>

export async function loader({ request }: Route.LoaderArgs) {
  try {
    const res = await fetchFromPublicApi('/market/second-derivative', request)
    const raw = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
    const suppliers: SupplierRow[] = raw.flatMap((row: unknown) => {
      const parsed = SupplierSchema.safeParse(row)
      return parsed.success ? [parsed.data] : []
    })
    return { suppliers, error: null }
  } catch (error) {
    if (error instanceof Response) throw error
    return { suppliers: [], error: error instanceof Error ? error.message : 'Failed to load' }
  }
}

export default function SecondDerivative({ loaderData }: Route.ComponentProps) {
  const { suppliers, error } = loaderData
  const [
    search,
    setSearch,
  ] = useState('')

  const filtered: SupplierRow[] = suppliers.filter((s: SupplierRow) =>
    s.ticker.toLowerCase().includes(search.toLowerCase())
    || (s.name || '').toLowerCase().includes(search.toLowerCase()))

  return (
    <div className="p-6 w-full space-y-6 font-mono">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-6 border-b border-border/10 pb-6">
        <div>
          <h1 className="text-4xl font-bold text-foreground tracking-tight flex items-center gap-3">
            <span className="text-accent">🔗</span> SECOND DERIVATIVE
          </h1>
          <p className="text-foreground/40 font-bold mt-2 uppercase tracking-wider text-xs">
            Suppliers of +200% 12m names. Highlight = supplier has not doubled yet and a supplied winner prints within 2 weeks.
          </p>
        </div>
        <input
          type="text"
          placeholder="SEARCH SUPPLIERS..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full md:w-80 bg-surface-sink border border-border/20 px-4 py-2.5 text-foreground font-mono text-xs placeholder-foreground/40 focus:outline-none focus:border-primary uppercase tracking-wider"
        />
      </header>

      {error && (
        <div className="bg-down-500/10 border border-down-500/30 p-4 text-down font-bold flex items-center gap-3 text-xs">
          <span>🚨</span> {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6">
        {filtered.map((row: SupplierRow) => (
          <div key={row.ticker} className="bg-surface-sink/40 border border-border/10 hover:border-accent/40 transition-all group">
            <div className="p-6">
              <div className="flex flex-col md:flex-row justify-between gap-6 items-start">
                <div className="flex items-start gap-5">
                  <div className="w-16 h-16 bg-accent/10 border border-accent/30 flex items-center justify-center text-xl font-bold text-accent group-hover:bg-accent group-hover:text-black transition-all">
                    {row.ticker}
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-foreground group-hover:text-primary transition-colors">{row.name || row.ticker}</h2>
                    <div className="flex flex-wrap items-center gap-2 mt-2">
                      <span className="bg-white/5 border border-border/10 text-foreground/50 px-2.5 py-0.5 text-micro font-bold uppercase tracking-wider">{row.sector || 'US EQUITIES'}</span>
                      {row.isBuyPlay && (
                        <span className="bg-up-500/20 border border-up-500/40 text-up px-2.5 py-0.5 text-micro font-bold uppercase tracking-wider">
                          UNRALLIED · W PRINT ≤14D
                        </span>
                      )}
                      {!row.isBuyPlay && row.isEarningsPlay && (
                        <span className="bg-warning-500/20 border border-warning-500/40 text-warning px-2.5 py-0.5 text-micro font-bold uppercase tracking-wider">
                          WINNER EARNINGS ≤14D
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="text-right space-y-1">
                  <div className="text-micro font-bold text-foreground/50 uppercase tracking-widest">Max winner 12m</div>
                  <div className="text-3xl font-bold text-up tracking-tight">
                    +{Number(row.maxWinnerReturn ?? 0).toFixed(0)}%
                  </div>
                  <div className="text-micro font-bold text-foreground/50 uppercase tracking-widest">
                    Supplier 12m {row.supplierYearReturn == null ? 'N/A' : `${Number(row.supplierYearReturn) >= 0 ? '+' : ''}${Number(row.supplierYearReturn).toFixed(0)}%`}
                    {row.daysUntilWinnerEarnings != null ? ` · W print ${row.daysUntilWinnerEarnings}d` : ''}
                  </div>
                </div>
              </div>

              <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
                <div className="space-y-3">
                  <h3 className="text-micro font-bold text-foreground/50 uppercase tracking-widest">Supplies</h3>
                  <div className="flex flex-wrap gap-2">
                    {(row.winners || []).map((w: z.infer<typeof WinnerSchema>) => (
                      <Link
                        key={w.ticker}
                        to={`/tickers/${w.ticker}`}
                        className="bg-accent/10 border border-accent/20 text-accent px-2.5 py-1 text-micro font-bold uppercase tracking-wider hover:bg-accent hover:text-black transition-all"
                      >
                        {w.ticker} +{w.yearReturnPct.toFixed(0)}%
                      </Link>
                    ))}
                  </div>
                  <Link
                    to={`/tickers/${row.ticker}`}
                    className="flex items-center justify-center gap-2 w-full py-3 bg-white/5 hover:bg-white/10 border border-border/10 text-foreground font-bold transition-all uppercase tracking-wider text-xs"
                  >
                    View Technical Detail
                  </Link>
                </div>
                <div className="bg-accent/5 p-4 border border-accent/20">
                  <h3 className="text-micro font-bold text-accent uppercase tracking-widest mb-3">Why it is here</h3>
                  <p className="text-foreground/60 leading-relaxed font-medium text-xs">
                    {row.analysis || 'Direct supplier of a +200% 12-month winner.'}
                  </p>
                </div>
              </div>
            </div>
            <div className="bg-surface-sink/40 px-6 py-3 border-t border-border/10 text-micro font-bold text-foreground/50 uppercase tracking-wider">
              Last Evaluated: {row.updatedAt ? new Date(row.updatedAt).toLocaleDateString() : 'N/A'}
            </div>
          </div>
        ))}

        {filtered.length === 0 && (
          <div className="py-16 text-center space-y-3 border border-dashed border-border/10 bg-surface-sink/20">
            <p className="text-foreground/50 font-bold uppercase tracking-wider text-xs">No second-derivative suppliers yet. Scan runs on market days at 10:15 ET.</p>
          </div>
        )}
      </div>
    </div>
  )
}
