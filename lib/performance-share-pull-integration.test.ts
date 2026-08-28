import { describe, it, expect, afterAll } from 'vitest'
import { supabaseServer } from './supabase'
import { computePerformanceShareLineItemsForPeriod } from './performance-share-pull'
import type { ContractTerms } from './types'

// ═══════════════════════════════════════════════════════════════════════════
// Step 17F.4, item 5 — real-Postgres proof that variable_invoice_timing's
// fail-closed gate holds at the ACTUAL invoice-scheduler-facing function,
// not merely at the isolated isVariableInvoiceTimingConfirmed predicate
// (already unit-tested in lib/performance-share-pull.test.ts). A fee whose
// AMOUNT is fully computable (valid, final operational inputs on record)
// must still never produce a line item when its invoice timing is
// 'invoice_at_period_end' (a resolvable value with no execution path yet)
// or 'unclear' (genuinely unresolved) — only 'invoice_at_next_period_start'
// with requires_confirmation:false may execute.
// Run deliberately:
//   RUN_RLS_INTEGRATION_TESTS=true node --env-file=.env.local node_modules/.bin/vitest run lib/performance-share-pull-integration.test.ts
// ═══════════════════════════════════════════════════════════════════════════

const RUN = process.env.RUN_RLS_INTEGRATION_TESTS === 'true'
const describeIf = RUN ? describe : describe.skip

const cleanupOrgIds: string[] = []
const cleanupJobIds: string[] = []

async function createTestOrg(name: string): Promise<string> {
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const { data, error } = await supabaseServer.from('organizations').insert({ name, slug }).select('id').single()
  if (error || !data) throw new Error(`createTestOrg failed: ${error?.message}`)
  cleanupOrgIds.push(data.id as string)
  return data.id as string
}

async function createTestJob(orgId: string): Promise<string> {
  const { data, error } = await supabaseServer
    .from('jobs')
    .insert({ name: '17F.4 performance-share-pull integration test job', module: 'AUTO_CONFIGURE', currency: 'SEK', org_id: orgId })
    .select('id').single()
  if (error || !data) throw new Error(`createTestJob failed: ${error?.message}`)
  cleanupJobIds.push(data.id as string)
  return data.id as string
}

afterAll(async () => {
  if (!RUN) return
  for (const jobId of cleanupJobIds) {
    await supabaseServer.from('operational_input_period_values').delete().eq('job_id', jobId)
    await supabaseServer.from('contract_terms').delete().eq('job_id', jobId)
    await supabaseServer.from('jobs').delete().eq('id', jobId)
  }
  for (const orgId of cleanupOrgIds) {
    await supabaseServer.from('organizations').delete().eq('id', orgId)
  }
}, 60_000)

function percentageOfBasisConfig() {
  return {
    derived_metric: {
      metric_key: 'value_weighted_payment_rate', operation: 'ratio' as const,
      numerator_input_key: 'paid_invoice_value', denominator_input_key: 'total_invoice_value_of_issued_requests',
      output_unit: 'percentage' as const, min_output_value: 0, max_output_value: 100,
    },
    rate_schedule: { schedule_key: 'x', bands: [{ from: 0, to: null, rate_pct: 3.55 }], min_selector_value: 0, max_selector_value: 100 },
    basis_input_key: 'total_invoice_value_of_issued_requests',
  }
}

async function insertFinalOperationalInputs(jobId: string, orgId: string, periodStart: string, periodEnd: string) {
  for (const [key, value] of [['paid_invoice_value', 80000], ['total_invoice_value_of_issued_requests', 100000]] as const) {
    const { error } = await supabaseServer.rpc('replace_operational_input_period_value', {
      p_job_id: jobId, p_org_id: orgId, p_input_key: key, p_period_start: periodStart, p_period_end: periodEnd,
      p_value: value, p_currency: 'SEK', p_recorded_by: 'integration-test@verdix.internal', p_is_final: true,
    })
    if (error) throw new Error(`op-input RPC failed for ${key}: ${error.message}`)
  }
}

