/**
 * GET /api/jobs/[id]/manual-input-due-state
 *   Per-component operational-input due-state for Commercial Logic & Billing
 *   Setup — the SAME canonical derivation (lib/operational-action-due-
 *   state.ts's classifyOperationalActionState) Dashboard Billing Actions
 *   already uses (lib/dashboard-billing-actions.ts), scoped to one job
 *   instead of a whole org. Never a second, independently-derived answer.
 *   Covers BOTH real manual-input mechanisms this codebase's execution
 *   code actually gates on — performance (percentage_of_basis, via
 *   operational_input_period_values) and usage-manual-fallback (a flat
 *   rate_per_unit fee with an unconfirmed-meter semantic_input_key, via
 *   usage_period_values) — and surfaces, per component, the OLDEST closed
 *   period with an unresolved requirement (never merely "the most recent
 *   closed period," which can silently lose an older unresolved gap once
 *   a newer period also closes — see lib/dashboard-billing-actions.ts's
 *   own header for the full audit).
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { unwrapEmbedded } from '@/lib/postgrest-helpers'
import { isMonetaryOperationalInput } from '@/lib/operational-data-inputs'
import { classifyOperationalActionState, oldestUnresolvedPeriod, type ClosedPeriod } from '@/lib/operational-action-due-state'

type AdditionalRecurringFeeLike = {
  fee_label: string
  recurring_fee_id?: string | null
  rate_per_unit?: number | null
  semantic_input_key?: string | null
  percentage_of_basis?: {
    derived_metric: { numerator_input_key: string; denominator_input_key: string }
    basis_input_key: string
  } | null
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let org
  try { org = await requireOrg('member') } catch (res) { return res as Response }

  const { id: jobId } = await params

  const { data: job } = await supabaseServer
    .from('jobs')
    .select('id, contract_terms(additional_recurring_fees)')
    .eq('id', jobId)
    .eq('org_id', org.orgId)
    .maybeSingle()
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  const contractTerms = unwrapEmbedded(job.contract_terms as unknown as { additional_recurring_fees?: AdditionalRecurringFeeLike[] } | { additional_recurring_fees?: AdditionalRecurringFeeLike[] }[] | null)
  const fees = contractTerms?.additional_recurring_fees ?? []
  if (fees.length === 0) return NextResponse.json({ components: [] })

  const [{ data: periodRows }, { data: inputValueRows }, { data: usageValueRows }, { data: meterMappingRows }] = await Promise.all([
    supabaseServer
      .from('planned_invoices')
      .select('period_start, period_end')
      .eq('job_id', jobId)
      .eq('invoice_type', 'period')
      .lt('period_end', new Date().toISOString().slice(0, 10))
      .order('period_end', { ascending: true }),
    supabaseServer
      .from('operational_input_period_values')
      .select('input_key, period_start, period_end, finalized_at')
      .eq('job_id', jobId)
      .eq('status', 'active'),
    supabaseServer
      .from('usage_period_values')
      .select('semantic_input_key, period_start, period_end, finalized_at')
      .eq('job_id', jobId)
      .eq('status', 'active'),
    supabaseServer
      .from('contract_meter_mappings')
      .select('semantic_input_key, meter_key, confirmed')
      .eq('job_id', jobId),
  ])

  const periods: ClosedPeriod[] = (periodRows ?? []).map(r => ({ periodStart: r.period_start as string, periodEnd: r.period_end as string }))
  if (periods.length === 0) return NextResponse.json({ components: [] })

  function buildKeySets<T extends { period_start: unknown; period_end: unknown; finalized_at: unknown }>(rows: T[], keyField: (r: T) => string) {
    const finalized = new Map<string, Set<string>>()
    const draft = new Map<string, Set<string>>()
    for (const r of rows) {
      const pKey = `${r.period_start}:${r.period_end}`
      const target = r.finalized_at ? finalized : draft
      const set = target.get(pKey)
      if (set) set.add(keyField(r))
      else target.set(pKey, new Set([keyField(r)]))
    }
    return { finalized, draft }
  }
  const opInput = buildKeySets(inputValueRows ?? [], r => r.input_key as string)
  const usageInput = buildKeySets(usageValueRows ?? [], r => r.semantic_input_key as string)
  const confirmedMeterKeys = new Set(
    (meterMappingRows ?? []).filter(r => r.confirmed && r.meter_key).map(r => r.semantic_input_key as string),
  )

  const components: Array<{ componentLabel: string; recurringFeeId: string | null; sourcePeriodStart: string; sourcePeriodEnd: string; actionState: string }> = []

  for (const fee of fees) {
    if (fee.percentage_of_basis) {
      const config = fee.percentage_of_basis
      const requiredKeys = [config.derived_metric.numerator_input_key, config.derived_metric.denominator_input_key, config.basis_input_key]
        .filter(isMonetaryOperationalInput)
      if (requiredKeys.length === 0) continue
      const period = oldestUnresolvedPeriod(periods, p => {
        const finalizedKeys = opInput.finalized.get(`${p.periodStart}:${p.periodEnd}`) ?? new Set<string>()
        return requiredKeys.every(k => finalizedKeys.has(k))
      })
      if (!period) continue
      const pKey = `${period.periodStart}:${period.periodEnd}`
      const actionState = classifyOperationalActionState({
        periodStart: period.periodStart, periodEnd: period.periodEnd, requiredKeys,
        finalizedKeys: opInput.finalized.get(pKey) ?? new Set(), draftKeys: opInput.draft.get(pKey) ?? new Set(),
      })
      components.push({ componentLabel: fee.fee_label, recurringFeeId: fee.recurring_fee_id ?? null, sourcePeriodStart: period.periodStart, sourcePeriodEnd: period.periodEnd, actionState })
    } else if (typeof fee.rate_per_unit === 'number' && fee.rate_per_unit > 0 && fee.semantic_input_key) {
      if (confirmedMeterKeys.has(fee.semantic_input_key)) continue
      const requiredKeys = [fee.semantic_input_key]
      const period = oldestUnresolvedPeriod(periods, p => {
        const finalizedKeys = usageInput.finalized.get(`${p.periodStart}:${p.periodEnd}`) ?? new Set<string>()
        return requiredKeys.every(k => finalizedKeys.has(k))
      })
      if (!period) continue
      const pKey = `${period.periodStart}:${period.periodEnd}`
      const actionState = classifyOperationalActionState({
        periodStart: period.periodStart, periodEnd: period.periodEnd, requiredKeys,
        finalizedKeys: usageInput.finalized.get(pKey) ?? new Set(), draftKeys: usageInput.draft.get(pKey) ?? new Set(),
      })
      components.push({ componentLabel: fee.fee_label, recurringFeeId: fee.recurring_fee_id ?? null, sourcePeriodStart: period.periodStart, sourcePeriodEnd: period.periodEnd, actionState })
    }
  }

  return NextResponse.json({ components })
}
