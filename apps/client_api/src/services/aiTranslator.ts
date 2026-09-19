import { logger } from './logger'

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  ua: 'Ukrainian',
}

// In-memory cache: avoids re-translating the same content if the user re-runs
// a command within the TTL window. Keyed by content hash + target language.
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const translationCache = new Map<string, { translated: string; expiresAt: number }>()

/**
 * Translate AI-generated analysis text to the user's language using
 * GEMINI_TRANSLATION_MODEL (gemini-3.5-flash-lite in our deployments — the
 * cheapest tier).
 *
 * Design decisions:
 * - 10s timeout via AbortSignal.timeout — translation is a nice-to-have, never
 *   blocks the user from getting a response. On timeout/failure, returns the
 *   original English text unchanged.
 * - 5-minute in-memory cache keyed by content hash + language — prevents
 *   re-translating the same analysis if the user re-runs /analyze.
 * - Skipped entirely when lang === 'en' (no-op, returns original).
 * - Skipped when GEMINI_API_KEY is not configured (self-hoster without a key).
 *
 * Used by runDeepScan and runDeepPortfolio to translate Gemini-generated
 * financial analysis. NOT for static UI strings (use t() from i18n.ts for those).
 */
export async function translateAiContent(content: string,
  lang: string): Promise<string> {
  // No-op for English or missing content
  if (!content || lang === 'en') return content

  const targetLanguage = LANGUAGE_NAMES[lang]
  if (!targetLanguage) return content // unknown language, don't translate

  // Check cache
  const cacheKey = `${hashContent(content)}:${lang}`
  const cached = translationCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.translated
  }

  // Prune expired entries (cheap sweep — keeps the Map bounded)
  if (translationCache.size > 100) {
    const now = Date.now()
    for (const [
      key,
      entry,
    ] of translationCache.entries()) {
      if (entry.expiresAt <= now) translationCache.delete(key)
    }
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      logger.debug('[AI_TRANSLATOR] No GEMINI_API_KEY — skipping translation')
      return content
    }

    // No fabricated model default (the repo mandate): a hardcoded plausible
    // name rots when Google decommissions the model (the gemini-2.5 retirement
    // broke exactly this). Unset/sentinel ⇒ skip translation gracefully.
    const model = process.env.GEMINI_TRANSLATION_MODEL
    if (!model || model === 'UNCONFIGURED') {
      logger.debug('[AI_TRANSLATOR] GEMINI_TRANSLATION_MODEL is not set — skipping translation')
      return content
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

    const prompt = `Translate the following financial market analysis to ${targetLanguage}. Preserve ALL formatting exactly: HTML tags (<b>, <code>, <i>), emojis (🔍 🎯 📊 etc.), numbers, currency symbols ($), percentages, and ticker symbols (AAPL, NVDA). Do not add any commentary, preamble, or notes — output ONLY the translated text.

${content}`

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
            ], 
          },
        ],
        generationConfig: {
          temperature: 0.1, // low temp for faithful translation
          maxOutputTokens: 4096,
          topP: 0.8,
        },
      }),
      signal: AbortSignal.timeout(10_000), // 10s max — never block the user
    })

    if (!response.ok) {
      logger.warn({ status: response.status, lang }, '[AI_TRANSLATOR] Translation API returned non-OK — falling back to English')
      return content
    }

    const data = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }

    const translated = data.candidates?.[0]?.content?.parts?.[0]?.text
    if (!translated || translated.trim().length === 0) {
      logger.warn('[AI_TRANSLATOR] Empty translation response — falling back to English')
      return content
    }

    // Cache the successful translation
    translationCache.set(cacheKey, { translated: translated.trim(), expiresAt: Date.now() + CACHE_TTL_MS })

    return translated.trim()
  } catch (e) {
    // Timeout, network error, parse error — always fall back gracefully
    logger.debug({ error: e instanceof Error ? e.message : String(e), lang }, '[AI_TRANSLATOR] Translation failed — falling back to English')
    return content
  }
}

/** Simple hash for cache keying — not cryptographic, just collision-resistant enough. */
function hashContent(text: string): string {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash |= 0
  }
  return Math.abs(hash).toString(36)
}
