// Issued-invoice cancellation/correction via Remembill's POST
// /invoices/{id}/credit — deliberately separate from lib/credit-ledger*.ts
// (the contractual credit/rebate ledger, which tracks commercial credits
// BEFORE an invoice is issued). This module reverses an ALREADY-ISSUED
// invoice. Once issued, the original Remembill invoice is treated as
// immutable — nothing here ever mutates it; only Verdix's own bookkeeping
// (planned_invoices.corrected_at, invoice_corrections) is written.
//
// Request schema for POST /invoices/{id}/credit confirmed from Remembill's
// published OpenAPI spec (docs.remembill.com/api/docs/openapi.yaml, tag
// "Invoices", operationId creditInvoice) and verified against their sandbox
// to the point of passing request validation: { mode: 'remaining' | 'partial',
// date, method: 'email'|'sms'|'letter' }, Idempotency-Key header required.
// A full cancellation/correction always uses mode: 'remaining' (credits
// every value not yet consumed by an earlier credit). The sandbox itself
// returned a reproducible 500 past validation during verification — flagged
// to the user as a probable sandbox-side issue, not a schema problem.
import { supabaseServer } from './supabase'
import { REMEMBILL_BASE, remembillHeaders, getOrgConfig, createAdHocInvoice } from './billing-writer'
import { computeOverageForPeriod } from './usage-pull'
import { resolveVatTreatment, computeVat } from './vat'
import { getCustomerVatConfig, getInvoiceVatOverride } from './vat-service'
import { unwrapEmbedded } from './postgrest-helpers'
import type { ContractTerms } from './types'

export type CorrectionAction = 'cancellation' | 'correction'

interface RequestParams {
  jobId: string
  orgId: string
  plannedInvoiceId: string
  action: CorrectionAction
  reason: string | null
  requestedBy: string | null
}

export type RequestResult =
  | { ok: true; correctionId: string; creditStatus: string; replacementStatus: string }
  | { ok: false; reason: string }

const fmtDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export async function requestInvoiceCorrection(params: RequestParams): Promise<RequestResult> {
  const { jobId, orgId, plannedInvoiceId, action, reason, requestedBy } = params

  // Idempotent: a prior fully-succeeded attempt for this exact
  // (invoice, action) is returned as-is — never re-credited, never a
  // second replacement created.
  const { data: existing } = await supabaseServer
    .from('invoice_corrections')
    .select('*')
    .eq('original_planned_invoice_id', plannedInvoiceId)
    .eq('action', action)
    .maybeSingle()

  if (existing && existing.credit_status === 'succeeded' && (action === 'cancellation' || existing.replacement_status === 'succeeded')) {
    return { ok: true, correctionId: existing.id, creditStatus: existing.credit_status, replacementStatus: existing.replacement_status }
  }

  const { data: invoice } = await supabaseServer
    .from('planned_invoices')
    .select('*')
    .eq('id', plannedInvoiceId)
    .eq('job_id', jobId)
    .eq('org_id', orgId)
    .single()

  if (!invoice) return { ok: false, reason: 'Invoice not found' }
  if (!['sent', 'paid'].includes(invoice.status)) {
    return { ok: false, reason: `Only sent/paid invoices can be ${action === 'cancellation' ? 'cancelled' : 'corrected'} — this invoice is '${invoice.status}'.` }
  }
  if (!invoice.stripe_invoice_id) return { ok: false, reason: 'No platform invoice id recorded for this invoice.' }

  const { data: job } = await supabaseServer
    .from('jobs')
    .select('billing_platform, billing_customer_id, contract_terms ( * )')
    .eq('id', jobId)
    .single()
  if (!job) return { ok: false, reason: 'Job not found' }

  const billingPlatform = (job.billing_platform as string | null) ?? 'stripe'
  if (billingPlatform !== 'remembill') {
    return { ok: false, reason: `Invoice cancellation/correction is currently only supported for Remembill invoices (this job uses ${billingPlatform}).` }
  }

  let correctionId: string
  if (existing) {
    correctionId = existing.id
  } else {
    const idemKey = `verdix-correction-${plannedInvoiceId}-${action}`
    const { data: inserted, error } = await supabaseServer
      .from('invoice_corrections')
      .insert({
        org_id: orgId, job_id: jobId, original_planned_invoice_id: plannedInvoiceId, action, reason, requested_by: requestedBy,
        original_currency: invoice.currency, original_net_amount: invoice.net_amount, original_vat_amount: invoice.vat_amount,
        original_gross_amount: invoice.gross_amount, original_vat_mode: invoice.vat_mode, original_vat_rate_pct: invoice.vat_rate_pct,
        original_platform_invoice_id: invoice.stripe_invoice_id,
        credit_idempotency_key: idemKey,
        replacement_status: action === 'correction' ? 'pending' : 'not_applicable',
      })
      .select('id')
      .single()
    if (error || !inserted) return { ok: false, reason: `Could not record correction request: ${error?.message}` }
    correctionId = inserted.id
  }

  // ── Step 1: credit the ORIGINAL invoice's actual issued figures ─────────
  // mode: 'remaining' reverses everything not yet consumed by an earlier
  // credit — the correct full-reversal mode regardless of whether this is
  // a cancellation or the first step of a correction. Never recomputed
  // from today's terms; Remembill itself derives the credited amount from
  // the original invoice it already has on file.
  const { data: row } = await supabaseServer.from('invoice_corrections').select('*').eq('id', correctionId).single()
  let creditStatus: string = row!.credit_status
  if (creditStatus !== 'succeeded') {
    const orgConfig = await getOrgConfig(orgId, 'remembill')
    const apiKey = orgConfig?.api_key ?? process.env.REMEMBILL_API_KEY
    if (!apiKey) return { ok: false, reason: 'Remembill API key not configured' }
    const h = remembillHeaders(apiKey)

    await supabaseServer.from('invoice_corrections').update({ credit_requested_at: new Date().toISOString() }).eq('id', correctionId)

    try {
      const creditRes = await fetch(`${REMEMBILL_BASE}/invoices/${invoice.stripe_invoice_id}/credit`, {
        method: 'POST',
        headers: { ...h, 'Idempotency-Key': row!.credit_idempotency_key },
        body: JSON.stringify({ mode: 'remaining', date: fmtDate(new Date()), method: 'email' }),
      })
      const rawBody = await creditRes.text()
      if (!creditRes.ok) {
        const message = `Remembill credit failed (${creditRes.status}): ${rawBody}`
        await supabaseServer.from('invoice_corrections').update({ credit_status: 'failed', credit_error_message: message }).eq('id', correctionId)
        return { ok: false, reason: message }
      }
      const creditJson = JSON.parse(rawBody) as Record<string, unknown>
      const creditObj = (creditJson.invoice ?? creditJson.data ?? creditJson) as Record<string, unknown>
      const creditInvoiceId = creditObj.id as string | undefined
      await supabaseServer.from('invoice_corrections').update({
        credit_status: 'succeeded', credit_platform_invoice_id: creditInvoiceId ?? null,
        credit_completed_at: new Date().toISOString(), credit_error_message: null,
      }).eq('id', correctionId)
      // Additive marker only — the original invoice's own fields
      // (base_amount, net_amount, vat_amount, ...) are never altered.
      await supabaseServer.from('planned_invoices').update({ corrected_at: new Date().toISOString(), correction_id: correctionId }).eq('id', plannedInvoiceId)
      creditStatus = 'succeeded'
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await supabaseServer.from('invoice_corrections').update({ credit_status: 'failed', credit_error_message: message }).eq('id', correctionId)
      return { ok: false, reason: message }
    }
  }

  if (action === 'cancellation') {
    return { ok: true, correctionId, creditStatus, replacementStatus: 'not_applicable' }
  }

  // ── Step 2 (correction only): replacement, ONLY reached once the credit
  // above has actually succeeded — never created speculatively. ──────────
  const { data: freshRow } = await supabaseServer.from('invoice_corrections').select('*').eq('id', correctionId).single()
  if (freshRow!.replacement_status === 'succeeded') {
    return { ok: true, correctionId, creditStatus: 'succeeded', replacementStatus: 'succeeded' }
  }

  try {
    const terms = unwrapEmbedded((job as unknown as { contract_terms: ContractTerms | ContractTerms[] }).contract_terms)
    if (!terms) throw new Error('Contract terms not found')

    const customerId = job.billing_customer_id as string | undefined
    if (!customerId) throw new Error('No billing customer on this job')

    // "Current approved billing instruction" — recomputed fresh, unlike
    // the credit above. The base recurring fee is carried forward from the
    // original invoice unchanged (a correction doesn't re-litigate the
    // confirmed recurring fee itself); usage-based overage is recomputed
    // for the same period (meter mappings/usage data may have been
    // corrected since); VAT is resolved fresh (the explicit case a
    // correction exists for — VAT config or the contract may have changed).
    const overageLineItems = await computeOverageForPeriod({
      orgId, jobId, terms, customerId,
      periodStartUnix: Math.floor(new Date(invoice.period_start + 'T00:00:00').getTime() / 1000),
      periodEndUnix: Math.floor(new Date(invoice.period_end + 'T23:59:59').getTime() / 1000),
      currency: invoice.currency,
    })

    const netAmount = Number(invoice.base_amount) + overageLineItems.reduce((s, i) => s + i.amount, 0)
    const [customerVat, invoiceVatOverride] = await Promise.all([
      getCustomerVatConfig(orgId, customerId),
      getInvoiceVatOverride(plannedInvoiceId),
    ])
    const vatTreatment = resolveVatTreatment(customerVat, invoiceVatOverride)
    const vatResult = computeVat(netAmount, vatTreatment)
    if (!vatResult.ok) throw new Error(`Billing blocked: ${vatResult.reason}`)

    const lineItems = [
      { description: invoice.fee_label ?? `Replacement invoice for period ${invoice.period_start} – ${invoice.period_end}`, quantity: 1, unitPrice: Number(invoice.base_amount) },
      ...overageLineItems.map(i => ({ description: i.description, quantity: 1, unitPrice: i.amount })),
    ]

    const created = await createAdHocInvoice({
      orgId, billingPlatform: 'remembill', customerId, currency: invoice.currency, netDays: 30,
      lineItems, idempotencyKey: `verdix-replacement-${correctionId}`,
      metadata: { verdix_job: jobId, correction_id: correctionId, original_invoice: invoice.stripe_invoice_id as string },
      // Previously computed here but never actually passed through —
      // createAdHocInvoice always resolved VAT off the customer default
      // only, silently ignoring a per-invoice override on the REAL pushed
      // invoice while this file's own bookkeeping below claimed the
      // override had been applied. Passing it through is what makes
      // created.vat below the authoritative record of what was truly charged.
      vatOverride: invoiceVatOverride,
    })

    const { data: replacementRow } = await supabaseServer
      .from('planned_invoices')
      .insert({
        job_id: jobId, org_id: orgId, year_num: invoice.year_num, period_start: invoice.period_start, period_end: invoice.period_end,
        base_amount: invoice.base_amount, currency: invoice.currency, fee_label: invoice.fee_label, invoice_type: invoice.invoice_type,
        status: 'sent', stripe_invoice_id: created.invoiceId, stripe_invoice_url: created.hostedUrl, sent_at: new Date().toISOString(),
        overage_line_items: overageLineItems, overage_total: overageLineItems.reduce((s, i) => s + i.amount, 0),
        // Sourced from created.vat — the figures createAdHocInvoice actually
        // applied to the real Remembill push — not the vatTreatment/vatResult
        // computed above, which only ever existed for the early fail-closed
        // check and could otherwise drift from what was truly charged.
        vat_mode: created.vat.mode, vat_rate_pct: created.vat.mode === 'rate' ? created.vat.ratePct : null,
        vat_source: invoiceVatOverride ? 'override' : 'customer_default',
        net_amount: created.vat.netAmount, vat_amount: created.vat.vatAmount, gross_amount: created.vat.grossAmount,
      })
      .select('id')
      .single()

    await supabaseServer.from('invoice_corrections').update({
      replacement_status: 'succeeded', replacement_planned_invoice_id: replacementRow?.id ?? null,
      replacement_platform_invoice_id: created.invoiceId, replacement_error_message: null,
    }).eq('id', correctionId)

    return { ok: true, correctionId, creditStatus: 'succeeded', replacementStatus: 'succeeded' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await supabaseServer.from('invoice_corrections').update({ replacement_status: 'failed', replacement_error_message: message }).eq('id', correctionId)
    return { ok: false, reason: message }
  }
}
