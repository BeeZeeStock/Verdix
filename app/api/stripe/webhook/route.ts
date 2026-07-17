/**
 * Stripe webhook handler — customer contract billing.
 * Separate from /api/billing/webhook which handles Verdix SaaS subscription charges.
 *
 * Per-org routing: orgs register this URL in their own Stripe dashboard as:
 *   https://<host>/api/stripe/webhook?orgId=<orgId>
 * Verdix looks up that org's webhook_secret (stored in org_integrations.config)
 * and uses it to verify the signature, then uses the org's secret_key for all
 * subsequent Stripe API calls. This keeps each org's contract billing fully
 * isolated in their own Stripe account.
 *
 * Handles:
 *   invoice.created           — injects correct year/overage amounts as invoice items
 *   invoice.payment_succeeded — marks computed_invoice as PAID
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { getCustomerMeterTotal } from '@/lib/stripe-meter'
import { groupTiersByMetric, computeMetricOverage } from '@/lib/tariff'
import { validateInvoice } from '@/lib/invoice-validator'
import type { ContractTerms, BillingMeteredItem } from '@/lib/types'
import type Stripe from 'stripe'

export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  const sig     = req.headers.get('stripe-signature') ?? ''
  const orgId   = req.nextUrl.searchParams.get('orgId')

  // ── Resolve credentials ──────────────────────────────────────────────────────
  // Per-org: look up the org's Stripe integration for its webhook_secret + secret_key.
  // Platform fallback: use env vars (for contracts pushed via the Verdix platform key).
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
      // Org hasn't completed webhook setup — reject clearly rather than falling
      // through to a signature failure that would look like a Stripe error.
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

  // ── Route by event type ────────────────────────────────────────────────────

  if (event.type === 'invoice.payment_succeeded') {
    return handlePaymentSucceeded(event)
  }

  if (event.type !== 'invoice.created') {
    return NextResponse.json({ received: true })
  }

  // ── invoice.created ────────────────────────────────────────────────────────

  const invoice = event.data.object as Stripe.Invoice

  // In Stripe API 2026-06-24 (dahlia), subscription reference moved to invoice.parent
  const subRef = invoice.parent?.subscription_details?.subscription
  if (invoice.status !== 'draft' || !subRef) {
    return NextResponse.json({ received: true })
  }

  const subscriptionId = typeof subRef === 'string' ? subRef : subRef.id

  try {
    // ── 0. Idempotency guard ───────────────────────────────────────────────
    const { data: existing } = await supabaseServer
      .from('computed_invoices')
      .select('id')
      .eq('external_invoice_id', invoice.id)
      .limit(1)
    if (existing && existing.length > 0) {
      return NextResponse.json({ received: true, skipped: 'already_processed' })
    }

    // ── 1. Look up the Verdix contract by subscription ID ──────────────────
    const { data: jobs } = await supabaseServer
      .from('jobs')
      .select('id, contract_terms ( * )')
      .eq('billing_subscription_id', subscriptionId)
      .limit(1)

    const job = jobs?.[0]
    if (!job) return NextResponse.json({ received: true })

    const termsArr = job.contract_terms as unknown as (ContractTerms & {
      id: string
      billing_metered_items?: BillingMeteredItem[]
    })[]
    const terms = termsArr?.[0]
    if (!terms) return NextResponse.json({ received: true })

    // ── 2. Resolve billing period from invoice ─────────────────────────────
    const periodStart = new Date((invoice.period_start ?? 0) * 1000)
    const periodEnd   = new Date((invoice.period_end   ?? 0) * 1000)
    const customerId  = typeof invoice.customer === 'string'
      ? invoice.customer
      : invoice.customer?.id ?? ''

    const injectedLines: {
      description: string
      amount: number
      currency: string
      type: 'base' | 'overage'
      unit_type?: string
      total_quantity?: number
      included_quantity?: number
      excess_quantity?: number
    }[] = []

    // ── 3. Inject correct base fee for year_pricing contracts ──────────────
    const isYearPricing = !!(terms.year_pricing && Object.keys(terms.year_pricing).length > 0)

    if (isYearPricing && terms.contract_start_date && terms.year_pricing) {
      const yp = terms.year_pricing
      const contractStart = new Date(terms.contract_start_date)
      const monthsElapsed =
        (periodStart.getFullYear() - contractStart.getFullYear()) * 12 +
        (periodStart.getMonth()    - contractStart.getMonth())
      const yearNum   = Math.floor(monthsElapsed / 12) + 1
      const yearKey   = `year${yearNum}`
      const lastKey   = `year${Object.keys(yp).length}`
      const annualFee = yp[yearKey] ?? yp[lastKey] ?? 0

      const periodLabel = formatPeriod(periodStart, periodEnd)
      const description = `Base subscription — Year ${yearNum} (${periodLabel})`

      await stripe.invoiceItems.create({
        customer:    customerId,
        invoice:     invoice.id,
        amount:      Math.round(annualFee * 100),
        currency:    (terms.currency ?? 'EUR').toLowerCase(),
        description,
      })

      injectedLines.push({ description, amount: annualFee, currency: terms.currency, type: 'base' })
    }

    // ── 4. Read meter totals + apply tariff logic per usage type ───────────
    const meteredItems  = terms.billing_metered_items ?? []
    const tiersByMetric = groupTiersByMetric(terms.overage_tiers ?? [])
    const includedUnits = terms.included_units ?? 0

    await Promise.all(
      meteredItems.map(async item => {
        const tiers = tiersByMetric.get(item.unit_type.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''))
        if (!tiers || tiers.length === 0) return

        const quantity = await getCustomerMeterTotal(stripe, {
          meterId:    item.meter_id,
          customerId,
          startTime:  periodStart,
          endTime:    periodEnd,
        })

        const amount = Math.round(computeMetricOverage(quantity, tiers, includedUnits) * 100) / 100
        if (amount <= 0) return

        const description = buildOverageDescription(item.unit_type, quantity, tiers, includedUnits)

        await stripe.invoiceItems.create({
          customer:    customerId,
          invoice:     invoice.id,
          amount:      Math.round(amount * 100),
          currency:    (terms.currency ?? 'EUR').toLowerCase(),
          description,
          metadata: {
            metric_code: item.meter_id,
            unit_type:   item.unit_type,
            quantity:    String(quantity),
            verdix_job:  job.id,
          },
        })

        injectedLines.push({
          description,
          amount,
          currency:          terms.currency,
          type:              'overage',
          unit_type:         item.unit_type,
          total_quantity:    quantity,
          included_quantity: includedUnits,
          excess_quantity:   Math.max(0, quantity - includedUnits),
        })
      })
    )

    // ── 5. Persist computed invoice (DRAFT) ────────────────────────────────
    const totalAmount = injectedLines.reduce((s, l) => s + l.amount, 0)

    const { data: insertedRows } = await supabaseServer
      .from('computed_invoices')
      .insert({
        job_id:                   job.id,
        external_invoice_id:      invoice.id,
        external_subscription_id: subscriptionId,
        connector:                'stripe',
        period_start:             periodStart.toISOString(),
        period_end:               periodEnd.toISOString(),
        line_items:               injectedLines,
        total_amount:             totalAmount,
        currency:                 terms.currency ?? 'EUR',
        status:                   'DRAFT',
      })
      .select('id')

    const computedInvoiceId = insertedRows?.[0]?.id

    // ── 6. Run billing check agent automatically ───────────────────────────
    if (computedInvoiceId) {
      const { data: priorInvoices } = await supabaseServer
        .from('computed_invoices')
        .select('id, period_start, period_end, line_items, total_amount, currency')
        .eq('job_id', job.id)
        .neq('id', computedInvoiceId)
        .order('period_start', { ascending: false })
        .limit(12)

      const findings = validateInvoice(terms, injectedLines, priorInvoices ?? [])

      if (findings.length === 0) {
        await supabaseServer
          .from('computed_invoices')
          .update({ status: 'VALIDATED', validation_result: [] })
          .eq('id', computedInvoiceId)

        await stripe.invoices.finalizeInvoice(invoice.id).catch(err => {
          console.error('[stripe/webhook] finalise failed', err)
        })
      } else {
        await supabaseServer
          .from('computed_invoices')
          .update({ status: 'NEEDS_REVIEW', validation_result: findings })
          .eq('id', computedInvoiceId)
      }
    }

    return NextResponse.json({ received: true })
  } catch (err) {
    console.error('[stripe/webhook] processing error for invoice', err)
    return NextResponse.json({ received: true, error: err instanceof Error ? err.message : String(err) })
  }
}

// ── Payment succeeded handler ──────────────────────────────────────────────────

async function handlePaymentSucceeded(event: Stripe.Event): Promise<NextResponse> {
  const invoice = event.data.object as Stripe.Invoice

  try {
    await supabaseServer
      .from('computed_invoices')
      .update({ status: 'PAID', paid_at: new Date().toISOString() })
      .eq('external_invoice_id', invoice.id)
  } catch (err) {
    console.error('[stripe/webhook] payment_succeeded handler error', err)
  }

  return NextResponse.json({ received: true })
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatPeriod(start: Date, end: Date): string {
  const fmt = (d: Date) => d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
  return `${fmt(start)} – ${fmt(end)}`
}

function buildOverageDescription(
  unitType: string,
  quantity: number,
  tiers: import('@/lib/types').OverageTier[],
  includedUnits: number,
): string {
  const billable = Math.max(0, quantity - includedUnits)
  const rate     = tiers[0]?.rate_per_unit ?? 0
  return `${unitType} overage — ${billable.toLocaleString()} excess units @ €${rate}/unit (${quantity.toLocaleString()} total, ${includedUnits.toLocaleString()} included)`
}
