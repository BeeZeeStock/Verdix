/**
 * GET  /api/jobs/[id]/manual-invoice
 *   Data needed to build a manual verification invoice for this job: its
 *   confirmed meter mappings (tiers/included_units) and any line_items
 *   presets (recurring base fee / one-time fees from the approved billing
 *   configuration) to prefill a fixed or one-time fee component.
 *
 * POST /api/jobs/[id]/manual-invoice
 *   Computes overage for an entered usage value against this job's own
 *   confirmed tiers (not org-wide — the exact agreement), optionally adds a
 *   fixed/one-time fee, and either returns a preview (push=false) or creates
 *   a real invoice on the org's connected Stripe/Remembill account (push=true).
 *   Body: { meterKey?, usage?, fixedFee?: {label,amount}|null, oneTimeFee?: {label,amount}|null, push: boolean }
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { createAdHocInvoice } from '@/lib/billing-writer'
import { computeMetricOverage, describeTieredUsage } from '@/lib/tariff'
import type { OverageTier } from '@/lib/types'

async function loadJob(jobId: string, orgId: string) {
  const { data: job } = await supabaseServer
    .from('jobs')
    .select('id, org_id, billing_customer_id, billing_platform, contract_terms(currency, payment_terms_days)')
    .eq('id', jobId)
    .eq('org_id', orgId)
    .maybeSingle()
  return job
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id: jobId } = await params
  const job = await loadJob(jobId, org.orgId)
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  const termsArr = job.contract_terms as unknown as Array<{ currency?: string; payment_terms_days?: number | null }>
  const currency = (termsArr?.[0]?.currency ?? 'EUR').toUpperCase()

  const [{ data: mappings }, { data: lineItems }] = await Promise.all([
    supabaseServer
      .from('contract_meter_mappings')
      .select('meter_key, included_units, overage_tiers, billing_cycle')
      .eq('job_id', jobId)
      .eq('confirmed', true),
    supabaseServer
      .from('line_items')
      .select('product_name, quantity, unit_price, total_amount, billing_period, currency')
      .eq('job_id', jobId),
  ])

  const meters = (mappings ?? []).map(m => ({
    meterKey:      m.meter_key as string,
    includedUnits: (m.included_units as number) ?? 0,
    overageTiers:  (m.overage_tiers ?? []) as Array<{ from_unit: number | null; to_unit: number | null; rate_per_unit: number }>,
    billingCycle:  m.billing_cycle as string,
  }))

  const presetFees = (lineItems ?? []).map(li => ({
    label:    li.product_name as string,
    amount:   Number(li.total_amount),
    currency: (li.currency as string) ?? currency,
    kind:     li.billing_period === 'one_time' ? 'one_time' as const : 'recurring' as const,
  }))

  return NextResponse.json({
    currency,
    billingPlatform: (job.billing_platform as string | null) ?? 'stripe',
    hasCustomer:     Boolean(job.billing_customer_id),
    meters,
    presetFees,
  })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id: jobId } = await params
  const body = await req.json() as {
    meterKey?:  string
    usage?:     number
    fixedFee?:  { label: string; amount: number } | null
    oneTimeFee?: { label: string; amount: number } | null
    push:       boolean
  }

  const job = await loadJob(jobId, org.orgId)
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  const termsArr = job.contract_terms as unknown as Array<{ currency?: string; payment_terms_days?: number | null }>
  const terms    = termsArr?.[0] ?? {}
  const currency = (terms.currency ?? 'EUR').toUpperCase()
  const netDays  = terms.payment_terms_days ?? 30

  const lineItems: Array<{ description: string; quantity: number; unitPrice: number }> = []
  let overageSnapshot: {
    meter_key: string; total_units: number; included_units: number; billable_units: number
    rate_per_unit: number; amount: number; currency: string; description: string; metric_source: 'meter_pull'
  } | null = null

  if (body.meterKey && body.usage != null && body.usage > 0) {
    const { data: mapping } = await supabaseServer
      .from('contract_meter_mappings')
      .select('included_units, overage_tiers')
      .eq('job_id', jobId)
      .eq('meter_key', body.meterKey)
      .eq('confirmed', true)
      .maybeSingle()

    if (!mapping) {
      return NextResponse.json({ error: `No confirmed mapping for meter '${body.meterKey}' on this job` }, { status: 400 })
    }

    const includedUnits = (mapping.included_units as number) ?? 0
    const rawTiers = (mapping.overage_tiers ?? []) as Array<{ from_unit?: number | null; to_unit?: number | null; rate_per_unit?: number; tier_calculation?: OverageTier['tier_calculation'] }>
    const tiers: OverageTier[] = rawTiers.map((t, i) => ({
      tier_label:    `Tier ${i + 1}`,
      from_unit:     t.from_unit ?? null,
      to_unit:       t.to_unit   ?? null,
      rate_per_unit: t.rate_per_unit ?? 0,
      unit_type:     body.meterKey!,
      tier_calculation: t.tier_calculation ?? null,
    }))
    const overageResult = tiers.length > 0 ? computeMetricOverage(body.usage, tiers, includedUnits) : { amount: 0, method: 'graduated' as const, requiresConfirmation: false }
    if (overageResult.requiresConfirmation) {
      return NextResponse.json({
        error: `Meter '${body.meterKey}' has more than one price tier and its calculation method (graduated vs. volume vs. block) hasn't been confirmed yet. Resolve it in the Review panel before invoicing this usage.`,
      }, { status: 409 })
    }
    const rawAmount = overageResult.amount
    const amount    = Math.round(rawAmount * 100) / 100
    const billable  = Math.max(0, body.usage - includedUnits)
    const rate      = tiers[0]?.rate_per_unit ?? (billable > 0 ? amount / billable : 0)
    const description = describeTieredUsage(body.meterKey, body.usage, tiers, includedUnits, true, overageResult.method)

    // A single line item at quantity 1 — usage spanning multiple tiers has no
    // single per-unit rate, so quantity × unitPrice must never be used here,
    // or the pushed invoice amount would only reflect the first tier's rate.
    lineItems.push({ description, quantity: 1, unitPrice: amount })
    overageSnapshot = {
      meter_key: body.meterKey, total_units: body.usage, included_units: includedUnits,
      billable_units: billable, rate_per_unit: rate, amount,
      currency, description, metric_source: 'meter_pull',
    }
  }

  if (body.fixedFee?.label && body.fixedFee.amount > 0) {
    lineItems.push({ description: body.fixedFee.label, quantity: 1, unitPrice: body.fixedFee.amount })
  }
  if (body.oneTimeFee?.label && body.oneTimeFee.amount > 0) {
    lineItems.push({ description: body.oneTimeFee.label, quantity: 1, unitPrice: body.oneTimeFee.amount })
  }

  if (lineItems.length === 0) {
    return NextResponse.json({ error: 'Add usage for a meter, a fixed fee, or a one-time fee first' }, { status: 400 })
  }

  const total = Math.round(lineItems.reduce((s, i) => s + i.quantity * i.unitPrice, 0) * 100) / 100

  if (!body.push) {
    return NextResponse.json({ preview: { lineItems, total, currency } })
  }

  if (!job.billing_customer_id) {
    return NextResponse.json({ error: 'No billing customer on this job' }, { status: 400 })
  }

  try {
    const { invoiceId, hostedUrl } = await createAdHocInvoice({
      orgId:           org.orgId,
      billingPlatform: ((job.billing_platform as string | null) ?? 'stripe') as 'stripe' | 'remembill',
      customerId:      job.billing_customer_id as string,
      currency,
      netDays,
      lineItems,
      idempotencyKey: `verdix-manual-${jobId}-${Date.now()}`,
      metadata: { verdix_job: jobId, invoice_type: 'manual_verification' },
    })

    const todayStr = new Date().toISOString().slice(0, 10)
    await supabaseServer.from('planned_invoices').insert({
      job_id:             jobId,
      org_id:             org.orgId,
      year_num:           null,
      period_start:       todayStr,
      period_end:         todayStr,
      base_amount:        total,
      currency,
      fee_label:          'Manual verification invoice',
      invoice_type:       'one_time',
      status:             'sent',
      stripe_invoice_id:  invoiceId,
      stripe_invoice_url: hostedUrl,
      sent_at:            new Date().toISOString(),
      quantity:           lineItems.length === 1 ? lineItems[0].quantity : null,
      unit_price:         lineItems.length === 1 ? lineItems[0].unitPrice : null,
      // overage_line_items is kept for audit/reference only — base_amount
      // (total) already includes the overage amount, so overage_total must
      // stay 0 here or downstream code that does base_amount + overage_total
      // (billing-summary's mapPlanned) double-counts it.
      overage_line_items: overageSnapshot ? [overageSnapshot] : [],
      overage_total:      0,
    })

    return NextResponse.json({ ok: true, invoiceId, hostedUrl, total })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
