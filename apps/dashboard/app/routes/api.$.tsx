import type { Route } from './+types/api.$'


export const loader = async ({ request }: Route.LoaderArgs) => {
  return handleApiProxy(request)
}

export const action = async ({ request }: Route.ActionArgs) => {
  return handleApiProxy(request)
}

async function handleApiProxy(request: Request) {
  const url = new URL(request.url)
  
  // The API server runs on port 3001 inside the same container (or localhost in dev)
  const apiHost = process.env.API_URL || 'http://127.0.0.1:3001'
  const targetUrl = `${apiHost}${url.pathname}${url.search}`

  const headers = new Headers(request.headers)
  headers.delete('host')
  
  // Forward original host so Better Auth knows the true origin
  headers.set('x-forwarded-host', url.host)
  headers.set('x-forwarded-proto', url.protocol.replace(':', ''))

  const fetchOptions: RequestInit = {
    method: request.method,
    headers,
    redirect: 'manual',
  }

  // Disable keep-alive to prevent socket errors with Bun upstream
  if (fetchOptions.headers instanceof Headers) {
    fetchOptions.headers.set('Connection', 'close')
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    fetchOptions.body = await request.clone().arrayBuffer()
  }

  try {
    const response = await fetch(targetUrl, fetchOptions)
    
    if (!response.ok) {
      const clonedResp = response.clone()
      console.error(`[API PROXY ERROR] ${targetUrl} returned ${response.status}:`, await clonedResp.text())
    }
    
    // We must rebuild headers to handle Set-Cookie correctly
    const newHeaders = new Headers(response.headers)
    newHeaders.delete('set-cookie')
    
    const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : []
    
    for (const cookie of setCookies) {
      // Strip Domain attribute so it works on the proxy domain (localhost:3000)
      const sanitizedCookie = cookie.replace(/Domain=[^;]+;?/i, '')
      newHeaders.append('set-cookie', sanitizedCookie)
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    })
  } catch (error) {
    console.error('API Proxy Error:', error)
    return new Response(JSON.stringify({ error: 'Internal API Gateway Error' }), { 
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
