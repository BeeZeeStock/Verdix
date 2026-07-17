import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { supabaseServer } from '@/lib/supabase'
import { getOrgSubscription, getOrCreateStripeCustomer } from '@/lib/billing'
import { getActiveOrg } from '@/lib/org'

// POST /api/billing/checkout
// Body: { planId: 'core' | 'pro', includePiiAddon?: boolean, returnUrl?: string }
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const org = await getActiveOrg()
  if (!org) return NextResponse.json({ error: 'No organisation' }, { status: 400 })

  const { planId, includePiiAddon, returnUrl } = await req.json() as {
    planId: string
    includePiiAddon?: boolean
    returnUrl?: string
  }

  if (!['core', 'pro'].includes(planId)) {
    return NextResponse.json({ error: 'Invalid plan' }, { status: 400 })
  }

  // Fetch the plan's Stripe price
  const { data: plan } = await supabaseServer
    .from('verdix_plans')
    .select('stripe_price_id, name')
    .eq('id', planId)
    .maybeSingle()

  if (!plan?.stripe_price_id) {
    return NextResponse.json({ error: 'Plan not yet pushed to Stripe. Ask admin to push.' }, { status: 400 })
  }

  // Fetch PII add-on price if requested
  let piiPriceId: string | null = null
  if (includePiiAddon) {
    const { data: piiPlan } = await supabaseServer
      .from('verdix_plans')
      .select('stripe_price_id')
      .eq('id', 'pii_addon')
      .maybeSingle()
    piiPriceId = piiPlan?.stripe_price_id ?? null
  }

  const { default: Stripe } = await import('stripe')
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-06-24.dahlia' })

  const sub = await getOrgSubscription(org.orgId)

  // ── Upgrade path: org already has an active subscription ──────────────────
  if (sub.stripe_subscription_id && ['active', 'trialing'].includes(sub.status ?? '')) {
    const existing = await stripe.subscriptions.retrieve(sub.stripe_subscription_id, {
      expand: ['items'],
    })

    // Build the new set of prices
    const wantedPrices = new Set([plan.stripe_price_id, ...(piiPriceId ? [piiPriceId] : [])])

    // Items to delete (prices no longer wanted)
    const toDelete = existing.items.data
      .filter(item => !wantedPrices.has(item.price.id))
      .map(item => ({ id: item.id, deleted: true as const }))

    // Items to keep or add
    const toKeep = existing.items.data
      .filter(item => wantedPrices.has(item.price.id))
      .map(item => ({ id: item.id, price: item.price.id, quantity: 1 }))

    const existingPrices = new Set(existing.items.data.map(item => item.price.id))
    const toAdd = [...wantedPrices]
      .filter(priceId => !existingPrices.has(priceId))
      .map(priceId => ({ price: priceId, quantity: 1 }))

    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      items: [...toDelete, ...toKeep, ...toAdd],
      proration_behavior: 'create_prorations',
      metadata: { verdix_org_id: org.orgId, verdix_plan_id: planId },
    })

    // Update Supabase immediately so the UI reflects the new plan
    await supabaseServer
      .from('org_subscriptions')
      .update({
        plan_id: planId,
        pii_addon_enabled: !!piiPriceId,
        updated_at: new Date().toISOString(),
      })
      .eq('org_id', org.orgId)

    return NextResponse.json({ upgraded: true })
  }

  // ── New subscription path: no active subscription yet ─────────────────────
  const customerId = await getOrCreateStripeCustomer(org.orgId, org.orgName, session.user.email)

  const base = returnUrl ?? `${process.env.AUTH_URL || process.env.NEXTAUTH_URL || 'https://lynoraai.com'}/settings/billing`

  const lineItems: { price: string; quantity: number }[] = [{ price: plan.stripe_price_id, quantity: 1 }]
  if (piiPriceId) lineItems.push({ price: piiPriceId, quantity: 1 })

  const checkoutSession = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: lineItems,
    success_url: `${base}?upgraded=1`,
    cancel_url:  `${base}?cancelled=1`,
    metadata: { verdix_org_id: org.orgId, verdix_plan_id: planId },
    subscription_data: {
      metadata: { verdix_org_id: org.orgId, verdix_plan_id: planId },
    },
    allow_promotion_codes: true,
  })

  return NextResponse.json({ url: checkoutSession.url })
}
