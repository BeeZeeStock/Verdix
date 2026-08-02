import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { supabaseServer } from '@/lib/supabase'
import { getOrgSubscription } from '@/lib/billing'
import { getActiveOrg } from '@/lib/org'

const PLAN_ALIAS: Record<string, string> = { free: 'trial', payg: 'core', scale: 'pro' }

async function getLiveCheckoutActive(): Promise<boolean> {
  const { data } = await supabaseServer
    .from('verdix_settings')
    .select('value')
    .eq('key', 'live_checkout_active')
    .maybeSingle()
  return (data?.value as string) === 'true'
}

function buildStripe(key: string) {
  const Stripe = require('stripe')
  return new Stripe(key, { apiVersion: '2026-06-24.dahlia' })
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
    try {
      await stripe.customers.retrieve(existingId)
      return existingId
    } catch {
      // Customer doesn't exist in this Stripe account — create fresh below
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

    const [{ data: plan }, liveActive] = await Promise.all([
      supabaseServer
        .from('verdix_plans')
        .select('stripe_price_id_test, stripe_price_id_live, stripe_price_id, name, overage_price_eur, base_price_eur')
        .eq('id', planId)
        .maybeSingle(),
      getLiveCheckoutActive(),
    ])

    // Key is always chosen by live_checkout_active — not by whether env-specific prices exist.
    // This ensures the toggle actually switches Stripe accounts.
    const stripeKey = liveActive
      ? (process.env.STRIPE_SECRET_KEY_LIVE ?? process.env.STRIPE_SECRET_KEY)
      : (process.env.STRIPE_SECRET_KEY_TEST ?? process.env.STRIPE_SECRET_KEY)

    if (!stripeKey) throw new Error('Missing Stripe key. Set STRIPE_SECRET_KEY in environment.')

    // If live checkout is active but only a test key is available, warn clearly.
    if (liveActive && stripeKey?.startsWith('sk_test_')) {
      console.error('[billing/checkout] Live checkout active but STRIPE_SECRET_KEY_LIVE not set — falling back to test key.')
      return NextResponse.json({
        error: 'Checkout is temporarily unavailable. Please contact support.',
      }, { status: 400 })
    }

    const stripe = buildStripe(stripeKey)

    // Prefer env-specific price (post-migration); fall back to legacy only in sandbox mode.
    // In live mode we never use the legacy test price — it won't exist in the live account.
    const envPriceId = liveActive ? plan?.stripe_price_id_live : plan?.stripe_price_id_test
    const priceId = envPriceId ?? (liveActive ? null : plan?.stripe_price_id)

    if (!priceId) {
      console.error(`[billing/checkout] No Stripe price for plan "${planId}" in ${liveActive ? 'live' : 'sandbox'} mode. Admin needs to push plans from Admin → Billing.`)
      return NextResponse.json({
        error: 'This plan is temporarily unavailable. Please contact support.',
      }, { status: 400 })
    }

    const sub = await getOrgSubscription(org.orgId)

    // ── Upgrade path (existing active subscription in this Stripe account) ──────
    // Only attempt upgrade if the subscription actually exists in the current
    // Stripe account. A test subscription ID won't exist in the live account.
    let useNewCheckout = true
    if (sub.stripe_subscription_id && ['active', 'trialing'].includes(sub.status ?? '')) {
      try {
        const existing = await stripe.subscriptions.retrieve(sub.stripe_subscription_id, {
          expand: ['items'],
        })

        const toDelete = existing.items.data
          .filter((item: { price: { id: string } }) => item.price.id !== priceId)
          .map((item: { id: string }) => ({ id: item.id, deleted: true as const }))

        const alreadyHasPlan = existing.items.data.some((item: { price: { id: string } }) => item.price.id === priceId)
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
      } catch (err) {
        // Subscription not found in this Stripe account (e.g. test sub in live mode).
        // Fall through to create a fresh checkout session.
        console.warn('[billing/checkout] Subscription not in this Stripe account, using new checkout:', err instanceof Error ? err.message : err)
        useNewCheckout = true
      }
    }
    void useNewCheckout

    // ── New subscription ───────────────────────────────────────────────────────
    const customerId = await resolveCustomer(stripe, org.orgId, org.orgName, session.user.email)
    const base = returnUrl ?? `${process.env.AUTH_URL || process.env.NEXTAUTH_URL || 'https://lynoraai.com'}/settings/billing`

    // For pay-as-you-go plans (€0 base, overage per agreement), show a note
    // in the checkout so customers understand how they'll be billed.
    const isPayg = !plan?.base_price_eur && plan?.overage_price_eur
    const overageNote = isPayg
      ? `€${plan.overage_price_eur} per agreement processed, billed monthly in arrears based on usage.`
      : undefined

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
      ...(overageNote ? {
        custom_text: {
          submit: { message: overageNote },
        },
      } : {}),
    })

    return NextResponse.json({ url: checkoutSession.url })
  } catch (err) {
    console.error('[billing/checkout]', err)
    const message = err instanceof Error ? err.message : 'Unexpected error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
