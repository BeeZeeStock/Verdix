/**
 * GET /api/jobs/[id]/performance-share
 *
 * Step 17E, item 2 — the approved-contract GUI's persistent "Performance
 * share" display. Read-only: finds, for each additional_recurring_fees
 * entry with a compiled percentage_of_basis config, the MOST RECENT period
 * for which every required operational input (numerator/denominator/
 * basis) has an ACTIVE, FINALIZED value on record, and returns the
 * SAME structured trace lib/performance-share-fee.ts's computePerformanceShareFee
 * produces for real billing — never a separately-invented display
 * calculation. "Do not calculate from drafts" (item 2's explicit
 * constraint): a period with only a draft value for a required input is
 * skipped entirely, exactly like lib/performance-share-pull.ts's own
 * real-billing readiness gate.
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { computePerformanceShareFee } from '@/lib/performance-share-fee'
import { buildOperationalInputMap, type OperationalInputPeriodValueRow } from '@/lib/operational-input-binding'
import { hasContractStarted } from '@/lib/performance-share-timing'
import { unwrapEmbedded } from '@/lib/postgrest-helpers'
import type { ContractTerms, AdditionalRecurringFee } from '@/lib/types'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let org
  try { org = await requireOrg('member') } catch (res) { return res as Response }

  const { id: jobId } = await params

  const { data: job } = await supabaseServer
    .from('jobs')
    .select('id, org_id, currency, contract_terms ( * )')
    .eq('id', jobId)
    .eq('org_id', org.orgId)
    .maybeSingle()
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  const terms = unwrapEmbedded(job.contract_terms as unknown as ContractTerms | ContractTerms[])
  const currency = (job.currency as string | undefined) ?? terms?.currency ?? 'EUR'

  const feesWithConfig = ((terms?.additional_recurring_fees ?? []) as AdditionalRecurringFee[]).filter(f => f.percentage_of_basis)
  if (feesWithConfig.length === 0) return NextResponse.json({ fees: [] })

  // Step 17E.1, item B — no eligible billing period exists yet before the
  // contract has even started; asking "which operational inputs are
  // missing" is the wrong question at that point (there is no period to
  // enter them FOR). A contract-level fact, checked once, short-circuiting
  // every fee the same way — never a per-fee "not ready" reason that
  // reads as if data entry were merely incomplete.
  if (!hasContractStarted(terms?.contract_start_date)) {
    return NextResponse.json({
      fees: feesWithConfig.map(fee => ({
        feeLabel: fee.fee_label, status: 'not_started' as const,
        contractStartDate: terms?.contract_start_date,
      })),
    })
  }

  const { data: rows } = await supabaseServer
    .from('operational_input_period_values')
    .select('id, input_key, period_start, period_end, value, currency, recorded_at, finalized_at, status, revoked_at')
    .eq('job_id', jobId)
  const valueRows = (rows ?? []) as OperationalInputPeriodValueRow[]

  const results = feesWithConfig.map(fee => {
    const config = fee.percentage_of_basis!
    const requiredKeys = [config.derived_metric.numerator_input_key, config.derived_metric.denominator_input_key, config.basis_input_key]

    // Every distinct (period_start, period_end) pair this job has ANY
    // recorded value for, most recent first — the first one where every
    // required key resolves to an active+finalized value (via the SAME
    // buildOperationalInputMap real billing uses) is the period shown.
    const periods = Array.from(new Set(valueRows.map(r => `${r.period_start}|${r.period_end}`)))
      .map(k => { const [periodStart, periodEnd] = k.split('|'); return { periodStart, periodEnd } })
      .sort((a, b) => b.periodStart.localeCompare(a.periodStart))

    for (const { periodStart, periodEnd } of periods) {
      const asOf = new Date().toISOString()
      const inputMap = buildOperationalInputMap(valueRows, periodStart, periodEnd, asOf)
      if (!requiredKeys.every(k => inputMap[k] != null)) continue

      const result = computePerformanceShareFee({
        config, inputs: inputMap, discounts: terms?.discounts, periodStart, periodEnd,
        contractStartDate: terms?.contract_start_date, contractEndDate: terms?.contract_end_date,
      })
      if (result.status === 'not_ready' || result.status === 'invalid') {
        return { feeLabel: fee.fee_label, status: result.status, reason: result.reason, periodStart, periodEnd }
      }
      return {
        feeLabel: fee.fee_label,
        status: result.status, // 'ready' | 'waived'
        periodStart, periodEnd,
        currency: currency.toUpperCase(),
        numeratorKey: config.derived_metric.numerator_input_key,
        numeratorValue: result.trace.derived_metric.numerator_value,
        denominatorKey: config.derived_metric.denominator_input_key,
        denominatorValue: result.trace.derived_metric.denominator_value,
        derivedPct: result.trace.derived_metric.value,
        selectedRatePct: result.trace.rate_schedule.rate_pct,
        basisKey: result.trace.basis.input_key,
        basisValue: result.trace.basis.value,
        amount: result.amount,
      }
    }

    // Step 17E, item 5 — which specific required inputs have NEVER been
    // given an active+finalized value at all (any period) — surfaced so
    // the approved-contract GUI's period-readiness banner can name exactly
    // what it's waiting for (e.g. "paid_invoice_value"), not just a
    // generic "pending" state.
    const everFinalized = new Set(valueRows.filter(r => r.status === 'active' && r.finalized_at != null).map(r => r.input_key))
    const missingKeys = requiredKeys.filter(k => !everFinalized.has(k))
    return { feeLabel: fee.fee_label, status: 'not_ready' as const, reason: 'Pending operational inputs', periodStart: null, periodEnd: null, missingKeys }
  })

  return NextResponse.json({ fees: results })
}
