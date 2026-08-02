import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { supabaseServer } from '@/lib/supabase'
import { getActiveOrg } from '@/lib/org'

const base = () =>
  process.env.AUTH_URL || process.env.NEXTAUTH_URL || 'https://lynoraai.com'

const PLAN_ALIAS: Record<string, string> = { free: 'trial', payg: 'core', scale: 'pro' }

async function getLiveCheckoutActive(): Promise<boolean> {
  const { data } = await supabaseServer
    .from('verdix_settings')
    .select('value')
    .eq('key', 'live_checkout_active')
    .maybeSingle()
  return (data?.value as string) === 'true'
}

// GET /api/billing/checkout-redirect?plan=payg|scale|core|pro
// Called as callbackUrl after OAuth when user arrived from a plan CTA.
export async function GET(req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.email) {
      return NextResponse.redirect(new URL('/login', base()))
    }

    const rawPlanId = new URL(req.url).searchParams.get('plan')
    const planId = rawPlanId ? (PLAN_ALIAS[rawPlanId] ?? rawPlanId) : null
    if (!planId || !['core', 'pro'].includes(planId)) {
      return NextResponse.redirect(new URL('/dashboard', base()))
    }

    const org = await getActiveOrg()
    if (!org) {
      return NextResponse.redirect(new URL('/dashboard', base()))
    }

    const [{ data: plan }, liveActive] = await Promise.all([
      supabaseServer
        .from('verdix_plans')
        .select('stripe_price_id_test, stripe_price_id_live, stripe_price_id, name, overage_price_eur, base_price_eur')
        .eq('id', planId)
        .maybeSingle(),
      getLiveCheckoutActive(),
    ])

    // Select Stripe key based on live_checkout_active — same logic as /api/billing/checkout
    const stripeKey = liveActive
      ? (process.env.STRIPE_SECRET_KEY_LIVE ?? process.env.STRIPE_SECRET_KEY)
      : (process.env.STRIPE_SECRET_KEY_TEST ?? process.env.STRIPE_SECRET_KEY)

    if (!stripeKey) {
      console.error('[checkout-redirect] No Stripe key available')
      return NextResponse.redirect(new URL('/settings/billing?cancelled=1', base()))
    }

    if (liveActive && stripeKey.startsWith('sk_test_')) {
      console.error('[checkout-redirect] Live checkout active but STRIPE_SECRET_KEY_LIVE not set')
      return NextResponse.redirect(new URL('/settings/billing?cancelled=1', base()))
    }

    const { default: Stripe } = await import('stripe')
    const stripe = new Stripe(stripeKey, { apiVersion: '2026-06-24.dahlia' })

    // Use env-specific price; never fall back to test price in live mode
    const envPriceId = liveActive ? plan?.stripe_price_id_live : plan?.stripe_price_id_test
    const priceId = envPriceId ?? (liveActive ? null : plan?.stripe_price_id)

    if (!priceId) {
      console.error(`[checkout-redirect] No price for plan "${planId}" in ${liveActive ? 'live' : 'sandbox'} mode`)
      return NextResponse.redirect(new URL('/settings/billing', base()))
    }

    // Verify or create customer in the correct Stripe account
    const { data: sub } = await supabaseServer
      .from('org_subscriptions')
      .select('stripe_customer_id')
      .eq('org_id', org.orgId)
      .maybeSingle()

    let customerId = sub?.stripe_customer_id as string | null
    if (customerId) {
      try {
        await stripe.customers.retrieve(customerId)
      } catch {
        customerId = null
      }
    }
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: org.orgName,
        email: session.user.email,
        metadata: { verdix_org_id: org.orgId },
      })
      customerId = customer.id
      await supabaseServer
        .from('org_subscriptions')
        .update({ stripe_customer_id: customerId, updated_at: new Date().toISOString() })
        .eq('org_id', org.orgId)
    }

    const returnUrl = `${base()}/settings/billing`

    const isPayg = !plan?.base_price_eur && plan?.overage_price_eur
    const overageNote = isPayg
      ? `€${plan.overage_price_eur} per agreement processed, billed monthly in arrears based on usage.`
      : undefined

    const checkoutSession = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${returnUrl}?upgraded=1`,
      cancel_url:  `${returnUrl}?cancelled=1`,
      metadata: { verdix_org_id: org.orgId, verdix_plan_id: planId },
      subscription_data: {
        metadata: { verdix_org_id: org.orgId, verdix_plan_id: planId },
      },
      allow_promotion_codes: true,
      ...(overageNote ? { custom_text: { submit: { message: overageNote } } } : {}),
    })

    return NextResponse.redirect(checkoutSession.url!)
  } catch (err) {
    console.error('[checkout-redirect]', err)
    return NextResponse.redirect(new URL('/settings/billing?cancelled=1', base()))
  }
}
