import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { billingInterval } from '@/lib/stripe-meter'
import { remembillAppUrl } from '@/lib/billing-writer'
import { enumerateContractWindows, resolveWindowMinimum } from '@/lib/tariff'
import { unwrapEmbedded } from '@/lib/postgrest-helpers'
import type { ContractTerms } from '@/lib/types'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let org
  try { org = await requireOrg() } catch (res) { return res as Response }

  const { id } = await params

  const { data: job } = await supabaseServer
    .from('jobs')
    .select('org_id, billing_subscription_id, billing_customer_id, billing_platform, contract_terms(*)')
    .eq('id', id)
    .eq('org_id', org.orgId)
    .single()

  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (!job.billing_subscription_id && !job.billing_customer_id) {
    return NextResponse.json({ error: 'No billing configured' }, { status: 404 })
  }

  if (job.billing_platform === 'chargebee') {
    return NextResponse.json({ error: 'Chargebee not supported here' }, { status: 400 })
  }

  const subId      = job.billing_subscription_id as string | null
  const customerId = job.billing_customer_id     as string | null
  const terms      = unwrapEmbedded(job.contract_terms as unknown as ContractTerms | ContractTerms[])

  // ── Remembill path: no Stripe client needed ───────────────────────────────
  if (job.billing_platform === 'remembill') {
    const { data: planned } = await supabaseServer
      .from('planned_invoices')
      .select('*')
      .eq('job_id', id)
      .order('period_start', { ascending: true })

    if (!planned?.length) {
      return NextResponse.json({ error: 'No billing schedule found' }, { status: 404 })
    }

    const paymentSchedule = terms?.year_pricing
      ? Object.entries(terms.year_pricing).map(([key, amount]) => {
          const yearNum = parseInt(key.replace('year', ''), 10)
          const contractStart = terms?.contract_start_date ? new Date(terms.contract_start_date) : null
          let periodStart: string | null = null
          let periodEnd:   string | null = null
          if (contractStart) {
            const ys = new Date(contractStart)
            ys.setFullYear(ys.getFullYear() + yearNum - 1)
            const ye = new Date(ys)
            ye.setFullYear(ye.getFullYear() + 1)
            ye.setDate(ye.getDate() - 1)
            periodStart = ys.toISOString().slice(0, 10)
            periodEnd   = ye.toISOString().slice(0, 10)
          }
          return { year: yearNum, amount, currency: terms?.currency ?? 'EUR', periodStart, periodEnd }
        })
      : null

    return handlePlannedInvoicesPath({
      stripe:          null,
      customerId,
      id,
      terms,
      planned,
      paymentSchedule,
      stripeKey:       '',
      billingPlatform: 'remembill',
    })
  }

  const { data: integration } = await supabaseServer
    .from('org_integrations')
    .select('config')
    .eq('org_id', org.orgId)
    .eq('connector_name', 'stripe')
    .eq('is_active', true)
    .maybeSingle()

  const stripeKey = (integration?.config as Record<string, string>)?.secret_key ?? process.env.STRIPE_SECRET_KEY!

  const { default: Stripe } = await import('stripe')
  const stripe = new Stripe(stripeKey, { apiVersion: '2026-06-24.dahlia' })

  // Build per-year payment schedule from contract terms (shared by both paths)
  const paymentSchedule = terms?.year_pricing
    ? Object.entries(terms.year_pricing).map(([key, amount]) => {
        const yearNum = parseInt(key.replace('year', ''), 10)
        const contractStart = terms?.contract_start_date ? new Date(terms.contract_start_date) : null
        let periodStart: string | null = null
        let periodEnd:   string | null = null
        if (contractStart) {
          const ys = new Date(contractStart)
          ys.setFullYear(ys.getFullYear() + yearNum - 1)
          const ye = new Date(ys)
          ye.setFullYear(ye.getFullYear() + 1)
          ye.setDate(ye.getDate() - 1)
          periodStart = ys.toISOString().slice(0, 10)
          periodEnd   = ye.toISOString().slice(0, 10)
        }
        return { year: yearNum, amount, currency: terms?.currency ?? 'EUR', periodStart, periodEnd }
      })
    : null

  const mapStripeInvoice = (inv: import('stripe').Stripe.Invoice) => {
    const meta = inv.metadata as Record<string, string> | null
    return {
      id:            inv.id,
      number:        inv.number,
      status:        inv.status,
      amount:        (inv.amount_due ?? 0) / 100,
      currency:      inv.currency?.toUpperCase() ?? 'EUR',
      dueDate:       inv.due_date   ? new Date(inv.due_date   * 1000).toISOString() : null,
      created:       new Date(inv.created * 1000).toISOString(),
      periodEnd:     inv.period_end ? new Date(inv.period_end * 1000).toISOString() : null,
      pdfUrl:        inv.invoice_pdf         ?? null,
      hostedUrl:     inv.hosted_invoice_url  ?? null,
      feeLabel:      meta?.fee_label    ?? null,
      yearNum:       meta?.year ? parseInt(meta.year, 10) : null,
      scheduledDate: meta?.scheduled_date ?? null,
    }
  }

  try {
    // ── Check for planned_invoices (new subscription-free contracts) ──────────
    const { data: planned } = await supabaseServer
      .from('planned_invoices')
      .select('*')
      .eq('job_id', id)
      .order('period_start', { ascending: true })

    if (planned && planned.length > 0) {
      return handlePlannedInvoicesPath({
        stripe, customerId, id, terms, planned, paymentSchedule,
        stripeKey,
      })
    }

    // ── Legacy path: subscription-based ──────────────────────────────────────
    if (!subId) {
      return NextResponse.json({ error: 'No billing configured' }, { status: 404 })
    }

    const [subscription, subscriptionInvRes, allCustomerInvRes, computedRes] = await Promise.all([
      stripe.subscriptions.retrieve(subId, { expand: ['items.data.price'] }),
      stripe.invoices.list({ subscription: subId, limit: 100 }),
      customerId
        ? stripe.invoices.list({ customer: customerId, limit: 50 })
        : Promise.resolve({ data: [] }),
      supabaseServer
        .from('computed_invoices')
        .select('*')
        .eq('job_id', id)
        .order('period_start', { ascending: false }),
    ])

    const baseItem                = subscription.items.data[0]
    const recurringInterval       = baseItem?.price?.recurring?.interval       ?? 'month'
    const recurringIntervalCount  = baseItem?.price?.recurring?.interval_count ?? 1

    const subscriptionInvIds = new Set(subscriptionInvRes.data.map(inv => inv.id))
    const standaloneInvoices = allCustomerInvRes.data.filter(inv => {
      if (subscriptionInvIds.has(inv.id)) return false
      const meta = inv.metadata as Record<string, string> | null
      return meta?.verdix_job === id
    })
    const annualDraftInvoices       = standaloneInvoices.filter(inv => (inv.metadata as Record<string, string> | null)?.invoice_type === 'annual_base')
    const oneTimeStandaloneInvoices = standaloneInvoices.filter(inv => (inv.metadata as Record<string, string> | null)?.invoice_type !== 'annual_base')

    // Auto-repair one-time invoices whose due_date was clamped at push time
    if (terms?.payment_terms_days) {
      const netSec = terms.payment_terms_days * 86_400
      await Promise.all(
        oneTimeStandaloneInvoices
          .filter(inv => inv.status === 'open' && inv.due_date != null)
          .filter(inv => inv.due_date! < inv.created + netSec - 2 * 86_400)
          .map(inv => {
            const daysUntilDue = Math.max(1, Math.ceil((inv.created + netSec - Date.now() / 1000) / 86_400))
            return stripe.invoices.update(inv.id, { days_until_due: daysUntilDue }).catch(() => {})
          })
      )
    }

    const latestInvoice = subscriptionInvRes.data.find(
      inv => inv.status !== 'void' && inv.status !== 'draft',
    ) ?? subscriptionInvRes.data[0]
    const currentPeriodStart = latestInvoice?.period_start
      ? new Date(latestInvoice.period_start * 1000).toISOString()
      : ''
    const currentPeriodEnd = latestInvoice?.period_end
      ? new Date(latestInvoice.period_end * 1000).toISOString()
      : ''

    const sub = subscription as unknown as Record<string, unknown>

    return NextResponse.json({
      subscription: {
        id: subscription.id,
        status: subscription.status,
        interval: recurringInterval,
        intervalCount: recurringIntervalCount,
        currentPeriodStart,
        currentPeriodEnd,
        cancelAtPeriodEnd: typeof sub.cancel_at_period_end === 'boolean' ? sub.cancel_at_period_end : false,
        isTest: !subscription.livemode,
        dashboardUrl: `https://dashboard.stripe.com/${!subscription.livemode ? 'test/' : ''}subscriptions/${subscription.id}`,
      },
      invoices:             subscriptionInvRes.data.map(mapStripeInvoice),
      annualDraftInvoices:  annualDraftInvoices.map(mapStripeInvoice),
      oneTimeInvoices:      oneTimeStandaloneInvoices.map(mapStripeInvoice),
      paymentSchedule,
      oneTimeFees:          terms?.one_time_fees ?? [],
      contractStart:        terms?.contract_start_date ?? null,
      currency:             terms?.currency ?? 'EUR',
      paymentTermsDays:     terms?.payment_terms_days ?? null,
      computedInvoices:     computedRes.data ?? [],
      hasOverageTerms:      (terms?.overage_tiers?.length ?? 0) > 0,
      overageMeterTypes:    Array.from(new Set((terms?.overage_tiers ?? []).map(t => t.unit_type).filter(Boolean))),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}

// ── New planned_invoices path ─────────────────────────────────────────────────

async function handlePlannedInvoicesPath({
  stripe, customerId, id, terms, planned, paymentSchedule, stripeKey, billingPlatform,
}: {
  stripe:          import('stripe').Stripe | null
  customerId:      string | null
  id:              string
  terms:           ContractTerms | undefined
  planned:         Record<string, unknown>[]
  paymentSchedule: { year: number; amount: number; currency: string; periodStart: string | null; periodEnd: string | null }[] | null
  stripeKey:       string
  billingPlatform?: string
}): Promise<NextResponse> {

  // For Stripe: enrich rows with live invoice status from the Stripe API.
  // For other platforms (Remembill etc.): skip — status comes from planned_invoices.status directly.
  const allCustomerInvoices = (stripe && customerId && billingPlatform !== 'remembill')
    ? await stripe.invoices.list({ customer: customerId, limit: 100 }).catch(() => ({ data: [] }))
    : { data: [] }

  const stripeInvMap = new Map(allCustomerInvoices.data.map(inv => [inv.id, inv]))

  type OverageLineItem = {
    meter_key: string
    total_units: number
    included_units: number
    billable_units?: number
    rate_per_unit?: number
    amount: number
    currency: string
    description: string
    metric_source: 'meter_pull' | 'client_pull'
  }
  type PlannedRow = {
    id: string
    year_num: number | null
    period_start: string
    period_end: string
    base_amount: number
    currency: string
    fee_label: string | null
    invoice_type: string
    status: string
    stripe_invoice_id: string | null
    stripe_invoice_url: string | null
    sent_at: string | null
    paid_at: string | null
    created_at: string
    overage_line_items: OverageLineItem[] | null
    overage_total: number | null
    line_item_id: string | null
    quantity: number | null
    unit_price: number | null
    error_message: string | null
  }

  const rows = planned as PlannedRow[]

  const mapPlanned = (row: PlannedRow) => {
    const stripeInv = row.stripe_invoice_id ? stripeInvMap.get(row.stripe_invoice_id) : null
    const liveStatus = stripeInv?.status ?? null
    // For Stripe: derive display status from live API status.
    // For Remembill: use planned_invoices.status directly (no live API lookup).
    // A row invoice-scheduler failed to push (status='failed', a real
    // error_message attached) must never render as an ordinary 'draft' row —
    // that hid genuine push failures (bad org number, expired API key, etc.)
    // behind a normal-looking "not due yet" badge with no indication anything
    // needed attention.
    const status = row.status === 'paid' ? 'paid'
      : row.status === 'failed' ? 'failed'
      : liveStatus === 'paid' ? 'paid'
      : liveStatus === 'open' ? 'open'
      : row.status === 'sent' ? (billingPlatform === 'remembill' ? 'sent' : 'open')
      : 'draft'

    // When we have the live Stripe invoice object, amount_due is ground truth
    // (already reflects base + overage as actually invoiced). Otherwise — every
    // Remembill row, or a Stripe row whose invoice hasn't synced into stripeInvMap
    // yet — fall back to base_amount + overage_total, which previously only
    // included base_amount and silently dropped overage from the displayed total.
    const amount = stripeInv
      ? (stripeInv.amount_due ?? 0) / 100
      : Number(row.base_amount) + Number(row.overage_total ?? 0)

    return {
      id:            row.id,
      number:        stripeInv?.number ?? null,
      status,
      amount,
      currency:      (row.currency ?? 'EUR').toUpperCase(),
      dueDate:       stripeInv?.due_date ? new Date(stripeInv.due_date * 1000).toISOString() : null,
      created:       row.created_at,
      periodEnd:     row.period_end,
      pdfUrl:        stripeInv?.invoice_pdf        ?? null,
      hostedUrl:     stripeInv?.hosted_invoice_url ?? row.stripe_invoice_url ?? null,
      feeLabel:      row.fee_label,
      yearNum:       row.year_num,
      scheduledDate: row.period_start,
      baseAmount:    Number(row.base_amount),
      overageLineItems: row.overage_line_items ?? [],
      overageTotal:     Number(row.overage_total ?? 0),
      // Real per-unit breakdown from the approved line_items row (e.g. "4
      // connectors @ 45,000") — null when the fee has no per-unit structure.
      quantity:   row.quantity   != null ? Number(row.quantity)   : null,
      unitPrice:  row.unit_price != null ? Number(row.unit_price) : null,
      lineItemId: row.line_item_id,
      errorMessage: status === 'failed' ? row.error_message : null,
    }
  }

  const periodRows  = rows.filter(r => r.invoice_type === 'period')
  // Parked rows are one_time fees awaiting manual delivery confirmation
  const parkedRows  = rows.filter(r => r.invoice_type === 'one_time' && r.status === 'parked')
  const oneTimeRows = rows.filter(r => r.invoice_type === 'one_time' && r.status !== 'parked')

  // ── invoices: individual period entries (shown in billing timeline per period) ──
  const invoices = periodRows.map(mapPlanned)

  // ── annualDraftInvoices: one entry per contract year (for commitment waterfall) ──
  const yearGroups = new Map<number, PlannedRow[]>()
  for (const row of periodRows) {
    const yr = row.year_num ?? 1
    if (!yearGroups.has(yr)) yearGroups.set(yr, [])
    yearGroups.get(yr)!.push(row)
  }

  const annualDraftInvoices = [...yearGroups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([yearNum, yearRows]) => {
      const anyPaid = yearRows.some(r => {
        const si = r.stripe_invoice_id ? stripeInvMap.get(r.stripe_invoice_id) : null
        return r.status === 'paid' || si?.status === 'paid'
      })
      const anySent = yearRows.some(r => r.status === 'sent' || r.status === 'processing')
      const status  = anyPaid ? 'paid' : anySent ? 'open' : 'draft'

      const totalBase    = yearRows.reduce((s, r) => s + Number(r.base_amount), 0)
      const yearOverageItems = yearRows.flatMap(r => r.overage_line_items ?? [])
      const yearOverageTotal = yearRows.reduce((s, r) => s + Number(r.overage_total ?? 0), 0)
      const firstRow    = yearRows[0]
      const lastRow     = yearRows[yearRows.length - 1]

      const latestSentRow = [...yearRows].reverse().find(r => r.stripe_invoice_id)
      const latestStripeInv = latestSentRow?.stripe_invoice_id
        ? stripeInvMap.get(latestSentRow.stripe_invoice_id)
        : null

      return {
        id:            `year-${yearNum}-${id}`,
        number:        null,
        status,
        amount:        totalBase + yearOverageTotal,
        currency:      (firstRow.currency ?? 'EUR').toUpperCase(),
        dueDate:       null,
        created:       firstRow.created_at,
        periodEnd:     lastRow.period_end,
        pdfUrl:        latestStripeInv?.invoice_pdf        ?? null,
        hostedUrl:     latestStripeInv?.hosted_invoice_url ?? null,
        feeLabel:      null,
        yearNum,
        scheduledDate: firstRow.period_start,
        baseAmount:       totalBase,
        overageLineItems: yearOverageItems,
        overageTotal:     yearOverageTotal,
      }
    })

  // ── oneTimeInvoices: one-time fees ─────────────────────────────────────────
  const oneTimeInvoices = oneTimeRows.map(mapPlanned)

  // ── commercialRuleEvents: confirmed metric-level commitments (additive fees,
  // minimum floors, etc.) that haven't closed yet, so no real planned_invoices
  // row exists for them — a confirmed rule must still show on the schedule
  // before the window closes, or the timeline silently contradicts the
  // Commercial Terms card that says it's confirmed. Reuses the same
  // cadence-window engine and per-window proration math usage-pull.ts /
  // computeMinimumCommitmentSchedule use for real billing (lib/tariff.ts)
  // rather than a parallel date calculation.
  type CommercialRuleEvent = {
    id: string; meterKey: string; mode: string; amount: number; currency: string
    cadence: string; windowStart: string; windowEnd: string
    partialPeriod: { isPartial: boolean; needsConfirmation: boolean; prorated: boolean } | null
    // Only an additive fee is a deterministic charge independent of usage —
    // floor/minimum_spend/prepaid_commitment are max(usage, X)-style rules
    // whose final billed amount isn't known until usage is pulled, so
    // `amount` here is the applicable THRESHOLD, not a promised invoice
    // total. The UI must never present it as final for those modes.
    isDeterministic: boolean
  }
  const commercialRuleEvents: CommercialRuleEvent[] = []
  if (terms?.overage_tiers?.length && terms.contract_start_date) {
    const seen = new Set<string>()
    const contractStartDate = new Date(terms.contract_start_date + 'T00:00:00')
    const contractEndDate   = terms.contract_end_date ? new Date(terms.contract_end_date + 'T00:00:00') : null
    const today = new Date()
    const dateOnly = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

    for (const t of terms.overage_tiers) {
      if (!t.unit_type || !t.minimum_commitment || t.minimum_commitment.requires_confirmation) continue
      if (seen.has(t.unit_type)) continue
      seen.add(t.unit_type)
      const mc = t.minimum_commitment
      const cadence = t.measurement_period ?? 'monthly'
      const anchor: 'calendar' | 'contract_start' = t.reset_anchor === 'calendar' ? 'calendar' : 'contract_start'
      // A window past the contract's own end date doesn't exist to schedule
      // — enumerateContractWindows already scopes to the confirmed term
      // when an end date is known; an open-ended contract needs its own
      // bounded horizon so this doesn't scan forever.
      const horizonEnd = contractEndDate ?? new Date(today.getFullYear(), today.getMonth() + 12, today.getDate())

      const windows = enumerateContractWindows(contractStartDate, horizonEnd, cadence, anchor)
      for (const w of windows) {
        // A window that has already closed either already has a real overage
        // line item (once invoice-scheduler processes it) or is about to —
        // this synthetic entry exists only to cover the gap before that,
        // never to duplicate or contradict the real invoiced amount.
        if (w.end < today) continue
        const wm = resolveWindowMinimum(w, contractStartDate, contractEndDate ?? horizonEnd, anchor, mc)
        commercialRuleEvents.push({
          id:        `commercial-${t.unit_type}-${dateOnly(w.start)}`,
          meterKey:  t.unit_type,
          mode:      mc.mode,
          // wm.amount is null only when a partial window's proration is
          // still unconfirmed — fall back to the raw amount for display,
          // but partialPeriod.needsConfirmation (below) keeps it flagged
          // rather than silently presenting an unconfirmed figure.
          amount:    wm.amount ?? mc.amount,
          currency:  terms.currency ?? 'EUR',
          cadence,
          windowStart: dateOnly(w.start),
          windowEnd:   dateOnly(w.end),
          partialPeriod: wm.isPartial
            ? { isPartial: true, needsConfirmation: wm.requiresConfirmation, prorated: mc.prorate_partial_periods === true }
            : null,
          isDeterministic: mc.mode === 'additive',
        })
      }
    }
  }

  // ── parkedInvoices: service fees awaiting manual trigger ───────────────────
  type AnyFee = { fee_label: string; metric_name?: string | null; rate_per_unit?: number | null; description?: string | null }
  const termsFees = (terms?.one_time_fees ?? []) as AnyFee[]
  const parkedInvoices = parkedRows.map(row => {
    const termFee = termsFees.find(f => f.fee_label === row.fee_label)
    return {
      id:          row.id,
      feeLabel:    row.fee_label,
      currency:    (row.currency ?? 'EUR').toUpperCase(),
      baseAmount:  Number(row.base_amount),
      metricName:  termFee?.metric_name  ?? null,
      ratePerUnit: termFee?.rate_per_unit ?? null,
      description: termFee?.description  ?? null,
    }
  })

  // ── Synthetic subscription object from contract terms + planned state ───────
  const { interval, intervalCount } = billingInterval(terms?.billing_frequency)
  const sentPeriods    = periodRows.filter(r => r.status === 'sent' || r.status === 'paid')
  const mostRecentSent = sentPeriods[sentPeriods.length - 1]
  const anyActive      = sentPeriods.length > 0

  const isTest       = billingPlatform !== 'remembill' && stripeKey.includes('sk_test_')
  const dashboardUrl = billingPlatform === 'remembill'
    ? remembillAppUrl('')
    : `https://dashboard.stripe.com/${isTest ? 'test/' : ''}customers/${customerId ?? ''}`

  return NextResponse.json({
    subscription: {
      id:                  customerId ?? id,
      status:              anyActive ? 'active' : 'draft',
      interval,
      intervalCount,
      currentPeriodStart:  mostRecentSent?.period_start ?? terms?.contract_start_date ?? '',
      currentPeriodEnd:    mostRecentSent?.period_end   ?? '',
      cancelAtPeriodEnd:   false,
      isTest,
      dashboardUrl,
    },
    invoices,
    annualDraftInvoices,
    oneTimeInvoices,
    commercialRuleEvents,
    parkedInvoices,
    paymentSchedule,
    oneTimeFees:      terms?.one_time_fees ?? [],
    contractStart:    terms?.contract_start_date ?? null,
    currency:         terms?.currency      ?? 'EUR',
    paymentTermsDays: terms?.payment_terms_days  ?? null,
    computedInvoices: [],
    billingPlatform:  billingPlatform ?? 'stripe',
    hasOverageTerms:  (terms?.overage_tiers?.length ?? 0) > 0,
    overageMeterTypes: Array.from(new Set((terms?.overage_tiers ?? []).map(t => t.unit_type).filter(Boolean))),
  })
}
