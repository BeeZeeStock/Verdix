// Organization Rulebook — reviewer-decision promotion (Step 5D).
//
// "Use as organization default": lets a reviewer turn a decision they just
// made for ONE contract into a private organization policy candidate — but
// never automatically, and never by mutating the agreement's own
// reviewer_policy. This module is the pure, no-DB-access half: given the
// CURRENT, ALREADY-PERSISTED state of a commercial field (never a client-
// asserted value — see this module's own callers in app/api/org/rulebook/
// promote/route.ts), it decides whether promotion is even eligible, and if
// so, generates the narrow, allowlisted structured scope a resulting
// organization rule would have. It never itself creates, writes, or
// activates anything — organization-rules-service.ts's createOrganizationRule
// does that, always with status: 'draft' (item 6 — create ≠ approve ≠
// activate).
//
// Step 5D deliberately supports exactly ONE promotable field:
// survival.carry_forward — the only field Step 5C actually activated for
// production resolution (PRODUCTION_ORGANIZATION_RULEBOOK_ALLOWLIST in
// organization-rulebook-production.ts). Promoting a field with no
// production authority would create a rule that could only ever
// participate in shadow diagnostics — confusing, and explicitly out of
// scope ("Do not generalize other reviewer decisions yet").
import { isProductionActivatedOrganizationField, ORGANIZATION_POLICY_SCOPE_DIMENSIONS, type ProductionActivatedOrganizationField } from './organization-rulebook-production'
import type { MatchCondition } from './organization-rules'
import type { FieldProvenance } from '@/lib/types'

export type PromotionIneligibleReason =
  // The field itself isn't one Step 5D supports promoting at all (today,
  // only 'survival.carry_forward' — mirrors, but is intentionally NARROWER
  // than, the production activation allowlist; see targetField's own check
  // below for why this is currently the identical set).
  | 'field_not_promotable'
  // The current value is contract_derived — the CONTRACT itself already
  // states this; promoting it as an "organization default" would be
  // promoting a fact that was never actually a reviewer decision at all
  // ("contract-derived value cannot be promoted", item 16).
  | 'contract_derived_cannot_promote'
  // The current value's provenance IS organization_rulebook already — an
  // org-policy-resolved value can never recursively promote itself into a
  // (possibly different) new organization policy; that would let a
  // resolution silently regenerate/mutate its own source of authority
  // ("organization_rulebook-originated value cannot recursively promote
  // itself", item 16).
  | 'already_organization_policy'
  // Neither contract nor reviewer nor org policy resolved this — nothing
  // concrete exists to promote (verdix_recommends or genuinely unresolved).
  | 'not_a_resolved_reviewer_decision'
  // Provenance says reviewer_policy but there's no concrete boolean value
  // to promote (should not occur given validateProposalState's own
  // guarantees, but checked explicitly — belt-and-braces, same discipline
  // as buildCreditApplicationRule's requiresConfirmation check).
  | 'no_concrete_value'

export interface PromotableFieldState {
  targetField: string
  provenance: FieldProvenance | null | undefined
  value: boolean | 'unclear' | null | undefined
  // Final amendment — the FULL set of semantic facts known about the
  // specific commercial item being promoted, never invented here, always
  // the real facts about that item. Only the subset named in
  // organization-rulebook-production.ts's ORGANIZATION_POLICY_SCOPE_
  // DIMENSIONS for this state's targetField actually becomes a
  // match_conditions entry (see below) — the rest is retained purely for
  // scopeSummary's display purposes. For survival.carry_forward, that
  // scope is rule_type ONLY: unused-balance survival is a different
  // commercial dimension from WHEN a credit first becomes applicable
  // (applicationTiming), and conflating the two would make a rebate
  // carry-forward default fail to generalize across rebates that differ
  // only in application timing.
  matchFacts: { ruleType: string; applicationTiming: string }
}

export interface PromotionEligible {
  eligible: true
  targetField: string
  value: boolean
  matchConditions: MatchCondition[]
  // Human-readable summary for the preview screen (item 5) — never
  // natural-language storage, purely a display derivation from the same
  // structured facts persisted in matchConditions/value.
  scopeSummary: {
    ruleTypeLabel: string
    applicationTimingLabel: string
    treatmentLabel: string
  }
}

export interface PromotionIneligible {
  eligible: false
  reason: PromotionIneligibleReason
  message: string
}

export type PromotionEvaluation = PromotionEligible | PromotionIneligible

function humanize(snakeCase: string): string {
  return snakeCase.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

function timingLabel(timing: string): string {
  return timing === 'next_invoice' ? 'Next invoice' : humanize(timing)
}

// The pure eligibility + scope-generation decision. Deliberately takes
// PromotableFieldState — the CURRENT PERSISTED state a caller already
// loaded from contract_terms (org-scoped, via jobs.org_id) — never a raw
// request body. See item 13: "client-provided rule ID/version/effective
// date/proposed value must always be verified against the server-side
// organization" — the discipline here is the same one level up: a client
// can request "promote this credit's survival field", but the VALUE being
// promoted is always what the server itself finds persisted, never
// anything the client separately asserts.
export function evaluateReviewerDecisionForPromotion(state: PromotableFieldState): PromotionEvaluation {
  if (!isProductionActivatedOrganizationField(state.targetField)) {
    return { eligible: false, reason: 'field_not_promotable', message: `"${state.targetField}" is not a field Step 5D supports promoting yet — only survival.carry_forward is.` }
  }
  if (state.provenance === 'contract_derived') {
    return { eligible: false, reason: 'contract_derived_cannot_promote', message: 'The contract itself already states this — there is no reviewer decision here to promote.' }
  }
  if (state.provenance === 'organization_rulebook') {
    return { eligible: false, reason: 'already_organization_policy', message: 'This value already comes from an organization policy — it cannot be used to create another one.' }
  }
  if (state.provenance !== 'reviewer_policy') {
    return { eligible: false, reason: 'not_a_resolved_reviewer_decision', message: 'This field has not been resolved by an explicit reviewer decision yet.' }
  }
  if (typeof state.value !== 'boolean') {
    return { eligible: false, reason: 'no_concrete_value', message: 'No concrete value is on file for this field yet.' }
  }

  // Final amendment — match_conditions is derived from this field's own
  // allowed scope dimensions (ORGANIZATION_POLICY_SCOPE_DIMENSIONS), never
  // a single universal recipe applied to every promotable field. The
  // targetField check above already guarantees state.targetField is a
  // ProductionActivatedOrganizationField by this point.
  const factsByDimension: Record<string, unknown> = {
    rule_type: state.matchFacts.ruleType,
    'application.timing': state.matchFacts.applicationTiming,
  }
  const scopeDimensions = ORGANIZATION_POLICY_SCOPE_DIMENSIONS[state.targetField as ProductionActivatedOrganizationField]
  const matchConditions: MatchCondition[] = scopeDimensions.map(field => ({
    field, operator: 'eq', value: factsByDimension[field],
  }))

  return {
    eligible: true,
    targetField: state.targetField,
    value: state.value,
    matchConditions,
    scopeSummary: {
      ruleTypeLabel: humanize(state.matchFacts.ruleType),
      applicationTimingLabel: timingLabel(state.matchFacts.applicationTiming),
      treatmentLabel: state.value ? 'Carry forward until fully used' : 'Does not carry forward past the period earned',
    },
  }
}
