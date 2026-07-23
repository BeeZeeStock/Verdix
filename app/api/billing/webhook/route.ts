/**
 * Stripe webhook for Verdix SaaS billing.
 *
 * Under the Verdix-driven billing model Stripe is only a payment terminal.
 * Verdix computes all invoices via runBillingForOrg() and pushes them to Stripe.
 * Stripe fires events only to confirm what happened after the fact.
 *
 * Events handled:
 *  - checkout.session.completed → record subscription, set cancel_at_period_end
 *  - invoice.paid               → confirm status active
 *  - customer.subscription.deleted → safety-net downgrade to trial
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'

type StripeInvoice = import('stripe').default.Invoice

export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  const sig     = req.headers.get('stripe-signature') ?? ''

  const { default: Stripe } = await import('stripe')
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-06-24.dahlia' })

  let event: import('stripe').default.Event
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_BILLING_WEBHOOK_SECRET ?? process.env.STRIPE_WEBHOOK_SECRET!,
    )
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  try {
    // ── checkout.session.completed ───────────────────────────────────────────
    if (event.type === 'checkout.session.completed') {
      const cs = event.data.object as import('stripe').default.Checkout.Session
      if (cs.mode !== 'subscription') return NextResponse.json({ received: true })

      const orgId  = cs.metadata?.verdix_org_id
      const planId = cs.metadata?.verdix_plan_id
      const cycle  = (cs.metadata?.billing_cycle ?? 'monthly') as string
      const subId  = typeof cs.subscription === 'string' ? cs.subscription : cs.subscription?.id

      if (!orgId || !planId || !subId) return NextResponse.json({ received: true })

      const subscription = await stripe.subscriptions.retrieve(subId, { expand: ['latest_invoice'] })
      const invoice      = subscription.latest_invoice as StripeInvoice | null
      const periodStart  = invoice ? new Date(invoice.period_start * 1000).toISOString() : new Date().toISOString()
      const periodEnd    = invoice ? new Date(invoice.period_end   * 1000).toISOString()
        : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

      const customerId = typeof cs.customer === 'string'
        ? cs.customer
        : (cs.customer as { id: string } | null)?.id ?? null

      await supabaseServer.from('org_subscriptions').upsert({
        org_id:                 orgId,
        plan_id:                planId,
        stripe_customer_id:     customerId,
        stripe_subscription_id: subId,
        billing_cycle:          cycle,
        current_period_start:   periodStart,
        current_period_end:     periodEnd,
        syncs_used:             0,
        status:                 'active',
        updated_at:             new Date().toISOString(),
      }, { onConflict: 'org_id' })

      // Write plan-based billing config so the billing engine uses the right pricing
      const { data: plan } = await supabaseServer
        .from('verdix_plans')
        .select('sync_limit, overage_price_eur')
        .eq('id', planId)
        .maybeSingle()

      if (plan) {
        const overagePriceEur = plan.overage_price_eur ?? 0
        await supabaseServer.from('org_billing_config').upsert({
          org_id:         orgId,
          meter_key:      'sync',
          included_units: plan.sync_limit ?? 0,
          overage_tiers:  overagePriceEur > 0
            ? [{ from_unit: (plan.sync_limit ?? 0) + 1, to_unit: null, rate_per_unit: overagePriceEur }]
            : [],
          billing_cycle:  cycle,
          cycle_start:    new Date(periodStart).toISOString().split('T')[0],
          source:         'plan',
          active:         true,
          updated_at:     new Date().toISOString(),
        }, { onConflict: 'org_id,meter_key' })
      }

      // Verdix takes over billing from month 2 — prevent Stripe from auto-renewing.
      await stripe.subscriptions.update(subId, { cancel_at_period_end: true })
        .catch(err => console.error('[billing/webhook] cancel_at_period_end failed:', err))
    }

    // ── invoice.paid ─────────────────────────────────────────────────────────
    // Verdix already advanced the period before creating the invoice.
    // This handler only confirms active status.
    else if (event.type === 'invoice.paid') {
      const invoice = event.data.object as StripeInvoice

      // Verdix-created invoices carry verdix_org_id in metadata
      const metaOrgId = (invoice.metadata as Record<string, string> | null)?.verdix_org_id

      if (metaOrgId) {
        await supabaseServer.from('org_subscriptions')
          .update({ status: 'active', updated_at: new Date().toISOString() })
          .eq('org_id', metaOrgId)
        return NextResponse.json({ received: true })
      }

      // First Stripe invoice (from checkout): identify org via subscription metadata
      const subRef = invoice.parent?.subscription_details?.subscription
      if (!subRef) return NextResponse.json({ received: true })

      const subId        = typeof subRef === 'string' ? subRef : (subRef as { id: string }).id
      const subscription = await stripe.subscriptions.retrieve(subId)
      const orgId        = subscription.metadata?.verdix_org_id
      if (!orgId) return NextResponse.json({ received: true })

      await supabaseServer.from('org_subscriptions')
        .update({ status: 'active', updated_at: new Date().toISOString() })
        .eq('org_id', orgId)
    }

    // ── customer.subscription.deleted ────────────────────────────────────────
    // Safety net for Stripe-side cancellations (e.g. payment failure).
    // Verdix-managed periods do NOT fire this because cancel_at_period_end
    // only prevents auto-renewal; Verdix recreates invoices directly.
    else if (event.type === 'customer.subscription.deleted') {
      const sub   = event.data.object as import('stripe').default.Subscription
      const orgId = sub.metadata?.verdix_org_id
      if (!orgId) return NextResponse.json({ received: true })

      await supabaseServer.from('org_subscriptions').update({
        plan_id:                'trial',
        stripe_subscription_id: null,
        billing_cycle:          'monthly',
        status:                 'active',
        syncs_used:             0,
        updated_at:             new Date().toISOString(),
      }).eq('org_id', orgId)

      // Deactivate billing config so they revert to trial limits
      await supabaseServer
        .from('org_billing_config')
        .update({ active: false, updated_at: new Date().toISOString() })
        .eq('org_id', orgId)
    }
  } catch (err) {
    console.error('[billing/webhook] handler error', err)
  }

  return NextResponse.json({ received: true })
}
