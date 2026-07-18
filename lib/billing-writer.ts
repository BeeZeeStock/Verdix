import { ContractTerms } from './types'
import {
  ensureStripeMeter,
  createMeteredPrice,
  createBasePrice,
  billingInterval,
} from './stripe-meter'
import { groupTiersByMetric } from './tariff'
import { supabaseServer } from './supabase'

export type BillingPlatform = 'stripe' | 'chargebee'

async function getOrgConfig(orgId: string, connector: string): Promise<Record<string, string> | null> {
  const { data } = await supabaseServer
    .from('org_integrations')
    .select('config')
    .eq('org_id', orgId)
    .eq('connector_name', connector)
    .eq('is_active', true)
    .single()
  return (data?.config as Record<string, string>) ?? null
}

async function detectOrgPlatform(orgId: string): Promise<BillingPlatform> {
  const { data } = await supabaseServer
    .from('org_integrations')
    .select('connector_name')
    .eq('org_id', orgId)
    .eq('connector_type', 'billing')
    .eq('is_active', true)
    .limit(1)
    .single()
  if (data?.connector_name === 'chargebee') return 'chargebee'
  return 'stripe'
}

export interface LineItemInput {
  product_name: string
  quantity: number
  unit_price: number
  billing_period: string
  total_amount: number
  currency: string
  source_section?: string
}

export interface ConfigureResult {
  platform: BillingPlatform
  subscriptionId: string
  customerId: string
  lineItemCount: number
  dashboardUrl: string
}

export async function configureBilling(
  terms: ContractTerms,
  lineItems: LineItemInput[],
  platform?: BillingPlatform,
  jobId?: string,
  orgId?: string
): Promise<ConfigureResult> {
  const resolved = platform ?? (orgId ? await detectOrgPlatform(orgId) : detectPlatform())
  if (resolved === 'chargebee') return configureChargebee(terms, lineItems, jobId, orgId)
  return configureStripe(terms, lineItems, jobId, orgId)
}

