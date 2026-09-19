/**
 * Weighted thematic tags on tickers (macro / moat / news).
 * Distinct from AST strategy behavior tags (trend_continuation, etc.).
 */
import { z } from 'zod'

export const TagPolaritySchema = z.enum([
  'tailwind',
  'headwind',
  'neutral',
])
export type TagPolarity = z.infer<typeof TagPolaritySchema>

export const TagSourceSchema = z.enum([
  'moat',
  'news',
  'manual',
  'default',
])
export type TagSource = z.infer<typeof TagSourceSchema>

export const TickerTagSchema = z.object({
  tag: z.string().min(1),
  weight: z.number().min(0).max(1),
  polarity: TagPolaritySchema.default('neutral'),
  source: TagSourceSchema.default('default'),
})
export type TickerTag = z.infer<typeof TickerTagSchema>

const SOURCE_RANK: Record<TagSource, number> = {
  manual: 4,
  moat: 3,
  news: 2,
  default: 1,
}

export function normalizeTags(raw: unknown): TickerTag[] {
  if (!Array.isArray(raw)) return []
  const out: TickerTag[] = []
  for (const item of raw) {
    if (typeof item === 'string' && item.trim()) {
      out.push({
        tag: item.trim().toUpperCase(),
        weight: 1,
        polarity: 'neutral',
        source: 'default',
      })
      continue
    }
    if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>
      const tagRaw = typeof rec.tag === 'string' ? rec.tag.trim().toUpperCase() : ''
      if (!tagRaw) continue
      const weightNum = typeof rec.weight === 'number'
        ? rec.weight
        : typeof rec.weight === 'string'
          ? parseFloat(rec.weight)
          : 1
      const parsed = TickerTagSchema.safeParse({
        tag: tagRaw,
        weight: Number.isFinite(weightNum) ? Math.min(1, Math.max(0, weightNum)) : 1,
        polarity: rec.polarity ?? 'neutral',
        source: rec.source ?? 'default',
      })
      if (parsed.success) out.push(parsed.data)
    }
  }
  return out
}

export function tagNames(tags: unknown): string[] {
  return normalizeTags(tags).map(t => t.tag)
}

export function hasTag(tags: unknown, name: string): boolean {
  const upper = name.toUpperCase()
  return normalizeTags(tags).some(t => t.tag === upper)
}

export function mergeTags(existing: unknown, incoming: unknown): TickerTag[] {
  const map = new Map<string, TickerTag>()
  for (const t of normalizeTags(existing)) map.set(t.tag, t)
  for (const t of normalizeTags(incoming)) {
    const prev = map.get(t.tag)
    if (
      !prev ||
      SOURCE_RANK[t.source] > SOURCE_RANK[prev.source] ||
      (SOURCE_RANK[t.source] === SOURCE_RANK[prev.source] && t.weight >= prev.weight)
    ) {
      map.set(t.tag, t)
    }
  }
  return Array.from(map.values())
}

export function formatTag(t: TickerTag): string {
  return `${t.tag}:${t.weight.toFixed(2)}`
}

/** Parse admin input: "TAG1, TAG2:0.8, TAG3" */
export function parseTagInput(input: string, source: TagSource = 'manual'): TickerTag[] {
  return input
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map((part) => {
      const [
        name,
        w,
      ] = part.split(':')
      const weight = w != null && w !== '' ? Math.min(1, Math.max(0, parseFloat(w))) : 1
      return {
        tag: (name || '').trim().toUpperCase(),
        weight: Number.isFinite(weight) ? weight : 1,
        polarity: 'neutral' as const,
        source,
      }
    })
    .filter(t => t.tag.length > 0)
}

export function maxMatchedWeight(tickerTags: unknown, narrativeTags: string[]): number {
  return maxMatchedTag(tickerTags, narrativeTags)?.weight ?? 0
}

export interface MatchedTag {
  tag: string
  weight: number
  polarity: TagPolarity
}

/**
 * Best-matching narrative tag on a ticker, including its polarity — the
 * direction signal for victim/beneficiary classification. Returns null when no
 * narrative tag is present on the ticker.
 */
export function maxMatchedTag(tickerTags: unknown, narrativeTags: string[]): MatchedTag | null {
  const tags = normalizeTags(tickerTags)
  const narrativeUpper = new Set(narrativeTags.map(t => t.toUpperCase()))
  let best: MatchedTag | null = null
  for (const t of tags) {
    if (narrativeUpper.has(t.tag) && (best === null || t.weight > best.weight)) {
      best = {
        tag: t.tag,
        weight: t.weight,
        polarity: t.polarity,
      }
    }
  }
  return best
}

export function weightToReversalImpact(weight: number): 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' {
  if (weight >= 0.8) return 'CRITICAL'
  if (weight >= 0.6) return 'HIGH'
  if (weight >= 0.3) return 'MEDIUM'
  return 'LOW'
}

