// Step 17G.4B — small pure helpers behind the Commercial BoM table
// (formerly "Billing Configuration"). classifyItem (app/(dashboard)/
// configure/[id]/page.tsx) alone cannot distinguish a flat variable-rate
// additional_recurring_fee (e.g. "Per-issued payment request fee") from
// the true fixed base fee — both fall through to its same default
// classification bucket. Matched here by product_name against the fee's
// own fee_label, the same identity lib/line-items.ts's buildLineItems
// used to create the row in the first place.
export interface CommercialBomFee {
  fee_label: string
  metric_name?: string | null
  rate_per_unit?: number | null
  percentage_of_basis?: unknown
}

export function deriveVariableRateFeeLabels(fees: CommercialBomFee[] | null | undefined): Set<string> {
  return new Set(
    (fees ?? [])
      .filter(f => !!f.metric_name && typeof f.rate_per_unit === 'number' && f.rate_per_unit > 0 && !f.percentage_of_basis)
      .map(f => f.fee_label),
  )
}

export type CommercialBomRowKind = 'overage_tier' | 'one_time' | 'escalator' | 'escalator_interpretation' | string

// The pricing-model sub-label shown under each component name — never
// itself decides what's "deterministic" (that stays computeCommittedFixedFees'
// job); purely descriptive.
export function pricingModelLabelFor(rowKind: CommercialBomRowKind, isFlatUsageRate: boolean): string {
  if (rowKind === 'overage_tier' || isFlatUsageRate) return 'Usage-based'
  if (rowKind === 'one_time') return 'One-time'
  if (rowKind === 'escalator' || rowKind === 'escalator_interpretation') return 'Escalator'
  return 'Fixed recurring'
}

// Step 17G.4C — presentation-only display-label cleanup for the Commercial
// BoM's "Commercial component" column. Two tiers of confidence, in order:
//  1. The recurring/base platform fee's product_name is drawn from a
//     fully enumerable, non-contract-specific set buildLineItems itself
//     emits (lib/line-items.ts) — 'Recurring base fee', 'Recurring base
//     fee (periods N–M)', 'Recurring base fee — partial-period treatment
//     unresolved', 'Base subscription' — so renaming these to "Platform
//     subscription" is a global, deterministic substitution, never a
//     per-contract guess.
//  2. Everything else is free text extracted from the contract itself
//     (additional_recurring_fees[].fee_label, one_time_fees[].fee_label,
//     overage_tiers[].tier_label). Only a light, structural cleanup is
//     globally safe here — stripping a "Per-"/"per " prefix and a
//     trailing "fee"/"charge" noun. A deeper rewrite (pluralizing,
//     dropping qualifying words, shortening a threshold clause) requires
//     understanding what the label actually MEANS on a per-contract
//     basis — exactly the kind of guess this function must not make — so
//     when the light transform doesn't change anything, the original
//     extracted label is returned verbatim rather than invented.
export function bomDisplayLabel(productName: string): string {
  if (productName === 'Recurring base fee' || productName === 'Base subscription') return 'Platform subscription'
  // Step 17H.4B0D4H1B4E6 §6 — previously preserved as "Platform subscription
  // (periods 4–12)". The periods substring is WHEN/HOW information (which
  // rate blocks this row covers), not WHAT the component is — the row's own
  // Qty column already states the period count, and pilot-waiver/timing
  // treatment already live downstream (Commercial Logic, Billing Timeline).
  // The persisted identity string this regex matches against is untouched
  // (see the comment below) — this only changes what's DISPLAYED.
  if (/^Recurring base fee \(periods \d+–\d+\)$/.test(productName)) return 'Platform subscription'
  // Step 17H.4B0D4H1B4E2.5 §7-8 — this exact string is a STABLE, PERSISTED
  // identity marker lib/line-items.ts's buildLineItems writes to
  // current_line_items.product_name (never renamed — lib/current-line-
  // item-reconciliation-plan.ts/lib/line-item-markers.ts match it verbatim
  // for reconciliation identity, so the underlying data stays untouched).
  // The DISPLAY name, though, must stay pure WHAT (the economic component
  // is still "Platform subscription" — the base fee didn't change) — the
  // unresolved-HOW fact is already carried independently by
  // isBaseFeeProrationUnresolved (page.tsx), which drives the deterministic-
  // value column's own "Pending interpretation" badge without reading this
  // string at all, so nothing is lost by cleaning the name here.
  if (productName === 'Recurring base fee — partial-period treatment unresolved') {
    return 'Platform subscription'
  }
  const cleaned = productName.replace(/^per[- ]/i, '').replace(/\s+(fee|charge)$/i, '').trim()
  if (!cleaned || cleaned === productName) return productName
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
}
