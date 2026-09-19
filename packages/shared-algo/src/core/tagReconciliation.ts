/**
 * Tag vocabulary reconciliation — the coupling layer between event-side
 * `impactedTags` and ticker-side tag assignments.
 *
 * Problem (2026-08-19): both sides are Gemini-produced with only prompt-level
 * vocabulary sharing, and downstream matching (`maxMatchedTag`) is EXACT
 * string intersection. An event tag `CHIPS` when every ticker says
 * `SEMICONDUCTORS` silently matches zero tickers — nothing flags the drift.
 *
 * Contract: everything here is PURE (no DB, no network) so the partition /
 * similarity-map / cap / frequency-selection semantics are unit-testable.
 * The IO shell lives in apps/api tagReconciliationService.
 */
import {
  normalizeTags, type TagSource, type TickerTag, 
} from './tickerTags'

/** Max tags stored per ticker. Guardrail against vocabulary explosion. */
export const MAX_TAGS_PER_TICKER = 10

/** Max tags injected into AI prompts (top-N by document frequency). */
export const MAX_INJECTED_VOCABULARY = 300

/** Distinct-tag count that triggers a drift warning in rotation logs. */
export const VOCABULARY_WARN_THRESHOLD = 500

/** Cosine similarity above which an unknown event tag maps to a known one. */
export const TAG_SIMILARITY_THRESHOLD = 0.80

export interface TagPartition {
  /** Incoming tags already present (exact, uppercase) in the vocabulary. */
  known: string[]
  /** Incoming tags not in the vocabulary — candidates for similarity mapping. */
  unknown: string[]
}

function upperUnique(tags: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of tags) {
    const u = t.trim().toUpperCase()
    if (u && !seen.has(u)) {
      seen.add(u)
      out.push(u)
    }
  }
  return out
}

/** Split incoming tags into exact-vocabulary hits and unknowns. */
export function partitionTags(incoming: readonly string[], vocabulary: readonly string[]): TagPartition {
  const vocab = new Set(upperUnique(vocabulary))
  const incomingUnique = upperUnique(incoming)
  const known: string[] = []
  const unknown: string[] = []
  for (const tag of incomingUnique) {
    if (vocab.has(tag)) known.push(tag)
    else unknown.push(tag)
  }
  return { known, unknown }
}

export interface SimilarityMapping {
  /** unknown → canonical vocabulary tag (cosine ≥ threshold). */
  mapped: Map<string, string>
  /** Unknowns below threshold — dropped from the event, logged by the caller. */
  unresolved: string[]
}

/**
 * Map unknown tags to vocabulary entries by cosine similarity of precomputed
 * embeddings. Each unknown maps to its best-scoring vocabulary tag when that
 * score ≥ threshold; otherwise it lands in `unresolved`. Vocabulary entries
 * without an embedding are not candidates (the service layer guarantees
 * embeddings for the injected set).
 */
