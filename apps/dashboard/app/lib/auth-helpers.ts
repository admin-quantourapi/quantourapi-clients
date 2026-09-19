import { redirect } from 'react-router'

export interface SessionData {
  user: {
    id: string
    name: string
    email: string
    role?: string
  }
}

export async function getSessionFromServer(request: Request): Promise<SessionData | null> {
  try {
    const cookieHeader = request.headers.get('cookie') || request.headers.get('Cookie')
    const apiPort = process.env.API_PORT || '3001'
    const res = await fetch(`http://127.0.0.1:${apiPort}/api/auth/get-session`, {
      headers: { ...(cookieHeader ? { cookie: cookieHeader } : {}) },
    })
    if (res.ok) {
      const data = await res.json()
      if (data && data.session && data.user) {
        return data as SessionData
      }
    }
  } catch (error) {
    console.error('Failed to fetch session from server:', error)
  }
  return null
}

export async function requireWriteAccess(request: Request): Promise<SessionData> {
  const session = await getSessionFromServer(request)
  if (!session) {
    throw redirect('/login')
  }
  return session
}
