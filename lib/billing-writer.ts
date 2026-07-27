import { ContractTerms } from './types'
import { billingInterval } from './stripe-meter'
import { supabaseServer } from './supabase'

// Compute all billing periods for the contract term with their base amounts
// (base fee + additional recurring fees, no overages). Used at push time to
// populate planned_invoices and by the scheduler to understand the schedule.
interface BillingPeriod {
  yearNum: number
  periodIndex: number
  periodStart: Date
  periodEnd: Date
  baseAmount: number
}

function computeBillingSchedule(terms: ContractTerms): BillingPeriod[] {
  const termMonths = terms.contract_term_months ?? 0
  if (!termMonths) return []

  const { interval, intervalCount } = billingInterval(terms.billing_frequency)
  const monthsPerPeriod = interval === 'year' ? 12 * intervalCount : intervalCount

  const cs = terms.contract_start_date
    ? new Date(terms.contract_start_date + 'T00:00:00')
    : new Date()

  const yearPricing  = terms.year_pricing
  const rampSchedule = terms.ramp_schedule?.length ? terms.ramp_schedule : null

  const baseAnnualFallback = terms.base_annual_fee ?? 0
  const baseMonthly = terms.base_monthly_fee
    ?? (baseAnnualFallback > 0 && !yearPricing && !rampSchedule ? baseAnnualFallback / 12 : 0)

  const additionalMonthly = (terms.additional_recurring_fees ?? [])
    .reduce((s, f) => s + (f.amount ?? 0), 0)

  const escalators = terms.escalators ?? []
  const discounts  = terms.discounts  ?? []

  function monthlyBase(globalMonthIdx: number, d: Date): number {
    if (rampSchedule) {
      for (const step of rampSchedule) {
        const s = new Date(step.start_date), e = new Date(step.end_date)
        if (d >= s && d <= e) return step.monthly_fee
      }
      return rampSchedule[rampSchedule.length - 1].monthly_fee
    }
    if (yearPricing) {
      const yr   = Math.floor(globalMonthIdx / 12) + 1
      const key  = `year${yr}`
      const keys = Object.keys(yearPricing)
      return (yearPricing[key] ?? yearPricing[keys[keys.length - 1]] ?? 0) / 12
    }
    return baseMonthly
  }

  const periods: BillingPeriod[] = []
  let periodIdx  = 0
  let monthsUsed = 0

  while (monthsUsed < termMonths) {
    const monthsInThisPeriod = Math.min(monthsPerPeriod, termMonths - monthsUsed)

    const periodStart = new Date(
      cs.getFullYear(),
      cs.getMonth() + monthsUsed,
      cs.getDate(),
    )
    const nextStart = new Date(
      cs.getFullYear(),
      cs.getMonth() + monthsUsed + monthsInThisPeriod,
      cs.getDate(),
    )
    const periodEnd = new Date(nextStart.getTime() - 86_400_000)

    const yearNum = Math.floor(monthsUsed / 12) + 1

    let baseAmount = 0
    for (let mi = 0; mi < monthsInThisPeriod; mi++) {
      const globalMonthIdx = monthsUsed + mi
      const d    = new Date(cs.getFullYear(), cs.getMonth() + globalMonthIdx, 1)
      const base = monthlyBase(globalMonthIdx, d)

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

      baseAmount += amount
    }

    periods.push({ yearNum, periodIndex: periodIdx, periodStart, periodEnd, baseAmount })
    periodIdx++
    monthsUsed += monthsInThisPeriod
  }

  return periods
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
  subscriptionId: string | null
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

async function configureStripe(
  terms: ContractTerms,
  lineItems: LineItemInput[],
  jobId?: string,
  orgId?: string,
): Promise<ConfigureResult> {
  const { default: Stripe } = await import('stripe')
  const orgConfig = orgId ? await getOrgConfig(orgId, 'stripe') : null
  const stripeKey = orgConfig?.secret_key ?? process.env.STRIPE_SECRET_KEY!
  const stripe    = new Stripe(stripeKey, { apiVersion: '2026-06-24.dahlia' })

  const cur         = (terms.currency ?? 'EUR').toLowerCase()
  const contractId  = terms.contract_id ?? jobId ?? 'unknown'
  const daysUntilDue = terms.payment_terms_days ?? 30
  const now          = new Date()

  // ── 1. Upsert Stripe customer ───────────────────────────────────────────────
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

  const isTest = !customer.livemode

  // ── 2. Compute full billing schedule ────────────────────────────────────────
  const periods = computeBillingSchedule(terms)

  const fmtLabel  = (d: Date) => d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
  const formatDate = (d: Date) => {
    const y   = d.getFullYear()
    const mo  = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${mo}-${day}`
  }

  type PlannedRow = {
    job_id?: string; org_id?: string
    year_num: number | null; period_start: string; period_end: string
    base_amount: number; currency: string; fee_label: string | null
    invoice_type: string; status: string
    stripe_invoice_id: string | null; stripe_invoice_url: string | null
    sent_at: string | null
  }
  const plannedRows: PlannedRow[] = []

  // ── 3. Send immediately-due period invoices; queue future ones ──────────────
  for (const period of periods) {
    const isDue = period.periodStart <= now

    const description = `Base subscription — Year ${period.yearNum} (${fmtLabel(period.periodStart)} – ${fmtLabel(period.periodEnd)})`

    if (isDue && period.baseAmount > 0) {
      const inv = await stripe.invoices.create({
        customer:                       customer.id,
        collection_method:              'send_invoice',
        days_until_due:                 daysUntilDue,
        pending_invoice_items_behavior: 'exclude',
        metadata: {
          verdix_job:      jobId ?? '',
          verdix_contract: contractId,
          invoice_type:    'period',
          year:            String(period.yearNum),
          scheduled_date:  formatDate(period.periodStart),
        },
      })

      await stripe.invoiceItems.create({
        customer:    customer.id,
        invoice:     inv.id,
        amount:      Math.round(period.baseAmount * 100),
        currency:    cur,
        description,
      })

      const finalized = await stripe.invoices.finalizeInvoice(inv.id).catch(err => {
        console.error('[billing-writer] finalizeInvoice failed', err)
        return inv
      })

      plannedRows.push({
        year_num:          period.yearNum,
        period_start:      formatDate(period.periodStart),
        period_end:        formatDate(period.periodEnd),
        base_amount:       period.baseAmount,
        currency:          terms.currency ?? 'EUR',
        fee_label:         null,
        invoice_type:      'period',
        status:            'sent',
        stripe_invoice_id: inv.id,
        stripe_invoice_url: finalized.hosted_invoice_url ?? null,
        sent_at:           new Date().toISOString(),
      })
    } else {
      plannedRows.push({
        year_num:          period.yearNum,
        period_start:      formatDate(period.periodStart),
        period_end:        formatDate(period.periodEnd),
        base_amount:       period.baseAmount,
        currency:          terms.currency ?? 'EUR',
        fee_label:         null,
        invoice_type:      'period',
        status:            period.baseAmount > 0 ? 'scheduled' : 'scheduled',
        stripe_invoice_id: null,
        stripe_invoice_url: null,
        sent_at:           null,
      })
    }
  }

  // ── 4. One-time fees: immediately-due → Stripe now; future → planned row ─────
  type OneTimeFeeInput = { fee_label: string; amount: number; due_date?: string | null }
  const oneTimeFees = (terms.one_time_fees ?? []) as OneTimeFeeInput[]

  for (const fee of oneTimeFees.filter(f => f.amount > 0)) {
    const feeDueDate = fee.due_date ? new Date(fee.due_date + 'T00:00:00') : null
    const isDue      = !feeDueDate || feeDueDate <= now

    if (isDue) {
      const netDays         = terms.payment_terms_days ?? 30
      const feeDueDaysFromNow = feeDueDate
        ? Math.ceil((feeDueDate.getTime() - Date.now()) / 86_400_000)
        : 0
      const days = feeDueDaysFromNow > 1 ? feeDueDaysFromNow : netDays

      const oneTimeInv = await stripe.invoices.create({
        customer:                       customer.id,
        collection_method:              'send_invoice',
        days_until_due:                 days,
        pending_invoice_items_behavior: 'exclude',
        metadata: {
          verdix_job:      jobId ?? '',
          verdix_contract: contractId,
          fee_type:        'one_time',
          fee_label:       fee.fee_label,
          invoice_type:    'one_time',
          scheduled_date:  formatDate(feeDueDate ?? now),
        },
      })

      await stripe.invoiceItems.create({
        customer:    customer.id,
        invoice:     oneTimeInv.id,
        amount:      Math.round(fee.amount * 100),
        currency:    cur,
        description: fee.fee_label,
      })

      const finalized = await stripe.invoices.finalizeInvoice(oneTimeInv.id).catch(err => {
        console.error('[billing-writer] one-time finalizeInvoice failed', err)
        return oneTimeInv
      })

      const dueDateStr = formatDate(feeDueDate ?? now)
      plannedRows.push({
        year_num:           null,
        period_start:       dueDateStr,
        period_end:         dueDateStr,
        base_amount:        fee.amount,
        currency:           terms.currency ?? 'EUR',
        fee_label:          fee.fee_label,
        invoice_type:       'one_time',
        status:             'sent',
        stripe_invoice_id:  oneTimeInv.id,
        stripe_invoice_url: finalized.hosted_invoice_url ?? null,
        sent_at:            new Date().toISOString(),
      })
    } else {
      const dueDateStr = formatDate(feeDueDate!)
      plannedRows.push({
        year_num:           null,
        period_start:       dueDateStr,
        period_end:         dueDateStr,
        base_amount:        fee.amount,
        currency:           terms.currency ?? 'EUR',
        fee_label:          fee.fee_label,
        invoice_type:       'one_time',
        status:             'scheduled',
        stripe_invoice_id:  null,
        stripe_invoice_url: null,
        sent_at:            null,
      })
    }
  }

  // ── 5. Persist planned rows ──────────────────────────────────────────────────
  if (jobId && plannedRows.length > 0) {
    const { error } = await supabaseServer
      .from('planned_invoices')
      .insert(plannedRows.map(r => ({ ...r, job_id: jobId, org_id: orgId })))
    if (error) console.error('[billing-writer] planned_invoices insert failed', error)
  }

  const dashboardUrl = `https://dashboard.stripe.com/${isTest ? 'test/' : ''}customers/${customer.id}`

  return {
    platform:       'stripe',
    subscriptionId: null,
    customerId:     customer.id,
    lineItemCount:  periods.length + oneTimeFees.filter(f => f.amount > 0).length,
    dashboardUrl,
  }
}

async function configureChargebee(
  terms: ContractTerms,
  lineItems: LineItemInput[],
  jobId?: string,
  orgId?: string,
): Promise<ConfigureResult> {
  const orgConfig = orgId ? await getOrgConfig(orgId, 'chargebee') : null
  const site   = orgConfig?.site    ?? process.env.CHARGEBEE_SITE!
  const apiKey = orgConfig?.api_key ?? process.env.CHARGEBEE_API_KEY!
  const base = `https://${site}.chargebee.com/api/v2`
  const headers = {
    'Authorization': `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  }

  const customerRes = await fetch(`${base}/customers`, {
    method: 'POST',
    headers,
    body: new URLSearchParams({
      'first_name':     terms.customer_name ?? 'Unknown',
      'cf_contract_id': terms.contract_id   ?? '',
      'cf_source':      'verdix',
      ...(jobId ? { 'cf_revlens_job_id': jobId } : {}),
    }).toString(),
  })
  const customerData = await customerRes.json()
  const customerId   = customerData.customer?.id

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
  const subData      = await subRes.json()
  const subscriptionId = subData.subscription?.id ?? 'unknown'

  return {
    platform:       'chargebee',
    subscriptionId,
    customerId,
    lineItemCount:  lineItems.length,
    dashboardUrl:   `https://${site}.chargebee.com/subscriptions/${subscriptionId}`,
  }
}

function detectPlatform(): BillingPlatform {
  if (process.env.CHARGEBEE_API_KEY) return 'chargebee'
  return 'stripe'
}

// Re-export computeBillingSchedule for use by the invoice scheduler
export { computeBillingSchedule }
export type { BillingPeriod }
