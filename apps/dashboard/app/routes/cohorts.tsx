import { getSessionFromServer } from 'app/lib/auth-helpers'
import { requireEnv } from 'app/utils/env.server'
import type { CohortGroupRule } from '@quantour/shared-algo/src/finance-algo/ast'
import { CohortGroupRuleSchema, CustomStrategyASTSchema } from '@quantour/shared-algo/src/finance-algo/astSchema'
import { parseTickerList } from '@quantour/shared-algo/src/finance-algo/cohortGroups'
import { Form, Link, redirect } from 'react-router'

import type { Route } from './+types/cohorts'

function parseAst(raw: unknown): Record<string, unknown> | null {
  let candidate: unknown = raw
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate)
    } catch {
      return null
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
  const result = CustomStrategyASTSchema.safeParse(candidate)
  return result.success ? candidate as Record<string, unknown> : null
}

function groupsOf(ast: Record<string, unknown> | null): CohortGroupRule[] {
  if (!ast) return []
  const raw = ast.cohortGroups
  if (!Array.isArray(raw)) return []
  const out: CohortGroupRule[] = []
  for (const g of raw) {
    const parsed = CohortGroupRuleSchema.safeParse(g)
    if (parsed.success) out.push(parsed.data)
  }
  return out
}

async function loadAst(): Promise<Record<string, unknown> | null> {
  const clientApiUrl = requireEnv('CLIENT_API_URL')
  const res = await fetch(`${clientApiUrl}/api/settings`, {
    headers: { Connection: 'close' },
    cache: 'no-store',
  }).catch(() => null)
  if (!res || !res.ok) return null
  const body: unknown = await res.json().catch(() => null)
  if (!body || typeof body !== 'object') return null
  const raw = (body as { mainStrategyAst?: unknown }).mainStrategyAst
  return parseAst(raw)
}

