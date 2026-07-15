'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { VerdixLogo } from '@/components/VerdixLogo'

export default function ConsentPage() {
  const router = useRouter()
  const { update } = useSession()
  const [agreed, setAgreed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!agreed) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/consent', { method: 'POST' })
      if (!res.ok) throw new Error('Failed to record consent')
      // Refresh the JWT so needsConsent clears and middleware lets us through
      await update()
      router.push('/dashboard')
    } catch {
      setError('Something went wrong. Please try again.')
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-cream flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="bg-white border border-forest/10 rounded-2xl p-8 shadow-sm">
          <div className="flex flex-col items-center mb-8">
            <VerdixLogo size={36} />
            <h1 className="font-display font-light text-ink text-2xl mt-4 mb-1">One quick step</h1>
            <p className="text-stone text-sm text-center">Please review how Verdix handles your data before continuing.</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="rounded-xl border border-forest/15 bg-cream p-4 space-y-2.5">
              <p className="text-xs font-semibold text-ink">Your data stays yours</p>
              <ul className="space-y-1.5 text-xs text-stone leading-relaxed list-none">
                <li><span className="font-medium text-ink">Contract files</span> are stored securely and only accessible by your organisation.</li>
                <li><span className="font-medium text-ink">PII masking</span> — names, emails, and identifiers are detected and masked locally before being sent to AI for analysis.</li>
                <li><span className="font-medium text-ink">AI processing</span> is performed via Amazon Bedrock infrastructure. Your contract data is never used to train AI models.</li>
                <li><span className="font-medium text-ink">Extracted terms</span> (prices, dates, discounts) power your dashboard only and are never shared with other organisations.</li>
                <li><span className="font-medium text-ink">Storage</span> is handled by Supabase with encryption at rest. EU hosting is available on request.</li>
              </ul>
            </div>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={agreed}
                onChange={e => setAgreed(e.target.checked)}
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
              <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
            )}

            <button
              type="submit"
              disabled={!agreed || loading}
              className="w-full bg-forest text-white rounded-xl px-4 py-3 text-sm font-medium hover:bg-sage transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {loading ? 'Saving...' : 'Continue to Verdix →'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
