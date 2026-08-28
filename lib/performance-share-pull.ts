// Step 17C.1 (hardened in 17C.1a) — the DB-querying wiring layer,
// mirroring lib/usage-pull.ts's computeOverageForPeriod shape (same params
// style, same OverageLineItem output, same "skip and log, never throw
// over one held/invalid item" discipline) rather than modifying that
// already large, delicate function's internals. Reuses the SAME
// downstream array/push path a caller (app/api/admin/invoice-scheduler/
// route.ts) already has for overage line items — this is not a separate
// "performance billing engine," just another producer of the same
// OverageLineItem shape.
import { supabaseServer } from '@/lib/supabase'
import { computePerformanceShareFee } from '@/lib/performance-share-fee'
import { buildOperationalInputMap, findMonetaryCurrencyProblem, type OperationalInputPeriodValueRow } from '@/lib/operational-input-binding'
import { isMonetaryOperationalInput } from '@/lib/operational-data-inputs'
import { PERFORMANCE_SHARE_FEE_COMPONENT } from '@/lib/performance-share-materiality'
import type { ContractTerms, VariableInvoiceTimingRule } from '@/lib/types'
import type { OverageLineItem } from '@/lib/usage-pull'

// Step 17F.3, item 6 (renamed from isArrearsSettlementTimingConfirmed —
// Step 17F.1, item 6) — extracted as its own pure, exported predicate (the
// same "small typed gate, unit-tested in isolation" pattern this codebase
// uses throughout — isProvenanceResolved, isMeterMappingResolved, etc.)
// rather than left inline. Renamed to describe what it actually gates now:
// WHEN the already-determined charge is invoiced, never WHETHER it's
// determined in arrears (that's structural — see computePerformanceShareFee's
// own 'not_ready' handling below, unconditional, no rule involved).
// 'invoice_at_next_period_start' AND requires_confirmation false are BOTH
// required — a fee whose rule was reset to 'unclear' pending re-review must
// never execute merely because requires_confirmation briefly reads false
// from stale data, and a confirmed-but-still-'unclear' timing (should never
// happen, but not structurally impossible) must never be treated as
// authorization either. 'invoice_at_period_end' is a resolvable VALUE (a
// contract can state this arrangement) but has no distinct execution path
// yet, so it is deliberately NOT authorized here either — held exactly
// like an unresolved rule, never silently executed on the
// next-period-start cycle as if it were the same arrangement.
export function isVariableInvoiceTimingConfirmed(rule: VariableInvoiceTimingRule | null | undefined): boolean {
  return !!rule && !rule.requires_confirmation && rule.timing === 'invoice_at_next_period_start'
}

