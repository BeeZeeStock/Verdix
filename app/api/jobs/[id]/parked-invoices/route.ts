/**
 * POST /api/jobs/[id]/parked-invoices
 *   Generates a Stripe invoice for a parked (manual-trigger) service fee.
 *   The parked planned_invoice row acts as a reusable template — a new invoice
 *   row is inserted each time the user confirms a service delivery.
 *
 *   Body: { fee_label, quantity, rate_per_unit, metric_name, currency, description? }
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id: jobId } = await params

  const body = await req.json() as {
    fee_label:    string
    quantity:     number
    rate_per_unit: number
    metric_name:  string
    currency?:    string
    description?: string
  }

  const { fee_label, quantity, rate_per_unit, metric_name, description } = body
  if (!fee_label || !quantity || !rate_per_unit) {
    return NextResponse.json({ error: 'fee_label, quantity, and rate_per_unit are required' }, { status: 400 })
  }

  const amount = Math.round(quantity * rate_per_unit * 100) / 100

  // Fetch job + billing config
  const { data: job } = await supabaseServer
    .from('jobs')
    .select('org_id, billing_customer_id, contract_terms(currency, payment_terms_days)')
    .eq('id', jobId)
    .eq('org_id', org.orgId)
    .single()

  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  if (!job.billing_customer_id) return NextResponse.json({ error: 'No Stripe customer on this job' }, { status: 400 })

  const termsArr = job.contract_terms as unknown as Array<{ currency?: string; payment_terms_days?: number | null }>
  const terms    = termsArr?.[0] ?? {}
  const cur      = (body.currency ?? terms.currency ?? 'EUR').toLowerCase()
  const netDays  = terms.payment_terms_days ?? 30

  // Load Stripe key
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

  const today    = new Date()
  const todayStr = today.toISOString().slice(0, 10)

  const lineDesc = description
    ?? `${fee_label} — ${quantity} ${metric_name} @ ${cur.toUpperCase()} ${rate_per_unit}/${metric_name}`

  try {
    const inv = await stripe.invoices.create({
      customer:                       job.billing_customer_id as string,
      collection_method:              'send_invoice',
      days_until_due:                 netDays,
      pending_invoice_items_behavior: 'exclude',
      metadata: {
        verdix_job:      jobId,
        fee_type:        'parked_service',
        fee_label,
        invoice_type:    'one_time',
        scheduled_date:  todayStr,
        metric_name,
        quantity:        String(quantity),
        rate_per_unit:   String(rate_per_unit),
      },
    })

    await stripe.invoiceItems.create({
      customer:    job.billing_customer_id as string,
      invoice:     inv.id,
      amount:      Math.round(amount * 100),
      currency:    cur,
      description: lineDesc,
    })

    const finalized = await stripe.invoices.finalizeInvoice(inv.id).catch(err => {
      console.error('[parked-invoices] finalizeInvoice failed', err)
      return inv
    })

    // Insert a new planned_invoice row for this delivery (template row stays as 'parked')
    const { error } = await supabaseServer
      .from('planned_invoices')
      .insert({
        job_id:             jobId,
        org_id:             org.orgId,
        year_num:           null,
        period_start:       todayStr,
        period_end:         todayStr,
        base_amount:        amount,
        currency:           cur.toUpperCase(),
        fee_label,
        invoice_type:       'one_time',
        status:             'sent',
        stripe_invoice_id:  inv.id,
        stripe_invoice_url: finalized.hosted_invoice_url ?? null,
        sent_at:            new Date().toISOString(),
      })

    if (error) {
      console.error('[parked-invoices] planned_invoices insert failed', error)
    }

    return NextResponse.json({
      ok:         true,
      invoiceId:  inv.id,
      amount,
      hostedUrl:  finalized.hosted_invoice_url ?? null,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
