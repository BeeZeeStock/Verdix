// Final safety-check amendment — the server-authoritative decision behind
// "Use organization policy" (reverting a contract-specific reviewer_policy
// override for survival.carry_forward back to the active Organization
// Policy). Extracted from confirm-rule/route.ts (which can't be unit-tested
// directly — it transitively imports next-auth) so this exact logic is
// independently, directly testable, same discipline as
// lib/credit-application-rule.ts.
//
// Two checks, both enforced HERE — never inferred from what a client
// submits:
//   1. Precedence — only a genuine, already-persisted reviewer_policy
//      override is eligible. A field the CONTRACT itself resolved
//      (contract_derived) must never be moved to the lower-authority
//      organization default by any request, crafted or not. This keeps
//      contract_derived > reviewer_policy > organization_rulebook true
//      regardless of what a crafted payload claims.
//   2. TOCTOU — re-resolves fresh, right now, against the CALLER-SUPPLIED
//      (already org-scoped, already loaded server-side) organizationRules
//      and asOf — never assumes the policy a UI rendered earlier is still
//      applicable. A disabled/superseded/no-longer-matching policy between
//      render and click must not silently leave the field unresolved; it
//      must reject the revert and preserve the existing override.
import { resolveProductionOrganizationField, type ProductionOrganizationResolution } from './rulebook/organization-rulebook-production'
import type { OrganizationRuleRecord } from './rulebook/organization-rules'

export type OrganizationPolicyRevertResult =
  | { eligible: true; resolution: ProductionOrganizationResolution & { status: 'resolved'; ruleId: string; ruleVersion: number } }
  | { eligible: false; reason: 'not_eligible_for_revert' }
  | { eligible: false; reason: 'policy_no_longer_applicable' }

export function resolveOrganizationPolicyRevert(input: {
  organizationId: string
  ruleType: string
  // The CURRENT persisted provenance for this field, read from trusted
  // server-side state (never from the request body).
  existingSurvivalProvenance: string | null | undefined
  organizationRules: OrganizationRuleRecord[]
  asOf: Date
}): OrganizationPolicyRevertResult {
  if (input.existingSurvivalProvenance !== 'reviewer_policy') {
    return { eligible: false, reason: 'not_eligible_for_revert' }
  }

  const resolution = resolveProductionOrganizationField('survival.carry_forward', {
    organizationId: input.organizationId,
    // Genuinely silent — this is a check for "what would apply if nothing
    // had ever decided this field," which is exactly the revert's own
    // question. Passing the stale reviewer_policy current state here would
    // make resolveFieldAuthority (Step 4) see a higher-precedence source
    // already occupying the field and report precedence_blocked, silently
    // defeating every revert attempt.
    commercialContext: {
      current: { 'survival.carry_forward': { value: null, provenance: null } },
      match: { rule_type: input.ruleType, application: { timing: 'next_invoice' } },
    },
    organizationRules: input.organizationRules,
    asOf: input.asOf,
  })

  if (resolution.status !== 'resolved' || resolution.ruleId == null || resolution.ruleVersion == null) {
    return { eligible: false, reason: 'policy_no_longer_applicable' }
  }
  return {
    eligible: true,
    resolution: { ...resolution, status: 'resolved' as const, ruleId: resolution.ruleId, ruleVersion: resolution.ruleVersion },
  }
}
