import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getActiveOrg } from '@/lib/org'
import { supabaseServer } from '@/lib/supabase'
import { getOrgSubscription } from '@/lib/billing'

// POST /api/billing/pii-addon
// Body: { enable: boolean }
// For paid plans: adds/removes a Stripe subscription item for the PII add-on
// Billed for the full month regardless of when enabled
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
    return NextResponse.json({ ok: true, billed: false })
  }

  // Core/Pro: manage via Stripe subscription item
  if (sub.stripe_subscription_id) {
    const { data: piiPlan } = await supabaseServer
      .from('verdix_plans')
      .select('stripe_price_id')
      .eq('id', 'pii_addon')
      .maybeSingle()

    if (piiPlan?.stripe_price_id && sub.stripe_subscription_id) {
      const { default: Stripe } = await import('stripe')
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-06-24.dahlia' })

      const subscription = await stripe.subscriptions.retrieve(sub.stripe_subscription_id)
      const existingItem = subscription.items.data.find(i => i.price.id === piiPlan.stripe_price_id)

      if (enable && !existingItem) {
        await stripe.subscriptionItems.create({
          subscription: sub.stripe_subscription_id,
          price: piiPlan.stripe_price_id,
          quantity: 1,
          // Bill for the full month from the start of current period
          billing_thresholds: undefined,
          proration_behavior: 'none',
        })
      } else if (!enable && existingItem) {
        await stripe.subscriptionItems.del(existingItem.id, { proration_behavior: 'none' })
      }
    }
  }

  await supabaseServer.from('org_subscriptions').update({
    pii_addon_enabled: enable,
    pii_addon_enabled_at: enable ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  }).eq('org_id', org.orgId)

  return NextResponse.json({ ok: true, billed: !!sub.stripe_subscription_id })
}
