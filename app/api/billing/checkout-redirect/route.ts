import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { supabaseServer } from '@/lib/supabase'
import { getOrCreateStripeCustomer } from '@/lib/billing'
import { getActiveOrg } from '@/lib/org'

const base = () =>
  process.env.AUTH_URL || process.env.NEXTAUTH_URL || 'https://lynoraai.com'

// GET /api/billing/checkout-redirect?plan=core
// Used as callbackUrl after Google OAuth when user arrived from a plan CTA.
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.email) {
    return NextResponse.redirect(new URL('/login', base()))
  }

  const planId = new URL(req.url).searchParams.get('plan')
  if (!planId || !['core', 'pro'].includes(planId)) {
    return NextResponse.redirect(new URL('/dashboard', base()))
  }

  const org = await getActiveOrg()
  if (!org) {
    return NextResponse.redirect(new URL('/dashboard', base()))
  }

  const { data: plan } = await supabaseServer
    .from('verdix_plans')
    .select('stripe_price_id, name')
    .eq('id', planId)
    .maybeSingle()

  if (!plan?.stripe_price_id) {
    return NextResponse.redirect(new URL('/settings/billing', base()))
  }

  const customerId = await getOrCreateStripeCustomer(org.orgId, org.orgName, session.user.email)

  const { default: Stripe } = await import('stripe')
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-06-24.dahlia' })

  const returnUrl = `${base()}/settings/billing`

  const checkoutSession = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
    success_url: `${returnUrl}?upgraded=1`,
    cancel_url:  `${returnUrl}?cancelled=1`,
    metadata: { verdix_org_id: org.orgId, verdix_plan_id: planId },
    subscription_data: {
      metadata: { verdix_org_id: org.orgId, verdix_plan_id: planId },
    },
    allow_promotion_codes: true,
  })

  return NextResponse.redirect(checkoutSession.url!)
}
