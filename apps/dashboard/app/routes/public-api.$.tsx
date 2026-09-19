import { requireEnv } from 'app/utils/env.server'

import type { Route } from './+types/public-api.$'


export const loader = async ({ request }: Route.LoaderArgs) => {
  return handleApiProxy(request)
}

export const action = async ({ request }: Route.ActionArgs) => {
  return handleApiProxy(request)
}

async function handleApiProxy(request: Request) {
  const url = new URL(request.url)
  
  // The public API server runs on port 3006 inside the container
  const apiHost = requireEnv('CLIENT_API_URL')
  
  // Strip '/public-api' from the path before forwarding
  // Handles /public-api/proxy/* => CLIENT_API_URL/proxy/*
  const newPath = url.pathname.replace(/^\/public-api/, '')
  const targetUrl = `${apiHost}${newPath}${url.search}`

  const headers = new Headers(request.headers)
  
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
    const responseBody = await response.arrayBuffer()
    const newHeaders = new Headers(response.headers)
    newHeaders.delete('content-encoding')
    newHeaders.delete('content-length')
    newHeaders.delete('transfer-encoding')
    newHeaders.delete('connection')
    newHeaders.delete('keep-alive')

    return new Response(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    })
  } catch (error) {
    console.error('Public API Proxy Error:', error)
    return new Response(JSON.stringify({ error: 'Internal API Gateway Error' }), { 
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
