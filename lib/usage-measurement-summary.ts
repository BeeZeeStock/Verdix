// Step 17H.2B.2 items 2/3/4/5 — the pricing-FREE measurement-only path
// Billing Timeline's Refresh action calls. Deliberately a separate module
// from lib/usage-pull.ts / lib/per-unit-fee-pull.ts (which remain the
// authoritative PRICING path, used by real billing and by the existing
// /consumption-summary route that Billing Periods still depends on) —
// reuses their exact quantity-resolution building blocks
// (resolveUsageMeasurementWindows, resolveUsageQuantityForPeriod) rather
// than re-implementing meter/source resolution, and never imports
// computeMetricOverage, computePerformanceShareFee, or any other pricing
// function. There is no code path from this file that can reach a tier
// table, a rate, or an overage/performance calculation — not merely "the
// result is discarded," the calculation itself is never invoked.
import { resolveUsageMeasurementWindows, resolveLegacyClientPullQuantity } from './usage-pull'
import { resolveUsageQuantityForPeriod } from './usage-quantity-resolver'
import { resolveRecognizedOperationalInputKey } from './operational-input-canonicalization'
import type { ContractTerms } from './types'

export interface UsageMeasurementFact {
  // Matches the rate-based correlation lib/billing-period-workspace.ts's
  // derivePeriodExecutionModel already uses (findMatchingConsumptionItem) —
  // this fact is designed to drop directly into a ConsumptionPeriodLike's
  // overageItems array with no adapter needed.
  meter_key: string
  rate_per_unit?: number
  total_units: number
  // Deliberately absent, always — this is the one structural guarantee
  // this module makes: no measurement fact it produces ever carries a
  // monetary amount.
  metric_source: 'meter_pull' | 'manual_entry' | 'client_pull'
  description?: string
}

// Step 17H.2B.2/17H.2C item 3 — for the overage-tier (usage-meter) side,
// reuses resolveUsageMeasurementWindows verbatim (the exact same function
// computeOverageForPeriod itself calls for quantity resolution) — never a
// second, independently-written meter/window/pull implementation.
//
// Precedence (item 3's explicit doctrine, matching computeOverageForPeriod's
// own existing structure exactly): a confirmed contract_meter_mappings row
// wins first; the legacy org-level client_usage_url fallback is only ever
// attempted when NO confirmed mapping exists at all. The legacy fallback
// can never override or compete with a confirmed mapping — resolved.length
// === 0 with hasConfirmedMappings === true (a confirmed mapping exists but
// genuinely produced no windows/reading yet) correctly does NOT fall
// through to legacy, exactly like computeOverageForPeriod's own early
// `if (meterConfigs && meterConfigs.length > 0) { ...; return items }`.
async function resolveOverageTierMeasurements(params: {
  orgId: string; jobId: string; terms: ContractTerms; customerId: string
  periodStartUnix: number; periodEndUnix: number; billingAsOf: Date
  preferClosedPeriodSnapshot?: boolean
}): Promise<UsageMeasurementFact[]> {
  const { hasConfirmedMappings, resolved } = await resolveUsageMeasurementWindows({
    orgId: params.orgId, jobId: params.jobId, terms: params.terms, customerId: params.customerId,
    periodStartUnix: params.periodStartUnix, periodEndUnix: params.periodEndUnix, billingAsOf: params.billingAsOf,
    // Never real billing — this path exists specifically so a Refresh
    // click can never reach the fail-closed real-billing invariant, the
    // finalize write, or (via the caller of this function) any pricing
    // math at all.
    isRealBilling: false,
    includeZeroUsage: true,
    // Every real caller of this module is a read-only preview (there is no
    // "real billing" use of it at all, by design) — matching /consumption-
    // summary's own convention for its live-preview branch, a test-mode
    // meter's simulated reading must still be visible here (that is the
    // whole point of testing it), even though real billing itself refuses
    // to invoice off one.
    ignoreTestModeGate: true,
    // livePreviewAsOfUnix mirrors billingAsOf — same "surface the
    // currently-open window" behavior the existing preview path uses,
    // never a real-billing closed-window-only scan.
    livePreviewAsOfUnix: Math.floor(params.billingAsOf.getTime() / 1000),
    preferClosedPeriodSnapshot: params.preferClosedPeriodSnapshot,
  })
  if (hasConfirmedMappings) {
    return resolved.map(({ cfg, totalUnits, metricSource }) => ({
      meter_key: cfg.meter_key,
      rate_per_unit: cfg.overage_tiers?.[0]?.rate_per_unit,
      total_units: totalUnits,
      metric_source: metricSource,
    }))
  }

  // No confirmed mapping at all — only NOW is the legacy fallback
  // attempted, mirroring computeOverageForPeriod's own precedence exactly.
  // resolveLegacyClientPullQuantity is the pricing-free quantity-only
  // extraction of that same legacy branch (Step 17H.2C item 3) — same HTTP
  // call, same response parsing, never computeMetricOverage.
  const legacy = await resolveLegacyClientPullQuantity({
    orgId: params.orgId, jobId: params.jobId, customerId: params.customerId,
    periodStartUnix: params.periodStartUnix, periodEndUnix: params.periodEndUnix,
  })
  if (!legacy.ready) return []
  // rate_per_unit included (never used to compute a charge here) purely so
  // derivePeriodExecutionModel's existing rate-based correlation
  // (findMatchingConsumptionItem) can still match this reading to its
  // pricing fact — matching computeOverageForPeriod's own legacy branch,
  // which sources the same value the same way.
  return [{
    meter_key: 'usage', total_units: legacy.aggregateUnits, metric_source: 'client_pull',
    rate_per_unit: params.terms.overage_tiers?.[0]?.rate_per_unit ?? 0,
  }]
}

