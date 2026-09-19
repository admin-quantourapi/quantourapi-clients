export const DIRECTIONAL_CONNECTION_TYPES = [
  'SUPPLIER',
  'CUSTOMER',
] as const

export type DirectionalConnectionType = typeof DIRECTIONAL_CONNECTION_TYPES[number]

export interface ConnectionEndpoints {
  fromTicker: string
  toTicker: string
  connectionType: string
}

export function isDirectionalConnectionType(type: string): type is DirectionalConnectionType {
  return (DIRECTIONAL_CONNECTION_TYPES as readonly string[]).includes(type)
}

export function normalizeConnectionEdge(edge: ConnectionEndpoints): ConnectionEndpoints {
  if (!isDirectionalConnectionType(edge.connectionType)) return edge
  if (edge.fromTicker === edge.toTicker) return edge
  return {
    fromTicker: edge.toTicker,
    toTicker: edge.fromTicker,
    connectionType: edge.connectionType,
  }
}

export function relatedTicker(viewed: string, edge: ConnectionEndpoints): string {
  return edge.fromTicker === viewed ? edge.toTicker : edge.fromTicker
}

export function connectionRoleFromPerspective(viewed: string, edge: ConnectionEndpoints): string {
  const type = edge.connectionType
  const viewedIsFrom = edge.fromTicker === viewed
  if (type === 'SUPPLIER') return viewedIsFrom ? 'Supplies' : 'Supplied by'
  if (type === 'CUSTOMER') return viewedIsFrom ? 'Buys from' : 'Sells to'
  return type
}

// --- Graph/candle query mechanics (moved from the proprietary supplier-thesis
// module so published client packages can shape connection data without the
// tuned thesis thresholds — callers supply their own winner cutoff). ---

export interface CloseBar {
  date: string
  close: number
}

export interface WinnerRef {
  ticker: string
  yearReturnPct: number
}

export interface SupplierWinnerLink {
  ticker: string
  yearReturnPct: number
  edgeType: string
}

export interface SupplierOfWinner {
  ticker: string
  winners: SupplierWinnerLink[]
  maxWinnerReturn: number
}

export function yearReturnPctFromCandles(candles: CloseBar[]): number | null {
  if (candles.length < 2) return null
  const last = candles[candles.length - 1]!
  if (!(last.close > 0)) return null
  const end = Date.parse(`${last.date}T00:00:00Z`)
  if (!Number.isFinite(end)) return null
  const startStr = new Date(end - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const startCandle = candles.find(c => c.date >= startStr && c.date < last.date)
  if (!startCandle || !(startCandle.close > 0)) return null
  return ((last.close - startCandle.close) / startCandle.close) * 100
}

export function suppliersOfWinners(
  winners: WinnerRef[],
  edges: ConnectionEndpoints[],
  minWinnerReturnPct: number,
): SupplierOfWinner[] {
  const winnerMap = new Map(winners.filter(w => w.yearReturnPct > minWinnerReturnPct).map(w => [w.ticker, w]))
  const bySupplier = new Map<string, Map<string, SupplierWinnerLink>>()

  const add = (supplier: string, winner: WinnerRef, edgeType: string) => {
    if (supplier === winner.ticker) return
    let links = bySupplier.get(supplier)
    if (!links) {
      links = new Map()
      bySupplier.set(supplier, links)
    }
    const existing = links.get(winner.ticker)
    if (!existing || winner.yearReturnPct > existing.yearReturnPct) {
      links.set(winner.ticker, {
        ticker: winner.ticker, yearReturnPct: winner.yearReturnPct, edgeType,
      })
    }
  }

  for (const edge of edges) {
    if (edge.connectionType === 'SUPPLIER') {
      const winner = winnerMap.get(edge.toTicker)
      if (winner) add(edge.fromTicker, winner, 'SUPPLIER')
    } else if (edge.connectionType === 'CUSTOMER') {
      const winner = winnerMap.get(edge.fromTicker)
      if (winner) add(edge.toTicker, winner, 'CUSTOMER')
    }
  }

  const rows: SupplierOfWinner[] = []
  for (const [
    ticker,
    links,
  ] of bySupplier) {
    const winnersList = [...links.values()].sort((a, b) => b.yearReturnPct - a.yearReturnPct)
    rows.push({
      ticker,
      winners: winnersList,
      maxWinnerReturn: winnersList[0]!.yearReturnPct,
    })
  }
  rows.sort((a, b) => {
    const countDiff = b.winners.length - a.winners.length
    if (countDiff !== 0) return countDiff
    return b.maxWinnerReturn - a.maxWinnerReturn
  })
  return rows
}

export function supplierAdjacency(edges: ConnectionEndpoints[]): Map<string, string[]> {
  const map = new Map<string, Set<string>>()
  const add = (supplier: string, customer: string) => {
    if (supplier === customer) return
    let set = map.get(supplier)
    if (!set) {
      set = new Set()
      map.set(supplier, set)
    }
    set.add(customer)
  }
  for (const edge of edges) {
    if (edge.connectionType === 'SUPPLIER') add(edge.fromTicker, edge.toTicker)
    else if (edge.connectionType === 'CUSTOMER') add(edge.toTicker, edge.fromTicker)
  }
  const out = new Map<string, string[]>()
  for (const [
    supplier,
    customers,
  ] of map) {
    out.set(supplier, [...customers])
  }
  return out
}

export function sliceCandlesBefore(candles: CloseBar[], asOfExclusive: string): CloseBar[] {
  return candles.filter(c => c.date < asOfExclusive)
}

export function daysUntilUnixSec(nextUnixSec: number, nowMs: number): number {
  return (nextUnixSec * 1000 - nowMs) / (24 * 60 * 60 * 1000)
}
