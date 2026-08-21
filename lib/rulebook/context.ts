// Verdix Global Rulebook — context adapters (Step 2, shadow mode only).
//
// Small, pure functions that translate today's real, already-shipped
// normalized structures (lib/types.ts) into the slices of
// CommercialSemanticContext a Rulebook rule reads. Nothing here is a new
// production data model — it's a read-only view over existing shapes. None
// of these adapters are wired into any route handler or production call
// site yet; see lib/rulebook/resolver.ts's module comment for the intended
// (not-yet-built) integration point.
import type { MinimumCommitment, TierCalculationMethod, CreditApplicationRule, FieldProvenance } from '@/lib/types'
import type { CommercialSemanticContext, ObservedMinimumCalculation, ObservedTierCalculation, ProvenancedField } from './types'

export function minimumCommitmentContext(
  mc: Pick<MinimumCommitment, 'mode'> | null | undefined,
  observed?: ObservedMinimumCalculation | null,
): CommercialSemanticContext['minimumCommitment'] {
  if (!mc) return null
  return { mode: mc.mode, observed: observed ?? null }
}

export function tierCalculationContext(
  tc: Pick<TierCalculationMethod, 'method'> | null | undefined,
  observed?: ObservedTierCalculation | null,
): CommercialSemanticContext['tierCalculation'] {
  if (!tc) return null
  return { method: tc.method, observed: observed ?? null }
}

export function creditApplicationContext(
  appRule: Pick<CreditApplicationRule, 'eligible_component_keys' | 'eligibility_provenance' | 'carry_forward' | 'survival_provenance' | 'availability'> | null | undefined,
): CommercialSemanticContext['creditApplication'] {
  if (!appRule) return null
  return {
    eligibleComponentKeys: appRule.eligible_component_keys,
    eligibilityProvenance: appRule.eligibility_provenance,
    carryForward: appRule.carry_forward,
    survivalProvenance: appRule.survival_provenance,
    availability: appRule.availability,
  }
}

export function creditBasisContext(componentKeys: string[] | null | undefined): CommercialSemanticContext['creditBasis'] {
  if (componentKeys == null) return null
  return { componentKeys }
}

export function provenancedField(
  field: string,
  value: unknown,
  provenance: FieldProvenance | null | undefined,
  sourceTextPresent: boolean,
): ProvenancedField {
  return { field, value, provenance, sourceTextPresent }
}
