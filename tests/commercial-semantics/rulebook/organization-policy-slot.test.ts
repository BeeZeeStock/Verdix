// Organization Rulebook — canonical policy-slot identity and promotion-
// dedup classification (Step 5D final amendment, item 4/11). Pure tests —
// no database. DB-touching dedup tests (findOrganizationRulesForSlot, the
// promote route's end-to-end outcomes) live in
// lib/organization-rulebook-promotion-integration.test.ts, gated the same
// way every other RLS-dependent test in this codebase is.
import { describe, it, expect } from 'vitest'
import {
  normalizeMatchConditions, organizationPolicySlotKey, sameOrganizationPolicySlot,
  organizationRuleOccupiesSlot, classifyOrganizationPolicySlotOutcome,
} from '@/lib/rulebook/organization-policy-slot'
import type { MatchCondition, OrganizationRuleRecord } from '@/lib/rulebook/organization-rules'

function rule(overrides: Partial<OrganizationRuleRecord> = {}): OrganizationRuleRecord {
  return {
    id: 'rule-1',
    organizationId: 'org-a',
    name: 'Rebate carry-forward default',
    description: 'Promoted from a reviewer decision on job job-1.',
    targetField: 'survival.carry_forward',
    value: true,
    matchConditions: [{ field: 'rule_type', operator: 'eq', value: 'rebate' }],
    status: 'draft',
    version: 1,
    supersedesRuleId: null,
    lineageId: 'rule-1',
    sourceKind: 'reviewer_promotion',
    createdBy: 'reviewer@lynora.test',
    approvedBy: null,
    createdAt: '2026-08-23T10:48:04.953Z',
    updatedAt: '2026-08-23T10:48:04.953Z',
    effectiveFrom: null,
    effectiveTo: null,
    ...overrides,
  }
}

describe('normalizeMatchConditions', () => {
  it('sorts conditions by field so array order never affects comparison', () => {
    const a: MatchCondition[] = [
      { field: 'application.timing', operator: 'eq', value: 'next_invoice' },
      { field: 'rule_type', operator: 'eq', value: 'rebate' },
    ]
    const b: MatchCondition[] = [
      { field: 'rule_type', operator: 'eq', value: 'rebate' },
      { field: 'application.timing', operator: 'eq', value: 'next_invoice' },
    ]
    expect(normalizeMatchConditions(a)).toEqual(normalizeMatchConditions(b))
  })

  it('a single-condition array normalizes to itself (the corrected rebate scope\'s common case)', () => {
    const conditions: MatchCondition[] = [{ field: 'rule_type', operator: 'eq', value: 'rebate' }]
    expect(normalizeMatchConditions(conditions)).toEqual(conditions)
  })
})

describe('organizationPolicySlotKey / sameOrganizationPolicySlot', () => {
  const rebateScope = { organizationId: 'org-a', targetField: 'survival.carry_forward', matchConditions: [{ field: 'rule_type', operator: 'eq' as const, value: 'rebate' }] }

  it('identical organization + target_field + match_conditions -> same slot', () => {
    expect(sameOrganizationPolicySlot(rebateScope, { ...rebateScope })).toBe(true)
  })

  it('organizationPolicySlotKey itself is deterministic and equal for the same slot', () => {
    expect(organizationPolicySlotKey(rebateScope)).toBe(organizationPolicySlotKey({ ...rebateScope }))
    expect(organizationPolicySlotKey(rebateScope)).not.toBe(organizationPolicySlotKey({ ...rebateScope, organizationId: 'org-b' }))
  })

  it('a different organization_id -> different slot (org A + rebate never equals org B + rebate — item 11, tenant isolation)', () => {
    expect(sameOrganizationPolicySlot(rebateScope, { ...rebateScope, organizationId: 'org-b' })).toBe(false)
  })

  it('a different target_field -> different slot', () => {
    expect(sameOrganizationPolicySlot(rebateScope, { ...rebateScope, targetField: 'survival.one_time' })).toBe(false)
  })

  it('a different match_conditions value -> different slot (rebate vs service_credit)', () => {
    expect(sameOrganizationPolicySlot(rebateScope, {
      ...rebateScope, matchConditions: [{ field: 'rule_type', operator: 'eq', value: 'service_credit' }],
    })).toBe(false)
  })

  it('the OLD (too-narrow) two-condition scope is a DIFFERENT slot from the corrected one-condition scope — never silently treated as the same policy', () => {
    const oldScope = { ...rebateScope, matchConditions: [...rebateScope.matchConditions, { field: 'application.timing', operator: 'eq' as const, value: 'next_invoice' }] }
    expect(sameOrganizationPolicySlot(rebateScope, oldScope)).toBe(false)
  })

  it('match_conditions written in a different array order for the same semantic scope is still the SAME slot (normalized comparison, not the database\'s own order-sensitive text equality)', () => {
    const twoCondition = { ...rebateScope, matchConditions: [{ field: 'rule_type', operator: 'eq' as const, value: 'rebate' }, { field: 'application.timing', operator: 'eq' as const, value: 'next_invoice' }] }
    const reordered = { ...rebateScope, matchConditions: [{ field: 'application.timing', operator: 'eq' as const, value: 'next_invoice' }, { field: 'rule_type', operator: 'eq' as const, value: 'rebate' }] }
    expect(sameOrganizationPolicySlot(twoCondition, reordered)).toBe(true)
  })
})

