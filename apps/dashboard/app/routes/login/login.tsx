import { Surface } from 'app/components/Surface'
import { authClient } from 'app/lib/auth-client'
import { useState } from 'react'

export default function Login() {
  const [
    email,
    setEmail,
  ] = useState('')
  const [
    password,
    setPassword,
  ] = useState('')
  const [
    showPassword,
    setShowPassword,
  ] = useState(false)
  const [
    error,
    setError,
  ] = useState<string | null>(null)
  const [
    infoMessage,
    setInfoMessage,
  ] = useState<string | null>(null)
  const [
    loading,
    setLoading,
  ] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setInfoMessage(null)
    setLoading(true)

    try {
      const { error: resError } = await authClient.signIn.email({
        email,
        password,
        callbackURL: '/',
      })
      if (resError) {
        setError(resError.message || 'Invalid credentials')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex-1 flex items-center justify-center min-h-[calc(100vh-64px)] p-4">
      <Surface surface="elevated" className="w-full max-w-md border border-surface-elevated-border rounded-none">
        {/* Top accent indicator strip (Metro guideline #6) */}
        <div className="h-0.5 bg-accent" />

        {/* Section bracket header */}
        <div className="px-5 py-3 border-b border-surface-sink-border flex items-center justify-between">
          <span className="font-mono text-xs font-black uppercase tracking-widest text-foreground/60">
            [ <span className="text-accent">AUTH</span> // SIGN IN ]
          </span>
          <span className="font-mono text-micro font-bold uppercase tracking-widest text-foreground/40">
            Secure Session
          </span>
        </div>

        {/* Brand block */}
        <div className="px-5 pt-6 pb-4">
          <h2 data-testid="login-title" className="text-xl font-black text-primary uppercase tracking-wider">
            Quantour
          </h2>
          <p data-testid="login-subtitle" className="font-mono text-xs uppercase tracking-widest text-foreground/60 mt-1">
            Access The Terminal
          </p>
        </div>

        <form onSubmit={handleSubmit} className="px-5 pb-5 space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="email" className="font-mono text-xs font-black uppercase tracking-widest text-foreground/60 block">
              Email Address
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@domain.com"
              required
              className="w-full bg-surface-sink border border-surface-elevated-border rounded-none px-3 py-2 font-mono text-sm focus:border-accent focus:outline-none text-foreground transition-colors"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex justify-between items-center">
              <label htmlFor="password" className="font-mono text-xs font-black uppercase tracking-widest text-foreground/60 block">
                Password
              </label>
              <button
                type="button"
                onClick={() => {
                  setError(null)
                  setInfoMessage('Password recovery is currently under development. Please contact your system administrator to reset credentials.')
                }}
                className="font-mono text-micro font-bold uppercase tracking-widest text-foreground/50 hover:text-accent cursor-pointer transition-colors"
              >
                Forgot Password?
              </button>
            </div>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                className="w-full bg-surface-sink border border-surface-elevated-border rounded-none pl-3 pr-10 py-2 font-mono text-sm focus:border-accent focus:outline-none text-foreground transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-foreground/40 hover:text-foreground/80 transition-colors cursor-pointer select-none"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? (
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
                  </svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {error && (
            <div className="bg-danger text-on-danger rounded-none px-3 py-2.5 font-mono text-xs font-bold">
              ⚠ {error}
            </div>
          )}

          {infoMessage && (
            <div className="bg-warning text-on-warning rounded-none px-3 py-2.5 font-mono text-xs font-bold leading-relaxed">
              ℹ {infoMessage}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-primary text-on-primary border border-primary rounded-none font-mono font-black uppercase tracking-widest py-3 text-xs hover:brightness-110 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {loading ? 'Authenticating...' : 'Sign In →'}
          </button>
        </form>

        {/* Footer status bar */}
        <div className="border-t border-surface-sink-border bg-surface-sink px-5 py-2 flex items-center justify-between font-mono text-micro uppercase tracking-widest text-foreground/40">
          <span>Session · TLS</span>
          <span className="text-success">● Online</span>
        </div>
      </Surface>
    </div>
  )
}
