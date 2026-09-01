// Step 17D, item 10 — closes the execution gap the architecture audit
// found: a generic per-unit additional_recurring_fee (metric_name +
// rate_per_unit, e.g. "€0.38 per issued payment request") had NO real
// quantity execution path at all — lib/line-items.ts only ever built a
// quantity-0/€0 PREVIEW row for it; nothing in usage-pull.ts or
// billing-writer.ts consumed metric_name to produce a real charge.
//
// Mirrors lib/performance-share-pull.ts's own shape exactly (same params
// style, same OverageLineItem output) — this is not a Remembill-specific
// calculation branch (item 10's explicit constraint): it is generic over
// ANY additional_recurring_fees[] entry that both is a variable-rate fee
// (lib/line-items.ts's own isVariableRate shape) AND declares a
// semantic_input_key that resolves through the same closed canonical
// registry every other execution path in this codebase uses. Quantity
// SOURCING is entirely delegated to lib/usage-quantity-resolver.ts — this
// module only ever multiplies rate_per_unit × the resolved quantity; it
// never pulls a connector or reads a table itself.
//
// Step E9E — acceptance testing found this file had never received the
// Step E9B fix already applied to lib/usage-pull.ts's manual-fallback
// branch and lib/performance-share-pull.ts's not_ready branch (see those
// files' own comments for the original incident): a required per-unit
// usage fee with no ready meter AND no finalized manual value was
// silently OMITTED from the real invoice Verdix actually sends — the
// exact "silently omit the usage obligation" failure mode, still present
// here even though every sibling execution path was already corrected.
// Real billing (finalize:true) now fails closed via
// QuantitySourceNotReadyError, tagged [usage_source] so lib/invoice-hold-
// status.ts's EXISTING classifyHoldReason (no change needed there)
// surfaces the same "Usage data required" business copy an overage-tier
// hold already uses. A live preview (finalize:false/undefined — the
// Consumption screen) keeps its exact prior behavior — skip and log,
// never throw — unchanged.
import type { ContractTerms } from '@/lib/types'
import type { OverageLineItem } from '@/lib/usage-pull'
import { resolveUsageQuantityForPeriod } from '@/lib/usage-quantity-resolver'
import { resolveRecognizedOperationalInputKey } from '@/lib/operational-input-canonicalization'
import { QuantitySourceNotReadyError } from '@/lib/commercial-quantity-source'

export async function computePerUnitFeeLineItemsForPeriod(params: {
  jobId: string
  orgId: string
  terms: ContractTerms
  currency: string
  periodStart: string
  periodEnd: string
  asOf?: string
  includeZeroAmount?: boolean
  // Step 17D.1, item H/J — false (default) for a live preview (Consumption
  // screen): always a fresh, non-durable read, exactly like before. true
  // ONLY for the real invoice-scheduler closing this period for real —
  // finalizes the resolved quantity as the authoritative closed-period
  // measurement (lib/usage-quantity-resolver.ts's 'closed_period_finalize'
  // mode), reusing an already-finalized snapshot from a sibling consumer
  // of the SAME semantic input in this same run (e.g. overage) rather than
  // pulling twice. Never true for a preview/read-only request.
  finalize?: boolean
  // Step 17F.2, item B — additive, opt-in only (default false, so every
  // EXISTING caller's behavior is completely unchanged): for a period that
  // has fully CLOSED but whose invoice hasn't been sent yet (consumption-
  // summary's own 'pending' status), prefer an already-finalized snapshot
  // (mode: 'closed_period_read') over a fresh live pull, so a source value
  // that changed AFTER real billing close doesn't make a not-yet-sent
  // period's DISPLAY disagree with what real billing already computed.
  // Never combined with finalize:true (real billing always pulls fresh and
  // finalizes its own result — this flag is read-only-preview-only).
  preferClosedPeriodSnapshot?: boolean
}): Promise<OverageLineItem[]> {
  const { jobId, orgId, terms, currency, periodStart, periodEnd, includeZeroAmount, finalize, preferClosedPeriodSnapshot } = params
  const asOf = params.asOf ?? new Date().toISOString()
  const asOfDate = new Date(asOf)

  const variableRateFees = (terms.additional_recurring_fees ?? []).filter(
    f => !!f.metric_name && typeof f.rate_per_unit === 'number' && f.rate_per_unit > 0 && !!f.semantic_input_key,
  )
  if (variableRateFees.length === 0) return []

  const items: OverageLineItem[] = []

  for (const fee of variableRateFees) {
    const canonicalKey = resolveRecognizedOperationalInputKey(fee.semantic_input_key!)
    if (!canonicalKey) {
      console.warn(`[per-unit-fee-pull] job ${jobId} fee '${fee.fee_label}': semantic_input_key '${fee.semantic_input_key}' is not recognized — skipping`)
      continue
    }

    const resolved = await resolveUsageQuantityForPeriod({
      jobId, orgId, semanticInputKey: canonicalKey,
      periodStart: new Date(periodStart + 'T00:00:00'),
      periodEnd: new Date(periodEnd + 'T23:59:59'),
      asOf: asOfDate,
      mode: finalize ? 'closed_period_finalize' : preferClosedPeriodSnapshot ? 'closed_period_read' : 'live',
    })

    if (!resolved.ready) {
      if (finalize) {
        throw new QuantitySourceNotReadyError({
          ready: false, provenance: 'external_usage', metricKey: fee.fee_label,
          periodStart, periodEnd, reason: `[usage_source] ${resolved.reason}`,
        })
      }
      console.warn(`[per-unit-fee-pull] job ${jobId} fee '${fee.fee_label}': ${resolved.reason}`)
      continue
    }

    const amount = Math.round(resolved.quantity * fee.rate_per_unit! * 100) / 100
    if (amount <= 0 && !includeZeroAmount) continue

    items.push({
      meter_key: resolved.source === 'meter' ? resolved.meterKey : canonicalKey,
      contractUnitType: canonicalKey,
      total_units: resolved.quantity,
      included_units: 0,
      billable_units: resolved.quantity,
      rate_per_unit: fee.rate_per_unit!,
      amount,
      currency,
      description: `${fee.fee_label}: ${resolved.quantity.toLocaleString()} × ${fee.rate_per_unit}`,
      metric_source: resolved.source === 'meter' ? 'meter_pull' : 'manual_entry',
      windowStart: periodStart,
      windowEnd: periodEnd,
    })
  }

  return items
}