// Item 4's explicit requirement: source_kind, the originating job/contract,
// description, value, rule id, and version must NEVER be part of slot
// identity — they describe a version/origin of a rule, not the slot.
describe('organizationRuleOccupiesSlot — slot identity excludes version/origin fields', () => {
  const slot = { organizationId: 'org-a', targetField: 'survival.carry_forward', matchConditions: [{ field: 'rule_type', operator: 'eq' as const, value: 'rebate' }] }

  it('two rules differing ONLY in source_kind occupy the same slot', () => {
    const manual = rule({ id: 'r1', sourceKind: 'manual' })
    const promoted = rule({ id: 'r2', sourceKind: 'reviewer_promotion' })
    expect(organizationRuleOccupiesSlot(manual, slot)).toBe(true)
    expect(organizationRuleOccupiesSlot(promoted, slot)).toBe(true)
  })

  it('two rules differing ONLY in description (originating job reference) occupy the same slot', () => {
    const jobA = rule({ id: 'r1', description: 'Promoted from a reviewer decision on job job-aaa.' })
    const jobB = rule({ id: 'r2', description: 'Promoted from a reviewer decision on job job-bbb.' })
    expect(organizationRuleOccupiesSlot(jobA, slot)).toBe(true)
    expect(organizationRuleOccupiesSlot(jobB, slot)).toBe(true)
  })

  it('two rules differing in value (true vs false) still occupy the SAME slot — value is what CONFLICTS within a slot, not what defines a different slot', () => {
    const trueRule = rule({ id: 'r1', value: true })
    const falseRule = rule({ id: 'r2', value: false })
    expect(organizationRuleOccupiesSlot(trueRule, slot)).toBe(true)
    expect(organizationRuleOccupiesSlot(falseRule, slot)).toBe(true)
  })

  it('two rules differing in id/version/lineage occupy the same slot', () => {
    const v1 = rule({ id: 'r1', version: 1, lineageId: 'r1' })
    const v2 = rule({ id: 'r2', version: 7, lineageId: 'r2', supersedesRuleId: 'some-other-id' })
    expect(organizationRuleOccupiesSlot(v1, slot)).toBe(true)
    expect(organizationRuleOccupiesSlot(v2, slot)).toBe(true)
  })
})

// Item 11, tests 5-9 — the dedup outcome matrix.
describe('classifyOrganizationPolicySlotOutcome — promotion dedup outcomes (item 11)', () => {
  it('no existing rule -> no_existing', () => {
    expect(classifyOrganizationPolicySlotOutcome(true, null, null)).toEqual({ state: 'no_existing' })
  })

  it('an active rule with the SAME value -> already_covered, no new rule created', () => {
    const active = rule({ id: 'active-1', status: 'active', value: true, approvedBy: 'admin@lynora.test' })
    expect(classifyOrganizationPolicySlotOutcome(true, active, null)).toEqual({ state: 'already_covered', rule: active })
  })

  it('a draft rule with the SAME value -> existing_draft, the existing draft is returned, never a new one', () => {
    const draft = rule({ id: 'draft-1', status: 'draft', value: true })
    expect(classifyOrganizationPolicySlotOutcome(true, null, draft)).toEqual({ state: 'existing_draft', rule: draft })
  })

  it('a draft rule with a DIFFERENT value -> draft_conflict, never a second competing draft', () => {
    const draft = rule({ id: 'draft-1', status: 'draft', value: false })
    expect(classifyOrganizationPolicySlotOutcome(true, null, draft)).toEqual({ state: 'draft_conflict', rule: draft })
  })

  it('an active rule with a DIFFERENT value -> proposed_policy_change, uses the successor/supersession lifecycle rather than a second independent active slot', () => {
    const active = rule({ id: 'active-1', status: 'active', value: false, approvedBy: 'admin@lynora.test' })
    expect(classifyOrganizationPolicySlotOutcome(true, active, null)).toEqual({ state: 'proposed_policy_change', rule: active })
  })

  it('a draft ALSO exists alongside an active rule -> the draft is classified first, regardless of what the active rule says (never a second competing draft on top of an in-flight supersession)', () => {
    const active = rule({ id: 'active-1', status: 'active', value: false, approvedBy: 'admin@lynora.test' })
    const draftSuccessor = rule({ id: 'draft-2', status: 'draft', value: true, supersedesRuleId: 'active-1' })
    // Proposed value matches the draft successor, not the active rule —
    // must resolve as existing_draft, not proposed_policy_change.
    expect(classifyOrganizationPolicySlotOutcome(true, active, draftSuccessor)).toEqual({ state: 'existing_draft', rule: draftSuccessor })
    // Proposed value matches NEITHER — still draft_conflict (the draft
    // successor wins classification), never a second draft.
    expect(classifyOrganizationPolicySlotOutcome('unclear' as unknown as boolean, active, draftSuccessor)).toEqual({ state: 'draft_conflict', rule: draftSuccessor })
  })
})