export function mapBySimilarity(
  unknown: readonly string[],
  vocabulary: readonly string[],
  embeddings: ReadonlyMap<string, readonly number[]>,
  threshold: number = TAG_SIMILARITY_THRESHOLD,
): SimilarityMapping {
  const mapped = new Map<string, string>()
  const unresolved: string[] = []

  const candidates = upperUnique(vocabulary).filter((tag) => embeddings.has(tag))
  const candidateVectors = candidates.map((tag) => ({
    tag,
    vec: embeddings.get(tag) as readonly number[],
  }))

  for (const tag of upperUnique(unknown)) {
    const incoming = embeddings.get(tag)
    if (!incoming || candidateVectors.length === 0) {
      unresolved.push(tag)
      continue
    }
    let bestTag: string | null = null
    let bestScore = -1
    for (const cand of candidateVectors) {
      const score = cosineSimilarity(incoming, cand.vec)
      if (score > bestScore) {
        bestScore = score
        bestTag = cand.tag
      }
    }
    if (bestTag !== null && bestScore >= threshold) {
      mapped.set(tag, bestTag)
    } else {
      unresolved.push(tag)
    }
  }
  return { mapped, unresolved }
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0
    const bi = b[i] ?? 0
    dot += ai * bi
    normA += ai * ai
    normB += bi * bi
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * Resolve a full incoming event-tag list against the vocabulary:
 * exact hits pass through, unknowns map by similarity when possible, the
 * rest are dropped. Duplicates introduced by mapping collapse to one entry.
 */
export function reconcileTags(
  incoming: readonly string[],
  vocabulary: readonly string[],
  embeddings: ReadonlyMap<string, readonly number[]>,
  threshold: number = TAG_SIMILARITY_THRESHOLD,
): TagPartition & { resolved: string[]; dropped: string[]; mapping: Map<string, string> } {
  const { known, unknown } = partitionTags(incoming, vocabulary)
  const { mapped, unresolved } = mapBySimilarity(
    unknown, vocabulary, embeddings, threshold,
  )
  const seen = new Set<string>()
  const resolved: string[] = []
  for (const tag of [
    ...known,
    ...unknown.map((u) => mapped.get(u) ?? u),
  ]) {
    if (!seen.has(tag)) {
      seen.add(tag)
      resolved.push(tag)
    }
  }
  return {
    known,
    unknown,
    resolved: resolved.filter((t) => !unresolved.includes(t) || mapped.has(t)),
    dropped: unresolved.filter((t) => !mapped.has(t)),
    mapping: mapped,
  }
}

const SOURCE_RANK: Record<TagSource, number> = {
  manual: 4,
  moat: 3,
  news: 2,
  default: 1,
}

/**
 * Cap a normalized tag list at MAX_TAGS_PER_TICKER, keeping the most
 * authoritative entries (higher source rank first, then weight, then name
 * for determinism). Applied at write time as a vocabulary guardrail — the
 * observed max is 11, so this trims only pathological cases.
 */
export function capTags(tags: readonly TickerTag[], max: number = MAX_TAGS_PER_TICKER): TickerTag[] {
  if (tags.length <= max) return [
    ...tags,
  ]
  return [
    ...tags,
  ]
    .sort((a, b) => {
      const rankDiff = SOURCE_RANK[b.source] - SOURCE_RANK[a.source]
      if (rankDiff !== 0) return rankDiff
      if (b.weight !== a.weight) return b.weight - a.weight
      return a.tag.localeCompare(b.tag)
    })
    .slice(0, max)
}

/** Normalize + cap in one step for write paths. */
export function normalizeCappedTags(raw: unknown, max?: number): TickerTag[] {
  return capTags(normalizeTags(raw), max)
}

export interface TagFrequency {
  tag: string
  /** Number of tickers holding this tag (document frequency). */
  count: number
}

/**
 * Document frequency of every distinct tag across the per-ticker lists.
 * Single pass, uppercase-normalized.
 */
export function tagFrequencies(perTickerTags: readonly unknown[]): TagFrequency[] {
  const counts = new Map<string, number>()
  for (const raw of perTickerTags) {
    const seen = new Set<string>()
    for (const t of normalizeTags(raw)) {
      if (!seen.has(t.tag)) {
        seen.add(t.tag)
        counts.set(t.tag, (counts.get(t.tag) ?? 0) + 1)
      }
    }
  }
  return Array.from(counts.entries())
    .map(([
      tag,
      count,
    ]) => ({ tag, count }))
    .sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag))
}

/**
 * The prompt-injection vocabulary: top tags by document frequency, capped at
 * `limit`. Rare single-ticker tags still match events exactly downstream —
 * they are just not advertised to the AI (a tag one ticker holds is noise
 * for event mapping) — so this bounds prompt tokens and the embedding cache
 * forever without losing matching power.
 */
export function topTagsByFrequency(perTickerTags: readonly unknown[], limit: number = MAX_INJECTED_VOCABULARY): string[] {
  return tagFrequencies(perTickerTags)
    .slice(0, limit)
    .map((f) => f.tag)
}

/**
 * Monthly prune planner: which `news`-source tags to delete. A tag is pruned
 * when it is held by fewer than `minTickerCount` tickers AND is not
 * referenced by any narrative. Manual / moat / default sources are NEVER
 * pruned — they are human or structural assertions.
 */
export function planTagPrune(perTickerTags: readonly unknown[],
  narrativeReferencedTags: readonly string[],
  minTickerCount = 2): Set<string> {
  const referenced = new Set(upperUnique(narrativeReferencedTags))
  const prunable = new Set<string>()
  for (const { tag, count } of tagFrequencies(perTickerTags)) {
    if (count < minTickerCount && !referenced.has(tag)) prunable.add(tag)
  }
  return prunable
}

/**
 * Apply a prune plan to a ticker's tag list: drop pruned tags that came from
 * the news source only. Returns the original array object when nothing
 * changes (cheap identity for the update skip).
 */
export function applyTagPrune(tags: readonly TickerTag[], prunable: ReadonlySet<string>): TickerTag[] {
  if (!tags.some((t) => t.source === 'news' && prunable.has(t.tag))) return [
    ...tags,
  ]
  return tags.filter((t) => !(t.source === 'news' && prunable.has(t.tag)))
}
