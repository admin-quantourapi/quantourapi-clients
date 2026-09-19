import { Surface } from 'app/components/Surface'
import { getSessionFromServer } from 'app/lib/auth-helpers'
import { requireEnv } from 'app/utils/env.server'
import { useState } from 'react'
import {
  data, Form, redirect, useFetcher, 
} from 'react-router'

import type { Route } from './+types/api-keys'

export async function loader({ request }: Route.LoaderArgs) {
  const session = await getSessionFromServer(request)
  if (!session) {
    throw redirect('/login')
  }

  // Fetch settings from local client_api
  const clientApiUrl = requireEnv('CLIENT_API_URL')
  let apiKey = ''
  try {
    const res = await fetch(`${clientApiUrl}/api/settings`, {
      headers: { 'Connection': 'close' },
      cache: 'no-store',
    })
    if (res.ok) {
      const data = await res.json()
      apiKey = data.quantourApiKey || ''
    }
  } catch (e) {
    console.error('Failed to fetch from client_api', e)
  }
  
  // Mask the keys for display
  const maskedKey = apiKey ? `${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}` : null

  let plan = 'Unknown'
  let credits = 0
  let unlimited = false
  
  if (apiKey) {
    try {
      const publicApiUrl = requireEnv('PUBLIC_API_URL')
      const pingRes = await fetch(`${publicApiUrl}/v1/ping`, {
        headers: { 'x-api-key': apiKey, 'Connection': 'close' },
      })
      if (pingRes.ok) {
        const pingData = await pingRes.json()
        plan = pingData.plan || 'Unknown'
        credits = pingData.credits || 0
        unlimited = pingData.unlimited ?? false
      } else {
        await pingRes.text().catch(() => {})
      }
    } catch (e) {
      console.error('Failed to fetch plan/credits', e)
    }
  }

  const quantourUrl = process.env.QUANTOUR_URL || 'https://quantourapi.com'

  return {
    maskedKey, fullKey: apiKey, hasKey: !!apiKey, plan, credits, unlimited, quantourUrl,
  }
}

export async function action({ request }: Route.ActionArgs) {
  const session = await getSessionFromServer(request)
  if (!session) {
    throw redirect('/login')
  }

  const formData = await request.formData()
  const intent = formData.get('intent')
  const clientApiUrl = requireEnv('CLIENT_API_URL')

  if (intent === 'save') {
    const apiKey = formData.get('apiKey') as string
    if (!apiKey) {
      return { error: 'API Key is required' }
    }
    
    try {
      const publicApiUrl = requireEnv('PUBLIC_API_URL')
      let pingOk = false

      // 1. Try validating against Public API directly
      try {
        const pingRes = await fetch(`${publicApiUrl}/v1/ping`, {
          headers: { 'x-api-key': apiKey.trim(), 'Connection': 'close' },
        })
        if (pingRes.ok) {
          pingOk = true
        }
        await pingRes.text().catch(() => {})
      } catch (directErr) {
        console.warn('[API-KEYS] Direct Public API ping failed, attempting via local client_api proxy:', directErr)
        // Fallback to validating via local client_api proxy
        const proxyPingRes = await fetch(`${clientApiUrl}/proxy/v1/ping`, {
          headers: { 'x-api-key': apiKey.trim(), 'Connection': 'close' },
        })
        if (proxyPingRes.ok) {
          pingOk = true
        }
        await proxyPingRes.text().catch(() => {})
      }

      if (!pingOk) {
        return { error: 'Invalid API Key. Please check your key and try again.' }
      }

      // 2. Save settings to local client_api
      const saveRes = await fetch(`${clientApiUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
        body: JSON.stringify({ 
          quantourApiKey: apiKey.trim(),
        }),
      })

      if (!saveRes.ok) {
        const errText = await saveRes.text().catch(() => '')
        return { error: `Failed to save settings locally: ${errText || saveRes.statusText}` }
      }
      await saveRes.text().catch(() => {}) // Consume body to prevent socket hang

      return data({ success: true })
    } catch (e) {
      console.error('Failed to validate or save API key', e)
      const msg = e instanceof Error ? e.message : String(e)
      return { error: `Failed to communicate with services: ${msg}` }
    }
  }

  if (intent === 'remove') {
    try {
      // Clear the settings in client_api
      await fetch(`${clientApiUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
        body: JSON.stringify({ 
          quantourApiKey: '',
        }),
      })
      
      return data({ success: true, removed: true })
    } catch (e) {
      console.error('Failed to clear client_api settings', e)
      return { error: 'Failed to connect to Local Client API' }
    }
  }

  return { error: 'Invalid intent' }
}

