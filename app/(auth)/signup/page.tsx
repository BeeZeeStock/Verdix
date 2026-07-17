'use client'

import Link from 'next/link'
import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { signIn } from 'next-auth/react'
import { VerdixLogo } from '@/components/VerdixLogo'

const PLAN_LABELS: Record<string, string> = {
  core: 'Core — €95/month',
  pro: 'Pro — €445/month',
}

function SignupContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const plan = searchParams.get('plan') ?? ''
  const planLabel = PLAN_LABELS[plan] ?? null

  const [form, setForm] = useState({ fullName: '', email: '', company: '', password: '', confirm: '' })
  const [gdpr, setGdpr] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const update = (field: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [field]: e.target.value }))

  const handleGoogleSignIn = () => {
    const callbackUrl = plan
      ? `/api/billing/checkout-redirect?plan=${encodeURIComponent(plan)}`
      : '/dashboard'
    signIn('google', { callbackUrl }, { prompt: 'select_account' })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!gdpr) { setError('You must accept the Privacy Policy and Terms to continue.'); return }
    if (form.password !== form.confirm) { setError('Passwords do not match.'); return }
    if (form.password.length < 8) { setError('Password must be at least 8 characters.'); return }
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: form.fullName,
          email: form.email,
          company: form.company,
          password: form.password,
          privacyConsentAt: new Date().toISOString(),
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'Something went wrong. Please try again.')
        return
      }
      const result = await signIn('credentials', {
        email: form.email,
        password: form.password,
        redirect: false,
      })
      if (result?.error) {
        setError('Account created — please sign in.')
        router.push('/login')
        return
      }

      // If a paid plan was selected, go straight to Stripe Checkout
      if (plan && ['core', 'pro'].includes(plan)) {
        const checkoutRes = await fetch('/api/billing/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ planId: plan }),
        })
        if (checkoutRes.ok) {
          const { url } = await checkoutRes.json()
          if (url) { window.location.href = url; return }
        }
      }

      router.push('/dashboard')
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-cream flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="bg-white border border-forest/10 rounded-2xl p-8 shadow-sm">
          <div className="flex flex-col items-center mb-8">
            <VerdixLogo size={36} />
            <h1 className="font-display font-light text-ink text-2xl mt-4 mb-1">Start finding leakage</h1>
            {planLabel ? (
              <div
                className="mt-2 flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-medium"
                style={{ color: '#27500A', background: '#EAF3DE', border: '1px solid #C0DD97' }}
              >
                <i className="ti ti-check" style={{ fontSize: 11 }} />
                Signing up for {planLabel}
              </div>
            ) : (
              <p className="text-stone text-sm">Free for your first audit. No credit card.</p>
            )}
          </div>

          <button
            onClick={handleGoogleSignIn}
            className="flex items-center justify-center gap-3 w-full border border-forest/20 rounded-xl px-4 py-3 text-sm font-medium text-ink hover:bg-cream transition-colors mb-6"
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

          <form onSubmit={handleSubmit} className="space-y-4">
            {[
              { label: 'Full name', field: 'fullName', placeholder: 'Anna Lindqvist', type: 'text' },
              { label: 'Work email', field: 'email', placeholder: 'you@company.com', type: 'email' },
              { label: 'Company name', field: 'company', placeholder: 'Acme AB', type: 'text' },
              { label: 'Password', field: 'password', placeholder: '••••••••', type: 'password' },
              { label: 'Confirm password', field: 'confirm', placeholder: '••••••••', type: 'password' },
            ].map(f => (
              <div key={f.field}>
                <label className="block text-xs font-medium text-stone uppercase tracking-widest mb-2">{f.label}</label>
                <input
                  type={f.type}
                  value={(form as Record<string, string>)[f.field]}
                  onChange={update(f.field)}
                  placeholder={f.placeholder}
                  required
                  className="w-full bg-cream border border-forest/15 rounded-xl px-4 py-3 text-sm text-ink outline-none focus:border-forest focus:bg-white transition-colors"
                />
              </div>
            ))}

            {/* Data privacy notice */}
            <div className="rounded-xl border border-forest/15 bg-cream p-4 space-y-2.5 mt-2">
              <p className="text-xs font-semibold text-ink">Your data stays yours</p>
              <ul className="space-y-1.5 text-xs text-stone leading-relaxed list-none">
                <li><span className="font-medium text-ink">Contract files</span> are stored securely and only accessible by your organisation.</li>
                <li><span className="font-medium text-ink">PII masking</span> — names, emails, and identifiers are detected and masked locally before being sent to AI for analysis.</li>
                <li><span className="font-medium text-ink">AI processing</span> is performed via Amazon Bedrock infrastructure. Your contract data is never used to train AI models.</li>
                <li><span className="font-medium text-ink">Extracted terms</span> (prices, dates, discounts) power your dashboard only and are never shared with other organisations.</li>
                <li><span className="font-medium text-ink">Storage</span> is handled by Supabase with encryption at rest, hosted in the EU (Frankfurt).</li>
              </ul>
            </div>

            {/* Consent checkbox — mandatory */}
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={gdpr}
                onChange={e => setGdpr(e.target.checked)}
                className="mt-0.5 flex-shrink-0"
                style={{ accentColor: '#1A3D2B' }}
              />
              <span className="text-xs text-stone leading-relaxed">
                I understand how Verdix processes my data as described above, and I agree to the{' '}
                <Link href="/privacy" target="_blank" className="text-forest underline">Privacy Policy</Link>
                {' '}and{' '}
                <Link href="/terms" target="_blank" className="text-forest underline">Terms of Service</Link>.
              </span>
            </label>

            {error && (
              <p className="text-xs text-danger bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
            )}

            <button
              type="submit"
              disabled={!gdpr || loading}
              className="w-full bg-forest text-white rounded-xl px-4 py-3 text-sm font-medium hover:bg-sage transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {loading
                ? (plan ? 'Creating account & redirecting to checkout...' : 'Creating account...')
                : (planLabel ? `Create account & subscribe to ${PLAN_LABELS[plan]} →` : 'Create account →')}
            </button>
          </form>

          <p className="text-center text-sm text-stone mt-5">
            Already have an account?{' '}
            <Link href="/login" className="text-forest font-medium hover:underline">Sign in →</Link>
          </p>
        </div>
      </div>
    </div>
  )
}

export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupContent />
    </Suspense>
  )
}
