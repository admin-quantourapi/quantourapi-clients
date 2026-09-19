import { createAuthClient } from 'better-auth/react'

const getBaseURL = () => {
  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.host}`
  }
  return process.env.BETTER_AUTH_URL || 'http://localhost:3001'
}

export const authClient = createAuthClient({
  baseURL: getBaseURL(),
})
