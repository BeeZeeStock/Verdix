/**
 * Stripe webhook handler — customer contract billing.
 *
 * Per-org routing: orgs register this URL in their own Stripe dashboard as:
 *   https://<host>/api/stripe/webhook?orgId=<orgId>
 * Verdix looks up that org's webhook_secret (stored in org_integrations.config)
 * and uses it to verify the signature.
 *
 * Handles:
 *   invoice.payment_succeeded — marks planned_invoice and computed_invoice as PAID
 *
 * All invoice creation and overage injection is handled by the invoice-scheduler
 * cron (/api/admin/invoice-scheduler) rather than in this webhook. There are no
 * subscriptions to manage — Verdix owns the full billing schedule as standalone
 * Stripe invoices written to planned_invoices and created by the scheduler.
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import type Stripe from 'stripe'

export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  const sig     = req.headers.get('stripe-signature') ?? ''
  const orgId   = req.nextUrl.searchParams.get('orgId')

  // ── Resolve credentials ───────────────────────────────────────────────────
  let stripeKey     = process.env.STRIPE_SECRET_KEY!
  let webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!

  if (orgId) {
    const { data: integration } = await supabaseServer
      .from('org_integrations')
      .select('config')
      .eq('org_id', orgId)
      .eq('connector_name', 'stripe')
      .eq('is_active', true)
      .maybeSingle()

    const config = (integration?.config ?? {}) as Record<string, string>

    if (!config.webhook_secret) {
      return NextResponse.json(
        { error: 'Webhook secret not configured for this org. Add it in Settings → Integrations.' },
        { status: 400 },
      )
    }

    if (config.secret_key) stripeKey = config.secret_key
    webhookSecret = config.webhook_secret
  }

  const { default: StripeSDK } = await import('stripe')
  const stripe = new StripeSDK(stripeKey, { apiVersion: '2026-06-24.dahlia' })

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret)
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  if (event.type === 'invoice.payment_succeeded') {
    return handlePaymentSucceeded(event)
  }

  // All other events are acknowledged and ignored — invoice creation and
  // overage injection happen via the invoice-scheduler cron, not webhooks.
  return NextResponse.json({ received: true })
}

async function handlePaymentSucceeded(event: Stripe.Event): Promise<NextResponse> {
  const invoice = event.data.object as Stripe.Invoice

  try {
    await Promise.all([
      // Mark planned_invoice paid (new model)
      supabaseServer
        .from('planned_invoices')
        .update({ status: 'paid', paid_at: new Date().toISOString() })
        .eq('stripe_invoice_id', invoice.id),

      // Mark computed_invoice paid (legacy model — safe no-op if row doesn't exist)
      supabaseServer
        .from('computed_invoices')
        .update({ status: 'PAID', paid_at: new Date().toISOString() })
        .eq('external_invoice_id', invoice.id),
    ])
  } catch (err) {
    console.error('[stripe/webhook] payment_succeeded handler error', err)
  }

  return NextResponse.json({ received: true })
}
