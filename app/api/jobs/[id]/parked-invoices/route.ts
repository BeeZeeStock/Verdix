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
import { REMEMBILL_BASE, remembillHeaders, remembillAppUrl, safeHeaderValue } from '@/lib/billing-writer'

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
    .select('org_id, billing_customer_id, billing_platform, contract_terms(currency, payment_terms_days)')
    .eq('id', jobId)
    .eq('org_id', org.orgId)
    .single()

  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  if (!job.billing_customer_id) return NextResponse.json({ error: 'No billing customer on this job' }, { status: 400 })

  const termsArr        = job.contract_terms as unknown as Array<{ currency?: string; payment_terms_days?: number | null }>
  const terms           = termsArr?.[0] ?? {}
  const cur             = (body.currency ?? terms.currency ?? 'EUR').toUpperCase()
  const netDays         = terms.payment_terms_days ?? 30
  const billingPlatform = (job.billing_platform as string | null) ?? 'stripe'

  const today    = new Date()
  const todayStr = today.toISOString().slice(0, 10)
  const lineDesc = description
    ?? `${fee_label} — ${quantity} ${metric_name} @ ${cur} ${rate_per_unit}/${metric_name}`

  const fmtDate = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

  try {
    let invoiceId:  string
    let hostedUrl:  string | null

    // ── Remembill ──────────────────────────────────────────────────────────
    if (billingPlatform === 'remembill') {
      const { data: rbIntegration } = await supabaseServer
        .from('org_integrations')
        .select('config')
        .eq('org_id', org.orgId)
        .eq('connector_name', 'remembill')
        .eq('is_active', true)
        .maybeSingle()

      const rbKey = (rbIntegration?.config as Record<string, string>)?.api_key ?? process.env.REMEMBILL_API_KEY!
      const rbH   = remembillHeaders(rbKey)
      const dueDate = new Date(today.getTime() + netDays * 86_400_000)

      const invRes = await fetch(`${REMEMBILL_BASE}/invoices`, {
        method: 'POST',
        headers: { ...rbH, 'Idempotency-Key': safeHeaderValue(`verdix-parked-${jobId}-${fee_label}-${todayStr}`) },
        body: JSON.stringify({
          customer_id:   job.billing_customer_id,
          currency:      cur,
          issue_date:    todayStr,
          due_date:      fmtDate(dueDate),
          payment_terms: `Net ${netDays}`,
        }),
      })
      if (!invRes.ok) {
        const rawBody = await invRes.text()
        console.error('[parked-invoices/remembill] invoice creation failed', invRes.status, rawBody)
        throw new Error(`Remembill invoice creation failed (${invRes.status}): ${rawBody}`)
      }
      invoiceId = ((await invRes.json()) as { id: string }).id

      // Add line item row (amount in minor units)
      await fetch(`${REMEMBILL_BASE}/invoices/${invoiceId}/rows`, {
        method: 'POST', headers: rbH,
        body: JSON.stringify({ name: lineDesc, quantity, unit_price: Math.round(rate_per_unit * 100), vat_rate: 0 }),
      })

      // Deliver via email
      await fetch(`${REMEMBILL_BASE}/invoices/${invoiceId}/email`, {
        method: 'POST', headers: rbH, body: JSON.stringify({}),
      }).catch(err => console.error('[parked-invoices/remembill] email delivery failed', err))

      hostedUrl = remembillAppUrl('')

    // ── Stripe (default) ───────────────────────────────────────────────────
    } else {
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

      const inv = await stripe.invoices.create({
        customer:                       job.billing_customer_id as string,
        collection_method:              'send_invoice',
        days_until_due:                 netDays,
        pending_invoice_items_behavior: 'exclude',
        metadata: {
          verdix_job: jobId, fee_type: 'parked_service', fee_label,
          invoice_type: 'one_time', scheduled_date: todayStr,
          metric_name, quantity: String(quantity), rate_per_unit: String(rate_per_unit),
        },
      })

      await stripe.invoiceItems.create({
        customer:    job.billing_customer_id as string,
        invoice:     inv.id,
        amount:      Math.round(amount * 100),
        currency:    cur.toLowerCase(),
        description: lineDesc,
      })

      const finalized = await stripe.invoices.finalizeInvoice(inv.id).catch(err => {
        console.error('[parked-invoices] finalizeInvoice failed', err)
        return inv
      })

      invoiceId = inv.id
      hostedUrl = finalized.hosted_invoice_url ?? null
    }

    // Insert a new planned_invoice row for this delivery (template stays as 'parked')
    const { error } = await supabaseServer
      .from('planned_invoices')
      .insert({
        job_id:             jobId,
        org_id:             org.orgId,
        year_num:           null,
        period_start:       todayStr,
        period_end:         todayStr,
        base_amount:        amount,
        currency:           cur,
        fee_label,
        invoice_type:       'one_time',
        status:             'sent',
        stripe_invoice_id:  invoiceId,
        stripe_invoice_url: hostedUrl,
        sent_at:            new Date().toISOString(),
      })

    if (error) console.error('[parked-invoices] planned_invoices insert failed', error)

    return NextResponse.json({ ok: true, invoiceId, amount, hostedUrl })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}

