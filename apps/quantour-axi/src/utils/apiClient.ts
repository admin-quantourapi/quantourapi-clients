export interface ApiClientConfig {
  baseUrl: string
  apiKey?: string
}

export class QuantourApiClient {
  private baseUrl: string
  private apiKey?: string

  constructor(config?: ApiClientConfig) {
    this.baseUrl = (config?.baseUrl || process.env.QUANTOUR_API_URL || 'https://api.quantourapi.com').replace(/\/$/, '')
    this.apiKey = config?.apiKey || process.env.QUANTOUR_API_KEY || ''
  }

  async get<T = unknown>(endpoint: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${this.baseUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`)
    if (params) {
      Object.entries(params).forEach(([
        key,
        val,
      ]) => {
        if (val !== undefined && val !== null) {
          url.searchParams.append(key, val)
        }
      })
    }

    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'User-Agent': 'quantour-axi/1.0.0',
    }
    if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey
    }

    const res = await fetch(url.toString(), { headers })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`API Error [${res.status}]: ${errText || res.statusText}`)
    }

    return res.json() as Promise<T>
  }

  async post<T = unknown>(endpoint: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'quantour-axi/1.0.0',
    }
    if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`API Error [${res.status}]: ${errText || res.statusText}`)
    }

    return res.json() as Promise<T>
  }
}
