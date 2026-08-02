import { NextRequest, NextResponse } from 'next/server'
import { getVerdixStripe, getBillingMode } from '@/lib/stripe-verdix'
import { auth } from '@/lib/auth'
import { supabaseServer } from '@/lib/supabase'
import { getOrgSubscription, getOrCreateStripeCustomer } from '@/lib/billing'
import { getActiveOrg } from '@/lib/org'

// Alias new marketing plan IDs to DB plan IDs (DB IDs unchanged for Stripe compatibility)
const PLAN_ALIAS: Record<string, string> = { free: 'trial', payg: 'core', scale: 'pro' }

// POST /api/billing/checkout
// Body: { planId: 'payg' | 'scale' | 'core' | 'pro', returnUrl?: string }
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

    const [{ data: plan }, mode] = await Promise.all([
      supabaseServer
        .from('verdix_plans')
        .select('stripe_price_id_test, stripe_price_id_live, stripe_price_id, name')
        .eq('id', planId)
        .maybeSingle(),
      getBillingMode(),
    ])

    // Use mode-specific price if available (post-migration), otherwise fall back to legacy
    const modeSpecificPriceId = mode === 'live' ? plan?.stripe_price_id_live : plan?.stripe_price_id_test
    const priceId = modeSpecificPriceId ?? plan?.stripe_price_id
    if (!priceId) {
      return NextResponse.json({ error: `Plan not yet pushed to Stripe. Go to Admin → Billing and push the plan.` }, { status: 400 })
    }

    // Use mode-aware Stripe key when using env-specific price; fall back to original key for legacy prices
    const { default: Stripe } = await import('stripe')
    const stripeKey = modeSpecificPriceId
      ? (mode === 'live' ? (process.env.STRIPE_SECRET_KEY_LIVE ?? process.env.STRIPE_SECRET_KEY) : (process.env.STRIPE_SECRET_KEY_TEST ?? process.env.STRIPE_SECRET_KEY))
      : process.env.STRIPE_SECRET_KEY
    if (!stripeKey) throw new Error('Missing STRIPE_SECRET_KEY env var')
    const stripe = new Stripe(stripeKey, { apiVersion: '2026-06-24.dahlia' })

    const sub = await getOrgSubscription(org.orgId)

    // ── Upgrade path: org already has an active subscription ──────────────────
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

    // ── New subscription path: no active subscription yet ─────────────────────
    const customerId = await getOrCreateStripeCustomer(org.orgId, org.orgName, session.user.email)

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
