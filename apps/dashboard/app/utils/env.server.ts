const DEFAULTS: Record<string, string> = {
  CLIENT_API_URL: 'http://127.0.0.1:3006',
  PUBLIC_API_URL: 'http://127.0.0.1:3002',
  API_URL: 'http://127.0.0.1:3001',
}

export function requireEnv(name: string): string {
  const value = process.env[name] || DEFAULTS[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}
