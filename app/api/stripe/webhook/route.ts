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
import { getCustomerMeterTotal, billingInterval, periodsPerYear } from '@/lib/stripe-meter'
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
      .select('id, org_id, contract_terms ( * )')
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

    // ── 1a. Resolve org on-demand pull config ──────────────────────────────
    // If the org has a client_usage_url configured, usage data is pulled from
    // their endpoint at invoice time rather than from Stripe Billing Meters.
    type PullCfg = { client_usage_url: string; client_read_api_key?: string }
    let pullConfig: PullCfg | null = null
    if (job.org_id) {
      const { data: orgData } = await supabaseServer
        .from('organizations')
        .select('pull_config')
        .eq('id', job.org_id)
        .maybeSingle()
      const pc = (orgData?.pull_config ?? {}) as Partial<PullCfg>
      if (pc.client_usage_url) pullConfig = pc as PullCfg
    }

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

    // ── 3. Compute billing cadence + year position relative to contract ───────
    const hasYearRates   = !!(terms.year_pricing && Object.keys(terms.year_pricing).length > 0)
    const { interval, intervalCount } = billingInterval(terms.billing_frequency)
    const isAnnualBilling = interval === 'year'
    const ppy             = periodsPerYear(interval, intervalCount)

    const contractStart  = terms.contract_start_date ? new Date(terms.contract_start_date) : null
    const monthsElapsed  = contractStart
      ? (periodStart.getFullYear() - contractStart.getFullYear()) * 12 +
        (periodStart.getMonth()    - contractStart.getMonth())
      : 0
    const rawYearNum = Math.floor(monthsElapsed / 12) + 1
    const yearNum    = Math.max(1, rawYearNum)

    // ── 3a. Redirect to pre-created annual draft for Year 2+ (annual only) ────
    // For annual billing: billing-writer pre-creates draft invoices for all future
    // years. When Stripe auto-generates the anniversary invoice, redirect into the
    // pre-created draft, inject items, finalize it, and delete the auto-generated one.
    // For monthly/quarterly/semi-annual: Stripe generates each period invoice
    // automatically — no pre-created drafts exist, no redirect needed.
    let targetInvoiceId = invoice.id
    if (isAnnualBilling && yearNum > 1) {
      const drafts = await stripe.invoices.list({ customer: customerId, status: 'draft', limit: 50 })
      const preDraft = drafts.data.find(inv => {
        const meta = inv.metadata as Record<string, string> | null
        return meta?.verdix_job === job.id &&
               meta?.invoice_type === 'annual_base' &&
               meta?.year === String(yearNum)
      })
      if (preDraft) {
        targetInvoiceId = preDraft.id
        await stripe.invoices.del(invoice.id).catch(() => null)
      }
    }

    // ── 3b. Inject base fee ────────────────────────────────────────────────
    // Fires whenever the contract has per-year rate differentials (escalators/ramps).
    // For annual billing: injects the full year N amount.
    // For sub-annual billing (monthly/quarterly/semi-annual): injects the period
    // fee = year N annual amount ÷ periods-per-year, using the actual invoice dates.
    if (hasYearRates && contractStart && terms.year_pricing) {
      const yp          = terms.year_pricing
      const totalYears  = Object.keys(yp).length
      const clampedYear = Math.min(yearNum, totalYears)
      const annualFee   = yp[`year${clampedYear}`] ?? yp[`year${totalYears}`] ?? 0

      let injectAmount: number
      let description: string

      if (isAnnualBilling) {
        const yearStartDate = new Date(contractStart)
        yearStartDate.setFullYear(yearStartDate.getFullYear() + (clampedYear - 1))
        const yearEndDate = new Date(yearStartDate)
        yearEndDate.setFullYear(yearEndDate.getFullYear() + 1)
        yearEndDate.setDate(yearEndDate.getDate() - 1)
        injectAmount = annualFee
        description  = `Base subscription — Year ${yearNum} (${formatPeriod(yearStartDate, yearEndDate)})`
      } else {
        // Use the invoice's actual period dates for the description
        injectAmount = annualFee / ppy
        description  = `Base subscription — ${formatPeriod(periodStart, periodEnd)}`
      }

      // Skip if the pre-created draft already has the base fee item (annual only)
      const existingItems = targetInvoiceId !== invoice.id
        ? await stripe.invoiceItems.list({ invoice: targetInvoiceId, limit: 10 })
        : { data: [] }
      const hasBaseItem = existingItems.data.some(item =>
        (item.description ?? '').startsWith('Base subscription')
      )

      if (!hasBaseItem) {
        await stripe.invoiceItems.create({
          customer:    customerId,
          invoice:     targetInvoiceId,
          amount:      Math.round(injectAmount * 100),
          currency:    (terms.currency ?? 'EUR').toLowerCase(),
          description,
        })
        injectedLines.push({ description, amount: injectAmount, currency: terms.currency, type: 'base' })
      } else {
        injectedLines.push({ description, amount: injectAmount, currency: terms.currency, type: 'base' })
      }
    }

    // ── 4. Compute overage amounts ──────────────────────────────────────────
    // Primary path: per-meter pull from registered billing_meters endpoints.
    // Each confirmed org_billing_config meter has its own pull endpoint registered
    // in billing_meters. Verdix calls that endpoint per meter — same flow for
    // platform meters (sync → /api/internal/usage) and 3PP org meters.
    //
    // Fallback A: single org-level pull endpoint (legacy, backward compat).
    // Fallback B: Stripe Billing Meters (original path for metered subscriptions).

    type MeterCfg = {
      meter_key:      string
      included_units: number
      overage_tiers:  Array<{ from_unit?: number | null; to_unit?: number | null; rate_per_unit?: number }>
    }
    type MeterDef = {
      pull_endpoint_url: string | null
      pull_auth_token:   string | null
      pull_param_name:   string | null
    }

    const { data: meterConfigs } = await supabaseServer
      .from('org_billing_config')
      .select('meter_key, included_units, overage_tiers')
      .eq('org_id', job.org_id)
      .eq('active', true)

    if (meterConfigs && meterConfigs.length > 0) {
      // ── Primary: per-meter pull ─────────────────────────────────────────────
      for (const cfg of (meterConfigs as MeterCfg[])) {
        const { data: meterDef } = await supabaseServer
          .from('billing_meters')
          .select('pull_endpoint_url, pull_auth_token, pull_param_name')
          .or(`org_id.is.null,org_id.eq.${job.org_id}`)
          .eq('meter_key', cfg.meter_key)
          .maybeSingle()

        const def = meterDef as MeterDef | null

        if (!def?.pull_endpoint_url) {
          console.warn(`[stripe/webhook] no pull endpoint for meter '${cfg.meter_key}' org ${job.org_id} — skipping`)
          continue
        }

        const pullUrl = new URL(def.pull_endpoint_url)
        pullUrl.searchParams.set('customer_id',  customerId)
        pullUrl.searchParams.set('period_start', String(invoice.period_start))
        pullUrl.searchParams.set('period_end',   String(invoice.period_end))
        pullUrl.searchParams.set(def.pull_param_name ?? 'billing_parameter', cfg.meter_key)

        const pullHeaders: Record<string, string> = {}
        if (def.pull_auth_token) pullHeaders['Authorization'] = `Bearer ${def.pull_auth_token}`

        const pullRes = await fetch(pullUrl.toString(), { headers: pullHeaders })
        if (!pullRes.ok) {
          console.error(`[stripe/webhook] pull failed for meter '${cfg.meter_key}' (${pullRes.status}) — skipping`)
          continue
        }

        const usageData  = await pullRes.json() as { total_billable_units?: number | string }
        const totalUnits = Number(usageData.total_billable_units ?? 0)
        if (totalUnits <= 0) continue

        const tiers         = (cfg.overage_tiers ?? []).map((t, i) => ({
          tier_label:    `Tier ${i + 1}`,
          from_unit:     t.from_unit ?? null,
          to_unit:       t.to_unit   ?? null,
          rate_per_unit: t.rate_per_unit ?? 0,
          unit_type:     cfg.meter_key,
        }))
        const includedUnits = cfg.included_units ?? 0
        const overageEur    = tiers.length > 0
          ? computeMetricOverage(totalUnits, tiers, includedUnits)
          : 0

        if (overageEur <= 0) continue

        const description = buildOverageDescription(cfg.meter_key, totalUnits, tiers, includedUnits)

        await stripe.invoiceItems.create({
          customer:    customerId,
          invoice:     targetInvoiceId,
          amount:      Math.round(overageEur * 100),
          currency:    (terms.currency ?? 'EUR').toLowerCase(),
          description,
          metadata: {
            metric_source:     'meter_pull',
            meter_key:         cfg.meter_key,
            total_units:       String(totalUnits),
            billing_parameter: cfg.meter_key,
            verdix_job:        job.id,
          },
        })

        injectedLines.push({
          description,
          amount:            overageEur,
          currency:          terms.currency,
          type:              'overage',
          unit_type:         cfg.meter_key,
          total_quantity:    totalUnits,
          included_quantity: includedUnits,
          excess_quantity:   Math.max(0, totalUnits - includedUnits),
        })
      }
    } else if (pullConfig) {
      // ── Fallback A: legacy single org-level pull endpoint ───────────────────
      const pullUrl = new URL(pullConfig.client_usage_url)
      pullUrl.searchParams.set('customer_id',  customerId)
      pullUrl.searchParams.set('period_start', String(invoice.period_start))
      pullUrl.searchParams.set('period_end',   String(invoice.period_end))

      const pullHeaders: Record<string, string> = {}
      if (pullConfig.client_read_api_key) pullHeaders['Authorization'] = `Bearer ${pullConfig.client_read_api_key}`

      const pullRes = await fetch(pullUrl.toString(), { headers: pullHeaders })
      if (!pullRes.ok) {
        console.error(`[stripe/webhook] legacy pull failed (${pullRes.status}) for job ${job.id}`)
      } else {
        const usageData      = await pullRes.json() as { total_billable_units?: number | string }
        const aggregateUnits = Number(usageData.total_billable_units || 0)
        const includedUnits  = terms.included_units ?? 0

        if (aggregateUnits > 0) {
          const overageAmount = Math.round(computeMetricOverage(aggregateUnits, terms.overage_tiers ?? [], includedUnits) * 100) / 100
          if (overageAmount > 0) {
            const description = buildOverageDescription('Usage', aggregateUnits, terms.overage_tiers ?? [], includedUnits)
            await stripe.invoiceItems.create({
              customer:    customerId,
              invoice:     targetInvoiceId,
              amount:      Math.round(overageAmount * 100),
              currency:    (terms.currency ?? 'EUR').toLowerCase(),
              description,
              metadata: { metric_source: 'client_pull', total_units: String(aggregateUnits), verdix_job: job.id },
            })
            injectedLines.push({
              description, amount: overageAmount, currency: terms.currency, type: 'overage',
              total_quantity: aggregateUnits, included_quantity: includedUnits,
              excess_quantity: Math.max(0, aggregateUnits - includedUnits),
            })
          }
        }
      }
    } else {
      // ── Fallback B: Stripe Billing Meters (original metered subscription path) ─
      const meteredItems  = terms.billing_metered_items ?? []
      const tiersByMetric = groupTiersByMetric(terms.overage_tiers ?? [])
      const includedUnits = terms.included_units ?? 0

      await Promise.all(
        meteredItems.map(async item => {
          const tiers = tiersByMetric.get(item.unit_type.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''))
          if (!tiers || tiers.length === 0) return

          const quantity = await getCustomerMeterTotal(stripe, {
            meterId: item.meter_id, customerId, startTime: periodStart, endTime: periodEnd,
          })

          const amount = Math.round(computeMetricOverage(quantity, tiers, includedUnits) * 100) / 100
          if (amount <= 0) return

          const description = buildOverageDescription(item.unit_type, quantity, tiers, includedUnits)
          await stripe.invoiceItems.create({
            customer:    customerId,
            invoice:     targetInvoiceId,
            amount:      Math.round(amount * 100),
            currency:    (terms.currency ?? 'EUR').toLowerCase(),
            description,
            metadata: { metric_code: item.meter_id, unit_type: item.unit_type, quantity: String(quantity), verdix_job: job.id },
          })
          injectedLines.push({
            description, amount, currency: terms.currency, type: 'overage',
            unit_type: item.unit_type, total_quantity: quantity,
            included_quantity: includedUnits, excess_quantity: Math.max(0, quantity - includedUnits),
          })
        })
      )
    }

    // ── 5. Persist computed invoice (DRAFT) ────────────────────────────────
    const totalAmount = injectedLines.reduce((s, l) => s + l.amount, 0)

    const { data: insertedRows } = await supabaseServer
      .from('computed_invoices')
      .insert({
        job_id:                   job.id,
        external_invoice_id:      targetInvoiceId,
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

        await stripe.invoices.finalizeInvoice(targetInvoiceId).catch(err => {
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