async function configureStripe(terms: ContractTerms, lineItems: LineItemInput[], jobId?: string, orgId?: string): Promise<ConfigureResult> {
  const { default: Stripe } = await import('stripe')
  const orgConfig = orgId ? await getOrgConfig(orgId, 'stripe') : null
  const stripeKey = orgConfig?.secret_key ?? process.env.STRIPE_SECRET_KEY!
  const stripe = new Stripe(stripeKey, { apiVersion: '2026-06-24.dahlia' })

  const cur         = (terms.currency ?? 'EUR').toLowerCase()
  const contractId  = terms.contract_id ?? jobId ?? 'unknown'
  const isYearPricing = !!(terms.year_pricing && Object.keys(terms.year_pricing).length > 0)
  const { interval, intervalCount } = billingInterval(terms.billing_frequency)

  // ── 1. Upsert Stripe customer ────────────────────────────────────────────
  const emailInContact = terms.billing_contact?.match(/[^\s@]+@[^\s@]+\.[^\s@]+/)?.[0]
  const billingEmail   = emailInContact
    ?? `billing@${(terms.customer_name ?? 'customer').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.com`

  const safeName = (terms.customer_name ?? '').replace(/'/g, "\\'")
  const existing = safeName
    ? await stripe.customers.search({ query: `name:'${safeName}'`, limit: 1 }).catch(() => ({ data: [] }))
    : { data: [] }
  let customer = existing.data[0]
  const customerFields = {
    name:     terms.customer_name ?? undefined,
    email:    billingEmail,
    address:  terms.customer_address ? { line1: terms.customer_address } : undefined,
    metadata: { contract_id: contractId, source: 'verdix' },
  }
  customer = customer
    ? await stripe.customers.update(customer.id, customerFields)
    : await stripe.customers.create(customerFields)

  // ── 2. Provision Billing Meters + metered prices (one per usage type) ───
  const tiersByMetric = groupTiersByMetric(terms.overage_tiers ?? [])
  type MeteredItemDraft = { unit_type: string; meter_id: string; price_id: string }
  const meteredDrafts: MeteredItemDraft[] = []

  await Promise.all(
    [...tiersByMetric.entries()].map(async ([, tiers]) => {
      const unitType = tiers[0].unit_type ?? ''
      const meter    = await ensureStripeMeter(stripe, unitType)
      const price    = await createMeteredPrice(stripe, {
        meterId:       meter.id,
        currency:      cur,
        interval,
        intervalCount,
        contractId,
        unitType,
        jobId,
      })
      meteredDrafts.push({ unit_type: unitType, meter_id: meter.id, price_id: price.id })
    })
  )

  // ── 3. Base subscription price ───────────────────────────────────────────
  const baseMonthly = terms.base_monthly_fee ?? 0
  const baseAnnual  = terms.base_annual_fee ?? (terms.year_pricing?.['year1'] ?? 0)
  const baseAmount  = interval === 'year' ? baseAnnual : baseMonthly

  const basePrice = await createBasePrice(stripe, {
    amountCents:   Math.round(baseAmount * 100),
    currency:      cur,
    interval,
    intervalCount,
    contractId,
    customerName:  terms.customer_name ?? 'Customer',
    isYearPricing,
    jobId,
  })

  // ── 4. Create subscription ───────────────────────────────────────────────
  const subscriptionItems = [
    { price: basePrice.id },
    ...meteredDrafts.map(m => ({ price: m.price_id })),
  ]

  const subscription = await stripe.subscriptions.create({
    customer:           customer.id,
    items:              subscriptionItems,
    collection_method:  'send_invoice',
    days_until_due:     terms.payment_terms_days ?? 30,
    metadata: {
      contract_id:  contractId,
      created_by:   'verdix',
      ...(jobId ? { verdix_job_id: jobId } : {}),
    },
  })

  // ── 5. Persist billing_metered_items back to Supabase ───────────────────
  const stripeMeteredItems = meteredDrafts.map(draft => {
    const subItem = subscription.items.data.find(si => si.price.id === draft.price_id)
    return {
      unit_type:           draft.unit_type,
      meter_id:            draft.meter_id,
      price_id:            draft.price_id,
      subscription_item_id: subItem?.id ?? '',
    }
  })

  if (jobId && stripeMeteredItems.length > 0) {
    await supabaseServer
      .from('contract_terms')
      .update({ billing_metered_items: stripeMeteredItems })
      .eq('job_id', jobId)
  }

  // ── 6. Process the first subscription invoice inline ─────────────────────
  // Stripe fires invoice.created immediately when the subscription is created,
  // BEFORE the approve route can save billing_subscription_id to the DB.
  // The webhook handler therefore can't find the job and injects nothing.
  // To eliminate this race, we inject the Year 1 base fee here directly and
  // finalize the invoice. The webhook idempotency guard (computed_invoices)
  // will skip it if the event arrives later.
  const firstDraftInvoices = await stripe.invoices.list({
    subscription: subscription.id,
    limit: 1,
  })
  const firstInvoice = firstDraftInvoices.data[0]

  if (firstInvoice && firstInvoice.status === 'draft' && isYearPricing && terms.year_pricing && jobId) {
    const yp = terms.year_pricing
    const totalYears = Object.keys(yp).length
    const annualFee  = yp['year1'] ?? yp[`year${totalYears}`] ?? 0

    if (annualFee > 0) {
      const contractStart = terms.contract_start_date ? new Date(terms.contract_start_date) : new Date()
      const yearEnd = new Date(contractStart)
      yearEnd.setFullYear(yearEnd.getFullYear() + 1)
      yearEnd.setDate(yearEnd.getDate() - 1)
      const fmt = (d: Date) => d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
      const description = `Base subscription — Year 1 (${fmt(contractStart)} – ${fmt(yearEnd)})`

      await stripe.invoiceItems.create({
        customer:    customer.id,
        invoice:     firstInvoice.id,
        amount:      Math.round(annualFee * 100),
        currency:    cur,
        description,
      })

      // Persist to computed_invoices so the webhook's idempotency guard skips this invoice.
      supabaseServer.from('computed_invoices').insert({
        job_id:              jobId,
        external_invoice_id: firstInvoice.id,
        external_subscription_id: subscription.id,
        connector:           'stripe',
        period_start:        contractStart.toISOString(),
        period_end:          yearEnd.toISOString(),
        line_items:          [{ description, amount: annualFee, currency: terms.currency ?? 'EUR', type: 'base' }],
        total_amount:        annualFee,
        currency:            terms.currency ?? 'EUR',
        status:              'VALIDATED',
        validation_result:   [],
      }).then(({ error }) => {
        if (error) console.error('[billing-writer] computed_invoice insert failed', error)
      })

      // Finalize the invoice — makes it open and sends it to the customer.
      await stripe.invoices.finalizeInvoice(firstInvoice.id).catch(err =>
        console.error('[billing-writer] finalise failed', err)
      )
    }
  }

  // ── 6b. Pre-create draft invoices for future contract years ──────────────
  // Years 2, 3, etc. are created immediately as drafts (auto_advance: false)
  // so the full billing schedule is visible from day one. When each year's
  // anniversary arrives, the webhook finds this draft, injects overages, and
  // finalizes it — discarding Stripe's auto-generated subscription invoice.
  if (isYearPricing && terms.year_pricing && jobId) {
    const fmtLabel = (d: Date) => d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
    const contractStart = terms.contract_start_date ? new Date(terms.contract_start_date) : new Date()
    const daysUntilDue  = terms.payment_terms_days ?? 30

    await Promise.all(
      Object.entries(terms.year_pricing)
        .filter(([key]) => parseInt(key.replace('year', ''), 10) > 1)
        .map(async ([key, amount]) => {
          const yearNum = parseInt(key.replace('year', ''), 10)

          const yearStart = new Date(contractStart)
          yearStart.setFullYear(yearStart.getFullYear() + yearNum - 1)
          const yearEnd = new Date(yearStart)
          yearEnd.setFullYear(yearEnd.getFullYear() + 1)
          yearEnd.setDate(yearEnd.getDate() - 1)

          const description = `Base subscription — Year ${yearNum} (${fmtLabel(yearStart)} – ${fmtLabel(yearEnd)})`

          const draftInv = await stripe.invoices.create({
            customer:                       customer.id,
            collection_method:              'send_invoice',
            days_until_due:                 daysUntilDue,
            auto_advance:                   false,   // stay as draft until we finalize
            pending_invoice_items_behavior: 'exclude',
            metadata: {
              verdix_job:      jobId,
              verdix_contract: contractId,
              invoice_type:    'annual_base',
              year:            String(yearNum),
              scheduled_date:  yearStart.toISOString().slice(0, 10),
            },
          })

          await stripe.invoiceItems.create({
            customer:    customer.id,
            invoice:     draftInv.id,
            amount:      Math.round(amount * 100),
            currency:    cur,
            description,
            metadata:    { verdix_job: jobId, invoice_type: 'annual_base', year: String(yearNum) },
          })
        })
    )
  }

  // ── 7. Create standalone invoices for one-time fees ───────────────────────
  // Each fee gets its own Stripe invoice with the exact due date from the
  // contract. These are completely separate from the recurring subscription
  // invoices — the subscription handles base fees + overages only.
  type OneTimeFeeInput = { fee_label: string; amount: number; due_date?: string | null }
  const oneTimeFees = (terms.one_time_fees ?? []) as OneTimeFeeInput[]

  await Promise.all(
    oneTimeFees
      .filter(fee => fee.amount && fee.amount > 0)
      .map(async fee => {
        // days_until_due drives the due_date once the invoice is finalized.
        // Minimum 1 day so Stripe accepts it; past due dates become due tomorrow.
        const daysUntilDue = fee.due_date
          ? Math.max(1, Math.ceil((new Date(fee.due_date).getTime() - Date.now()) / 86_400_000))
          : (terms.payment_terms_days ?? 30)

        // Create draft invoice — exclude pending items so only this fee is on it.
        const oneTimeInv = await stripe.invoices.create({
          customer:                      customer.id,
          collection_method:             'send_invoice',
          days_until_due:                daysUntilDue,
          pending_invoice_items_behavior: 'exclude',
          metadata: {
            verdix_job:      jobId ?? '',
            verdix_contract: contractId,
            fee_type:        'one_time',
            fee_label:       fee.fee_label,
          },
        })

        // Attach the line item to this specific invoice.
        await stripe.invoiceItems.create({
          customer:    customer.id,
          invoice:     oneTimeInv.id,
          amount:      Math.round(fee.amount * 100),
          currency:    cur,
          description: fee.fee_label,
          metadata:    { verdix_job: jobId ?? '', fee_type: 'one_time' },
        })

        // Finalize → status becomes "open", due_date is set, email sent to customer.
        await stripe.invoices.finalizeInvoice(oneTimeInv.id)

        // Record in computed_invoices so it appears in the Processed invoices tab.
        // Webhook skips standalone invoices (no subscription ref), so we persist inline.
        if (jobId) {
          const dueDate = fee.due_date ? new Date(fee.due_date).toISOString() : new Date().toISOString()
          supabaseServer.from('computed_invoices').insert({
            job_id:              jobId,
            external_invoice_id: oneTimeInv.id,
            connector:           'stripe',
            period_start:        dueDate,
            period_end:          dueDate,
            line_items:          [{ description: fee.fee_label, amount: fee.amount, currency: terms.currency ?? 'EUR', type: 'one_time' }],
            total_amount:        fee.amount,
            currency:            terms.currency ?? 'EUR',
            status:              'VALIDATED',
            validation_result:   [],
          }).then(({ error }) => {
            if (error) console.error('[billing-writer] one-time computed_invoice insert failed', error)
          })
        }
      })
  )

  const isTest     = !subscription.livemode
  const dashboardUrl = `https://dashboard.stripe.com/${isTest ? 'test/' : ''}subscriptions/${subscription.id}`

  return {
    platform:      'stripe',
    subscriptionId: subscription.id,
    customerId:    customer.id,
    lineItemCount: subscriptionItems.length + oneTimeFees.filter(f => f.amount > 0).length,
    dashboardUrl,
  }
}

async function configureChargebee(terms: ContractTerms, lineItems: LineItemInput[], jobId?: string, orgId?: string): Promise<ConfigureResult> {
  // Chargebee REST API — using native fetch
  const orgConfig = orgId ? await getOrgConfig(orgId, 'chargebee') : null
  const site   = orgConfig?.site    ?? process.env.CHARGEBEE_SITE!
  const apiKey = orgConfig?.api_key ?? process.env.CHARGEBEE_API_KEY!
  const base = `https://${site}.chargebee.com/api/v2`
  const headers = {
    'Authorization': `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  }

  // Create/find customer
  const customerRes = await fetch(`${base}/customers`, {
    method: 'POST',
    headers,
    body: new URLSearchParams({
      'first_name': terms.customer_name ?? 'Unknown',
      'cf_contract_id': terms.contract_id ?? '',
      'cf_source': 'verdix',
      ...(jobId ? { 'cf_revlens_job_id': jobId } : {}),
    }).toString(),
  })
  const customerData = await customerRes.json()
  const customerId = customerData.customer?.id

  // Create subscription
  const params = new URLSearchParams({ 'customer_id': customerId })
  lineItems.forEach((item, i) => {
    params.append(`subscription_items[item_price_id][${i}]`, item.product_name.toLowerCase().replace(/\s+/g, '-'))
    params.append(`subscription_items[quantity][${i}]`, String(item.quantity))
    params.append(`subscription_items[unit_price][${i}]`, String(Math.round(item.unit_price * 100)))
  })

  const subRes = await fetch(`${base}/subscriptions/create_with_items/${customerId}`, {
    method: 'POST',
    headers,
    body: params.toString(),
  })
  const subData = await subRes.json()
  const subscriptionId = subData.subscription?.id ?? 'unknown'

  return {
    platform: 'chargebee',
    subscriptionId,
    customerId,
    lineItemCount: lineItems.length,
    dashboardUrl: `https://${site}.chargebee.com/subscriptions/${subscriptionId}`,
  }
}

function detectPlatform(): BillingPlatform {
  if (process.env.CHARGEBEE_API_KEY) return 'chargebee'
  return 'stripe'
}
