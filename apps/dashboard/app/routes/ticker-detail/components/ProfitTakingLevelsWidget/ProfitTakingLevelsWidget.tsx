export function ProfitTakingLevelsWidget({
  ticker,
  currentPrice,
  vwap,
  atr,
  recentSignals,
}: {
  ticker: string
  currentPrice?: number
  vwap?: number
  atr?: number
  recentSignals?: Array<{ entry?: number | string }>
}) {
  const signalEntries = recentSignals
    ?.map(s => (s.entry ? parseFloat(s.entry.toString()) : 0))
    .filter(p => p > 0) || []

  const avgSignalEntry = signalEntries.length > 0
    ? signalEntries.reduce((sum, p) => sum + p, 0) / signalEntries.length
    : null

  const referenceBase = vwap || avgSignalEntry || (currentPrice ? currentPrice * 0.96 : 145.00)
  const effectiveAtr = atr && atr > 0 ? atr : (referenceBase * 0.035)

  // 1 Stop Loss Base + 2 Volatility-Based Profit Targets
  const stopLossPrice = referenceBase - (effectiveAtr * 1.5)
  const target1Price = referenceBase + (effectiveAtr * 2.0)
  const target2Price = referenceBase + (effectiveAtr * 4.0)

  const stopLossDistUsd = referenceBase - stopLossPrice
  const target1DistUsd = target1Price - referenceBase
  const target2DistUsd = target2Price - referenceBase

  const stopLossPct = ((stopLossPrice - referenceBase) / referenceBase) * 100
  const target1Pct = ((target1Price - referenceBase) / referenceBase) * 100
  const target2Pct = ((target2Price - referenceBase) / referenceBase) * 100

  return (
    <div className="metro-tile p-5 border-2 border-accent bg-surface-base shadow-xl flex flex-col gap-4 font-mono">
      <div className="flex items-center justify-between border-b border-border-surface-elevated/40 pb-3">
        <div className="flex items-center gap-2">
          <span className="text-xl">📈</span>
          <div>
            <h2 className="text-sm font-bold uppercase tracking-wider text-on-surface-base">
              PROFIT-TAKING RISK LEVELS ({ticker})
            </h2>
            <p className="text-micro text-muted">
              4h Baseline VWAP: ${referenceBase.toFixed(2)} | Volatility ATR: ${effectiveAtr.toFixed(2)}
            </p>
          </div>
        </div>
        <span className="px-2.5 py-1 text-micro font-bold uppercase border bg-accent/20 text-accent border-accent/40">
          KEY PIVOT LEVELS
        </span>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {/* 🛑 STOP LOSS / REBOUND BASE (-1.5x ATR) */}
        <div 
          className="group relative p-3 border flex flex-col items-center justify-center gap-1 bg-surface-sink/50 border-danger/40 hover:border-danger hover:bg-danger/10 transition-all cursor-pointer"
        >
          <span className="text-micro font-bold text-danger uppercase">🛑 BASE SUPPORT (-1.5x ATR)</span>
          <span className="text-sm font-bold text-on-surface-base">${stopLossPrice.toFixed(2)}</span>
          <span className="text-micro text-muted">Rebound Base Support</span>

          {/* Hover Tooltip */}
          <div className="pointer-events-none absolute bottom-full mb-2 hidden group-hover:flex flex-col gap-1.5 w-64 p-3 bg-surface-sink border border-danger text-on-surface-base text-micro rounded-none shadow-2xl z-50">
            <span className="font-bold text-danger uppercase">🛑 Support Base & Risk Cut-off</span>
            <span>Price Level: <b>${stopLossPrice.toFixed(2)}</b> ({stopLossPct.toFixed(1)}%)</span>
            <span>ATR Distance: -1.5x ATR (-${stopLossDistUsd.toFixed(2)})</span>
            <p className="text-micro text-muted italic border-t border-border-surface-elevated/40 pt-1 mt-0.5">
              💡 <b>Trading Guidance:</b> Do not panic sell if this level holds as base support. High probability of structural rebound.
            </p>
          </div>
        </div>

        {/* 🎯 TARGET 1 (+2.0x ATR SCALE-OUT) */}
        <div 
          className="group relative p-3 border flex flex-col items-center justify-center gap-1 bg-surface-sink/50 border-info/40 hover:border-info hover:bg-info/10 transition-all cursor-pointer"
        >
          <span className="text-micro font-bold text-info uppercase">🎯 T1 SCALE-OUT (+2.0x ATR)</span>
          <span className="text-sm font-bold text-on-surface-base">${target1Price.toFixed(2)}</span>
          <span className="text-micro text-muted">Initial Scale-Out</span>

          {/* Hover Tooltip */}
          <div className="pointer-events-none absolute bottom-full mb-2 hidden group-hover:flex flex-col gap-1.5 w-64 p-3 bg-surface-sink border border-info text-on-surface-base text-micro rounded-none shadow-2xl z-50">
            <span className="font-bold text-info uppercase">🎯 Initial Profit Target</span>
            <span>Target Level: <b>${target1Price.toFixed(2)}</b> (+{target1Pct.toFixed(1)}%)</span>
            <span>ATR Distance: +2.0x ATR (+${target1DistUsd.toFixed(2)})</span>
            <p className="text-micro text-muted italic border-t border-border-surface-elevated/40 pt-1 mt-0.5">
              💡 <b>Trading Guidance:</b> Consider locking in initial partial profits (25-30%) as price approaches this expansion target.
            </p>
          </div>
        </div>

        {/* 🚀 TARGET 2 (+4.0x ATR EXTENDED EXHAUSTION) */}
        <div 
          className="group relative p-3 border flex flex-col items-center justify-center gap-1 bg-surface-sink/50 border-warning/40 hover:border-warning hover:bg-warning/10 transition-all cursor-pointer"
        >
          <span className="text-micro font-bold text-warning uppercase">⚡ T2 EXHAUSTION (+4.0x ATR)</span>
          <span className="text-sm font-bold text-on-surface-base">${target2Price.toFixed(2)}</span>
          <span className="text-micro text-muted">Heavy Exhaustion Risk</span>

          {/* Hover Tooltip */}
          <div className="pointer-events-none absolute bottom-full mb-2 hidden group-hover:flex flex-col gap-1.5 w-64 p-3 bg-surface-sink border border-warning text-on-surface-base text-micro rounded-none shadow-2xl z-50">
            <span className="font-bold text-warning uppercase">⚡ Volatility Exhaustion Zone</span>
            <span>Exhaustion Level: <b>${target2Price.toFixed(2)}</b> (+{target2Pct.toFixed(1)}%)</span>
            <span>ATR Distance: +4.0x ATR (+${target2DistUsd.toFixed(2)})</span>
            <p className="text-micro text-muted italic border-t border-border-surface-elevated/40 pt-1 mt-0.5">
              💡 <b>Trading Guidance:</b> 🚫 <b>DO NOT BUY INTO SPIKE!</b> High risk of mean-reversion exhaustion. Look to exit remaining core position.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
