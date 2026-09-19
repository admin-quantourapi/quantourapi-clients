import {
  githubDarkTheme, JsonEditor, 
} from 'json-edit-react'
import { useState } from 'react'

interface StrategyAstProps {
  astJson: string
  setAstJson: (json: string) => void
}

export function StrategyAst({ astJson, setAstJson }: StrategyAstProps) {
  const [
    mode,
    setMode,
  ] = useState<'tree' | 'text'>('tree')
  const [
    rawText,
    setRawText,
  ] = useState(astJson)
  const [
    error,
    setError,
  ] = useState<string | null>(null)

  const handleTextChange = (val: string) => {
    setRawText(val)
    try {
      JSON.parse(val)
      setError(null)
      setAstJson(val)
    } catch {
      setError('Invalid JSON syntax')
    }
  }

  const parsedData = (() => {
    try {
      return JSON.parse(astJson)
    } catch {
      return {}
    }
  })()

  return (
    <div className="flex flex-col h-full w-full">
      <div className="flex justify-between items-center px-4 py-2 bg-surface-elevated/40 border-b border-surface-sink-border shrink-0">
        <div className="flex gap-1 bg-surface-sink p-1 rounded-lg border border-surface-sink-border">
          <button
            type="button"
            className={`px-3 py-1 text-xs font-bold uppercase tracking-wider rounded-md transition-colors ${
              mode === 'tree' ? 'bg-primary text-primary-content shadow-sm' : 'text-foreground/60 hover:text-foreground'
            }`}
            onClick={() => {
              setRawText(astJson)
              setError(null)
              setMode('tree')
            }}
          >
            Interactive Tree
          </button>
          <button
            type="button"
            className={`px-3 py-1 text-xs font-bold uppercase tracking-wider rounded-md transition-colors ${
              mode === 'text' ? 'bg-primary text-primary-content shadow-sm' : 'text-foreground/60 hover:text-foreground'
            }`}
            onClick={() => {
              setRawText(astJson)
              setError(null)
              setMode('text')
            }}
          >
            Plain Text
          </button>
        </div>
        {error && mode === 'text' && (
          <span className="text-xs font-bold text-danger bg-danger/10 px-2.5 py-1 rounded border border-danger/20">
            {error}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 p-2">
        {mode === 'tree' ? (
          <JsonEditor 
            data={parsedData}
            onUpdate={({ newData }) => setAstJson(JSON.stringify(newData, null, 2))}
            theme={githubDarkTheme}
            rootName="Strategy"
          />
        ) : (
          <textarea
            value={rawText}
            onChange={(e) => handleTextChange(e.target.value)}
            className="w-full h-full font-mono text-xs p-4 bg-surface-sink text-foreground border border-surface-sink-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary/50 resize-none"
            placeholder="Paste or type JSON AST here..."
          />
        )}
      </div>
    </div>
  )
}
