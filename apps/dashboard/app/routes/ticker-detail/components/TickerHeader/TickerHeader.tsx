export function TickerHeader({ ticker, name }: { ticker: string; name: string | null }) {
  return (
    <div className="flex items-center justify-between mb-6 border-b-2 border-tertiary pb-4 flex-wrap gap-4">
      <div className="flex items-baseline gap-4">
        <h1 className="text-4xl font-black text-primary">{ticker}</h1>
        <h2 className="text-2xl font-semibold opacity-80">{name}</h2>
      </div>
    </div>
  )
}
