'use client'

import { useState } from 'react'
import Link from 'next/link'
import { VerdixLogo } from '@/components/VerdixLogo'

export default function ForgotPasswordPage() {
  const [email, setEmail]     = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent]       = useState(false)
  const [error, setError]     = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    const res = await fetch('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    })

    setLoading(false)
    if (res.ok) {
      setSent(true)
    } else {
      const data = await res.json().catch(() => ({}))
      setError(data.error ?? 'Something went wrong. Please try again.')
    }
  }

  return (
    <div className="min-h-screen bg-cream flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="bg-white border border-forest/10 rounded-2xl p-8 shadow-sm">
          <div className="flex flex-col items-center mb-8">
            <VerdixLogo size={36} />
            <h1 className="font-display font-light text-ink text-2xl mt-4 mb-1">Reset your password</h1>
            <p className="text-stone text-sm text-center">
              {sent ? 'Check your inbox' : "Enter your email and we'll send you a reset link"}
            </p>
          </div>

          {sent ? (
            <div className="text-center space-y-4">
              <div className="w-12 h-12 rounded-full bg-forest/10 flex items-center justify-center mx-auto">
                <i className="ti ti-mail-check text-forest" style={{ fontSize: 22 }} />
              </div>
              <p className="text-sm text-stone leading-relaxed">
                We sent a password reset link to <span className="font-medium text-ink">{email}</span>.
                Check your spam folder if it doesn&apos;t arrive within a minute.
              </p>
              <Link href="/login"
                className="inline-block mt-2 text-sm text-forest hover:underline font-medium">
                ← Back to sign in
              </Link>
            </div>
          ) : (
            <>
              {error && (
                <div className="mb-4 text-xs text-danger bg-danger/5 border border-danger/20 rounded-xl px-4 py-3">
                  {error}
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-stone uppercase tracking-widest mb-2">
                    Work email
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="you@company.com"
                    required
                    className="w-full bg-cream border border-forest/15 rounded-xl px-4 py-3 text-sm text-ink outline-none focus:border-forest focus:bg-white transition-colors"
                  />
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-forest text-white rounded-xl px-4 py-3 text-sm font-medium hover:bg-sage transition-colors disabled:opacity-60"
                >
                  {loading ? 'Sending...' : 'Send reset link →'}
                </button>
              </form>

              <p className="text-center mt-5 text-sm text-stone">
                <Link href="/login" className="hover:text-forest transition-colors">
                  ← Back to sign in
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
