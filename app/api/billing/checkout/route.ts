import { NextRequest, NextResponse } from 'next/server'
import { getBillingMode } from '@/lib/stripe-verdix'
import { auth } from '@/lib/auth'
import { supabaseServer } from '@/lib/supabase'
import { getOrgSubscription } from '@/lib/billing'
import { getActiveOrg } from '@/lib/org'

const PLAN_ALIAS: Record<string, string> = { free: 'trial', payg: 'core', scale: 'pro' }

async function getStripeForCheckout() {
  // Live checkout is controlled by a separate setting from the push environment.
  // live_checkout_active must be explicitly 'true' to charge real money.
  const { data: setting } = await supabaseServer
    .from('verdix_settings')
    .select('value')
    .eq('key', 'live_checkout_active')
    .maybeSingle()

  const liveActive = (setting?.value as string) === 'true'
  const { default: Stripe } = await import('stripe')

  const key = liveActive
    ? (process.env.STRIPE_SECRET_KEY_LIVE ?? process.env.STRIPE_SECRET_KEY)
    : (process.env.STRIPE_SECRET_KEY_TEST ?? process.env.STRIPE_SECRET_KEY)

  if (!key) throw new Error('Missing Stripe key. Set STRIPE_SECRET_KEY in environment.')
  return { stripe: new Stripe(key, { apiVersion: '2026-06-24.dahlia' }), liveActive }
}

async function resolveCustomer(
  stripe: import('stripe').default,
  orgId: string,
  orgName: string,
  email: string,
): Promise<string> {
  const { data: sub } = await supabaseServer
    .from('org_subscriptions')
    .select('stripe_customer_id')
    .eq('org_id', orgId)
    .maybeSingle()

  const existingId = sub?.stripe_customer_id as string | null

  if (existingId) {
    // Verify the customer exists in the current Stripe account
    try {
      await stripe.customers.retrieve(existingId)
      return existingId
    } catch {
      // Customer belongs to a different Stripe account — create fresh
    }
  }

  const customer = await stripe.customers.create({
    name: orgName,
    email,
    metadata: { verdix_org_id: orgId },
  })

  await supabaseServer
    .from('org_subscriptions')
    .update({ stripe_customer_id: customer.id, updated_at: new Date().toISOString() })
    .eq('org_id', orgId)

  return customer.id
}

export async function POST(req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const org = await getActiveOrg()
    if (!org) return NextResponse.json({ error: 'No organisation' }, { status: 400 })

    const { planId: rawPlanId, returnUrl } = await req.json() as {
      planId: string
      returnUrl?: string
    }

    const planId = PLAN_ALIAS[rawPlanId] ?? rawPlanId
    if (!['core', 'pro'].includes(planId)) {
      return NextResponse.json({ error: 'Invalid plan' }, { status: 400 })
    }

    const [{ data: plan }, { stripe, liveActive }, mode] = await Promise.all([
      supabaseServer
        .from('verdix_plans')
        .select('stripe_price_id_test, stripe_price_id_live, stripe_price_id, name')
        .eq('id', planId)
        .maybeSingle(),
      getStripeForCheckout(),
      getBillingMode(),
    ])

    // Prefer env-specific price (post-migration); fall back to legacy column
    const modeSpecificPriceId = liveActive ? plan?.stripe_price_id_live : plan?.stripe_price_id_test
    const priceId = modeSpecificPriceId ?? plan?.stripe_price_id
    if (!priceId) {
      return NextResponse.json({
        error: `Plan not yet pushed to Stripe ${liveActive ? 'live' : 'sandbox'}. Go to Admin → Billing and push the plan.`,
      }, { status: 400 })
    }

    const sub = await getOrgSubscription(org.orgId)

    // ── Upgrade path ──────────────────────────────────────────────────────────
    if (sub.stripe_subscription_id && ['active', 'trialing'].includes(sub.status ?? '')) {
      const existing = await stripe.subscriptions.retrieve(sub.stripe_subscription_id, {
        expand: ['items'],
      })

      const toDelete = existing.items.data
        .filter(item => item.price.id !== priceId)
        .map(item => ({ id: item.id, deleted: true as const }))

      const alreadyHasPlan = existing.items.data.some(item => item.price.id === priceId)
      const toAdd = alreadyHasPlan ? [] : [{ price: priceId, quantity: 1 }]

      await stripe.subscriptions.update(sub.stripe_subscription_id, {
        items: [...toDelete, ...toAdd],
        proration_behavior: 'create_prorations',
        metadata: { verdix_org_id: org.orgId, verdix_plan_id: planId },
      })

      await supabaseServer
        .from('org_subscriptions')
        .update({ plan_id: planId, updated_at: new Date().toISOString() })
        .eq('org_id', org.orgId)

      return NextResponse.json({ upgraded: true })
    }

    // ── New subscription ──────────────────────────────────────────────────────
    const customerId = await resolveCustomer(stripe, org.orgId, org.orgName, session.user.email)
    const base = returnUrl ?? `${process.env.AUTH_URL || process.env.NEXTAUTH_URL || 'https://lynoraai.com'}/settings/billing`

    const checkoutSession = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${base}?upgraded=1`,
      cancel_url:  `${base}?cancelled=1`,
      metadata: { verdix_org_id: org.orgId, verdix_plan_id: planId },
      subscription_data: {
        metadata: { verdix_org_id: org.orgId, verdix_plan_id: planId },
      },
      allow_promotion_codes: true,
    })

    return NextResponse.json({ url: checkoutSession.url })
  } catch (err) {
    console.error('[billing/checkout]', err)
    const message = err instanceof Error ? err.message : 'Unexpected error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