export async function computePerformanceShareLineItemsForPeriod(params: {
  jobId: string
  terms: ContractTerms
  currency: string
  // The closed month (or other measured window) this charge is FOR —
  // matches computeOverageForPeriod's own backward-looking arrears
  // convention (invoice-scheduler passes the previous period here, never
  // the invoice's own period_start).
  periodStart: string
  periodEnd: string
  // The instant this calculation is evaluated as of — a real billing run
  // passes "now" (the default); a historical replay (an admin re-deriving
  // what a past invoice run would have seen) passes that run's own
  // billingAsOf explicitly. Threaded straight into
  // lib/operational-input-binding.ts's resolveInputValueAsOf so a later
  // correction to a finalized value never retroactively changes what an
  // earlier asOf replay computes.
  asOf?: string
  // Preview-only, mirrors computeOverageForPeriod's own flag — real
  // billing must never invoice a €0 (fully waived) obligation.
  includeZeroAmount?: boolean
}): Promise<OverageLineItem[]> {
  const { jobId, terms, currency, periodStart, periodEnd, includeZeroAmount } = params
  const asOf = params.asOf ?? new Date().toISOString()

  const feesWithConfig = (terms.additional_recurring_fees ?? []).filter(f => f.percentage_of_basis)
  if (feesWithConfig.length === 0) return []

  const { data: rows, error } = await supabaseServer
    .from('operational_input_period_values')
    .select('id, input_key, period_start, period_end, value, currency, recorded_at, finalized_at, status, revoked_at')
    .eq('job_id', jobId)
    .eq('period_start', periodStart)
    .eq('period_end', periodEnd)
  if (error) {
    console.error(`[performance-share-pull] failed to load operational input values for job ${jobId}, period ${periodStart}–${periodEnd}:`, error.message)
    return []
  }

  const valueRows = (rows ?? []) as OperationalInputPeriodValueRow[]
  const inputMap = buildOperationalInputMap(valueRows, periodStart, periodEnd, asOf)
  const items: OverageLineItem[] = []

  for (const fee of feesWithConfig) {
    const config = fee.percentage_of_basis!

    // Step 17F.3, item 6 — WHEN this already-determined charge is invoiced
    // is a separate typed decision from whether its AMOUNT can be computed
    // (config being present at all) and from whether it's determined in
    // arrears (structural — the 'not_ready' check below runs unconditionally,
    // with no rule gating it). Never silently assume the generic
    // next-period-start invoice cycle applies — lib/commercial-mechanism-
    // compiler.ts attaches this as unresolved by default; only a reviewer
    // confirming it (requires_confirmation: false) authorizes real
    // execution on this cycle. Held exactly like any other unresolved
    // rule — never invoiced, never throws, visible to the workspace as a
    // pending decision via the SAME missingDependencies path.
    if (!isVariableInvoiceTimingConfirmed(fee.variable_invoice_timing)) {
      console.warn(`[performance-share-pull] '${fee.fee_label}' held for job ${jobId}: variable invoice timing not yet confirmed`)
      continue
    }

    // Step 17C.1a/b, item 4/B — fail closed BEFORE ever attempting the
    // calculation: a monetary input's own recorded currency must be
    // PRESENT (never silently assumed to match) and must MATCH the
    // obligation's configured currency. A countable input (none of this
    // fee's own required keys are, today, but the filter is generic) is
    // never subject to this check — currency: null is its normal shape.
    const requiredKeys = [config.derived_metric.numerator_input_key, config.derived_metric.denominator_input_key, config.basis_input_key]
    const monetaryKeys = requiredKeys.filter(isMonetaryOperationalInput)
    const currencyProblem = findMonetaryCurrencyProblem(valueRows, monetaryKeys, periodStart, periodEnd, asOf, currency)
    if (currencyProblem) {
      const detail = currencyProblem.problem === 'missing'
        ? `input '${currencyProblem.input_key}' has a recorded value with no currency set`
        : `input '${currencyProblem.input_key}' was recorded in ${currencyProblem.rowCurrency}, expected ${currency}`
      console.error(`[performance-share-pull] '${fee.fee_label}' currency problem for job ${jobId}, period ${periodStart}–${periodEnd}: ${detail}`)
      continue
    }

    const result = computePerformanceShareFee({
      config, inputs: inputMap, discounts: terms.discounts, periodStart, periodEnd,
      contractStartDate: terms.contract_start_date, contractEndDate: terms.contract_end_date,
    })

    if (result.status === 'not_ready') {
      console.warn(`[performance-share-pull] '${fee.fee_label}' held for job ${jobId}, period ${periodStart}–${periodEnd}: ${result.reason}`)
      continue
    }
    if (result.status === 'invalid') {
      console.error(`[performance-share-pull] '${fee.fee_label}' invalid for job ${jobId}, period ${periodStart}–${periodEnd}: ${result.reason}`)
      continue
    }
    if (result.amount <= 0 && !includeZeroAmount) continue

    const rateSchedulePct = result.trace.rate_schedule.rate_pct
    const selectorPct = result.trace.derived_metric.value
    const waivedSuffix = result.status === 'waived' ? ' — waived (pilot)' : ''
    items.push({
      meter_key: 'performance_share_fee',
      // Step 17C.1a, item 5 — a STABLE canonical component identity, not
      // the verbose human fee_label: this is what invoice-scheduler's own
      // pool construction (classifyContractUnitType) resolves into
      // CommercialComponentClass 'performance_fee' — the sole thing a
      // credit's eligible_component_keys is ever matched against. Without
      // this exact, registered value, the fee resolves to an unclassified
      // (null) component: unreachable by any credit with a SPECIFIC
      // eligible list (safe), but also never intentionally targetable by
      // one either. See lib/commercial-component-scope.ts and
      // lib/performance-share-credit-isolation.test.ts.
      contractUnitType: PERFORMANCE_SHARE_FEE_COMPONENT,
      total_units: 0,
      included_units: 0,
      billable_units: 0,
      rate_per_unit: rateSchedulePct,
      amount: result.amount,
      currency: currency.toUpperCase(),
      description: `${fee.fee_label}: ${selectorPct.toFixed(3)}% payment rate → ${rateSchedulePct.toFixed(2)}% rate → ${currency.toUpperCase()} ${result.trace.amount.toFixed(2)} (basis: ${currency.toUpperCase()} ${result.trace.basis.value.toFixed(2)})${waivedSuffix}`,
      metric_source: 'manual_entry',
      windowStart: periodStart,
      windowEnd: periodEnd,
    })
  }

  return items
}