export default function ApiKeysPage({ loaderData, actionData }: Route.ComponentProps) {
  const {
    maskedKey, fullKey, hasKey, plan, credits, unlimited, quantourUrl,
  } = loaderData
  const fetcher = useFetcher<typeof action>()
  const [
    apiKey,
    setApiKey,
  ] = useState('')

  const isSaving = fetcher.state !== 'idle' && fetcher.formData?.get('intent') === 'save'
  const isRemoving = fetcher.state !== 'idle' && fetcher.formData?.get('intent') === 'remove'
  const error = (fetcher.data && typeof fetcher.data === 'object' && 'error' in fetcher.data ? (fetcher.data as { error?: string }).error : null) || (actionData && 'error' in actionData ? (actionData as { error?: string }).error : null)

  const handleCopy = () => {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(fullKey).then(() => {
        alert('API Key copied to clipboard! You can now send this to the Telegram bot.')
      }).catch(() => fallbackCopy(fullKey))
    } else {
      fallbackCopy(fullKey)
    }
  }

  const fallbackCopy = (text: string) => {
    const textArea = document.createElement('textarea')
    textArea.value = text
    textArea.style.position = 'fixed'
    textArea.style.left = '-999999px'
    textArea.style.top = '-999999px'
    document.body.appendChild(textArea)
    textArea.focus()
    textArea.select()
    try {
      document.execCommand('copy')
      alert('API Key copied to clipboard! You can now send this to the Telegram bot.')
    } catch (err) {
      console.error('Fallback copy failed', err)
      alert('Failed to copy automatically. Please copy it manually.')
    }
    document.body.removeChild(textArea)
  }

  return (
    <div className="flex-1 p-6 bg-background text-foreground w-full space-y-6 font-mono">
      <div className="flex flex-col gap-1.5 border-b border-border/10 pb-4">
        <h2 className="text-xl font-bold text-warning uppercase tracking-wider">
          ⚙️ Local API & Integrations
        </h2>
        <span className="text-xs font-bold text-foreground/40 uppercase tracking-wider block mt-1">
          Configure your access to the Quantour public API and Telegram Bot Integrations
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="space-y-4">
          <h3 className="text-xs font-bold text-warning uppercase tracking-wider">
            ⚙️ Configure Access
          </h3>
          <Surface surface="elevated" className="p-6 border border-border/10 bg-surface-sink/40">
            {hasKey ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2 text-up font-bold text-xs uppercase tracking-wider">
                    <span>✅ Quantour API Key configured</span>
                    <div className="flex gap-2">
                      <span className="bg-primary/20 text-primary border border-primary/40 px-2 py-0.5 text-micro uppercase tracking-wider">{plan} Plan</span>
                      <span className="bg-up/20 text-up border border-up/40 px-2 py-0.5 text-micro uppercase tracking-wider">
                        {unlimited ? 'Unlimited' : `${credits} Credits`}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 bg-surface-sink p-3 border border-border/20 font-mono text-xs text-foreground/80">
                      {maskedKey}
                    </div>
                    <button
                      onClick={handleCopy}
                      className="px-4 py-3 bg-primary/20 hover:bg-primary/30 text-primary border border-primary/50 text-xs font-bold uppercase tracking-wider transition-colors cursor-pointer"
                      title="Copy full API key"
                      type="button"
                    >
                      Copy Key
                    </button>
                  </div>
                </div>

                <Form method="post" onSubmit={(e) => {
                  if (!confirm('Are you sure you want to remove your API key? The dashboard will lose access to data.')) {
                    e.preventDefault()
                  }
                }}>
                  <input type="hidden" name="intent" value="remove" />
                  <button
                    type="submit"
                    disabled={isRemoving}
                    className="w-full mt-4 bg-down/10 text-down border border-down/30 font-bold text-xs uppercase tracking-wider px-4 py-2.5 hover:bg-down/20 transition-colors cursor-pointer"
                  >
                    {isRemoving ? 'Removing...' : 'Remove Settings'}
                  </button>
                </Form>
              </div>
            ) : (
              <Form method="post" className="space-y-4" data-testid="api-key-form">
                <input type="hidden" name="intent" value="save" />
                <div>
                  <label className="block text-xs font-bold text-foreground/70 mb-2 uppercase tracking-wider">
                    Quantour API Key
                  </label>
                  <input
                    type="password"
                    name="apiKey"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="quantour_..."
                    className="w-full bg-surface-sink border border-border/20 px-4 py-2.5 text-xs text-foreground font-mono placeholder-white/30 focus:outline-none focus:border-primary transition-all"
                  />
                </div>
                
                {error ? <p className="text-down text-xs font-bold bg-down/10 border border-down/30 p-2">{String(error)}</p> : null}
                
                <button
                  type="submit"
                  disabled={isSaving}
                  className="w-full bg-primary/20 hover:bg-primary/30 border border-primary/50 text-primary font-bold text-xs uppercase tracking-wider px-4 py-2.5 transition-colors cursor-pointer"
                >
                  {isSaving ? 'Saving...' : 'Save Configuration'}
                </button>
              </Form>
            )}
          </Surface>
        </div>
        
        <div className="space-y-4">
          <h3 className="text-xs font-bold text-foreground/50 uppercase tracking-wider">
            ℹ️ Information
          </h3>
          <Surface surface="elevated" className="p-6 border border-border/10 bg-surface-sink/40">
            <p className="text-xs text-foreground/80 leading-relaxed">
              This dashboard now routes requests through your local <strong>client_api</strong> backend. 
              To fetch macroeconomic data, signals, and portfolio analysis, you must provide a valid Quantour API key.
            </p>
            <p className="text-xs text-foreground/80 leading-relaxed mt-3">
              Your API key and integrations are securely stored in a local SQLite database and are NEVER sent anywhere except directly to Quantour servers.
            </p>
            <a 
              href={quantourUrl}
              target="_blank" 
              rel="noreferrer"
              className="inline-block mt-4 text-primary font-bold text-xs hover:underline uppercase tracking-wider"
            >
              Get an API key at {quantourUrl.replace(/^https?:\/\//, '')} →
            </a>
          </Surface>
        </div>
      </div>
    </div>
  )
}
