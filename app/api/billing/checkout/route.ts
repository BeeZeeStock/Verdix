import { NextRequest, NextResponse } from 'next/server'
import { getVerdixStripe } from '@/lib/stripe-verdix'
import { auth } from '@/lib/auth'
import { supabaseServer } from '@/lib/supabase'
import { getOrgSubscription, getOrCreateStripeCustomer } from '@/lib/billing'
import { getActiveOrg } from '@/lib/org'

// Alias new marketing plan IDs to DB plan IDs (DB IDs unchanged for Stripe compatibility)
const PLAN_ALIAS: Record<string, string> = { free: 'trial', payg: 'core', scale: 'pro' }

// POST /api/billing/checkout
// Body: { planId: 'payg' | 'scale' | 'core' | 'pro', returnUrl?: string }
export async function POST(req: NextRequest) {
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

  // Fetch the plan's Stripe price
  const { data: plan } = await supabaseServer
    .from('verdix_plans')
    .select('stripe_price_id, name')
    .eq('id', planId)
    .maybeSingle()

  if (!plan?.stripe_price_id) {
    return NextResponse.json({ error: 'Plan not yet pushed to Stripe. Ask admin to push.' }, { status: 400 })
  }


  const stripe = await getVerdixStripe()

  const sub = await getOrgSubscription(org.orgId)

  // ── Upgrade path: org already has an active subscription ──────────────────
  if (sub.stripe_subscription_id && ['active', 'trialing'].includes(sub.status ?? '')) {
    const existing = await stripe.subscriptions.retrieve(sub.stripe_subscription_id, {
      expand: ['items'],
    })

    const toDelete = existing.items.data
      .filter(item => item.price.id !== plan.stripe_price_id)
      .map(item => ({ id: item.id, deleted: true as const }))

    const alreadyHasPlan = existing.items.data.some(item => item.price.id === plan.stripe_price_id)
    const toAdd = alreadyHasPlan ? [] : [{ price: plan.stripe_price_id, quantity: 1 }]

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
    line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
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
