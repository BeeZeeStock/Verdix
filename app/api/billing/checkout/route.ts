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

  const customerId = await getOrCreateStripeCustomer(org.orgId, org.orgName, session.user.email)

  const { default: Stripe } = await import('stripe')
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-06-24.dahlia' })

  const base = returnUrl ?? `${process.env.NEXTAUTH_URL ?? 'https://app.lynoraai.com'}/settings/billing`

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
