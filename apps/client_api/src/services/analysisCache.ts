interface CacheEntry<T> {
  data: T
  expiresAt: number
}

class AnalysisCache {
  private cache = new Map<string, CacheEntry<string>>()
  private rotationRationaleCache = new Map<string, CacheEntry<string>>()
  private genericCache = new Map<string, CacheEntry<unknown>>()
  private readonly TTL = 15 * 60 * 1000 // 15 minutes

  setGeneric<T>(key: string, data: T, ttlMs = 15 * 60 * 1000) {
    this.genericCache.set(key, {
      data: data as unknown,
      expiresAt: Date.now() + ttlMs,
    })
  }

  getGeneric<T>(key: string): T | null {
    const entry = this.genericCache.get(key)
    if (!entry) return null

    if (Date.now() > entry.expiresAt) {
      this.genericCache.delete(key)
      return null
    }

    return entry.data as T
  }

  set(
    ticker: string, lang: string, result: string, ttlMs?: number,
  ) {
    const key = `${ticker}:${lang}`
    this.cache.set(key, {
      data: result,
      expiresAt: Date.now() + (ttlMs || this.TTL),
    })
  }

  get(ticker: string, lang: string): string | null {
    const key = `${ticker}:${lang}`
    const entry = this.cache.get(key)
    if (!entry) return null

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      return null
    }

    return entry.data
  }

  setRotationRationale(chatId: string, lang: string, rationale: string) {
    const key = `${chatId}:${lang}`
    this.rotationRationaleCache.set(key, {
      data: rationale,
      expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour TTL for rotations
    })
  }

  getRotationRationale(chatId: string, lang: string): string | null {
    const key = `${chatId}:${lang}`
    const entry = this.rotationRationaleCache.get(key)
    if (!entry) return null

    if (Date.now() > entry.expiresAt) {
      this.rotationRationaleCache.delete(key)
      return null
    }

    return entry.data
  }

  clear() {
    this.cache.clear()
    this.rotationRationaleCache.clear()
    this.genericCache.clear()
  }
}

export const analysisCache = new AnalysisCache()
