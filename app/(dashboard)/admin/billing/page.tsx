'use client'

import { useEffect, useState } from 'react'

type BillingCycle = { cycle: 'monthly' | 'quarterly' | 'yearly'; price_eur: number }

type Plan = {
  id: string
  name: string
  base_price_eur: number
  sync_limit: number | null
  overage_price_eur: number | null
  pii_addon_available: boolean
  stripe_product_id: string | null
  stripe_price_id: string | null
  stripe_cycle_prices: Record<string, string>
  billing_cycles: BillingCycle[]
  sort_order: number
}

type Setting = { key: string; value: number | string }

const EDITABLE_PLANS = ['core', 'pro', 'pii_addon']
const ALL_CYCLES: Array<{ cycle: BillingCycle['cycle']; label: string; stripeDesc: string }> = [
  { cycle: 'monthly',   label: 'Monthly',   stripeDesc: 'every month' },
  { cycle: 'quarterly', label: 'Quarterly', stripeDesc: 'every 3 months' },
  { cycle: 'yearly',    label: 'Yearly',    stripeDesc: 'every year' },
]

export default function AdminBillingPage() {
  const [plans, setPlans]           = useState<Plan[]>([])
  const [settings, setSettings]     = useState<Setting[]>([])
  const [loading, setLoading]       = useState(true)
  const [saving, setSaving]         = useState<string | null>(null)
  const [msg, setMsg]               = useState<{ id: string; ok: boolean; text: string } | null>(null)
  const [edits, setEdits]           = useState<Record<string, Partial<Plan>>>({})
  const [cycleEdits, setCycleEdits] = useState<Record<string, Record<string, number>>>({})
  const [trialLimit, setTrialLimit] = useState('')
  const [savingTrial, setSavingTrial] = useState(false)
  const [webhookSecret, setWebhookSecret] = useState<string | null>(null)
  const [registeringWebhook, setRegisteringWebhook] = useState(false)
  const [webhookMsg, setWebhookMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [pushingCycle, setPushingCycle] = useState<string | null>(null)

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
    ((edits[planId]?.[field]) as Plan[K]) ?? fallback

  const getCyclePrice = (planId: string, plan: Plan, cycle: string): number => {
    if (cycleEdits[planId]?.[cycle] !== undefined) return cycleEdits[planId][cycle]
    return (plan.billing_cycles ?? []).find(c => c.cycle === cycle)?.price_eur ?? 0
  }

  const setCyclePrice = (planId: string, cycle: string, value: number) =>
    setCycleEdits(prev => ({ ...prev, [planId]: { ...prev[planId], [cycle]: value } }))

  const cyclesForSave = (planId: string, plan: Plan): BillingCycle[] => {
    const base = [...(plan.billing_cycles ?? [])]
    const editsForPlan = cycleEdits[planId] ?? {}
    for (const [cycle, price_eur] of Object.entries(editsForPlan)) {
      const idx = base.findIndex(c => c.cycle === cycle)
      if (idx >= 0) base[idx] = { ...base[idx], price_eur }
      else base.push({ cycle: cycle as BillingCycle['cycle'], price_eur })
    }
    return base.filter(c => c.price_eur > 0)
  }

  const addCycle = (planId: string, plan: Plan, cycle: BillingCycle['cycle']) => {
    const existing = (plan.billing_cycles ?? []).find(c => c.cycle === cycle)
    if (!existing) {
      setCyclePrice(planId, cycle, 0)
    }
  }

  const savePlan = async (plan: Plan, pushToStripe: boolean) => {
    setSaving(plan.id)
    setMsg(null)
    const billing_cycles = cyclesForSave(plan.id, plan)
    const patch = {
      id: plan.id, pushToStripe,
      name: plan.name,
      base_price_eur: plan.base_price_eur,
      billing_cycles,
      ...edits[plan.id],
    }
    const res = await fetch('/api/admin/billing', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
    const data = await res.json()
    if (res.ok) {
      setPlans(prev => prev.map(p => p.id === plan.id ? { ...p, ...data.plan } : p))
      setEdits(prev => { const n = { ...prev }; delete n[plan.id]; return n })
      setCycleEdits(prev => { const n = { ...prev }; delete n[plan.id]; return n })
      setMsg({ id: plan.id, ok: true, text: pushToStripe ? 'Saved & pushed monthly to Stripe ✓' : 'Saved ✓' })
    } else {
      setMsg({ id: plan.id, ok: false, text: data.error ?? 'Error' })
    }
    setSaving(null)
  }

  const pushCycleToStripe = async (plan: Plan, cycle: BillingCycle['cycle']) => {
    const key = `${plan.id}:${cycle}`
    setPushingCycle(key)
    setMsg(null)
    const billing_cycles = cyclesForSave(plan.id, plan)
    const res = await fetch('/api/admin/billing', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: plan.id, pushCycle: cycle, billing_cycles, name: plan.name }),
    })
    const data = await res.json()
    if (res.ok) {
      setPlans(prev => prev.map(p => p.id === plan.id ? { ...p, ...data.plan } : p))
      setMsg({ id: plan.id, ok: true, text: `${cycle} price pushed to Stripe ✓` })
    } else {
      setMsg({ id: plan.id, ok: false, text: data.error ?? 'Error' })
    }
    setPushingCycle(null)
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
        <p className="text-stone text-sm">Manage Verdix SaaS pricing tiers, billing cycles, and push to Stripe</p>
      </div>

      {/* Trial global limit */}
      <div className="bg-white border border-forest/10 rounded-2xl p-6 mb-6">
        <div className="text-sm font-medium text-ink mb-1">Global trial sync limit</div>
        <p className="text-xs text-stone mb-4">Default max agreement syncs for all Trial accounts.</p>
        <div className="flex items-center gap-3">
          <input
            type="number" value={trialLimit}
            onChange={e => setTrialLimit(e.target.value)}
            className="w-28 bg-cream border border-forest/15 rounded-xl px-4 py-2.5 text-sm text-ink outline-none focus:border-forest"
            min={0}
          />
          <span className="text-sm text-stone">syncs / month</span>
          <button onClick={saveTrialLimit} disabled={savingTrial}
            className="bg-forest text-white text-sm font-medium px-4 py-2 rounded-xl hover:bg-sage transition-colors disabled:opacity-50">
            {savingTrial ? 'Saving…' : 'Save'}
          </button>
          {msg?.id === 'trial' && (
            <span className={`text-xs font-medium ${msg.ok ? 'text-forest' : 'text-red-600'}`}>{msg.text}</span>
          )}
        </div>
      </div>

      {/* Stripe webhook */}
      <div className="bg-white border border-forest/10 rounded-2xl p-6 mb-6">
        <div className="text-sm font-medium text-ink mb-1">Stripe billing webhook</div>
        <p className="text-xs text-stone mb-4">
          Registers <code className="bg-cream px-1 rounded font-mono">/api/billing/webhook</code> with Stripe.
          Copy the secret to Vercel as <code className="bg-cream px-1 rounded font-mono">STRIPE_BILLING_WEBHOOK_SECRET</code>.
        </p>
        <div className="flex items-center gap-3 flex-wrap">
          <button onClick={registerWebhook} disabled={registeringWebhook}
            className="bg-forest text-white text-sm font-medium px-4 py-2 rounded-xl hover:bg-sage transition-colors disabled:opacity-50">
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
          const isEditable = EDITABLE_PLANS.includes(plan.id)
          const hasCycleEdits = Object.keys(cycleEdits[plan.id] ?? {}).length > 0
          const hasFieldEdits = !!edits[plan.id] && Object.keys(edits[plan.id]).length > 0
          const isDraft = hasCycleEdits || hasFieldEdits
          const activeCycles = cyclesForSave(plan.id, plan)

          return (
            <div key={plan.id} className="bg-white border border-forest/10 rounded-2xl overflow-hidden">
              {/* Plan header */}
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

              {/* Core plan fields */}
              <div className="p-6 grid grid-cols-2 md:grid-cols-3 gap-4 border-b border-forest/6">
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
                    type="number" step="0.01"
                    value={getVal(plan.id, 'overage_price_eur', plan.overage_price_eur) ?? ''}
                    placeholder="N/A"
                    onChange={e => setField(plan.id, 'overage_price_eur', e.target.value ? Number(e.target.value) : null)}
                    disabled={!isEditable}
                    className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest disabled:opacity-50"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">Stripe Product ID</label>
                  <div className="text-xs text-stone mt-2 font-mono break-all">{plan.stripe_product_id ?? '—'}</div>
                </div>
              </div>

              {/* Billing cycles */}
              {isEditable && (
                <div className="p-6">
                  <div className="flex items-center justify-between mb-3">
                    <div className="text-[10px] font-semibold text-stone uppercase tracking-widest">Billing cycles & pricing</div>
                    <div className="flex items-center gap-1.5">
                      {ALL_CYCLES.filter(ac => !activeCycles.find(c => c.cycle === ac.cycle)).map(ac => (
                        <button
                          key={ac.cycle}
                          onClick={() => addCycle(plan.id, plan, ac.cycle)}
                          className="text-[10px] border border-forest/20 text-forest px-2 py-0.5 rounded-lg hover:bg-forest/5 transition-colors"
                        >
                          + {ac.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2">
                    {ALL_CYCLES.filter(ac =>
                      activeCycles.find(c => c.cycle === ac.cycle) ||
                      cycleEdits[plan.id]?.[ac.cycle] !== undefined
                    ).map(ac => {
                      const price = getCyclePrice(plan.id, plan, ac.cycle)
                      const stripeId = (plan.stripe_cycle_prices ?? {})[ac.cycle]
                      const pushKey = `${plan.id}:${ac.cycle}`
                      const isPushing = pushingCycle === pushKey

                      return (
                        <div key={ac.cycle} className="flex items-center gap-3 bg-cream/60 rounded-xl px-4 py-2.5">
                          <div className="w-24 flex-shrink-0">
                            <span className="text-xs font-medium text-ink">{ac.label}</span>
                            <div className="text-[9px] text-stone">{ac.stripeDesc}</div>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs text-stone">€</span>
                            <input
                              type="number" step="0.01" min={0}
                              value={price || ''}
                              placeholder="0"
                              onChange={e => setCyclePrice(plan.id, ac.cycle, Number(e.target.value))}
                              className="w-24 bg-white border border-forest/15 rounded-lg px-2.5 py-1.5 text-sm text-ink outline-none focus:border-forest"
                            />
                          </div>
                          <div className="flex-1 min-w-0">
                            {stripeId ? (
                              <span className="text-[10px] font-mono text-stone/60 truncate block">{stripeId}</span>
                            ) : (
                              <span className="text-[10px] text-stone/40">Not in Stripe</span>
                            )}
                          </div>
                          <button
                            onClick={() => pushCycleToStripe(plan, ac.cycle)}
                            disabled={isPushing || price <= 0}
                            className="text-[10px] font-medium border border-forest text-forest px-3 py-1 rounded-lg hover:bg-forest/5 transition-colors disabled:opacity-40 flex-shrink-0"
                          >
                            {isPushing ? 'Pushing…' : stripeId ? 'Update in Stripe' : 'Push to Stripe →'}
                          </button>
                        </div>
                      )
                    })}

                    {activeCycles.length === 0 && !Object.keys(cycleEdits[plan.id] ?? {}).length && (
                      <p className="text-xs text-stone/50 italic">No billing cycles configured — click + Monthly / + Quarterly / + Yearly above to add one.</p>
                    )}
                  </div>
                </div>
              )}

              {/* Plan actions */}
              {isEditable && (
                <div className="px-6 pb-5 flex items-center gap-3 flex-wrap border-t border-forest/6 pt-4">
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
                        Save & push monthly to Stripe
                      </button>
                      <button
                        onClick={() => {
                          setEdits(prev => { const n = { ...prev }; delete n[plan.id]; return n })
                          setCycleEdits(prev => { const n = { ...prev }; delete n[plan.id]; return n })
                        }}
                        className="text-xs text-stone hover:text-ink transition-colors"
                      >
                        Discard
                      </button>
                    </>
                  )}
                  {!isDraft && (
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
