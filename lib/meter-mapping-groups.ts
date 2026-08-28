// Step 17D.2, item E — builds the set of usage-mapping "groups" the
// meter-mappings review UI shows one card per, extracted out of
// app/api/jobs/[id]/meter-mappings/route.ts's GET handler so this
// dedup-by-canonical-key logic is unit-testable (this codebase has no
// precedent for testing Next.js route handlers directly — every other
// piece of route logic that needs real test coverage lives in a plain lib
// function the route calls, same convention followed here).
//
// The goal: "the review UI presents one source decision, not three" (item
// E) — a per-unit additional_recurring_fee, an overage_tiers entry, and a
// rolling volume-band migration can all require the SAME canonical usage
// fact (e.g. issued_payment_request_count). Before this, only
// overage_tiers ever produced a mapping card at all — a per-unit fee or a
// rolling migration with no overage tier of its own was invisible to the
// review UI entirely. Now: overage_tiers still drives the primary
// grouping (by raw unit_type, unchanged); a fee or rolling migration gets
// its OWN card only when its resolved canonical key isn't ALREADY covered
// by an existing overage-tier group — this is what makes three
// requirements referencing the same canonical fact collapse into one
// card, while a genuinely uncovered fact (no overage tier at all) still
// surfaces rather than being silently dropped.
import { resolveRecognizedOperationalInputKey } from './operational-input-canonicalization'
import type { MinimumCommitment } from './types'

export interface UsageMappingTier {
  from_unit: number | null
  to_unit: number | null
  rate_per_unit: number
  minimum_period_amount: number | null
  minimum_commitment: MinimumCommitment | null
  reset_anchor: 'contract_start' | 'calendar' | null
}

interface RawOverageTier {
  unit_type?: string
  from_unit?: number | null
  to_unit?: number | null
  rate_per_unit?: number
  minimum_period_amount?: number | null
  minimum_commitment?: MinimumCommitment | null
  reset_anchor?: 'contract_start' | 'calendar' | null
  required_operational_inputs?: string[] | null
  semantic_input_key?: string | null
  measurement_period?: string | null
}

interface RawAdditionalRecurringFee {
  fee_label?: string
  metric_name?: string | null
  rate_per_unit?: number | null
  semantic_input_key?: string | null
}

interface RawUnsupportedMechanism {
  description?: string
  execution_status?: string
  rolling_band_migration?: { aggregate?: { input_key?: string | null } | null } | null
}

export interface UsageMappingGroups {
  unitGroups: Map<string, UsageMappingTier[]>
  unitCycles: Map<string, string>
  extractedSemanticKeys: Map<string, string>
}

export function buildUsageMappingGroups(params: {
  overageTiers: RawOverageTier[]
  additionalRecurringFees: RawAdditionalRecurringFee[]
  unsupportedMechanisms: RawUnsupportedMechanism[]
  normaliseCycle: (freq: string | null | undefined) => string
}): UsageMappingGroups {
  const { overageTiers, additionalRecurringFees, unsupportedMechanisms, normaliseCycle } = params

  const unitGroups = new Map<string, UsageMappingTier[]>()
  const unitCycles = new Map<string, string>()
  const extractedSemanticKeys = new Map<string, string>()

  for (const t of overageTiers) {
    if (!t.unit_type) continue
    if (!unitGroups.has(t.unit_type)) unitGroups.set(t.unit_type, [])
    unitGroups.get(t.unit_type)!.push({
      from_unit:    t.from_unit ?? null,
      to_unit:      t.to_unit   ?? null,
      rate_per_unit: t.rate_per_unit ?? 0,
      minimum_period_amount: t.minimum_period_amount ?? null,
      minimum_commitment: t.minimum_commitment ?? null,
      reset_anchor: t.reset_anchor ?? null,
    })
    if (t.semantic_input_key && !extractedSemanticKeys.has(t.unit_type)) {
      extractedSemanticKeys.set(t.unit_type, t.semantic_input_key)
    }
    if (t.measurement_period && !unitCycles.has(t.unit_type)) {
      unitCycles.set(t.unit_type, normaliseCycle(t.measurement_period))
    }
  }

  // Precompute which canonical keys the overage-tier groups already cover
  // before deciding whether a fee/rolling-migration needs its own card.
  const coveredSemanticKeys = new Set<string>()
  for (const unitType of unitGroups.keys()) {
    const key = extractedSemanticKeys.has(unitType)
      ? resolveRecognizedOperationalInputKey(extractedSemanticKeys.get(unitType)!)
      : resolveRecognizedOperationalInputKey(unitType)
    if (key) coveredSemanticKeys.add(key)
  }

  for (const fee of additionalRecurringFees) {
    if (!fee.semantic_input_key || typeof fee.rate_per_unit !== 'number' || fee.rate_per_unit <= 0) continue
    const resolved = resolveRecognizedOperationalInputKey(fee.semantic_input_key)
    if (!resolved || coveredSemanticKeys.has(resolved)) continue
    const label = fee.fee_label || fee.metric_name || `Per-unit fee (${resolved})`
    if (unitGroups.has(label)) { coveredSemanticKeys.add(resolved); continue }
    unitGroups.set(label, [])
    extractedSemanticKeys.set(label, fee.semantic_input_key)
    coveredSemanticKeys.add(resolved)
  }

  for (const mech of unsupportedMechanisms) {
    const inputKey = mech.rolling_band_migration?.aggregate?.input_key
    if (mech.execution_status !== 'executable' || !inputKey) continue
    const resolved = resolveRecognizedOperationalInputKey(inputKey)
    if (!resolved || coveredSemanticKeys.has(resolved)) continue
    const label = mech.description ? `Rolling volume basis: ${mech.description}` : `Rolling volume basis (${resolved})`
    if (unitGroups.has(label)) { coveredSemanticKeys.add(resolved); continue }
    unitGroups.set(label, [])
    extractedSemanticKeys.set(label, inputKey)
    coveredSemanticKeys.add(resolved)
  }

  return { unitGroups, unitCycles, extractedSemanticKeys }
}
