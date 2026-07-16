'use client'

import Link from 'next/link'
import { useState } from 'react'
import { signIn } from 'next-auth/react'
import { VerdixLogo } from '@/components/VerdixLogo'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleGoogle = async () => {
    setLoading(true)
    await signIn('google', { callbackUrl: '/dashboard' }, { prompt: 'select_account' })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    const res = await signIn('credentials', {
      email, password, redirect: false,
    })
    if (res?.error) {
      setError('Invalid email or password')
      setLoading(false)
    } else {
      window.location.href = '/dashboard'
    }
  }

  return (
    <div className="min-h-screen bg-cream flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="bg-white border border-forest/10 rounded-2xl p-8 shadow-sm">
          <div className="flex flex-col items-center mb-8">
            <VerdixLogo size={36} />
            <h1 className="font-display font-light text-ink text-2xl mt-4 mb-1">Welcome back</h1>
            <p className="text-stone text-sm">Sign in to your Verdix account</p>
          </div>

          {/* Google */}
          <button
            onClick={handleGoogle}
            disabled={loading}
            className="flex items-center justify-center gap-3 w-full border border-forest/20 rounded-xl px-4 py-3 text-sm font-medium text-ink hover:bg-cream transition-colors mb-6 disabled:opacity-60"
          >
            <svg width="18" height="18" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
            </svg>
            Continue with Google
          </button>

          <div className="flex items-center gap-4 mb-6">
            <div className="flex-1 h-px bg-forest/10" />
            <span className="text-xs text-stone">or</span>
            <div className="flex-1 h-px bg-forest/10" />
          </div>

          {error && (
            <div className="mb-4 text-xs text-danger bg-danger/5 border border-danger/20 rounded-xl px-4 py-3">{error}</div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-stone uppercase tracking-widest mb-2">Work email</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@company.com"
                required
                className="w-full bg-cream border border-forest/15 rounded-xl px-4 py-3 text-sm text-ink outline-none focus:border-forest focus:bg-white transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone uppercase tracking-widest mb-2">Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                className="w-full bg-cream border border-forest/15 rounded-xl px-4 py-3 text-sm text-ink outline-none focus:border-forest focus:bg-white transition-colors"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-forest text-white rounded-xl px-4 py-3 text-sm font-medium hover:bg-sage transition-colors disabled:opacity-60"
            >
              {loading ? 'Signing in...' : 'Sign in →'}
            </button>
          </form>

          <div className="flex items-center justify-between mt-5 text-sm text-stone">
            <a href="#" className="hover:text-forest transition-colors">Forgot password?</a>
            <Link href="/signup" className="hover:text-forest transition-colors">Don&apos;t have an account? <span className="text-forest font-medium">Sign up →</span></Link>
          </div>

          <p className="text-center text-xs text-stone/60 mt-6">
            By signing in you agree to our{' '}
            <Link href="/terms" className="underline hover:text-forest">Terms</Link> and{' '}
            <Link href="/privacy" className="underline hover:text-forest">Privacy Policy</Link>
          </p>
        </div>
      </div>
    </div>
  )
}