async function saveAst(ast: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
  const clientApiUrl = requireEnv('CLIENT_API_URL')
  const res = await fetch(`${clientApiUrl}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mainStrategyAst: JSON.stringify(ast) }),
  }).catch(() => null)
  if (!res) return { ok: false, error: 'Client API unreachable' }
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { issues?: { path: string; message: string }[] } | null
    const first = body?.issues?.[0]
    return { ok: false, error: first ? `${first.path}: ${first.message}` : 'Failed to save AST' }
  }
  return { ok: true }
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = await getSessionFromServer(request)
  if (!session) throw redirect('/login')
  const ast = await loadAst()
  return {
    hasAst: ast != null,
    strategyName: typeof ast?.strategyName === 'string' ? ast.strategyName : null,
    groups: groupsOf(ast),
    cohortFromMacros: ast?.cohortFromMacros === true,
  }
}

export async function action({ request }: Route.ActionArgs) {
  const session = await getSessionFromServer(request)
  if (!session) throw redirect('/login')
  const form = await request.formData()
  const intent = String(form.get('intent') ?? '')
  const ast = await loadAst()
  if (!ast) return { error: 'Apply a strategy in Strategy Studio first.' }

  if (intent === 'toggle_macros') {
    ast.cohortFromMacros = form.get('cohortFromMacros') === 'on'
    const saved = await saveAst(ast)
    return saved.ok ? { success: 'Saved cohortFromMacros.' } : { error: saved.error }
  }

  if (intent === 'delete') {
    const idx = Number(form.get('index'))
    const next = groupsOf(ast).filter((_, i) => i !== idx)
    ast.cohortGroups = next
    const saved = await saveAst(ast)
    return saved.ok ? { success: 'Removed group.' } : { error: saved.error }
  }

  if (intent === 'save_group') {
    const name = String(form.get('name') ?? '').trim()
    const leaders = parseTickerList(String(form.get('leaders') ?? ''))
    const members = parseTickerList(String(form.get('members') ?? ''))
    const memberPolicy = form.get('memberPolicy') === 'REVERSE' ? 'REVERSE' : 'FOLLOW'
    const leaderPolicy = form.get('leaderPolicy') === 'SIGNAL_ONLY' ? 'SIGNAL_ONLY' : 'TRADE'
    const capitalFlipRaw = String(form.get('capitalFlip') ?? 'NONE')
    const capitalFlip = (
      capitalFlipRaw === 'TRIM_LEADERS' || capitalFlipRaw === 'ROTATE_TO_MEMBERS' || capitalFlipRaw === 'ROTATE_TO_CASH'
        ? capitalFlipRaw
        : 'NONE'
    )
    const thresholdRaw = String(form.get('slowdownThreshold') ?? '').trim()
    const threshold = thresholdRaw === '' ? undefined : Number(thresholdRaw)
    if (!name || leaders.length === 0 || members.length === 0) {
      return { error: 'Name, at least one leader, and at least one member are required.' }
    }
    if (threshold != null && !Number.isFinite(threshold)) {
      return { error: 'slowdownThreshold must be a number (decimal, 0.05 = 5pp).' }
    }
    const group: CohortGroupRule = {
      name,
      leaders,
      members,
      memberPolicy,
      leaderPolicy,
      capitalFlip,
      ...(threshold != null ? { slowdownThreshold: threshold } : {}),
    }
    const idx = Number(form.get('index'))
    const next = groupsOf(ast)
    if (Number.isInteger(idx) && idx >= 0 && idx < next.length) next[idx] = group
    else next.push(group)
    ast.cohortGroups = next
    const saved = await saveAst(ast)
    return saved.ok ? { success: 'Saved group.' } : { error: saved.error }
  }

  return { error: 'Unknown action' }
}

export default function Cohorts({ loaderData, actionData }: Route.ComponentProps) {
  const { hasAst, strategyName, groups, cohortFromMacros } = loaderData
  const flash = actionData as { error?: string; success?: string } | undefined

  return (
    <div className="p-6 w-full space-y-6 font-sans">
      <header className="border-b border-border/10 pb-6 space-y-2">
        <p className="text-micro font-mono uppercase tracking-widest text-foreground/50">[ AST // VOCABULARY ]</p>
        <h1 data-testid="cohorts-heading" className="text-3xl font-black tracking-tight text-foreground">Cohorts</h1>
        <p className="text-sm text-foreground/60 max-w-3xl">
          User-defined groups on your main strategy AST. FOLLOW members may enter only when the
          weakest leader beats SPY over 20 days. REVERSE members only when that leader lags.
          This is a constraint, not a Quantour signal. Default AI_COMBINED does not set groups.
        </p>
        {strategyName && (
          <p className="font-mono text-xs text-foreground/40 uppercase tracking-wider">
            Active AST: {strategyName}
          </p>
        )}
      </header>

      {flash?.error && (
        <div className="border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">{flash.error}</div>
      )}
      {flash?.success && (
        <div className="border border-up/40 bg-up/10 px-4 py-3 text-sm text-up">{flash.success}</div>
      )}

      {!hasAst && (
        <div className="border border-border/20 bg-surface-sink p-6 space-y-3">
          <p className="text-foreground/70 text-sm">No main strategy AST yet. Apply one in Strategy Studio, then return here.</p>
          <Link to="/strategy-builder" className="inline-flex items-center gap-2 bg-primary px-4 py-2 text-on-accent text-xs font-bold uppercase tracking-wider hover:opacity-90 active:scale-95">
            Open Strategy Studio
          </Link>
        </div>
      )}

      {hasAst && (
        <>
          <section data-testid="cohorts-honesty" className="border border-warning/30 bg-surface-sink p-4 space-y-2">
            <p className="font-mono text-micro uppercase tracking-widest text-warning">Honesty</p>
            <ul className="text-xs text-foreground/70 space-y-1 list-disc pl-4">
              <li>Same-day corr with a leader is real. Next-day lead-lag is not. Do not treat FOLLOW as a forecast.</li>
              <li>Saving writes <code className="font-mono text-primary">cohortGroups</code> onto your AST and tags it user-owned (boot will not overwrite it with stock AI_COMBINED).</li>
              <li>
                <code className="font-mono text-primary">cohortFromMacros</code> maps live narratives → FOLLOW/REVERSE via 60d corr.
                Honest backtests omit that map (no narrative history).
              </li>
              <li><code className="font-mono">capitalFlip</code> is declared vocabulary; the rotation engine does not execute it yet.</li>
            </ul>
          </section>

          <Form method="post" className="border border-border/20 bg-surface-base p-4 flex flex-wrap items-center gap-4">
            <input type="hidden" name="intent" value="toggle_macros" />
            <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
              <input data-testid="cohorts-macros-toggle" type="checkbox" name="cohortFromMacros" defaultChecked={cohortFromMacros} className="accent-primary" />
              Merge live macro-derived cohorts (<span className="font-mono text-xs">cohortFromMacros</span>)
            </label>
            <button data-testid="cohorts-macros-save" type="submit" className="border border-primary px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-primary hover:bg-primary/10 active:scale-95">
              Save flag
            </button>
          </Form>

          <section className="space-y-3">
            <h2 className="font-mono text-xs uppercase tracking-widest text-foreground/50">Declared groups</h2>
            {groups.length === 0 && (
              <p className="text-sm text-foreground/50">None yet. Add AI_INFRA (NVDA → ASML FOLLOW) below if you want a static list.</p>
            )}
            <div className="grid gap-4 md:grid-cols-2">
              {groups.map((g, i) => (
                <article data-testid={`cohort-card-${g.name}`} key={`${g.name}-${i}`} className="border border-border/20 bg-surface-sink p-4 space-y-3 min-w-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="font-mono text-sm font-bold text-foreground truncate">{g.name}</h3>
                      <p className="text-micro uppercase tracking-wider text-accent">{g.memberPolicy}</p>
                    </div>
                    <Form method="post">
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="index" value={i} />
                      <button data-testid={`cohort-delete-${g.name}`} type="submit" className="border border-danger/60 px-2 py-1 text-micro font-bold uppercase tracking-wider text-danger hover:bg-danger/10 active:scale-95">
                        Remove
                      </button>
                    </Form>
                  </div>
                  <p className="font-mono text-xs text-foreground/70 break-words">
                    Leaders: {g.leaders.join(', ')}
                  </p>
                  <p className="font-mono text-xs text-foreground/70 break-words">
                    Members: {g.members.join(', ')}
                  </p>
                  <p className="text-micro text-foreground/40 uppercase tracking-wider">
                    {g.leaderPolicy ?? 'TRADE'} · {g.capitalFlip ?? 'NONE'}
                    {g.slowdownThreshold != null ? ` · thr ${g.slowdownThreshold}` : ''}
                  </p>
                </article>
              ))}
            </div>
          </section>

          <section className="border border-border/20 bg-surface-base p-4 space-y-4">
            <h2 className="font-mono text-xs uppercase tracking-widest text-foreground/50">Add group</h2>
            <Form method="post" className="grid gap-3 md:grid-cols-2">
              <input type="hidden" name="intent" value="save_group" />
              <input type="hidden" name="index" value="-1" />
              <label className="block space-y-1 md:col-span-2">
                <span className="text-micro uppercase tracking-wider text-foreground/50">Name</span>
                <input data-testid="cohorts-add-name" name="name" required placeholder="AI_INFRA" className="w-full bg-surface-sink border border-border/20 px-3 py-2 font-mono text-sm text-foreground focus:outline-none focus:border-primary" />
              </label>
              <label className="block space-y-1">
                <span className="text-micro uppercase tracking-wider text-foreground/50">Leaders</span>
                <input data-testid="cohorts-add-leaders" name="leaders" required placeholder="NVDA" className="w-full bg-surface-sink border border-border/20 px-3 py-2 font-mono text-sm text-foreground focus:outline-none focus:border-primary" />
              </label>
              <label className="block space-y-1">
                <span className="text-micro uppercase tracking-wider text-foreground/50">Members</span>
                <input data-testid="cohorts-add-members" name="members" required placeholder="ASML, TSM" className="w-full bg-surface-sink border border-border/20 px-3 py-2 font-mono text-sm text-foreground focus:outline-none focus:border-primary" />
              </label>
              <label className="block space-y-1">
                <span className="text-micro uppercase tracking-wider text-foreground/50">Member policy</span>
                <select data-testid="cohorts-add-policy" name="memberPolicy" className="w-full bg-surface-sink border border-border/20 px-3 py-2 font-mono text-sm text-foreground focus:outline-none focus:border-primary">
                  <option value="FOLLOW">FOLLOW — enter only if leader beats SPY</option>
                  <option value="REVERSE">REVERSE — enter only if leader lags SPY</option>
                </select>
              </label>
              <label className="block space-y-1">
                <span className="text-micro uppercase tracking-wider text-foreground/50">Leader policy</span>
                <select name="leaderPolicy" className="w-full bg-surface-sink border border-border/20 px-3 py-2 font-mono text-sm text-foreground focus:outline-none focus:border-primary">
                  <option value="TRADE">TRADE</option>
                  <option value="SIGNAL_ONLY">SIGNAL_ONLY — do not enter the leader</option>
                </select>
              </label>
              <label className="block space-y-1">
                <span className="text-micro uppercase tracking-wider text-foreground/50">Capital flip (declared)</span>
                <select name="capitalFlip" className="w-full bg-surface-sink border border-border/20 px-3 py-2 font-mono text-sm text-foreground focus:outline-none focus:border-primary">
                  <option value="NONE">NONE</option>
                  <option value="TRIM_LEADERS">TRIM_LEADERS</option>
                  <option value="ROTATE_TO_MEMBERS">ROTATE_TO_MEMBERS</option>
                  <option value="ROTATE_TO_CASH">ROTATE_TO_CASH</option>
                </select>
              </label>
              <label className="block space-y-1">
                <span className="text-micro uppercase tracking-wider text-foreground/50">Threshold (optional decimal)</span>
                <input name="slowdownThreshold" placeholder="0" className="w-full bg-surface-sink border border-border/20 px-3 py-2 font-mono text-sm text-foreground focus:outline-none focus:border-primary" />
              </label>
              <div className="md:col-span-2">
                <button data-testid="cohorts-add-submit" type="submit" className="bg-primary px-4 py-2 text-on-accent text-xs font-bold uppercase tracking-wider hover:opacity-90 active:scale-95">
                  Add to AST
                </button>
              </div>
            </Form>
          </section>
        </>
      )}
    </div>
  )
}
