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
import type { ContractTerms } from '@/lib/types'
import type { OverageLineItem } from '@/lib/usage-pull'
import { QuantitySourceNotReadyError } from '@/lib/commercial-quantity-source'
import { classifyCurrencyProblem, classifyPerformanceShareResultStatus } from '@/lib/performance-share-readiness'
// Step 17H.4B0D4H1B4E5.2 — moved to lib/rule-interpretation.ts (the
// established client-safe, zero-supabaseServer home — see that file's own
// header) so lib/commercial-rule-status.ts and lib/commercial-components.ts
// (both imported directly by page.tsx) can reuse this SAME predicate for
// readiness/display without pulling this file's supabaseServer import into
// the browser bundle. Re-exported below, unchanged in behavior, so this
// file's own existing callers (further down, and app/api/jobs/[id]/
// performance-share/route.ts) need no import-path changes.
import { isVariableInvoiceTimingConfirmed } from '@/lib/rule-interpretation'
export { isVariableInvoiceTimingConfirmed } from '@/lib/rule-interpretation'

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
      // Step E9B — this file's own header documents "skip and log, never
      // throw" as a deliberate discipline, but that was calibrated for a
      // hypothetical preview caller this function never actually has (the
      // real preview route, app/api/jobs/[id]/performance-share/route.ts,
      // calls computePerformanceShareFee directly — confirmed by reading
      // it, not assumed) — every real caller of THIS function is
      // invoice-scheduler's own real-billing path. A currency mismatch on
      // an already-ENTERED value is a genuine data-integrity problem —
      // unlike a merely-not-yet-entered input, retrying it unattended
      // tomorrow will not fix it, so this deliberately throws a PLAIN
      // Error (not QuantitySourceNotReadyError): invoice-scheduler's
      // existing generic catch-all marks the row 'failed' with this
      // message, correctly surfacing it for a human to actually correct
      // the recorded value, rather than silently retrying it forever as
      // "held" or dropping the charge from the sent invoice either way.
      // Step E9B.1 §9 — the retryable/non-retryable decision itself is
      // made by lib/performance-share-readiness.ts's pure
      // classifyCurrencyProblem, directly unit-tested there. [currency_
      // mismatch] is the stable marker lib/invoice-hold-status.ts's
      // describeInvoiceFailure matches on for business-facing copy.
      const currencyOutcome = classifyCurrencyProblem(detail)
      throw new Error(`'${fee.fee_label}' currency problem for job ${jobId}, period ${periodStart}–${periodEnd}: ${currencyOutcome.reason}`)
    }

    const result = computePerformanceShareFee({
      config, inputs: inputMap, discounts: terms.discounts, periodStart, periodEnd,
      contractStartDate: terms.contract_start_date, contractEndDate: terms.contract_end_date,
    })

    // Step E9B.1 §8/§9 — the retryable/non-retryable decision for BOTH
    // 'not_ready' and 'invalid' is made by lib/performance-share-
    // readiness.ts's pure classifyPerformanceShareResultStatus, directly
    // unit-tested there — this call site only acts on it. CORRECTS an
    // incomplete prior edit: 'invalid' was still throwing
    // QuantitySourceNotReadyError (retryable/held) until this pass,
    // contradicting the currency-mismatch branch just above (and the E9B
    // closing report, which incorrectly claimed both were already
    // converted) — 'invalid' means computePerformanceShareFee itself
    // judged the data malformed, not merely absent, the same "won't self-
    // resolve by waiting" reasoning as a currency mismatch. (Currently
    // unreachable — computePerformanceShareFee has no call site that
    // returns 'invalid' today, confirmed by reading lib/performance-
    // share-fee.ts in full — but the type contract declares it possible,
    // so this stays correctly classified rather than silently wrong the
    // day a future change starts producing it.)
    // Checked as `result.status === ... || ...` (not via a separately
    // computed boolean) so TypeScript still narrows `result` itself to
    // 'ready' | 'waived' below this block — the classify call still makes
    // the actual retryable/reason decision, this shape is only about
    // preserving the compiler's own narrowing.
    if (result.status === 'not_ready' || result.status === 'invalid') {
      const resultOutcome = classifyPerformanceShareResultStatus(result.status, result.reason)
      if (resultOutcome.blocked && resultOutcome.retryable) {
        // Step E9B — the core fix: a performance fee still missing a
        // required manual operational input used to be silently omitted
        // from the real invoice (documented above as deliberate — correct
        // for "held pending a reviewer's commercial timing decision" a few
        // lines up, but wrong here, where the input is simply not entered
        // yet). Reusing the identical error/recovery path as usage-pull.ts's
        // own E9B fix — see that file's comment for the full rationale.
        throw new QuantitySourceNotReadyError({
          ready: false, provenance: 'external_usage', metricKey: fee.fee_label, periodStart, periodEnd, reason: resultOutcome.reason,
        })
      }
      throw new Error(`'${fee.fee_label}' invalid for job ${jobId}, period ${periodStart}–${periodEnd}: ${resultOutcome.blocked ? resultOutcome.reason : 'unknown'}`)
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
