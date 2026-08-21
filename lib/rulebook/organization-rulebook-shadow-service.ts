// Organization Rulebook — shadow resolution loader (Step 5B).
//
// The ONLY DB-touching piece of Step 5B — a thin wrapper that loads an
// organization's active rules (via Step 5A's unmodified
// listActiveOrganizationRules) and hands them to the pure resolver
// (organization-rulebook-shadow.ts's resolveOrganizationRulebookShadow).
// Mirrors the pure/DB-touching split already established across this
// module (organization-rules.ts pure / organization-rules-service.ts
// DB-touching; lib/credit-ledger.ts pure / lib/credit-ledger-service.ts
// DB-touching).
//
// Not called from any production route or page — exists so a caller
// (currently: tests, and eventually a real diagnostic/route once Step 5B
// is reviewed) doesn't have to hand-wire the loader and resolver together
// itself. organizationId must be trusted (from requireOrg()), never a
// client-supplied value — same contract as organization-rules-service.ts.
import { listActiveOrganizationRules } from './organization-rules-service'
import { resolveOrganizationRulebookShadow, type CommercialFieldContext, type OrganizationRulebookFieldShadowResult } from './organization-rulebook-shadow'
import type { RuleResolutionCandidate } from './resolution'

export async function loadAndResolveOrganizationRulebookShadow(input: {
  organizationId: string
  commercialContext: CommercialFieldContext
  asOf: Date
  verdixCandidates?: RuleResolutionCandidate[]
}): Promise<OrganizationRulebookFieldShadowResult[]> {
  const organizationRules = await listActiveOrganizationRules(input.organizationId)
  return resolveOrganizationRulebookShadow({
    organizationId: input.organizationId,
    commercialContext: input.commercialContext,
    organizationRules,
    asOf: input.asOf,
    verdixCandidates: input.verdixCandidates,
  })
}
