// Step 17F, item 3 — classifies each commercial component into what it
// actually depends on for its amount: a fixed schedule figure, a usage
// meter reading, or an operational-input-derived performance calculation.
// Previously the GUI's "Billing Configuration" section grouped everything
// usage-adjacent under one broad "Variable pricing" label, which didn't
// distinguish "this needs a meter reading" from "this needs a human to
// type a monetary figure each period" — two different operational
// responsibilities. Pure, DB-free: takes the same typed contract-terms
// data and the already-built UsageSourceCard list (lib/usage-source-cards.ts,
// the canonical source-of-truth for "which meter/manual entry supplies
// which semantic input") so a usage-meter component's `sourceName` is
// never independently re-resolved.
import type { UsageSourceCard } from './usage-source-cards'

// Deliberately narrow, structural interfaces (mirroring lib/usage-source-
// cards.ts's own UsageSourceFee/UsageSourceTier convention) rather than
// importing lib/types.ts's canonical AdditionalRecurringFee/OverageTier —
// callers (this page has its own locally-typed, slightly looser Tier/fee
// shapes) only need to satisfy these specific fields, not the full
// canonical type.
export interface PricingDependencyFee {
  fee_label: string
  amount?: number | null
  rate_per_unit?: number | null
  semantic_input_key?: string | null
  percentage_of_basis?: {
    derived_metric: { numerator_input_key: string; denominator_input_key: string }
    basis_input_key: string
  } | null
}

export interface PricingDependencyTier {
  tier_label?: string | null
  unit_type?: string | null
  from_unit?: number | null
  rate_per_unit?: number | null
  semantic_input_key?: string | null
}

export type PricingDependencyKind = 'fixed' | 'usage_meter' | 'performance_based'

export interface FixedPricingFact {
  kind: 'fixed'
  key: string
  label: string
  amount: number
}

export interface UsageMeterPricingFact {
  kind: 'usage_meter'
  key: string
  label: string
  ratePerUnit: number
  semanticInputKey: string | null
  sourceName: string | null
  // Present only for a tiered/overage component (the amount above an
  // included allowance) — absent for a flat per-unit fee, which has no
  // included-units concept.
  includedUnits?: number | null
}

export interface PerformanceBasedPricingFact {
  kind: 'performance_based'
  key: string
  label: string
  numeratorKey: string
  denominatorKey: string
  basisKey: string
}

export interface PricingDependencyGroups {
  fixed: FixedPricingFact[]
  usageMeter: UsageMeterPricingFact[]
  performanceBased: PerformanceBasedPricingFact[]
}

function findSource(usageSources: UsageSourceCard[], semanticInputKey: string | null | undefined): { sourceName: string | null; semanticInputKey: string | null } {
  if (!semanticInputKey) return { sourceName: null, semanticInputKey: null }
  const card = usageSources.find(c => c.semanticInputKey === semanticInputKey)
  return { sourceName: card?.sourceName ?? null, semanticInputKey }
}

export function buildPricingDependencyGroups(params: {
  baseMonthlyFee?: number | null
  additionalFixedFees?: Array<{ fee_label: string; amount?: number | null }>
  fees: PricingDependencyFee[]
  tiers: PricingDependencyTier[]
  usageSources: UsageSourceCard[]
}): PricingDependencyGroups {
  const { baseMonthlyFee, additionalFixedFees, fees, tiers, usageSources } = params

  const fixed: FixedPricingFact[] = []
  if (typeof baseMonthlyFee === 'number' && baseMonthlyFee > 0) {
    fixed.push({ kind: 'fixed', key: 'base_monthly_fee', label: 'Platform fee', amount: baseMonthlyFee })
  }
  for (const f of additionalFixedFees ?? []) {
    if (typeof f.amount === 'number' && f.amount > 0) {
      fixed.push({ kind: 'fixed', key: f.fee_label, label: f.fee_label, amount: f.amount })
    }
  }

  const usageMeter: UsageMeterPricingFact[] = []
  for (const fee of fees) {
    if (fee.percentage_of_basis) continue // performance_based, handled below
    if (typeof fee.rate_per_unit !== 'number' || fee.rate_per_unit <= 0) continue
    const { sourceName, semanticInputKey } = findSource(usageSources, fee.semantic_input_key)
    usageMeter.push({
      kind: 'usage_meter', key: fee.fee_label, label: fee.fee_label,
      ratePerUnit: fee.rate_per_unit, semanticInputKey, sourceName,
    })
  }
  for (const tier of tiers) {
    if (typeof tier.rate_per_unit !== 'number' || tier.rate_per_unit <= 0) continue
    const { sourceName, semanticInputKey } = findSource(usageSources, tier.semantic_input_key)
    usageMeter.push({
      kind: 'usage_meter', key: tier.tier_label || `${tier.unit_type} overage`, label: tier.tier_label || `${tier.unit_type} overage`,
      ratePerUnit: tier.rate_per_unit, semanticInputKey, sourceName,
      includedUnits: tier.from_unit != null ? Math.max(0, tier.from_unit - 1) : null,
    })
  }

  const performanceBased: PerformanceBasedPricingFact[] = []
  for (const fee of fees) {
    if (!fee.percentage_of_basis) continue
    const c = fee.percentage_of_basis
    performanceBased.push({
      kind: 'performance_based', key: fee.fee_label, label: fee.fee_label,
      numeratorKey: c.derived_metric.numerator_input_key,
      denominatorKey: c.derived_metric.denominator_input_key,
      basisKey: c.basis_input_key,
    })
  }

  return { fixed, usageMeter, performanceBased }
}
