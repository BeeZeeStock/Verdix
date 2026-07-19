import { ContractTerms } from './types'
import {
  ensureStripeMeter,
  createMeteredPrice,
  createBasePrice,
  billingInterval,
  periodsPerYear,
} from './stripe-meter'
import { groupTiersByMetric } from './tariff'
import { supabaseServer } from './supabase'

// Compute the total subscription amount for each contract year (base + additional,
// discounts and escalators applied month-by-month). Used to pre-create annual
// commitment draft invoices that make the full TCV visible in Stripe on day 1.
function computeYearlyAmounts(terms: ContractTerms): number[] {
  const termMonths = terms.contract_term_months ?? 0
  if (!termMonths) return []

  const numYears          = Math.ceil(termMonths / 12)
  const yearPricing       = terms.year_pricing
  const rampSchedule      = terms.ramp_schedule && terms.ramp_schedule.length > 0
    ? terms.ramp_schedule : null
  const baseMonthly       = terms.base_monthly_fee ?? 0
  const additionalMonthly = (terms.additional_recurring_fees ?? [])
    .reduce((s, f) => s + (f.amount ?? 0), 0)
  const escalators        = terms.escalators ?? []
  const discounts         = terms.discounts  ?? []
  const cs = terms.contract_start_date ? new Date(terms.contract_start_date) : new Date()

  function monthlyBase(idx: number, d: Date): number {
    if (rampSchedule) {
      for (const step of rampSchedule) {
        const s = new Date(step.start_date), e = new Date(step.end_date)
        if (d >= s && d <= e) return step.monthly_fee
      }
      return rampSchedule[rampSchedule.length - 1].monthly_fee
    }
    if (yearPricing) {
      const yr  = Math.floor(idx / 12) + 1
      const key = `year${yr}`
      const keys = Object.keys(yearPricing)
      return (yearPricing[key] ?? yearPricing[keys[keys.length - 1]] ?? 0) / 12
    }
    return baseMonthly
  }

  return Array.from({ length: numYears }, (_, yi) => {
    const monthsInYear = Math.min(12, termMonths - yi * 12)
    let total = 0
    for (let mi = 0; mi < monthsInYear; mi++) {
      const idx = yi * 12 + mi
      const d   = new Date(cs.getFullYear(), cs.getMonth() + idx, 1)
      const base = monthlyBase(idx, d)

      // Compound escalation (suppressed when year_pricing or ramp_schedule encodes rates)
      let mult = 1
      if (!yearPricing && !rampSchedule) {
        for (const esc of escalators) {
          const ed = esc.effective_date ? new Date(esc.effective_date) : null
          if (ed && d >= ed) {
            const ms = (d.getFullYear() - ed.getFullYear()) * 12 + (d.getMonth() - ed.getMonth())
            mult = Math.pow(1 + (esc.escalator_pct ?? 0) / 100, Math.floor(ms / 12) + 1)
            break
          }
        }
      }

      let amount = (base + additionalMonthly) * mult
      for (const disc of discounts) {
        const ds = disc.start_date ? new Date(disc.start_date) : null
        const de = disc.end_date   ? new Date(disc.end_date)   : null
        if (ds && de && d >= ds && d <= de && disc.discount_pct) {
          amount *= 1 - disc.discount_pct / 100
          break
        }
      }
      total += amount
    }
    return total
  })
}

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

  const cur             = (terms.currency ?? 'EUR').toLowerCase()
  const contractId      = terms.contract_id ?? jobId ?? 'unknown'
  // hasYearRates: contract has per-year rate differentials (escalator/ramp).
  // This is INDEPENDENT of billing cadence — a monthly contract can have year pricing.
  const hasYearRates    = !!(terms.year_pricing && Object.keys(terms.year_pricing).length > 0)
  const { interval, intervalCount } = billingInterval(terms.billing_frequency)
  const isAnnualBilling = interval === 'year'
  const ppy             = periodsPerYear(interval, intervalCount) // periods per year
  // isFiniteContract: contract has a defined term that ends — as opposed to an open-ended
  // auto-renewing contract. Finite contracts get cancel_at on the subscription and
  // pre-created annual commitment draft invoices so TCV is visible from day one.
  const isFiniteContract = !!(terms.contract_term_months && terms.contract_term_months > 0)

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
  // When hasYearRates: set price to $0 — billing-writer (first invoice) and
  // the webhook (subsequent invoices) inject the correct period amount directly.
  // When flat-rate: use the actual periodic amount so Stripe handles it natively.
  const baseMonthly = terms.base_monthly_fee ?? 0
  const baseAnnual  = terms.base_annual_fee ?? (terms.year_pricing?.['year1'] ?? 0)
  const baseAmount  = hasYearRates
    ? 0
    : isAnnualBilling
      ? baseAnnual
      : baseMonthly * intervalCount  // monthly→×1, quarterly→×3, semi-annual→×6

  const basePrice = await createBasePrice(stripe, {
    amountCents:   Math.round(baseAmount * 100),
    currency:      cur,
    interval,
    intervalCount,
    contractId,
    customerName:  terms.customer_name ?? 'Customer',
    isYearPricing: hasYearRates,
    jobId,
  })

  // ── 3b. Additional recurring fee prices ─────────────────────────────────
  // Each additional recurring fee (e.g. Dedicated Support) becomes its own
  // Stripe subscription item at its stated periodic amount.
  const additionalFees = terms.additional_recurring_fees ?? []
  const additionalPrices = await Promise.all(
    additionalFees
      .filter(f => f.amount > 0)
      .map(fee =>
        stripe.prices.create({
          currency:    cur,
          unit_amount: Math.round(fee.amount * intervalCount * 100),
          recurring:   { interval, interval_count: intervalCount },
          product_data: { name: `${fee.fee_label} — ${contractId}` },
          metadata: { verdix_contract: contractId, fee_type: 'additional_recurring', ...(jobId ? { verdix_job_id: jobId } : {}) },
        })
      )
  )

  // ── 4. Create subscription ───────────────────────────────────────────────
  const subscriptionItems = [
    { price: basePrice.id },
    ...additionalPrices.map(p => ({ price: p.id })),
    ...meteredDrafts.map(m => ({ price: m.price_id })),
  ]

  const subscription = await stripe.subscriptions.create({
    customer:           customer.id,
    items:              subscriptionItems,
    collection_method:  'send_invoice',
    days_until_due:     terms.payment_terms_days ?? 30,
    // For finite contracts: cancel the subscription at contract end so it doesn't
    // auto-renew indefinitely. Auto-renewing contracts get a new subscription per term.
    ...(isFiniteContract && terms.contract_end_date
      ? { cancel_at: Math.floor(new Date(terms.contract_end_date).getTime() / 1000) }
      : {}),
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

  if (firstInvoice && firstInvoice.status === 'draft' && hasYearRates && terms.year_pricing && jobId) {
    const yp         = terms.year_pricing
    const annualFeeY1 = yp['year1'] ?? yp[Object.keys(yp)[0]] ?? 0

    if (annualFeeY1 > 0) {
      const contractStart  = terms.contract_start_date ? new Date(terms.contract_start_date) : new Date()
      const invPeriodStart = new Date((firstInvoice.period_start ?? 0) * 1000)
      const invPeriodEnd   = new Date((firstInvoice.period_end   ?? 0) * 1000)
      const fmt            = (d: Date) => d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })

      let injectAmount: number
      let description: string

      if (isAnnualBilling) {
        // Annual: one invoice covers a full contract year
        const yearEnd = new Date(contractStart)
        yearEnd.setFullYear(yearEnd.getFullYear() + 1)
        yearEnd.setDate(yearEnd.getDate() - 1)
        injectAmount = annualFeeY1
        description  = `Base subscription — Year 1 (${fmt(contractStart)} – ${fmt(yearEnd)})`
      } else {
        // Monthly / quarterly / semi-annual: pro-rate the year 1 annual fee
        injectAmount = annualFeeY1 / ppy
        description  = `Base subscription — ${fmt(invPeriodStart)} – ${fmt(invPeriodEnd)}`
      }

      await stripe.invoiceItems.create({
        customer:    customer.id,
        invoice:     firstInvoice.id,
        amount:      Math.round(injectAmount * 100),
        currency:    cur,
        description,
      })

      // Persist to computed_invoices so the webhook's idempotency guard skips this invoice.
      supabaseServer.from('computed_invoices').insert({
        job_id:                   jobId,
        external_invoice_id:      firstInvoice.id,
        external_subscription_id: subscription.id,
        connector:                'stripe',
        period_start:             invPeriodStart.toISOString(),
        period_end:               invPeriodEnd.toISOString(),
        line_items:               [{ description, amount: injectAmount, currency: terms.currency ?? 'EUR', type: 'base' }],
        total_amount:             injectAmount,
        currency:                 terms.currency ?? 'EUR',
        status:                   'VALIDATED',
        validation_result:        [],
      }).then(({ error }) => {
        if (error) console.error('[billing-writer] computed_invoice insert failed', error)
      })

      // Finalize the invoice — makes it open and sends it to the customer.
      await stripe.invoices.finalizeInvoice(firstInvoice.id).catch(err =>
        console.error('[billing-writer] finalise failed', err)
      )
    }
  }

  // ── 6b. Pre-create annual commitment draft invoices ─────────────────────────
  // Annual billing (year_pricing): pre-create Year 2, 3, … as drafts. The webhook
  // redirects Stripe's auto-generated anniversary invoice into the pre-created draft.
  //
  // Monthly/sub-annual finite contracts: pre-create ALL years (including Year 1) as
  // commitment drafts (auto_advance:false — internal visibility only, not sent to the
  // customer). This makes the full contracted TCV visible in Stripe from day one.
  // The subscription still handles actual monthly billing; these drafts represent
  // the annual commitment for each year of the contract.
  const fmtLabel      = (d: Date) => d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
  const contractStart = terms.contract_start_date ? new Date(terms.contract_start_date) : new Date()
  const daysUntilDue  = terms.payment_terms_days ?? 30

  if (isAnnualBilling && hasYearRates && terms.year_pricing && jobId) {
    // Annual billing path — Year 2+ drafts (Year 1 was handled inline in step 6)
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
            auto_advance:                   false,
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
  } else if (!isAnnualBilling && isFiniteContract && jobId) {
    // Monthly/sub-annual finite contract path — commitment drafts for ALL years
    const yearlyAmounts = computeYearlyAmounts(terms)
    await Promise.all(
      yearlyAmounts.map(async (amount, yi) => {
        const yearNum   = yi + 1
        const yearStart = new Date(contractStart)
        yearStart.setFullYear(yearStart.getFullYear() + yi)
        const yearEnd   = new Date(yearStart)
        yearEnd.setFullYear(yearEnd.getFullYear() + 1)
        yearEnd.setDate(yearEnd.getDate() - 1)
        const description = `Base subscription — Year ${yearNum} (${fmtLabel(yearStart)} – ${fmtLabel(yearEnd)})`

        const draftInv = await stripe.invoices.create({
          customer:                       customer.id,
          collection_method:              'send_invoice',
          days_until_due:                 daysUntilDue,
          auto_advance:                   false,
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
      })
  )

  const isTest     = !subscription.livemode
  const dashboardUrl = `https://dashboard.stripe.com/${isTest ? 'test/' : ''}subscriptions/${subscription.id}`

  return {
    platform:       'stripe',
    subscriptionId: subscription.id,
    customerId:     customer.id,
    lineItemCount:  subscriptionItems.length + oneTimeFees.filter(f => f.amount > 0).length,
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
