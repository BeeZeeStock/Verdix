/**
 * GET /api/admin/invoice-scheduler
 *
 * Daily cron: find planned_invoices whose period_start is today or earlier and
 * status is 'scheduled'. For each:
 *   1. Pull usage data for the closed period
 *   2. Compute overages
 *   3. Create a complete standalone Stripe invoice (base + overages)
 *   4. Finalize and send
 *   5. Mark the planned_invoice row as 'sent'
 *
 * Protected by x-cron-secret header (same CRON_SECRET env var as billing-cron).
 *
 * Vercel Cron: add to vercel.json —
 *   { "crons": [{ "path": "/api/admin/invoice-scheduler", "schedule": "0 6 * * *" }] }
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { REMEMBILL_BASE, remembillHeaders, remembillAppUrl } from '@/lib/billing-writer'
import { computeOverageForPeriod, type OverageLineItem } from '@/lib/usage-pull'
import type { ContractTerms } from '@/lib/types'
import { isAuthorizedCronRequest } from '@/lib/cron-auth'

export async function GET(req: NextRequest) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const today = new Date().toISOString().slice(0, 10)

  // ── Find all due planned invoices ─────────────────────────────────────────
  const { data: dueRows, error: fetchError } = await supabaseServer
    .from('planned_invoices')
    .select('*')
    .eq('status', 'scheduled')
    .lte('period_start', today)
    .order('period_start', { ascending: true })

  if (fetchError) {
    console.error('[invoice-scheduler] failed to fetch due rows', fetchError)
    return NextResponse.json({ error: fetchError.message }, { status: 500 })
  }

  if (!dueRows?.length) {
    return NextResponse.json({ processed: 0, results: [] })
  }

  const results: { id: string; ok: boolean; stripe_invoice_id?: string; error?: string }[] = []

  for (const row of dueRows) {
    // Mark as processing so concurrent runs skip it
    const { error: lockError } = await supabaseServer
      .from('planned_invoices')
      .update({ status: 'processing' })
      .eq('id', row.id)
      .eq('status', 'scheduled')

    if (lockError) {
      // Another run already grabbed this row
      continue
    }

    try {
      // ── Fetch job + contract terms ────────────────────────────────────────
      const { data: job } = await supabaseServer
        .from('jobs')
        .select('id, org_id, billing_customer_id, billing_platform, contract_terms ( * )')
        .eq('id', row.job_id)
        .single()

      if (!job) throw new Error(`Job ${row.job_id} not found`)

      const termsArr = job.contract_terms as unknown as ContractTerms[]
      const terms    = termsArr?.[0]
      if (!terms) throw new Error(`No contract terms for job ${row.job_id}`)

      const customerId = (job.billing_customer_id as string | null)
        ?? (typeof job === 'object' && 'billing_customer_id' in job ? String(job.billing_customer_id) : null)

      if (!customerId) throw new Error(`No billing_customer_id for job ${row.job_id}`)

      const billingPlatform = (job.billing_platform as string | null) ?? 'stripe'
      const cur             = (terms.currency ?? 'EUR').toLowerCase()
      const periodStart     = new Date(row.period_start + 'T00:00:00')
      const periodEnd       = new Date(row.period_end   + 'T23:59:59')
      const fmtPeriod       = (d: Date) => d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
      const daysUntilDue    = terms.payment_terms_days ?? 30
      // Real per-unit breakdown (from the approved line_items row, e.g. "4
      // connectors @ 45,000"), when one was captured at push/parked-confirm
      // time — null for period rows and one-time fees without a real quantity.
      const rowQuantity  = row.quantity  != null ? Number(row.quantity)   : null
      const rowUnitPrice = row.unit_price != null ? Number(row.unit_price) : null
      const hasBreakdown = rowQuantity != null && rowUnitPrice != null && rowQuantity > 0 && rowUnitPrice > 0

      const description = (row.fee_label
        ?? `Base subscription — Year ${row.year_num ?? 1} (${fmtPeriod(periodStart)} – ${fmtPeriod(periodEnd)})`)
        + (hasBreakdown ? ` — ${rowQuantity.toLocaleString()} × ${cur.toUpperCase()} ${rowUnitPrice.toLocaleString()}` : '')

      let sentInvoiceId:  string | null = null
      let sentInvoiceUrl: string | null = null

      // Overage is billed in arrears, on the same invoice as the next
      // period's advance base fee — this row's own period_start/period_end
      // describe the period the BASE FEE covers (prepaid, hence due the
      // moment it starts). Usage for that period doesn't exist yet at that
      // point, so overage must be computed for the period that just closed
      // (the one immediately before this row), not this row's own period —
      // querying it fresh each run rather than trusting whatever was
      // recorded on that period's own (necessarily $0, prematurely-computed)
      // invoice.
      let overageLineItems: OverageLineItem[] = []
      if (row.invoice_type === 'period') {
        const { data: prevPeriod } = await supabaseServer
          .from('planned_invoices')
          .select('period_start, period_end')
          .eq('job_id', row.job_id)
          .eq('invoice_type', 'period')
          .lt('period_end', row.period_start)
          .order('period_end', { ascending: false })
          .limit(1)
          .maybeSingle()

        // No prior invoice (this is the job's first) — scan from the
        // contract's own start date instead of skipping outright. A meter
        // with a shorter measurement cadence than the deal's first invoice
        // period (e.g. a monthly-measured metric inside a quarterly-billed
        // first invoice) can still have closed windows to bill even before
        // any invoice has ever gone out.
        const scanStart = prevPeriod?.period_start ?? terms.contract_start_date
        // toISOString() converts to UTC first — on a server not running in
        // UTC that silently shifts this a day off from the local calendar
        // date d was built from. Format from d's own local fields instead.
        const scanEnd    = prevPeriod?.period_end
          ?? (() => {
            const d = new Date(row.period_start + 'T00:00:00')
            d.setDate(d.getDate() - 1)
            const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0')
            return `${y}-${m}-${day}`
          })()

        if (scanStart) {
          overageLineItems = await computeOverageForPeriod({
            orgId: job.org_id, jobId: row.job_id, terms, customerId,
            periodStartUnix: Math.floor(new Date(scanStart + 'T00:00:00').getTime() / 1000),
            periodEndUnix:   Math.floor(new Date(scanEnd   + 'T23:59:59').getTime() / 1000),
            currency: cur,
          })
        }
      }

      // ── Remembill path ────────────────────────────────────────────────────
      if (billingPlatform === 'remembill') {
        const { data: rbIntegration } = await supabaseServer
          .from('org_integrations')
          .select('config')
          .eq('org_id', job.org_id)
          .eq('connector_name', 'remembill')
          .eq('is_active', true)
          .maybeSingle()

        const rbKey = (rbIntegration?.config as Record<string, string>)?.api_key ?? process.env.REMEMBILL_API_KEY!
        const rbH   = remembillHeaders(rbKey)
        const today = new Date()
        const fmtDate = (d: Date) =>
          `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

        // Create draft invoice
        const invRes = await fetch(`${REMEMBILL_BASE}/invoices`, {
          method: 'POST', headers: { ...rbH, 'Idempotency-Key': `verdix-sched-${row.id}` },
          body: JSON.stringify({
            customer_id:   customerId,
            currency:      cur.toUpperCase(),
            issue_date:    fmtDate(today),
            due_date:      fmtDate(new Date(today.getTime() + daysUntilDue * 86_400_000)),
            payment_terms: `Net ${daysUntilDue}`,
          }),
        })
        if (!invRes.ok) {
          const rawBody = await invRes.text()
          console.error('[invoice-scheduler/remembill] invoice creation failed', invRes.status, rawBody)
          throw new Error(`Remembill invoice creation failed (${invRes.status}): ${rawBody}`)
        }
        const invoiceId = ((await invRes.json()) as { id: string }).id

        // Add line item row (amount in minor units, e.g. öre for SEK).
        // Real quantity/unit_price when we have a per-unit breakdown, else
        // the previous flat quantity=1/total-as-price behavior.
        await fetch(`${REMEMBILL_BASE}/invoices/${invoiceId}/rows`, {
          method: 'POST', headers: rbH,
          body: JSON.stringify(hasBreakdown
            ? { description, quantity: rowQuantity, unit_price: Math.round(rowUnitPrice * 100) }
            : { description, quantity: 1, unit_price: Math.round(Number(row.base_amount) * 100) }),
        })

        // Overage rows — one per metered item with usage above its included allowance
        for (const item of overageLineItems) {
          await fetch(`${REMEMBILL_BASE}/invoices/${invoiceId}/rows`, {
            method: 'POST', headers: rbH,
            body: JSON.stringify({ description: item.description, quantity: 1, unit_price: Math.round(item.amount * 100) }),
          }).catch(err => console.error(`[invoice-scheduler/remembill] overage row failed for meter '${item.meter_key}'`, err))
        }

        // Deliver via email
        await fetch(`${REMEMBILL_BASE}/invoices/${invoiceId}/email`, {
          method: 'POST', headers: rbH, body: JSON.stringify({}),
        }).catch(err => console.error('[invoice-scheduler/remembill] email delivery failed', err))

        sentInvoiceId  = invoiceId
        sentInvoiceUrl = remembillAppUrl(`/invoices/${invoiceId}`)

      // ── Stripe path (default) ─────────────────────────────────────────────
      } else {
        const { data: integration } = await supabaseServer
          .from('org_integrations')
          .select('config')
          .eq('org_id', job.org_id)
          .eq('connector_name', 'stripe')
          .eq('is_active', true)
          .maybeSingle()

        const stripeKey = (integration?.config as Record<string, string>)?.secret_key
          ?? process.env.STRIPE_SECRET_KEY!

        const { default: Stripe } = await import('stripe')
        const stripe = new Stripe(stripeKey, { apiVersion: '2026-06-24.dahlia' })

        const inv = await stripe.invoices.create({
          customer:                       customerId,
          collection_method:              'send_invoice',
          days_until_due:                 daysUntilDue,
          pending_invoice_items_behavior: 'exclude',
          metadata: {
            verdix_job:      row.job_id,
            invoice_type:    row.invoice_type,
            year:            String(row.year_num ?? ''),
            scheduled_date:  row.period_start,
            planned_invoice: row.id,
          },
        })

        if (row.base_amount > 0) {
          await stripe.invoiceItems.create({
            customer:    customerId,
            invoice:     inv.id,
            amount:      Math.round(Number(row.base_amount) * 100),
            currency:    cur,
            description,
          })
        }

        // ── Overage line items (already pulled + computed above) ────────────
        for (const item of overageLineItems) {
          await stripe.invoiceItems.create({
            customer:    customerId,
            invoice:     inv.id,
            amount:      Math.round(item.amount * 100),
            currency:    cur,
            description: item.description,
            metadata: { metric_source: item.metric_source, meter_key: item.meter_key, total_units: String(item.total_units), verdix_job: row.job_id },
          })
        }

        const finalized = await stripe.invoices.finalizeInvoice(inv.id)
        sentInvoiceId  = inv.id
        sentInvoiceUrl = finalized.hosted_invoice_url ?? null
      }

      // ── Mark planned_invoice as sent ──────────────────────────────────────
      await supabaseServer
        .from('planned_invoices')
        .update({
          status:              'sent',
          stripe_invoice_id:   sentInvoiceId,
          stripe_invoice_url:  sentInvoiceUrl,
          sent_at:             new Date().toISOString(),
          error_message:       null,
          overage_line_items:  overageLineItems,
          overage_total:       overageLineItems.reduce((s, i) => s + i.amount, 0),
        })
        .eq('id', row.id)

      results.push({ id: row.id, ok: true, stripe_invoice_id: sentInvoiceId ?? undefined })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[invoice-scheduler] failed for planned_invoice ${row.id}`, err)

      await supabaseServer
        .from('planned_invoices')
        .update({ status: 'failed', error_message: message })
        .eq('id', row.id)

      results.push({ id: row.id, ok: false, error: message })
    }
  }

  const succeeded = results.filter(r => r.ok).length
  const failed    = results.filter(r => !r.ok).length
  console.log(`[invoice-scheduler] processed ${results.length}: ${succeeded} ok, ${failed} failed`)

  return NextResponse.json({ processed: results.length, succeeded, failed, results })
}
