export type TrackedStock = Record<string, unknown> & {
  direction?: 'SHORT' | 'LONG'
  highestHigh: number
  stopLoss: number
  entry: number
  risk: number
  isPartialTaken: boolean
  partialTarget?: number
  ttl?: number
  maxHoldingDays?: number
  daysHeld: number
  stage: number
  strategyName: string
  atr?: number
  target: number
  // AST-sourced exit params (from riskManagement). Each defaults to a sensible
  // value when absent so legacy positions without them still work.
  chandelierAtrMultiplier?: number
  partialExitTriggerR?: number
  partialExitPercent?: number
  breakEvenActivationR?: number
  chandelierActivationR?: number
  gapExitThresholdPercent?: number
  gapExitThresholdAtr?: number
}

export function calculateSellSignal(
  stock: TrackedStock,
  currentHigh: number,
  currentLow: number,
  currentClose: number,
  isBinaryEventRiskHigh: boolean = false,
  isDangerous: boolean = false,
  currentOpen?: number,
  previousClose?: number,
  /**
   * Stop trigger semantics (2026-08-21 sweep hardening):
   * - 'wick' (default, historical): any bar-range touch of the stop triggers —
   *   pessimistic-but-honest for live stop orders (a live tick through the
   *   stop level fills).
   * - 'close': the stop triggers only on a CLOSE THROUGH the level — the
   *   classic closing-stop that ignores intrabar sweep wicks. Live exits must
   *   then be evaluated on close (or the position rides the wick).
   * Gap-through logic (GAP_BEYOND_STOP) is unaffected: an OPEN beyond the
   * stop is real slippage in both modes.
   */
  stopMode: 'wick' | 'close' = 'wick',
) {
  const updatedStock: TrackedStock = { ...stock }
  let exitReason: string | null = null
  let slMoved = false
  let exitConfidence: number | null = null

  const isShort = stock.direction === 'SHORT'

  if (isBinaryEventRiskHigh) {
    exitReason = 'BINARY_EVENT_RISK_REDUCTION'
    exitConfidence = isDangerous ? 90 : 75
  }

  if (!exitReason) {
    if (isShort && currentLow < updatedStock.highestHigh) {
      updatedStock.highestHigh = currentLow
    } else if (!isShort && currentHigh > updatedStock.highestHigh) {
      updatedStock.highestHigh = currentHigh
    }
  }

  const currentProfitR = isShort 
    ? (stock.entry - currentLow) / stock.risk 
    : (currentHigh - stock.entry) / stock.risk

  const breakEvenR = typeof stock.breakEvenActivationR === 'number' ? stock.breakEvenActivationR : 2.0
  if (currentProfitR >= breakEvenR) {
    if ((!isShort && updatedStock.stopLoss < updatedStock.entry) ||
        (isShort && updatedStock.stopLoss > updatedStock.entry)) {
      updatedStock.stopLoss = updatedStock.entry
      slMoved = true
    }
  }

  if (!stock.isPartialTaken && stock.partialTarget) {
    const targetHit = isShort ? currentLow <= stock.partialTarget : currentHigh >= stock.partialTarget
    if (targetHit) {
      exitReason = 'PARTIAL_TARGET_HIT'
      updatedStock.isPartialTaken = true
      slMoved = true
      exitConfidence = 70
    }
  }

  let ttl = 40
  if (typeof stock.maxHoldingDays === 'number' && stock.maxHoldingDays > 0) {
    ttl = stock.maxHoldingDays
  } else if (stock.ttl && stock.ttl > 0) {
    ttl = stock.ttl
  }

  if (!exitReason && stock.daysHeld >= ttl && stock.stage < 1) {
    exitReason = 'TIME_STOP'
    exitConfidence = 50
  }

  if (!exitReason) {
    // Chandelier trailing exit: applies to any strategy that declares a
    // chandelierAtrMultiplier in its AST riskManagement (no hardcoded strategy
    // name gate — the AST is the source of truth for which exits apply).
    if (typeof stock.chandelierAtrMultiplier === 'number' && stock.chandelierAtrMultiplier > 0) {
      const chandelierActivationR = typeof stock.chandelierActivationR === 'number' ? stock.chandelierActivationR : 2.5
      if (currentProfitR >= chandelierActivationR) {
        const chandelierMult = stock.chandelierAtrMultiplier
        if (isShort) {
          const chandelierStop = updatedStock.highestHigh + ((stock.atr || 1) * chandelierMult)
          if (chandelierStop < updatedStock.stopLoss) {
            updatedStock.stopLoss = chandelierStop
            slMoved = true
          }
        } else {
          const chandelierStop = updatedStock.highestHigh - ((stock.atr || 1) * chandelierMult)
          if (chandelierStop > updatedStock.stopLoss) {
            updatedStock.stopLoss = chandelierStop
            slMoved = true
          }
        }
      }
    }

    if (stock.strategyName === 'MEAN_REVERSION') {
      const targetHit = isShort ? currentLow <= stock.target : currentHigh >= stock.target
      if (targetHit) {
        exitReason = 'TARGET_HIT'
        exitConfidence = 85
      }
    }
  }

  if (!exitReason && currentOpen !== undefined && previousClose !== undefined) {
    const gapPct = ((currentOpen - previousClose) / previousClose) * 100
    const gapBelowStop = isShort ? currentOpen >= updatedStock.stopLoss : currentOpen <= updatedStock.stopLoss
    const gapAtr = Math.abs(currentOpen - previousClose) / (stock.atr || 1)

    const gapPctThreshold = typeof stock.gapExitThresholdPercent === 'number' ? stock.gapExitThresholdPercent : 3.0
    const gapAtrThreshold = typeof stock.gapExitThresholdAtr === 'number' ? stock.gapExitThresholdAtr : 2.0
    const isBigAdverseGap = isShort ? gapPct >= gapPctThreshold : gapPct <= -gapPctThreshold
    const isMediumAdverseGap = isShort ? (gapPct > 0 && gapAtr > gapAtrThreshold) : (gapPct < 0 && gapAtr > gapAtrThreshold)

    if (gapBelowStop) {
      exitReason = `GAP_BEYOND_STOP: ${gapPct.toFixed(1)}%`
      exitConfidence = 95
    } else if (isBigAdverseGap) {
      exitReason = `ADVERSE_GAP: ${gapPct.toFixed(1)}%`
      exitConfidence = Math.min(Math.round(60 + Math.abs(gapPct) * 5), 95)
    } else if (isMediumAdverseGap) {
      exitReason = `ADVERSE_GAP: ${gapPct.toFixed(1)}%`
      exitConfidence = Math.min(Math.round(60 + gapAtr * 8), 90)
    }
  }

  if (!exitReason) {
    // Intraday stop: 'wick' uses the bar's range (low for longs, high for
    // shorts) — close-only understates stop hits on wick-throughs that
    // recover by the close. 'close' triggers only on close-through (sweep-
    // resistant closing stop).
    const stopHit = stopMode === 'close'
      ? (isShort ? currentClose >= updatedStock.stopLoss : currentClose <= updatedStock.stopLoss)
      : (isShort ? currentHigh >= updatedStock.stopLoss : currentLow <= updatedStock.stopLoss)
    if (stopHit) {
      exitReason = 'STOP_LOSS_HIT'
      exitConfidence = 90
    }
  }

  return {
    exitReason, slMoved, updatedStock, exitConfidence, 
  }
}