describeIf('computePerformanceShareLineItemsForPeriod — variable_invoice_timing fail-closed (Step 17F.4, item 5)', () => {
  const periodStart = '2027-02-01', periodEnd = '2027-02-28'

  it('invoice_at_next_period_start, confirmed -> executes and produces the real line item', async () => {
    const orgId = await createTestOrg('17F.4 confirmed-timing org')
    const jobId = await createTestJob(orgId)
    await insertFinalOperationalInputs(jobId, orgId, periodStart, periodEnd)

    const terms = {
      currency: 'SEK',
      additional_recurring_fees: [{
        fee_label: 'Performance share', amount: 0, description: null,
        percentage_of_basis: percentageOfBasisConfig(),
        variable_invoice_timing: { timing: 'invoice_at_next_period_start', requires_confirmation: false },
      }],
    } as unknown as ContractTerms

    const items = await computePerformanceShareLineItemsForPeriod({ jobId, terms, currency: 'SEK', periodStart, periodEnd })
    expect(items).toHaveLength(1)
    expect(items[0].amount).toBeCloseTo(3550, 2)
  })

  // Step 17F.4, item 5's critical safety rule — invoice_at_period_end has
  // no verified execution path: even with a fully computable amount (valid
  // final inputs on record), it must never produce a line item, and must
  // never silently fall back to the next-period-start cycle.
  it('invoice_at_period_end, even "confirmed" (requires_confirmation:false) -> held, produces NO line item — no execution path exists for it', async () => {
    const orgId = await createTestOrg('17F.4 period-end-timing org')
    const jobId = await createTestJob(orgId)
    await insertFinalOperationalInputs(jobId, orgId, periodStart, periodEnd)

    const terms = {
      currency: 'SEK',
      additional_recurring_fees: [{
        fee_label: 'Performance share', amount: 0, description: null,
        percentage_of_basis: percentageOfBasisConfig(),
        variable_invoice_timing: { timing: 'invoice_at_period_end', requires_confirmation: false },
      }],
    } as unknown as ContractTerms

    const items = await computePerformanceShareLineItemsForPeriod({ jobId, terms, currency: 'SEK', periodStart, periodEnd })
    expect(items).toHaveLength(0)
  })

  it('unclear, requires_confirmation:true -> held, produces NO line item', async () => {
    const orgId = await createTestOrg('17F.4 unclear-timing org')
    const jobId = await createTestJob(orgId)
    await insertFinalOperationalInputs(jobId, orgId, periodStart, periodEnd)

    const terms = {
      currency: 'SEK',
      additional_recurring_fees: [{
        fee_label: 'Performance share', amount: 0, description: null,
        percentage_of_basis: percentageOfBasisConfig(),
        variable_invoice_timing: { timing: 'unclear', requires_confirmation: true },
      }],
    } as unknown as ContractTerms

    const items = await computePerformanceShareLineItemsForPeriod({ jobId, terms, currency: 'SEK', periodStart, periodEnd })
    expect(items).toHaveLength(0)
  })

  it('no variable_invoice_timing attached at all -> held, produces NO line item (never silently defaults to executable)', async () => {
    const orgId = await createTestOrg('17F.4 no-timing-rule org')
    const jobId = await createTestJob(orgId)
    await insertFinalOperationalInputs(jobId, orgId, periodStart, periodEnd)

    const terms = {
      currency: 'SEK',
      additional_recurring_fees: [{
        fee_label: 'Performance share', amount: 0, description: null,
        percentage_of_basis: percentageOfBasisConfig(),
      }],
    } as unknown as ContractTerms

    const items = await computePerformanceShareLineItemsForPeriod({ jobId, terms, currency: 'SEK', periodStart, periodEnd })
    expect(items).toHaveLength(0)
  })
})
