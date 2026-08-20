import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { supabaseServer } from './supabase'
import { requestInvoiceCorrection } from './invoice-correction'

// ═══════════════════════════════════════════════════════════════════════════
// Integration test against the REAL Remembill sandbox (same org/credentials
// already configured in org_integrations) and a real, already-SENT sandbox
// invoice created during schema verification. Confirms the parts of this
// module that don't require a successful Remembill /credit response to
// verify: fail-closed on credit failure (original untouched, no
// replacement created), and idempotent record-creation (a retry reuses the
// same invoice_corrections row rather than creating a second one).
//
// Remembill's sandbox currently returns a reproducible 500 past request
// validation on POST /invoices/{id}/credit (confirmed via two independent
// live attempts against a schema that matches their published OpenAPI spec
// exactly) — this test exploits that as a real, naturally-occurring failure
// case rather than needing to fake one. The full success path (credit
// succeeds -> replacement created) cannot be verified end-to-end until that
// sandbox issue is resolved; re-run this file once it is.
//
// SKIPPED BY DEFAULT:
//   RUN_RLS_INTEGRATION_TESTS=true npx vitest run lib/invoice-correction.test.ts
// ═══════════════════════════════════════════════════════════════════════════

const RUN = process.env.RUN_RLS_INTEGRATION_TESTS === 'true'
const describeIf = RUN ? describe : describe.skip

// Real org already configured with a working Remembill API key.
const REAL_ORG_ID = 'b911acab-03b1-48fd-8195-e2b2731ed69a'
// A real, confirmed-SENT sandbox invoice created during schema
// verification (customer cus_ofze819ppfn5plv5jlbsqylu, 5,000.00 SEK net).
const REAL_SENT_INVOICE_ID = 'inv_muz00wkrdnhyvql5xk5fw6gy'
const REAL_CUSTOMER_ID = 'cus_ofze819ppfn5plv5jlbsqylu'

describeIf('requestInvoiceCorrection — real Remembill sandbox', () => {
  let jobId: string
  let plannedInvoiceId: string

  beforeAll(async () => {
    const { data: job, error: jobError } = await supabaseServer.from('jobs').insert({
      org_id: REAL_ORG_ID, name: 'invoice-correction-test-job', module: 'AUTO_CONFIGURE', status: 'PENDING',
      billing_platform: 'remembill', billing_customer_id: REAL_CUSTOMER_ID,
    }).select('id').single()
    if (jobError) throw new Error(`jobs insert failed: ${jobError.message}`)
    jobId = job!.id

    const { data: terms, error: termsError } = await supabaseServer.from('contract_terms').insert({
      job_id: jobId, currency: 'SEK', contract_start_date: '2026-08-01', contract_end_date: '2027-07-31',
    }).select('id').single()
    if (termsError) throw new Error(`contract_terms insert failed: ${termsError.message}`)
    await supabaseServer.from('jobs').update({ contract_terms_id: terms!.id }).eq('id', jobId)

    const { data: inv, error: invError } = await supabaseServer.from('planned_invoices').insert({
      job_id: jobId, org_id: REAL_ORG_ID, year_num: 1, period_start: '2026-08-01', period_end: '2026-08-31',
      base_amount: 5000, currency: 'SEK', invoice_type: 'period', status: 'sent',
      stripe_invoice_id: REAL_SENT_INVOICE_ID, sent_at: new Date().toISOString(),
      net_amount: 5000, vat_amount: 1250, gross_amount: 6250, vat_mode: 'rate', vat_rate_pct: 25,
    }).select('id').single()
    if (invError) throw new Error(`planned_invoices insert failed: ${invError.message}`)
    plannedInvoiceId = inv!.id
  })

  afterAll(async () => {
    await supabaseServer.from('invoice_corrections').delete().eq('job_id', jobId)
    await supabaseServer.from('planned_invoices').delete().eq('job_id', jobId)
    await supabaseServer.from('contract_terms').delete().eq('job_id', jobId)
    await supabaseServer.from('jobs').delete().eq('id', jobId)
  })

  it('credit failure leaves the original invoice untouched and creates no replacement', async () => {
    const result = await requestInvoiceCorrection({
      jobId, orgId: REAL_ORG_ID, plannedInvoiceId, action: 'correction',
      reason: 'integration test', requestedBy: 'test@verdix.test',
    })
    // Expected to fail while Remembill's sandbox 500s past validation.
    expect(result.ok).toBe(false)

    const { data: corrections } = await supabaseServer.from('invoice_corrections').select('*').eq('original_planned_invoice_id', plannedInvoiceId)
    expect(corrections).toHaveLength(1)
    expect(corrections![0].credit_status).toBe('failed')
    expect(corrections![0].replacement_status).toBe('pending') // never advanced past credit failure
    expect(corrections![0].replacement_planned_invoice_id).toBeNull()

    // Original invoice's own financial fields are provably untouched.
    const { data: original } = await supabaseServer.from('planned_invoices').select('*').eq('id', plannedInvoiceId).single()
    expect(original!.corrected_at).toBeNull()
    expect(Number(original!.net_amount)).toBe(5000)

    // No second, replacement planned_invoices row was created for this job.
    const { data: allInvoices } = await supabaseServer.from('planned_invoices').select('id').eq('job_id', jobId)
    expect(allInvoices).toHaveLength(1)
  })

  it('a retry after failure reuses the same invoice_corrections row rather than creating a second one', async () => {
    const first = await supabaseServer.from('invoice_corrections').select('id').eq('original_planned_invoice_id', plannedInvoiceId)
    const firstId = first.data![0].id

    const retryResult = await requestInvoiceCorrection({
      jobId, orgId: REAL_ORG_ID, plannedInvoiceId, action: 'correction',
      reason: 'integration test retry', requestedBy: 'test@verdix.test',
    })
    expect(retryResult.ok).toBe(false)

    const { data: corrections } = await supabaseServer.from('invoice_corrections').select('id').eq('original_planned_invoice_id', plannedInvoiceId)
    expect(corrections).toHaveLength(1) // still exactly one row
    expect(corrections![0].id).toBe(firstId) // the SAME row, reused
  })
})
