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
import { computeMetricOverage } from '@/lib/tariff'
import { REMEMBILL_BASE, remembillHeaders, remembillAppUrl } from '@/lib/billing-writer'
import type { ContractTerms } from '@/lib/types'

type MeterCfg = {
  meter_key: string
  included_units: number
  overage_tiers: Array<{ from_unit?: number | null; to_unit?: number | null; rate_per_unit?: number }>
}
type MeterDef = {
  pull_endpoint_url: string | null
  pull_auth_token: string | null
  pull_param_name: string | null
}
type PullCfg = { client_usage_url: string; client_read_api_key?: string }

function buildOverageDescription(
  unitType: string,
  quantity: number,
  tiers: { from_unit?: number | null; to_unit?: number | null; rate_per_unit?: number }[],
  includedUnits: number,
): string {
  const billable = Math.max(0, quantity - includedUnits)
  const rate     = tiers[0]?.rate_per_unit ?? 0
  return `${unitType} overage — ${billable.toLocaleString()} excess units @ €${rate}/unit (${quantity.toLocaleString()} total, ${includedUnits.toLocaleString()} included)`
}

export async function GET(req: NextRequest) {
  const secret = req.headers.get('x-cron-secret')
  if (secret !== process.env.CRON_SECRET) {
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
      const description     = row.fee_label
        ?? `Base subscription — Year ${row.year_num ?? 1} (${fmtPeriod(periodStart)} – ${fmtPeriod(periodEnd)})`

      let sentInvoiceId:  string | null = null
      let sentInvoiceUrl: string | null = null

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

        // Add line item row (amount in minor units, e.g. öre for SEK)
        await fetch(`${REMEMBILL_BASE}/invoices/${invoiceId}/rows`, {
          method: 'POST', headers: rbH,
          body: JSON.stringify({ description, quantity: 1, unit_price: Math.round(Number(row.base_amount) * 100) }),
        })

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

        const periodStartUnix = Math.floor(periodStart.getTime() / 1000)
        const periodEndUnix   = Math.floor(periodEnd.getTime()   / 1000)

        // ── Fetch org-level pull config (legacy fallback) ───────────────────
        let pullConfig: PullCfg | null = null
        const { data: orgData } = await supabaseServer
          .from('organizations')
          .select('pull_config')
          .eq('id', job.org_id)
          .maybeSingle()
        const pc = (orgData?.pull_config ?? {}) as Partial<PullCfg>
        if (pc.client_usage_url) pullConfig = pc as PullCfg

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

        // ── Overage line items ──────────────────────────────────────────────
        if (row.invoice_type === 'period') {
          const { data: meterConfigs } = await supabaseServer
            .from('org_billing_config')
            .select('meter_key, included_units, overage_tiers')
            .eq('org_id', job.org_id)
            .eq('active', true)

          if (meterConfigs && meterConfigs.length > 0) {
            for (const cfg of meterConfigs as MeterCfg[]) {
              const { data: meterDef } = await supabaseServer
                .from('billing_meters')
                .select('pull_endpoint_url, pull_auth_token, pull_param_name')
                .or(`org_id.is.null,org_id.eq.${job.org_id}`)
                .eq('meter_key', cfg.meter_key)
                .maybeSingle()

              const def = meterDef as MeterDef | null
              if (!def?.pull_endpoint_url) {
                console.warn(`[invoice-scheduler] no pull endpoint for meter '${cfg.meter_key}' org ${job.org_id}`)
                continue
              }

              const pullUrl = new URL(def.pull_endpoint_url)
              pullUrl.searchParams.set('customer_id',  customerId)
              pullUrl.searchParams.set('period_start', String(periodStartUnix))
              pullUrl.searchParams.set('period_end',   String(periodEndUnix))
              pullUrl.searchParams.set(def.pull_param_name ?? 'billing_parameter', cfg.meter_key)

              const pullHeaders: Record<string, string> = {}
              if (def.pull_auth_token) pullHeaders['Authorization'] = `Bearer ${def.pull_auth_token}`

              const pullRes = await fetch(pullUrl.toString(), { headers: pullHeaders })
              if (!pullRes.ok) {
                console.error(`[invoice-scheduler] pull failed for meter '${cfg.meter_key}' (${pullRes.status})`)
                continue
              }

              const usageData  = await pullRes.json() as { total_billable_units?: number | string }
              const totalUnits = Number(usageData.total_billable_units ?? 0)
              if (totalUnits <= 0) continue

              const tiers = (cfg.overage_tiers ?? []).map((t, i) => ({
                tier_label:    `Tier ${i + 1}`,
                from_unit:     t.from_unit ?? null,
                to_unit:       t.to_unit   ?? null,
                rate_per_unit: t.rate_per_unit ?? 0,
                unit_type:     cfg.meter_key,
              }))
              const includedUnits = cfg.included_units ?? 0
              const overageEur    = tiers.length > 0 ? computeMetricOverage(totalUnits, tiers, includedUnits) : 0
              if (overageEur <= 0) continue

              const overageDesc = buildOverageDescription(cfg.meter_key, totalUnits, tiers, includedUnits)
              await stripe.invoiceItems.create({
                customer:    customerId,
                invoice:     inv.id,
                amount:      Math.round(overageEur * 100),
                currency:    cur,
                description: overageDesc,
                metadata: { metric_source: 'meter_pull', meter_key: cfg.meter_key, total_units: String(totalUnits), verdix_job: row.job_id },
              })
            }
          } else if (pullConfig) {
            const pullUrl = new URL(pullConfig.client_usage_url)
            pullUrl.searchParams.set('customer_id',  customerId)
            pullUrl.searchParams.set('period_start', String(periodStartUnix))
            pullUrl.searchParams.set('period_end',   String(periodEndUnix))

            const pullHeaders: Record<string, string> = {}
            if (pullConfig.client_read_api_key) pullHeaders['Authorization'] = `Bearer ${pullConfig.client_read_api_key}`

            const pullRes = await fetch(pullUrl.toString(), { headers: pullHeaders })
            if (pullRes.ok) {
              const usageData      = await pullRes.json() as { total_billable_units?: number | string }
              const aggregateUnits = Number(usageData.total_billable_units ?? 0)
              const includedUnits  = terms.included_units ?? 0

              if (aggregateUnits > 0) {
                const overageAmount = Math.round(computeMetricOverage(aggregateUnits, terms.overage_tiers ?? [], includedUnits) * 100) / 100
                if (overageAmount > 0) {
                  const overageDesc = buildOverageDescription('Usage', aggregateUnits, terms.overage_tiers ?? [], includedUnits)
                  await stripe.invoiceItems.create({
                    customer:    customerId,
                    invoice:     inv.id,
                    amount:      Math.round(overageAmount * 100),
                    currency:    cur,
                    description: overageDesc,
                    metadata: { metric_source: 'client_pull', total_units: String(aggregateUnits), verdix_job: row.job_id },
                  })
                }
              }
            } else {
              console.error(`[invoice-scheduler] legacy pull failed (${pullRes.status}) for job ${row.job_id}`)
            }
          }
        }

        const finalized = await stripe.invoices.finalizeInvoice(inv.id)
        sentInvoiceId  = inv.id
        sentInvoiceUrl = finalized.hosted_invoice_url ?? null
      }

      // ── Mark planned_invoice as sent ──────────────────────────────────────
      await supabaseServer
        .from('planned_invoices')
        .update({
          status:             'sent',
          stripe_invoice_id:  sentInvoiceId,
          stripe_invoice_url: sentInvoiceUrl,
          sent_at:            new Date().toISOString(),
          error_message:      null,
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
