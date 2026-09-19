import { useState } from 'react'

export function TickerDescription({ description }: { description: string | null }) {
  const [
    expanded,
    setExpanded,
  ] = useState(false)
  const desc = description || 'No description available for this ticker.'
  const limit = 180
  const clamped = desc.length > limit
  const shown = expanded || !clamped ? desc : `${desc.slice(0, limit).trimEnd()}…`

  return (
    <div className="prose dark:prose-invert max-w-none">
      <h3 className="text-lg font-bold mb-2 uppercase tracking-wider text-foreground/50">About Company</h3>
      <p className="text-foreground/70 leading-relaxed whitespace-pre-wrap text-lg text-justify">
        {shown}{' '}
        {clamped && (
          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            className="text-accent hover:underline font-bold whitespace-nowrap text-base"
          >
            {expanded ? 'show less' : 'show more'}
          </button>
        )}
      </p>
    </div>
  )
}
