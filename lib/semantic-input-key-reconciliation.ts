// Step 17F.1, item 1 — backfills a MISSING additional_recurring_fees/
// overage_tiers.semantic_input_key on a contract extracted before that
// field existed (root cause confirmed via git blame: commit 3c1fe52b7
// added the extraction-prompt instruction on 2026-08-28 16:24, ~2 hours
// AFTER the real Remembill job a4459e99 was extracted at 14:41 the same
// day — a pre-17D.1 extraction artifact, not a compiler or reconciliation
// omission; lib/commercial-mechanism-compiler.ts's
// resolveExtractedSemanticInputKeys only ever canonicalizes an ALREADY-
// present value, it was never meant to assign one from nothing).
//
// Pure, DB-free. Resolves ONLY via lib/operational-input-canonicalization.ts's
// strict, closed registry (resolveRecognizedOperationalInputKey) applied to
// each fee/tier's own controlled, extraction-typed field (metric_name /
// unit_type — the field the extraction prompt specifically documents as
// naming the counted unit) — never fee_label/tier_label (free-text display
// strings), and never invoked from a billing-time code path. An entry that
// already has a semantic_input_key, or whose metric_name/unit_type doesn't
// resolve via the registry, is left completely untouched — this never
// guesses, it only completes an identity the registry already recognizes.
import { resolveRecognizedOperationalInputKey } from './operational-input-canonicalization'

export interface ReconcilableFee {
  fee_label: string
  metric_name?: string | null
  semantic_input_key?: string | null
}

export interface ReconcilableTier {
  unit_type?: string | null
  semantic_input_key?: string | null
}

export interface SemanticInputKeyReconciliationPlan {
  // Index into the caller's own additional_recurring_fees/overage_tiers
  // arrays (not a copy of the row) — the caller applies these positionally,
  // so array order/identity is preserved exactly as stored.
  feeUpdates: Array<{ index: number; fee_label: string; semantic_input_key: string }>
  tierUpdates: Array<{ index: number; unit_type: string; semantic_input_key: string }>
}

export function planSemanticInputKeyReconciliation(params: {
  fees: ReconcilableFee[]
  tiers: ReconcilableTier[]
}): SemanticInputKeyReconciliationPlan {
  const { fees, tiers } = params
  const feeUpdates: SemanticInputKeyReconciliationPlan['feeUpdates'] = []
  const tierUpdates: SemanticInputKeyReconciliationPlan['tierUpdates'] = []

  fees.forEach((fee, index) => {
    if (fee.semantic_input_key) return
    const resolved = fee.metric_name ? resolveRecognizedOperationalInputKey(fee.metric_name) : null
    if (resolved) feeUpdates.push({ index, fee_label: fee.fee_label, semantic_input_key: resolved })
  })

  tiers.forEach((tier, index) => {
    if (tier.semantic_input_key) return
    const resolved = tier.unit_type ? resolveRecognizedOperationalInputKey(tier.unit_type) : null
    if (resolved) tierUpdates.push({ index, unit_type: tier.unit_type as string, semantic_input_key: resolved })
  })

  return { feeUpdates, tierUpdates }
}

export interface ReconcilableMapping {
  contract_unit_type: string
  semantic_input_key?: string | null
}

export interface MappingSemanticKeyReconciliationPlan {
  mappingUpdates: Array<{ contract_unit_type: string; semantic_input_key: string }>
}

// Step 17F.1, item 3's investigation found a SEPARATE storage location for
// the same identity: lib/usage-pull.ts's real-billing overage path reads
// contract_meter_mappings.semantic_input_key (not contract_terms'
// additional_recurring_fees/overage_tiers copy) to decide whether to pin a
// resolved_usage_period_snapshots row — leaving it null means the tiered-
// overage pull never finalizes a snapshot, so a sibling per-unit-fee-pull
// call for the identical semantic key can't reuse it and must pull again
// (item 3's "do not introduce duplicate pulls" requirement). Resolved the
// exact same way — strict registry against contract_unit_type, the
// controlled field this table's own row is keyed on — never a second,
// looser heuristic.
export function planMeterMappingSemanticKeyReconciliation(params: {
  mappings: ReconcilableMapping[]
}): MappingSemanticKeyReconciliationPlan {
  const mappingUpdates: MappingSemanticKeyReconciliationPlan['mappingUpdates'] = []
  for (const m of params.mappings) {
    if (m.semantic_input_key) continue
    const resolved = resolveRecognizedOperationalInputKey(m.contract_unit_type)
    if (resolved) mappingUpdates.push({ contract_unit_type: m.contract_unit_type, semantic_input_key: resolved })
  }
  return { mappingUpdates }
}

// Applies a plan to fresh copies of the fee/tier arrays — pure, no
// mutation of the caller's own objects. The DB-touching wrapper (the
// explicit POST reconciliation route) is the only place this result is
// ever persisted.
export function applySemanticInputKeyReconciliation<F extends ReconcilableFee, T extends ReconcilableTier>(params: {
  fees: F[]
  tiers: T[]
  plan: SemanticInputKeyReconciliationPlan
}): { fees: F[]; tiers: T[] } {
  const { fees, tiers, plan } = params
  const feeByIndex = new Map(plan.feeUpdates.map(u => [u.index, u.semantic_input_key]))
  const tierByIndex = new Map(plan.tierUpdates.map(u => [u.index, u.semantic_input_key]))
  return {
    fees: fees.map((f, i) => feeByIndex.has(i) ? { ...f, semantic_input_key: feeByIndex.get(i) } : f),
    tiers: tiers.map((t, i) => tierByIndex.has(i) ? { ...t, semantic_input_key: tierByIndex.get(i) } : t),
  }
}
