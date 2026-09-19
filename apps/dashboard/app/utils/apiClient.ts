import { requireEnv } from 'app/utils/env.server'

export async function fetchFromPublicApi(path: string, _request: Request, options?: RequestInit) {
  // We no longer need to read cookies here; the local client_api holds the key!

  const clientApiUrl = requireEnv('CLIENT_API_URL')
  const urlStr = path.startsWith('/') ? path : `/${path}`

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 1500)

  try {
    // Proxy through the local client API
    const response = await fetch(`${clientApiUrl}/proxy${urlStr}`, {
      cache: 'no-store',
      signal: controller.signal,
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Connection': 'close',
        ...options?.headers,
      },
    })
    clearTimeout(timeoutId)

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      console.error(`[API CLIENT] Public API fetch failed status=${response.status} path=${urlStr}: ${errorText}`)
      return null
    }

    return response.json()
  } catch (_err) {
    clearTimeout(timeoutId)
    return null
  }
}
