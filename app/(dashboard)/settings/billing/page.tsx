'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { Suspense } from 'react'

const ADMIN_EMAILS = ['bilal@lynoraai.com', 'bilal.zahoor@yahoo.com']

type Plan = {
  id: string
  name: string
  base_price_eur: number
  sync_limit: number | null
  overage_price_eur: number | null
  pii_addon_available: boolean
  stripe_price_id: string | null
}

type BillingStatus = {
  plan: Plan
  subscription: {
    plan_id: string
    syncs_used: number
    pii_addon_enabled: boolean
    stripe_customer_id: string | null
    current_period_end: string | null
    status: string
  }
  syncLimit: number | null
  syncsRemaining: number | null
  isOverLimit: boolean
  isNearLimit: boolean
  plans: Plan[]
}

const PLAN_ORDER = ['trial', 'core', 'pro', 'enterprise']
const PLAN_COLORS: Record<string, string> = { trial: '#9CA3AF', core: '#2563EB', pro: '#7C3AED', enterprise: '#1A3D2B' }

function BillingPageInner() {
  const params = useSearchParams()
  const { data: session } = useSession()
  const router = useRouter()
  const [status, setStatus]               = useState<BillingStatus | null>(null)
  const [loading, setLoading]             = useState(true)
  const [upgrading, setUpgrading]         = useState<string | null>(null)
  const [piiToggling, setPiiToggling]     = useState(false)
  const [showEnterprise, setShowEnterprise] = useState(false)
  const [entForm, setEntForm]             = useState({ name: '', company: '', message: '' })
  const [entSending, setEntSending]       = useState(false)
  const [entSent, setEntSent]             = useState(false)
  const [portalLoading, setPortalLoading] = useState(false)

  const upgraded  = params.get('upgraded') === '1'
  const cancelled = params.get('cancelled') === '1'

  useEffect(() => {
    if (session?.user?.email && ADMIN_EMAILS.includes(session.user.email)) {
      router.replace('/admin/billing')
      return
    }
    fetch('/api/billing/status')
      .then(r => r.json())
      .then(d => { setStatus(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [session, router])

  const upgrade = async (planId: string, includePiiAddon = false) => {
    setUpgrading(planId)
    const res = await fetch('/api/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId, includePiiAddon }),
    })
    const data = await res.json()
    if (data.url) window.location.href = data.url
    else setUpgrading(null)
  }

  const togglePii = async (enable: boolean) => {
    setPiiToggling(true)
    await fetch('/api/billing/pii-addon', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enable }),
    })
    setStatus(prev => prev ? { ...prev, subscription: { ...prev.subscription, pii_addon_enabled: enable } } : prev)
    setPiiToggling(false)
  }

  const openPortal = async () => {
    setPortalLoading(true)
    const res = await fetch('/api/billing/portal', { method: 'POST' })
    const data = await res.json()
    if (data.url) window.location.href = data.url
    else setPortalLoading(false)
  }

  const sendEnterpriseEnquiry = async () => {
    setEntSending(true)
    await fetch('/api/billing/enterprise-enquiry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(entForm),
    })
    setEntSending(false)
    setEntSent(true)
  }

  if (loading) return <div className="p-4 md:p-8 text-stone text-sm">Loading…</div>
  if (!status) return <div className="p-4 md:p-8 text-red-600 text-sm">Failed to load billing info.</div>

  const { plan, subscription, syncLimit, isOverLimit, isNearLimit, plans } = status
  const syncsUsed = subscription.syncs_used
  const usagePct  = syncLimit ? Math.min(100, Math.round((syncsUsed / syncLimit) * 100)) : 0

  const nextPlans = plans
    .filter(p => PLAN_ORDER.indexOf(p.id) > PLAN_ORDER.indexOf(plan.id) && p.id !== 'enterprise')
    .sort((a, b) => PLAN_ORDER.indexOf(a.id) - PLAN_ORDER.indexOf(b.id))

  return (
    <div className="p-4 md:p-8 max-w-2xl">
      <div className="mb-8">
        <h1 className="font-display font-light text-ink text-2xl mb-1">Billing</h1>
        <p className="text-stone text-sm">Manage your Verdix subscription</p>
      </div>

      {upgraded && (
        <div className="mb-6 bg-forest/8 border border-forest/20 rounded-xl px-4 py-3 text-sm text-forest font-medium">
          ✓ Subscription activated — welcome to {plan.name}!
        </div>
      )}
      {cancelled && (
        <div className="mb-6 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-700">
          Upgrade cancelled. Your current plan is unchanged.
        </div>
      )}

      {/* Current plan */}
      <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden mb-4">
        <div className="px-6 py-4 border-b border-forest/8">
          <span className="text-sm font-medium text-ink">Current plan</span>
        </div>
        <div className="p-6">
          <div className="flex items-start justify-between mb-5">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xl font-semibold text-ink">{plan.name}</span>
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: `${PLAN_COLORS[plan.id]}18`, color: PLAN_COLORS[plan.id] }}>
                  {subscription.status}
                </span>
              </div>
              <div className="text-sm text-stone">
                {plan.base_price_eur > 0 ? `€${plan.base_price_eur}/month` : 'Free'}
                {subscription.current_period_end && (
                  <span className="ml-2 text-stone/60">
                    · Renews {new Date(subscription.current_period_end).toLocaleDateString('en-IE', { day: 'numeric', month: 'long' })}
                  </span>
                )}
              </div>
            </div>
            {subscription.stripe_customer_id && (
              <button
                onClick={openPortal}
                disabled={portalLoading}
                className="text-xs text-forest border border-forest/20 px-3 py-1.5 rounded-lg hover:bg-forest/5 transition-colors disabled:opacity-50"
              >
                {portalLoading ? 'Loading…' : 'Manage invoices →'}
              </button>
            )}
          </div>

          {/* Usage meter */}
          {syncLimit != null && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs text-stone">Agreement syncs this period</span>
                <span className="text-xs font-mono font-medium text-ink">{syncsUsed} / {syncLimit}</span>
              </div>
              <div className="h-2 bg-forest/8 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${usagePct}%`,
                    background: isOverLimit ? '#DC2626' : isNearLimit ? '#D97706' : '#1A3D2B',
                  }}
                />
              </div>
              {isOverLimit && (
                <p className="text-xs text-red-600 mt-1.5 font-medium">
                  Over limit — {plan.overage_price_eur ? `€${plan.overage_price_eur}/extra sync will be billed at month end` : 'upgrade to continue'}
                </p>
              )}
              {isNearLimit && !isOverLimit && (
                <p className="text-xs text-amber-600 mt-1.5">
                  Approaching your monthly limit
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* PII add-on */}
      {plan.pii_addon_available && (
        <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden mb-4">
          <div className="px-6 py-4 border-b border-forest/8">
            <span className="text-sm font-medium text-ink">Advanced PII Data Masking</span>
          </div>
          <div className="p-6 flex items-start justify-between gap-4">
            <div>
              <p className="text-sm text-stone leading-relaxed">
                Names, emails, and identifiers are detected and masked before being sent to AI.
                {plan.id === 'enterprise' ? ' Included in your Enterprise plan.' : ' +€45/month, billed for the full month.'}
              </p>
            </div>
            <button
              onClick={() => togglePii(!subscription.pii_addon_enabled)}
              disabled={piiToggling}
              className={`flex-shrink-0 text-sm font-medium px-4 py-2 rounded-xl transition-colors disabled:opacity-50 ${
                subscription.pii_addon_enabled
                  ? 'bg-red-50 text-red-700 border border-red-200 hover:bg-red-100'
                  : 'bg-forest text-white hover:bg-sage'
              }`}
            >
              {piiToggling ? '…' : subscription.pii_addon_enabled ? 'Disable' : 'Enable — €45/mo'}
            </button>
          </div>
        </div>
      )}

      {/* Upgrade options */}
      {nextPlans.length > 0 && (
        <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden mb-4">
          <div className="px-6 py-4 border-b border-forest/8">
            <span className="text-sm font-medium text-ink">Upgrade plan</span>
          </div>
          <div className="p-6 space-y-3">
            {nextPlans.map(p => (
              <div key={p.id} className="flex items-center justify-between p-4 border border-forest/10 rounded-xl hover:border-forest/20 transition-colors">
                <div>
                  <div className="text-sm font-semibold text-ink mb-0.5">{p.name}</div>
                  <div className="text-xs text-stone">
                    €{p.base_price_eur}/month · {p.sync_limit} syncs included
                    {p.overage_price_eur ? ` · €${p.overage_price_eur}/extra` : ''}
                  </div>
                </div>
                <button
                  onClick={() => upgrade(p.id)}
                  disabled={upgrading === p.id || !p.stripe_price_id}
                  className="bg-forest text-white text-sm font-medium px-4 py-2 rounded-xl hover:bg-sage transition-colors disabled:opacity-40"
                  title={!p.stripe_price_id ? 'Plan not yet configured in Stripe' : ''}
                >
                  {upgrading === p.id ? 'Redirecting…' : `Upgrade to ${p.name.split(' ').pop()}`}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Enterprise */}
      {plan.id !== 'enterprise' && (
        <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden">
          <div className="p-6 flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-ink mb-0.5">Verdix Enterprise</div>
              <div className="text-xs text-stone">Contact the Verdix team for a custom offer tailored to your organisation&apos;s specific needs.</div>
            </div>
            <button
              onClick={() => setShowEnterprise(true)}
              className="flex-shrink-0 border border-forest/20 text-forest text-sm font-medium px-4 py-2 rounded-xl hover:bg-forest/5 transition-colors"
            >
              Contact sales →
            </button>
          </div>

          {showEnterprise && (
            <div className="px-6 pb-6 border-t border-forest/8 pt-5 space-y-3">
              {entSent ? (
                <p className="text-sm text-forest font-medium">Thanks! We'll be in touch within one business day.</p>
              ) : (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">Your name</label>
                      <input value={entForm.name} onChange={e => setEntForm(f => ({ ...f, name: e.target.value }))}
                        className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2.5 text-sm text-ink outline-none focus:border-forest" />
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">Company</label>
                      <input value={entForm.company} onChange={e => setEntForm(f => ({ ...f, company: e.target.value }))}
                        className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2.5 text-sm text-ink outline-none focus:border-forest" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">What are you looking for? (optional)</label>
                    <textarea value={entForm.message} onChange={e => setEntForm(f => ({ ...f, message: e.target.value }))} rows={3}
                      className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2.5 text-sm text-ink outline-none focus:border-forest resize-none" />
                  </div>
                  <button
                    onClick={sendEnterpriseEnquiry}
                    disabled={entSending || !entForm.name || !entForm.company}
                    className="bg-forest text-white text-sm font-medium px-5 py-2.5 rounded-xl hover:bg-sage transition-colors disabled:opacity-40"
                  >
                    {entSending ? 'Sending…' : 'Send enquiry →'}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function BillingPage() {
  return (
    <Suspense fallback={<div className="p-8 text-stone text-sm">Loading…</div>}>
      <BillingPageInner />
    </Suspense>
  )
}
