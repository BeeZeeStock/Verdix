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
  platform: BillingPlatform = detectPlatform(),
  jobId?: string
): Promise<ConfigureResult> {
  if (platform === 'chargebee') {
    return configureChargebee(terms, lineItems, jobId)
  }
  return configureStripe(terms, lineItems, jobId)
}

async function configureStripe(terms: ContractTerms, lineItems: LineItemInput[], jobId?: string): Promise<ConfigureResult> {
  const { default: Stripe } = await import('stripe')
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-06-24.dahlia' })

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
  // Map subscription item IDs to their meter/price records
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

  const isTest     = !subscription.livemode
  const dashboardUrl = `https://dashboard.stripe.com/${isTest ? 'test/' : ''}subscriptions/${subscription.id}`

  return {
    platform:      'stripe',
    subscriptionId: subscription.id,
    customerId:    customer.id,
    lineItemCount: subscriptionItems.length,
    dashboardUrl,
  }
}

async function configureChargebee(terms: ContractTerms, lineItems: LineItemInput[], jobId?: string): Promise<ConfigureResult> {
  // Chargebee REST API — using native fetch
  const site = process.env.CHARGEBEE_SITE!
  const apiKey = process.env.CHARGEBEE_API_KEY!
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
