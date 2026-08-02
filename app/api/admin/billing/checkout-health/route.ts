import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin'
import { supabaseServer } from '@/lib/supabase'

// GET /api/admin/billing/checkout-health
// Returns a diagnostic summary of live checkout readiness — admin only.
export async function GET() {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }

  const [{ data: settings }, { data: plans }] = await Promise.all([
    supabaseServer.from('verdix_settings').select('key, value'),
    supabaseServer.from('verdix_plans').select('id, name, stripe_price_id, stripe_price_id_test, stripe_price_id_live').in('id', ['core', 'pro']),
  ])

  const get = (key: string) => settings?.find(s => s.key === key)?.value

  const liveCheckoutActive = (get('live_checkout_active') as string) === 'true'
  const billingMode = (get('billing_mode') as string) ?? 'test'

  const hasLiveKey = !!(process.env.STRIPE_SECRET_KEY_LIVE)
  const liveKeyIsLive = process.env.STRIPE_SECRET_KEY_LIVE?.startsWith('sk_live_') ?? false

  const planStatus = (plans ?? []).map(p => ({
    id: p.id,
    name: p.name,
    hasSandboxPrice: !!(p.stripe_price_id_test ?? p.stripe_price_id),
    hasLivePrice: !!(p.stripe_price_id_live),
  }))

  const issues: string[] = []
  if (liveCheckoutActive && !hasLiveKey) issues.push('STRIPE_SECRET_KEY_LIVE is not set in environment')
  if (liveCheckoutActive && hasLiveKey && !liveKeyIsLive) issues.push('STRIPE_SECRET_KEY_LIVE does not start with sk_live_ — it may be a test key')
  for (const p of planStatus) {
    if (liveCheckoutActive && !p.hasLivePrice) issues.push(`Plan "${p.name}" has no live Stripe price — push it from Admin → Billing with Push environment set to Live`)
  }

  return NextResponse.json({ liveCheckoutActive, billingMode, hasLiveKey, liveKeyIsLive, planStatus, issues, ready: issues.length === 0 })
}
