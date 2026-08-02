import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin'
import { supabaseServer } from '@/lib/supabase'

export async function GET() {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }

  const [{ data: settings }, { data: plans }] = await Promise.all([
    supabaseServer.from('verdix_settings').select('key, value'),
    supabaseServer.from('verdix_plans')
      .select('id, name, stripe_price_id, stripe_price_id_test, stripe_price_id_live')
      .in('id', ['core', 'pro']),
  ])

  const get = (key: string) => settings?.find(s => s.key === key)?.value
  const liveCheckoutActive = (get('live_checkout_active') as string) === 'true'
  const billingMode = (get('billing_mode') as string) ?? 'test'
  const liveKey = process.env.STRIPE_SECRET_KEY_LIVE
  const hasLiveKey = !!liveKey
  const liveKeyIsLive = liveKey?.startsWith('sk_live_') ?? false

  const issues: string[] = []

  if (liveCheckoutActive && !hasLiveKey) {
    issues.push('STRIPE_SECRET_KEY_LIVE is not set in environment variables')
  }
  if (liveCheckoutActive && hasLiveKey && !liveKeyIsLive) {
    issues.push('STRIPE_SECRET_KEY_LIVE does not start with sk_live_ — it appears to be a test key')
  }

  type PlanStatus = {
    id: string
    name: string
    hasSandboxPrice: boolean
    hasLivePrice: boolean
    livePriceValid: boolean | null
    livePriceId: string | null
  }

  const planStatus: PlanStatus[] = (plans ?? []).map(p => ({
    id: p.id,
    name: p.name,
    hasSandboxPrice: !!(p.stripe_price_id_test ?? p.stripe_price_id),
    hasLivePrice: !!(p.stripe_price_id_live),
    livePriceValid: null,
    livePriceId: p.stripe_price_id_live ?? null,
  }))

  // Verify each live price ID actually exists in live Stripe
  if (liveCheckoutActive && liveKeyIsLive && liveKey) {
    const { default: Stripe } = await import('stripe')
    const stripe = new Stripe(liveKey, { apiVersion: '2026-06-24.dahlia' })

    for (const p of planStatus) {
      if (!p.livePriceId) {
        issues.push(`Plan "${p.name}" has no live Stripe price — switch Push environment to Live and push the plan`)
        p.livePriceValid = false
        continue
      }
      try {
        await stripe.prices.retrieve(p.livePriceId)
        p.livePriceValid = true
      } catch {
        p.livePriceValid = false
        issues.push(`Plan "${p.name}" live price ID (${p.livePriceId}) is not found in your live Stripe account — it was likely pushed using a test key. Switch Push environment to Live and push the plan again.`)
      }
    }
  } else if (liveCheckoutActive) {
    for (const p of planStatus) {
      if (!p.livePriceId) {
        issues.push(`Plan "${p.name}" has no live Stripe price — switch Push environment to Live and push the plan`)
      }
    }
  }

  return NextResponse.json({
    liveCheckoutActive,
    billingMode,
    hasLiveKey,
    liveKeyIsLive,
    planStatus,
    issues,
    ready: issues.length === 0,
  })
}
