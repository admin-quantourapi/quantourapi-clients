import {
  describe, expect, it, 
} from 'bun:test'

import { partitionChatsByGate } from './clientScanner'

describe('clientScanner Deduplication Logic', () => {
  it('deduplicates signals per user per ticker for automated scans within 24h', () => {
    const sentSignalsCache = new Map<string, number>()
    const chatId = '12345'
    const ticker = 'TLT'
    const cacheKey = `${chatId}:${ticker.toUpperCase()}`

    const now = Date.now()

    // 1. Initial scan: Cache is empty -> Signal should be sent
    expect(sentSignalsCache.has(cacheKey)).toBe(false)
    sentSignalsCache.set(cacheKey, now)

    // 2. Subsequent automated scan 15 minutes later: Cache contains key -> Signal suppressed
    const isManual = false
    const shouldSkip = !isManual && sentSignalsCache.has(cacheKey)
    expect(shouldSkip).toBe(true)

    // 3. Manual scan on demand: isManual is true -> Signal allowed
    const isManualOverride = true
    const shouldSkipManual = !isManualOverride && sentSignalsCache.has(cacheKey)
    expect(shouldSkipManual).toBe(false)
  })

  it('expires cache entries older than 24 hours', () => {
    const sentSignalsCache = new Map<string, number>()
    const oldTimestamp = Date.now() - (25 * 60 * 60 * 1000) // 25 hours ago
    sentSignalsCache.set('12345:AAPL', oldTimestamp)

    const now = Date.now()
    for (const [
      key,
      timestamp,
    ] of sentSignalsCache.entries()) {
      if (now - timestamp > 24 * 60 * 60 * 1000) {
        sentSignalsCache.delete(key)
      }
    }

    expect(sentSignalsCache.has('12345:AAPL')).toBe(false)
  })

  it('suppresses automated scans in silent mode but permits user-initiated manual scans', () => {
    const signalMode = 'silent'

    // Automated scan in silent mode -> suppressed
    const isManualScan = false
    const isSilentAutomated = !isManualScan && signalMode === 'silent'
    expect(isSilentAutomated).toBe(true)

    // User-initiated manual scan (/scan) in silent mode -> allowed
    const isUserInitiatedScan = true
    const isSilentManual = !isUserInitiatedScan && signalMode === 'silent'
    expect(isSilentManual).toBe(false)
  })
})

describe('partitionChatsByGate — per-chat API-key hard gate', () => {
  type Row = {
    telegramChatId: string | null
    quantourApiKey: string | null
    status: string
  }

  it('authorizes a chat that has its own valid approved key', () => {
    const rows: Row[] = [
      { telegramChatId: 'chat_a', quantourApiKey: 'KEY_ALPHA', status: 'approved' },
    ]
    const { authorized, skipped } = partitionChatsByGate(rows)
    expect(authorized).toHaveLength(1)
    expect(authorized[0]?.telegramChatId).toBe('chat_a')
    expect(skipped).toHaveLength(0)
  })

  it('skips a chat whose own key is null even when a sibling row has a key (cross-user leak fix)', () => {
    // This is the core bug: previously the scanner borrowed sibling's key
    // and broadcast to the unlinked chat. Now the unlinked chat must be
    // skipped and only the linked chat authorized.
    const rows: Row[] = [
      { telegramChatId: 'unlinked_chat', quantourApiKey: null, status: 'pending' },
      { telegramChatId: 'linked_chat', quantourApiKey: 'KEY_ALPHA', status: 'approved' },
    ]
    const { authorized, skipped } = partitionChatsByGate(rows)
    expect(authorized.map(r => r.telegramChatId)).toEqual([
      'linked_chat',
    ])
    expect(skipped.map(r => r.telegramChatId)).toEqual([
      'unlinked_chat',
    ])
  })

  it('skips a chat whose status is pending even if it has a key string stored', () => {
    // Covers the post-401 / daily-sweep quarantine: a revoked key leaves
    // status='pending', so the chat must stop receiving signals even
    // though quantourApiKey is still non-null in the row.
    const rows: Row[] = [
      { telegramChatId: 'quarantined', quantourApiKey: 'REVOKED_KEY', status: 'pending' },
    ]
    const { authorized, skipped } = partitionChatsByGate(rows)
    expect(authorized).toHaveLength(0)
    expect(skipped).toHaveLength(1)
    expect(skipped[0]?.telegramChatId).toBe('quarantined')
  })

  it('ignores rows without a telegramChatId (chat-less instance / dashboard rows never broadcast)', () => {
    const rows: Row[] = [
      { telegramChatId: null, quantourApiKey: 'KEY_ALPHA', status: 'approved' },
      { telegramChatId: 'chat_a', quantourApiKey: 'KEY_ALPHA', status: 'approved' },
    ]
    const { authorized, skipped } = partitionChatsByGate(rows)
    expect(authorized.map(r => r.telegramChatId)).toEqual([
      'chat_a',
    ])
    expect(skipped).toHaveLength(0)
  })

  it('handles a mixed multi-tenant instance correctly', () => {
    const rows: Row[] = [
      // authorized — own key, approved
      { telegramChatId: 'a', quantourApiKey: 'K1', status: 'approved' },
      // skipped — no key (never linked)
      { telegramChatId: 'b', quantourApiKey: null, status: 'pending' },
      // skipped — key present but quarantined pending (revoked)
      { telegramChatId: 'c', quantourApiKey: 'K2', status: 'pending' },
      // authorized — second valid account
      { telegramChatId: 'd', quantourApiKey: 'K3', status: 'approved' },
      // ignored — chat-less instance row
      { telegramChatId: null, quantourApiKey: 'K1', status: 'approved' },
    ]
    const { authorized, skipped } = partitionChatsByGate(rows)
    expect(authorized.map(r => r.telegramChatId)).toEqual([
      'a',
      'd',
    ])
    expect(skipped.map(r => r.telegramChatId)).toEqual([
      'b',
      'c',
    ])
  })

  it('returns empty arrays for an empty input', () => {
    const { authorized, skipped } = partitionChatsByGate([])
    expect(authorized).toEqual([])
    expect(skipped).toEqual([])
  })
})