/**
 * PATCH /api/jobs/[id]/parked-invoices
 *   Moves an existing planned_invoice row (scheduled or sent) to parked status.
 *   If a Stripe invoice exists and is still voidable (draft/open), it is voided first.
 *   Body: { planned_invoice_id: string }
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id: jobId } = await params
  const { planned_invoice_id } = await req.json() as { planned_invoice_id: string }

  if (!planned_invoice_id) {
    return NextResponse.json({ error: 'planned_invoice_id required' }, { status: 400 })
  }

  // Fetch the row and confirm it belongs to this job/org
  const { data: row } = await supabaseServer
    .from('planned_invoices')
    .select('id, stripe_invoice_id, job_id, org_id')
    .eq('id', planned_invoice_id)
    .eq('job_id', jobId)
    .eq('org_id', org.orgId)
    .maybeSingle()

  if (!row) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })

  // Void the external invoice if one exists and is still voidable
  if (row.stripe_invoice_id) {
    // Detect billing platform from the job
    const { data: jobRow } = await supabaseServer
      .from('jobs')
      .select('billing_platform')
      .eq('id', jobId)
      .maybeSingle()
    const billingPlatform = (jobRow?.billing_platform as string | null) ?? 'stripe'

    if (billingPlatform === 'remembill') {
      // Remembill: DELETE the draft invoice (only drafts can be deleted)
      const { data: rbIntegration } = await supabaseServer
        .from('org_integrations')
        .select('config')
        .eq('org_id', org.orgId)
        .eq('connector_name', 'remembill')
        .eq('is_active', true)
        .maybeSingle()

      const rbKey = (rbIntegration?.config as Record<string, string>)?.api_key ?? process.env.REMEMBILL_API_KEY!
      await fetch(`${REMEMBILL_BASE}/invoices/${row.stripe_invoice_id}`, {
        method: 'DELETE', headers: remembillHeaders(rbKey),
      }).catch(err => console.error('[parked-invoices/remembill] delete failed', err))

    } else {
      // Stripe: void if draft or open
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

      try {
        const stripeInv = await stripe.invoices.retrieve(row.stripe_invoice_id as string)
        if (stripeInv.status === 'draft' || stripeInv.status === 'open') {
          await stripe.invoices.voidInvoice(row.stripe_invoice_id as string)
        }
      } catch (err) {
        console.error('[parked-invoices] stripe void failed', err)
      }
    }
  }

  // Flip the row to parked and clear Stripe references
  const { error } = await supabaseServer
    .from('planned_invoices')
    .update({
      status:             'parked',
      stripe_invoice_id:  null,
      stripe_invoice_url: null,
      sent_at:            null,
    })
    .eq('id', planned_invoice_id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