export function polaritySign(p: TagPolarity): number {
  if (p === 'tailwind') return 1
  if (p === 'headwind') return -1
  return 0
}

export function computeTagWind(tags: unknown): number {
  const list = normalizeTags(tags)
  if (list.length === 0) return 0
  const sum = list.reduce((acc, t) => acc + polaritySign(t.polarity) * t.weight, 0)
  return sum / list.length
}

export function computeWindScore(moatDelta: number, moatTags: unknown): number {
  const tagWind = computeTagWind(moatTags)
  const raw = 0.6 * moatDelta + 0.4 * tagWind
  return Math.max(-1, Math.min(1, raw))
}

export function windLabel(score: number): 'TAILWIND' | 'HEADWIND' | 'NEUTRAL' {
  if (score > 0.15) return 'TAILWIND'
  if (score < -0.15) return 'HEADWIND'
  return 'NEUTRAL'
}

export function toWeightedDefaults(names: string[]): TickerTag[] {
  return names.map(tag => ({
    tag: tag.toUpperCase(),
    weight: 1,
    polarity: 'neutral' as const,
    source: 'default' as const,
  }))
}

/** Best narrative alignment for moat confluence (BENEFICIARY > none > AT_RISK). */
export type MoatAlignment = 'BENEFICIARY' | 'AT_RISK' | 'NONE'

export type MoatMacroPhase = 'RISK_ON' | 'RISK_NEUTRAL' | 'RISK_OFF'

export interface MoatConfluenceInput {
  /** Structural durability 0..1 */
  moatStrength?: number
  /** QoQ trajectory −1..1 */
  moatWindScore?: number
  /** Macro regime / trend phase */
  macroRegime?: MoatMacroPhase | string
  /** Company vs active macro narrative */
  alignment?: MoatAlignment | string
}

/**
 * Single multi-factor moat signal for scoring (−1..1).
 *
 * Moat alone is not a trade instruction — it only pays when strength, QoQ wind,
 * macro phase, and narrative alignment reinforce each other:
 *
 * - RISK_ON weights trajectory (expanding moat) higher
 * - RISK_OFF weights structural strength (fortress) higher
 * - BENEFICIARY unlocks full positive confluence; AT_RISK damps positives and
 *   keeps full weight on negatives; no narrative damps everything
 *
 * Returns null when both strength and wind are missing (branch stays inert).
 */
export function computeMoatConfluence(input: MoatConfluenceInput): number | null {
  const strengthRaw = input.moatStrength
  const windRaw = input.moatWindScore
  const hasStrength = typeof strengthRaw === 'number' && Number.isFinite(strengthRaw)
  const hasWind = typeof windRaw === 'number' && Number.isFinite(windRaw)
  if (!hasStrength && !hasWind) return null

  const strength = hasStrength
    ? Math.min(1, Math.max(0, strengthRaw as number))
    : 0.5
  const wind = hasWind
    ? Math.min(1, Math.max(-1, windRaw as number))
    : 0

  // Center strength on 0 so 0.5 is neutral structural quality.
  const strengthCentered = 2 * strength - 1 // −1..1

  const regime = (input.macroRegime || 'RISK_NEUTRAL') as string
  // Phase weights: growth phase → wind; defensive phase → fortress strength.
  let wStrength = 0.5
  let wWind = 0.5
  if (regime === 'RISK_ON') {
    wStrength = 0.35
    wWind = 0.65
  } else if (regime === 'RISK_OFF') {
    wStrength = 0.65
    wWind = 0.35
  }

  // Strong moats amplify wind; weak moats mute trajectory noise.
  const windAmplified = wind * (0.4 + 0.6 * strength)
  let structural = wStrength * strengthCentered + wWind * windAmplified

  const alignment = (input.alignment || 'NONE') as string
  if (alignment === 'BENEFICIARY') {
    // Full upside; partial downside (still a warning if moat erodes on a beneficiary).
    structural = structural >= 0 ? structural : structural * 0.6
  } else if (alignment === 'AT_RISK') {
    // Improving moat does not fully offset narrative risk; erosion hits hard.
    structural = structural >= 0 ? structural * 0.25 : structural
  } else {
    // No narrative alignment → moat is background context only.
    structural *= 0.35
  }

  return Math.max(-1, Math.min(1, structural))
}

/** Map narrative exposure rows to a single alignment label. */
export function moatAlignmentFromExposures(exposures?: Array<{ exposureType?: string }>): MoatAlignment {
  if (!exposures || exposures.length === 0) return 'NONE'
  if (exposures.some(e => e.exposureType === 'BENEFICIARY')) return 'BENEFICIARY'
  if (exposures.some(e => e.exposureType === 'AT_RISK')) return 'AT_RISK'
  return 'NONE'
}

export function moatConfluenceLabel(score: number): 'TAILWIND' | 'HEADWIND' | 'NEUTRAL' {
  if (score > 0.25) return 'TAILWIND'
  if (score < -0.25) return 'HEADWIND'
  return 'NEUTRAL'
}
