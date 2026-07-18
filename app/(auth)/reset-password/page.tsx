'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { VerdixLogo } from '@/components/VerdixLogo'
import { createBrowserClient } from '@/lib/supabase'

export default function ResetPasswordPage() {
  const router = useRouter()
  const [password, setPassword]   = useState('')
  const [confirm, setConfirm]     = useState('')
  const [loading, setLoading]     = useState(false)
  const [done, setDone]           = useState(false)
  const [error, setError]         = useState('')
  const [ready, setReady]         = useState(false)

  // Supabase appends #access_token=...&type=recovery to the redirect URL.
  // We need to let the Supabase client pick up those hash params and establish
  // a session before we can call updateUser.
  useEffect(() => {
    const supabase = createBrowserClient()

    // onAuthStateChange fires with event=PASSWORD_RECOVERY when Supabase
    // detects the recovery token in the URL hash.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') setReady(true)
    })

    // Also check if there's already a session (e.g. page reload after hash was consumed)
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) setReady(true)
    })

    return () => subscription.unsubscribe()
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }

    setLoading(true)
    const supabase = createBrowserClient()
    const { error: updateError } = await supabase.auth.updateUser({ password })
    setLoading(false)

    if (updateError) {
      setError(updateError.message)
    } else {
      setDone(true)
      setTimeout(() => router.push('/login'), 3000)
    }
  }

  return (
    <div className="min-h-screen bg-cream flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="bg-white border border-forest/10 rounded-2xl p-8 shadow-sm">
          <div className="flex flex-col items-center mb-8">
            <VerdixLogo size={36} />
            <h1 className="font-display font-light text-ink text-2xl mt-4 mb-1">Set new password</h1>
            <p className="text-stone text-sm">
              {done ? 'Password updated' : 'Choose a new password for your account'}
            </p>
          </div>

          {done ? (
            <div className="text-center space-y-4">
              <div className="w-12 h-12 rounded-full bg-forest/10 flex items-center justify-center mx-auto">
                <i className="ti ti-circle-check text-forest" style={{ fontSize: 22 }} />
              </div>
              <p className="text-sm text-stone">
                Your password has been updated. Redirecting you to sign in…
              </p>
              <Link href="/login" className="inline-block text-sm text-forest hover:underline font-medium">
                Sign in now →
              </Link>
            </div>
          ) : !ready ? (
            <div className="text-center space-y-4">
              <div className="w-8 h-8 rounded-full border-2 border-forest/20 border-t-forest animate-spin mx-auto" />
              <p className="text-sm text-stone">Verifying reset link…</p>
              <p className="text-xs text-stone/60">
                If nothing happens, the link may have expired.{' '}
                <Link href="/forgot-password" className="text-forest hover:underline">Request a new one</Link>.
              </p>
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
                    New password
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="Min. 8 characters"
                    required
                    className="w-full bg-cream border border-forest/15 rounded-xl px-4 py-3 text-sm text-ink outline-none focus:border-forest focus:bg-white transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-stone uppercase tracking-widest mb-2">
                    Confirm password
                  </label>
                  <input
                    type="password"
                    value={confirm}
                    onChange={e => setConfirm(e.target.value)}
                    placeholder="Repeat new password"
                    required
                    className="w-full bg-cream border border-forest/15 rounded-xl px-4 py-3 text-sm text-ink outline-none focus:border-forest focus:bg-white transition-colors"
                  />
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-forest text-white rounded-xl px-4 py-3 text-sm font-medium hover:bg-sage transition-colors disabled:opacity-60"
                >
                  {loading ? 'Updating...' : 'Update password →'}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
