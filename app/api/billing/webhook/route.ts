/**
 * Stripe webhook for Verdix SaaS subscription billing.
 * Separate from /api/stripe/webhook which handles customer contract billing.
 *
 * Events handled:
 *  checkout.session.completed  → activate subscription after upgrade checkout
 *  customer.subscription.updated → sync plan changes
 *  customer.subscription.deleted → downgrade to trial
 *  invoice.paid (subscription) → reset sync counter for new period
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { resetPeriodSyncs } from '@/lib/billing'

export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  const sig     = req.headers.get('stripe-signature') ?? ''

  const { default: Stripe } = await import('stripe')
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-06-24.dahlia' })

  let event: import('stripe').default.Event
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_BILLING_WEBHOOK_SECRET ?? process.env.STRIPE_WEBHOOK_SECRET!)
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const cs = event.data.object as import('stripe').default.Checkout.Session
      if (cs.mode !== 'subscription') return NextResponse.json({ received: true })

      const orgId  = cs.metadata?.verdix_org_id
      const planId = cs.metadata?.verdix_plan_id
      const subId  = typeof cs.subscription === 'string' ? cs.subscription : cs.subscription?.id

      if (!orgId || !planId || !subId) return NextResponse.json({ received: true })

      const subscription = await stripe.subscriptions.retrieve(subId)
      const periodStart  = new Date(subscription.current_period_start * 1000).toISOString()
      const periodEnd    = new Date(subscription.current_period_end   * 1000).toISOString()

      await supabaseServer.from('org_subscriptions').upsert({
        org_id: orgId,
        plan_id: planId,
        stripe_subscription_id: subId,
        current_period_start: periodStart,
        current_period_end:   periodEnd,
        syncs_used: 0,
        status: 'active',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'org_id' })
    }

    else if (event.type === 'customer.subscription.updated') {
      const sub   = event.data.object as import('stripe').default.Subscription
      const orgId = sub.metadata?.verdix_org_id
      if (!orgId) return NextResponse.json({ received: true })

      const planId = sub.metadata?.verdix_plan_id ?? 'core'
      const periodStart = new Date(sub.current_period_start * 1000).toISOString()
      const periodEnd   = new Date(sub.current_period_end   * 1000).toISOString()

      await supabaseServer.from('org_subscriptions').update({
        plan_id: planId,
        status:  sub.status === 'active' ? 'active' : sub.status,
        current_period_start: periodStart,
        current_period_end:   periodEnd,
        updated_at: new Date().toISOString(),
      }).eq('org_id', orgId)
    }

    else if (event.type === 'customer.subscription.deleted') {
      const sub   = event.data.object as import('stripe').default.Subscription
      const orgId = sub.metadata?.verdix_org_id
      if (!orgId) return NextResponse.json({ received: true })

      await supabaseServer.from('org_subscriptions').update({
        plan_id: 'trial',
        stripe_subscription_id: null,
        status: 'active',
        syncs_used: 0,
        updated_at: new Date().toISOString(),
      }).eq('org_id', orgId)
    }

    else if (event.type === 'invoice.paid') {
      const invoice = event.data.object as import('stripe').default.Invoice
      const subRef  = invoice.parent?.subscription_details?.subscription
      if (!subRef) return NextResponse.json({ received: true })

      const subId = typeof subRef === 'string' ? subRef : subRef.id
      const subscription = await stripe.subscriptions.retrieve(subId)
      const orgId = subscription.metadata?.verdix_org_id
      if (!orgId) return NextResponse.json({ received: true })

      // Add overage line items for previous period before resetting counter
      const { data: sub } = await supabaseServer
        .from('org_subscriptions')
        .select('syncs_used, plan_id')
        .eq('org_id', orgId)
        .maybeSingle()

      if (sub) {
        const { data: plan } = await supabaseServer
          .from('verdix_plans')
          .select('sync_limit, overage_price_eur')
          .eq('id', sub.plan_id)
          .maybeSingle()

        const overageCount = plan?.sync_limit != null
          ? Math.max(0, sub.syncs_used - plan.sync_limit)
          : 0

        if (overageCount > 0 && plan?.overage_price_eur && invoice.customer) {
          const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer.id
          await stripe.invoiceItems.create({
            customer:    customerId,
            amount:      Math.round(plan.overage_price_eur * overageCount * 100),
            currency:    'eur',
            description: `Verdix agreement sync overage — ${overageCount} excess sync${overageCount !== 1 ? 's' : ''} @ €${plan.overage_price_eur}/sync`,
          }).catch(err => console.error('[billing/webhook] overage invoiceitem failed', err))
        }
      }

      // Reset sync counter for new period
      const periodStart = new Date(subscription.current_period_start * 1000).toISOString()
      const periodEnd   = new Date(subscription.current_period_end   * 1000).toISOString()
      await resetPeriodSyncs(orgId, periodStart, periodEnd)
    }
  } catch (err) {
    console.error('[billing/webhook] handler error', err)
  }

  return NextResponse.json({ received: true })
}
