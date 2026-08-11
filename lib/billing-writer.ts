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

// Which rate applies to a given month — ramp schedule → year pricing → flat
// base fee, in that priority order. No escalation, no additions, no discount;
// callers compose those on top. Exported so buildLineItems() (contract
// execute route) can generate real per-year recurring-fee line items using
// the exact same rate logic as the actual billing schedule, instead of a
// separate, potentially-inconsistent approximation.
export function computeMonthlyBaseRate(terms: ContractTerms, globalMonthIdx: number, d: Date): number {
  const yearPricing  = terms.year_pricing
  const rampSchedule = terms.ramp_schedule?.length ? terms.ramp_schedule : null
  const baseAnnualFallback = terms.base_annual_fee ?? 0
  const baseMonthly = terms.base_monthly_fee
    ?? (baseAnnualFallback > 0 && !yearPricing && !rampSchedule ? baseAnnualFallback / 12 : 0)

  if (rampSchedule) {
    for (const step of rampSchedule) {
      // Bare date-only strings ("2024-04-01") parse as UTC midnight, while d
      // (the per-month cursor, built via `new Date(y, m, 1)`) is local
      // midnight — in any timezone east of UTC those disagree by several
      // hours, so the *first* day of every ramp step failed its own
      // `d >= s` check and silently fell through to the wrong rate.
      // Anchoring both to local midnight keeps this correct regardless of
      // which timezone the code happens to run in.
      const s = new Date(step.start_date + 'T00:00:00'), e = new Date(step.end_date + 'T00:00:00')
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

// Compound escalation multiplier for a given month. Only applies when neither
// ramp_schedule nor year_pricing is set (those already encode their own
// step-ups). Exported alongside computeMonthlyBaseRate for the same reason.
export function computeEscalatorMultiplier(terms: ContractTerms, d: Date): number {
  if (terms.year_pricing || terms.ramp_schedule?.length) return 1
  for (const esc of terms.escalators ?? []) {
    const ed = esc.effective_date ? new Date(esc.effective_date + 'T00:00:00') : null
    if (ed && d >= ed) {
      const ms = (d.getFullYear() - ed.getFullYear()) * 12 + (d.getMonth() - ed.getMonth())
      return Math.pow(1 + (esc.escalator_pct ?? 0) / 100, Math.floor(ms / 12) + 1)
    }
  }
  return 1
}

function computeBillingSchedule(terms: ContractTerms): BillingPeriod[] {
  const cs = terms.contract_start_date
    ? new Date(terms.contract_start_date + 'T00:00:00')
    : new Date()

  // Prefer explicit term months; fall back to computing from start/end dates.
  let termMonths = terms.contract_term_months ?? 0
  if (!termMonths && terms.contract_end_date) {
    const ce = new Date(terms.contract_end_date + 'T00:00:00')
    termMonths = (ce.getFullYear() - cs.getFullYear()) * 12 + (ce.getMonth() - cs.getMonth()) + 1
  }
  if (!termMonths) return []

  const { interval, intervalCount } = billingInterval(terms.billing_frequency)
  const monthsPerPeriod = interval === 'year' ? 12 * intervalCount : intervalCount

  const additionalMonthly = (terms.additional_recurring_fees ?? [])
    .reduce((s, f) => s + (f.amount ?? 0), 0)

  const discounts = terms.discounts ?? []

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
      const base = computeMonthlyBaseRate(terms, globalMonthIdx, d)
      const mult = computeEscalatorMultiplier(terms, d)

      let amount = (base + additionalMonthly) * mult

      for (const disc of discounts) {
        // Same local-midnight anchoring as computeMonthlyBaseRate's ramp
        // dates above — a bare date-only string parses as UTC midnight,
        // which disagrees with d's local-midnight construction east of UTC.
        const ds = disc.start_date ? new Date(disc.start_date + 'T00:00:00') : null
        const de = disc.end_date   ? new Date(disc.end_date   + 'T00:00:00') : null
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

export type BillingPlatform = 'stripe' | 'chargebee' | 'remembill'

export async function getOrgConfig(orgId: string, connector: string): Promise<Record<string, string> | null> {
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
  // Only a fallback for a job that's never been configured before — approve
  // always passes the job's own already-known platform when one exists, so
  // this only runs on first configuration. Still, an org can have more than
  // one active billing connector (e.g. testing a migration), and without an
  // explicit priority the previous .limit(1) picked whichever row Postgres
  // happened to return first — non-deterministic. Fetch all and apply a
  // fixed, explicit priority instead.
  const { data } = await supabaseServer
    .from('org_integrations')
    .select('connector_name')
    .eq('org_id', orgId)
    .eq('connector_type', 'billing')
    .eq('is_active', true)
  const active = new Set((data ?? []).map(r => r.connector_name as string))
  if (active.has('chargebee')) return 'chargebee'
  if (active.has('remembill')) return 'remembill'
  return 'stripe'
}

export interface LineItemInput {
  id?: string
  product_name: string
  quantity: number
  unit_price: number
  billing_period: string
  total_amount: number
  currency: string
  source_section?: string
}

// One-time fees are matched to their approved line_items row by product_name
// (buildLineItems sets product_name = fee_label for one-time fees). Falls
// back to null (caller uses the raw contract-terms amount) when not found —
// e.g. a fee added to the contract after line_items was last generated.
function findOneTimeLineItem(lineItems: LineItemInput[], feeLabel: string): LineItemInput | null {
  return lineItems.find(li => li.billing_period === 'one_time' && li.product_name === feeLabel) ?? null
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
  orgId?: string,
  existingCustomerId?: string,
): Promise<ConfigureResult> {
  const resolved = platform ?? (orgId ? await detectOrgPlatform(orgId) : detectPlatform())
  if (resolved === 'chargebee')  return configureChargebee(terms, lineItems, jobId, orgId)
  if (resolved === 'remembill')  return configureRememhill(terms, lineItems, jobId, orgId, existingCustomerId)
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
    line_item_id?: string | null; quantity?: number | null; unit_price?: number | null
  }
  const plannedRows: PlannedRow[] = []

  // Idempotent repush: carry forward already-sent invoices unchanged, and
  // clear stale not-yet-sent rows before regenerating — otherwise every
  // repush (e.g. re-syncing edited terms, or a platform switch) both
  // creates a second real Stripe invoice for any period that's already due
  // and leaves the first set of planned_invoices rows in place, duplicating
  // the billing schedule. Mirrors configureRememhill's existing pattern.
  type ExistingSentRow = {
    year_num: number | null
    period_start: string; period_end: string
    invoice_type: string; fee_label: string | null
    stripe_invoice_id: string | null; stripe_invoice_url: string | null
    base_amount: number; currency: string
    sent_at: string | null; status: string
  }
  let sentRows: ExistingSentRow[] = []
  if (jobId) {
    const { data: sent } = await supabaseServer
      .from('planned_invoices')
      .select('year_num, period_start, period_end, invoice_type, fee_label, stripe_invoice_id, stripe_invoice_url, base_amount, currency, sent_at, status')
      .eq('job_id', jobId)
      .in('status', ['sent', 'paid'])
    sentRows = (sent ?? []) as ExistingSentRow[]

    const { error: cleanErr } = await supabaseServer
      .from('planned_invoices')
      .delete()
      .eq('job_id', jobId)
      .in('status', ['scheduled', 'parked', 'processing', 'draft'])
    if (cleanErr) console.error('[billing-writer/stripe] stale planned_invoices cleanup failed', cleanErr)
  }

  // ── 3. Send immediately-due period invoices; queue future ones ──────────────
  for (const period of periods) {
    const periodStartStr = formatDate(period.periodStart)
    const alreadySent = sentRows.find(
      r => r.invoice_type === 'period' && r.year_num === period.yearNum && r.period_start === periodStartStr,
    )
    if (alreadySent) {
      plannedRows.push({
        year_num: alreadySent.year_num, period_start: alreadySent.period_start, period_end: alreadySent.period_end,
        base_amount: alreadySent.base_amount, currency: alreadySent.currency, fee_label: null,
        invoice_type: 'period', status: alreadySent.status,
        stripe_invoice_id: alreadySent.stripe_invoice_id, stripe_invoice_url: alreadySent.stripe_invoice_url,
        sent_at: alreadySent.sent_at,
      })
      continue
    }

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
  type OneTimeFeeInput = {
    fee_label: string
    amount: number
    due_date?: string | null
    manual_trigger?: boolean
    metric_name?: string | null
    rate_per_unit?: number | null
  }
  const oneTimeFees = (terms.one_time_fees ?? []) as OneTimeFeeInput[]

  // Park manual-trigger service fees — they need human confirmation before invoicing
  for (const fee of oneTimeFees.filter(f => f.manual_trigger)) {
    const alreadySent = sentRows.find(r => r.invoice_type === 'one_time' && r.fee_label === fee.fee_label)
    if (alreadySent) {
      plannedRows.push({
        year_num: null, period_start: alreadySent.period_start, period_end: alreadySent.period_end,
        base_amount: alreadySent.base_amount, currency: alreadySent.currency, fee_label: alreadySent.fee_label,
        invoice_type: 'one_time', status: alreadySent.status,
        stripe_invoice_id: alreadySent.stripe_invoice_id, stripe_invoice_url: alreadySent.stripe_invoice_url,
        sent_at: alreadySent.sent_at,
      })
      continue
    }
    const li = findOneTimeLineItem(lineItems, fee.fee_label)
    plannedRows.push({
      year_num:           null,
      period_start:       fee.due_date ?? formatDate(now),
      period_end:         fee.due_date ?? formatDate(now),
      base_amount:        fee.amount ?? 0,
      currency:           terms.currency ?? 'EUR',
      fee_label:          fee.fee_label,
      invoice_type:       'one_time',
      status:             'parked',
      stripe_invoice_id:  null,
      stripe_invoice_url: null,
      sent_at:            null,
      line_item_id: li?.id ?? null,
      // Real quantity isn't known until a human confirms delivery (parked-invoices
      // route) — only the rate can be pre-filled from the approved line item.
      quantity: null, unit_price: li?.unit_price ?? fee.rate_per_unit ?? null,
    })
  }

  for (const fee of oneTimeFees.filter(f => !f.manual_trigger && f.amount > 0)) {
    const alreadySent = sentRows.find(r => r.invoice_type === 'one_time' && r.fee_label === fee.fee_label)
    if (alreadySent) {
      plannedRows.push({
        year_num: null, period_start: alreadySent.period_start, period_end: alreadySent.period_end,
        base_amount: alreadySent.base_amount, currency: alreadySent.currency, fee_label: alreadySent.fee_label,
        invoice_type: 'one_time', status: alreadySent.status,
        stripe_invoice_id: alreadySent.stripe_invoice_id, stripe_invoice_url: alreadySent.stripe_invoice_url,
        sent_at: alreadySent.sent_at,
      })
      continue
    }
    const feeDueDate = fee.due_date ? new Date(fee.due_date + 'T00:00:00') : null
    const isDue      = !feeDueDate || feeDueDate <= now

    // Prefer the approved line_items row (may carry a human-corrected
    // quantity/unit_price/total) over the raw extracted contract amount.
    const li          = findOneTimeLineItem(lineItems, fee.fee_label)
    const amount      = li?.total_amount ?? fee.amount
    const hasBreakdown = !!li && li.quantity > 0 && li.unit_price > 0
    const description  = hasBreakdown
      ? `${fee.fee_label} — ${li.quantity.toLocaleString()} × ${cur.toUpperCase()} ${li.unit_price.toLocaleString()}`
      : fee.fee_label

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

      // Stripe invoice items only take a flat amount + quantity=1 here (real
      // per-unit quantity/rate needs price_data.unit_amount, a Decimal type —
      // not worth the added complexity when the description already carries
      // the real breakdown). Remembill (below) gets true quantity/unit_price.
      await stripe.invoiceItems.create({
        customer:    customer.id,
        invoice:     oneTimeInv.id,
        amount:      Math.round(amount * 100),
        currency:    cur,
        description,
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
        base_amount:        amount,
        currency:           terms.currency ?? 'EUR',
        fee_label:          fee.fee_label,
        invoice_type:       'one_time',
        status:             'sent',
        stripe_invoice_id:  oneTimeInv.id,
        stripe_invoice_url: finalized.hosted_invoice_url ?? null,
        sent_at:            new Date().toISOString(),
        line_item_id: li?.id ?? null,
        quantity:     hasBreakdown ? li.quantity   : null,
        unit_price:   hasBreakdown ? li.unit_price : null,
      })
    } else {
      const dueDateStr = formatDate(feeDueDate!)
      plannedRows.push({
        year_num:           null,
        period_start:       dueDateStr,
        period_end:         dueDateStr,
        base_amount:        amount,
        currency:           terms.currency ?? 'EUR',
        fee_label:          fee.fee_label,
        invoice_type:       'one_time',
        status:             'scheduled',
        stripe_invoice_id:  null,
        stripe_invoice_url: null,
        sent_at:            null,
        line_item_id: li?.id ?? null,
        quantity:     hasBreakdown ? li.quantity   : null,
        unit_price:   hasBreakdown ? li.unit_price : null,
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

// ── Remembill ──────────────────────────────────────────────────────────────────
// Remembill is an invoice-based billing platform (no subscriptions).
// Flow: create customer → for each due period create a draft invoice, add one
// row, deliver via email. Future periods are stored as 'scheduled' planned rows
// and pushed by the daily invoice-scheduler cron.
// Taxes are handled by Remembill automatically — we send net amounts.
const REMEMBILL_BASE = 'https://api.remembill.com/v1'

// HTTP header values must be printable ASCII. Strip any non-ASCII character
// (em dashes, curly quotes, etc.) and collapse runs of non-alphanumeric to a
// single hyphen so idempotency keys remain readable and safe.
export function safeHeaderValue(s: string): string {
  return s
    .replace(/[^\x20-\x7E]/g, '-')   // non-printable-ASCII → hyphen
    .replace(/[^a-zA-Z0-9_\-]/g, '-') // remaining specials → hyphen
    .replace(/-{2,}/g, '-')            // collapse repeated hyphens
    .replace(/^-|-$/g, '')             // trim leading/trailing hyphens
    .slice(0, 255)
}

// Builds an app.remembill.com URL that respects the org path segment.
// Set REMEMBILL_ORG_SLUG in Vercel to the slug that appears after /org/ in
// your Remembill dashboard URL (e.g. "acme" if the URL is app.remembill.com/org/acme/...).
function remembillAppUrl(path: string): string {
  const slug = process.env.REMEMBILL_ORG_SLUG
  const base = slug ? `https://app.remembill.com/org/${slug}` : 'https://app.remembill.com'
  return `${base}${path}`
}

function remembillHeaders(apiKey: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type':  'application/json',
    'Accept':        'application/json',
  }
}

async function configureRememhill(
  terms: ContractTerms,
  lineItems: LineItemInput[],
  jobId?: string,
  orgId?: string,
  existingCustomerId?: string,
): Promise<ConfigureResult> {
  const orgConfig = orgId ? await getOrgConfig(orgId, 'remembill') : null
  const apiKey = orgConfig?.api_key ?? process.env.REMEMBILL_API_KEY
  if (!apiKey) throw new Error('Remembill API key not configured')

  const h      = remembillHeaders(apiKey)
  const cur    = (terms.currency || 'SEK').toUpperCase()   // || so empty string falls back too
  const now    = new Date()
  const netDays = terms.payment_terms_days ?? 30

  const fmtDate  = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const fmtLabel = (d: Date) => d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
  const addDays  = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000)

  if (!cur) {
    throw new Error('Remembill: currency is missing from contract terms — set it in the contract details and try again.')
  }
  if (cur !== 'SEK') {
    throw new Error(
      `Remembill only supports invoicing in SEK. This contract is in ${cur}. ` +
      'Please use Stripe for non-SEK contracts, or update the contract currency to SEK.',
    )
  }

  // ── 1. Customer — reuse from a previous attempt or create fresh ─────────────
  let customerId: string

  if (existingCustomerId) {
    // Re-push after a failed attempt: the customer already exists in Remembill.
    customerId = existingCustomerId
    console.log('[billing-writer/remembill] reusing existing customer:', customerId)
  } else {
    // Remembill requires: name, type, org_number, and at least one of email or phone.
    const realEmail = terms.customer_email
      ?? terms.billing_contact?.match(/[^\s@]+@[^\s@]+\.[^\s@]+/)?.[0]
      ?? null

    const customerBody: Record<string, string> = {
      type: 'business',
      name: terms.customer_name ?? 'Unknown',
    }
    if (realEmail) {
      customerBody.email = realEmail
    } else {
      const slug = (terms.customer_name ?? 'customer')
        .toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 30) || 'customer'
      customerBody.email = `billing+${slug}@verdix-noreply.com`
    }
    if (terms.customer_org_number) {
      customerBody.org_number = terms.customer_org_number
    } else {
      throw new Error(
        'Remembill requires a company registration number (org number). ' +
        'Please add it in the contract details under "Customer org / reg number" and try again.',
      )
    }

    const custRes = await fetch(`${REMEMBILL_BASE}/customers`, {
      method: 'POST', headers: h,
      body: JSON.stringify(customerBody),
    })
    const custRawBody = await custRes.text()
    if (!custRes.ok) {
      console.error('[billing-writer/remembill] customer creation failed', custRes.status, custRawBody)
      throw new Error(`Remembill customer creation failed (${custRes.status}): ${custRawBody}`)
    }
    console.log('[billing-writer/remembill] customer creation response:', custRawBody)
    const custJson = JSON.parse(custRawBody) as Record<string, unknown>
    const custObj  = (custJson.customer ?? custJson.data ?? custJson) as Record<string, unknown>
    const newCustomerId = custObj.id as string | undefined
    if (!newCustomerId) {
      throw new Error(`Remembill customer creation: could not extract id from response: ${custRawBody}`)
    }
    customerId = newCustomerId

    // Persist the customer ID immediately so a re-push can reuse it if invoicing fails later.
    if (jobId) {
      const { error: saveErr } = await supabaseServer.from('jobs').update({ billing_customer_id: customerId }).eq('id', jobId)
      if (saveErr) console.error('[billing-writer/remembill] failed to persist customer_id early', saveErr)
    }
  }
  console.log('[billing-writer/remembill] customerId:', customerId, '| currency:', cur)

  // ── 1b. Preserve already-sent invoices; delete only unsent rows ─────────────
  // Sent invoices have already been delivered to the customer — never create
  // duplicates. Scheduled/parked rows are safe to delete and re-compute.
  type ExistingSentRow = {
    year_num: number | null
    period_start: string; period_end: string
    invoice_type: string; fee_label: string | null
    stripe_invoice_id: string | null; stripe_invoice_url: string | null
    base_amount: number; currency: string
    sent_at: string | null; status: string
  }
  let sentRows: ExistingSentRow[] = []
  if (jobId) {
    const { data: sent } = await supabaseServer
      .from('planned_invoices')
      .select('year_num, period_start, period_end, invoice_type, fee_label, stripe_invoice_id, stripe_invoice_url, base_amount, currency, sent_at, status')
      .eq('job_id', jobId)
      .in('status', ['sent', 'paid'])
    sentRows = (sent ?? []) as ExistingSentRow[]

    const { error: cleanErr } = await supabaseServer
      .from('planned_invoices')
      .delete()
      .eq('job_id', jobId)
      .in('status', ['scheduled', 'parked', 'processing', 'draft'])
    if (cleanErr) console.error('[billing-writer/remembill] stale planned_invoices cleanup failed', cleanErr)
  }

  // Per-push timestamp so idempotency keys are unique across retry attempts.
  const pushStamp = Date.now().toString(36)

  // ── 2. Helper: draft invoice → add row → send via email ────────────────────
  // Parameters are passed explicitly (not closed over) so values are unambiguous.
  // Confirmed via probe: Remembill ignores rows[] in the creation body and
  // rejects PUT. The only working strategy is POST /invoices/:id/rows.
  async function pushInvoice(
    description: string,
    unitPrice: number,
    issueDate: Date,
    idempotencyKey: string,
    invoiceCustomerId: string,
    invoiceCurrency: string,
    quantity = 1,
  ): Promise<{ id: string; url: string | null }> {
    const dueDate = addDays(issueDate, netDays)

    const invoiceBody = {
      customer_id:   invoiceCustomerId,
      currency:      invoiceCurrency,
      issue_date:    fmtDate(issueDate),
      due_date:      fmtDate(dueDate),
      payment_terms: `Net ${netDays}`,
    }
    const invRes = await fetch(`${REMEMBILL_BASE}/invoices`, {
      method: 'POST', headers: { ...h, 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(invoiceBody),
    })
    const invRawBody = await invRes.text()
    if (!invRes.ok) {
      console.error('[billing-writer/remembill] invoice creation failed', invRes.status, invRawBody)
      throw new Error(`Remembill invoice creation failed (${invRes.status}): ${invRawBody}`)
    }
    const invJson  = JSON.parse(invRawBody) as Record<string, unknown>
    const invObj   = (invJson.invoice ?? invJson.data ?? invJson) as Record<string, unknown>
    const invoiceId = invObj.id as string | undefined
    if (!invoiceId) {
      throw new Error(`Remembill invoice creation: could not extract id from response: ${invRawBody}`)
    }

    // price is in öre (minor units): 1 kr = 100 öre. vat is 0–100 percent.
    // quantity defaults to 1 (period/flat fees); one-time fees with a real
    // per-unit breakdown pass their actual quantity so Remembill's invoice
    // shows e.g. "4 × 45,000" instead of a single lump-sum row.
    // POST /invoices/:id/rows is the only endpoint that reliably attaches a row.
    const rowBody = { name: description, quantity, price: Math.round(unitPrice * 100), vat: 0 }
    const rowRes  = await fetch(`${REMEMBILL_BASE}/invoices/${invoiceId}/rows`, {
      method: 'POST', headers: h,
      body: JSON.stringify(rowBody),
    })
    const rowRawBody = await rowRes.text()
    if (!rowRes.ok) {
      console.error(`[billing-writer/remembill] row creation failed (${rowRes.status}):`, rowRawBody)
      throw new Error(`Remembill row creation failed (${rowRes.status}): ${rowRawBody}`)
    }

    // Deliver via email — returns 202 Accepted when queued
    await fetch(`${REMEMBILL_BASE}/invoices/${invoiceId}/email`, {
      method: 'POST', headers: h, body: JSON.stringify({}),
    }).catch(err => console.error('[billing-writer/remembill] email delivery failed', err))

    return { id: invoiceId, url: remembillAppUrl('') }
  }

  // ── 3. Billing schedule ─────────────────────────────────────────────────────
  const periods = computeBillingSchedule(terms)

  type PlannedRow = {
    job_id?: string; org_id?: string
    year_num: number | null; period_start: string; period_end: string
    base_amount: number; currency: string; fee_label: string | null
    invoice_type: string; status: string
    stripe_invoice_id: string | null; stripe_invoice_url: string | null
    sent_at: string | null
    line_item_id?: string | null; quantity?: number | null; unit_price?: number | null
  }
  const plannedRows: PlannedRow[] = []

  // ── 4. Period invoices ──────────────────────────────────────────────────────
  for (const period of periods) {
    const periodStartStr = fmtDate(period.periodStart)
    const periodEndStr   = fmtDate(period.periodEnd)

    // If this period's invoice was already sent in a previous push, carry it
    // forward unchanged — don't create a duplicate in Remembill.
    const alreadySent = sentRows.find(
      r => r.invoice_type === 'period' && r.year_num === period.yearNum && r.period_start === periodStartStr,
    )
    if (alreadySent) {
      plannedRows.push({
        year_num: alreadySent.year_num, period_start: alreadySent.period_start, period_end: alreadySent.period_end,
        base_amount: alreadySent.base_amount, currency: alreadySent.currency, fee_label: null,
        invoice_type: 'period', status: alreadySent.status,
        stripe_invoice_id: alreadySent.stripe_invoice_id, stripe_invoice_url: alreadySent.stripe_invoice_url,
        sent_at: alreadySent.sent_at,
      })
      continue
    }

    const description = `Base subscription — Year ${period.yearNum} (${fmtLabel(period.periodStart)} – ${fmtLabel(period.periodEnd)})`

    if (period.periodStart <= now && period.baseAmount > 0) {
      const key = safeHeaderValue(`verdix-${jobId ?? 'unknown'}-${pushStamp}-period-${period.yearNum}-${period.periodIndex}`)
      const { id, url } = await pushInvoice(description, Math.round(period.baseAmount * 100) / 100, now, key, customerId, cur)
      plannedRows.push({
        year_num: period.yearNum, period_start: periodStartStr, period_end: periodEndStr,
        base_amount: period.baseAmount, currency: terms.currency ?? 'SEK', fee_label: null,
        invoice_type: 'period', status: 'sent',
        stripe_invoice_id: id, stripe_invoice_url: url, sent_at: new Date().toISOString(),
      })
    } else {
      plannedRows.push({
        year_num: period.yearNum, period_start: periodStartStr, period_end: periodEndStr,
        base_amount: period.baseAmount, currency: terms.currency ?? 'SEK', fee_label: null,
        invoice_type: 'period', status: 'scheduled',
        stripe_invoice_id: null, stripe_invoice_url: null, sent_at: null,
      })
    }
  }

  // ── 5. One-time fees ────────────────────────────────────────────────────────
  type OneTimeFeeInput = {
    fee_label: string; amount: number; due_date?: string | null
    manual_trigger?: boolean; metric_name?: string | null; rate_per_unit?: number | null
  }
  const oneTimeFees = (terms.one_time_fees ?? []) as OneTimeFeeInput[]

  for (const fee of oneTimeFees.filter(f => f.manual_trigger)) {
    const alreadySent = sentRows.find(r => r.invoice_type === 'one_time' && r.fee_label === fee.fee_label)
    if (alreadySent) {
      plannedRows.push({ ...alreadySent, invoice_type: 'one_time', fee_label: alreadySent.fee_label })
      continue
    }
    const li = findOneTimeLineItem(lineItems, fee.fee_label)
    plannedRows.push({
      year_num: null, period_start: fee.due_date ?? fmtDate(now), period_end: fee.due_date ?? fmtDate(now),
      base_amount: fee.amount ?? 0, currency: terms.currency ?? 'SEK', fee_label: fee.fee_label,
      invoice_type: 'one_time', status: 'parked',
      stripe_invoice_id: null, stripe_invoice_url: null, sent_at: null,
      line_item_id: li?.id ?? null,
      // Real quantity isn't known until a human confirms delivery — only the
      // rate can be pre-filled from the approved line item.
      quantity: null, unit_price: li?.unit_price ?? fee.rate_per_unit ?? null,
    })
  }

  for (const fee of oneTimeFees.filter(f => !f.manual_trigger && f.amount > 0)) {
    const feeDueDate = fee.due_date ? new Date(fee.due_date + 'T00:00:00') : null
    const isDue      = !feeDueDate || feeDueDate <= now
    const dueDateStr = fmtDate(feeDueDate ?? now)

    // Don't re-send an already-sent one-time fee
    const alreadySent = sentRows.find(r => r.invoice_type === 'one_time' && r.fee_label === fee.fee_label)
    if (alreadySent) {
      plannedRows.push({ ...alreadySent, invoice_type: 'one_time', fee_label: alreadySent.fee_label })
      continue
    }

    // Prefer the approved line_items row (may carry a human-corrected
    // quantity/unit_price/total) over the raw extracted contract amount.
    const li           = findOneTimeLineItem(lineItems, fee.fee_label)
    const amount       = li?.total_amount ?? fee.amount
    const hasBreakdown = !!li && li.quantity > 0 && li.unit_price > 0

    if (isDue) {
      const key = safeHeaderValue(`verdix-${jobId ?? 'unknown'}-${pushStamp}-onetime-${fee.fee_label}`)
      const { id, url } = hasBreakdown
        ? await pushInvoice(fee.fee_label, li.unit_price, feeDueDate ?? now, key, customerId, cur, li.quantity)
        : await pushInvoice(fee.fee_label, amount, feeDueDate ?? now, key, customerId, cur)
      plannedRows.push({
        year_num: null, period_start: dueDateStr, period_end: dueDateStr,
        base_amount: amount, currency: terms.currency ?? 'SEK', fee_label: fee.fee_label,
        invoice_type: 'one_time', status: 'sent',
        stripe_invoice_id: id, stripe_invoice_url: url, sent_at: new Date().toISOString(),
        line_item_id: li?.id ?? null,
        quantity:     hasBreakdown ? li.quantity   : null,
        unit_price:   hasBreakdown ? li.unit_price : null,
      })
    } else {
      plannedRows.push({
        year_num: null, period_start: dueDateStr, period_end: dueDateStr,
        base_amount: amount, currency: terms.currency ?? 'SEK', fee_label: fee.fee_label,
        invoice_type: 'one_time', status: 'scheduled',
        stripe_invoice_id: null, stripe_invoice_url: null, sent_at: null,
        line_item_id: li?.id ?? null,
        quantity:     hasBreakdown ? li.quantity   : null,
        unit_price:   hasBreakdown ? li.unit_price : null,
      })
    }
  }

  // ── 6. Persist planned rows ─────────────────────────────────────────────────
  if (jobId && plannedRows.length > 0) {
    const { error } = await supabaseServer
      .from('planned_invoices')
      .insert(plannedRows.map(r => ({ ...r, job_id: jobId, org_id: orgId })))
    if (error) console.error('[billing-writer/remembill] planned_invoices insert failed', error)
  }

  return {
    platform:       'remembill',
    subscriptionId: null,
    customerId,
    lineItemCount:  periods.length + oneTimeFees.filter(f => f.amount > 0).length,
    dashboardUrl:   remembillAppUrl(''),
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
    // Chargebee subscription items recur automatically per their item
    // price's own configured interval — quantity means "units per cycle",
    // never "how many cycles". item.quantity here instead counts billing
    // cycles over the contract term (for the Configure page's display /
    // Base TCV), so it must never be forwarded as-is — doing so would tell
    // Chargebee to charge unit_price × cycle-count *every single cycle*.
    params.append(`subscription_items[quantity][${i}]`, '1')
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
  if (process.env.REMEMBILL_API_KEY) return 'remembill'
  return 'stripe'
}

// Creates a one-off invoice with arbitrary line items on the org's connected
// Stripe or Remembill account. Used for manually-triggered invoices (e.g. the
// job-scoped manual invoice generator) where the caller has already computed
// the line items and just needs them pushed to the real billing platform —
// mirrors the proven Stripe/Remembill mechanics used elsewhere in this file
// so there's one code path for "create an ad-hoc invoice," not several.
export async function createAdHocInvoice(params: {
  orgId: string
  billingPlatform: 'stripe' | 'remembill'
  customerId: string
  currency: string
  netDays: number
  lineItems: Array<{ description: string; quantity: number; unitPrice: number }>
  idempotencyKey: string
  metadata?: Record<string, string>
}): Promise<{ invoiceId: string; hostedUrl: string | null }> {
  const { orgId, billingPlatform, customerId, currency, netDays, lineItems, idempotencyKey, metadata } = params
  const today = new Date()
  const fmtDate = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

  if (billingPlatform === 'remembill') {
    const orgConfig = await getOrgConfig(orgId, 'remembill')
    const apiKey = orgConfig?.api_key ?? process.env.REMEMBILL_API_KEY
    if (!apiKey) throw new Error('Remembill API key not configured')
    const h       = remembillHeaders(apiKey)
    const dueDate = new Date(today.getTime() + netDays * 86_400_000)

    const invRes = await fetch(`${REMEMBILL_BASE}/invoices`, {
      method: 'POST',
      headers: { ...h, 'Idempotency-Key': safeHeaderValue(idempotencyKey) },
      body: JSON.stringify({
        customer_id:   customerId,
        currency:      currency.toUpperCase(),
        issue_date:    fmtDate(today),
        due_date:      fmtDate(dueDate),
        payment_terms: `Net ${netDays}`,
      }),
    })
    if (!invRes.ok) {
      const raw = await invRes.text()
      throw new Error(`Remembill invoice creation failed (${invRes.status}): ${raw}`)
    }
    const invJson    = await invRes.json() as Record<string, unknown>
    const invObj     = (invJson.invoice ?? invJson.data ?? invJson) as Record<string, unknown>
    const invoiceId  = invObj.id as string | undefined
    if (!invoiceId) throw new Error(`Could not extract Remembill invoice id: ${JSON.stringify(invJson)}`)

    for (const item of lineItems) {
      await fetch(`${REMEMBILL_BASE}/invoices/${invoiceId}/rows`, {
        method: 'POST', headers: h,
        body: JSON.stringify({ name: item.description, quantity: item.quantity, price: Math.round(item.unitPrice * 100), vat: 0 }),
      })
    }

    await fetch(`${REMEMBILL_BASE}/invoices/${invoiceId}/email`, {
      method: 'POST', headers: h, body: JSON.stringify({}),
    }).catch(() => {})

    return { invoiceId, hostedUrl: remembillAppUrl('') }
  }

  // ── Stripe ──────────────────────────────────────────────────────────────────
  const { default: Stripe } = await import('stripe')
  const orgConfig = await getOrgConfig(orgId, 'stripe')
  const stripeKey = orgConfig?.secret_key ?? process.env.STRIPE_SECRET_KEY!
  const stripe    = new Stripe(stripeKey, { apiVersion: '2026-06-24.dahlia' })

  const inv = await stripe.invoices.create({
    customer:                       customerId,
    collection_method:              'send_invoice',
    days_until_due:                 netDays,
    pending_invoice_items_behavior: 'exclude',
    metadata,
  })

  for (const item of lineItems) {
    await stripe.invoiceItems.create({
      customer:    customerId,
      invoice:     inv.id,
      amount:      Math.round(item.quantity * item.unitPrice * 100),
      currency:    currency.toLowerCase(),
      description: item.quantity !== 1
        ? `${item.description} — ${item.quantity} × ${currency.toUpperCase()} ${item.unitPrice}`
        : item.description,
    })
  }

  const finalized = await stripe.invoices.finalizeInvoice(inv.id).catch(() => inv)
  return { invoiceId: inv.id, hostedUrl: finalized.hosted_invoice_url ?? null }
}

// Re-export computeBillingSchedule for use by the invoice scheduler
export { computeBillingSchedule, REMEMBILL_BASE, remembillHeaders, remembillAppUrl }
export type { BillingPeriod }
