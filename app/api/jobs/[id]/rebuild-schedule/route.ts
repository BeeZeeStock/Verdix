import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { computeBillingSchedule } from '@/lib/billing-writer'
import type { ContractTerms } from '@/lib/types'

// Rebuilds planned_invoices from the current contract_terms, sends any
// immediately-due invoices to Stripe, and queues future ones as scheduled rows.
// Safe to call on already-completed contracts — deletes existing planned rows first.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id } = await params

  const { data: job } = await supabaseServer
    .from('jobs')
    .select('org_id, billing_customer_id, billing_platform, contract_terms(*)')
    .eq('id', id)
    .eq('org_id', org.orgId)
    .single()

  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!job.billing_customer_id) return NextResponse.json({ error: 'No customer configured yet — approve the contract first' }, { status: 400 })
  if (job.billing_platform === 'chargebee') return NextResponse.json({ error: 'Chargebee not supported' }, { status: 400 })

  const terms = (job.contract_terms as unknown as ContractTerms[])?.[0]
  if (!terms) return NextResponse.json({ error: 'No contract terms' }, { status: 400 })

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

  const customerId = job.billing_customer_id as string
  const cur = (terms.currency ?? 'EUR').toLowerCase()
  const daysUntilDue = terms.payment_terms_days ?? 30
  const now = new Date()
  const contractId = terms.contract_id ?? id

  const formatDate = (d: Date) => {
    const y  = d.getFullYear()
    const mo = String(d.getMonth() + 1).padStart(2, '0')
    const dy = String(d.getDate()).padStart(2, '0')
    return `${y}-${mo}-${dy}`
  }
  const fmtLabel = (d: Date) => d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })

  // Wipe existing planned rows so we start clean
  await supabaseServer.from('planned_invoices').delete().eq('job_id', id)

  const periods = computeBillingSchedule(terms)
  if (periods.length === 0) {
    return NextResponse.json({ error: 'Cannot compute billing schedule — contract is missing start/end dates or term length' }, { status: 422 })
  }

  type PlannedRow = {
    job_id: string; org_id: string
    year_num: number | null; period_start: string; period_end: string
    base_amount: number; currency: string; fee_label: string | null
    invoice_type: string; status: string
    stripe_invoice_id: string | null; stripe_invoice_url: string | null
    sent_at: string | null
  }
  const plannedRows: PlannedRow[] = []

  for (const period of periods) {
    const isDue = period.periodStart <= now
    const description = `Base subscription — Year ${period.yearNum} (${fmtLabel(period.periodStart)} – ${fmtLabel(period.periodEnd)})`

    if (isDue && period.baseAmount > 0) {
      const inv = await stripe.invoices.create({
        customer:                       customerId,
        collection_method:              'send_invoice',
        days_until_due:                 daysUntilDue,
        pending_invoice_items_behavior: 'exclude',
        metadata: {
          verdix_job:      id,
          verdix_contract: contractId,
          invoice_type:    'period',
          year:            String(period.yearNum),
          scheduled_date:  formatDate(period.periodStart),
        },
      })
      await stripe.invoiceItems.create({
        customer:    customerId,
        invoice:     inv.id,
        amount:      Math.round(period.baseAmount * 100),
        currency:    cur,
        description,
      })
      const finalized = await stripe.invoices.finalizeInvoice(inv.id).catch(err => {
        console.error('[rebuild-schedule] finalizeInvoice failed', err)
        return inv
      })
      plannedRows.push({
        job_id: id, org_id: org.orgId,
        year_num: period.yearNum,
        period_start: formatDate(period.periodStart),
        period_end:   formatDate(period.periodEnd),
        base_amount:  period.baseAmount,
        currency:     terms.currency ?? 'EUR',
        fee_label:    null,
        invoice_type: 'period',
        status:       'sent',
        stripe_invoice_id:  inv.id,
        stripe_invoice_url: finalized.hosted_invoice_url ?? null,
        sent_at: new Date().toISOString(),
      })
    } else {
      plannedRows.push({
        job_id: id, org_id: org.orgId,
        year_num: period.yearNum,
        period_start: formatDate(period.periodStart),
        period_end:   formatDate(period.periodEnd),
        base_amount:  period.baseAmount,
        currency:     terms.currency ?? 'EUR',
        fee_label:    null,
        invoice_type: 'period',
        status:       'scheduled',
        stripe_invoice_id:  null,
        stripe_invoice_url: null,
        sent_at: null,
      })
    }
  }

  if (plannedRows.length > 0) {
    const { error } = await supabaseServer.from('planned_invoices').insert(plannedRows)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, periods: plannedRows.length })
}
