// Organization Rulebook — canonical policy-slot identity (Step 5D final
// amendment, promotion-dedup pass).
//
// A policy SLOT is what makes two organization_rulebook_rules rows "the
// same policy" for deduplication/conflict purposes:
//   organization_id + target_field + normalized match_conditions
// Deliberately excludes source_kind, the originating job/contract,
// description, value, rule id, and version — those describe a specific
// VERSION or ORIGIN of a rule, never the slot it occupies. Two rules with
// an identical slot but different values are a genuine conflict (see
// classifyOrganizationPolicySlotOutcome below), not two different slots.
import type { MatchCondition, OrganizationRuleRecord } from './organization-rules'

// Deterministic order so two condition arrays describing the same
// semantic scope in a different array order compare equal — the known,
// documented limitation of the database's own exclusion constraint
// (match_conditions_json::text equality, order-sensitive — see
// 20260823000001_organization_rulebook_temporal_validity.sql's own
// comment on org_rulebook_no_overlapping_scope). This is the ONE
// normalizer the application layer uses; the database constraint remains
// a separate, order-sensitive last line of defense (see this module's
// callers for why application-level dedup runs first).
export function normalizeMatchConditions(conditions: MatchCondition[]): MatchCondition[] {
  return [...conditions]
    .map(c => ({ field: c.field, operator: c.operator, value: c.value ?? null }))
    .sort((a, b) => a.field.localeCompare(b.field) || a.operator.localeCompare(b.operator))
}

export interface OrganizationPolicySlot {
  organizationId: string
  targetField: string
  matchConditions: MatchCondition[]
}

// The one canonical string identity for a policy slot. Never source_kind,
// never the originating job/contract, never description, never value,
// never rule id/version/lineage — those identify a VERSION or ORIGIN of a
// rule, not the slot it occupies.
export function organizationPolicySlotKey(slot: OrganizationPolicySlot): string {
  return JSON.stringify({
    organizationId: slot.organizationId,
    targetField: slot.targetField,
    matchConditions: normalizeMatchConditions(slot.matchConditions),
  })
}

export function sameOrganizationPolicySlot(a: OrganizationPolicySlot, b: OrganizationPolicySlot): boolean {
  return organizationPolicySlotKey(a) === organizationPolicySlotKey(b)
}

export function organizationRuleOccupiesSlot(rule: OrganizationRuleRecord, slot: OrganizationPolicySlot): boolean {
  return sameOrganizationPolicySlot(slot, {
    organizationId: rule.organizationId, targetField: rule.targetField, matchConditions: rule.matchConditions,
  })
}

// Given, at most, one active and one draft rule already occupying the
// SAME slot as a proposed promotion (the caller — app/api/org/rulebook/
// promote/route.ts — is responsible for finding those via the slot
// comparison above), decides what a new promotion attempt should do. Pure
// — no database access, so this logic is fully unit-testable independent
// of the route/service layer.
export type OrganizationPolicySlotOutcome =
  | { state: 'no_existing' }
  | { state: 'already_covered'; rule: OrganizationRuleRecord }
  | { state: 'existing_draft'; rule: OrganizationRuleRecord }
  | { state: 'draft_conflict'; rule: OrganizationRuleRecord }
  | { state: 'proposed_policy_change'; rule: OrganizationRuleRecord }

export function classifyOrganizationPolicySlotOutcome(
  proposedValue: unknown,
  activeRule: OrganizationRuleRecord | null,
  draftRule: OrganizationRuleRecord | null,
): OrganizationPolicySlotOutcome {
  // Draft is checked FIRST, unconditionally — even when an active rule ALSO
  // exists for this slot (the in-flight-supersession case: an active rule
  // with a draft successor already awaiting activation). If active were
  // checked first, a reviewer decision that merely differs from the
  // CURRENT active value would be classified proposed_policy_change and
  // create a SECOND competing draft successor for the same active rule —
  // exactly the "duplicate/competing draft" outcome this whole pass exists
  // to prevent. Any existing draft — whatever its own origin — must be
  // surfaced and resolved (existing_draft/draft_conflict) before a new
  // policy-change proposal against the active rule is ever considered.
  if (draftRule) {
    return draftRule.value === proposedValue
      ? { state: 'existing_draft', rule: draftRule }
      : { state: 'draft_conflict', rule: draftRule }
  }
  if (activeRule) {
    return activeRule.value === proposedValue
      ? { state: 'already_covered', rule: activeRule }
      : { state: 'proposed_policy_change', rule: activeRule }
  }
  return { state: 'no_existing' }
}
