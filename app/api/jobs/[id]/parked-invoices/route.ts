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
import { resolveVatTreatment, computeVat, reconcileGrossAmount } from '@/lib/vat'
import { getCustomerVatConfig } from '@/lib/vat-service'
import { unwrapEmbedded } from '@/lib/postgrest-helpers'

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

  const terms = unwrapEmbedded(job.contract_terms as unknown as { currency?: string; payment_terms_days?: number | null } | Array<{ currency?: string; payment_terms_days?: number | null }>) ?? {}
  const cur   = (body.currency ?? terms.currency ?? 'EUR').toUpperCase()

  // Link back to the approved line_items row (for traceability — quantity
  // itself is per-delivery human input, not read from here).
  const { data: matchingLineItem } = await supabaseServer
    .from('line_items')
    .select('id')
    .eq('job_id', jobId)
    .eq('product_name', fee_label)
    .eq('billing_period', 'one_time')
    .maybeSingle()
  const netDays         = terms.payment_terms_days ?? 30
  const billingPlatform = (job.billing_platform as string | null) ?? 'stripe'

  const today    = new Date()
  const todayStr = today.toISOString().slice(0, 10)
  const lineDesc = description
    ?? `${fee_label} — ${quantity} ${metric_name} @ ${cur} ${rate_per_unit}/${metric_name}`

  const fmtDate = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

  // Verdix owns the complete invoice instruction here too — same
  // resolution/fail-closed gate as invoice-scheduler's real per-period
  // invoices. No per-invoice override exists yet at this point (the
  // planned_invoice row for this delivery is only created after send), so
  // only the customer's standing default applies.
  const customerVat = await getCustomerVatConfig(org.orgId, job.billing_customer_id as string)
  const vatTreatment = resolveVatTreatment(customerVat, null)
  const vatResult = computeVat(amount, vatTreatment)
  if (!vatResult.ok) {
    return NextResponse.json({ error: `Billing blocked: ${vatResult.reason}` }, { status: 400 })
  }
  const { vatRatePct, vatAmount, grossAmount: expectedGrossAmount } = vatResult.calculation

  try {
    let invoiceId:  string
    let hostedUrl:  string | null
    let actualGrossAmount: number | null = null

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
      const dueDate    = new Date(today.getTime() + netDays * 86_400_000)
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
      // Handle both flat { id } and wrapped { invoice: { id } } response shapes
      const invJson = await invRes.json() as Record<string, unknown>
      const invObj  = (invJson.invoice ?? invJson.data ?? invJson) as Record<string, unknown>
      invoiceId = invObj.id as string
      if (!invoiceId) throw new Error(`Remembill invoice creation: could not extract id from response: ${JSON.stringify(invJson)}`)

      // price is in öre (minor units): 1 kr = 100 öre. vat is 0–100 percent,
      // resolved above from customer_vat_config — never hardcoded.
      // Row is also included in the creation body (billing-writer strategy A) as a belt-and-suspenders
      // measure; here we follow up with POST /rows in case Remembill needs both.
      await fetch(`${REMEMBILL_BASE}/invoices/${invoiceId}/rows`, {
        method: 'POST', headers: rbH,
        body: JSON.stringify({ name: lineDesc, quantity, price: Math.round(rate_per_unit * 100), vat: Math.round(vatRatePct) }),
      })

      // Deliver via email
      await fetch(`${REMEMBILL_BASE}/invoices/${invoiceId}/email`, {
        method: 'POST', headers: rbH, body: JSON.stringify({}),
      }).catch(err => console.error('[parked-invoices/remembill] email delivery failed', err))

      hostedUrl = remembillAppUrl('')

      // Reconcile: read the invoice back and compare Remembill's own
      // returned total against Verdix's expected gross.
      try {
        const getRes = await fetch(`${REMEMBILL_BASE}/invoices/${invoiceId}`, { headers: rbH })
        if (getRes.ok) {
          const getJson = await getRes.json() as Record<string, unknown>
          const getObj = (getJson.invoice ?? getJson.data ?? getJson) as Record<string, unknown>
          const rawTotal = getObj.total ?? getObj.total_amount ?? getObj.amount_total
          if (typeof rawTotal === 'number') actualGrossAmount = rawTotal / 100
        }
      } catch (err) {
        console.error('[parked-invoices/remembill] post-send reconciliation fetch failed', err)
      }

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

      let stripeTaxRateId: string | null = null
      if (vatTreatment.mode === 'rate' && vatRatePct > 0) {
        const existing = await stripe.taxRates.list({ active: true, limit: 100 })
        const match = existing.data.find(tr => tr.display_name === 'VAT' && tr.percentage === vatRatePct && !tr.inclusive)
        stripeTaxRateId = match?.id
          ?? (await stripe.taxRates.create({ display_name: 'VAT', percentage: vatRatePct, inclusive: false })).id
      }

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
        tax_rates:   stripeTaxRateId ? [stripeTaxRateId] : undefined,
      })

      const finalized = await stripe.invoices.finalizeInvoice(inv.id).catch(err => {
        console.error('[parked-invoices] finalizeInvoice failed', err)
        return inv
      })

      invoiceId = inv.id
      hostedUrl = finalized.hosted_invoice_url ?? null
      if (typeof finalized.total === 'number') actualGrossAmount = finalized.total / 100
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
        line_item_id:       matchingLineItem?.id ?? null,
        quantity,
        unit_price:         rate_per_unit,
        vat_mode:                  vatTreatment.mode,
        vat_rate_pct:              vatTreatment.mode === 'rate' ? vatRatePct : null,
        vat_source:                'customer_default',
        net_amount:                amount,
        vat_amount:                vatAmount,
        gross_amount:              expectedGrossAmount,
        vat_reconciliation_status: reconcileGrossAmount(expectedGrossAmount, actualGrossAmount),
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
