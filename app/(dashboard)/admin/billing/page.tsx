'use client'

import { useEffect, useState } from 'react'

type Plan = {
  id: string
  name: string
  base_price_eur: number
  sync_limit: number | null
  overage_price_eur: number | null
  pii_addon_available: boolean
  stripe_product_id: string | null
  stripe_price_id: string | null
  sort_order: number
}

type Setting = { key: string; value: number | string }

const EDITABLE_PLANS = ['core', 'pro', 'pii_addon']

export default function AdminBillingPage() {
  const [plans, setPlans]           = useState<Plan[]>([])
  const [settings, setSettings]     = useState<Setting[]>([])
  const [loading, setLoading]       = useState(true)
  const [saving, setSaving]         = useState<string | null>(null)
  const [msg, setMsg]               = useState<{ id: string; ok: boolean; text: string } | null>(null)
  const [edits, setEdits]           = useState<Record<string, Partial<Plan>>>({})
  const [trialLimit, setTrialLimit] = useState('')
  const [savingTrial, setSavingTrial] = useState(false)
  const [webhookSecret, setWebhookSecret] = useState<string | null>(null)
  const [registeringWebhook, setRegisteringWebhook] = useState(false)
  const [webhookMsg, setWebhookMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    fetch('/api/admin/billing')
      .then(r => r.json())
      .then(d => {
        setPlans(d.plans ?? [])
        setSettings(d.settings ?? [])
        const tl = d.settings?.find((s: Setting) => s.key === 'trial_sync_limit')
        if (tl) setTrialLimit(String(tl.value))
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const setField = (planId: string, field: keyof Plan, value: unknown) =>
    setEdits(prev => ({ ...prev, [planId]: { ...prev[planId], [field]: value } }))

  const getVal = <K extends keyof Plan>(planId: string, field: K, fallback: Plan[K]) =>
    (edits[planId]?.[field] as Plan[K]) ?? fallback

  const savePlan = async (plan: Plan, pushToStripe: boolean) => {
    setSaving(plan.id)
    setMsg(null)
    // Always include current plan values so Stripe push works even without edits
    const patch = { id: plan.id, pushToStripe, name: plan.name, base_price_eur: plan.base_price_eur, ...edits[plan.id] }
    const res = await fetch('/api/admin/billing', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
    const data = await res.json()
    if (res.ok) {
      setPlans(prev => prev.map(p => p.id === plan.id ? { ...p, ...data.plan } : p))
      setEdits(prev => { const n = { ...prev }; delete n[plan.id]; return n })
      setMsg({ id: plan.id, ok: true, text: pushToStripe ? 'Saved and pushed to Stripe ✓' : 'Saved ✓' })
    } else {
      setMsg({ id: plan.id, ok: false, text: data.error ?? 'Error' })
    }
    setSaving(null)
  }

  const registerWebhook = async () => {
    setRegisteringWebhook(true)
    setWebhookMsg(null)
    setWebhookSecret(null)
    const res = await fetch('/api/admin/billing/register-webhook', { method: 'POST' })
    const data = await res.json()
    if (res.ok) {
      setWebhookSecret(data.secret)
      setWebhookMsg({ ok: true, text: `Webhook registered at ${data.url}` })
    } else {
      setWebhookMsg({ ok: false, text: data.error ?? 'Failed to register webhook' })
    }
    setRegisteringWebhook(false)
  }

  const saveTrialLimit = async () => {
    setSavingTrial(true)
    const res = await fetch('/api/admin/billing', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'trial_sync_limit', value: Number(trialLimit) }),
    })
    setSavingTrial(false)
    if (res.ok) setMsg({ id: 'trial', ok: true, text: 'Trial limit updated ✓' })
  }

  if (loading) return <div className="p-8 text-stone text-sm">Loading…</div>

  return (
    <div className="p-4 md:p-8 max-w-4xl">
      <div className="mb-8">
        <h1 className="font-display font-light text-ink text-2xl mb-1">Billing & Packages</h1>
        <p className="text-stone text-sm">Manage Verdix SaaS pricing tiers and push to Stripe</p>
      </div>

      {/* Trial global limit */}
      <div className="bg-white border border-forest/10 rounded-2xl p-6 mb-6">
        <div className="text-sm font-medium text-ink mb-1">Global trial sync limit</div>
        <p className="text-xs text-stone mb-4">Default max agreement syncs for all Trial accounts. Individual orgs can be overridden on the Customers page.</p>
        <div className="flex items-center gap-3">
          <input
            type="number"
            value={trialLimit}
            onChange={e => setTrialLimit(e.target.value)}
            className="w-28 bg-cream border border-forest/15 rounded-xl px-4 py-2.5 text-sm text-ink outline-none focus:border-forest"
            min={0}
          />
          <span className="text-sm text-stone">syncs / month</span>
          <button
            onClick={saveTrialLimit}
            disabled={savingTrial}
            className="bg-forest text-white text-sm font-medium px-4 py-2 rounded-xl hover:bg-sage transition-colors disabled:opacity-50"
          >
            {savingTrial ? 'Saving…' : 'Save'}
          </button>
          {msg?.id === 'trial' && (
            <span className={`text-xs font-medium ${msg.ok ? 'text-forest' : 'text-red-600'}`}>{msg.text}</span>
          )}
        </div>
      </div>

      {/* Stripe webhook registration */}
      <div className="bg-white border border-forest/10 rounded-2xl p-6 mb-6">
        <div className="text-sm font-medium text-ink mb-1">Stripe billing webhook</div>
        <p className="text-xs text-stone mb-4">
          Registers the <code className="bg-cream px-1 rounded font-mono">/api/billing/webhook</code> endpoint with Stripe automatically.
          After registering, copy the signing secret into Vercel as <code className="bg-cream px-1 rounded font-mono">STRIPE_BILLING_WEBHOOK_SECRET</code>.
        </p>
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={registerWebhook}
            disabled={registeringWebhook}
            className="bg-forest text-white text-sm font-medium px-4 py-2 rounded-xl hover:bg-sage transition-colors disabled:opacity-50"
          >
            {registeringWebhook ? 'Registering…' : 'Register with Stripe'}
          </button>
          {webhookMsg && (
            <span className={`text-xs font-medium ${webhookMsg.ok ? 'text-forest' : 'text-red-600'}`}>{webhookMsg.text}</span>
          )}
        </div>
        {webhookSecret && (
          <div className="mt-4 bg-amber-50 border border-amber-200 rounded-xl p-4">
            <div className="text-xs font-semibold text-amber-800 mb-1">Signing secret — copy to Vercel now (won&apos;t be shown again)</div>
            <div className="font-mono text-xs text-amber-900 break-all select-all">{webhookSecret}</div>
          </div>
        )}
      </div>

      {/* Plans */}
      <div className="space-y-4">
        {plans.map(plan => {
          const isDraft = !!edits[plan.id] && Object.keys(edits[plan.id]).length > 0
          const isEditable = EDITABLE_PLANS.includes(plan.id)
          return (
            <div key={plan.id} className="bg-white border border-forest/10 rounded-2xl overflow-hidden">
              <div className="px-6 py-4 border-b border-forest/8 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium text-ink">{plan.name}</span>
                  {plan.stripe_price_id && (
                    <span className="text-[10px] bg-forest/8 text-forest px-2 py-0.5 rounded-full font-medium">Stripe live</span>
                  )}
                  {isDraft && (
                    <span className="text-[10px] bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5 rounded-full font-medium">Unsaved changes</span>
                  )}
                </div>
                {msg?.id === plan.id && (
                  <span className={`text-xs font-medium ${msg.ok ? 'text-forest' : 'text-red-600'}`}>{msg.text}</span>
                )}
              </div>

              <div className="p-6 grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">Monthly price (€)</label>
                  <input
                    type="number"
                    value={getVal(plan.id, 'base_price_eur', plan.base_price_eur)}
                    onChange={e => setField(plan.id, 'base_price_eur', Number(e.target.value))}
                    disabled={!isEditable}
                    className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest disabled:opacity-50"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">Sync limit</label>
                  <input
                    type="number"
                    value={getVal(plan.id, 'sync_limit', plan.sync_limit) ?? ''}
                    placeholder="Unlimited"
                    onChange={e => setField(plan.id, 'sync_limit', e.target.value ? Number(e.target.value) : null)}
                    disabled={!isEditable}
                    className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest disabled:opacity-50"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">Overage price (€/sync)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={getVal(plan.id, 'overage_price_eur', plan.overage_price_eur) ?? ''}
                    placeholder="N/A"
                    onChange={e => setField(plan.id, 'overage_price_eur', e.target.value ? Number(e.target.value) : null)}
                    disabled={!isEditable}
                    className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest disabled:opacity-50"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">Stripe Price ID</label>
                  <div className="text-xs text-stone mt-2 font-mono break-all">{plan.stripe_price_id ?? '—'}</div>
                </div>
              </div>

              {isEditable && (
                <div className="px-6 pb-5 flex items-center gap-3 flex-wrap">
                  {isDraft && (
                    <>
                      <button
                        onClick={() => savePlan(plan, false)}
                        disabled={saving === plan.id}
                        className="bg-forest text-white text-sm font-medium px-4 py-2 rounded-xl hover:bg-sage transition-colors disabled:opacity-40"
                      >
                        {saving === plan.id ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        onClick={() => savePlan(plan, true)}
                        disabled={saving === plan.id}
                        className="border border-forest text-forest text-sm font-medium px-4 py-2 rounded-xl hover:bg-forest/5 transition-colors disabled:opacity-40"
                      >
                        Save & Push to Stripe
                      </button>
                      <button
                        onClick={() => setEdits(prev => { const n = { ...prev }; delete n[plan.id]; return n })}
                        className="text-xs text-stone hover:text-ink transition-colors"
                      >
                        Discard
                      </button>
                    </>
                  )}
                  {!isDraft && !plan.stripe_price_id && (
                    <button
                      onClick={() => savePlan(plan, true)}
                      disabled={saving === plan.id}
                      className="border border-forest text-forest text-sm font-medium px-4 py-2 rounded-xl hover:bg-forest/5 transition-colors disabled:opacity-40"
                    >
                      {saving === plan.id ? 'Pushing…' : 'Push to Stripe →'}
                    </button>
                  )}
                  {plan.stripe_price_id && !isDraft && (
                    <span className="text-xs text-stone/60">No unsaved changes</span>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