// Step 17H.2B.2 item 3 — for the per-unit-fee side, calls
// resolveUsageQuantityForPeriod directly (already the pricing-free
// quantity resolver lib/per-unit-fee-pull.ts itself builds on) — stops
// before that file's own `amount = quantity * rate` line.
async function resolvePerUnitFeeMeasurements(params: {
  jobId: string; orgId: string; terms: ContractTerms
  periodStart: string; periodEnd: string; asOf: Date
  preferClosedPeriodSnapshot?: boolean
}): Promise<UsageMeasurementFact[]> {
  const variableRateFees = (params.terms.additional_recurring_fees ?? []).filter(
    f => !!f.metric_name && typeof f.rate_per_unit === 'number' && f.rate_per_unit > 0 && !!f.semantic_input_key,
  )
  const facts: UsageMeasurementFact[] = []
  for (const fee of variableRateFees) {
    const canonicalKey = resolveRecognizedOperationalInputKey(fee.semantic_input_key!)
    if (!canonicalKey) continue
    const resolved = await resolveUsageQuantityForPeriod({
      jobId: params.jobId, orgId: params.orgId, semanticInputKey: canonicalKey,
      periodStart: new Date(params.periodStart + 'T00:00:00'), periodEnd: new Date(params.periodEnd + 'T23:59:59'),
      asOf: params.asOf,
      // Never 'closed_period_finalize' — this path never finalizes.
      mode: params.preferClosedPeriodSnapshot ? 'closed_period_read' : 'live',
    })
    if (!resolved.ready) continue
    facts.push({
      meter_key: resolved.source === 'meter' ? resolved.meterKey : canonicalKey,
      rate_per_unit: fee.rate_per_unit!,
      total_units: resolved.quantity,
      metric_source: resolved.source === 'meter' ? 'meter_pull' : 'manual_entry',
      description: fee.fee_label,
    })
  }
  return facts
}

// Step 17H.2B.2 items 2-5 — the ONE function Billing Timeline's Refresh
// action calls for a given period's usage-adjacent measurement state.
// Combines both metric shapes (tiered overage, flat per-unit fee) into one
// list, matching the SAME `key -> ratePerUnit` correlation
// derivePeriodExecutionModel already uses to join a pricing fact to its
// live reading — no new correlation scheme, no new persistence.
export async function resolveMeasurementSummaryForPeriod(params: {
  orgId: string
  jobId: string
  terms: ContractTerms
  customerId: string
  periodStart: string
  periodEnd: string
  asOf: Date
  preferClosedPeriodSnapshot?: boolean
}): Promise<UsageMeasurementFact[]> {
  const { orgId, jobId, terms, customerId, periodStart, periodEnd, asOf, preferClosedPeriodSnapshot } = params
  const periodStartUnix = Math.floor(new Date(periodStart + 'T00:00:00').getTime() / 1000)
  const periodEndUnix   = Math.floor(new Date(periodEnd   + 'T23:59:59').getTime() / 1000)

  const [overageFacts, perUnitFacts] = await Promise.all([
    resolveOverageTierMeasurements({ orgId, jobId, terms, customerId, periodStartUnix, periodEndUnix, billingAsOf: asOf, preferClosedPeriodSnapshot }),
    resolvePerUnitFeeMeasurements({ jobId, orgId, terms, periodStart, periodEnd, asOf, preferClosedPeriodSnapshot }),
  ])
  return overageFacts.concat(perUnitFacts)
}
