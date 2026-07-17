import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getActiveOrg } from '@/lib/org'
import { supabaseServer } from '@/lib/supabase'
import { getOrgSubscription } from '@/lib/billing'

// POST /api/billing/pii-addon
// Body: { enable: boolean }
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const org = await getActiveOrg()
  if (!org) return NextResponse.json({ error: 'No organisation' }, { status: 400 })

  const { enable } = await req.json() as { enable: boolean }

  const sub = await getOrgSubscription(org.orgId)

  if (!['core', 'pro', 'enterprise'].includes(sub.plan_id)) {
    return NextResponse.json({ error: 'PII add-on requires Core, Pro, or Enterprise plan' }, { status: 400 })
  }

  // Enterprise: PII is included, just toggle the flag
  if (sub.plan_id === 'enterprise') {
    await supabaseServer.from('org_subscriptions').update({
      pii_addon_enabled: enable,
      pii_addon_enabled_at: enable ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    }).eq('org_id', org.orgId)
    return NextResponse.json({ ok: true, stripeUpdated: false })
  }

  // Core/Pro: manage via Stripe subscription item
  const { data: piiPlan } = await supabaseServer
    .from('verdix_plans')
    .select('stripe_price_id')
    .eq('id', 'pii_addon')
    .maybeSingle()

  if (!piiPlan?.stripe_price_id) {
    return NextResponse.json({ error: 'PII add-on not yet configured in Stripe. Ask admin to push it.' }, { status: 400 })
  }

  if (!sub.stripe_customer_id) {
    return NextResponse.json({ error: 'No Stripe customer found. Please contact support.' }, { status: 400 })
  }

  const { default: Stripe } = await import('stripe')
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-06-24.dahlia' })

  // Resolve the active subscription ID — the stored one may be stale if the
  // user upgraded via Checkout (which creates a new subscription) before the
  // in-place upgrade fix was deployed.
  let activeSubId = sub.stripe_subscription_id

  if (activeSubId) {
    try {
      const stored = await stripe.subscriptions.retrieve(activeSubId)
      if (!['active', 'trialing'].includes(stored.status)) {
        activeSubId = null // stored ID is cancelled/inactive, find the real one
      }
    } catch {
      activeSubId = null
    }
  }

  // Fall back: find the customer's active subscription in Stripe
  if (!activeSubId) {
    const list = await stripe.subscriptions.list({
      customer: sub.stripe_customer_id,
      status: 'active',
      limit: 10,
    })
    const match = list.data.find(s =>
      s.items.data.some(i =>
        i.price.metadata?.verdix_plan === sub.plan_id ||
        i.price.id !== piiPlan.stripe_price_id // any non-PII item = main plan
      )
    )
    if (match) {
      activeSubId = match.id
      // Sync the correct ID back to Supabase
      await supabaseServer
        .from('org_subscriptions')
        .update({ stripe_subscription_id: activeSubId, updated_at: new Date().toISOString() })
        .eq('org_id', org.orgId)
    }
  }

  if (!activeSubId) {
    return NextResponse.json({ error: 'No active subscription found in Stripe. Please contact support.' }, { status: 400 })
  }

  try {
    const activeSub = await stripe.subscriptions.retrieve(activeSubId)
    const existingItem = activeSub.items.data.find(i => i.price.id === piiPlan.stripe_price_id)

    if (enable && !existingItem) {
      await stripe.subscriptionItems.create({
        subscription: activeSubId,
        price: piiPlan.stripe_price_id,
        quantity: 1,
        proration_behavior: 'none',
      })
    } else if (!enable && existingItem) {
      await stripe.subscriptionItems.del(existingItem.id, { proration_behavior: 'none' })
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Stripe error'
    return NextResponse.json({ error: `Failed to update Stripe subscription: ${msg}` }, { status: 500 })
  }

  await supabaseServer.from('org_subscriptions').update({
    pii_addon_enabled: enable,
    pii_addon_enabled_at: enable ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  }).eq('org_id', org.orgId)

  return NextResponse.json({ ok: true, stripeUpdated: true })
}
